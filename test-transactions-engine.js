/**
 * Standalone Integration Test Script: Fantasy Transactions Engine
 * Verifies Add/Drops (roster limits, Free Agency, waiver placement),
 * rolling Waiver Claims (priority roll, queue rotation, auto-swap),
 * and Trade Proposals (state transitions, 24-hour review delay, asset verification, swap).
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
  collection,
  getDocs,
  Timestamp 
} from "firebase/firestore";
import { 
  submitAddDrop,
  submitWaiverClaim,
  processWaivers,
  submitTradeProposal,
  respondToTrade,
  processAcceptedTrades,
  setTestDateOverride
} from "./src/services/leagueService.js";

const TEST_EMAIL = "transactions_tester_temp@example.com";
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
      console.log(`✅ Temporary account created and authenticated as ${userCredential.user.email}`);
      return userCredential.user;
    }
    throw error;
  }
}

async function runTest() {
  let testUser = null;
  const leagueId = "transaction_test_league_888";
  const createdDocs = [];

  try {
    // 1. Authenticate to satisfy Firestore security rules
    testUser = await authenticate();

    console.log("\n🏔️ Initializing Mock League & Roster environment...");

    // Create a mock league with 4 teams and custom roster limits:
    // bench = 0, forwards starters = 1, defense starters = 1, goalies starters = 0
    // Total max roster size = 0 + 1 + 1 + 0 = 2 players.
    const leagueRef = doc(db, "fantasy_leagues", leagueId);
    const waiverOrder = ["team_A", "team_B", "team_C", "team_D"];
    
    await setDoc(leagueRef, {
      name: "Transactions Engine Test League",
      maxTeams: 4,
      status: "active",
      rosterSettings: {
        bench: 0,
        forwards: { starters: 1, max: 1 },
        defense: { starters: 1, max: 1 },
        goalies: { starters: 0, max: 0 }
      },
      waiverOrder: waiverOrder
    });
    createdDocs.push(leagueRef);
    console.log("✅ Mock fantasy league rules initialized in Firestore.");

    // Create the 4 teams in the league
    const teamA_Ref = doc(db, `fantasy_leagues/${leagueId}/teams`, "team_A");
    const teamB_Ref = doc(db, `fantasy_leagues/${leagueId}/teams`, "team_B");
    const teamC_Ref = doc(db, `fantasy_leagues/${leagueId}/teams`, "team_C");
    const teamD_Ref = doc(db, `fantasy_leagues/${leagueId}/teams`, "team_D");

    await setDoc(teamA_Ref, { teamName: "Team A", ownerId: "uid_A", players: ["player_1", "player_2"] });
    await setDoc(teamB_Ref, { teamName: "Team B", ownerId: "uid_B", players: ["player_3", "player_4"] });
    await setDoc(teamC_Ref, { teamName: "Team C", ownerId: "uid_C", players: ["player_5", "player_6"] });
    await setDoc(teamD_Ref, { teamName: "Team D", ownerId: "uid_D", players: ["player_7", "player_8"] });

    createdDocs.push(teamA_Ref, teamB_Ref, teamC_Ref, teamD_Ref);
    console.log("✅ Mock team rosters initialized (each team owns exactly 2 players).");

    // Initialize baseline simulated system date: May 29, 2026 12:00:00 UTC
    const baselineDate = new Date("2026-05-29T12:00:00Z");
    setTestDateOverride(baselineDate);
    console.log(`⏰ Baseline simulated clock set to: ${baselineDate.toISOString()}`);

    console.log("\n🧪 Running Transactions Verification Suite...");

    // ────────────────────────────────────────────────────────
    // 🧪 PHASE 1: Add/Drop & Roster Limits
    // ────────────────────────────────────────────────────────
    console.log("\n🛡️ [PHASE 1] Testing Add/Drop Free Agency swap & Roster limits...");

    // Test case 1a: Valid Add/Drop swap (team_A swaps player_2 for free agent player_FA)
    console.log("   👉 Team A performing valid Add/Drop (Acquire 'player_FA', Drop 'player_2')...");
    await submitAddDrop(leagueId, "team_A", "uid_A", "player_FA", "player_2");
    
    // Assert team_A's roster was atomically updated
    let teamSnap = await getDoc(teamA_Ref);
    let roster = teamSnap.data().players || [];
    console.log(`   - Team A updated roster: [${roster.join(", ")}] (Expected: ['player_1', 'player_FA'])`);
    if (roster.length !== 2 || !roster.includes("player_1") || !roster.includes("player_FA")) {
      throw new Error(`Roster mismatch for team_A. Got [${roster.join(", ")}]`);
    }
    console.log("   ✅ Valid Add/Drop executed atomically.");

    // Assert player_2 was placed on waivers for 48 hours
    const waiverRef_2 = doc(db, `fantasy_leagues/${leagueId}/waivers`, "player_2");
    createdDocs.push(waiverRef_2);
    let waiverSnap = await getDoc(waiverRef_2);
    if (!waiverSnap.exists()) {
      throw new Error("Waiver document was not created for dropped player_2!");
    }
    const waiverData = waiverSnap.data();
    const expectedWaiverDeadline = new Date(baselineDate.getTime() + 48 * 60 * 60 * 1000);
    const actualWaiverDeadline = waiverData.waiverDeadline.toDate();
    console.log(`   - Dropped player 'player_2' waiver deadline: ${actualWaiverDeadline.toISOString()}`);
    console.log(`     (Expected exactly: ${expectedWaiverDeadline.toISOString()})`);
    
    if (actualWaiverDeadline.getTime() !== expectedWaiverDeadline.getTime()) {
      throw new Error("Waiver deadline timestamp calculation mismatch!");
    }
    console.log("   ✅ Dropped player placed on 48-hour waivers successfully.");

    // Test case 1b: Roster Limit violation (team_A tries to add player_FA2 without dropping anyone)
    console.log("   👉 Team A trying to add 'player_FA2' without drop (should exceed max roster size of 2)...");
    try {
      await submitAddDrop(leagueId, "team_A", "uid_A", "player_FA2", null);
      throw new Error("CRITICAL FAILURE: Roster limits were not enforced!");
    } catch (e) {
      console.log(`   ✅ Correctly blocked roster violation. Reason: "${e.message}"`);
    }

    // ────────────────────────────────────────────────────────
    // 🧪 PHASE 2: Competing Waiver Claims & Rolling Priority
    // ────────────────────────────────────────────────────────
    console.log("\n🛡️ [PHASE 2] Testing Competing Waiver Claims & Rolling Priority Queue...");

    // team_B (uid_B) submits claim on player_2, dropping player_4
    console.log("   👉 Team B submitting waiver claim on 'player_2' (designates 'player_4' to drop)...");
    await submitWaiverClaim(leagueId, "team_B", "uid_B", "player_2", "player_4");
    const claimBRef = doc(db, `fantasy_leagues/${leagueId}/waiver_claims`, "team_B_player_2");
    createdDocs.push(claimBRef);

    // team_C (uid_C) submits claim on player_2, dropping player_6
    console.log("   👉 Team C submitting waiver claim on 'player_2' (designates 'player_6' to drop)...");
    await submitWaiverClaim(leagueId, "team_C", "uid_C", "player_2", "player_6");
    const claimCRef = doc(db, `fantasy_leagues/${leagueId}/waiver_claims`, "team_C_player_2");
    createdDocs.push(claimCRef);

    // Test case 2a: Process waivers BEFORE the deadline (should do nothing)
    console.log("   👉 Trying to process waivers before deadline at baseline system date...");
    await processWaivers(leagueId);
    
    waiverSnap = await getDoc(waiverRef_2);
    if (!waiverSnap.exists()) {
      throw new Error("Waiver processed prematurely!");
    }
    console.log("   ✅ Waiver remained active because the simulated date hasn't reached the deadline.");

    // Test case 2b: Process waivers AFTER the 48-hour deadline (team_B has higher priority than team_C)
    // Advance simulated clock: May 31, 2026 12:01:00 UTC (+48h 1m)
    const advancedDate = new Date("2026-05-31T12:01:00Z");
    setTestDateOverride(advancedDate);
    console.log(`   ⏰ Advanced simulated clock (+48h) to: ${advancedDate.toISOString()}`);

    console.log("   👉 Triggering waiver processing...");
    await processWaivers(leagueId);

    // Assert player_2 is no longer on waivers (claims deleted, waiver deleted)
    waiverSnap = await getDoc(waiverRef_2);
    if (waiverSnap.exists()) {
      throw new Error("Waiver document was not cleaned up/deleted after processing!");
    }
    const claimBSnap = await getDoc(claimBRef);
    const claimCSnap = await getDoc(claimCRef);
    if (claimBSnap.exists() || claimCSnap.exists()) {
      throw new Error("Waiver claim documents were not cleaned up/deleted after processing!");
    }
    console.log("   ✅ Waiver and claim documents successfully cleaned up.");

    // Assert that team_B (higher priority in queue ['team_A', 'team_B', 'team_C', 'team_D']) won player_2
    const teamBSnap = await getDoc(teamB_Ref);
    const rosterB = teamBSnap.data().players || [];
    console.log(`   - Team B updated roster: [${rosterB.join(", ")}] (Expected: ['player_3', 'player_2'])`);
    if (rosterB.length !== 2 || !rosterB.includes("player_3") || !rosterB.includes("player_2")) {
      throw new Error(`Waiver winner assignment error. Team B roster: [${rosterB.join(", ")}]`);
    }
    console.log("   ✅ Winner team_B successfully awarded player_2.");

    // Assert that team_C (loser) roster remains unchanged
    const teamCSnap = await getDoc(teamC_Ref);
    const rosterC = teamCSnap.data().players || [];
    console.log(`   - Team C roster remains intact: [${rosterC.join(", ")}] (Expected: ['player_5', 'player_6'])`);
    if (rosterC.length !== 2 || !rosterC.includes("player_5") || !rosterC.includes("player_6")) {
      throw new Error(`Team C roster modified incorrectly. Roster: [${rosterC.join(", ")}]`);
    }
    console.log("   ✅ Loser team_C roster remained perfectly intact.");

    // Assert that player_4 (dropped by winning team_B) was placed on waivers
    const waiverRef_4 = doc(db, `fantasy_leagues/${leagueId}/waivers`, "player_4");
    createdDocs.push(waiverRef_4);
    const waiver4Snap = await getDoc(waiverRef_4);
    if (!waiver4Snap.exists()) {
      throw new Error("Dropped player_4 was not placed on waivers!");
    }
    console.log(`   - Dropped player 'player_4' successfully placed on waivers with deadline: ${waiver4Snap.data().waiverDeadline.toDate().toISOString()}`);
    console.log("   ✅ Dropped player from successful waiver claim placed on waivers.");

    // Assert rolling waiverOrder rotation (team_B moves to the bottom)
    // Old: ['team_A', 'team_B', 'team_C', 'team_D']
    // Expected New: ['team_A', 'team_C', 'team_D', 'team_B']
    const leagueSnap = await getDoc(leagueRef);
    const currentWaiverOrder = leagueSnap.data().waiverOrder || [];
    console.log(`   - Updated rolling waiver order: [${currentWaiverOrder.join(" ➜ ")}]`);
    console.log(`     (Expected: [team_A ➜ team_C ➜ team_D ➜ team_B])`);
    if (
      currentWaiverOrder.length !== 4 ||
      currentWaiverOrder[0] !== "team_A" ||
      currentWaiverOrder[1] !== "team_C" ||
      currentWaiverOrder[2] !== "team_D" ||
      currentWaiverOrder[3] !== "team_B"
    ) {
      throw new Error("Waiver order was not rotated correctly!");
    }
    console.log("   ✅ Rolling priority order successfully rotated to the bottom.");

    // ────────────────────────────────────────────────────────
    // 🧪 PHASE 3: Trades & Delayed Execution Windows
    // ────────────────────────────────────────────────────────
    console.log("\n🛡️ [PHASE 3] Testing Trades Proposal, Acceptance, and 24h Review Delay...");

    // Propose trade: team_A sends player_FA, team_B sends player_2
    console.log("   👉 Team A proposing Trade to Team B (Sends 'player_FA', Receives 'player_2')...");
    const tradeId = await submitTradeProposal(
      leagueId,
      "team_A",
      "team_B",
      ["player_FA"],
      ["player_2"]
    );
    const tradeRef = doc(db, `fantasy_leagues/${leagueId}/trades`, tradeId);
    createdDocs.push(tradeRef);

    let tradeSnap = await getDoc(tradeRef);
    if (!tradeSnap.exists()) {
      throw new Error("Trade proposal was not created!");
    }
    console.log(`   - Trade proposed successfully. ID: ${tradeId} | Status: "${tradeSnap.data().status}"`);
    if (tradeSnap.data().status !== "pending") {
      throw new Error(`Unexpected trade status. Got "${tradeSnap.data().status}"`);
    }
    console.log("   ✅ Trade proposed and initialized with 'pending' status.");

    // team_B responds to trade (Accepts trade)
    console.log("   👉 Team B responding to proposal: Accepting trade...");
    await respondToTrade(leagueId, tradeId, "uid_B", "accept");

    tradeSnap = await getDoc(tradeRef);
    const processDeadline = tradeSnap.data().processDeadline.toDate();
    const expectedProcessDeadline = new Date(advancedDate.getTime() + 24 * 60 * 60 * 1000);
    console.log(`   - Trade accepted successfully. Status: "${tradeSnap.data().status}"`);
    console.log(`   - Process veto-delay deadline set: ${processDeadline.toISOString()}`);
    console.log(`     (Expected exactly: ${expectedProcessDeadline.toISOString()})`);

    if (tradeSnap.data().status !== "accepted") {
      throw new Error(`Unexpected trade status after acceptance. Got "${tradeSnap.data().status}"`);
    }
    if (processDeadline.getTime() !== expectedProcessDeadline.getTime()) {
      throw new Error("Trade process deadline mismatch!");
    }
    console.log("   ✅ Trade accepted and 24-hour veto-review delay configured successfully.");

    // Test case 3a: Run processAcceptedTrades BEFORE review period is complete (should do nothing)
    console.log("   👉 Running processAcceptedTrades before the 24-hour delay expires...");
    await processAcceptedTrades(leagueId);

    // Verify rosters and status remain unchanged
    tradeSnap = await getDoc(tradeRef);
    if (tradeSnap.data().status !== "accepted") {
      throw new Error("Trade was processed before its deadline!");
    }
    console.log("   ✅ Trade remained locked/accepted inside the 24-hour review period.");

    // Test case 3b: Run processAcceptedTrades AFTER 24-hour review period is complete
    // Advance simulated clock: June 1, 2026 12:02:00 UTC (+24h 1m)
    const tradeExecutionDate = new Date("2026-06-01T12:02:00Z");
    setTestDateOverride(tradeExecutionDate);
    console.log(`   ⏰ Advanced simulated clock (+24h) to: ${tradeExecutionDate.toISOString()}`);

    console.log("   👉 Triggering trade execution processing...");
    await processAcceptedTrades(leagueId);

    // Verify trade status updated to 'processed'
    tradeSnap = await getDoc(tradeRef);
    console.log(`   - Trade execution status: "${tradeSnap.data().status}"`);
    if (tradeSnap.data().status !== "processed") {
      throw new Error(`Trade failed to execute or update status. Status: "${tradeSnap.data().status}"`);
    }

    // Verify atomic player swap in rosters
    // team_A: was ['player_1', 'player_FA'], now should be ['player_1', 'player_2']
    // team_B: was ['player_3', 'player_2'], now should be ['player_3', 'player_FA']
    const teamA_Snap = await getDoc(teamA_Ref);
    const rosterA = teamA_Snap.data().players || [];
    console.log(`   - Team A roster after Trade: [${rosterA.join(", ")}] (Expected: ['player_1', 'player_2'])`);
    if (rosterA.length !== 2 || !rosterA.includes("player_1") || !rosterA.includes("player_2")) {
      throw new Error("Trade swap failed for Team A!");
    }

    const teamB_Snap2 = await getDoc(teamB_Ref);
    const rosterB2 = teamB_Snap2.data().players || [];
    console.log(`   - Team B roster after Trade: [${rosterB2.join(", ")}] (Expected: ['player_3', 'player_FA'])`);
    if (rosterB2.length !== 2 || !rosterB2.includes("player_3") || !rosterB2.includes("player_FA")) {
      throw new Error("Trade swap failed for Team B!");
    }
    console.log("   ✅ Trade assets successfully and atomically swapped across both rosters!");

    console.log("\n⭐ FANTASY TRANSACTIONS ENGINE INTEGRATION TEST PASSED PERFECTLY! ⭐\n");

  } catch (error) {
    console.error("\n💥 INTEGRITY TEST FAILED:", error);
    process.exitCode = 1;
  } finally {
    // 6. Robust cleanup to keep Firestore pristine
    console.log("🧹 Restoring Firestore database to pristine status...");
    
    // Fetch all waiver claims, waivers, and trades in the league space just in case some weren't manually added to createdDocs
    try {
      const claimsSnap = await getDocs(collection(db, `fantasy_leagues/${leagueId}/waiver_claims`));
      claimsSnap.forEach(docSnap => createdDocs.push(docSnap.ref));
      
      const waiversSnap = await getDocs(collection(db, `fantasy_leagues/${leagueId}/waivers`));
      waiversSnap.forEach(docSnap => createdDocs.push(docSnap.ref));

      const tradesSnap = await getDocs(collection(db, `fantasy_leagues/${leagueId}/trades`));
      tradesSnap.forEach(docSnap => createdDocs.push(docSnap.ref));
    } catch (e) {
      console.error("Failed to query subcollections for cleanup:", e.message);
    }

    // Delete all collected document references in reverse order
    for (let i = createdDocs.length - 1; i >= 0; i--) {
      const ref = createdDocs[i];
      try {
        await deleteDoc(ref);
      } catch (e) {
        console.error(`Failed to delete document ${ref.path}:`, e.message);
      }
    }
    console.log("✅ Firestore test documents and subcollections cleaned up successfully.");

    // Clean up temporary authentication user
    if (testUser) {
      console.log("👤 Cleaning up temporary authentication account...");
      try {
        await deleteUser(testUser);
        console.log("✅ Temporary authentication account deleted successfully.");
      } catch (e) {
        console.error("Failed to delete temporary auth user:", e.message);
      }
    }

    console.log("👋 Verification script completed.");
    process.exit();
  }
}

runTest();
