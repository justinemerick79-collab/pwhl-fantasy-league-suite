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

const admin = require("firebase-admin");
const { Timestamp } = require("firebase-admin/firestore");

// Lazy getter — ensures admin.initializeApp() has already been called by index.js
function getDb() {
  return admin.firestore();
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
 * This mirrors the logic in calculateSummaryFantasyPoints (functions/index.js)
 * but returns structured stat breakdowns for audit trail purposes.
 */
function calculatePlayerStatsFromSummary(summary, scoringRules, playersPosMap) {
  const result = {}; // playerId -> { stats, fantasyPoints }

  // Step 1: Parse scoring plays for assist/PP/SH breakdowns
  const scoringPlays = Array.isArray(summary.goals) ? summary.goals : [];
  const assistCounts = {};
  const goalCounts = {};

  scoringPlays.forEach(goal => {
    const isPP = goal.power_play === "1" || goal.power_play === 1;
    const isSH = goal.short_handed === "1" || goal.short_handed === 1;

    if (goal.goal_scorer?.player_id) {
      const scorerId = String(goal.goal_scorer.player_id);
      if (!goalCounts[scorerId]) goalCounts[scorerId] = { ppGoals: 0, shGoals: 0 };
      if (isPP) goalCounts[scorerId].ppGoals++;
      if (isSH) goalCounts[scorerId].shGoals++;
    }

    [goal.assist1_player, goal.assist2_player].forEach(a => {
      if (!a?.player_id) return;
      const assistId = String(a.player_id);
      if (!assistCounts[assistId]) assistCounts[assistId] = { assists: 0, ppAssists: 0, shAssists: 0 };
      assistCounts[assistId].assists++;
      if (isPP) assistCounts[assistId].ppAssists++;
      if (isSH) assistCounts[assistId].shAssists++;
    });
  });

  // Step 2: Process skaters
  const homeSkaters = summary.home_team_lineup?.players || [];
  const visitorSkaters = summary.visitor_team_lineup?.players || [];

  [...homeSkaters, ...visitorSkaters].forEach(player => {
    const id = String(player.player_id);
    if (!id) return;

    const goals = parseInt(player.goals || 0);
    const pim = parseInt(player.pim || 0);
    const shots = parseInt(player.shots_on || player.shots || 0);
    const blocks = parseInt(player.shots_blocked_by_player || player.shots_blocked || 0);
    const hits = parseInt(player.hits || 0);

    let plusMinus = 0;
    const pm = player.plusminus;
    if (pm !== undefined && pm !== null && pm !== "") {
      plusMinus = parseInt(pm, 10) || 0;
    }

    let assists = 0;
    let ppPoints = 0;
    let shPoints = 0;

    const assistObj = assistCounts[id];
    if (assistObj) {
      assists += assistObj.assists;
      ppPoints += assistObj.ppAssists;
      shPoints += assistObj.shAssists;
    }

    const goalObj = goalCounts[id];
    if (goalObj) {
      ppPoints += goalObj.ppGoals;
      shPoints += goalObj.shGoals;
    }

    const stats = { goals, assists, plusMinus, ppp: ppPoints, shp: shPoints, sog: shots, hits, blocks, pim };

    // Calculate fantasy points using the provided scoring rules
    const matrix = scoringRules.skaters || DEFAULT_SCORING.skaters;
    let pts = 0;
    pts += goals * (matrix.goals || 0);
    pts += assists * (matrix.assists || 0);
    pts += plusMinus * (matrix.plusMinus || 0);
    pts += ppPoints * (matrix.ppp || 0);
    pts += shPoints * (matrix.shp || 0);
    pts += shots * (matrix.sog || 0);
    pts += hits * (matrix.hits || 0);
    pts += blocks * (matrix.blocks || 0);

    // Defense bonus
    const pos = playersPosMap[id] || "F";
    if (pos === "D" || pos === "Defense") {
      pts += (goals + assists) * (matrix.defensePoints || 0);
    }

    if (!result[id]) {
      result[id] = { fantasyPoints: 0, stats: { goals: 0, assists: 0, plusMinus: 0, ppp: 0, shp: 0, sog: 0, hits: 0, blocks: 0, pim: 0 } };
    }
    result[id].fantasyPoints += pts;
    // Accumulate stats (a player could appear in multiple summaries on same date, though rare)
    const rs = result[id].stats;
    rs.goals += stats.goals;
    rs.assists += stats.assists;
    rs.plusMinus += stats.plusMinus;
    rs.ppp += stats.ppp;
    rs.shp += stats.shp;
    rs.sog += stats.sog;
    rs.hits += stats.hits;
    rs.blocks += stats.blocks;
    rs.pim += stats.pim;
  });

  // Step 3: Process goalies
  const homeGoalies = summary.goalies?.home || [];
  const visitorGoalies = summary.goalies?.visitor || [];

  const gameGoaliesMap = {};
  [...homeGoalies, ...visitorGoalies].forEach(goalie => {
    const id = String(goalie.player_id);
    if (!id) return;

    let secs = parseInt(goalie.seconds || goalie.secs || 0);
    if (!secs && goalie.secs_mmss && goalie.secs_mmss.includes(":")) {
      const [m, s] = goalie.secs_mmss.split(":").map(Number);
      secs = m * 60 + s;
    }

    if (!gameGoaliesMap[id]) {
      gameGoaliesMap[id] = {
        saves: parseInt(goalie.saves || 0),
        goalsAgainst: parseInt(goalie.goals_against || 0),
        wins: parseInt(goalie.win || 0),
        losses: parseInt(goalie.loss || 0),
        overtimeLosses: parseInt(goalie.ot_loss || 0),
        shutouts: parseInt(goalie.shutout || 0),
        timeOnIce: secs
      };
    } else {
      const existing = gameGoaliesMap[id];
      existing.saves += parseInt(goalie.saves || 0);
      existing.goalsAgainst += parseInt(goalie.goals_against || 0);
      existing.wins = Math.max(existing.wins, parseInt(goalie.win || 0));
      existing.losses = Math.max(existing.losses, parseInt(goalie.loss || 0));
      existing.overtimeLosses = Math.max(existing.overtimeLosses, parseInt(goalie.ot_loss || 0));
      existing.shutouts = Math.max(existing.shutouts, parseInt(goalie.shutout || 0));
      existing.timeOnIce += secs;
    }
  });

  for (const [id, stats] of Object.entries(gameGoaliesMap)) {
    if (stats.timeOnIce > 0 || stats.saves > 0 || stats.goalsAgainst > 0) {
      const matrix = scoringRules.goalies || DEFAULT_SCORING.goalies;
      let pts = 0;
      pts += stats.wins * (matrix.wins || 0);
      pts += stats.overtimeLosses * (matrix.otl || 0);
      pts += stats.goalsAgainst * (matrix.ga || 0);
      pts += stats.saves * (matrix.saves || 0);
      pts += stats.shutouts * (matrix.shutouts || 0);

      const goalieStats = {
        wins: stats.wins, losses: stats.losses, overtimeLosses: stats.overtimeLosses,
        goalsAgainst: stats.goalsAgainst, saves: stats.saves, shutouts: stats.shutouts,
        timeOnIce: stats.timeOnIce
      };

      if (!result[id]) {
        result[id] = { fantasyPoints: 0, stats: goalieStats };
      } else {
        result[id].stats = goalieStats;
      }
      result[id].fantasyPoints += pts;
    }
  }

  // Round all fantasy points
  for (const [id, entry] of Object.entries(result)) {
    entry.fantasyPoints = Math.round(entry.fantasyPoints * 100) / 100;
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
  if (!docSnap.exists) {
    return {};
  }

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
