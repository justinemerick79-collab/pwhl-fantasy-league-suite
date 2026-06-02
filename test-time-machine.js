/**
 * test-time-machine.js
 * 
 * Standalone Node.js script that connects to the Firebase Local Emulator.
 * It:
 * 1. Authenticates a temporary admin user.
 * 2. Writes a simulated date of '2024-01-15T12:00:00Z' to the admin document admin_settings/simulation_state.
 * 3. Invokes the getSimulatedTime Cloud Function.
 * 4. Asserts that the returned time exactly matches the 2024 override date, ignoring the real host clock.
 * 5. Cleans up database records and the temporary auth user.
 * 
 * Run using: npx tsx test-time-machine.js
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
} else {
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
}

if (authHostEnv) {
  connectAuthEmulator(auth, `http://${authHostEnv}`);
} else {
  connectAuthEmulator(auth, "http://127.0.0.1:9099");
}

if (functionsHostEnv) {
  const [host, port] = functionsHostEnv.split(":");
  connectFunctionsEmulator(functions, host, parseInt(port, 10));
} else {
  connectFunctionsEmulator(functions, "127.0.0.1", 5001);
}

const TEST_EMAIL = "timemachine_admin_temp@example.com";
const TEST_PASSWORD = "TempPassword123!";

async function authenticateAndSetAdmin() {
  console.log("🔑 Authenticating client session...");
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

  // Elevate to admin role in Firestore so the client write passes firestore security rules
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

async function runTest() {
  let testUser = null;
  const targetDateStr = "2024-01-15T12:00:00Z";
  const expectedTimeMs = new Date(targetDateStr).getTime();

  try {
    // 1. Authenticate & grant admin role
    testUser = await authenticateAndSetAdmin();

    // 2. Write simulated date to Firestore admin document admin_settings/simulation_state
    console.log(`\n🛸 STEP 1: Warping simulated date to: '${targetDateStr}'...`);
    const simStateRef = doc(db, "admin_settings", "simulation_state");
    await setDoc(simStateRef, {
      testModeActive: true,
      current_simulated_date: targetDateStr,
      isTestNode: true
    }, { merge: true });
    console.log("✅ Simulation clock warped in Firestore.");

    // 3. Trigger mock Cloud Function
    console.log("\n⚡ STEP 2: Triggering getSimulatedTime Cloud Function...");
    const getSimulatedTime = httpsCallable(functions, "getSimulatedTime");
    const result = await getSimulatedTime();
    
    console.log("📦 Cloud Function response:", result.data);
    
    if (!result.data || typeof result.data.timeMs !== "number") {
      throw new Error(`Cloud Function failed to return timeMs: ${JSON.stringify(result.data)}`);
    }

    const returnedTimeMs = result.data.timeMs;
    const returnedDateStr = new Date(returnedTimeMs).toISOString();

    // 4. Assertions
    console.log("\n🔍 STEP 3: Executing assertions...");
    console.log(`- Stored override date string: ${targetDateStr} (Epoch: ${expectedTimeMs})`);
    console.log(`- Cloud Function returned date string: ${returnedDateStr} (Epoch: ${returnedTimeMs})`);
    
    if (returnedTimeMs !== expectedTimeMs) {
      throw new Error(`Assertion Failed: Expected returned time to be ${expectedTimeMs}, got ${returnedTimeMs}`);
    }

    console.log("⭐ ASSERTION PASSED: The returned time exactly matches the 2024 override date and ignores standard Date.now()!");

    console.log("\n========================================================");
    console.log("🏆 STATUS: PASS - TIME TRAVEL SIMULATION ASSERTIONS PASSED!");
    console.log("========================================================\n");

  } catch (error) {
    console.error("\n❌ STATUS: FAIL - VERIFICATION FAILED:", error.message);
    process.exitCode = 1;
  } finally {
    // Cleanup Simulation State document
    console.log("🧹 Resetting simulation state document in Firestore...");
    try {
      const simStateRef = doc(db, "admin_settings", "simulation_state");
      await setDoc(simStateRef, {
        testModeActive: false,
        current_simulated_date: null
      }, { merge: true });
      console.log("✅ simulation_state deactivated.");
    } catch (e) {
      console.error("Failed to reset simulation state:", e.message);
    }

    // Cleanup temporary admin user if generated
    if (testUser) {
      console.log("👤 Cleaning up temporary admin auth account and user document...");
      try {
        await deleteDoc(doc(db, "users", testUser.uid));
        await deleteUser(testUser);
        console.log("✅ Admin account and Firestore record deleted.");
      } catch (e) {
        console.error("Failed to clean up authentication user:", e.message);
      }
    }

    console.log("👋 Time Machine test script complete.");
    process.exit();
  }
}

runTest();
