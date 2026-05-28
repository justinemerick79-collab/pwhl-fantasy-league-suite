import { db } from '../firebase';
import { doc, writeBatch, collection, getDocs, query, where } from 'firebase/firestore';

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

// 1. Sync Seasons
export async function syncSeasons() {
  const data = await fetchFromApi({ feed: 'modulekit', view: 'seasons' });
  const seasons = data?.SiteKit?.Seasons || [];
  
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

// 4. Sync Schedule
export async function syncSchedule(seasonId) {
  const data = await fetchFromApi({ feed: 'modulekit', view: 'schedule', season_id: seasonId });
  const games = data?.SiteKit?.Schedule || [];

  let count = 0;
  let currentBatch = writeBatch(db);

  for (const game of games) {
    if (!game.game_id) continue;
    const ref = doc(db, 'pwhl_games', game.game_id.toString());
    currentBatch.set(ref, game, { merge: true });
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
  
  return games;
}

// 5. Sync Player Stats (Top Scorers for simplicity)
export async function syncPlayerStats(seasonId) {
  const data = await fetchFromApi({ feed: 'modulekit', view: 'statviewtype', type: 'topscorers', season_id: seasonId, first: 0, limit: 500 });
  const stats = data?.SiteKit?.Statviewtype || [];

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
        const games = await syncSchedule(sId);
        
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
