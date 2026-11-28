import { db } from '../firebase.js';
import { rankLineFromProjection, rankLineFromSeasonStats } from './scoring';
import { doc, writeBatch, collection, getDocs, query, where, getDoc } from 'firebase/firestore';

export const normalizePosition = (posStr) => {
  if (!posStr) return 'F';
  const up = String(posStr).toUpperCase().trim();
  if (
    ['F', 'FORWARD', 'FORWARDS', 'C', 'CENTER', 'CENTRE', 'LW', 'LEFT WING', 'LEFTWING', 'RW', 'RIGHT WING', 'RIGHTWING'].includes(up) ||
    up.includes('WING') ||
    up.includes('FORWARD') ||
    up.includes('CENTER') ||
    up.includes('CENTRE')
  ) {
    return 'F';
  }
  if (
    ['D', 'RD', 'LD', 'DEFENSE', 'DEFENCE', 'DEFENDER', 'DEFENDERS', 'DEFENSEMAN', 'DEFENSEMEN', 'DEFENSMAN', 'RIGHT DEFENSE', 'RIGHT DEFENCE', 'LEFT DEFENSE', 'LEFT DEFENCE'].includes(up) ||
    up.includes('DEFENSE') ||
    up.includes('DEFENCE') ||
    up.includes('DEFENDER') ||
    up.includes('DEFENSEMAN') ||
    up.includes('DEFENSEMEN')
  ) {
    return 'D';
  }
  if (
    ['G', 'GOALIE', 'GOALIES', 'GOALTENDER', 'GOALTENDERS'].includes(up) ||
    up.includes('GOAL')
  ) {
    return 'G';
  }
  return 'F';
};

/**
 * The one rule for which season's player pool ("universe") a reader uses.
 *
 * A season that has players uses its own pool. A season with no players yet
 * (an upcoming season before its rosters are synced) uses the most recent
 * regular season (playoff '0', career '1') that starts before it. If none
 * qualifies, the season itself is returned and the pool stays empty.
 *
 * The server keeps a copy of this rule in functions/universeSeason.js — keep
 * the two in step; test-season-pool.js checks both.
 *
 * @param {string|number} seasonId - The season the caller asked for.
 * @param {Array<object>} seasons - pwhl_seasons docs ({ season_id, start_date, playoff, career }).
 * @param {boolean} hasPlayers - Whether pwhl_players has any doc for seasonId.
 * @returns {{ seasonId: string, isFallback: boolean }}
 */
export function resolveUniverseSeason(seasonId, seasons, hasPlayers) {
  const target = String(seasonId);
  if (hasPlayers || !Array.isArray(seasons) || seasons.length === 0) {
    return { seasonId: target, isFallback: false };
  }
  const idOf = (s) => String(s.season_id ?? s.id);
  const targetDoc = seasons.find(s => idOf(s) === target);
  const targetStart = targetDoc?.start_date ? new Date(targetDoc.start_date) : new Date();

  const prevRegular = seasons
    .filter(s => {
      const isRegular = (s.playoff === '0' || s.playoff === 0) && (s.career === '1' || s.career === 1);
      return isRegular && idOf(s) !== target && s.start_date && new Date(s.start_date) < targetStart;
    })
    .sort((a, b) => new Date(b.start_date) - new Date(a.start_date));

  if (prevRegular.length === 0) return { seasonId: target, isFallback: false };
  return { seasonId: idOf(prevRegular[0]), isFallback: true };
}

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

  // BASE_URL is relative and reaches the PWHL feed through the Vite dev-server
  // proxy (see vite.config.js). Firebase Hosting rewrites ** -> /index.html and
  // has no /api rule, so on the deployed site this request is answered with the
  // SPA's own HTML. Detect that here and say so, instead of failing further down
  // with an opaque "Unexpected token '<'" from JSON.parse.
  if (text.trimStart().startsWith('<')) {
    throw new Error(
      "PWHL feed unavailable: this request was answered with the app's own HTML rather than feed data. " +
      "The feed is reachable only through the Vite dev-server proxy, so syncing from the deployed site " +
      "is not supported — run the app locally with `npm run dev` to sync. Scheduled ingestion on the " +
      "deployed site runs server-side via the syncDailyData Cloud Function."
    );
  }

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
function getPSTDateStr(date) {
  if (!date) return '';
  const d = typeof date === 'string' ? new Date(date) : date;
  try {
    return new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(d);
  } catch (e) {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
}

function getGameDatePSTStr(gDateStr) {
  if (!gDateStr) return '';
  const s = String(gDateStr);
  if (s.length >= 10 && s.charAt(4) === '-' && s.charAt(7) === '-') {
    return s.slice(0, 10);
  }
  return getPSTDateStr(new Date(s));
}

async function checkIsSimulation() {
  try {
    const simDoc = await getDoc(doc(db, "admin_settings", "simulation_state"));
    if (simDoc.exists() && simDoc.data().testModeActive) {
      return true;
    }
    const activeLeagueId = localStorage.getItem('pwhl_active_league');
    if (activeLeagueId) {
      const leagueDoc = await getDoc(doc(db, 'fantasy_leagues', activeLeagueId));
      if (leagueDoc.exists() && leagueDoc.data().isSimulation) {
        return true;
      }
    }
  } catch (e) {
    console.warn("[PwhlService] Error checking simulation state:", e);
  }
  return false;
}

export async function fetchPlayerGameHistory(playerId, pos, teamCode, seasonId, simulatedDate, scoringSettings) {
  try {
    const gamesQuery = query(collection(db, 'pwhl_games'), where('season_id', 'in', [String(seasonId), Number(seasonId)]));
    const gamesSnap = await getDocs(gamesQuery);
    const gamesList = gamesSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    const summariesQuery = query(collection(db, 'pwhl_game_summaries'), where('season_id', 'in', [String(seasonId), Number(seasonId)]));
    const summariesSnap = await getDocs(summariesQuery);
    const gameSummariesList = summariesSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    const cutoff = simulatedDate ? new Date(simulatedDate) : new Date();
    if (simulatedDate) {
      cutoff.setHours(23, 59, 59, 999);
    }
    const isGoalie = pos === 'G';
    const playerIdStr = String(playerId);
    const defaultScoring = {
      skaters: { goals: 2, assists: 1, plusMinus: 0.5, ppp: 0.5, shp: 0.5, sog: 0.1, hits: 0.1, blocks: 0.5, defensePoints: 0.5 },
      goalies: { wins: 4, otl: 1, ga: -2, saves: 0.2, shutouts: 3 }
    };
    const scoring = scoringSettings || defaultScoring;

    const playerGames = [];

    const isSimulation = await checkIsSimulation();

    gameSummariesList.forEach(summary => {
      const gameDoc = gamesList.find(g => String(g.game_id) === String(summary.id));
      if (!gameDoc) return;

      let isFinal = gameDoc.status === '4' || gameDoc.status === '3';

      const gDateStr = gameDoc.date_played || gameDoc.date;
      if (!gDateStr) return;
      const gameDate = new Date(gDateStr);

      if (isSimulation) {
        const gamePST = getGameDatePSTStr(gDateStr);
        const simPST = getPSTDateStr(simulatedDate || new Date());
        if (gamePST <= simPST) {
          isFinal = true;
        }
      }

      if (!isFinal) return;
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

        let result;
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


// Fantasy weeks run Monday 00:00 to Sunday 23:59:59.999 Pacific time (league days
// are PST-based). Games are assigned by their calendar date string, never by
// `new Date('YYYY-MM-DD')`, which is midnight UTC and moved Monday games into the
// previous week. Must match functions/seasonWeeks.js#buildSeasonWeeks, which the
// daily server sync uses; keep the two in step.
const PACIFIC_HOUR = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: '2-digit', hourCycle: 'h23' });

function pacificMidnightMs(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  for (const offsetHours of [8, 7]) {
    const ms = Date.UTC(y, m - 1, d, offsetHours);
    if (Number(PACIFIC_HOUR.format(new Date(ms))) === 0) return ms;
  }
  throw new Error(`Cannot resolve Pacific midnight for ${dateStr}`);
}

function addDaysStr(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function mondayOfStr(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return addDaysStr(dateStr, dow === 0 ? -6 : 1 - dow);
}

export function generateWeeksList(seasonStart, seasonEnd, games) {
  const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v);
  if (!isDate(seasonStart) || !isDate(seasonEnd)) return [];
  const endDay = seasonEnd.slice(0, 10);
  const gameDay = (g) => {
    const raw = g.date_played || g.GameDateISO8601 || g.date || '';
    return isDate(raw) ? raw.slice(0, 10) : null;
  };

  const weeks = [];
  for (let monday = mondayOfStr(seasonStart.slice(0, 10)), n = 1; monday <= endDay; monday = addDaysStr(monday, 7), n++) {
    const sunday = addDaysStr(monday, 6);
    const gamesInWeek = games.filter(g => {
      const d = gameDay(g);
      return d && d >= monday && d <= sunday;
    });
    weeks.push({
      week: n,
      start: new Date(pacificMidnightMs(monday)).toISOString(),
      end: new Date(pacificMidnightMs(addDaysStr(monday, 7)) - 1).toISOString(),
      gameCount: gamesInWeek.length,
      isOffWeek: gamesInWeek.length === 0,
      games: gamesInWeek.map(g => (g.game_id || g.id).toString())
    });
  }
  return weeks;
}

export async function fetchGameSummary(gameId) {
  const data = await fetchFromApi({ feed: 'gc', tab: 'gamesummary', game_id: gameId, site_id: 0, lang: 'en' });
  return data?.GC?.Gamesummary || null;
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
  let rawPlayers = playersSnap.docs.map(d => d.data());

  const universe = resolveUniverseSeason(draftSeasonId, seasons, rawPlayers.length > 0);
  if (universe.isFallback) {
    const prevPlayersQuery = query(collection(db, 'pwhl_players'), where('season_id', 'in', [universe.seasonId, Number(universe.seasonId)]));
    const prevPlayersSnap = await getDocs(prevPlayersQuery);
    rawPlayers = prevPlayersSnap.docs.map(d => d.data());
  }

  // Draft value for auto-pick (src/services/scoring.js#projectedPoints): always for the
  // DRAFT season, whatever the on-screen view: projection, else last regular season.
  const rankLines = {};
  try {
    const projSnap = await getDocs(collection(db, `pwhl_projections/${draftSeasonId}/player_projections`));
    projSnap.forEach(d => { rankLines[String(d.data().playerId || d.id)] = { line: rankLineFromProjection(d.data().projected_season_stats), source: 'projection' }; });
    const target = seasons.find(se => String(se.season_id) === String(draftSeasonId));
    const prev = seasons
      .filter(se => String(se.career) === '1' && String(se.playoff) === '0' && Date.parse(se.start_date) < Date.parse(target?.start_date))
      .sort((a, b) => Date.parse(b.start_date) - Date.parse(a.start_date))[0];
    if (prev) {
      const prevSnap = await getDocs(query(collection(db, 'pwhl_player_stats'), where('season_id', 'in', [String(prev.season_id), Number(prev.season_id)])));
      prevSnap.forEach(d => { const pid = String(d.data().player_id); if (!rankLines[pid]) rankLines[pid] = { line: rankLineFromSeasonStats(d.data()), source: 'last_season' }; });
    }
  } catch (err) {
    console.error("Error loading draft values:", err);
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
      rankLine: rankLines[pId]?.line || null,
      rankSource: rankLines[pId]?.source || 'none',
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

export async function generateSeasonProjectionsClient(seasonIdStr) {
  if (!seasonIdStr) throw new Error("Missing seasonId parameter.");

  const seasonSnap = await getDocs(query(collection(db, 'pwhl_seasons'), where('season_id', 'in', [seasonIdStr, Number(seasonIdStr)])));
  if (seasonSnap.empty) throw new Error(`Season ${seasonIdStr} not found.`);
  
  const targetSeason = seasonSnap.docs[0].data();
  const startDateStr = targetSeason.start_date;
  if (!startDateStr) throw new Error(`Season ${seasonIdStr} is missing start_date.`);
  const targetSeasonStart = new Date(startDateStr);
  const gamesPerTeam = 30;

  const allSeasonsSnap = await getDocs(collection(db, 'pwhl_seasons'));
  const historicalSeasonIds = [];
  const prevRegularSeasons = [];

  allSeasonsSnap.forEach(sDoc => {
    const s = sDoc.data();
    const sId = String(s.season_id);
    if (sId !== String(seasonIdStr) && s.start_date) {
      const sStart = new Date(s.start_date);
      if (sStart < targetSeasonStart) {
        historicalSeasonIds.push(sId);
        const isRegular = (s.playoff === '0' || s.playoff === 0) && (s.career === '1' || s.career === 1);
        if (isRegular) {
          prevRegularSeasons.push({ id: sId, startDate: sStart });
        }
      }
    }
  });

  prevRegularSeasons.sort((a, b) => b.startDate - a.startDate);
  const prevSeasonId = prevRegularSeasons[0]?.id || "5";

  const playerHistory = {};
  if (historicalSeasonIds.length > 0) {
    const statsSnap = await getDocs(query(collection(db, 'pwhl_player_stats'), where('season_id', 'in', historicalSeasonIds)));
    statsSnap.forEach(docSnap => {
      const docData = docSnap.data();
      const pId = String(docData.player_id || docData.id || '');
      const sId = String(docData.season_id || '');
      if (!pId || !sId) return;

      if (!playerHistory[pId]) playerHistory[pId] = {};

      playerHistory[pId][sId] = {
        seasonId: sId,
        position: docData.position || "F",
        stats: {
          gamesPlayed: Number(docData.games_played || 0),
          goals: Number(docData.goals || 0),
          assists: Number(docData.assists || 0),
          plusMinus: Number(docData.plus_minus || 0),
          powerPlayGoals: Number(docData.power_play_goals || 0),
          powerPlayAssists: Number(docData.power_play_assists || 0),
          powerPlayPoints: Number(docData.power_play_points || 0),
          shortHandedGoals: Number(docData.short_handed_goals || 0),
          shortHandedAssists: Number(docData.short_handed_assists || 0),
          shortHandedPoints: Number(docData.short_handed_points || 0),
          pim: Number(docData.penalty_minutes || docData.pim || 0),
          shotsOnGoal: Number(docData.shots || docData.shots_on || 0),
          blockedShots: Number(docData.shots_blocked_by_player || 0),
          hits: Number(docData.hits || 0),
          timeOnIce: Number(docData.ice_time || 0),
          wins: Number(docData.wins || 0),
          losses: Number(docData.losses || docData.loss || 0),
          overtimeLosses: Number(docData.ot_loss || docData.overtime_losses || 0),
          goalsAgainst: Number(docData.goals_against || 0),
          shotsSaved: Number(docData.saves || 0),
          shutouts: Number(docData.shutouts || 0),
        }
      };
    });
  }

  let playersSnap = await getDocs(query(collection(db, 'pwhl_players'), where('season_id', 'in', [seasonIdStr, Number(seasonIdStr)])));
  let allPlayers = playersSnap.docs.map(d => ({ id: d.id, data: d.data() }));

  const universe = resolveUniverseSeason(
    seasonIdStr,
    allSeasonsSnap.docs.map(d => ({ id: d.id, ...d.data() })),
    allPlayers.length > 0
  );
  if (universe.isFallback) {
    console.log(`[Projections Client] Season ${seasonIdStr} has 0 rostered players. Falling back to previous regular season ${universe.seasonId} player pool...`);
    const prevPlayersSnap = await getDocs(query(collection(db, 'pwhl_players'), where('season_id', 'in', [universe.seasonId, Number(universe.seasonId)])));
    allPlayers = prevPlayersSnap.docs.map(d => ({ id: d.id, data: d.data() }));
  }

  if (allPlayers.length === 0) {
    throw new Error("No player roster records found in database.");
  }

  const goalieWeights = {};
  const goalieTeams = {};
  const teamGoalieWeights = {};

  for (const playerDoc of allPlayers) {
    const pData = playerDoc.data;
    const playerId = String(pData.player_id || pData.id || playerDoc.id.split("_")[1] || playerDoc.id);
    if (!playerId) continue;

    const rawPosition = String(pData.position || pData.pos || "F").trim().toUpperCase();
    if (rawPosition.startsWith("G") || rawPosition.includes("GOALIE")) {
      const teamId = String(pData.team_id || pData.current_team_id || pData.latest_team_id || "FA");
      const gpLast = playerHistory[playerId]?.[prevSeasonId]?.stats?.gamesPlayed || 0;
      const weight = Math.max(gpLast, 6);

      goalieWeights[playerId] = weight;
      goalieTeams[playerId] = teamId;
      teamGoalieWeights[teamId] = (teamGoalieWeights[teamId] || 0) + weight;
    }
  }

  const defaultScoring = {
    skaters: { goals: 2, assists: 1, plusMinus: 0.5, ppp: 0.5, shp: 0.5, sog: 0.1, hits: 0.1, blocks: 0.5, defensePoints: 0.5 },
    goalies: { wins: 4, otl: 1, ga: -2, saves: 0.2, shutouts: 3 }
  };

  const playerProjections = [];

  for (const playerDoc of allPlayers) {
    const pData = playerDoc.data;
    const playerId = String(pData.player_id || pData.id || playerDoc.id.split("_")[1] || playerDoc.id);
    if (!playerId) continue;

    const rawPosition = String(pData.position || pData.pos || "F").trim().toUpperCase();
    let position = "F";
    if (rawPosition.startsWith("G") || rawPosition.includes("GOALIE")) position = "G";
    else if (rawPosition.startsWith("D") || rawPosition.includes("DEFENSE") || rawPosition.includes("DEFENCE") || rawPosition === "LD" || rawPosition === "RD") position = "D";

    const name = pData.name || `${pData.first_name || ""} ${pData.last_name || ""}`.trim() || "Unknown Player";

    const history = playerHistory[playerId] || {};
    const validSeasons = Object.values(history).filter(h => h.stats && h.stats.gamesPlayed >= 5);
    validSeasons.sort((a, b) => new Date(allSeasonsSnap.docs.find(d => d.id === b.seasonId)?.data()?.start_date || 0) - new Date(allSeasonsSnap.docs.find(d => d.id === a.seasonId)?.data()?.start_date || 0));

    const s1 = validSeasons[0];
    const s2 = validSeasons[1];

    let goalsRate = 0, assistsRate = 0, plusMinusRate = 0, powerPlayGoalsRate = 0, powerPlayAssistsRate = 0, powerPlayPointsRate = 0;
    let shortHandedGoalsRate = 0, shortHandedAssistsRate = 0, shortHandedPointsRate = 0, pimRate = 0, shotsOnGoalRate = 0, blockedShotsRate = 0, hitsRate = 0, timeOnIceRate;
    let winsRate = 0, lossesRate = 0, overtimeLossesRate = 0, shotsSavedRate = 0, goalsAgainstRate = 0, shutoutsRate = 0;

    const isVeteran = validSeasons.length > 0;
    let expectedGamesPlayed = 30;

    if (isVeteran) {
      const getWeightedRate = (metric) => {
        if (s1 && s2) {
          const r1 = (s1.stats[metric] || 0) / s1.stats.gamesPlayed;
          const r2 = (s2.stats[metric] || 0) / s2.stats.gamesPlayed;
          return (0.5 * r1 + 0.3 * r2) / 0.8;
        } else {
          return (s1.stats[metric] || 0) / s1.stats.gamesPlayed;
        }
      };

      if (position === "G") {
        winsRate = getWeightedRate("wins");
        lossesRate = getWeightedRate("losses");
        overtimeLossesRate = getWeightedRate("overtimeLosses");
        shotsSavedRate = getWeightedRate("shotsSaved");
        goalsAgainstRate = getWeightedRate("goalsAgainst");
        shutoutsRate = getWeightedRate("shutouts");
        timeOnIceRate = getWeightedRate("timeOnIce");
      } else {
        goalsRate = getWeightedRate("goals");
        assistsRate = getWeightedRate("assists");
        plusMinusRate = getWeightedRate("plusMinus");
        powerPlayGoalsRate = getWeightedRate("powerPlayGoals");
        powerPlayAssistsRate = getWeightedRate("powerPlayAssists");
        powerPlayPointsRate = getWeightedRate("powerPlayPoints");
        shortHandedGoalsRate = getWeightedRate("shortHandedGoals");
        shortHandedAssistsRate = getWeightedRate("shortHandedAssists");
        shortHandedPointsRate = getWeightedRate("shortHandedPoints");
        pimRate = getWeightedRate("pim");
        shotsOnGoalRate = getWeightedRate("shotsOnGoal");
        blockedShotsRate = getWeightedRate("blockedShots");
        hitsRate = getWeightedRate("hits");
        timeOnIceRate = getWeightedRate("timeOnIce");
      }
    } else {
      if (position === "G") {
        winsRate = 0.40; lossesRate = 0.50; overtimeLossesRate = 0.10;
        shotsSavedRate = 25.3; goalsAgainstRate = 2.70; shutoutsRate = 0.03;
        timeOnIceRate = 3600;
      } else {
        goalsRate = 0.25; assistsRate = 0.35; pimRate = 0.4; shotsOnGoalRate = 1.5; blockedShotsRate = 0.4; hitsRate = 0.6;
        powerPlayPointsRate = 0.05; timeOnIceRate = 850;
      }
    }

    if (position === "G") {
      const teamId = goalieTeams[playerId] || "FA";
      const totalWeight = teamGoalieWeights[teamId] || 6;
      const myWeight = goalieWeights[playerId] || 6;
      expectedGamesPlayed = 30 * (myWeight / totalWeight);
    }

    expectedGamesPlayed = Math.max(0, Math.min(expectedGamesPlayed, gamesPerTeam));

    let projected_season_stats;
    let projectedFPP;

    if (position === "G") {
      projected_season_stats = {
        gamesPlayed: Math.round(expectedGamesPlayed),
        wins: Math.round(winsRate * expectedGamesPlayed * 100) / 100,
        losses: Math.round(lossesRate * expectedGamesPlayed * 100) / 100,
        overtimeLosses: Math.round(overtimeLossesRate * expectedGamesPlayed * 100) / 100,
        shotsSaved: Math.round(shotsSavedRate * expectedGamesPlayed * 100) / 100,
        goalsAgainst: Math.round(goalsAgainstRate * expectedGamesPlayed * 100) / 100,
        shutouts: Math.round(shutoutsRate * expectedGamesPlayed * 100) / 100,
        timeOnIce: Math.round(timeOnIceRate * expectedGamesPlayed)
      };

      const matrix = defaultScoring.goalies;
      let fPoints = 0;
      fPoints += projected_season_stats.wins * matrix.wins;
      fPoints += projected_season_stats.overtimeLosses * matrix.otl;
      fPoints += projected_season_stats.goalsAgainst * matrix.ga;
      fPoints += projected_season_stats.shotsSaved * matrix.saves;
      fPoints += projected_season_stats.shutouts * matrix.shutouts;
      projectedFPP = Math.round(fPoints * 100) / 100;
    } else {
      projected_season_stats = {
        gamesPlayed: Math.round(expectedGamesPlayed),
        goals: Math.round(goalsRate * expectedGamesPlayed * 100) / 100,
        assists: Math.round(assistsRate * expectedGamesPlayed * 100) / 100,
        plusMinus: Math.round(plusMinusRate * expectedGamesPlayed * 100) / 100,
        powerPlayGoals: Math.round(powerPlayGoalsRate * expectedGamesPlayed * 100) / 100,
        powerPlayAssists: Math.round(powerPlayAssistsRate * expectedGamesPlayed * 100) / 100,
        powerPlayPoints: Math.round(powerPlayPointsRate * expectedGamesPlayed * 100) / 100,
        shortHandedGoals: Math.round(shortHandedGoalsRate * expectedGamesPlayed * 100) / 100,
        shortHandedAssists: Math.round(shortHandedAssistsRate * expectedGamesPlayed * 100) / 100,
        shortHandedPoints: Math.round(shortHandedPointsRate * expectedGamesPlayed * 100) / 100,
        pim: Math.round(pimRate * expectedGamesPlayed * 100) / 100,
        shotsOnGoal: Math.round(shotsOnGoalRate * expectedGamesPlayed * 100) / 100,
        blockedShots: Math.round(blockedShotsRate * expectedGamesPlayed * 100) / 100,
        hits: Math.round(hitsRate * expectedGamesPlayed * 100) / 100,
        timeOnIce: Math.round(timeOnIceRate * expectedGamesPlayed)
      };

      const matrix = defaultScoring.skaters;
      let fPoints = 0;
      fPoints += projected_season_stats.goals * matrix.goals;
      fPoints += projected_season_stats.assists * matrix.assists;
      fPoints += projected_season_stats.plusMinus * matrix.plusMinus;
      const ppp = projected_season_stats.powerPlayPoints || (projected_season_stats.powerPlayGoals + projected_season_stats.powerPlayAssists);
      fPoints += ppp * matrix.ppp;
      const shp = projected_season_stats.shortHandedPoints || (projected_season_stats.shortHandedGoals + projected_season_stats.shortHandedAssists);
      fPoints += shp * matrix.shp;
      fPoints += projected_season_stats.shotsOnGoal * matrix.sog;
      fPoints += projected_season_stats.hits * matrix.hits;
      fPoints += projected_season_stats.blockedShots * matrix.blocks;

      if (position === "D" || position === "Defense") {
        fPoints += (projected_season_stats.goals + projected_season_stats.assists) * matrix.defensePoints;
      }
      projectedFPP = Math.round(fPoints * 100) / 100;
    }

    playerProjections.push({
      playerId: String(playerId),
      playerName: name,
      position: position,
      teamId: String(pData.team_id || pData.current_team_id || pData.latest_team_id || ''),
      seasonId: seasonIdStr,
      expectedGamesPlayed: Math.round(expectedGamesPlayed * 100) / 100,
      projected_season_stats: projected_season_stats,
      projectedFPP: projectedFPP
    });
  }

  const forwardsList = playerProjections.filter(p => p.position === 'F');
  const defensemenList = playerProjections.filter(p => p.position === 'D');
  const goaliesList = playerProjections.filter(p => p.position === 'G');

  forwardsList.sort((a, b) => b.projectedFPP - a.projectedFPP);
  defensemenList.sort((a, b) => b.projectedFPP - a.projectedFPP);
  goaliesList.sort((a, b) => b.projectedFPP - a.projectedFPP);

  const forwardBaseline = forwardsList[Math.min(36, forwardsList.length - 1)]?.projectedFPP || 0;
  const defenseBaseline = defensemenList[Math.min(24, defensemenList.length - 1)]?.projectedFPP || 0;
  const goalieBaseline = goaliesList[Math.min(6, goaliesList.length - 1)]?.projectedFPP || 0;

  for (const p of playerProjections) {
    let baseline = p.position === 'F' ? forwardBaseline : p.position === 'D' ? defenseBaseline : goalieBaseline;
    p.vorpScore = Math.round((p.projectedFPP - baseline) * 100) / 100;
  }

  playerProjections.sort((a, b) => b.vorpScore - a.vorpScore);
  playerProjections.forEach((p, idx) => { p.overallRank = idx + 1; });
  forwardsList.forEach((p, idx) => { p.positionalRank = idx + 1; });
  defensemenList.forEach((p, idx) => { p.positionalRank = idx + 1; });
  goaliesList.forEach((p, idx) => { p.positionalRank = idx + 1; });

  let currentBatch = writeBatch(db);
  let writeCount = 0;

  for (const p of playerProjections) {
    const docRef = doc(db, 'pwhl_projections', seasonIdStr, 'player_projections', p.playerId);
    currentBatch.set(docRef, {
      playerId: p.playerId,
      playerName: p.playerName,
      position: p.position,
      seasonId: p.seasonId,
      teamId: p.teamId,
      expectedGamesPlayed: p.expectedGamesPlayed,
      projected_season_stats: p.projected_season_stats,
      projectedFPP: p.projectedFPP,
      vorpScore: p.vorpScore,
      overallRank: p.overallRank,
      positionalRank: p.positionalRank
    }, { merge: true });

    const globalRef = doc(db, 'pwhl_season_player_stats', `${seasonIdStr}_global_${p.playerId}`);
    currentBatch.set(globalRef, {
      seasonId: seasonIdStr,
      leagueId: 'global',
      playerId: p.playerId,
      playerName: p.playerName,
      teamId: p.teamId,
      position: p.position,
      stats: p.projected_season_stats,
      fantasyPoints: p.projectedFPP
    }, { merge: true });

    writeCount += 2;
    if (writeCount >= 450) {
      await currentBatch.commit();
      currentBatch = writeBatch(db);
      writeCount = 0;
    }
  }

  if (writeCount > 0) {
    await currentBatch.commit();
  }

  return {
    success: true,
    processedCount: playerProjections.length,
    baselines: { forward: forwardBaseline, defense: defenseBaseline, goalie: goalieBaseline }
  };
}

