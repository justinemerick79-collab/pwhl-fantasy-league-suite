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
      // Check root
      const rootPath = path.resolve(__dirname, "../draft_results.txt");
      if (fs.existsSync(rootPath)) {
        filePath = rootPath;
      } else {
        // Fallback to home Downloads
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

    // Skip header
    const dataLines = lines.slice(1);
    console.log(`Loaded ${dataLines.length} draft result records.`);

    // 2. Fetch all existing PWHL players for local matching (one DB read is faster than 90 queries)
    console.log("Fetching existing players from Firestore...");
    const playersSnap = await db.collection("pwhl_players").get();
    const existingPlayers = playersSnap.docs.map(doc => ({
      id: doc.id,
      ref: doc.ref,
      data: doc.data()
    }));
    console.log(`Loaded ${existingPlayers.length} existing players from Firestore.`);

    // 3. Match and generate operations list
    const operations = [];
    let matchCount = 0;
    let newCount = 0;

    for (const line of dataLines) {
      // Parse CSV line
      // Format: Year,Round,Pick,Team,Player,Position,Previous_Team
      const parts = line.split(",");
      if (parts.length < 7) {
        console.warn(`Skipping invalid line: ${line}`);
        continue;
      }

      const yearStr = cleanString(parts[0]);
      const roundStr = cleanString(parts[1]);
      const pickStr = cleanString(parts[2]);
      const team = cleanString(parts[3]);
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
        draftedBy: team,
        formerTeam: formerTeam
      };

      // Match player case-insensitively by name field or first_name + last_name
      const cleanedPlayerName = player.toLowerCase();
      const matchedPlayer = existingPlayers.find(ep => {
        const epData = ep.data;
        const dbName = (epData.name || "").trim().toLowerCase();
        const dbFullName = `${epData.first_name || ""} ${epData.last_name || ""}`.trim().toLowerCase();
        return dbName === cleanedPlayerName || dbFullName === cleanedPlayerName;
      });

      if (matchedPlayer) {
        operations.push({
          type: "update",
          ref: matchedPlayer.ref,
          draftInfo: draftInfo,
          playerName: player
        });
        matchCount++;
      } else {
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

        const newDocRef = db.collection("pwhl_players").doc();
        operations.push({
          type: "create",
          ref: newDocRef,
          playerName: player,
          data: {
            name: player,
            first_name: firstName,
            last_name: lastName,
            position: positionCode,
            pos: positionCode,
            draftInfo: draftInfo
          }
        });
        newCount++;
      }
    }

    console.log(`Matched ${matchCount} existing players. Creating ${newCount} new player records.`);

    // 4. Batched Commits (chunks of 400)
    let batch = db.batch();
    let batchSize = 0;
    const CHUNK_LIMIT = 400;

    for (const op of operations) {
      if (op.type === "update") {
        batch.update(op.ref, { draftInfo: op.draftInfo });
      } else if (op.type === "create") {
        batch.set(op.ref, op.data);
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
  } catch (err) {
    console.error("INGESTION FAILED WITH ERROR:", err);
    process.exit(1);
  }
  process.exit(0);
}

run();
