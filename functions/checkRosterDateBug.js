const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
initializeApp({
  projectId: "pwhl-fantasy-mobile-26"
});
const db = getFirestore();

// Mirror frontend's parseDateStr
const parseDateStr = (dateStr) => {
  if (!dateStr) return new Date();
  if (dateStr.includes('T') || dateStr.includes(' ')) return new Date(dateStr);
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0);
};

// Mirror frontend's parseDateSafe
function parseDateSafe(dateStr) {
  if (!dateStr) return new Date();
  const s = String(dateStr);
  if (s.includes('T') || s.includes(' ')) return new Date(s);
  const parts = s.split('-').map(Number);
  if (parts.length === 3) return new Date(parts[0], parts[1] - 1, parts[2], 12, 0, 0);
  return new Date(s);
}

async function run() {
  const selectedDateStr = "2025-11-22";
  const seasonId = "8";
  
  const simDate = new Date("2025-11-22T08:00:00-08:00");
  
  const dayStart = parseDateStr(selectedDateStr);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = parseDateStr(selectedDateStr);
  dayEnd.setHours(23, 59, 59, 999);
  
  console.log("simDate:", simDate.toISOString(), "local:", simDate.toString());
  console.log("dayStart:", dayStart.toISOString(), "local:", dayStart.toString());
  console.log("dayEnd:", dayEnd.toISOString(), "local:", dayEnd.toString());
  
  let effectiveEnd = new Date(dayEnd);
  if (simDate && simDate < effectiveEnd) {
    effectiveEnd = simDate;
  }
  const effectiveStart = new Date(dayStart);
  
  console.log("effectiveStart:", effectiveStart.toISOString());
  console.log("effectiveEnd:", effectiveEnd.toISOString());
  
  // Load games from Firestore
  const gamesSnap = await db.collection("pwhl_games").where("season_id", "==", seasonId).get();
  const games = [];
  gamesSnap.forEach(d => games.push(d.data()));
  
  console.log("\n=== Checking game date comparisons ===");
  const pastGameIds = [];
  for (const game of games) {
    const isFinal = game.status === '4' || game.status === '3';
    if (!isFinal) continue;
    
    const gDateStr = game.date_played || game.date;
    const gameDate = parseDateSafe(gDateStr);
    
    const condition = gameDate < effectiveEnd && (!effectiveStart || gameDate >= effectiveStart);
    console.log(`Game ${game.game_id} (${game.home_team_code} vs ${game.visiting_team_code}):`);
    console.log(`  date_played: ${gDateStr}`);
    console.log(`  gameDate parsed: ${gameDate.toISOString()} / local: ${gameDate.toString()}`);
    console.log(`  gameDate < effectiveEnd: ${gameDate < effectiveEnd}`);
    console.log(`  gameDate >= effectiveStart: ${gameDate >= effectiveStart}`);
    console.log(`  Matches Saturday 11/22? ${condition}`);
    if (condition) {
      pastGameIds.push(game.game_id);
    }
  }
  
  console.log("\nMatched games for 11/22:", pastGameIds);
}

run().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
