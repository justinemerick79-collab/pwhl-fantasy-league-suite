const admin = require("firebase-admin");
admin.initializeApp({
  projectId: "pwhl-fantasy-mobile-26"
});
const db = admin.firestore();

async function run() {
  console.log("=== PWHL Fantasy: Diagnostics - Check Seeded Games ===");
  
  // 1. Fetch all games from pwhl_games
  const gamesSnap = await db.collection("pwhl_games").get();
  console.log(`Total games in pwhl_games: ${gamesSnap.size}`);

  const games = [];
  gamesSnap.forEach(doc => {
    games.push({ id: doc.id, ...doc.data() });
  });

  // Sort games by date
  games.sort((a, b) => {
    const dA = a.date_played || a.date || "";
    const dB = b.date_played || b.date || "";
    return dA.localeCompare(dB);
  });

  // We are particularly interested in 2025 simulated season games
  const simGames = games.filter(g => {
    const d = g.date_played || g.date;
    return d && d.startsWith("2025");
  });

  console.log(`\nFound ${simGames.length} games in simulated season (2025)`);
  
  let validCount = 0;
  let missingSummaryCount = 0;
  let nonFinalCount = 0;

  for (const game of simGames) {
    const gameId = String(game.game_id || game.id);
    const dateStr = game.date_played || game.date;
    const homeTeam = game.home_team_name || game.home_team || "Unknown";
    const visitorTeam = game.visitor_team_name || game.visiting_team || "Unknown";
    const status = game.status;

    // Check for corresponding game summary document
    const summarySnap = await db.collection("pwhl_game_summaries").doc(gameId).get();
    const hasSummary = summarySnap.exists;

    const isFinal = status === "3" || status === "4";
    const isValid = isFinal && hasSummary;

    if (isValid) validCount++;
    if (!hasSummary) missingSummaryCount++;
    if (!isFinal) nonFinalCount++;

    const statusLabel = status === "4" ? "4 (Final)" : (status === "3" ? "3 (Final OT)" : `${status} (Not Final)`);
    const summaryLabel = hasSummary ? "✅ Present" : "❌ MISSING";
    const overallLabel = isValid ? "🟢 VALID" : "🔴 INVALID";

    console.log(`[${overallLabel}] Date: ${dateStr.split('T')[0]} | Game ID: ${gameId.padEnd(6)} | ${visitorTeam} @ ${homeTeam}`);
    console.log(`            Status: ${statusLabel} | Summary: ${summaryLabel}`);
  }

  console.log("\n=== Summary Report ===");
  console.log(`Total Simulated Games Checked: ${simGames.length}`);
  console.log(`🟢 Valid (Final + Has Summary): ${validCount}`);
  console.log(`🔴 Missing Summary Doc:        ${missingSummaryCount}`);
  console.log(`🟡 Non-Final Status:           ${nonFinalCount}`);

  if (validCount === simGames.length) {
    console.log("\n✅ All simulated games are valid and possess summaries!");
  } else {
    console.log("\n⚠️ Warning: Some games are missing summaries or are not marked final. They will not yield fantasy points.");
  }
}

run().then(() => process.exit(0)).catch(err => {
  console.error("Diagnostic execution failed:", err.message || err);
  if (err.message && err.message.includes("Could not load the default credentials")) {
    console.log("\n💡 How to resolve this authentication error:");
    console.log("--------------------------------------------");
    console.log("If running against production:");
    console.log("  Run: gcloud auth application-default login");
    console.log("  Then run this script again.");
    console.log("\nIf running against local Firebase emulator:");
    console.log("  Ensure the Firestore emulator is active on port 8080");
    console.log("  Then run: FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node check-seeded-games.cjs");
  }
  process.exit(1);
});
