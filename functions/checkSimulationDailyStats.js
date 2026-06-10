const admin = require("firebase-admin");
admin.initializeApp({
  projectId: "pwhl-fantasy-mobile-26"
});
const db = admin.firestore();

async function run() {
  console.log("=== Checking League docs ===");
  const leaguesSnap = await db.collection("fantasy_leagues").get();
  for (const doc of leaguesSnap.docs) {
    const data = doc.data();
    console.log(`League ID: ${doc.id}`);
    console.log(`- Name: ${data.name}`);
    console.log(`- isSimulation: ${data.isSimulation}`);
    console.log(`- simulatedDate: ${data.simulatedDate}`);
    console.log(`- season_id: ${data.season_id}`);
    console.log(`- currentWeek: ${data.currentWeek}`);
  }

  console.log("\n=== Checking daily_game_stats for mid-November 2025 ===");
  const dgsSnap = await db.collection("daily_game_stats").where("date", ">=", "2025-11-17").where("date", "<=", "2025-11-25").get();
  for (const doc of dgsSnap.docs) {
    const data = doc.data();
    console.log(`Daily Game Stats Date: ${doc.id}`);
    console.log(`- status: ${data.status}`);
    console.log(`- gamesProcessed:`, data.gamesProcessed);
    console.log(`- playerPoints size:`, Object.keys(data.playerPoints || {}).length);
    console.log(`- leaguePoints keys:`, Object.keys(data.leaguePoints || {}));
  }

  console.log("\n=== Checking games around Nov 20th 2025 ===");
  const gamesSnap = await db.collection("pwhl_games").get();
  const games = [];
  gamesSnap.forEach(doc => games.push({ id: doc.id, ...doc.data() }));
  const sortedGames = games.filter(g => {
    const d = g.date_played || g.date;
    return d && d >= "2025-11-17" && d <= "2025-11-25";
  });
  console.log(`Found ${sortedGames.length} games in range:`);
  for (const g of sortedGames) {
    console.log(`Game ${g.id}: date=${g.date_played || g.date}, status=${g.status}, season_id=${g.season_id}`);
  }
}

run().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
