/**
 * PWHL data sync, server side. Used by the nightly syncDailyData job and by the
 * admin "Sync" button (runDataSync callable), so there is one sync, and it works on
 * the deployed site. (The old browser sync could only reach the feed through the Vite
 * dev-server proxy.)
 *
 * Per season: teams → rosters (pwhl_players) → schedule (pwhl_games) → season document
 * and week map → missing game summaries → player stats. Document shapes match the
 * browser sync it replaces (src/services/pwhlService.js).
 */
const { Timestamp } = require("firebase-admin/firestore");
const { fetchFromApi, fetchGameSummary } = require("./hockeytech");
const { buildSeasonWeeks } = require("./seasonWeeks");

const SEASON_LOOKBACK_YEARS = 2;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function commitInChunks(db, writes) {
  for (let i = 0; i < writes.length; i += 450) {
    const batch = db.batch();
    for (const [ref, data] of writes.slice(i, i + 450)) batch.set(ref, data, { merge: true });
    await batch.commit();
  }
}

/**
 * Which feed seasons to sync.
 * @param {'recent'|'all'|string} target  'recent' = seasons starting within the last
 *   SEASON_LOOKBACK_YEARS (from 1 January), 'all', or one season id.
 */
function selectSeasons(seasons, target, nowMs = Date.now()) {
  if (target === "all") return seasons.filter(s => s.season_id);
  if (target && target !== "recent") return seasons.filter(s => String(s.season_id) === String(target));
  const now = new Date(nowMs);
  const windowStart = new Date(now.getFullYear() - SEASON_LOOKBACK_YEARS, 0, 1);
  const recentYears = [];
  for (let i = SEASON_LOOKBACK_YEARS + 1; i >= -1; i--) recentYears.push(String(now.getFullYear() - i));
  return seasons.filter(s => {
    if (!s.season_id) return false;
    const start = s.start_date ? new Date(s.start_date) : null;
    if (start && !Number.isNaN(start.getTime())) return start >= windowStart;
    return recentYears.some(y => (s.season_name || "").includes(y));
  });
}

/**
 * Sync one season.
 * @param {{log: Function, maxSummaries: number}} opts
 * @returns {Promise<{summariesLeft: number}>}
 */
async function syncSeason(db, season, { log, maxSummaries }) {
  const sId = String(season.season_id);
  log(`Season ${season.season_name || sId}:`);

  // Teams and rosters
  const teams = (await fetchFromApi({ feed: "modulekit", view: "teamsbyseason", season_id: sId }))?.SiteKit?.Teamsbyseason || [];
  await commitInChunks(db, teams.filter(t => t.id).map(t => [db.collection("pwhl_teams").doc(`${sId}_${t.id}`), { ...t, season_id: sId }]));
  let playerCount = 0;
  for (const team of teams) {
    if (!team.id) continue;
    await sleep(150);
    const roster = (await fetchFromApi({ feed: "modulekit", view: "roster", season_id: sId, team_id: team.id }))?.SiteKit?.Roster || [];
    const writes = [];
    for (const p of roster) {
      const pId = p.player_id || p.id || p.person_id;
      if (pId) writes.push([db.collection("pwhl_players").doc(`${sId}_${pId}`), { ...p, current_team_id: team.id, season_id: sId }]);
    }
    await commitInChunks(db, writes);
    playerCount += writes.length;
  }
  log(`  ${teams.length} teams, ${playerCount} rostered players`);

  // Schedule, season document and week map
  const games = (await fetchFromApi({ feed: "modulekit", view: "schedule", season_id: sId }))?.SiteKit?.Schedule || [];
  await commitInChunks(db, games.filter(g => g.game_id).map(g => [db.collection("pwhl_games").doc(String(g.game_id)), g]));
  const seasonUpdate = { ...season };
  if (games.length > 0 && season.start_date && season.end_date) {
    seasonUpdate.weeks = buildSeasonWeeks(season.start_date, season.end_date, games);
    seasonUpdate.weeksUpdatedAt = Timestamp.now();
    const placed = seasonUpdate.weeks.reduce((n, w) => n + w.gameCount, 0);
    log(`  ${games.length} games; week map ${seasonUpdate.weeks.length} weeks, ${placed}/${games.length} games placed`);
  } else {
    log(`  ${games.length} games; week map not rebuilt (an empty schedule never replaces an existing one)`);
  }
  await db.collection("pwhl_seasons").doc(sId).set(seasonUpdate, { merge: true });

  // Game summaries: completed games with no usable stored summary. Each write
  // fires the season-totals rebuild (onGameSummaryWritten), so cap per run.
  const finished = games.filter(g => String(g.status) === "4" && g.game_id).map(g => String(g.game_id));
  const missing = [];
  for (let i = 0; i < finished.length; i += 100) {
    const snaps = await db.getAll(...finished.slice(i, i + 100).map(id => db.collection("pwhl_game_summaries").doc(id)));
    snaps.forEach((s, j) => { if (!s.exists || !s.data().home_team_lineup) missing.push(finished[i + j]); });
  }
  let fetched = 0;
  for (const id of missing.slice(0, maxSummaries)) {
    try {
      await sleep(150);
      const summary = await fetchGameSummary(id);
      if (!summary) continue;
      await db.collection("pwhl_game_summaries").doc(id).set({ ...summary, season_id: sId, game_id: id }, { merge: true });
      fetched++;
    } catch (err) {
      log(`  summary ${id} failed: ${err.message || err}`);
    }
  }
  const summariesLeft = Math.max(0, missing.length - fetched);
  log(`  game summaries: ${fetched} downloaded${summariesLeft ? `, ${summariesLeft} still missing (run the sync again)` : ", all complete"}`);

  // Player stats
  const skaters = (await fetchFromApi({ feed: "modulekit", view: "statviewtype", type: "topscorers", season_id: sId, first: 0, limit: 500 }))?.SiteKit?.Statviewtype || [];
  const goalies = (await fetchFromApi({ feed: "modulekit", view: "statviewtype", type: "topgoalies", season_id: sId, first: 0, limit: 100 }))?.SiteKit?.Statviewtype || [];
  const stats = [...skaters, ...goalies].filter(s => s.player_id);
  await commitInChunks(db, stats.map(s => [db.collection("pwhl_player_stats").doc(`${sId}_${s.player_id}`), { ...s, season_id: sId }]));
  log(`  ${stats.length} player stat lines`);
  return { summariesLeft };
}

/**
 * @param {{target?: 'recent'|'all'|string, maxSummaries?: number, log?: Function}} [opts]
 * @returns {Promise<{seasons: string[], summariesLeft: number}>}
 */
async function runSync(db, { target = "recent", maxSummaries = 40, log = console.log } = {}) {
  const feedSeasons = (await fetchFromApi({ feed: "modulekit", view: "seasons" }))?.SiteKit?.Seasons || [];
  const seasons = selectSeasons(feedSeasons, target);
  log(`Syncing ${seasons.length} season(s): ${seasons.map(s => s.season_name || s.season_id).join(", ") || "none"}`);
  let summariesLeft = 0;
  for (const season of seasons) {
    try {
      const r = await syncSeason(db, season, { log, maxSummaries }); // the cap applies per season
      summariesLeft += r.summariesLeft;
    } catch (err) {
      log(`  Season ${season.season_id} failed: ${err.message || err}`);
    }
  }
  return { seasons: seasons.map(s => String(s.season_id)), summariesLeft };
}

module.exports = { runSync, selectSeasons, syncSeason };
