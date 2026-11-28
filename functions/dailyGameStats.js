/**
 * Daily Game Stats Module
 * 
 * Central module for the Daily Fantasy Data Pipeline (Tier 2).
 * Provides the `snapshotDailyGameStats` function that ALL data sources call:
 *   - Live Poller (writes "preliminary" snapshots during active games)
 *   - Daily Sync (overwrites with "final" authoritative data)
 *   - Simulation Processor (processes historical data as if it's happening today)
 * 
 * Also provides `getLockedPlayerIds` for player-level lineup lock enforcement.
 */

const { Timestamp, getFirestore } = require("firebase-admin/firestore");
const { normalizeBoxScore, pointsForGame, scoreGoalie } = require("./boxScore");

// Lazy getter — ensures initializeApp() has already been called by index.js
function getDb() {
  return getFirestore();
}

const DEFAULT_SCORING = {
  skaters: {
    goals: 2, assists: 1, plusMinus: 0.5, ppp: 0.5, shp: 0.5,
    sog: 0.1, hits: 0.1, blocks: 0.5, defensePoints: 0.5
  },
  goalies: {
    wins: 4, otl: 1, ga: -2, saves: 0.2, shutouts: 3
  }
};

/**
 * Normalizes position strings to one of: 'F', 'D', 'G'
 */
function normalizePosition(posStr) {
  if (!posStr) return "F";
  const up = String(posStr).toUpperCase().trim();
  if (["C", "RW", "LW", "F", "FORWARD", "FORWARDS"].includes(up)) return "F";
  if (["D", "RD", "LD", "DEFENSE", "DEFENSEMAN", "DEFENSEMEN"].includes(up)) return "D";
  if (["G", "GOALIE", "GOALTENDER", "GOALIES"].includes(up)) return "G";
  return "F";
}

/**
 * Formats a Date to "YYYY-MM-DD" local date string.
 */
function getLocalDateStr(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Safe date parser: avoids UTC midnight shift for bare "YYYY-MM-DD" strings.
 */
function parseDateSafe(dateStr) {
  if (!dateStr) return new Date();
  const s = String(dateStr);
  if (s.includes('T') || s.includes(' ')) return new Date(s);
  const parts = s.split('-').map(Number);
  if (parts.length === 3) return new Date(parts[0], parts[1] - 1, parts[2], 12, 0, 0);
  return new Date(s);
}

/**
 * Calculates per-player raw stats and fantasy points from a single game summary.
 * Returns an object: { playerId: { fantasyPoints, stats: { ... } } }
 *
 * A thin wrapper over functions/boxScore.js — the one parser and scoring formula
 * shared with live scoring and the nightly official switch. Positions come from
 * `playersPosMap` (default 'F'), as before.
 */
function calculatePlayerStatsFromSummary(summary, scoringRules, playersPosMap) {
  const box = normalizeBoxScore(summary, { final: true });
  const pts = pointsForGame(box, scoringRules || {}, playersPosMap || {});
  const result = {};
  for (const [id, st] of Object.entries(box.skaters)) {
    result[id] = {
      fantasyPoints: pts[id] ?? 0,
      stats: { goals: st.goals, assists: st.assists, plusMinus: st.plusMinus, ppp: st.ppp, shp: st.shp, sog: st.sog, hits: st.hits, blocks: st.blocks, pim: st.pim }
    };
  }
  for (const [id, st] of Object.entries(box.goalies)) {
    if (scoreGoalie(st) === null) continue; // did not play
    result[id] = {
      fantasyPoints: pts[id] ?? 0,
      stats: { wins: st.wins, losses: st.losses, overtimeLosses: st.overtimeLosses, goalsAgainst: st.goalsAgainst, saves: st.saves, shutouts: st.shutouts, timeOnIce: st.timeOnIce }
    };
  }
  return result;
}

/**
 * Snapshots daily fantasy points for all players on a specific date.
 * 
 * This is the CENTRAL function that all data sources call:
 *   - Live Poller → status = "preliminary"
 *   - Daily Sync → status = "final"  
 *   - Simulation Processor → status = "final"
 * 
 * It reads raw game data from `pwhl_games` and `pwhl_game_summaries`,
 * computes fantasy points using both global defaults and per-league custom scoring,
 * and writes the result to `daily_game_stats/{dateStr}`.
 * 
 * @param {string} dateStr - The date to snapshot, in "YYYY-MM-DD" format
 * @param {string} status - "preliminary" (live data) or "final" (authoritative)
 * @param {Object} [options] - Optional overrides
 * @param {Array} [options.allGames] - Pre-fetched games array (avoids re-reading Firestore)
 * @param {Object} [options.allSummaries] - Pre-fetched summaries map { gameId: data }
 * @param {Object} [options.playersPosMap] - Pre-fetched player position map { playerId: pos }
 * @param {string} [options.seasonId] - Specific season to filter by (useful for simulation)
 */
async function snapshotDailyGameStats(dateStr, status, options = {}) {
  console.log(`[DailyStats] Snapshotting daily_game_stats for ${dateStr} (status: ${status})`);

  // Check: don't downgrade "final" to "preliminary"
  const existingDoc = await getDb().collection("daily_game_stats").doc(dateStr).get();
  if (existingDoc.exists && existingDoc.data().status === "final" && status === "preliminary") {
    console.log(`[DailyStats] Skipping ${dateStr} — already has final data. Won't downgrade to preliminary.`);
    return;
  }

  // 1. Get games for this date
  let allGames = options.allGames;
  if (!allGames) {
    const gamesSnap = await getDb().collection("pwhl_games").get();
    allGames = [];
    gamesSnap.forEach(doc => allGames.push({ id: doc.id, ...doc.data() }));
  }

  const dailyGames = allGames.filter(game => {
    const gDateStr = game.date_played || game.date;
    if (!gDateStr) return false;
    const gDate = parseDateSafe(gDateStr);
    const isFinal = game.status === "4" || game.status === "3";
    const matchesDate = getLocalDateStr(gDate) === dateStr;

    if (options.seasonId) {
      const matchesSeason = String(game.season_id) === String(options.seasonId);
      return matchesDate && isFinal && matchesSeason;
    }
    return matchesDate && isFinal;
  });

  if (dailyGames.length === 0) {
    console.log(`[DailyStats] No final games found for ${dateStr}. Writing empty snapshot.`);
    await getDb().collection("daily_game_stats").doc(dateStr).set({
      date: dateStr,
      seasonId: options.seasonId || "",
      status: status,
      gamesProcessed: [],
      playerPoints: {},
      leaguePoints: {},
      updatedAt: Timestamp.now(),
      version: existingDoc.exists ? (existingDoc.data().version || 0) + 1 : 1
    });
    return;
  }

  const gameIds = dailyGames.map(g => String(g.game_id || g.id));
  const seasonId = options.seasonId || String(dailyGames[0].season_id || "");

  // 2. Get game summaries
  let allSummaries = options.allSummaries;
  if (!allSummaries) {
    const summariesSnap = await getDb().collection("pwhl_game_summaries").get();
    allSummaries = {};
    summariesSnap.forEach(doc => {
      allSummaries[doc.id] = doc.data();
    });
  }

  // 3. Get player position map
  let playersPosMap = options.playersPosMap;
  if (!playersPosMap) {
    playersPosMap = {};
    const playersSnap = await getDb().collection("pwhl_players").get();
    playersSnap.forEach(pDoc => {
      const p = pDoc.data();
      const id = p.player_id || p.id || pDoc.id.split("_")[1];
      if (id) {
        playersPosMap[id.toString()] = normalizePosition(p.position);
      }
    });
  }

  // 4. Calculate global default scoring
  const globalPlayerPoints = {};

  for (const gameId of gameIds) {
    const summary = allSummaries[gameId];
    if (!summary) {
      console.log(`[DailyStats] Warning: No summary found for game ${gameId}`);
      continue;
    }

    const gameResult = calculatePlayerStatsFromSummary(summary, DEFAULT_SCORING, playersPosMap);

    // Merge into global map
    for (const [playerId, data] of Object.entries(gameResult)) {
      if (!globalPlayerPoints[playerId]) {
        globalPlayerPoints[playerId] = { fantasyPoints: 0, stats: {} };
      }
      globalPlayerPoints[playerId].fantasyPoints += data.fantasyPoints;
      globalPlayerPoints[playerId].fantasyPoints = Math.round(globalPlayerPoints[playerId].fantasyPoints * 100) / 100;
      // Merge stats (keep last game's stats structure since most players only play one game per day)
      globalPlayerPoints[playerId].stats = data.stats;
    }
  }

  // 5. Calculate per-league custom scoring
  const leaguePoints = {};
  
  if (options.leagueId) {
    const leagueDoc = await getDb().collection("fantasy_leagues").doc(options.leagueId).get();
    if (leagueDoc.exists) {
      const leagueData = leagueDoc.data();
      const leagueScoringSettings = leagueData.scoringSettings;
      if (leagueScoringSettings) {
        const leagueId = leagueDoc.id;
        leaguePoints[leagueId] = {};
        for (const gameId of gameIds) {
          const summary = allSummaries[gameId];
          if (!summary) continue;

          const gameResult = calculatePlayerStatsFromSummary(summary, leagueScoringSettings, playersPosMap);
          for (const [playerId, data] of Object.entries(gameResult)) {
            leaguePoints[leagueId][playerId] = (leaguePoints[leagueId][playerId] || 0) + data.fantasyPoints;
            leaguePoints[leagueId][playerId] = Math.round(leaguePoints[leagueId][playerId] * 100) / 100;
          }
        }
      }
    }
  } else {
    const leaguesSnap = await getDb().collection("fantasy_leagues").get();
    for (const leagueDoc of leaguesSnap.docs) {
      const leagueData = leagueDoc.data();
      const leagueScoringSettings = leagueData.scoringSettings;
      if (!leagueScoringSettings) continue;

      const leagueId = leagueDoc.id;
      leaguePoints[leagueId] = {};
      for (const gameId of gameIds) {
        const summary = allSummaries[gameId];
        if (!summary) continue;

        const gameResult = calculatePlayerStatsFromSummary(summary, leagueScoringSettings, playersPosMap);
        for (const [playerId, data] of Object.entries(gameResult)) {
          leaguePoints[leagueId][playerId] = (leaguePoints[leagueId][playerId] || 0) + data.fantasyPoints;
          leaguePoints[leagueId][playerId] = Math.round(leaguePoints[leagueId][playerId] * 100) / 100;
        }
      }
    }
  }

  // 6. Write to Firestore (with merging to prevent overwriting other leagues' custom scoring)
  let mergedLeaguePoints = leaguePoints;
  let mergedPlayerPoints = globalPlayerPoints;
  
  if (existingDoc.exists) {
    const existingData = existingDoc.data();
    mergedLeaguePoints = {
      ...(existingData.leaguePoints || {}),
      ...leaguePoints
    };
    if (Object.keys(globalPlayerPoints).length === 0 && existingData.playerPoints) {
      mergedPlayerPoints = existingData.playerPoints;
    }
  }

  const docData = {
    date: dateStr,
    seasonId: seasonId,
    status: status,
    gamesProcessed: gameIds,
    playerPoints: mergedPlayerPoints,
    leaguePoints: mergedLeaguePoints,
    updatedAt: Timestamp.now(),
    version: existingDoc.exists ? (existingDoc.data().version || 0) + 1 : 1
  };

  await getDb().collection("daily_game_stats").doc(dateStr).set(docData);

  const totalPlayers = Object.keys(mergedPlayerPoints).length;
  const totalLeagues = Object.keys(mergedLeaguePoints).length;
  console.log(`[DailyStats] Wrote daily_game_stats/${dateStr}: ${gameIds.length} games, ${totalPlayers} players, ${totalLeagues} league overrides, status=${status}`);
}

/**
 * Returns a Set of player IDs whose PWHL teams have active or completed games 
 * on the specified date. These players' lineup slots should be LOCKED.
 * 
 * Player-level lock logic:
 * - A player's slot locks when their PWHL team's game starts
 * - Players whose team hasn't played yet today can still be swapped
 * 
 * @param {string} dateStr - The date to check, in "YYYY-MM-DD" format
 * @param {string} seasonId - The PWHL season ID
 * @param {Array} [preloadedGames] - Optional pre-loaded games array
 * @returns {Promise<Set<string>>} Set of locked player IDs
 */
async function getLockedPlayerIds(dateStr, seasonId, preloadedGames = null) {
  // 1. Find games on this date with status >= "in progress"
  let games = preloadedGames;
  if (!games) {
    const gamesSnap = await getDb().collection("pwhl_games").get();
    games = [];
    gamesSnap.forEach(doc => games.push({ id: doc.id, ...doc.data() }));
  }

  const lockedTeamIds = new Set();

  games.forEach(game => {
    const gDateStr = game.date_played || game.date;
    if (!gDateStr) return;
    const gDate = parseDateSafe(gDateStr);
    if (getLocalDateStr(gDate) !== dateStr) return;

    // Status 2 = In Progress, 3 = Final (OT/SO), 4 = Final
    const isActiveOrComplete = game.status === "2" || game.status === "3" || game.status === "4";
    if (!isActiveOrComplete) return;

    // Add both home and visiting team IDs
    if (game.home_team) lockedTeamIds.add(String(game.home_team));
    if (game.visiting_team) lockedTeamIds.add(String(game.visiting_team));
  });

  if (lockedTeamIds.size === 0) {
    return new Set();
  }

  // 2. Map locked team IDs to player IDs
  const seasonFilter = seasonId
    ? [String(seasonId), Number(seasonId)]
    : undefined;

  let playersSnap;
  if (seasonFilter) {
    playersSnap = await getDb().collection("pwhl_players")
      .where("season_id", "in", seasonFilter)
      .get();
  } else {
    playersSnap = await getDb().collection("pwhl_players").get();
  }

  const lockedPlayerIds = new Set();
  playersSnap.forEach(pDoc => {
    const p = pDoc.data();
    const teamId = String(p.current_team_id || p.team_id || "");
    if (lockedTeamIds.has(teamId)) {
      const playerId = String(p.player_id || p.id || pDoc.id.split("_")[1]);
      if (playerId) {
        lockedPlayerIds.add(playerId);
      }
    }
  });

  console.log(`[DailyStats] getLockedPlayerIds(${dateStr}): ${lockedTeamIds.size} locked teams → ${lockedPlayerIds.size} locked players`);
  return lockedPlayerIds;
}

/**
 * Reads daily fantasy points for a specific date from the daily_game_stats collection.
 * Returns the per-league points if available, otherwise falls back to global default.
 * 
 * @param {string} dateStr - "YYYY-MM-DD"
 * @param {string} [leagueId] - Optional league ID for custom scoring lookup
 * @returns {Promise<Object>} { playerId: fantasyPoints } map
 */
async function readDailyPoints(dateStr, leagueId = null) {
  const docSnap = await getDb().collection("daily_game_stats").doc(dateStr).get();
  if (docSnap.exists) {
    const data = docSnap.data();

    // If a league-specific override exists, use it
    if (leagueId && data.leaguePoints && data.leaguePoints[leagueId]) {
      return data.leaguePoints[leagueId];
    }

    // Otherwise, extract just the fantasyPoints from the global playerPoints
    const result = {};
    if (data.playerPoints) {
      for (const [playerId, entry] of Object.entries(data.playerPoints)) {
        result[playerId] = entry.fantasyPoints || 0;
      }
    }
    return result;
  }

  // Fallback: Calculate on the fly if snapshot document doesn't exist
  console.log(`[DailyStats] Snapshot missing for ${dateStr}. Calculating points on the fly...`);
  try {
    const gamesSnap = await getDb().collection("pwhl_games").get();
    const dailyGames = [];
    gamesSnap.forEach(doc => {
      const game = doc.data();
      const gDateStr = game.date_played || game.date;
      if (!gDateStr) return;
      const gDate = parseDateSafe(gDateStr);
      const isFinal = game.status === "4" || game.status === "3";
      if (getLocalDateStr(gDate) === dateStr && isFinal) {
        dailyGames.push({ id: doc.id, ...game });
      }
    });

    if (dailyGames.length === 0) {
      return {};
    }

    let scoringRules = DEFAULT_SCORING;
    if (leagueId) {
      const leagueDoc = await getDb().collection("fantasy_leagues").doc(leagueId).get();
      if (leagueDoc.exists && leagueDoc.data().scoringSettings) {
        scoringRules = leagueDoc.data().scoringSettings;
      }
    }

    const playersPosMap = {};
    const playersSnap = await getDb().collection("pwhl_players").get();
    playersSnap.forEach(pDoc => {
      const p = pDoc.data();
      const id = p.player_id || p.id || pDoc.id.split("_")[1];
      if (id) {
        playersPosMap[id.toString()] = normalizePosition(p.position);
      }
    });

    const result = {};
    for (const game of dailyGames) {
      const gameId = String(game.game_id || game.id);
      const summaryDoc = await getDb().collection("pwhl_game_summaries").doc(gameId).get();
      if (summaryDoc.exists) {
        const summary = summaryDoc.data();
        const stats = calculatePlayerStatsFromSummary(summary, scoringRules, playersPosMap);
        for (const [playerId, entry] of Object.entries(stats)) {
          if (!result[playerId]) result[playerId] = 0;
          result[playerId] += entry.fantasyPoints || 0;
        }
      }
    }

    // Round all fantasy points
    for (const playerId of Object.keys(result)) {
      result[playerId] = Math.round(result[playerId] * 100) / 100;
    }

    return result;
  } catch (err) {
    console.error(`[DailyStats] Failed calculating fallback daily points for ${dateStr}:`, err);
    return {};
  }
}

/**
 * Calculates the total matchup score for a team over a range of dates.
 * Uses daily_game_stats for points and daily_lineups for roster context.
 * 
 * @param {string} leagueId - Fantasy league ID
 * @param {string} teamId - Team ID
 * @param {Date} startDate - Start of range (inclusive)
 * @param {Date} endDate - End of range (inclusive, capped at current date)
 * @param {Object} [options] - Optional cache objects
 * @param {Object} [options.dailyPointsCache] - Cache: dateStr -> { playerId: points }
 * @param {Object} [options.lineupCache] - Cache: "teamId_dateStr" -> activeLineup
 * @returns {Promise<{ totalScore: number, dailyBreakdown: Object }>}
 */
async function calculateTeamWeekScore(leagueId, teamId, startDate, endDate, options = {}) {
  const dailyPointsCache = options.dailyPointsCache || {};
  const lineupCache = options.lineupCache || {};

  let totalScore = 0.0;
  const dailyBreakdown = {}; // dateStr -> dayScore

  const current = new Date(startDate);
  while (current <= endDate) {
    const dateStr = getLocalDateStr(current);

    // 1. Get daily points (from cache or Firestore)
    if (!dailyPointsCache[dateStr]) {
      dailyPointsCache[dateStr] = await readDailyPoints(dateStr, leagueId);
    }
    const dayPoints = dailyPointsCache[dateStr];

    // 2. Get team's active lineup for this date
    const cacheKey = `${teamId}_${dateStr}`;
    if (!lineupCache[cacheKey]) {
      lineupCache[cacheKey] = await getTeamActiveLineup(leagueId, teamId, dateStr);
    }
    const activeLineup = lineupCache[cacheKey];

    // 3. Sum points for active players only
    let dayScore = 0.0;
    Object.values(activeLineup).forEach(playerId => {
      if (playerId) {
        dayScore += dayPoints[String(playerId)] || 0.0;
      }
    });

    dailyBreakdown[dateStr] = Math.round(dayScore * 100) / 100;
    totalScore += dayScore;

    current.setDate(current.getDate() + 1);
  }

  return {
    totalScore: Math.round(totalScore * 100) / 100,
    dailyBreakdown
  };
}

/**
 * Helper to fetch a team's active lineup for a date, with fallback to previous day.
 */
async function getTeamActiveLineup(leagueId, teamId, dateStr) {
  try {
    const lineupDoc = await getDb().collection("fantasy_leagues").doc(leagueId)
      .collection("teams").doc(teamId)
      .collection("daily_lineups").doc(dateStr).get();

    if (lineupDoc.exists) {
      const data = lineupDoc.data();
      if (data && data.activeLineup) {
        return data.activeLineup;
      }
    }
  } catch (err) {
    console.error(`[DailyStats] Error loading lineup for team ${teamId} on ${dateStr}:`, err);
  }

  // Fallback: find most recent previous daily lineup
  try {
    const prevSnap = await getDb().collection("fantasy_leagues").doc(leagueId)
      .collection("teams").doc(teamId)
      .collection("daily_lineups")
      .where("date", "<", dateStr)
      .orderBy("date", "desc")
      .limit(1)
      .get();

    if (!prevSnap.empty) {
      const data = prevSnap.docs[0].data();
      if (data && data.activeLineup) {
        return data.activeLineup;
      }
    }
  } catch (err) {
    console.error(`[DailyStats] Error finding previous lineup for team ${teamId}:`, err);
  }

  // Fallback 2: build default lineup using team's activePlayers
  try {
    const teamDoc = await getDb().collection("fantasy_leagues").doc(leagueId)
      .collection("teams").doc(teamId).get();
    
    if (teamDoc.exists) {
      const teamData = teamDoc.data();
      const activeIds = (teamData.activePlayers || []).map(String);
      if (activeIds.length > 0) {
        const leagueDoc = await getDb().collection("fantasy_leagues").doc(leagueId).get();
        const leagueData = leagueDoc.exists ? leagueDoc.data() : {};
        const rosterSettings = leagueData.rosterSettings || {};
        const seasonId = leagueData.season_id ? String(leagueData.season_id) : "1";

        const fLimit = rosterSettings.forwards?.starters ?? 6;
        const dLimit = rosterSettings.defense?.starters ?? 4;
        const gLimit = rosterSettings.goalies?.starters ?? 1;

        // Fetch player positions in parallel
        const playerPromises = activeIds.map(async (pId) => {
          try {
            const pSnap = await getDb().collection("pwhl_players").doc(`${seasonId}_${pId}`).get();
            let pos = 'F';
            if (pSnap.exists) {
              pos = normalizePosition(pSnap.data().position);
            } else {
              const numId = parseInt(String(pId).replace(/^\D+/g, ''), 10);
              if (!isNaN(numId)) {
                if (numId >= 12 && numId <= 14) pos = "G";
                else if (numId >= 8 && numId <= 11) pos = "D";
              }
            }
            return { id: pId, pos };
          } catch (e) {
            console.error(`[DailyStats] Error fetching player pos for ${pId}:`, e);
            return { id: pId, pos: 'F' };
          }
        });

        const playerInfos = await Promise.all(playerPromises);
        
        const activeLineup = {};
        let fc = 0, dc = 0, gc = 0;
        playerInfos.forEach(({ id, pos }) => {
          if (pos === 'F' && fc < fLimit) { fc++; activeLineup[`F${fc}`] = id; }
          else if (pos === 'D' && dc < dLimit) { dc++; activeLineup[`D${dc}`] = id; }
          else if (pos === 'G' && gc < gLimit) { gc++; activeLineup[`G${gc}`] = id; }
        });
        
        return activeLineup;
      }
    }
  } catch (err) {
    console.error(`[DailyStats] Fallback activePlayers lineup build failed for team ${teamId}:`, err);
  }

  return {}; // Empty lineup = 0 points
}

module.exports = {
  snapshotDailyGameStats,
  getLockedPlayerIds,
  readDailyPoints,
  calculateTeamWeekScore,
  getTeamActiveLineup,
  calculatePlayerStatsFromSummary,
  normalizePosition,
  getLocalDateStr,
  parseDateSafe,
  DEFAULT_SCORING
};
