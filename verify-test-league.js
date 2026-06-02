/**
 * verify-test-league.js
 * 
 * Standalone Node.js script that connects to the Firebase Local Emulator.
 * It triggers the initializeTestEnvironment Cloud Function, waits 5 seconds,
 * and asserts that:
 * 1. An active 8-team league exists.
 * 2. Exactly 7 team owners have the isBot: true property.
 * 3. The schedule subcollection contains exactly 14 weeks of matchups.
 * 4. The admin_settings/simulation_state document is active.
 * 
 * Run using: npx tsx verify-test-league.js
 */

import { initializeApp } from "firebase/app";
import { 
  getAuth, 
  connectAuthEmulator, 
  signInWithEmailAndPassword, 
  createUserWithEmailAndPassword, 
  deleteUser 
} from "firebase/auth";
import { 
  getFirestore, 
  connectFirestoreEmulator, 
  doc, 
  getDoc, 
  getDocs, 
  collection, 
  deleteDoc, 
  setDoc 
} from "firebase/firestore";
import { 
  getFunctions, 
  connectFunctionsEmulator, 
  httpsCallable 
} from "firebase/functions";

// Config matches active project config in src/firebase.js
const firebaseConfig = {
  projectId: "pwhl-fantasy-mobile-26",
  appId: "1:502197146749:web:48318c0fda30defd4dcd14",
  storageBucket: "pwhl-fantasy-mobile-26.firebasestorage.app",
  apiKey: "AIzaSyBUpX8nhgUOoBJABs9UNsv0j2GAVL57ZDU",
  authDomain: "pwhl-fantasy-mobile-26.firebaseapp.com",
  messagingSenderId: "502197146749"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app);

// Connect to Emulators using standard environment detection or default local ports
const firestoreHostEnv = process.env.FIRESTORE_EMULATOR_HOST;
const authHostEnv = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const functionsHostEnv = process.env.FIREBASE_FUNCTIONS_EMULATOR_HOST;

if (firestoreHostEnv) {
  const [host, port] = firestoreHostEnv.split(":");
  connectFirestoreEmulator(db, host, parseInt(port, 10));
  console.log(`Connected to Firestore Emulator: ${host}:${port}`);
} else {
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
  console.log("Connected to Firestore Emulator (default): 127.0.0.1:8080");
}

if (authHostEnv) {
  connectAuthEmulator(auth, `http://${authHostEnv}`);
  console.log(`Connected to Auth Emulator: http://${authHostEnv}`);
} else {
  connectAuthEmulator(auth, "http://127.0.0.1:9099");
  console.log("Connected to Auth Emulator (default): http://127.0.0.1:9099");
}

if (functionsHostEnv) {
  const [host, port] = functionsHostEnv.split(":");
  connectFunctionsEmulator(functions, host, parseInt(port, 10));
  console.log(`Connected to Functions Emulator: ${host}:${port}`);
} else {
  connectFunctionsEmulator(functions, "127.0.0.1", 5001);
  console.log("Connected to Functions Emulator (default): 127.0.0.1:5001");
}

const TEST_EMAIL = "verify_admin_temp@example.com";
const TEST_PASSWORD = "TempPassword123!";

async function authenticateAndSetAdmin() {
  console.log("\n🔑 Authenticating client session...");
  let user;
  try {
    const userCredential = await signInWithEmailAndPassword(auth, TEST_EMAIL, TEST_PASSWORD);
    user = userCredential.user;
    console.log(`✅ Authenticated successfully as ${user.email}`);
  } catch (error) {
    if (error.code === 'auth/user-not-found' || error.code === 'auth/invalid-credential' || error.code === 'auth/wrong-password') {
      const userCredential = await createUserWithEmailAndPassword(auth, TEST_EMAIL, TEST_PASSWORD);
      user = userCredential.user;
      console.log(`✅ Temporary account created and authenticated as ${user.email}`);
    } else {
      throw error;
    }
  }

  // Elevate to admin role in Firestore so the Cloud Function passes privilege check
  console.log(`🛡️ Elevating user ${user.uid} to 'admin' in Firestore...`);
  const userDocRef = doc(db, "users", user.uid);
  await setDoc(userDocRef, {
    email: TEST_EMAIL,
    role: "admin",
    isTestNode: true
  }, { merge: true });
  console.log("✅ Admin privilege granted in database.");
  
  return user;
}

async function runVerification() {
  let testUser = null;
  let activeLeagueId = null;

  try {
    // 1. Authenticate & grant admin role
    testUser = await authenticateAndSetAdmin();

    // 2. Trigger Cloud Function
    console.log("\n⚡ Triggering initializeTestEnvironment Cloud Function...");
    const initializeTestEnvironment = httpsCallable(functions, "initializeTestEnvironment");
    const result = await initializeTestEnvironment();
    
    console.log("📦 Cloud Function response:", result.data);
    
    if (!result.data || !result.data.success) {
      throw new Error(`Cloud Function failed: ${result.data?.error || "Unknown error"}`);
    }

    activeLeagueId = result.data.active_test_league_id;
    console.log(`🎉 Sandbox initialized. Test League ID: ${activeLeagueId}`);

    // 3. Wait 5 seconds
    console.log("\n⏳ Waiting 5 seconds for async indexing and write propagation...");
    await new Promise((resolve) => setTimeout(resolve, 5000));

    console.log("\n🔍 Starting assertions...\n");

    // Assertion 1: A league exists with exactly 8 teams
    console.log("🧐 ASSERTION 1: Checking league team count...");
    const teamsCollectionRef = collection(db, `fantasy_leagues/${activeLeagueId}/teams`);
    const teamsSnap = await getDocs(teamsCollectionRef);
    console.log(`- Found ${teamsSnap.size} teams (Expected: 8)`);
    if (teamsSnap.size !== 8) {
      throw new Error(`Assertion 1 Failed: Expected exactly 8 teams in the league, found ${teamsSnap.size}`);
    }
    console.log("⭐ ASSERTION 1 PASSED: League has exactly 8 teams!");

    // Assertion 2: 7 of the owners have the isBot: true property
    console.log("\n🧐 ASSERTION 2: Checking bot owner status...");
    let botOwnerCount = 0;
    
    for (const teamDoc of teamsSnap.docs) {
      const teamData = teamDoc.data();
      const ownerId = teamData.ownerId;
      if (!ownerId) continue;
      
      const ownerSnap = await getDoc(doc(db, "users", ownerId));
      if (ownerSnap.exists()) {
        const ownerData = ownerSnap.data();
        if (ownerData.isBot === true) {
          botOwnerCount++;
        }
      }
    }
    
    console.log(`- Found ${botOwnerCount} team owners with isBot: true (Expected: 7)`);
    if (botOwnerCount !== 7) {
      throw new Error(`Assertion 2 Failed: Expected exactly 7 bot owners, found ${botOwnerCount}`);
    }
    console.log("⭐ ASSERTION 2 PASSED: Exactly 7 team owners have isBot: true!");

    // Assertion 3: The schedule contains exactly 14 weeks of matchups
    console.log("\n🧐 ASSERTION 3: Checking schedule matchups...");
    const matchupsCollectionRef = collection(db, `fantasy_leagues/${activeLeagueId}/matchups`);
    const matchupsSnap = await getDocs(matchupsCollectionRef);
    console.log(`- Found total of ${matchupsSnap.size} matchups across all weeks.`);
    
    const uniqueWeeks = new Set();
    matchupsSnap.forEach((matchupDoc) => {
      const matchupData = matchupDoc.data();
      if (matchupData.week) {
        uniqueWeeks.add(matchupData.week);
      }
    });
    
    console.log(`- Unique weeks represented in matchups: [${Array.from(uniqueWeeks).sort((a,b) => a-b).join(", ")}] (Count: ${uniqueWeeks.size})`);
    if (uniqueWeeks.size !== 14) {
      throw new Error(`Assertion 3 Failed: Expected exactly 14 weeks of matchups, found ${uniqueWeeks.size} weeks`);
    }
    for (let w = 1; w <= 14; w++) {
      if (!uniqueWeeks.has(w)) {
        throw new Error(`Assertion 3 Failed: Matchups are missing for week ${w}`);
      }
    }
    console.log("⭐ ASSERTION 3 PASSED: Matchup schedule has exactly 14 weeks represented!");

    // Assertion 4: The simulation_state document is active
    console.log("\n🧐 ASSERTION 4: Checking simulation state document...");
    const simStateSnap = await getDoc(doc(db, "admin_settings", "simulation_state"));
    if (!simStateSnap.exists()) {
      throw new Error("Assertion 4 Failed: admin_settings/simulation_state document does not exist");
    }
    
    const simStateData = simStateSnap.data();
    console.log("- Stored simulation_state:", simStateData);
    if (simStateData.testModeActive !== true) {
      throw new Error(`Assertion 4 Failed: Expected testModeActive to be true, got ${simStateData.testModeActive}`);
    }
    if (simStateData.active_test_league_id !== activeLeagueId) {
      throw new Error(`Assertion 4 Failed: Expected active_test_league_id to be ${activeLeagueId}, got ${simStateData.active_test_league_id}`);
    }
    console.log("⭐ ASSERTION 4 PASSED: simulation_state is active and links correctly to the test league!");

    console.log("\n========================================================");
    console.log("🏆 STATUS: PASS - ALL EMULATOR SANDBOX ASSERTIONS PASSED!");
    console.log("========================================================\n");

  } catch (error) {
    console.error("\n❌ STATUS: FAIL - VERIFICATION FAILED:", error.message);
    process.exitCode = 1;
  } finally {
    // Cleanup temporary admin user if generated
    if (testUser) {
      console.log("🧹 Cleaning up temporary admin auth account and user document...");
      try {
        await deleteDoc(doc(db, "users", testUser.uid));
        await deleteUser(testUser);
        console.log("✅ Admin account and Firestore record deleted.");
      } catch (e) {
        console.error("Failed to clean up authentication user:", e.message);
      }
    }

    console.log("👋 Verification script complete.");
    process.exit();
  }
}

runVerification();
