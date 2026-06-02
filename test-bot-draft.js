/**
 * test-bot-draft.js
 * 
 * Standalone Node.js script that connects to the Firebase Local Emulator.
 * It:
 * 1. Authenticates a temporary human admin user.
 * 2. Pre-populates the database with user records for the human admin and a bot user.
 * 3. Initializes a mock draft state with Pick 1 belonging to the bot and Pick 2 belonging to the human.
 * 4. Waits 5 seconds (to allow the 3-second bot setTimeout + transaction processing to execute).
 * 5. Asserts that the bot automatically selected the highest pre-ranked player (e.g. Marie-Philip Poulin / pwhl_1),
 *    added them to the picks and roster, and advanced the turn so the human is now on the clock.
 * 6. Cleans up all mock documents and the temporary user.
 * 
 * Run using: npx tsx test-bot-draft.js
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
  setDoc,
  Timestamp 
} from "firebase/firestore";

// Config matches active project config
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

// Connect to Emulators
const firestoreHostEnv = process.env.FIRESTORE_EMULATOR_HOST;
const authHostEnv = process.env.FIREBASE_AUTH_EMULATOR_HOST;

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

const TEST_EMAIL = "draft_admin_temp@example.com";
const TEST_PASSWORD = "TempPassword123!";
const BOT_UID = "test_bot_user_999";
const LEAGUE_ID = "draft_bot_test_999";

async function setupUsers(adminUid) {
  console.log("🛡️ Registering admin user document in Firestore...");
  await setDoc(doc(db, "users", adminUid), {
    email: TEST_EMAIL,
    role: "admin",
    isBot: false,
    isTestNode: true
  }, { merge: true });

  console.log("🤖 Registering bot user document in Firestore...");
  await setDoc(doc(db, "users", BOT_UID), {
    email: "bot_1_test@fantasy.com",
    role: "user",
    isBot: true,
    isTestNode: true
  }, { merge: true });
}

async function runVerification() {
  let testUser = null;
  const createdDocs = [];

  try {
    // 1. Authenticate temporary admin
    console.log("\n🔑 Authenticating client session...");
    try {
      const userCredential = await signInWithEmailAndPassword(auth, TEST_EMAIL, TEST_PASSWORD);
      testUser = userCredential.user;
      console.log(`✅ Authenticated successfully as ${testUser.email}`);
    } catch (error) {
      if (error.code === 'auth/user-not-found' || error.code === 'auth/invalid-credential' || error.code === 'auth/wrong-password') {
        const userCredential = await createUserWithEmailAndPassword(auth, TEST_EMAIL, TEST_PASSWORD);
        testUser = userCredential.user;
        console.log(`✅ Temporary account created and authenticated as ${testUser.email}`);
      } else {
        throw error;
      }
    }

    // 2. Set up users in database
    await setupUsers(testUser.uid);
    createdDocs.push(doc(db, "users", testUser.uid));
    createdDocs.push(doc(db, "users", BOT_UID));

    // 3. Create mock league document
    console.log("\n🏔️ Initializing mock league document...");
    const leagueRef = doc(db, "fantasy_leagues", LEAGUE_ID);
    await setDoc(leagueRef, {
      name: "Bot Auto-Draft Test League",
      ownerId: testUser.uid,
      commissionerId: testUser.uid,
      status: "drafting",
      maxTeams: 2,
      members: [BOT_UID, testUser.uid],
      isTestNode: true,
      rosterSettings: {
        bench: 1,
        forwards: { starters: 1 },
        defense: { starters: 0 },
        goalies: { starters: 0 }
      }
    });
    createdDocs.push(leagueRef);

    // Create a team document for the bot
    const botTeamRef = doc(db, `fantasy_leagues/${LEAGUE_ID}/teams`, "team_bot");
    await setDoc(botTeamRef, {
      ownerId: BOT_UID,
      teamName: "Bot Team 1",
      players: [],
      isTestNode: true
    });
    createdDocs.push(botTeamRef);

    // Create a team document for the admin
    const adminTeamRef = doc(db, `fantasy_leagues/${LEAGUE_ID}/teams`, "team_admin");
    await setDoc(adminTeamRef, {
      ownerId: testUser.uid,
      teamName: "Admin Team",
      players: [],
      isTestNode: true
    });
    createdDocs.push(adminTeamRef);

    // 4. Initialize draft state document with BOT on clock (Pick 1) and ADMIN next (Pick 2)
    console.log("🏁 Initializing mock draft state: BOT is on clock...");
    const draftStateRef = doc(db, `fantasy_leagues/${LEAGUE_ID}/draft`, "state");
    const deadline = Timestamp.fromMillis(Date.now() + 60000);
    
    await setDoc(draftStateRef, {
      status: "active",
      draftOrder: [BOT_UID, testUser.uid],
      currentRound: 1,
      currentPickIndex: 0,
      currentTeamOnClock: BOT_UID,
      current_pick_owner_id: BOT_UID, // support both schemas
      pickDeadline: deadline,
      picks: [],
      activeRosters: {
        [BOT_UID]: [],
        [testUser.uid]: []
      },
      isTestNode: true
    });
    createdDocs.push(draftStateRef);

    console.log("⏳ Waiting 5 seconds for bot setTimeout (3s) and transaction writes...");
    await new Promise((resolve) => setTimeout(resolve, 5000));

    console.log("\n🔍 Executing Assertions...\n");

    // Fetch updated draft state
    const draftSnap = await getDoc(draftStateRef);
    if (!draftSnap.exists()) {
      throw new Error("Draft state document does not exist after wait!");
    }
    const draftData = draftSnap.data();

    // Assertion 1: Verify player drafted
    console.log("🧐 ASSERTION 1: Checking if bot drafted a player...");
    const picks = draftData.picks || [];
    console.log(`- Picks count: ${picks.length} (Expected: 1)`);
    if (picks.length !== 1) {
      throw new Error(`Assertion 1 Failed: Expected exactly 1 pick, found ${picks.length}`);
    }
    const firstPick = picks[0];
    console.log(`- Player selected: ${firstPick.playerId || firstPick.player_id} (Expected: pwhl_1)`);
    if ((firstPick.playerId || firstPick.player_id) !== "pwhl_1") {
      throw new Error(`Assertion 1 Failed: Expected bot to select highest-ranked player 'pwhl_1', got '${firstPick.playerId || firstPick.player_id}'`);
    }
    console.log("⭐ ASSERTION 1 PASSED: Bot successfully drafted player 'pwhl_1'!");

    // Assertion 2: Verify player assigned to bot's active roster in draft state
    console.log("\n🧐 ASSERTION 2: Checking if player was assigned to bot's active rosters...");
    const activeRosters = draftData.activeRosters || draftData.active_rosters || {};
    const botRoster = activeRosters[BOT_UID] || [];
    console.log(`- Bot Roster: [${botRoster.join(", ")}] (Expected: ['pwhl_1'])`);
    if (!botRoster.includes("pwhl_1")) {
      throw new Error("Assertion 2 Failed: Player 'pwhl_1' not found in bot active roster map");
    }
    console.log("⭐ ASSERTION 2 PASSED: Player correctly added to bot active roster!");

    // Assertion 3: Verify team collection update
    console.log("\n🧐 ASSERTION 3: Checking if player was assigned to bot's team document...");
    const teamSnap = await getDoc(botTeamRef);
    const teamData = teamSnap.data();
    const teamRoster = teamData.players || [];
    console.log(`- Bot Team document roster: [${teamRoster.join(", ")}] (Expected: ['pwhl_1'])`);
    if (!teamRoster.includes("pwhl_1")) {
      throw new Error("Assertion 3 Failed: Player 'pwhl_1' was not updated on the team document roster");
    }
    console.log("⭐ ASSERTION 3 PASSED: Bot team document roster successfully updated!");

    // Assertion 4: Verify turn advanced to the human
    console.log("\n🧐 ASSERTION 4: Checking if turn advanced to human...");
    const currentOnClock = draftData.currentTeamOnClock || draftData.current_pick_owner_id;
    console.log(`- Current team on clock: ${currentOnClock} (Expected: ${testUser.uid})`);
    if (currentOnClock !== testUser.uid) {
      throw new Error(`Assertion 4 Failed: Expected turn to advance to human admin ${testUser.uid}, currently ${currentOnClock}`);
    }
    console.log("⭐ ASSERTION 4 PASSED: Draft turn successfully advanced to the human admin!");

    console.log("\n========================================================");
    console.log("🏆 STATUS: PASS - BOT AUTO-DRAFT ASSERTIONS PASSED!");
    console.log("========================================================\n");

  } catch (error) {
    console.error("\n❌ STATUS: FAIL - VERIFICATION FAILED:", error.message);
    process.exitCode = 1;
  } finally {
    console.log("🧹 Restoring Firestore database to pristine status...");
    for (const ref of createdDocs) {
      try {
        await deleteDoc(ref);
      } catch (e) {
        console.error(`Failed to delete document:`, e.message);
      }
    }
    console.log("✅ Cleanup complete.");

    if (testUser) {
      console.log("👤 Cleaning up temporary authentication account...");
      try {
        await deleteUser(testUser);
        console.log("✅ Admin auth account deleted.");
      } catch (e) {
        console.error("Failed to delete user account:", e.message);
      }
    }

    console.log("👋 Verification script completed.");
    process.exit();
  }
}

runVerification();
