import { db } from '../firebase';
import { collection, getDocs, query, where, doc, getDoc } from 'firebase/firestore';
import { normalizePosition } from './pwhlService';


// Safe date parser: avoids UTC midnight shift for bare "YYYY-MM-DD" strings
function parseDateSafe(dateStr) {
  if (!dateStr) return new Date();
  const s = String(dateStr);
  if (s.includes('T') || s.includes(' ')) return new Date(s);
  const parts = s.split('-').map(Number);
  if (parts.length === 3) return new Date(parts[0], parts[1] - 1, parts[2], 12, 0, 0);
  return new Date(s);
}

/**
 * Dynamically aggregates cumulative player stats from raw game summaries
 * based on a simulated "Time Travel" cutoff date.
 *
 * Data structure (PWHL HockeyTech GC API):
 *   - Skaters: summary.home_team_lineup.players[] and summary.visitor_team_lineup.players[]
 *     Fields: goals, assists, plusminus, pim, shots_on, power_play_goals, short_handed_goals,
 *             shots_blocked_by_player, hits
 *   - Goalies: summary.goalies.home[] and summary.goalies.visitor[]
 *     Fields: win, loss, ot_loss, shutout, saves, goals_against, seconds (TOI in seconds)
 *   - Assists / PP Assists / SH Assists: derived from summary.goals[] array
 *     Each goal has: goal_scorer.player_id, assist1_player.player_id, assist2_player.player_id
 *                    power_play, short_handed flags
 *
 * @param {string} seasonId - The PWHL season ID
 * @param {Date} cutoffDate - The simulated date (e.g. from getSimulatedDate())
 * @param {Date} startDate - Optional. If provided, only includes games on or after this date.
 * @returns {Object} { skaters: {}, goalies: {} } dictionaries keyed by player_id
 */
export async function fetchAggregatedStats(seasonId, cutoffDate, startDate = null) {
  // Helper to race getDocs with a timeout to prevent hanging on cached emulator connections
  async function getDocsWithTimeout(colRef, timeoutMs = 5000) {
    return Promise.race([
      getDocs(colRef),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Connection timed out. This often happens if the browser is using a cached connection to a non-running Firestore emulator.")), timeoutMs)
      )
    ]);
  }

  // 1. Fetch all games for the season to determine which were Final BEFORE the cutoff date
  const gamesQuery = query(collection(db, 'pwhl_games'), where('season_id', 'in', [seasonId, Number(seasonId)]));
  const gamesSnap = await getDocsWithTimeout(gamesQuery, 5000);

  const pastGameIds = new Set();
  gamesSnap.forEach(docSnap => {
    const game = docSnap.data();
    // status '4' = Final in PWHL schedule feed
    const isFinal = game.status === '4' || game.status === '3';
    if (!isFinal) return;

    const gDateStr = game.date_played || game.date;
    if (!gDateStr) return;
    const gameDate = parseDateSafe(gDateStr);
    if (gameDate < cutoffDate && (!startDate || gameDate >= startDate)) {
      pastGameIds.add(game.game_id.toString());
    }
  });

  if (pastGameIds.size === 0) {
    return { skaters: {}, goalies: {} };
  }

  // 2. Fetch game summaries for this season
  const summariesQuery = query(collection(db, 'pwhl_game_summaries'), where('season_id', 'in', [seasonId, Number(seasonId)]));
  const summariesSnap = await getDocsWithTimeout(summariesQuery, 5000);

  const skaters = {}; // keyed by player_id string
  const goalies = {}; // keyed by player_id string

  const getSkater = (id) => {
    const key = String(id);
    if (!skaters[key]) {
      skaters[key] = {
        gamesPlayed: 0, goals: 0, assists: 0,
        powerPlayGoals: 0, powerPlayAssists: 0, powerPlayPoints: 0,
        shortHandedGoals: 0, shortHandedAssists: 0, shortHandedPoints: 0,
        pim: 0, plusMinus: 0, shotsOnGoal: 0, blockedShots: 0, hits: 0,
        timeOnIce: 0, averageTimeOnIce: 0,
      };
    }
    return skaters[key];
  };

  const getGoalie = (id) => {
    const key = String(id);
    if (!goalies[key]) {
      goalies[key] = {
        gamesPlayed: 0, wins: 0, losses: 0, overtimeLosses: 0,
        shotsSaved: 0, goalsAgainst: 0, shutouts: 0,
        timeOnIce: 0, averageTimeOnIce: 0,
      };
    }
    return goalies[key];
  };

  summariesSnap.forEach(docSnap => {
    const gameId = docSnap.id;
    if (!pastGameIds.has(gameId)) return; // Skip future or non-final games

    const summary = docSnap.data();

    // ── STEP 1: Count goals per player from the scoring plays (goals array)
    // This gives us accurate PP/SH assists since lineup players[] only has totals
    const scoringPlays = Array.isArray(summary.goals) ? summary.goals : [];
    const assistCounts = {}; // player_id -> { assists, ppAssists, shAssists }
    const goalCounts = {};   // player_id -> { ppGoals, shGoals }

    const getAssistObj = (id) => {
      if (!assistCounts[id]) assistCounts[id] = { assists: 0, ppAssists: 0, shAssists: 0 };
      return assistCounts[id];
    };
    const getGoalObj = (id) => {
      if (!goalCounts[id]) goalCounts[id] = { ppGoals: 0, shGoals: 0 };
      return goalCounts[id];
    };

    scoringPlays.forEach(goal => {
      const isPP = goal.power_play === '1' || goal.power_play === 1;
      const isSH = goal.short_handed === '1' || goal.short_handed === 1;

      // Scorer goal type breakdowns
      if (goal.goal_scorer?.player_id) {
        const g = getGoalObj(goal.goal_scorer.player_id);
        if (isPP) g.ppGoals++;
        if (isSH) g.shGoals++;
      }

      // Assists
      [goal.assist1_player, goal.assist2_player].forEach(a => {
        if (!a?.player_id) return;
        const obj = getAssistObj(a.player_id);
        obj.assists++;
        if (isPP) obj.ppAssists++;
        if (isSH) obj.shAssists++;
      });
    });

    // ── STEP 2: Process Skaters from lineup
    const processSkaters = (players) => {
      if (!Array.isArray(players)) return;
      players.forEach(player => {
        const id = player.player_id;
        if (!id) return;
        const s = getSkater(id);
        s.gamesPlayed += 1;

        // Basic counting stats from lineup
        s.goals += parseInt(player.goals || 0);
        s.pim += parseInt(player.pim || 0);
        s.shotsOnGoal += parseInt(player.shots_on || player.shots || 0);
        s.blockedShots += parseInt(player.shots_blocked_by_player || player.shots_blocked || 0);
        s.hits += parseInt(player.hits || 0);

        // +/- can be a string like "+2" or "-1"
        const pm = player.plusminus;
        if (pm !== undefined && pm !== null && pm !== '') {
          s.plusMinus += parseInt(pm, 10) || 0;
        }

        // Assists from our scoring-play scan (more accurate PP/SH breakdown)
        const assistObj = assistCounts[id];
        if (assistObj) {
          s.assists += assistObj.assists;
          s.powerPlayAssists += assistObj.ppAssists;
          s.shortHandedAssists += assistObj.shAssists;
        }

        // PP / SH goals from our scoring-play scan
        const goalObj = goalCounts[id];
        if (goalObj) {
          s.powerPlayGoals += goalObj.ppGoals;
          s.shortHandedGoals += goalObj.shGoals;
        }

        // Recalculate combined PP/SH points
        s.powerPlayPoints = s.powerPlayGoals + s.powerPlayAssists;
        s.shortHandedPoints = s.shortHandedGoals + s.shortHandedAssists;
      });
    };

    processSkaters(summary.home_team_lineup?.players);
    processSkaters(summary.visitor_team_lineup?.players);

    // ── STEP 3: Process Goalies from top-level goalies object
    const processGoalies = (goalieList) => {
      if (!Array.isArray(goalieList)) return;
      
      const goalieMap = {};
      goalieList.forEach(goalie => {
        const id = goalie.player_id;
        if (!id) return;
        const idStr = String(id);
        
        let secs = parseInt(goalie.seconds || goalie.secs || 0);
        if (!secs && goalie.secs_mmss && goalie.secs_mmss.includes(':')) {
          const [m, s] = goalie.secs_mmss.split(':').map(Number);
          secs = m * 60 + s;
        }

        if (!goalieMap[idStr]) {
          goalieMap[idStr] = {
            saves: parseInt(goalie.saves || 0),
            goalsAgainst: parseInt(goalie.goals_against || 0),
            wins: parseInt(goalie.win || 0),
            losses: parseInt(goalie.loss || 0),
            overtimeLosses: parseInt(goalie.ot_loss || 0),
            shutouts: parseInt(goalie.shutout || 0),
            timeOnIce: secs
          };
        } else {
          const existing = goalieMap[idStr];
          existing.saves += parseInt(goalie.saves || 0);
          existing.goalsAgainst += parseInt(goalie.goals_against || 0);
          existing.wins = Math.max(existing.wins, parseInt(goalie.win || 0));
          existing.losses = Math.max(existing.losses, parseInt(goalie.loss || 0));
          existing.overtimeLosses = Math.max(existing.overtimeLosses, parseInt(goalie.ot_loss || 0));
          existing.shutouts = Math.max(existing.shutouts, parseInt(goalie.shutout || 0));
          existing.timeOnIce += secs;
        }
      });

      for (const [id, stats] of Object.entries(goalieMap)) {
        const g = getGoalie(id);
        // A goalie is considered to have played in the game if they played at least 1 second or recorded a save/allowed a goal
        if (stats.timeOnIce > 0 || stats.saves > 0 || stats.goalsAgainst > 0) {
          g.gamesPlayed += 1;
          g.shotsSaved += stats.saves;
          g.goalsAgainst += stats.goalsAgainst;
          g.wins += stats.wins;
          g.losses += stats.losses;
          g.overtimeLosses += stats.overtimeLosses;
          g.shutouts += stats.shutouts;
          g.timeOnIce += stats.timeOnIce;
        }
      }
    };

    // Goalies live under summary.goalies.home[] and summary.goalies.visitor[]
    const goaliesData = summary.goalies;
    if (goaliesData && typeof goaliesData === 'object') {
      processGoalies(goaliesData.home);
      processGoalies(goaliesData.visitor);
    }
  });

  // ── STEP 4: Calculate averages
  Object.values(skaters).forEach(s => {
    s.averageTimeOnIce = s.gamesPlayed > 0 ? Math.round(s.timeOnIce / s.gamesPlayed) : 0;
  });
  Object.values(goalies).forEach(g => {
    g.averageTimeOnIce = g.gamesPlayed > 0 ? Math.round(g.timeOnIce / g.gamesPlayed) : 0;
  });

  return { skaters, goalies };
}

/**
 * Computes fantasy points for all players strictly bounded within a single matchup week.
 *
 * @param {string} seasonId - The PWHL season ID
 * @param {Date} weekStart - The start date of the week (inclusive)
 * @param {Date} weekEnd - The end date of the week (inclusive)
 * @param {Date} simulatedDate - The current simulation cutoff date
 * @param {Object} scoringSettings - Fantasy points matrix
 * @returns {Object} Map of player_id -> fantasyPoints
 */
export async function fetchWeeklyPlayerPoints(seasonId, weekStart, weekEnd, simulatedDate, scoringSettings) {
  // We only care about games that happen during the week AND before the simulation date
  // End bound is min(weekEnd end of day, simulatedDate)
  let effectiveEnd = new Date(weekEnd);
  effectiveEnd.setHours(23, 59, 59, 999);
  
  if (simulatedDate && simulatedDate < effectiveEnd) {
    effectiveEnd = simulatedDate;
  }

  // Start bound is weekStart beginning of day
  const effectiveStart = new Date(weekStart);
  effectiveStart.setHours(0, 0, 0, 0);

  // If the week hasn't even started in our simulation yet, return 0 points instantly
  if (effectiveStart >= effectiveEnd) {
    return {};
  }

  const { skaters, goalies } = await fetchAggregatedStats(seasonId, effectiveEnd, effectiveStart);
  
  const defaultScoring = {
    skaters: { goals: 2, assists: 1, plusMinus: 0.5, ppp: 0.5, shp: 0.5, sog: 0.1, hits: 0.1, blocks: 0.5, defensePoints: 0.5 },
    goalies: { wins: 4, otl: 1, ga: -2, saves: 0.2, shutouts: 3 }
  };
  const scoring = scoringSettings || defaultScoring;
  
  const skaterMatrix = scoring.skaters || defaultScoring.skaters;
  const goalieMatrix = scoring.goalies || defaultScoring.goalies;

  const pointsMap = {};

  // Compute for skaters
  for (const [id, s] of Object.entries(skaters)) {
    let pts = 0;
    pts += s.goals * (skaterMatrix.goals || 0);
    pts += s.assists * (skaterMatrix.assists || 0);
    pts += s.plusMinus * (skaterMatrix.plusMinus || 0);
    pts += s.powerPlayPoints * (skaterMatrix.ppp || 0);
    pts += s.shortHandedPoints * (skaterMatrix.shp || 0);
    pts += s.shotsOnGoal * (skaterMatrix.sog || 0);
    pts += s.hits * (skaterMatrix.hits || 0);
    pts += s.blockedShots * (skaterMatrix.blocks || 0);
    // Defense points are handled via position lookup in Roster/Matchup. 
    // Here we can't reliably know if player is a Defenseman. The caller will add defensePoints if needed.
    // However, if we must, we can leave the base points here, and callers add defense points.
    // For simplicity, we just return the base skater points.
    pointsMap[id] = pts;
  }

  // Compute for goalies
  for (const [id, g] of Object.entries(goalies)) {
    let pts = 0;
    pts += g.wins * (goalieMatrix.wins || 0);
    pts += g.overtimeLosses * (goalieMatrix.otl || 0);
    pts += g.goalsAgainst * (goalieMatrix.ga || 0);
    pts += g.shotsSaved * (goalieMatrix.saves || 0);
    pts += g.shutouts * (goalieMatrix.shutouts || 0);
    pointsMap[id] = pts;
  }

  return { pointsMap, skaters, goalies };
}

/**
 * Helper to format a local date string (YYYY-MM-DD)
 */
function getLocalDateStr(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Calculates daily fantasy points for each player on each day of the week.
 */
export async function fetchDailyPlayerPointsForWeek(seasonId, weekStart, weekEnd, simulatedDate, scoringSettings) {
  let effectiveEnd = new Date(weekEnd);
  effectiveEnd.setHours(23, 59, 59, 999);
  if (simulatedDate && simulatedDate < effectiveEnd) {
    effectiveEnd = simulatedDate;
  }
  const effectiveStart = new Date(weekStart);
  effectiveStart.setHours(0, 0, 0, 0);

  if (effectiveStart >= effectiveEnd) {
    return {};
  }

  const gamesQuery = query(collection(db, 'pwhl_games'), where('season_id', 'in', [seasonId, Number(seasonId)]));
  const gamesSnap = await getDocs(gamesQuery);

  const gameDateMap = {};
  const finalGameIds = new Set();

  gamesSnap.forEach(docSnap => {
    const game = docSnap.data();
    const isFinal = game.status === '4' || game.status === '3';
    if (!isFinal) return;

    const gDateStr = game.date_played || game.date;
    if (!gDateStr) return;
    const gameDate = parseDateSafe(gDateStr);
    
    if (gameDate >= effectiveStart && gameDate <= effectiveEnd) {
      const gId = String(game.game_id);
      finalGameIds.add(gId);
      gameDateMap[gId] = getLocalDateStr(gameDate);
    }
  });

  if (finalGameIds.size === 0) {
    return {};
  }

  // 2. Fetch all players to get positions
  const playersQuery = query(collection(db, 'pwhl_players'), where('season_id', 'in', [seasonId, Number(seasonId)]));
  const playersSnap = await getDocs(playersQuery);
  const playerPosMap = {};
  playersSnap.forEach(pDoc => {
    const p = pDoc.data();
    const pId = p.player_id || p.id;
    if (pId) {
      playerPosMap[String(pId)] = normalizePosition(p.position);
    }
  });

  // 3. Fetch all game summaries
  const summariesQuery = query(collection(db, 'pwhl_game_summaries'), where('season_id', 'in', [seasonId, Number(seasonId)]));
  const summariesSnap = await getDocs(summariesQuery);

  const defaultScoring = {
    skaters: { goals: 2, assists: 1, plusMinus: 0.5, ppp: 0.5, shp: 0.5, sog: 0.1, hits: 0.1, blocks: 0.5, defensePoints: 0.5 },
    goalies: { wins: 4, otl: 1, ga: -2, saves: 0.2, shutouts: 3 }
  };
  const scoring = scoringSettings || defaultScoring;
  const skaterMatrix = scoring.skaters || defaultScoring.skaters;
  const goalieMatrix = scoring.goalies || defaultScoring.goalies;

  // We want to calculate points per player per day
  const dailyPoints = {};

  summariesSnap.forEach(docSnap => {
    const gameId = String(docSnap.id);
    if (!finalGameIds.has(gameId)) return;

    const dateStr = gameDateMap[gameId];
    if (!dateStr) return;

    if (!dailyPoints[dateStr]) {
      dailyPoints[dateStr] = {};
    }
    const dayMap = dailyPoints[dateStr];

    const summary = docSnap.data();

    const scoringPlays = Array.isArray(summary.goals) ? summary.goals : [];
    const assistCounts = {};
    const goalCounts = {};

    scoringPlays.forEach(goal => {
      const isPP = goal.power_play === '1' || goal.power_play === 1;
      const isSH = goal.short_handed === '1' || goal.short_handed === 1;

      if (goal.goal_scorer?.player_id) {
        const id = String(goal.goal_scorer.player_id);
        if (!goalCounts[id]) goalCounts[id] = { ppGoals: 0, shGoals: 0 };
        if (isPP) goalCounts[id].ppGoals++;
        if (isSH) goalCounts[id].shGoals++;
      }

      [goal.assist1_player, goal.assist2_player].forEach(a => {
        if (!a?.player_id) return;
        const id = String(a.player_id);
        if (!assistCounts[id]) assistCounts[id] = { assists: 0, ppAssists: 0, shAssists: 0 };
        assistCounts[id].assists++;
        if (isPP) assistCounts[id].ppAssists++;
        if (isSH) assistCounts[id].shAssists++;
      });
    });

    const processSkaters = (players) => {
      if (!Array.isArray(players)) return;
      players.forEach(player => {
        const id = String(player.player_id);
        if (!id) return;

        const goals = parseInt(player.goals || 0);
        const pim = parseInt(player.pim || 0);
        const shots = parseInt(player.shots_on || player.shots || 0);
        const blocks = parseInt(player.shots_blocked_by_player || player.shots_blocked || 0);
        const hits = parseInt(player.hits || 0);

        let plusMinus = 0;
        const pm = player.plusminus;
        if (pm !== undefined && pm !== null && pm !== '') {
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

        let pts = 0;
        pts += goals * (skaterMatrix.goals || 0);
        pts += assists * (skaterMatrix.assists || 0);
        pts += plusMinus * (skaterMatrix.plusMinus || 0);
        pts += ppPoints * (skaterMatrix.ppp || 0);
        pts += shPoints * (skaterMatrix.shp || 0);
        pts += shots * (skaterMatrix.sog || 0);
        pts += hits * (skaterMatrix.hits || 0);
        pts += blocks * (skaterMatrix.blocks || 0);

        const pos = playerPosMap[id] || 'F';
        if (pos === 'D') {
          pts += (goals + assists) * (skaterMatrix.defensePoints || 0);
        }

        dayMap[id] = (dayMap[id] || 0) + pts;
      });
    };

    processSkaters(summary.home_team_lineup?.players);
    processSkaters(summary.visitor_team_lineup?.players);

    const processGoalies = (goalieList) => {
      if (!Array.isArray(goalieList)) return;
      
      const goalieMap = {};
      goalieList.forEach(goalie => {
        const id = String(goalie.player_id);
        if (!id) return;
        
        let secs = parseInt(goalie.seconds || goalie.secs || 0);
        if (!secs && goalie.secs_mmss && goalie.secs_mmss.includes(':')) {
          const [m, s] = goalie.secs_mmss.split(':').map(Number);
          secs = m * 60 + s;
        }

        if (!goalieMap[id]) {
          goalieMap[id] = {
            saves: parseInt(goalie.saves || 0),
            goalsAgainst: parseInt(goalie.goals_against || 0),
            wins: parseInt(goalie.win || 0),
            overtimeLosses: parseInt(goalie.ot_loss || 0),
            shutouts: parseInt(goalie.shutout || 0),
            timeOnIce: secs
          };
        } else {
          const existing = goalieMap[id];
          existing.saves += parseInt(goalie.saves || 0);
          existing.goalsAgainst += parseInt(goalie.goals_against || 0);
          existing.wins = Math.max(existing.wins, parseInt(goalie.win || 0));
          existing.overtimeLosses = Math.max(existing.overtimeLosses, parseInt(goalie.ot_loss || 0));
          existing.shutouts = Math.max(existing.shutouts, parseInt(goalie.shutout || 0));
          existing.timeOnIce += secs;
        }
      });

      for (const [id, stats] of Object.entries(goalieMap)) {
        if (stats.timeOnIce > 0 || stats.saves > 0 || stats.goalsAgainst > 0) {
          let pts = 0;
          pts += stats.wins * (goalieMatrix.wins || 0);
          pts += stats.overtimeLosses * (goalieMatrix.otl || 0);
          pts += stats.goalsAgainst * (goalieMatrix.ga || 0);
          pts += stats.saves * (goalieMatrix.saves || 0);
          pts += stats.shutouts * (goalieMatrix.shutouts || 0);

          dayMap[id] = (dayMap[id] || 0) + pts;
        }
      }
    };

    if (summary.goalies && typeof summary.goalies === 'object') {
      processGoalies(summary.goalies.home);
      processGoalies(summary.goalies.visitor);
    }
  });

  return dailyPoints;
}

/**
 * NEW: Reads pre-computed daily fantasy points from the `daily_game_stats` collection.
 * This is the primary function for the new architecture — it reads snapshots instead
 * of recalculating from raw game summaries.
 * 
 * Falls back to the legacy `fetchDailyPlayerPointsForWeek` if daily_game_stats 
 * documents don't exist yet (e.g., during migration or for dates before the new pipeline).
 *
 * @param {string} seasonId - The PWHL season ID
 * @param {Date} weekStart - The start date of the week (inclusive)
 * @param {Date} weekEnd - The end date of the week (inclusive)
 * @param {Date} simulatedDate - The current simulation cutoff date
 * @param {Object} scoringSettings - Fantasy points matrix (used for fallback only)
 * @param {string} [leagueId] - Optional league ID for per-league scoring lookup
 * @returns {Object} { "YYYY-MM-DD": { playerId: fantasyPoints } }
 */
export async function fetchDailyPlayerPointsFromSnapshot(seasonId, weekStart, weekEnd, simulatedDate, scoringSettings, leagueId = null) {
  let effectiveEnd = new Date(weekEnd);
  effectiveEnd.setHours(23, 59, 59, 999);
  if (simulatedDate && simulatedDate < effectiveEnd) {
    effectiveEnd = simulatedDate;
  }
  const effectiveStart = new Date(weekStart);
  effectiveStart.setHours(0, 0, 0, 0);

  if (effectiveStart >= effectiveEnd) {
    return {};
  }

  const dailyPoints = {};
  let usedSnapshot = false;
  let snapshotMissCount = 0;

  // Try to read from daily_game_stats for each day
  const current = new Date(effectiveStart);
  while (current <= effectiveEnd) {
    const dateStr = getLocalDateStr(current);
    
    try {
      const docRef = doc(db, 'daily_game_stats', dateStr);
      const docSnap = await getDoc(docRef);
      
      if (docSnap.exists()) {
        usedSnapshot = true;
        const data = docSnap.data();
        
        // Use per-league scoring if available
        if (leagueId && data.leaguePoints && data.leaguePoints[leagueId]) {
          dailyPoints[dateStr] = data.leaguePoints[leagueId];
        } else if (data.playerPoints) {
          // Extract just fantasyPoints from global playerPoints
          const dayMap = {};
          for (const [playerId, entry] of Object.entries(data.playerPoints)) {
            if (typeof entry === 'object' && entry.fantasyPoints !== undefined) {
              dayMap[playerId] = entry.fantasyPoints;
            } else {
              dayMap[playerId] = entry; // Backward compat if stored as flat number
            }
          }
          dailyPoints[dateStr] = dayMap;
        } else {
          dailyPoints[dateStr] = {};
        }
      } else {
        snapshotMissCount++;
        dailyPoints[dateStr] = {};
      }
    } catch (err) {
      console.warn(`[StatsEngine] Error reading daily_game_stats/${dateStr}:`, err);
      snapshotMissCount++;
      dailyPoints[dateStr] = {};
    }

    current.setDate(current.getDate() + 1);
  }

  // If we didn't find ANY snapshot docs, fall back to legacy calculation
  if (!usedSnapshot && snapshotMissCount > 0) {
    console.log('[StatsEngine] No daily_game_stats found, falling back to legacy calculation');
    return fetchDailyPlayerPointsForWeek(seasonId, weekStart, weekEnd, simulatedDate, scoringSettings);
  }

  return dailyPoints;
}
