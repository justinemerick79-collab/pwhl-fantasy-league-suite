/**
 * test-matchup-resolution.js
 * 
 * Standalone end-to-end integration test.
 * Connects to the Firebase Local Emulator and tests the Game Loop matchup resolution:
 * 1. Authenticates a temporary admin.
 * 2. Sets up a mock active league, two teams (Admin vs Bot 1), a week 1 matchup, and players.
 * 3. Populates historical game box scores inside week 1 showing Admin's player scoring a goal.
 * 4. Sets the Time Machine clock to the start of Week 1 (Jan 1, 2024).
 * 5. Advances the Time Machine clock by 8 days (Jan 9, 2024).
 * 6. Asserts that the Cloud Function triggered, resolved matchup scores, advanced league.currentWeek to 2,
 *    and updated team records so Admin is 1-0-0 and Bot 1 is 0-1-0.
 * 7. Cleans up all mock documents.
 * 
 * Run using: npx tsx test-matchup-resolution.js
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

const TEST_EMAIL = "gameloop_admin_temp@example.com";
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
  const leagueId = "loop_test_league_" + Math.random().toString(36).substring(2, 6);
  const botUid = "loop_test_bot_" + Math.random().toString(36).substring(2, 6);
  const adminTeamId = "team_admin";
  const botTeamId = "team_bot";

  const createdDocs = [];

  try {
    testUser = await authenticateAndSetAdmin();
    const adminUid = testUser.uid;

    console.log("\n🚀 STEP 1: Setting up mock league environment...");

    // 1. Create bot user doc
    const botUserRef = doc(db, "users", botUid);
    await setDoc(botUserRef, {
      email: `bot_loop_test@fantasy.com`,
      displayName: "Bot Roster Owner",
      role: "user",
      isBot: true,
      isTestNode: true
    });
    createdDocs.push(botUserRef);

    // 2. Create league doc
    const leagueRef = doc(db, "fantasy_leagues", leagueId);
    await setDoc(leagueRef, {
      name: "Game Loop Test League",
      ownerId: adminUid,
      commissionerId: adminUid,
      maxTeams: 8,
      members: [adminUid, botUid],
      status: "active",
      currentWeek: 1,
      rosterSettings: {
        forwards: { starters: 6 },
        defense: { starters: 4 },
        goalies: { starters: 1 }
      },
      scoringSettings: {
        skaters: { goals: 2, assists: 1, plusMinus: 0, ppp: 0, shp: 0, sog: 0, hits: 0, blocks: 0, defensePoints: 0 },
        goalies: { wins: 0, otl: 0, ga: 0, saves: 0, shutouts: 0 }
      }
    });
    createdDocs.push(leagueRef);

    // 3. Create Admin team sheet
    const adminTeamRef = doc(db, `fantasy_leagues/${leagueId}/teams`, adminTeamId);
    await setDoc(adminTeamRef, {
      ownerId: adminUid,
      teamName: "Admin Vipers",
      avatar: "🏒",
      players: ["pwhl_1"],
      wins: 0, losses: 0, ties: 0, points: 0.0
    });
    createdDocs.push(adminTeamRef);

    // 4. Create Bot 1 team sheet
    const botTeamRef = doc(db, `fantasy_leagues/${leagueId}/teams`, botTeamId);
    await setDoc(botTeamRef, {
      ownerId: botUid,
      teamName: "Bot Vipers",
      avatar: "🤖",
      players: ["pwhl_8"],
      wins: 0, losses: 0, ties: 0, points: 0.0
    });
    createdDocs.push(botTeamRef);

    // 5. Create Week 1 matchup
    const matchupRef = doc(db, `fantasy_leagues/${leagueId}/matchups`, "week_1_matchup_1");
    await setDoc(matchupRef, {
      week: 1,
      homeTeamId: adminTeamId,
      awayTeamId: botTeamId,
      homeTeamName: "Admin Vipers",
      awayTeamName: "Bot Vipers",
      homeScore: 0.0,
      awayScore: 0.0,
      status: "pending"
    });
    createdDocs.push(matchupRef);

    // 6. Write player records
    const p1Ref = doc(db, "pwhl_players", "1_pwhl_1");
    await setDoc(p1Ref, {
      player_id: "pwhl_1",
      first_name: "Marie-Philip",
      last_name: "Poulin",
      position: "F",
      season_id: "1"
    });
    createdDocs.push(p1Ref);

    const p8Ref = doc(db, "pwhl_players", "1_pwhl_8");
    await setDoc(p8Ref, {
      player_id: "pwhl_8",
      first_name: "Erin",
      last_name: "Ambrose",
      position: "D",
      season_id: "1"
    });
    createdDocs.push(p8Ref);

    // 7. Write a completed game played on Jan 4, 2024 (during Week 1)
    const gameRef = doc(db, "pwhl_games", "game_100");
    await setDoc(gameRef, {
      game_id: "game_100",
      season_id: "1",
      status: "4",
      date_played: "2024-01-04T19:00:00-08:00"
    });
    createdDocs.push(gameRef);

    // 8. Write game summary box scores (Marie-Philip Poulin scores 1 goal)
    const summaryRef = doc(db, "pwhl_game_summaries", "game_100");
    await setDoc(summaryRef, {
      season_id: "1",
      goals: [
        {
          goal_scorer: { player_id: "pwhl_1" }
        }
      ],
      home_team_lineup: {
        players: [
          { player_id: "pwhl_1", goals: 1 }
        ]
      },
      visitor_team_lineup: {
        players: [
          { player_id: "pwhl_8", goals: 0 }
        ]
      }
    });
    createdDocs.push(summaryRef);

    console.log("✅ Mock environment successfully set up.");

    console.log("\n🚀 STEP 2: Warping clock to start of Week 1 (2024-01-01)...");
    const simStateRef = doc(db, "admin_settings", "simulation_state");
    await setDoc(simStateRef, {
      testModeActive: true,
      current_simulated_date: "2024-01-01T08:00:00-08:00",
      active_test_league_id: leagueId
    }, { merge: true });

    // Wait 3 seconds to let any initial triggers complete
    console.log("⏳ Waiting 3 seconds...");
    await new Promise(r => setTimeout(r, 3000));

    console.log("\n🚀 STEP 3: Warping clock past Week 1 boundary (+8 Days to 2024-01-09)...");
    await setDoc(simStateRef, {
      current_simulated_date: "2024-01-09T08:00:00-08:00"
    }, { merge: true });

    // Wait 7 seconds for finalization transaction and standings commits
    console.log("⏳ Waiting 7 seconds for Game Loop processing...");
    await new Promise(r => setTimeout(r, 7000));

    console.log("\n🚀 STEP 4: Executing assertions on final results...");

    // Assert 1: Matchup resolved to completed
    const matchSnap = await getDoc(matchupRef);
    const mData = matchSnap.data();
    console.log(`- Matchup Status: ${mData.status} (Expected: completed)`);
    console.log(`- Scores: Admin Vipers ${mData.homeScore} vs Bot Vipers ${mData.awayScore}`);
    
    if (mData.status !== "completed") {
      throw new Error(`Assertion 1 Failed: Expected matchup status to be completed, got ${mData.status}`);
    }
    if (mData.homeScore !== 2.0) {
      throw new Error(`Assertion 1 Failed: Expected home score (goals: 1 * 2pts) to be 2.0, got ${mData.homeScore}`);
    }
    if (mData.awayScore !== 0.0) {
      throw new Error(`Assertion 1 Failed: Expected away score to be 0.0, got ${mData.awayScore}`);
    }
    console.log("⭐ ASSERTION 1 PASSED: Week 1 Matchup completed and scores resolved correctly!");

    // Assert 2: Standings updated
    const adminTeamSnap = await getDoc(adminTeamRef);
    const aData = adminTeamSnap.data();
    console.log(`- Admin record: ${aData.wins}-${aData.losses}-${aData.ties} (Points: ${aData.points})`);

    const botTeamSnap = await getDoc(botTeamRef);
    const bData = botTeamSnap.data();
    console.log(`- Bot record: ${bData.wins}-${bData.losses}-${bData.ties} (Points: ${bData.points})`);

    if (aData.wins !== 1 || aData.losses !== 0) {
      throw new Error(`Assertion 2 Failed: Expected Admin team to have 1 win and 0 losses, got W:${aData.wins} L:${aData.losses}`);
    }
    if (bData.wins !== 0 || bData.losses !== 1) {
      throw new Error(`Assertion 2 Failed: Expected Bot team to have 0 wins and 1 loss, got W:${bData.wins} L:${bData.losses}`);
    }
    console.log("⭐ ASSERTION 2 PASSED: League Standings updated correctly (Admin is 1-0, Bot is 0-1)!");

    // Assert 3: Active league week advanced to Week 2
    const leagueSnap = await getDoc(leagueRef);
    const lData = leagueSnap.data();
    console.log(`- League current week: ${lData.currentWeek} (Expected: 2)`);
    if (lData.currentWeek !== 2) {
      throw new Error(`Assertion 3 Failed: Expected league currentWeek to be 2, got ${lData.currentWeek}`);
    }
    console.log("⭐ ASSERTION 3 PASSED: League current week advanced to Week 2!");

    console.log("\n========================================================");
    console.log("🏆 STATUS: PASS - GAME LOOP MATCHUP FINALIZATION TEST PASSED!");
    console.log("========================================================\n");

  } catch (error) {
    console.error("\n❌ STATUS: FAIL - VERIFICATION FAILED:", error.message);
    process.exitCode = 1;
  } finally {
    console.log("🧹 Cleaning up created mock database documents...");
    for (const ref of createdDocs) {
      try {
        await deleteDoc(ref);
      } catch (e) {
        console.error(`Failed to delete document ${ref.path}:`, e.message);
      }
    }

    // Reset simulation state
    try {
      const simStateRef = doc(db, "admin_settings", "simulation_state");
      await setDoc(simStateRef, {
        testModeActive: false,
        current_simulated_date: null,
        active_test_league_id: null
      });
      console.log("✅ simulation_state reset.");
    } catch (e) {
      console.error("Failed to reset simulation state:", e.message);
    }

    console.log("👋 Verification script completed.");
    process.exit();
  }
}

runTest();
