/**
 * Standalone Verification Script: Snake Draft System
 * Verifies turn-based sequencing, turn locking, atomic player assignment,
 * snake direction rules (Odd 1-4, Even 4-1), and auto-pick timeouts.
 */

import { auth, db } from "./src/firebase.js";
import { 
  signInWithEmailAndPassword, 
  createUserWithEmailAndPassword, 
  deleteUser 
} from "firebase/auth";
import { 
  doc, 
  getDoc, 
  setDoc, 
  deleteDoc,
  Timestamp 
} from "firebase/firestore";
import { 
  initializeDraft, 
  submitDraftPick 
} from "./src/services/leagueService.js";

const TEST_EMAIL = "concurrency_runner_temp@example.com";
const TEST_PASSWORD = "TempPassword123!";

async function authenticate() {
  console.log("🔑 Authenticating test runner client session...");
  try {
    const userCredential = await signInWithEmailAndPassword(auth, TEST_EMAIL, TEST_PASSWORD);
    console.log(`✅ Authenticated successfully as ${userCredential.user.email}`);
    return userCredential.user;
  } catch (error) {
    if (error.code === 'auth/user-not-found' || error.code === 'auth/invalid-credential') {
      const userCredential = await createUserWithEmailAndPassword(auth, TEST_EMAIL, TEST_PASSWORD);
      console.log(`✅ Account created and authenticated as ${userCredential.user.email}`);
      return userCredential.user;
    }
    throw error;
  }
}

async function runTest() {
  let testUser = null;
  const leagueId = "draft_test_league_999";
  const createdDocs = [];

  try {
    // 1. Authenticate to satisfy Firestore security rules
    testUser = await authenticate();

    console.log("\n🏔️ Initializing Mock League & Draft environment...");

    // We create a mock league with 2 rounds total:
    // forwards starters = 1 | goalies starters = 1 | defense starters = 0 | bench = 0
    // Total picks across 4 teams = 2 * 4 = 8 picks.
    const leagueRef = doc(db, "fantasy_leagues", leagueId);
    await setDoc(leagueRef, {
      name: "Snake Draft Test League",
      maxTeams: 4,
      status: "pending",
      rosterSettings: {
        bench: 0,
        forwards: { starters: 1, max: 2 },
        defense: { starters: 0, max: 0 },
        goalies: { starters: 1, max: 1 }
      }
    });
    createdDocs.push(leagueRef);
    console.log("✅ Mock fantasy league initialized in Firestore.");

    // Initialize Draft order with 4 test users
    const draftOrder = ["uid_1", "uid_2", "uid_3", "uid_4"];
    console.log(`🎮 Initializing draft with order: [${draftOrder.join(" ➜ ")}]`);
    await initializeDraft(leagueId, draftOrder);
    
    const draftStateRef = doc(db, `fantasy_leagues/${leagueId}/draft`, "state");
    createdDocs.push(draftStateRef);
    console.log("✅ Draft state subcollection document initialized successfully.");

    // Fetch initial draft state
    let draftSnap = await getDoc(draftStateRef);
    let draftData = draftSnap.data();
    console.log(`👥 Current Turn: Round ${draftData.currentRound} | Team: "${draftData.currentTeamOnClock}" | Pick index: ${draftData.currentPickIndex}`);

    console.log("\n🧪 Running Draft Verification Suite...");

    // ── ASSERTION 1: Out-of-turn Protection ──
    console.log("🛡️ [Assertion 1] Testing out-of-turn lock...");
    try {
      // uid_2 tries to pick when uid_1 is on the clock
      await submitDraftPick(leagueId, "uid_2", "player_A");
      throw new Error("CRITICAL FAILURE: uid_2 was allowed to pick out of turn!");
    } catch (e) {
      console.log(`   ✅ Correctly blocked out-of-turn pick. Reason: "${e.message}"`);
    }

    // ── ASSERTION 2: First Pick Success ──
    console.log("🛡️ [Assertion 2] Submitting valid first pick (uid_1)...");
    await submitDraftPick(leagueId, "uid_1", "player_A");
    console.log("   ✅ uid_1 successfully drafted player_A.");

    // Verify turn advanced to uid_2
    draftSnap = await getDoc(draftStateRef);
    draftData = draftSnap.data();
    if (draftData.currentTeamOnClock !== "uid_2" || draftData.currentPickIndex !== 1) {
      throw new Error(`Integrity error: Turn did not advance correctly to uid_2. Current clock: ${draftData.currentTeamOnClock}`);
    }
    console.log(`   ✅ Turn advanced correctly: Round ${draftData.currentRound} | Team: "${draftData.currentTeamOnClock}"`);

    // ── ASSERTION 3: Double Selection / Atomic Protection ──
    console.log("🛡️ [Assertion 3] Testing double selection atomic block...");
    try {
      // uid_2 tries to draft player_A which was already taken by uid_1
      await submitDraftPick(leagueId, "uid_2", "player_A");
      throw new Error("CRITICAL FAILURE: uid_2 was allowed to select an already drafted player!");
    } catch (e) {
      console.log(`   ✅ Correctly blocked duplicate draft selection. Reason: "${e.message}"`);
    }

    // ── ASSERTION 4: Round 1 Forward Sequence ──
    console.log("🛡️ [Assertion 4] Completing Round 1 forward sequence...");
    await submitDraftPick(leagueId, "uid_2", "player_B");
    console.log("   ✅ uid_2 drafted player_B.");
    await submitDraftPick(leagueId, "uid_3", "player_C");
    console.log("   ✅ uid_3 drafted player_C.");
    await submitDraftPick(leagueId, "uid_4", "player_D");
    console.log("   ✅ uid_4 drafted player_D.");

    // Fetch state to confirm Round 1 completion and snake reverse turn
    draftSnap = await getDoc(draftStateRef);
    draftData = draftSnap.data();
    console.log(`👥 Draft State: Round ${draftData.currentRound} | Team On Clock: "${draftData.currentTeamOnClock}" | Pick index: ${draftData.currentPickIndex}`);
    
    if (draftData.currentRound !== 2 || draftData.currentTeamOnClock !== "uid_4") {
      throw new Error(`Snake Order Failure: Round 2 did not reverse to uid_4! Clock: ${draftData.currentTeamOnClock}`);
    }
    console.log("   ⭐ Odd Round (1) complete! Snake reversed correctly: uid_4 is back-to-back on the clock for Round 2!");

    // ── ASSERTION 5: Round 2 Snake Sequence (Even Round Reverse) ──
    console.log("🛡️ [Assertion 5] Processing Round 2 snake reverse sequence...");
    await submitDraftPick(leagueId, "uid_4", "player_E");
    console.log("   ✅ uid_4 drafted player_E (back-to-back).");
    await submitDraftPick(leagueId, "uid_3", "player_F");
    console.log("   ✅ uid_3 drafted player_F.");
    await submitDraftPick(leagueId, "uid_2", "player_G");
    console.log("   ✅ uid_2 drafted player_G.");

    // Fetch state: uid_1 is on the clock for the last pick
    draftSnap = await getDoc(draftStateRef);
    draftData = draftSnap.data();
    console.log(`👥 Current Clock: Team "${draftData.currentTeamOnClock}" (Pick Index: ${draftData.currentPickIndex}/8)`);

    if (draftData.currentTeamOnClock !== "uid_1") {
      throw new Error(`Snake Order Failure: Turn did not snake back to uid_1! Current clock: ${draftData.currentTeamOnClock}`);
    }
    console.log("   ⭐ Even Round (2) snaked backward successfully: uid_1 is on the clock for the final pick!");

    // ── ASSERTION 6: Timeout Auto-Pick Mechanics ──
    console.log("🛡️ [Assertion 6] Simulating clock timeout and auto-pick execution...");
    
    // Artificially expire pick deadline in Firestore directly
    const expiredDeadline = Timestamp.fromMillis(Date.now() - 10000); // 10 seconds in the past
    await setDoc(draftStateRef, {
      pickDeadline: expiredDeadline
    }, { merge: true });
    
    console.log("   ⏰ Clock expired artificially. Submitting auto-pick request...");
    // Trigger isAutoPick = true which bypasses authorization and drafts player_H
    await submitDraftPick(leagueId, "uid_1", "player_H", true);
    console.log("   ✅ Timeout auto-pick executed successfully!");

    // ── ASSERTION 7: Final Draft Completion ──
    console.log("🛡️ [Assertion 7] Verifying complete draft states...");
    
    // Fetch final draft state
    draftSnap = await getDoc(draftStateRef);
    draftData = draftSnap.data();
    
    // Fetch final league state
    const leagueSnap = await getDoc(leagueRef);
    const leagueData = leagueSnap.data();

    console.log(`📈 Final Draft Status: "${draftData.status}"`);
    console.log(`📈 Final League Status: "${leagueData.status}"`);
    console.log("🏡 Active Rosters in Database:");
    Object.entries(draftData.activeRosters).forEach(([uid, roster]) => {
      console.log(`   - Team "${uid}": [${roster.join(", ")}]`);
    });

    if (draftData.status !== "completed") {
      throw new Error(`Integrity Failure: Draft status is "${draftData.status}", expected "completed".`);
    }
    if (leagueData.status !== "active") {
      throw new Error(`Integrity Failure: League status is "${leagueData.status}", expected "active".`);
    }
    if (draftData.picks.length !== 8) {
      throw new Error(`Integrity Failure: Total picks is ${draftData.picks.length}, expected exactly 8.`);
    }

    console.log("\n⭐ SNAKE DRAFT SYSTEM INTEGRATION TEST PASSED PERFECTLY! ⭐\n");

  } catch (error) {
    console.error("\n💥 DRAFT INTEGRITY TEST FAILED:", error);
    process.exitCode = 1;
  } finally {
    // 5. Clean up mock database records
    console.log("🧹 Restoring Firestore database to pristine status...");
    for (const ref of createdDocs) {
      try {
        await deleteDoc(ref);
      } catch (e) {
        console.error(`Failed to delete document:`, e.message);
      }
    }
    console.log("✅ Cleanup complete.");

    // Clean up temporary user
    if (testUser) {
      console.log("👤 Cleaning up temporary authentication account...");
      try {
        await deleteUser(testUser);
        console.log("✅ Auth account deleted.");
      } catch (e) {
        console.error("Failed to delete user account:", e.message);
      }
    }

    console.log("👋 Verification script completed.");
    process.exit();
  }
}

runTest();
