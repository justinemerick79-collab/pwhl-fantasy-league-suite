/**
 * test-daily-lineups.js
 * 
 * Standalone integration test for daily lineups slot validation and time-based locking logic.
 * 
 * Run using: npx tsx test-daily-lineups.js
 */

import { initializeApp } from "firebase/app";
import { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword } from "firebase/auth";
import { getFirestore, doc, deleteDoc, setDoc } from "firebase/firestore";
import { saveDailyLineup, getDailyLineup } from "./src/services/leagueService.js";

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
  const leagueId = "daily_test_league_" + Math.random().toString(36).substring(2, 6);
  const teamId = "team_user";
  const createdDocs = [];

  try {
    testUser = await authenticateAndSetAdmin();
    const userUid = testUser.uid;

    console.log("\n🚀 STEP 1: Setting up mock league & team environment...");

    // 1. Create league doc
    const leagueRef = doc(db, "fantasy_leagues", leagueId);
    await setDoc(leagueRef, {
      name: "Daily Lineups Test League",
      ownerId: userUid,
      commissionerId: userUid,
      maxTeams: 8,
      members: [userUid],
      status: "active",
      currentWeek: 1,
      season_id: "1",
      rosterSettings: {
        forwards: { starters: 1 },
        defense: { starters: 1 },
        goalies: { starters: 0 }
      }
    });
    createdDocs.push(leagueRef);

    // 2. Create player records (Marie-Philip Poulin F (MTL) and Erin Ambrose D (BOS))
    const p1Ref = doc(db, "pwhl_players", "1_pwhl_1");
    await setDoc(p1Ref, {
      player_id: "pwhl_1",
      first_name: "Marie-Philip",
      last_name: "Poulin",
      position: "F",
      current_team_id: "MTL",
      season_id: "1"
    });
    createdDocs.push(p1Ref);

    const p8Ref = doc(db, "pwhl_players", "1_pwhl_8");
    await setDoc(p8Ref, {
      player_id: "pwhl_8",
      first_name: "Erin",
      last_name: "Ambrose",
      position: "D",
      current_team_id: "BOS",
      season_id: "1"
    });
    createdDocs.push(p8Ref);

    // 3. Create User team sheet (owning both players, starting Poulin, benching Ambrose)
    const teamRef = doc(db, `fantasy_leagues/${leagueId}/teams`, teamId);
    await setDoc(teamRef, {
      ownerId: userUid,
      teamName: "User Team",
      avatar: "🏒",
      players: ["pwhl_1", "pwhl_8"],
      activePlayers: ["pwhl_1"],
      benchPlayers: ["pwhl_8"],
      wins: 0, losses: 0, ties: 0, points: 0.0
    });
    createdDocs.push(teamRef);

    // 4. Create a game for MTL on Dec 28, 2023 at 19:00:00 (BOS has no game today)
    const gameRef = doc(db, "pwhl_games", "game_daily_1");
    await setDoc(gameRef, {
      game_id: "game_daily_1",
      season_id: "1",
      status: "1", // Scheduled
      date_played: "2023-12-28T19:00:00-08:00",
      home_team: "MTL",
      visiting_team: "TOR"
    });
    createdDocs.push(gameRef);

    console.log("✅ Mock environment set up.");

    console.log("\n🚀 STEP 2: Setting clock to 2023-12-28 at 12:00:00 (Before game starts)...");
    const simStateRef = doc(db, "admin_settings", "simulation_state");
    await setDoc(simStateRef, {
      testModeActive: true,
      current_simulated_date: "2023-12-28T12:00:00-08:00",
      active_test_league_id: leagueId
    }, { merge: true });

    // Wait a brief moment for database sync
    await new Promise(r => setTimeout(r, 2000));

    console.log("\n🚀 STEP 3: Attempting to save lineup for a past date (2023-12-27)...");
    try {
      await saveDailyLineup(leagueId, teamId, "2023-12-27", { F1: "pwhl_1" }, ["pwhl_8"]);
      throw new Error("FAIL: Allowed saving past date roster lineup.");
    } catch (e) {
      if (e.message.includes("Cannot modify a roster lineup for a past date.")) {
        console.log("⭐ PASSED: Successfully rejected past date lineup edit!");
      } else {
        throw e;
      }
    }

    console.log("\n🚀 STEP 4: Saving lineup for current date (2023-12-28) before game starts...");
    // Swap Poulin to Bench, Ambrose to Active Defense
    await saveDailyLineup(leagueId, teamId, "2023-12-28", { D1: "pwhl_8" }, ["pwhl_1"]);
    console.log("⭐ PASSED: Roster swapped successfully before game start.");

    // Verify it saved correctly
    const savedLineupBefore = await getDailyLineup(leagueId, teamId, "2023-12-28");
    console.log("- Saved Lineup (Active):", savedLineupBefore.activeLineup);
    console.log("- Saved Lineup (Bench):", savedLineupBefore.bench);
    if (savedLineupBefore.activeLineup.D1 !== "pwhl_8" || savedLineupBefore.bench[0] !== "pwhl_1") {
      throw new Error("Saved lineup did not match expected values.");
    }

    console.log("\n🚀 STEP 5: Setting clock to 2023-12-28 at 20:00:00 (After game started)...");
    await setDoc(simStateRef, {
      current_simulated_date: "2023-12-28T20:00:00-08:00"
    }, { merge: true });

    // Wait a brief moment
    await new Promise(r => setTimeout(r, 2000));

    console.log("\n🚀 STEP 6: Attempting to swap locked player (Poulin, game started)...");
    try {
      // Try to swap back: Poulin active, Ambrose bench
      await saveDailyLineup(leagueId, teamId, "2023-12-28", { F1: "pwhl_1" }, ["pwhl_8"]);
      throw new Error("FAIL: Allowed swapping player whose game already started.");
    } catch (e) {
      if (e.message.includes("Their game has already started")) {
        console.log(`⭐ PASSED: Correctly rejected swapping locked player: ${e.message}`);
      } else {
        throw e;
      }
    }

    console.log("\n========================================================");
    console.log("🏆 STATUS: PASS - DAILY LINEUPS AND SLOT LOCKING TEST PASSED!");
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
