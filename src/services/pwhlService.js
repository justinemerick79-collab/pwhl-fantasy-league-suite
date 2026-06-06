import { db } from '../firebase';
import { doc, writeBatch, collection, getDocs, query, where } from 'firebase/firestore';

export const normalizePosition = (posStr) => {
  if (!posStr) return 'F';
  const up = String(posStr).toUpperCase().trim();
  if (['C', 'RW', 'LW', 'F', 'FORWARD'].includes(up)) return 'F';
  if (['D', 'RD', 'LD', 'DEFENSE', 'DEFENSEMAN'].includes(up)) return 'D';
  if (['G', 'GOALIE', 'GOALTENDER'].includes(up)) return 'G';
  return 'F';
};

const API_KEY = '446521baf8c38984';
const CLIENT_CODE = 'pwhl';
const BASE_URL = '/api/pwhl/index.php';

async function fetchFromApi(params) {
  const url = new URL(BASE_URL, window.location.origin);
  url.searchParams.append('key', API_KEY);
  url.searchParams.append('client_code', CLIENT_CODE);
  url.searchParams.append('fmt', 'json'); 
  
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.append(key, value);
  }

  const response = await fetch(url.toString());
  if (!response.ok) throw new Error(`API fetch failed: ${response.statusText}`);
  
  const text = await response.text();
  
  let jsonString = text;
  // Handle HockeyTech JSONP callback wrappers if present
  if (text.startsWith('typeof ') || text.indexOf('(') > -1) {
      const match = text.match(/^[^{]*({.*})[^}]*$/s);
      if (match) {
          jsonString = match[1];
      }
  }
  
  return JSON.parse(jsonString);
}

export async function fetchPlayerGameHistory(playerId, pos, teamCode, seasonId, simulatedDate, scoringSettings) {
  try {
    const gamesQuery = query(collection(db, 'pwhl_games'), where('season_id', 'in', [String(seasonId), Number(seasonId)]));
    const gamesSnap = await getDocs(gamesQuery);
    const gamesList = gamesSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    const summariesQuery = query(collection(db, 'pwhl_game_summaries'), where('season_id', 'in', [String(seasonId), Number(seasonId)]));
    const summariesSnap = await getDocs(summariesQuery);
    const gameSummariesList = summariesSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    const cutoff = simulatedDate || new Date();
    const isGoalie = pos === 'G';
    const playerIdStr = String(playerId);
    const defaultScoring = {
      skaters: { goals: 2, assists: 1, plusMinus: 0.5, ppp: 0.5, shp: 0.5, sog: 0.1, hits: 0.1, blocks: 0.5, defensePoints: 0.5 },
      goalies: { wins: 4, otl: 1, ga: -2, saves: 0.2, shutouts: 3 }
    };
    const scoring = scoringSettings || defaultScoring;

    const playerGames = [];

    gameSummariesList.forEach(summary => {
      const gameDoc = gamesList.find(g => String(g.game_id) === String(summary.id));
      if (!gameDoc) return;

      const isFinal = gameDoc.status === '4' || gameDoc.status === '3';
      if (!isFinal) return;

      const gDateStr = gameDoc.date_played || gameDoc.date;
      if (!gDateStr) return;
      const gameDate = new Date(gDateStr);
      if (gameDate >= cutoff) return; // Skip future games

      let participated = false;
      let gameStats = {};
      let pts = 0;

      if (isGoalie) {
        const matchingHome = (summary.goalies?.home || []).filter(g => String(g.player_id) === playerIdStr);
        const matchingVisitor = (summary.goalies?.visitor || []).filter(g => String(g.player_id) === playerIdStr);
        const matches = [...matchingHome, ...matchingVisitor];

        if (matches.length > 0) {
          let wins = 0;
          let otl = 0;
          let ga = 0;
          let saves = 0;
          let shutouts = 0;
          let secs = 0;

          matches.forEach(g => {
            saves += parseInt(g.saves || 0);
            ga += parseInt(g.goals_against || 0);
            wins = Math.max(wins, parseInt(g.win || 0));
            otl = Math.max(otl, parseInt(g.ot_loss || 0));
            shutouts = Math.max(shutouts, parseInt(g.shutout || 0));
            let s = parseInt(g.seconds || g.secs || 0);
            if (!s && g.secs_mmss && g.secs_mmss.includes(':')) {
              const [m, sec] = g.secs_mmss.split(':').map(Number);
              s = m * 60 + sec;
            }
            secs += s;
          });

          if (secs > 0 || saves > 0 || ga > 0) {
            participated = true;
            gameStats = { wins, otl, ga, saves, shutouts };
            
            const matrix = scoring.goalies || defaultScoring.goalies;
            pts += wins * (matrix.wins || 0);
            pts += otl * (matrix.otl || 0);
            pts += ga * (matrix.ga || 0);
            pts += saves * (matrix.saves || 0);
            pts += shutouts * (matrix.shutouts || 0);
          }
        }
      } else {
        const homePlayer = (summary.home_team_lineup?.players || []).find(p => String(p.player_id) === playerIdStr);
        const visitorPlayer = (summary.visitor_team_lineup?.players || []).find(p => String(p.player_id) === playerIdStr);
        const p = homePlayer || visitorPlayer;

        if (p) {
          participated = true;
          const goals = parseInt(p.goals || 0);
          const pim = parseInt(p.pim || 0);
          const shots = parseInt(p.shots_on || p.shots || 0);
          const blocks = parseInt(p.shots_blocked_by_player || p.shots_blocked || 0);
          const hits = parseInt(p.hits || 0);
          
          let plusminus = 0;
          const pm = p.plusminus;
          if (pm !== undefined && pm !== null && pm !== '') {
            plusminus = parseInt(pm, 10) || 0;
          }

          let assists = 0;
          let ppGoals = 0;
          let shGoals = 0;
          let ppAssists = 0;
          let shAssists = 0;

          const scoringPlays = Array.isArray(summary.goals) ? summary.goals : [];
          scoringPlays.forEach(goal => {
            const isPP = goal.power_play === '1' || goal.power_play === 1;
            const isSH = goal.short_handed === '1' || goal.short_handed === 1;

            if (String(goal.goal_scorer?.player_id) === playerIdStr) {
              if (isPP) ppGoals++;
              if (isSH) shGoals++;
            }

            if (String(goal.assist1_player?.player_id) === playerIdStr || String(goal.assist2_player?.player_id) === playerIdStr) {
              assists++;
              if (isPP) ppAssists++;
              if (isSH) shAssists++;
            }
          });

          const ppp = ppGoals + ppAssists;
          const shp = shGoals + shAssists;

          gameStats = { goals, assists, plusminus, ppp, shp, shots, blocks, hits };

          const matrix = scoring.skaters || defaultScoring.skaters;
          pts += goals * (matrix.goals || 0);
          pts += assists * (matrix.assists || 0);
          pts += plusminus * (matrix.plusMinus || 0);
          pts += ppp * (matrix.ppp || 0);
          pts += shp * (matrix.shp || 0);
          pts += shots * (matrix.sog || 0);
          pts += hits * (matrix.hits || 0);
          pts += blocks * (matrix.blocks || 0);

          if (pos === 'D' || pos === 'Defense') {
            pts += (goals + assists) * (matrix.defensePoints || 0);
          }
        }
      }

      if (participated) {
        const isHome = gameDoc.home_team_code === teamCode;
        const opponent = isHome ? gameDoc.visiting_team_code : gameDoc.home_team_code;
        const matchupLabel = isHome ? `vs ${opponent}` : `@ ${opponent}`;
        
        const myScore = parseInt(isHome ? gameDoc.home_goal_count : gameDoc.visiting_goal_count);
        const oppScore = parseInt(isHome ? gameDoc.visiting_goal_count : gameDoc.home_goal_count);

        let result = '';
        if (myScore > oppScore) {
          result = `W ${myScore}-${oppScore}`;
        } else if (myScore < oppScore) {
          if (gameDoc.overtime === '1' || gameDoc.shootout === '1') {
            result = `OTL ${myScore}-${oppScore}`;
          } else {
            result = `L ${myScore}-${oppScore}`;
          }
        } else {
          result = `T ${myScore}-${oppScore}`;
        }

        playerGames.push({
          gameId: gameDoc.game_id,
          date: gameDoc.date_played || gameDoc.date,
          dateWithDay: gameDoc.date_with_day || gameDoc.date_played,
          matchupLabel,
          result,
          stats: gameStats,
          points: Math.round(pts * 100) / 100,
          gameDate
        });
      }
    });

    playerGames.sort((a, b) => new Date(b.gameDate) - new Date(a.gameDate));
    return playerGames.slice(0, 5);
  } catch (error) {
    console.error("Error fetching player game history:", error);
    return [];
  }
}

const UPCOMING_SEASONS = [
  {
    season_id: "10",
    season_name: "2026-27 Preseason",
    shortname: "2026-27 Preseason",
    start_date: "2026-06-01",
    end_date: "2026-11-19",
    playoff: "0",
    career: "0"
  },
  {
    season_id: "11",
    season_name: "2026-27 Regular Season",
    shortname: "2026-27 Reg",
    start_date: "2026-11-20",
    end_date: "2027-04-26",
    playoff: "0",
    career: "1"
  },
  {
    season_id: "12",
    season_name: "2027 Playoffs",
    shortname: "2027 Playoffs",
    start_date: "2027-04-27",
    end_date: "2027-05-27",
    playoff: "1",
    career: "1"
  }
];

// 1. Sync Seasons
export async function syncSeasons() {
  const data = await fetchFromApi({ feed: 'modulekit', view: 'seasons' });
  const apiSeasons = data?.SiteKit?.Seasons || [];
  const seasons = [...apiSeasons, ...UPCOMING_SEASONS];
  
  const batch = writeBatch(db);
  seasons.forEach(season => {
    if (!season.season_id) return;
    const ref = doc(db, 'pwhl_seasons', season.season_id.toString());
    batch.set(ref, season, { merge: true });
  });
  
  await batch.commit();
  return seasons;
}

// 2. Sync Teams
export async function syncTeams(seasonId) {
  const data = await fetchFromApi({ feed: 'modulekit', view: 'teamsbyseason', season_id: seasonId });
  const teams = data?.SiteKit?.Teamsbyseason || [];

  const batch = writeBatch(db);
  teams.forEach(team => {
    if (!team.id) return;
    const ref = doc(db, 'pwhl_teams', `${seasonId}_${team.id}`);
    batch.set(ref, { ...team, season_id: seasonId }, { merge: true });
  });

  await batch.commit();
  return teams;
}

// 3. Sync Players & Rosters
export async function syncRoster(seasonId, teamId) {
  const data = await fetchFromApi({ feed: 'modulekit', view: 'roster', season_id: seasonId, team_id: teamId });
  const players = data?.SiteKit?.Roster || [];

  const batch = writeBatch(db);
  players.forEach(player => {
    const pId = player.player_id || player.id || player.person_id;
    if (!pId) return;
    const ref = doc(db, 'pwhl_players', `${seasonId}_${pId}`);
    batch.set(ref, { ...player, current_team_id: teamId, season_id: seasonId }, { merge: true });
  });

  await batch.commit();
  return players;
}

export function generateWeeksList(seasonStart, seasonEnd, games) {
  const startDate = new Date(seasonStart);
  const endDate = new Date(seasonEnd);
  
  // Find Monday of the week containing seasonStart
  const startDay = startDate.getDay(); // 0 is Sunday, 1 is Monday, etc.
  const diffToMonday = startDay === 0 ? -6 : 1 - startDay;
  const firstMonday = new Date(startDate);
  firstMonday.setDate(startDate.getDate() + diffToMonday);
  firstMonday.setHours(0, 0, 0, 0);
  
  const weeks = [];
  let currentMonday = new Date(firstMonday);
  let weekIndex = 1;
  
  while (currentMonday <= endDate) {
    const nextSunday = new Date(currentMonday);
    nextSunday.setDate(currentMonday.getDate() + 6);
    nextSunday.setHours(23, 59, 59, 999);
    
    // Check if there are games in this week range
    const gamesInWeek = games.filter(g => {
      const gDateStr = g.date_played || g.date;
      if (!gDateStr) return false;
      const gDate = new Date(gDateStr);
      return gDate >= currentMonday && gDate <= nextSunday;
    });
    
    weeks.push({
      week: weekIndex,
      start: currentMonday.toISOString(),
      end: nextSunday.toISOString(),
      gameCount: gamesInWeek.length,
      isOffWeek: gamesInWeek.length === 0,
      games: gamesInWeek.map(g => (g.game_id || g.id).toString())
    });
    
    // Move to next Monday
    currentMonday.setDate(currentMonday.getDate() + 7);
    weekIndex++;
  }
  return weeks;
}

// 4. Sync Schedule
export async function syncSchedule(seasonId, seasonDoc) {
  const data = await fetchFromApi({ feed: 'modulekit', view: 'schedule', season_id: seasonId });
  const games = data?.SiteKit?.Schedule || [];

  let count = 0;
  let currentBatch = writeBatch(db);

  for (const game of games) {
    if (!game.game_id) continue;
    const ref = doc(db, 'pwhl_games', game.game_id.toString());
    currentBatch.set(ref, { ...game, season_id: seasonId }, { merge: true });
    count++;

    if (count === 490) { 
      await currentBatch.commit();
      currentBatch = writeBatch(db);
      count = 0;
    }
  }

  if (count > 0) {
    await currentBatch.commit();
  }
  
  if (seasonDoc) {
    const weeks = generateWeeksList(seasonDoc.start_date, seasonDoc.end_date, games);
    const seasonRef = doc(db, 'pwhl_seasons', seasonId.toString());
    await writeBatch(db).set(seasonRef, { weeks }, { merge: true }).commit();
  }
  
  return games;
}

// 5. Sync Player Stats (Top Scorers & Top Goalies)
export async function syncPlayerStats(seasonId) {
  const skatersData = await fetchFromApi({ feed: 'modulekit', view: 'statviewtype', type: 'topscorers', season_id: seasonId, first: 0, limit: 500 });
  const skaters = skatersData?.SiteKit?.Statviewtype || [];

  const goaliesData = await fetchFromApi({ feed: 'modulekit', view: 'statviewtype', type: 'topgoalies', season_id: seasonId, first: 0, limit: 100 });
  const goalies = goaliesData?.SiteKit?.Statviewtype || [];

  const stats = [...skaters, ...goalies];

  let count = 0;
  let currentBatch = writeBatch(db);

  for (const stat of stats) {
    if (!stat.player_id) continue;
    const ref = doc(db, 'pwhl_player_stats', `${seasonId}_${stat.player_id}`);
    currentBatch.set(ref, { ...stat, season_id: seasonId }, { merge: true });
    count++;

    if (count === 490) {
      await currentBatch.commit();
      currentBatch = writeBatch(db);
      count = 0;
    }
  }

  if (count > 0) {
    await currentBatch.commit();
  }

  return stats;
}

export async function fetchGameSummary(gameId) {
  const data = await fetchFromApi({ feed: 'gc', tab: 'gamesummary', game_id: gameId, site_id: 0, lang: 'en' });
  return data?.GC?.Gamesummary || null;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export async function syncGameSummaries(seasonId, games, logCallback) {
  // Get existing summaries for this season from DB to avoid re-downloading Final games
  const q = query(collection(db, 'pwhl_game_summaries'), where('season_id', '==', seasonId));
  const snap = await getDocs(q);
  const existing = {};
  snap.forEach(d => {
    existing[d.id] = d.data();
  });

  // Filter games that need downloading (missing from DB, or not 'Final' in DB)
  const gamesToFetch = games.filter(g => {
    const dbCopy = existing[g.game_id.toString()];
    if (!dbCopy) return true; // Missing completely
    if (dbCopy.status_value !== '4') return true; // 4 = Final, if not 4, we need to update it
    return false; // We have it and it's final
  });

  if (gamesToFetch.length === 0) {
    if(logCallback) logCallback(`All game summaries up-to-date for season ${seasonId}.`);
    return;
  }

  if(logCallback) logCallback(`Fetching ${gamesToFetch.length} game summaries for season ${seasonId}...`);

  let currentBatch = writeBatch(db);
  let opCount = 0;

  for (const game of gamesToFetch) {
    try {
      await sleep(500); // Prevent rate limiting
      const summary = await fetchGameSummary(game.game_id);
      if (!summary) continue;

      const ref = doc(db, 'pwhl_game_summaries', game.game_id.toString());
      currentBatch.set(ref, { ...summary, season_id: seasonId, game_id: game.game_id }, { merge: true });
      opCount++;

      if (opCount === 500) {
        await currentBatch.commit();
        currentBatch = writeBatch(db);
        opCount = 0;
      }
    } catch (err) {
      console.error(`Failed to fetch game summary ${game.game_id}:`, err);
    }
  }

  if (opCount > 0) {
    await currentBatch.commit();
  }
}

export async function runFullSync(logCallback, targetSeasonId = 'all') {
  if(logCallback) logCallback("Fetching Seasons...");
  try {
    const seasons = await syncSeasons();
    
    for (const season of seasons) {
      if (!season.season_id) continue;
      const sId = season.season_id.toString();
      
      if (targetSeasonId !== 'all' && sId !== targetSeasonId.toString()) {
        continue;
      }
      
      if(logCallback) logCallback(`Fetching Data for Season: ${season.season_name}...`);
      
      try {
        await sleep(500); // Prevent rate limiting
        const teams = await syncTeams(sId);
        
        for (const team of teams) {
          if (!team.id) continue;
          await sleep(200);
          await syncRoster(sId, team.id);
        }
        
        await sleep(500);
        const games = await syncSchedule(sId, season);
        
        await sleep(500);
        await syncGameSummaries(sId, games, logCallback);
        
        await sleep(500);
        await syncPlayerStats(sId);
      } catch (err) {
        if(logCallback) logCallback(`Error syncing season ${season.season_name}: ${err.message}`);
        console.error(`Failed to sync season ${sId}:`, err);
        // Continue to the next season instead of aborting completely
      }
    }
    
    if(logCallback) logCallback("Sync Complete!");
    return "Success";
  } catch (err) {
    if(logCallback) logCallback(`Critical Error: ${err.message}`);
    throw err;
  }
}

export async function autoGenerateMissingWeeks() {
  try {
    const seasonsSnap = await getDocs(collection(db, 'pwhl_seasons'));
    let count = 0;
    for (const sDoc of seasonsSnap.docs) {
      const s = sDoc.data();
      if (!s.weeks || s.weeks.length === 0) {
        console.log(`Generating missing weeks for season ${s.season_id}...`);
        const q = query(
          collection(db, 'pwhl_games'), 
          where('season_id', 'in', [s.season_id.toString(), Number(s.season_id)])
        );
        const gSnap = await getDocs(q);
        const games = gSnap.docs.map(d => d.data());
        
        const weeks = generateWeeksList(s.start_date, s.end_date, games);
        const seasonRef = doc(db, 'pwhl_seasons', sDoc.id);
        const batch = writeBatch(db);
        batch.set(seasonRef, { weeks }, { merge: true });
        await batch.commit();
        count++;
      }
    }
    return count;
  } catch (err) {
    console.error("Failed to generate missing weeks:", err);
    throw err;
  }
}

/**
 * Fetches draft eligible players for a target draft season and attaches their
 * stats (projections for the active draft season, and actual stats for the previous season).
 * Distinguishes between projected stats and actual stats, and standardizes their structure.
 *
 * @param {string} draftSeasonId - The upcoming/current draft season (e.g. "8" for 25-26)
 * @param {string} selectedSeasonId - The season corresponding to the current toggle state (e.g. "8" or "5")
 * @returns {Promise<Array>} List of standardized player documents with nested stats
 */
export async function fetchDraftEligiblePlayers(draftSeasonId, selectedSeasonId) {
  // 1. Fetch seasons
  const seasonsSnap = await getDocs(collection(db, 'pwhl_seasons'));
  const seasons = seasonsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  // 2. Fetch players for the draft/current season
  const playersQuery = query(collection(db, 'pwhl_players'), where('season_id', 'in', [draftSeasonId, Number(draftSeasonId)]));
  const playersSnap = await getDocs(playersQuery);
  let resolvedSeasonId = draftSeasonId;
  let rawPlayers = playersSnap.docs.map(d => d.data());

  if (rawPlayers.length === 0 && seasons.length > 0) {
    const currentSeasonDoc = seasons.find(s => String(s.season_id) === String(draftSeasonId));
    const currentStartDate = currentSeasonDoc ? new Date(currentSeasonDoc.start_date) : new Date();

    const prevRegularSeasons = seasons.filter(s => {
      const isRegular = (s.playoff === '0' || s.playoff === 0) && (s.career === '1' || s.career === 1);
      const startsBefore = new Date(s.start_date) < currentStartDate;
      return isRegular && startsBefore;
    });

    if (prevRegularSeasons.length > 0) {
      prevRegularSeasons.sort((a, b) => new Date(b.start_date) - new Date(a.start_date));
      const prevRegSeason = prevRegularSeasons[0];
      resolvedSeasonId = prevRegSeason.season_id.toString();

      const prevPlayersQuery = query(collection(db, 'pwhl_players'), where('season_id', 'in', [resolvedSeasonId, Number(resolvedSeasonId)]));
      const prevPlayersSnap = await getDocs(prevPlayersQuery);
      rawPlayers = prevPlayersSnap.docs.map(d => d.data());
    }
  }

  // 3. Query and attach stats data based on selectedSeasonId
  let projList = [];
  let prevStats = [];

  if (String(selectedSeasonId) === String(draftSeasonId)) {
    // Query projected stats from pwhl_projections/{seasonId}/player_projections
    try {
      const projectionsSnap = await getDocs(collection(db, `pwhl_projections/${draftSeasonId}/player_projections`));
      projList = projectionsSnap.docs.map(d => d.data());
    } catch (err) {
      console.error("Error fetching projections:", err);
    }
  } else {
    // Query actual stats from pwhl_player_stats
    try {
      const prevStatsSnap = await getDocs(
        query(collection(db, 'pwhl_player_stats'), where('season_id', '==', String(selectedSeasonId)))
      );
      prevStats = prevStatsSnap.docs.map(d => d.data());
    } catch (err) {
      console.error("Error fetching actual stats:", err);
    }
  }

  return rawPlayers.map((p, idx) => {
    const pId = String(p.player_id || p.id || `p_${idx}`);
    const stats = {};

    if (String(selectedSeasonId) === String(draftSeasonId)) {
      // Attach projected stats
      const proj = projList.find(pr => String(pr.playerId) === pId);
      if (proj) {
        const projSeasonStats = proj.projected_season_stats || {};
        stats[selectedSeasonId] = {
          gamesPlayed: Number(projSeasonStats.gamesPlayed || 0),
          goals: Number(projSeasonStats.goals || 0),
          assists: Number(projSeasonStats.assists || 0),
          plusMinus: Number(projSeasonStats.plusMinus || 0),
          powerPlayPoints: Number(projSeasonStats.powerPlayPoints || 0),
          shortHandedPoints: Number(projSeasonStats.shortHandedPoints || 0),
          shotsOnGoal: Number(projSeasonStats.shotsOnGoal || 0),
          blockedShots: Number(projSeasonStats.blockedShots || 0),
          hits: Number(projSeasonStats.hits || 0),
          wins: Number(projSeasonStats.wins || 0),
          losses: Number(projSeasonStats.losses || 0),
          overtimeLosses: Number(projSeasonStats.overtimeLosses || projSeasonStats.otl || 0),
          goalsAgainst: Number(projSeasonStats.goalsAgainst || projSeasonStats.ga || 0),
          shotsSaved: Number(projSeasonStats.shotsSaved || projSeasonStats.saves || 0),
          shutouts: Number(projSeasonStats.shutouts || 0),
        };
      } else {
        stats[selectedSeasonId] = null;
      }
    } else {
      // Attach actual stats
      const lastSeason = prevStats.find(ps => String(ps.player_id) === pId);
      if (lastSeason) {
        stats[selectedSeasonId] = {
          gamesPlayed: Number(lastSeason.games_played || 0),
          goals: Number(lastSeason.goals || 0),
          assists: Number(lastSeason.assists || 0),
          plusMinus: Number(lastSeason.plus_minus || 0),
          powerPlayPoints: Number(lastSeason.power_play_points || 0),
          shortHandedPoints: Number(lastSeason.short_handed_points || 0),
          shotsOnGoal: Number(lastSeason.shots || lastSeason.shots_on || 0),
          blockedShots: Number(lastSeason.shots_blocked_by_player || 0),
          hits: Number(lastSeason.hits || 0),
          wins: Number(lastSeason.wins || 0),
          losses: Number(lastSeason.losses || lastSeason.loss || 0),
          overtimeLosses: Number(lastSeason.ot_loss || lastSeason.overtime_losses || 0),
          goalsAgainst: Number(lastSeason.goals_against || 0),
          shotsSaved: Number(lastSeason.saves || 0),
          shutouts: Number(lastSeason.shutouts || 0),
        };
      } else {
        stats[selectedSeasonId] = null;
      }
    }

    return {
      id: pId,
      name: `${p.first_name || ''} ${p.last_name || ''}`.trim(),
      pos: normalizePosition(p.position),
      teamId: String(p.current_team_id || p.latest_team_id || p.team_id || ''),
      jersey: p.jersey_number || '-',
      shoots: p.shoots || 'L',
      height: p.height || '-',
      birthDate: p.birth_date || '-',
      overallRank: String(selectedSeasonId) === String(draftSeasonId) ? (projList.find(pr => String(pr.playerId) === pId)?.overallRank !== undefined ? Number(projList.find(pr => String(pr.playerId) === pId).overallRank) : 999) : 999,
      stats
    };
  });
}
