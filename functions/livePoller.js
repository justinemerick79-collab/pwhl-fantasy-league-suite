/**
 * Live Game Poller
 * 
 * Cloud Scheduler function that polls HockeyTech API every 5 minutes
 * for in-progress PWHL games and updates game summaries in Firestore.
 * 
 * Only runs during a live PWHL season. Does NOT run in simulation mode.
 * 
 * Flow:
 * 1. Check pwhl_games for today's games
 * 2. If any are "in progress" (status 2) → fetch updated summaries from API
 * 3. Write to pwhl_game_summaries (triggers onGameSummaryWritten)
 * 4. Call snapshotDailyGameStats with "preliminary" status
 * 
 * Cost: ~36 API calls per 3-hour game at 5-minute intervals
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { Timestamp } = require("firebase-admin/firestore");
const { snapshotDailyGameStats, getLocalDateStr } = require("./dailyGameStats");

const API_KEY = '446521baf8c38984';
const CLIENT_CODE = 'pwhl';
const BASE_URL = 'https://lscluster.hockeytech.com/feed/index.php';

/**
 * Fetches JSON data from HockeyTech GC API
 * (Duplicated from index.js to avoid circular dependency)
 */
async function fetchFromApi(params) {
  const url = new URL(BASE_URL);
  url.searchParams.append('key', API_KEY);
  url.searchParams.append('client_code', CLIENT_CODE);
  url.searchParams.append('fmt', 'json');

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.append(key, value);
  }

  const response = await fetch(url.toString());
  if (!response.ok) throw new Error(`HockeyTech API fetch failed: ${response.statusText}`);

  const text = await response.text();
  let jsonString = text;
  // Handle JSONP callback wrappers if present
  if (text.startsWith('typeof ') || text.indexOf('(') > -1) {
    const match = text.match(/^[^{]*({.*})[^}]*$/s);
    if (match) {
      jsonString = match[1];
    }
  }

  return JSON.parse(jsonString);
}

/**
 * Cloud Function running every 5 minutes to poll for live game updates.
 * Only executes work if there are PWHL games "in progress" today.
 */
exports.liveGamePoller = functions.pubsub
  .schedule("every 5 minutes")
  .onRun(async () => {
    const db = admin.firestore();
    const todayStr = getLocalDateStr(new Date());

    console.log(`[LivePoller] Checking for active games on ${todayStr}...`);

    // 1. Check if simulation mode is active globally — if so, skip live polling
    try {
      const simSnap = await db.collection("admin_settings").doc("simulation_state").get();
      if (simSnap.exists && simSnap.data().testModeActive === true) {
        console.log("[LivePoller] Global simulation mode is active. Skipping live poll.");
        return null;
      }
    } catch (err) {
      // If we can't read sim state, proceed with polling anyway
    }

    // 2. Find today's games from Firestore
    const gamesSnap = await db.collection("pwhl_games").get();
    const todayGames = [];

    gamesSnap.forEach(doc => {
      const game = doc.data();
      const gDateStr = game.date_played || game.date;
      if (!gDateStr) return;
      const gDate = new Date(gDateStr);
      if (getLocalDateStr(gDate) === todayStr) {
        todayGames.push({ id: doc.id, ...game });
      }
    });

    if (todayGames.length === 0) {
      console.log("[LivePoller] No games scheduled for today. Skipping.");
      return null;
    }

    // 3. Check which games are in progress or recently finalized
    // Status: 1 = Scheduled, 2 = In Progress, 3 = Final (OT/SO), 4 = Final
    const activeGames = todayGames.filter(g => {
      return g.status === "2" || g.status === "1"; // In progress or scheduled (could have started)
    });

    if (activeGames.length === 0) {
      // All games are final or no active games
      const hasAnyFinal = todayGames.some(g => g.status === "3" || g.status === "4");
      if (hasAnyFinal) {
        console.log(`[LivePoller] All ${todayGames.length} games are final. No active games to poll.`);
      }
      return null;
    }

    console.log(`[LivePoller] Found ${activeGames.length} active/scheduled games. Polling summaries...`);

    // 4. Fetch updated game summaries from HockeyTech API
    let updatedCount = 0;
    const batch = db.batch();

    for (const game of activeGames) {
      const gameId = String(game.game_id || game.id);
      try {
        const summaryData = await fetchFromApi({
          feed: 'gc',
          tab: 'gamesummary',
          game_id: gameId,
          site_id: '0',
          lang: 'en'
        });

        if (summaryData) {
          const summaryRef = db.collection("pwhl_game_summaries").doc(gameId);

          // Extract the season_id from the game data
          const seasonId = game.season_id || summaryData.season_id;

          // Write the summary (merge to preserve existing fields)
          batch.set(summaryRef, {
            ...summaryData,
            season_id: seasonId,
            game_id: gameId,
            lastPolledAt: Timestamp.now()
          }, { merge: true });

          // Also update the game status if it changed
          const newStatus = summaryData.status_value || summaryData.status;
          if (newStatus && newStatus !== game.status) {
            const gameRef = db.collection("pwhl_games").doc(gameId);
            batch.update(gameRef, { status: newStatus });
          }

          updatedCount++;
        }
      } catch (err) {
        console.error(`[LivePoller] Failed to fetch summary for game ${gameId}:`, err);
      }
    }

    if (updatedCount > 0) {
      await batch.commit();
      console.log(`[LivePoller] Updated ${updatedCount} game summaries.`);

      // 5. Snapshot daily game stats as "preliminary"
      try {
        await snapshotDailyGameStats(todayStr, "preliminary");
      } catch (err) {
        console.error("[LivePoller] Failed to snapshot daily game stats:", err);
      }
    }

    return null;
  });
