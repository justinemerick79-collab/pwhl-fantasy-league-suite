import admin from "firebase-admin";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Emulate filename/dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Firebase Admin
admin.initializeApp({
  projectId: "pwhl-fantasy-mobile-26"
});
const db = admin.firestore();

// Helper to clean up strings
function cleanString(str) {
  return str ? str.replace(/^"|"$/g, '').trim() : '';
}

async function run() {
  try {
    // 1. Resolve draft_results.txt path
    let filePath = process.argv[2];
    if (!filePath) {
      const rootPath = path.resolve(__dirname, "../draft_results.txt");
      if (fs.existsSync(rootPath)) {
        filePath = rootPath;
      } else {
        filePath = "/Users/justinemerick/Downloads/draft_results.txt";
      }
    }

    console.log(`Reading draft results from: ${filePath}`);
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found at path: ${filePath}`);
    }

    const fileContent = fs.readFileSync(filePath, "utf-8");
    const lines = fileContent.split(/\r?\n/).filter(line => line.trim().length > 0);

    if (lines.length <= 1) {
      throw new Error("No data found in draft_results.txt");
    }

    const dataLines = lines.slice(1);
    console.log(`Loaded ${dataLines.length} draft result records.`);

    // 2. Fetch all existing PWHL players and teams for local matching
    console.log("Fetching existing players from Firestore...");
    const playersSnap = await db.collection("pwhl_players").get();
    const existingPlayers = playersSnap.docs.map(doc => ({
      id: doc.id,
      ref: doc.ref,
      data: doc.data()
    }));
    console.log(`Loaded ${existingPlayers.length} existing player documents.`);

    console.log("Fetching existing teams from Firestore...");
    const teamsSnap = await db.collection("pwhl_teams").get();
    const existingTeams = teamsSnap.docs.map(doc => ({
      id: doc.id,
      ref: doc.ref,
      data: doc.data()
    }));
    console.log(`Loaded ${existingTeams.length} existing team documents.`);

    // Find the max numeric player ID to generate new IDs safely
    let maxPlayerId = 10000;
    for (const player of existingPlayers) {
      const pId = parseInt(player.data.player_id || player.data.id || player.id.split("_")[1], 10);
      if (!isNaN(pId) && pId > maxPlayerId) {
        maxPlayerId = pId;
      }
    }
    console.log(`Maximum player ID in database: ${maxPlayerId}`);

    // 3. Match and generate operations list
    const operations = [];
    let matchCount = 0;
    let newCount = 0;
    let deletedOrphans = 0;

    // Clean up orphaned records from previous runs (any player with draftInfo but no season_id)
    const orphans = existingPlayers.filter(ep => ep.data.draftInfo && !ep.data.season_id);
    console.log(`Cleaning up ${orphans.length} orphaned player documents (missing season_id)...`);
    for (const orphan of orphans) {
      operations.push({
        type: "delete",
        ref: orphan.ref,
        playerName: orphan.data.name
      });
      deletedOrphans++;
    }

    for (const line of dataLines) {
      // Format: Year,Round,Pick,Team,Player,Position,Previous_Team
      const parts = line.split(",");
      if (parts.length < 7) {
        console.warn(`Skipping invalid line: ${line}`);
        continue;
      }

      const yearStr = cleanString(parts[0]);
      const roundStr = cleanString(parts[1]);
      const pickStr = cleanString(parts[2]);
      const teamNameInput = cleanString(parts[3]);
      const player = cleanString(parts[4]);
      const position = cleanString(parts[5]);
      const formerTeam = cleanString(parts[6]);

      if (!player) {
        continue;
      }

      const draftInfo = {
        year: parseInt(yearStr, 10),
        round: parseInt(roundStr, 10),
        pick: parseInt(pickStr, 10),
        draftedBy: teamNameInput,
        formerTeam: formerTeam
      };

      // Match player case-insensitively by name field or first_name + last_name
      const cleanedPlayerName = player.toLowerCase();
      const matchedPlayers = existingPlayers.filter(ep => {
        const epData = ep.data;
        // Skip orphans that we are deleting
        if (epData.draftInfo && !epData.season_id) return false;
        
        const dbName = (epData.name || "").trim().toLowerCase();
        const dbFullName = `${epData.first_name || ""} ${epData.last_name || ""}`.trim().toLowerCase();
        return dbName === cleanedPlayerName || dbFullName === cleanedPlayerName;
      });

      if (matchedPlayers.length > 0) {
        // Update ALL matched player documents (across different seasons)
        for (const mp of matchedPlayers) {
          operations.push({
            type: "update",
            ref: mp.ref,
            draftInfo: draftInfo,
            playerName: player
          });
          matchCount++;
        }
      } else {
        // Create new player records for all relevant seasons
        maxPlayerId++;
        const newPlayerId = maxPlayerId;

        // Map position to F, D, or G
        let positionCode = "F";
        const posUpper = position.toUpperCase();
        if (posUpper === "DEFENDER" || posUpper === "DEFENSE" || posUpper === "D") {
          positionCode = "D";
        } else if (posUpper === "GOALTENDER" || posUpper === "GOALIE" || posUpper === "G") {
          positionCode = "G";
        }

        const nameParts = player.split(/\s+/);
        const firstName = nameParts[0] || "";
        const lastName = nameParts.slice(1).join(" ") || "";

        // Determine which seasons to create this player in
        const draftYear = parseInt(yearStr, 10);
        const seasonsToCreate = [];
        if (draftYear === 2024) {
          // Ingest into seasons from 2024-25 onwards
          seasonsToCreate.push("4", "5", "7", "8");
        } else if (draftYear === 2025) {
          // Ingest into seasons from 2025-26 onwards
          seasonsToCreate.push("7", "8");
        } else {
          seasonsToCreate.push("7", "8");
        }

        for (const seasonId of seasonsToCreate) {
          const docId = `${seasonId}_${newPlayerId}`;
          const newDocRef = db.collection("pwhl_players").doc(docId);

          // Find team_id and team_name for this season based on city name in draftInfo
          let teamId = "";
          let finalTeamName = "";
          const cityLower = teamNameInput.toLowerCase();
          const matchedTeam = existingTeams.find(t => {
            return String(t.data.season_id) === String(seasonId) && 
              (t.data.city?.toLowerCase() === cityLower || 
               t.data.name?.toLowerCase().includes(cityLower));
          });

          if (matchedTeam) {
            teamId = matchedTeam.data.id || "";
            finalTeamName = matchedTeam.data.name || "";
          }

          operations.push({
            type: "create",
            ref: newDocRef,
            playerName: player,
            data: {
              id: String(newPlayerId),
              player_id: String(newPlayerId),
              season_id: String(seasonId),
              name: player,
              first_name: firstName,
              last_name: lastName,
              position: positionCode,
              pos: positionCode,
              draftInfo: draftInfo,
              active: "1",
              rookie: "1",
              status: "Signed",
              points: 0,
              gp: 0,
              g_w: 0,
              a_otl: 0,
              pm_ga: 0,
              sog_sv: 0,
              blk_so: 0,
              hits: 0,
              current_team_id: teamId,
              team_name: finalTeamName
            }
          });
          newCount++;
        }
      }
    }

    console.log(`Matched and queued ${matchCount} updates. Queued ${newCount} creations. Queued ${deletedOrphans} deletes.`);

    // 4. Batched Commits (chunks of 400)
    let batch = db.batch();
    let batchSize = 0;
    const CHUNK_LIMIT = 400;

    for (const op of operations) {
      if (op.type === "update") {
        batch.update(op.ref, { draftInfo: op.draftInfo });
      } else if (op.type === "create") {
        batch.set(op.ref, op.data);
      } else if (op.type === "delete") {
        batch.delete(op.ref);
      }
      batchSize++;

      if (batchSize === CHUNK_LIMIT) {
        console.log(`Committing batch of ${CHUNK_LIMIT} records...`);
        await batch.commit();
        batch = db.batch();
        batchSize = 0;
      }
    }

    if (batchSize > 0) {
      console.log(`Committing final batch of ${batchSize} records...`);
      await batch.commit();
    }

    console.log("SUCCESS: Draft results ingestion completed successfully!");
    console.log(`- Updated records: ${matchCount}`);
    console.log(`- Created records: ${newCount}`);
    console.log(`- Deleted orphaned records: ${deletedOrphans}`);
  } catch (err) {
    console.error("INGESTION FAILED WITH ERROR:", err);
    process.exit(1);
  }
  process.exit(0);
}

run();
