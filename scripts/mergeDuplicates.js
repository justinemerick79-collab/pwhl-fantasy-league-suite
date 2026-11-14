import { initializeApp } from "firebase/app";
import { 
  getFirestore, 
  collection, 
  getDocs, 
  doc, 
  getDoc, 
  setDoc, 
  updateDoc, 
  deleteDoc, 
  writeBatch 
} from "firebase/firestore";
import { 
  getAuth, 
  signInWithEmailAndPassword, 
  createUserWithEmailAndPassword 
} from "firebase/auth";

const firebaseConfig = {
  projectId: "pwhl-fantasy-mobile-26",
  appId: "1:502197146749:web:48318c0fda30defd4dcd14",
  storageBucket: "pwhl-fantasy-mobile-26.firebasestorage.app",
  apiKey: "AIzaSyBUpX8nhgUOoBJABs9UNsv0j2GAVL57ZDU",
  authDomain: "pwhl-fantasy-mobile-26.firebaseapp.com",
  messagingSenderId: "502197146749"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

const ADMIN_EMAIL = "gameloop_admin_temp@example.com";
const ADMIN_PASSWORD = "TempPassword123!";

// Static mapping of custom player IDs to official player IDs
const MERGE_MAPS = {
  "10001": "189", // Britta Curl -> Britta Curl-Salemme
  "10002": "198", // Jennifer Gardiner -> Jenn Gardiner
  "10003": "114", // Abigail Boreen -> Abby Boreen
  "10004": "214"  // Noemi Neubauerova -> Noemi Neubauerová
};

// Helper to deduplicate array elements
function deduplicate(arr) {
  return [...new Set(arr)];
}

async function authenticate() {
  console.log("🔑 Authenticating client session...");
  let user;
  try {
    const userCredential = await signInWithEmailAndPassword(auth, ADMIN_EMAIL, ADMIN_PASSWORD);
    user = userCredential.user;
    console.log(`✅ Authenticated successfully as ${user.email}`);
  } catch (error) {
    if (error.code === 'auth/user-not-found' || error.code === 'auth/invalid-credential') {
      const userCredential = await createUserWithEmailAndPassword(auth, ADMIN_EMAIL, ADMIN_PASSWORD);
      user = userCredential.user;
      console.log(`✅ Temporary account created and authenticated as ${user.email}`);
    } else {
      throw error;
    }
  }

  // Elevate to admin role in Firestore
  console.log(`🛡️ Ensuring admin privilege for user ${user.uid}...`);
  const userDocRef = doc(db, "users", user.uid);
  await setDoc(userDocRef, {
    email: ADMIN_EMAIL,
    role: "admin",
    isTestNode: true
  }, { merge: true });
  console.log("✅ Admin privilege granted in database.");
  return user;
}

async function runMigration() {
  await authenticate();

  console.log("\n🚀 Starting Duplicate Player Merge Migration...");

  // 1. Scan and Merge inside Fantasy Leagues
  console.log("Scanning fantasy leagues...");
  const leaguesSnap = await getDocs(collection(db, "fantasy_leagues"));
  console.log(`Found ${leaguesSnap.size} leagues.`);

  for (const leagueDoc of leaguesSnap.docs) {
    const leagueId = leagueDoc.id;
    const leagueName = leagueDoc.data().name || leagueId;
    console.log(`\n--- Processing League: "${leagueName}" (${leagueId}) ---`);

    // A. Process League Teams
    const teamsSnap = await getDocs(collection(db, `fantasy_leagues/${leagueId}/teams`));
    console.log(`Found ${teamsSnap.size} teams.`);

    for (const teamDoc of teamsSnap.docs) {
      const teamId = teamDoc.id;
      const teamData = teamDoc.data();
      let teamChanged = false;

      const players = teamData.players || [];
      const activePlayers = teamData.activePlayers || [];
      const benchPlayers = teamData.benchPlayers || [];

      // Map players array
      const mappedPlayers = players.map(pId => {
        if (MERGE_MAPS[pId]) {
          console.log(`  [Team Roster] Mapping player ${pId} -> ${MERGE_MAPS[pId]} for team "${teamData.teamName}"`);
          teamChanged = true;
          return MERGE_MAPS[pId];
        }
        return pId;
      });

      // Map activePlayers array
      const mappedActive = activePlayers.map(pId => {
        if (MERGE_MAPS[pId]) {
          console.log(`  [Team Active] Mapping active player ${pId} -> ${MERGE_MAPS[pId]} for team "${teamData.teamName}"`);
          teamChanged = true;
          return MERGE_MAPS[pId];
        }
        return pId;
      });

      // Map benchPlayers array
      const mappedBench = benchPlayers.map(pId => {
        if (MERGE_MAPS[pId]) {
          console.log(`  [Team Bench] Mapping bench player ${pId} -> ${MERGE_MAPS[pId]} for team "${teamData.teamName}"`);
          teamChanged = true;
          return MERGE_MAPS[pId];
        }
        return pId;
      });

      if (teamChanged) {
        await updateDoc(doc(db, `fantasy_leagues/${leagueId}/teams`, teamId), {
          players: deduplicate(mappedPlayers),
          activePlayers: deduplicate(mappedActive),
          benchPlayers: deduplicate(mappedBench)
        });
        console.log(`  ✅ Updated team doc for "${teamData.teamName}"`);
      }

      // B. Process Daily Lineups for this team
      const lineupsSnap = await getDocs(collection(db, `fantasy_leagues/${leagueId}/teams/${teamId}/daily_lineups`));
      if (lineupsSnap.size > 0) {
        console.log(`  Processing ${lineupsSnap.size} daily lineups for team "${teamData.teamName}"...`);
        for (const lineupDoc of lineupsSnap.docs) {
          const lineupId = lineupDoc.id;
          const lineupData = lineupDoc.data();
          let lineupChanged = false;

          const activeLineup = lineupData.activeLineup || {};
          const bench = lineupData.bench || [];

          // Map activeLineup slots
          const newActiveLineup = { ...activeLineup };
          for (const [slot, pId] of Object.entries(newActiveLineup)) {
            if (MERGE_MAPS[pId]) {
              console.log(`    [Lineup Active] ${lineupId}: slot ${slot} mapped ${pId} -> ${MERGE_MAPS[pId]}`);
              newActiveLineup[slot] = MERGE_MAPS[pId];
              lineupChanged = true;
            }
          }

          // Map bench array
          const newBench = bench.map(pId => {
            if (MERGE_MAPS[pId]) {
              console.log(`    [Lineup Bench] ${lineupId}: mapped bench player ${pId} -> ${MERGE_MAPS[pId]}`);
              lineupChanged = true;
              return MERGE_MAPS[pId];
            }
            return pId;
          });

          if (lineupChanged) {
            await updateDoc(doc(db, `fantasy_leagues/${leagueId}/teams/${teamId}/daily_lineups`, lineupId), {
              activeLineup: newActiveLineup,
              bench: deduplicate(newBench)
            });
          }
        }
      }
    }

    // C. Process Draft State
    const draftStateRef = doc(db, `fantasy_leagues/${leagueId}/draft`, "state");
    const draftStateSnap = await getDoc(draftStateRef);
    if (draftStateSnap.exists()) {
      const draftData = draftStateSnap.data();
      let draftChanged = false;

      const picks = draftData.picks || [];
      const activeRosters = draftData.activeRosters || draftData.active_rosters || {};

      // Map picks
      const newPicks = picks.map(pick => {
        let pickChanged = false;
        const newPick = { ...pick };
        if (newPick.playerId && MERGE_MAPS[newPick.playerId]) {
          console.log(`  [Draft Pick] Mapping pick ${pick.pickNumber || pick.pickIndex} playerId ${newPick.playerId} -> ${MERGE_MAPS[newPick.playerId]}`);
          newPick.playerId = MERGE_MAPS[newPick.playerId];
          pickChanged = true;
        }
        if (newPick.player_id && MERGE_MAPS[newPick.player_id]) {
          console.log(`  [Draft Pick] Mapping pick ${pick.pickNumber || pick.pickIndex} player_id ${newPick.player_id} -> ${MERGE_MAPS[newPick.player_id]}`);
          newPick.player_id = MERGE_MAPS[newPick.player_id];
          pickChanged = true;
        }
        if (pickChanged) draftChanged = true;
        return newPick;
      });

      // Map activeRosters
      const newActiveRosters = { ...activeRosters };
      for (const [userId, roster] of Object.entries(newActiveRosters)) {
        if (Array.isArray(roster)) {
          let rosterChanged = false;
          const mappedRoster = roster.map(pId => {
            if (MERGE_MAPS[pId]) {
              console.log(`  [Draft ActiveRoster] User ${userId}: mapped player ${pId} -> ${MERGE_MAPS[pId]}`);
              rosterChanged = true;
              return MERGE_MAPS[pId];
            }
            return pId;
          });

          if (rosterChanged) {
            newActiveRosters[userId] = deduplicate(mappedRoster);
            draftChanged = true;
          }
        }
      }

      if (draftChanged) {
        const updates = { picks: newPicks };
        if (draftData.activeRosters) updates.activeRosters = newActiveRosters;
        if (draftData.active_rosters) updates.active_rosters = newActiveRosters;
        
        await updateDoc(draftStateRef, updates);
        console.log("  ✅ Updated draft/state document");
      }
    }
  }

  // 2. Process and Merge player records in pwhl_players
  console.log("\n🎒 Merging player records in pwhl_players...");
  const playersSnap = await getDocs(collection(db, "pwhl_players"));
  console.log(`Loaded ${playersSnap.size} player documents to analyze.`);

  // Group players by player_id
  const customPlayerDocs = [];
  const officialPlayerDocs = {};

  playersSnap.forEach(pDoc => {
    const data = pDoc.data();
    const pId = data.player_id;
    if (MERGE_MAPS[pId]) {
      customPlayerDocs.push({
        ref: pDoc.ref,
        id: pDoc.id,
        data: data
      });
    } else if (Object.values(MERGE_MAPS).includes(pId)) {
      const key = `${data.season_id}_${pId}`;
      officialPlayerDocs[key] = {
        ref: pDoc.ref,
        id: pDoc.id,
        data: data
      };
    }
  });

  console.log(`Found ${customPlayerDocs.length} custom duplicate player documents to merge.`);

  for (const customDoc of customPlayerDocs) {
    const customId = customDoc.data.player_id;
    const seasonId = customDoc.data.season_id;
    const officialId = MERGE_MAPS[customId];
    
    const officialKey = `${seasonId}_${officialId}`;
    const officialDoc = officialPlayerDocs[officialKey];

    console.log(`\nMerging duplicate doc ${customDoc.id} (ID: ${customId}, Name: ${customDoc.data.name}) -> Official Key: ${officialKey}`);

    if (officialDoc) {
      // Check if custom doc has draftInfo
      if (customDoc.data.draftInfo) {
        const officialDraftInfo = officialDoc.data.draftInfo || officialDoc.data.draftinfo;
        const officialDraftInfoIsEmpty = !officialDraftInfo || 
                                         (Array.isArray(officialDraftInfo) && officialDraftInfo.length === 0) ||
                                         (typeof officialDraftInfo === "object" && Object.keys(officialDraftInfo).length === 0);

        if (officialDraftInfoIsEmpty) {
          console.log(`  - Copying draftInfo to official player doc ${officialDoc.id}...`);
          await updateDoc(officialDoc.ref, {
            draftInfo: customDoc.data.draftInfo
          });
          console.log("  ✅ Copied draftInfo successfully.");
        } else {
          console.log("  - Official player doc already has draftInfo. Skipping copy.");
        }
      }
    } else {
      console.warn(`  ⚠️ Warning: No official player doc found for ${officialKey} (season_id may not exist for official player).`);
    }

    // Delete the duplicate document
    console.log(`  - Deleting duplicate player doc ${customDoc.ref.path}...`);
    await deleteDoc(customDoc.ref);
    console.log("  ✅ Deleted duplicate player doc.");
  }

  // 3. Delete stats and projections keyed under duplicate IDs
  console.log("\n📊 Cleaning up collections: pwhl_season_player_stats & pwhl_projections...");
  for (const customId of Object.keys(MERGE_MAPS)) {
    // Check seasons
    const seasons = ["4", "5", "6", "7", "8", "9"];
    for (const seasonId of seasons) {
      const docKey = `${seasonId}_${customId}`;
      
      // Delete stats doc if it exists
      const statsRef = doc(db, "pwhl_season_player_stats", docKey);
      const statsSnap = await getDoc(statsRef);
      if (statsSnap.exists()) {
        console.log(`Deleting duplicate season stats doc: ${statsRef.path}`);
        await deleteDoc(statsRef);
      }

      // Delete projections doc if it exists
      const projRef = doc(db, "pwhl_projections", docKey);
      const projSnap = await getDoc(projRef);
      if (projSnap.exists()) {
        console.log(`Deleting duplicate projections doc: ${projRef.path}`);
        await deleteDoc(projRef);
      }
    }
  }

  console.log("\n🎉 Duplicate Player Merge Migration completed successfully!");
}

runMigration().then(() => process.exit(0)).catch(err => {
  console.error("Migration failed with error:", err);
  process.exit(1);
});
