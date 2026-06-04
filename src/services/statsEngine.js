import { db } from '../firebase';
import { collection, getDocs, query, where } from 'firebase/firestore';

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
 * @returns {Object} { skaters: {}, goalies: {} } dictionaries keyed by player_id
 */
export async function fetchAggregatedStats(seasonId, cutoffDate) {
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
    const gameDate = new Date(gDateStr);
    if (gameDate < cutoffDate) {
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
