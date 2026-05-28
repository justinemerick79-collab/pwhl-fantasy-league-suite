/**
 * Standalone Verification Script: Transactions Phase 1
 * Simulates 4 users trying to join a league with only 1 remaining open slot simultaneously.
 * Verifies transaction integrity under concurrency on the live database.
 */

import { auth, db } from "./src/firebase.js";
import { 
  signInWithEmailAndPassword, 
  createUserWithEmailAndPassword, 
  deleteUser 
} from "firebase/auth";
import { 
  createLeague, 
  joinLeague 
} from "./src/services/leagueService.js";
import { 
  doc, 
  getDoc, 
  collection, 
  getDocs, 
  deleteDoc 
} from "firebase/firestore";

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
      console.log("📝 Creating temporary test runner user account...");
      const userCredential = await createUserWithEmailAndPassword(auth, TEST_EMAIL, TEST_PASSWORD);
      console.log(`✅ Account created and authenticated as ${userCredential.user.email}`);
      return userCredential.user;
    }
    throw error;
  }
}

async function runTest() {
  let testUser = null;
  let createdLeagueId = null;
  const teamsToDelete = [];

  try {
    // 1. Authenticate to satisfy Firestore security rules (allow read, write: if isAuthenticated();)
    testUser = await authenticate();

    console.log("\n🏔️ Initializing Concurrency Test...");
    
    // We create a league with maxTeams = 4 (respecting production rules which require 4-10 teams)
    const maxTeams = 4;
    console.log(`🎮 Creating test league with maxTeams = ${maxTeams}...`);
    createdLeagueId = await createLeague(
      "Transaction Test League",
      maxTeams,
      "mock_user_1",
      "Commissioner Team"
    );
    console.log(`✅ Test league created successfully with ID: ${createdLeagueId}`);

    // Fetch the league doc to retrieve the generated inviteCode
    const leagueRef = doc(db, "fantasy_leagues", createdLeagueId);
    let leagueSnap = await getDoc(leagueRef);
    let leagueData = leagueSnap.data();
    const inviteCode = leagueData.inviteCode;
    console.log(`🎫 Invite Code generated: "${inviteCode}"`);

    // Add mock_user_2 and mock_user_3 sequentially to occupy 2 more slots.
    // Total members will become 3. Remaining slots will be exactly 1.
    console.log("👥 Filling league slots sequentially to leave exactly 1 open slot...");
    await joinLeague(inviteCode, "mock_user_2", "Team Two");
    console.log("   - mock_user_2 successfully joined.");
    await joinLeague(inviteCode, "mock_user_3", "Team Three");
    console.log("   - mock_user_3 successfully joined.");

    // Fetch current state
    leagueSnap = await getDoc(leagueRef);
    leagueData = leagueSnap.data();
    console.log(`👥 Current members: [${leagueData.members.join(", ")}] (count: ${leagueData.members.length}/${maxTeams})`);
    console.log(`Remaining slots: ${maxTeams - leagueData.members.length}\n`);

    // 2. Simulate 4 concurrent users attempting to join the league simultaneously.
    // Only one should succeed because there is only 1 slot remaining.
    const mockUsers = [
      { id: "mock_user_4", team: "Team Four" },
      { id: "mock_user_5", team: "Team Five" },
      { id: "mock_user_6", team: "Team Six" },
      { id: "mock_user_7", team: "Team Seven" }
    ];

    console.log(`⚡ Dispatching ${mockUsers.length} concurrent join requests simultaneously...`);
    const joinPromises = mockUsers.map(user => {
      console.log(`🚀 [User: ${user.id}] Requesting to join...`);
      return joinLeague(inviteCode, user.id, user.team);
    });

    // Run all join requests concurrently and capture their outcomes
    const results = await Promise.allSettled(joinPromises);

    console.log("\n📊 Concurrency Execution Results:");
    let successCount = 0;
    let failureCount = 0;

    results.forEach((res, index) => {
      const user = mockUsers[index];
      if (res.status === "fulfilled") {
        successCount++;
        console.log(`✅ [User: ${user.id}] SUCCEEDED inside the transaction.`);
      } else {
        failureCount++;
        console.log(`❌ [User: ${user.id}] REJECTED with message: "${res.reason.message}"`);
      }
    });

    console.log("\n🧐 Asserting Transaction Integrity...");
    console.log(`- Total Successful Joins: ${successCount} (Expected: 1)`);
    console.log(`- Total Rejected Joins: ${failureCount} (Expected: 3)`);

    if (successCount !== 1) {
      throw new Error(`CRITICAL INTEGRITY FAILURE: ${successCount} users successfully joined, expected exactly 1.`);
    }
    console.log("🎯 Concurrency assertions met: Exactly 1 user joined, 3 were rejected!");

    // 3. Inspect final state in Firestore
    console.log("\n🔍 Fetching final league document state from Firestore...");
    const finalLeagueSnap = await getDoc(leagueRef);
    const finalLeagueData = finalLeagueSnap.data();

    console.log(`👥 Final members array: [${finalLeagueData.members.join(", ")}] (count: ${finalLeagueData.members.length})`);
    console.log(`📈 Final status: "${finalLeagueData.status}"`);

    // Fetch the teams subcollection
    const teamsSnap = await getDocs(collection(leagueRef, "teams"));
    console.log(`🏘️ Teams in subcollection: ${teamsSnap.size}`);
    teamsSnap.forEach(tDoc => {
      teamsToDelete.push(tDoc.id);
      const data = tDoc.data();
      console.log(`   - Team: "${data.teamName}" | Owner: ${data.ownerId}`);
    });

    // Assert final database state
    if (finalLeagueData.members.length !== 4) {
      throw new Error(`STATE INTEGRITY FAILURE: Members count is ${finalLeagueData.members.length}, expected exactly 4.`);
    }
    // Note: status is expected to stay "pending" as initialized by createLeague (commissioner setup flow)
    if (finalLeagueData.status !== "pending") {
      throw new Error(`STATE INTEGRITY FAILURE: League status is "${finalLeagueData.status}", expected "pending".`);
    }
    if (teamsSnap.size !== 4) {
      throw new Error(`STATE INTEGRITY FAILURE: Found ${teamsSnap.size} team documents, expected exactly 4.`);
    }

    console.log("\n⭐ CONCURRENCY TRANSACTION TEST PASSED PERFECTLY! ⭐\n");

  } catch (error) {
    console.error("\n💥 TEST FAILED:", error);
    process.exitCode = 1;
  } finally {
    // 4. Clean up test documents to keep database pristine
    console.log("🧹 Cleaning up Firestore test data...");
    if (createdLeagueId) {
      const leagueRef = doc(db, "fantasy_leagues", createdLeagueId);
      
      // Delete team documents first
      for (const teamId of teamsToDelete) {
        try {
          await deleteDoc(doc(db, `fantasy_leagues/${createdLeagueId}/teams`, teamId));
        } catch (e) {
          console.error(`Failed to delete team ${teamId}:`, e.message);
        }
      }
      
      // Delete league document
      try {
        await deleteDoc(leagueRef);
        console.log("✅ Firestore test league document and team subcollections cleaned up successfully.");
      } catch (e) {
        console.error("Failed to delete league document:", e.message);
      }
    }

    // Clean up temporary user
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
