const functions = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

const API_KEY = '446521baf8c38984';
const CLIENT_CODE = 'pwhl';
const BASE_URL = 'https://lscluster.hockeytech.com/feed/index.php';

/**
 * Fetches JSON data from HockeyTech GC API
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
 * Cloud Function running every 24 hours to sync Schedule and Player Stats.
 * Safely aggregates and chunks batch writes into sizes of 490 documents maximum.
 */
exports.syncDailyData = functions.pubsub
  .schedule("every 24 hours")
  .onRun(async (context) => {
    console.log("Daily scheduled ingestion started...");
    try {
      // 1. Fetch seasons to identify active seasons to sync
      const seasonsData = await fetchFromApi({ feed: 'modulekit', view: 'seasons' });
      const seasons = seasonsData?.SiteKit?.Seasons || [];
      
      // Filter for recent seasons to keep updates efficient (e.g. 2024-25, 2025-26)
      const activeSeasons = seasons.filter(s => {
        const name = s.season_name?.toLowerCase() || "";
        return name.includes("2024-25") || name.includes("2025-26") || name.includes("2026-27");
      });

      console.log(`Identified ${activeSeasons.length} active/recent seasons to synchronize.`);

      for (const season of activeSeasons) {
        if (!season.season_id) continue;
        const seasonId = season.season_id.toString();

        // A. Ingest schedule data
        console.log(`[Schedule Sync] Fetching games for season ${seasonId}...`);
        const scheduleData = await fetchFromApi({ feed: 'modulekit', view: 'schedule', season_id: seasonId });
        const games = scheduleData?.SiteKit?.Schedule || [];

        let count = 0;
        let currentBatch = db.batch();

        for (const game of games) {
          if (!game.game_id) continue;
          const ref = db.collection('pwhl_games').doc(game.game_id.toString());
          currentBatch.set(ref, game, { merge: true });
          count++;

          if (count === 490) {
            await currentBatch.commit();
            currentBatch = db.batch();
            count = 0;
            console.log(`[Schedule Sync] Committed 490-write chunk to Firestore.`);
          }
        }

        if (count > 0) {
          await currentBatch.commit();
          console.log(`[Schedule Sync] Committed final ${count}-write chunk to Firestore.`);
        }

        // B. Ingest player stats data (Top Scorers)
        console.log(`[Stats Sync] Fetching top scorers for season ${seasonId}...`);
        const statsData = await fetchFromApi({ 
          feed: 'modulekit', 
          view: 'statviewtype', 
          type: 'topscorers', 
          season_id: seasonId, 
          first: 0, 
          limit: 500 
        });
        const stats = statsData?.SiteKit?.Statviewtype || [];

        count = 0;
        currentBatch = db.batch();

        for (const stat of stats) {
          if (!stat.player_id) continue;
          const ref = db.collection('pwhl_player_stats').doc(`${seasonId}_${stat.player_id}`);
          currentBatch.set(ref, { ...stat, season_id: seasonId }, { merge: true });
          count++;

          if (count === 490) {
            await currentBatch.commit();
            currentBatch = db.batch();
            count = 0;
            console.log(`[Stats Sync] Committed 490-write chunk to Firestore.`);
          }
        }

        if (count > 0) {
          await currentBatch.commit();
          console.log(`[Stats Sync] Committed final ${count}-write chunk to Firestore.`);
        }
      }

      console.log("Daily scheduled ingestion finished successfully!");
      return null;
    } catch (error) {
      console.error("Fatal error during daily Scheduled Ingestion:", error);
      throw error;
    }
  });
