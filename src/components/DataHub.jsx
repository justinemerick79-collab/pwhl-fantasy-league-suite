import React, { useState, useEffect } from 'react';
import { db } from '../firebase';
import { collection, query, where, getDocs, doc, getDoc, orderBy } from 'firebase/firestore';
import { fetchGameSummary } from '../services/pwhlService';
import { fetchAggregatedStats } from '../services/statsEngine';
import { useTimeTravel } from '../contexts/TimeTravelContext';

function GameSummaryDetail({ summary, getTeamName, isFutureGame }) {
  if (!summary) return null;

  if (isFutureGame) {
    return (
      <div style={{ padding: '24px', textAlign: 'center', background: 'var(--bg-surface-alt)' }}>
        <h4 style={{ color: 'var(--text-secondary)', margin: 0 }}>Game Has Not Started</h4>
        <p style={{ color: 'var(--text-tertiary)', fontSize: '0.85rem', margin: '4px 0 0 0' }}>Player stats will appear here live once the game begins.</p>
      </div>
    );
  }

  // Calculate power play assists for skaters dynamically from goals array
  const ppAssistsMap = {};
  const scoringPlays = Array.isArray(summary.goals) ? summary.goals : [];
  scoringPlays.forEach(goal => {
    const isPP = goal.power_play === '1' || goal.power_play === 1;
    if (isPP) {
      if (goal.assist1_player?.player_id) {
        ppAssistsMap[String(goal.assist1_player.player_id)] = (ppAssistsMap[String(goal.assist1_player.player_id)] || 0) + 1;
      }
      if (goal.assist2_player?.player_id) {
        ppAssistsMap[String(goal.assist2_player.player_id)] = (ppAssistsMap[String(goal.assist2_player.player_id)] || 0) + 1;
      }
    }
  });

  const renderTeamStats = (teamLineup, teamObj, isHome) => {
    // 1. Aggregate skaters by player_id
    const skaterMap = {};
    (teamLineup?.players || []).forEach(p => {
      const id = String(p.player_id);
      if (!skaterMap[id]) {
        skaterMap[id] = {
          ...p,
          goals: parseInt(p.goals || 0),
          assists: parseInt(p.assists || 0),
          pim: parseInt(p.pim || 0),
          shots_on: parseInt(p.shots_on || p.shots || 0),
          hits: parseInt(p.hits || 0),
          shots_blocked_by_player: parseInt(p.shots_blocked_by_player || p.shots_blocked || 0),
          power_play_goals: parseInt(p.power_play_goals || 0),
          short_handed_goals: parseInt(p.short_handed_goals || 0),
          faceoff_wins: parseInt(p.faceoff_wins || 0),
          faceoff_attempts: parseInt(p.faceoff_attempts || 0),
          plusminus: parseInt(p.plusminus || 0),
        };
      } else {
        const existing = skaterMap[id];
        existing.goals += parseInt(p.goals || 0);
        existing.assists += parseInt(p.assists || 0);
        existing.pim += parseInt(p.pim || 0);
        existing.shots_on += parseInt(p.shots_on || p.shots || 0);
        existing.hits += parseInt(p.hits || 0);
        existing.shots_blocked_by_player += parseInt(p.shots_blocked_by_player || p.shots_blocked || 0);
        existing.power_play_goals += parseInt(p.power_play_goals || 0);
        existing.short_handed_goals += parseInt(p.short_handed_goals || 0);
        existing.faceoff_wins += parseInt(p.faceoff_wins || 0);
        existing.faceoff_attempts += parseInt(p.faceoff_attempts || 0);
        existing.plusminus += parseInt(p.plusminus || 0);
      }
    });
    const skaters = Object.values(skaterMap);

    // 2. Aggregate goalies
    const rawGoalies = isHome ? (summary.goalies?.home || []) : (summary.goalies?.visitor || []);
    const goalieMap = {};
    rawGoalies.forEach(g => {
      const id = String(g.player_id);
      let secs = parseInt(g.seconds || g.secs || 0);
      if (!secs && g.secs_mmss && g.secs_mmss.includes(':')) {
        const [m, s] = g.secs_mmss.split(':').map(Number);
        secs = m * 60 + s;
      }

      if (!goalieMap[id]) {
        goalieMap[id] = {
          ...g,
          shots_against: parseInt(g.shots_against || 0),
          saves: parseInt(g.saves || 0),
          goals_against: parseInt(g.goals_against || 0),
          loss: parseInt(g.loss || 0),
          ot_loss: parseInt(g.ot_loss || 0),
          shootout_loss: parseInt(g.shootout_loss || 0),
          shutout: parseInt(g.shutout || 0),
          totalSeconds: secs,
        };
      } else {
        const existing = goalieMap[id];
        existing.shots_against += parseInt(g.shots_against || 0);
        existing.saves += parseInt(g.saves || 0);
        existing.goals_against += parseInt(g.goals_against || 0);
        existing.loss = Math.max(existing.loss, parseInt(g.loss || 0));
        existing.ot_loss = Math.max(existing.ot_loss, parseInt(g.ot_loss || 0));
        existing.shootout_loss = Math.max(existing.shootout_loss, parseInt(g.shootout_loss || 0));
        existing.shutout = Math.max(existing.shutout, parseInt(g.shutout || 0));
        existing.totalSeconds += secs;
      }
    });

    const goalies = Object.values(goalieMap).map(g => {
      const lineupGoalie = (teamLineup?.goalies || []).find(lg => String(lg.player_id) === String(g.player_id));
      const m = Math.floor(g.totalSeconds / 60);
      const s = g.totalSeconds % 60;
      return {
        ...g,
        jersey_number: lineupGoalie?.jersey_number || g.jersey_number || '-',
        toi_formatted: `${m}:${s.toString().padStart(2, '0')}`,
      };
    });

    return (
      <div style={{ marginBottom: '24px' }}>
        <h4 style={{ fontSize: '0.95rem', fontWeight: '700', marginBottom: '12px', color: 'var(--text-primary)' }}>
          {getTeamName(teamObj?.id || teamObj)} <span style={{ fontWeight: '400', color: 'var(--text-secondary)' }}>({isHome ? 'Home' : 'Visitor'})</span>
        </h4>
        
        <div className="data-table-wrapper" style={{ marginBottom: '16px' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Player</th>
                <th>Pos</th>
                <th>G</th>
                <th>A</th>
                <th>+/-</th>
                <th>PIM</th>
                <th>SOG</th>
                <th>Hits</th>
                <th>Blk</th>
                <th>PPG</th>
                <th>PPA</th>
                <th>SHG</th>
                <th>FOW</th>
                <th>FOA</th>
              </tr>
            </thead>
            <tbody>
              {skaters.map((p, idx) => {
                const ppa = ppAssistsMap[String(p.player_id)] || 0;
                return (
                  <tr key={`${p.player_id || p.id}_${idx}`}>
                    <td>{p.jersey_number}</td>
                    <td style={{ fontWeight: '600', whiteSpace: 'nowrap' }}>{p.first_name} {p.last_name}</td>
                    <td><span className="badge badge-neutral">{p.position_str}</span></td>
                    <td style={{ fontWeight: '700' }}>{p.goals}</td>
                    <td>{p.assists}</td>
                    <td>{p.plusminus > 0 ? `+${p.plusminus}` : p.plusminus}</td>
                    <td>{p.pim}</td>
                    <td>{p.shots_on || 0}</td>
                    <td>{p.hits || 0}</td>
                    <td>{p.shots_blocked_by_player || 0}</td>
                    <td>{p.power_play_goals || 0}</td>
                    <td>{ppa}</td>
                    <td>{p.short_handed_goals || 0}</td>
                    <td>{p.faceoff_wins || 0}</td>
                    <td>{p.faceoff_attempts || 0}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {goalies.length > 0 && (
          <div className="data-table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Goalie</th>
                  <th>TOI</th>
                  <th>SA</th>
                  <th>SV</th>
                  <th>GA</th>
                  <th>L</th>
                  <th>OTL</th>
                  <th>SOL</th>
                  <th>SO</th>
                </tr>
              </thead>
              <tbody>
                {goalies.map((g, idx) => (
                  <tr key={`${g.player_id || g.id}_${idx}`}>
                    <td>{g.jersey_number}</td>
                    <td style={{ fontWeight: '600', whiteSpace: 'nowrap' }}>{g.first_name} {g.last_name}</td>
                    <td>{g.toi_formatted}</td>
                    <td>{g.shots_against}</td>
                    <td>{g.saves}</td>
                    <td>{g.goals_against}</td>
                    <td>{g.loss || 0}</td>
                    <td>{g.ot_loss || 0}</td>
                    <td>{g.shootout_loss || 0}</td>
                    <td>{g.shutout || 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{ padding: '24px', background: 'var(--bg-surface-alt)', borderTop: '1px solid var(--border-primary)' }}>
      {renderTeamStats(summary.visitor_team_lineup, summary.visitor, false)}
      {renderTeamStats(summary.home_team_lineup, summary.home, true)}
    </div>
  );
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

export default function DataHub() {
  const { simulationState, leagueSimState, getSimulatedDate } = useTimeTravel();
  
  const [seasons, setSeasons] = useState([]);
  const [selectedSeason, setSelectedSeason] = useState(localStorage.getItem('pwhl_active_season') || '');
  
  const [activeTab, setActiveTab] = useState('players');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  
  const [teams, setTeams] = useState([]);
  const [players, setPlayers] = useState([]);
  const [games, setGames] = useState([]);
  const [stats, setStats] = useState([]);
  const [playerStats, setPlayerStats] = useState({ skaters: {}, goalies: {} });
  const [projections, setProjections] = useState([]);

  // Search & Filter State
  const [searchQuery, setSearchQuery] = useState('');
  const [teamFilter, setTeamFilter] = useState('all');
  const [posFilter, setPosFilter] = useState('all');

  // Game Expansion State
  const [expandedGameId, setExpandedGameId] = useState(null);
  const [gameSummaries, setGameSummaries] = useState({});

  // Helper to race getDocs with a timeout
  async function getDocsWithTimeout(colRef, timeoutMs = 5000) {
    return Promise.race([
      getDocs(colRef),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Connection timed out. Please refresh your browser window.")), timeoutMs)
      )
    ]);
  }

  // Fetch Seasons
  useEffect(() => {
    async function fetchSeasons() {
      try {
        const snap = await getDocsWithTimeout(collection(db, 'pwhl_seasons'), 5000);
        const seasonMap = new Map();
        snap.docs.forEach(d => {
          const s = { id: d.id, ...d.data() };
          const key = String(s.season_id || s.id);
          if (!seasonMap.has(key)) seasonMap.set(key, s);
        });
        const seasonList = Array.from(seasonMap.values());
        seasonList.sort((a, b) => new Date(b.start_date) - new Date(a.start_date));
        setSeasons(seasonList);
        
        if (seasonList.length > 0 && !selectedSeason) {
          const defaultS = seasonList.find(s => s.season_name?.includes('2025-26')) || seasonList[0];
          const sId = defaultS.season_id;
          setSelectedSeason(sId);
          localStorage.setItem('pwhl_active_season', sId);
        }
      } catch (err) {
        console.error("Error fetching seasons in DataHub:", err);
        setError('Failed to fetch seasons: ' + err.message);
      }
    }
    fetchSeasons();
  }, [selectedSeason]);

  // Sync selected season to local storage
  useEffect(() => {
    if (selectedSeason) {
      localStorage.setItem('pwhl_active_season', selectedSeason);
    }
  }, [selectedSeason]);

  // Fetch data based on selected season
  useEffect(() => {
    if (!selectedSeason) return;
    
    async function fetchData() {
      setLoading(true);
      setError('');
      try {
        const seasonIdStr = String(selectedSeason);
        const seasonIdNum = Number(selectedSeason);

        // Fetch Teams (with robust deduplication, city/code normalization, and TBD filtering)
        const teamQ = query(collection(db, 'pwhl_teams'), where('season_id', 'in', [seasonIdStr, seasonIdNum]));
        const teamSnap = await getDocsWithTimeout(teamQ, 5000);
        let rawTeams = teamSnap.docs.map(d => ({id: d.id, ...d.data()}));

        if (rawTeams.length === 0) {
          const fallbackTeamSnap = await getDocsWithTimeout(collection(db, 'pwhl_teams'), 5000);
          rawTeams = fallbackTeamSnap.docs.map(d => ({id: d.id, ...d.data()}));
        }

        const teamMap = new Map();
        rawTeams.forEach(t => {
          // Filter out TBD teams
          const name = String(t.name || '').toUpperCase();
          const city = String(t.city || '').toUpperCase();
          const code = String(t.code || '').toUpperCase();
          const idStr = String(t.team_id || t.id || '').toUpperCase();

          if (
            code === 'TBD' ||
            idStr === 'TBD' ||
            idStr === '0' ||
            name.includes('TBD') ||
            name.includes('TO BE DETERMINED') ||
            city.includes('TBD')
          ) {
            return;
          }

          const cityNorm = String(t.city || '')
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .toUpperCase()
            .trim();

          let key = code && code !== 'TBD' ? code : '';
          if (!key) {
            const numId = idStr.includes('_') ? idStr.split('_').pop() : idStr;
            if (numId && numId !== '0') key = `ID_${numId}`;
            else if (cityNorm) key = `CITY_${cityNorm}`;
            else key = name;
          }

          if (cityNorm === 'MONTREAL' || cityNorm === 'MONTRÉAL' || name.includes('MONTREAL') || name.includes('MONTRÉAL')) {
            key = 'MTL';
          } else if (cityNorm === 'BOSTON' || name.includes('BOSTON')) {
            key = 'BOS';
          } else if (cityNorm === 'MINNESOTA' || name.includes('MINNESOTA')) {
            key = 'MIN';
          } else if (cityNorm === 'NEW YORK' || name.includes('NEW YORK')) {
            key = 'NY';
          } else if (cityNorm === 'OTTAWA' || name.includes('OTTAWA')) {
            key = 'OTT';
          } else if (cityNorm === 'TORONTO' || name.includes('TORONTO')) {
            key = 'TOR';
          }

          const getScore = (item) => {
            let score = 0;
            if (item.team_logo_url) score += 10;
            const iName = String(item.name || '');
            if (iName && !iName.startsWith('PWHL ')) score += 20;
            if (item.code) score += 5;
            if (item.season_id) score += Number(item.season_id) || 0;
            return score;
          };

          if (!teamMap.has(key) || getScore(t) > getScore(teamMap.get(key))) {
            teamMap.set(key, t);
          }
        });

        const teamList = Array.from(teamMap.values());
        teamList.sort((a, b) => (a.city || a.name || '').localeCompare(b.city || b.name || ''));
        setTeams(teamList);

        // Fetch Players (with fallback to previous regular season if target season has 0 players)
        const playerQ = query(collection(db, 'pwhl_players'), where('season_id', 'in', [seasonIdStr, seasonIdNum]));
        const playerSnap = await getDocsWithTimeout(playerQ, 5000);
        let rawPlayers = playerSnap.docs.map(d => ({id: d.id, ...d.data()}));

        if (rawPlayers.length === 0) {
          const seasonsSnap = await getDocsWithTimeout(collection(db, 'pwhl_seasons'), 5000);
          const allSeasons = seasonsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
          const targetDoc = allSeasons.find(s => String(s.season_id) === seasonIdStr || s.id === seasonIdStr);
          const targetStart = targetDoc?.start_date ? new Date(targetDoc.start_date) : new Date();

          const prevSeasons = allSeasons.filter(s => {
            const isReg = (s.playoff === '0' || s.playoff === 0) && (s.career === '1' || s.career === 1);
            return isReg && s.start_date && new Date(s.start_date) < targetStart;
          }).sort((a, b) => new Date(b.start_date) - new Date(a.start_date));

          const prevSId = prevSeasons[0]?.season_id || prevSeasons[0]?.id;
          if (prevSId) {
            const prevPlayerQ = query(collection(db, 'pwhl_players'), where('season_id', 'in', [String(prevSId), Number(prevSId)]));
            const prevPlayerSnap = await getDocsWithTimeout(prevPlayerQ, 5000);
            rawPlayers = prevPlayerSnap.docs.map(d => ({id: d.id, ...d.data()}));
          }
        }

        const playerMap = new Map();
        rawPlayers.forEach(p => {
          const key = String(p.player_id || p.id?.split('_').pop() || p.id || '');
          if (!key) return;
          if (!playerMap.has(key)) playerMap.set(key, p);
        });
        const playerList = Array.from(playerMap.values());
        setPlayers(playerList);

        // Fetch Games
        const gameQ = query(collection(db, 'pwhl_games'), where('season_id', 'in', [seasonIdStr, seasonIdNum]));
        const gameSnap = await getDocsWithTimeout(gameQ, 5000);
        const rawGames = gameSnap.docs.map(d => ({id: d.id, ...d.data()}));
        const gameMap = new Map();
        rawGames.forEach(g => {
          const key = String(g.game_id || g.id || '');
          if (!key) return;
          if (!gameMap.has(key)) gameMap.set(key, g);
        });
        const gameList = Array.from(gameMap.values());
        gameList.sort((a, b) => new Date(a.date_played) - new Date(b.date_played));
        setGames(gameList);

        // Fetch Stats
        const statQ = query(collection(db, 'pwhl_player_stats'), where('season_id', 'in', [seasonIdStr, seasonIdNum]));
        const statSnap = await getDocsWithTimeout(statQ, 5000);
        const rawStats = statSnap.docs.map(d => ({id: d.id, ...d.data()}));
        const statMap = new Map();
        rawStats.forEach(s => {
          const key = String(s.player_id || s.id || '');
          if (!key) return;
          if (!statMap.has(key)) statMap.set(key, s);
        });
        const statList = Array.from(statMap.values());
        statList.sort((a, b) => parseInt(b.points || 0) - parseInt(a.points || 0));
        setStats(statList);
        
        // Fetch Aggregated Player Stats
        const simulatedDate = getSimulatedDate();
        const aggStats = await fetchAggregatedStats(seasonIdStr, simulatedDate);
        setPlayerStats(aggStats);

        // Fetch Projections
        try {
          const projSnap = await getDocsWithTimeout(
            collection(db, `pwhl_projections/${seasonIdStr}/player_projections`), 
            5000
          );
          let rawProj = projSnap.docs.map(d => ({ id: d.id, ...d.data() }));

          if (rawProj.length === 0) {
            const projQ = query(
              collection(db, 'pwhl_season_player_stats'), 
              where('seasonId', '==', seasonIdStr),
              where('leagueId', '==', 'global')
            );
            const fallbackSnap = await getDocsWithTimeout(projQ, 5000);
            rawProj = fallbackSnap.docs.map(d => ({ id: d.id, ...d.data() }));
          }

          const projMap = new Map();
          rawProj.forEach(p => {
            const key = String(p.playerId || p.player_id || p.id || '');
            if (!key) return;
            if (!projMap.has(key)) projMap.set(key, p);
          });
          const projList = Array.from(projMap.values());
          projList.sort((a, b) => {
            const scoreA = a.vorpScore ?? a.projectedFPP ?? a.fantasyPoints ?? 0;
            const scoreB = b.vorpScore ?? b.projectedFPP ?? b.fantasyPoints ?? 0;
            return scoreB - scoreA;
          });
          setProjections(projList);
        } catch (projErr) {
          console.warn("[DataHub] Could not load projections:", projErr);
          setProjections([]);
        }
        
      } catch (err) {
        console.error("Error fetching data in DataHub:", err);
        setError('Failed to fetch stats/teams data: ' + err.message);
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, [
    selectedSeason, 
    leagueSimState.isSimulation, 
    leagueSimState.simulatedDate, 
    simulationState.testModeActive, 
    simulationState.current_simulated_date
  ]);

  const toggleGame = async (gameId) => {
    if (expandedGameId === gameId) {
      setExpandedGameId(null);
    } else {
      setExpandedGameId(gameId);
      if (!gameSummaries[gameId]) {
        try {
          const docRef = doc(db, 'pwhl_game_summaries', gameId.toString());
          const docSnap = await getDoc(docRef);
          
          if (docSnap.exists()) {
            setGameSummaries(prev => ({ ...prev, [gameId]: docSnap.data() }));
          } else {
            const summary = await fetchGameSummary(gameId);
            setGameSummaries(prev => ({ ...prev, [gameId]: summary }));
          }
        } catch (err) {
          console.error("Failed to fetch game summary", err);
        }
      }
    }
  };

  const getTeamName = (teamId, playerId = null) => {
    let resolvedTeamId = teamId;
    
    // Fallback: look up teamId from players list if teamId is missing or unassigned
    if ((!resolvedTeamId || String(resolvedTeamId) === '0' || String(resolvedTeamId).toUpperCase() === 'TBD') && playerId) {
      const p = players.find(player => String(player.player_id || player.id || '').split('_').pop() === String(playerId));
      if (p) {
        resolvedTeamId = p.current_team_id || p.team_id || p.latest_team_id;
      }
    }

    if (!resolvedTeamId || String(resolvedTeamId) === '0' || String(resolvedTeamId).toUpperCase() === 'TBD') {
      return 'Free Agent';
    }

    const sId = String(resolvedTeamId).toUpperCase();
    const t = teams.find(t => 
      String(t.id) === String(resolvedTeamId) || 
      String(t.team_id) === String(resolvedTeamId) || 
      String(t.code || '').toUpperCase() === sId ||
      String(t.id?.split('_').pop()) === String(resolvedTeamId)
    );

    if (!t) return resolvedTeamId || 'Free Agent';
    return t.name || `${t.city || ''} ${t.name || ''}`.trim() || 'Free Agent';
  };

  const getTeamLogo = (teamId, playerId = null) => {
    let resolvedTeamId = teamId;
    if (!resolvedTeamId && playerId) {
      const p = players.find(player => String(player.player_id || player.id || '').split('_').pop() === String(playerId));
      if (p) resolvedTeamId = p.current_team_id || p.team_id || p.latest_team_id;
    }
    if (!resolvedTeamId || String(resolvedTeamId) === '0') return '';
    const sId = String(resolvedTeamId).toUpperCase();
    const t = teams.find(t => 
      String(t.id) === String(resolvedTeamId) || 
      String(t.team_id) === String(resolvedTeamId) || 
      String(t.code || '').toUpperCase() === sId ||
      String(t.id?.split('_').pop()) === String(resolvedTeamId)
    );
    return t ? t.team_logo_url || '' : '';
  };

  // Player Filtering
  const filteredPlayers = players.filter(p => {
    if (teamFilter !== 'all' && String(p.current_team_id) !== String(teamFilter)) return false;
    if (posFilter !== 'all' && p.position !== posFilter) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      const fullName = `${p.name || ''} ${p.first_name || ''} ${p.last_name || ''}`.toLowerCase();
      if (!fullName.includes(q)) return false;
    }
    return true;
  });

  const filteredStats = stats.filter(s => {
    if (teamFilter !== 'all' && String(s.team_id) !== String(teamFilter)) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      if (!(s.name || '').toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const filteredProjections = projections.filter(p => {
    if (teamFilter !== 'all' && String(p.teamId) !== String(teamFilter)) return false;
    if (posFilter !== 'all' && p.position !== posFilter) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      if (!(p.playerName || '').toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const simulatedDate = getSimulatedDate();
  const processedGames = games.map(g => {
    let gCopy = { ...g };
    const simActive = leagueSimState.isSimulation || simulationState.testModeActive;
    if (simActive) {
      const gDateStr = g.GameDateISO8601 || g.date_time_played || g.date_played || g.date;
      const getGameDatePSTStr = (dateStr) => {
        if (!dateStr) return '';
        const s = String(dateStr);
        if (s.length >= 10 && s.charAt(4) === '-' && s.charAt(7) === '-') {
          return s.slice(0, 10);
        }
        return getPSTDateStr(new Date(s));
      };
      
      const gamePST = getGameDatePSTStr(gDateStr);
      const simPST = getPSTDateStr(simulatedDate);
      
      if (gamePST > simPST) {
        gCopy.status = '1';
        gCopy.visiting_goal_count = '-';
        gCopy.home_goal_count = '-';
        gCopy.isFutureGame = true;
      } else {
        gCopy.status = '4';
        gCopy.isFutureGame = false;
        if (gCopy.visiting_goal_count === undefined || gCopy.visiting_goal_count === null) {
          gCopy.visiting_goal_count = '-';
        }
        if (gCopy.home_goal_count === undefined || gCopy.home_goal_count === null) {
          gCopy.home_goal_count = '-';
        }
      }
    }
    return gCopy;
  });

  const formatTOI = (totalSeconds) => {
    if (!totalSeconds) return '0:00';
    const m = Math.floor(totalSeconds / 60);
    const s = Math.round(totalSeconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const renderSkaterTable = (playersToRender) => (
    <div className="data-table-wrapper">
      <table className="data-table">
        <thead>
          <tr>
            <th>Player</th>
            <th>Team</th>
            <th>Pos</th>
            <th>GP</th>
            <th>G</th>
            <th>A</th>
            <th>PTS</th>
            <th>PIM</th>
            <th>+/-</th>
            <th>PPG</th>
            <th>PPA</th>
            <th>PPP</th>
            <th>SHG</th>
            <th>SHA</th>
            <th>SHP</th>
            <th>TOI</th>
            <th>ATOI</th>
          </tr>
        </thead>
        <tbody>
          {playersToRender.map((p, idx) => {
            const sId = String(p.player_id || p.id?.split('_').pop() || '');
            const s = playerStats.skaters[sId] || { 
              gamesPlayed: 0, goals: 0, assists: 0, powerPlayGoals: 0, powerPlayAssists: 0, powerPlayPoints: 0,
              shortHandedGoals: 0, shortHandedAssists: 0, shortHandedPoints: 0, timeOnIce: 0, averageTimeOnIce: 0,
              pim: 0, plusMinus: 0
            };
            return (
              <tr key={`${p.id || p.player_id}_${idx}`}>
                <td style={{ fontWeight: '600', whiteSpace: 'nowrap' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    {p.player_image ? (
                      <img src={p.player_image} alt={p.name} style={{ width: '32px', height: '32px', borderRadius: '50%', objectFit: 'cover' }} />
                    ) : (
                      <div style={{ width: '32px', height: '32px', borderRadius: '50%', background: 'var(--bg-surface-alt)', border: '1px solid var(--border-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem', fontWeight: '700', color: 'var(--text-secondary)' }}>
                        {(p.name || 'P').charAt(0)}
                      </div>
                    )}
                    {p.name}
                  </div>
                </td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    {getTeamLogo(p.current_team_id) && <img src={getTeamLogo(p.current_team_id)} alt="logo" width="20" height="20" />}
                    <span>{getTeamName(p.current_team_id)}</span>
                  </div>
                </td>
                <td><span className="badge badge-primary">{p.position}</span></td>
                <td>{s.gamesPlayed}</td>
                <td style={{ fontWeight: '700' }}>{s.goals}</td>
                <td>{s.assists}</td>
                <td style={{ fontWeight: '800', color: 'var(--accent-action)' }}>{s.goals + s.assists}</td>
                <td>{s.pim}</td>
                <td>{s.plusMinus > 0 ? `+${s.plusMinus}` : s.plusMinus}</td>
                <td>{s.powerPlayGoals}</td>
                <td>{s.powerPlayAssists}</td>
                <td>{s.powerPlayPoints}</td>
                <td>{s.shortHandedGoals}</td>
                <td>{s.shortHandedAssists}</td>
                <td>{s.shortHandedPoints}</td>
                <td>{formatTOI(s.timeOnIce)}</td>
                <td>{formatTOI(s.averageTimeOnIce)}</td>
              </tr>
            );
          })}
          {playersToRender.length === 0 && (
            <tr>
              <td colSpan="17" style={{ textAlign: 'center', padding: '32px', color: 'var(--text-tertiary)' }}>
                No skaters match your current filters.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );

  const renderGoalieTable = (playersToRender) => (
    <div className="data-table-wrapper">
      <table className="data-table">
        <thead>
          <tr>
            <th>Player</th>
            <th>Team</th>
            <th>Pos</th>
            <th>GP</th>
            <th>W</th>
            <th>L</th>
            <th>OTL</th>
            <th>SV</th>
            <th>GA</th>
            <th>TOI</th>
            <th>ATOI</th>
          </tr>
        </thead>
        <tbody>
          {playersToRender.map((p, idx) => {
            const sId = String(p.player_id || p.id?.split('_').pop() || '');
            const g = playerStats.goalies[sId] || { 
              gamesPlayed: 0, wins: 0, losses: 0, overtimeLosses: 0, shotsSaved: 0, goalsAgainst: 0,
              timeOnIce: 0, averageTimeOnIce: 0
            };
            return (
              <tr key={`${p.id || p.player_id}_${idx}`}>
                <td style={{ fontWeight: '600', whiteSpace: 'nowrap' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    {p.player_image ? (
                      <img src={p.player_image} alt={p.name} style={{ width: '32px', height: '32px', borderRadius: '50%', objectFit: 'cover' }} />
                    ) : (
                      <div style={{ width: '32px', height: '32px', borderRadius: '50%', background: 'var(--bg-surface-alt)', border: '1px solid var(--border-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem', fontWeight: '700', color: 'var(--text-secondary)' }}>
                        {(p.name || 'P').charAt(0)}
                      </div>
                    )}
                    {p.name}
                  </div>
                </td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    {getTeamLogo(p.current_team_id) && <img src={getTeamLogo(p.current_team_id)} alt="logo" width="20" height="20" />}
                    <span>{getTeamName(p.current_team_id)}</span>
                  </div>
                </td>
                <td><span className="badge badge-warning">{p.position}</span></td>
                <td>{g.gamesPlayed}</td>
                <td style={{ fontWeight: '700', color: 'var(--accent-action)' }}>{g.wins}</td>
                <td>{g.losses}</td>
                <td>{g.overtimeLosses}</td>
                <td>{g.shotsSaved}</td>
                <td>{g.goalsAgainst}</td>
                <td>{formatTOI(g.timeOnIce)}</td>
                <td>{formatTOI(g.averageTimeOnIce)}</td>
              </tr>
            );
          })}
          {playersToRender.length === 0 && (
            <tr>
              <td colSpan="11" style={{ textAlign: 'center', padding: '32px', color: 'var(--text-tertiary)' }}>
                No goalies match your current filters.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );

  if (error) {
    return (
      <div style={{ padding: '24px', background: 'rgba(220, 38, 38, 0.06)', border: '1px solid var(--accent-danger)', borderRadius: '12px', color: 'var(--accent-danger)' }}>
        <h4 style={{ margin: '0 0 4px 0', fontSize: '1rem', fontWeight: '700' }}>Error Loading Data Hub</h4>
        <p style={{ margin: 0, fontSize: '0.88rem' }}>{error}</p>
      </div>
    );
  }

  return (
    <div style={{ marginTop: '16px' }}>
      {/* Header Bar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '16px', marginBottom: '20px' }}>
        <div>
          <h2 style={{ fontSize: '1.4rem', fontWeight: '800', fontFamily: 'Outfit, sans-serif' }}>PWHL Data Hub</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.88rem' }}>Official stats, game logs, and fantasy projections for the PWHL.</p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span style={{ fontSize: '0.85rem', fontWeight: '600', color: 'var(--text-secondary)' }}>Season:</span>
          <select 
            className="input-field" 
            style={{ width: '220px', padding: '8px 12px' }}
            value={selectedSeason}
            onChange={(e) => setSelectedSeason(e.target.value)}
          >
            {seasons.map(s => (
              <option key={s.id} value={s.season_id}>
                {s.season_name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Tabs Bar */}
      <div className="tabs-navigation">
        <button className={`tab-btn ${activeTab === 'players' ? 'active' : ''}`} onClick={() => setActiveTab('players')}>
          👥 Players ({players.length})
        </button>
        <button className={`tab-btn ${activeTab === 'teams' ? 'active' : ''}`} onClick={() => setActiveTab('teams')}>
          🏆 Teams ({teams.length})
        </button>
        <button className={`tab-btn ${activeTab === 'games' ? 'active' : ''}`} onClick={() => setActiveTab('games')}>
          📅 Schedule ({games.length})
        </button>
        <button className={`tab-btn ${activeTab === 'stats' ? 'active' : ''}`} onClick={() => setActiveTab('stats')}>
          📈 Top Scorers
        </button>
        <button className={`tab-btn ${activeTab === 'projections' ? 'active' : ''}`} onClick={() => setActiveTab('projections')}>
          🔮 Projections & VORP
        </button>
        <button className={`tab-btn ${activeTab === 'seasons' ? 'active' : ''}`} onClick={() => setActiveTab('seasons')}>
          🗓️ Seasons & Weeks
        </button>
      </div>

      {loading ? (
        <div style={{ padding: '60px', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.95rem' }}>
          Loading PWHL Data Hub...
        </div>
      ) : (
        <>
          {/* PLAYERS TAB */}
          {activeTab === 'players' && (
            <div>
              <div className="filter-bar" style={{ borderRadius: '12px 12px 0 0', border: '1px solid var(--border-primary)', borderBottom: 'none' }}>
                <div className="search-input-wrapper">
                  <span className="search-icon">🔍</span>
                  <input 
                    type="text"
                    className="input-field"
                    placeholder="Search player name..."
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                  />
                </div>
                <select className="input-field" style={{ width: '180px' }} value={teamFilter} onChange={e => setTeamFilter(e.target.value)}>
                  <option value="all">All Teams</option>
                  {teams.map(t => <option key={t.id} value={t.id}>{t.city} {t.name}</option>)}
                </select>
                <select className="input-field" style={{ width: '160px' }} value={posFilter} onChange={e => setPosFilter(e.target.value)}>
                  <option value="all">All Positions</option>
                  <option value="F">Forwards</option>
                  <option value="D">Defense</option>
                  <option value="G">Goalies</option>
                </select>
              </div>

              {(posFilter === 'all' || posFilter === 'F' || posFilter === 'D') && (
                <div style={{ marginBottom: posFilter === 'all' ? '28px' : '0' }}>
                  {posFilter === 'all' && (
                    <div style={{ padding: '12px 20px', background: 'var(--bg-surface-alt)', border: '1px solid var(--border-primary)', borderBottom: 'none', fontWeight: '700', fontSize: '0.9rem' }}>
                      Skaters
                    </div>
                  )}
                  {renderSkaterTable(filteredPlayers.filter(p => p.position !== 'G'))}
                </div>
              )}

              {(posFilter === 'all' || posFilter === 'G') && (
                <div>
                  {posFilter === 'all' && (
                    <div style={{ padding: '12px 20px', background: 'var(--bg-surface-alt)', border: '1px solid var(--border-primary)', borderBottom: 'none', fontWeight: '700', fontSize: '0.9rem' }}>
                      Goalies
                    </div>
                  )}
                  {renderGoalieTable(filteredPlayers.filter(p => p.position === 'G'))}
                </div>
              )}
            </div>
          )}

          {/* TEAMS TAB */}
          {activeTab === 'teams' && (
            <div className="data-table-wrapper">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Logo</th>
                    <th>City</th>
                    <th>Team Name</th>
                    <th>Division</th>
                    <th>Team ID</th>
                  </tr>
                </thead>
                <tbody>
                  {teams.map(t => (
                    <tr key={t.id}>
                      <td>
                        {t.team_logo_url ? (
                          <img src={t.team_logo_url} alt={t.name} width="36" height="36" style={{ objectFit: 'contain' }} />
                        ) : (
                          <div style={{ width: '36px', height: '36px', borderRadius: '8px', background: 'var(--bg-surface-alt)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: '700', fontSize: '0.8rem' }}>
                            {t.name?.charAt(0)}
                          </div>
                        )}
                      </td>
                      <td style={{ fontWeight: '700' }}>{t.city}</td>
                      <td>{t.name}</td>
                      <td><span className="badge badge-neutral">{t.division || 'PWHL'}</span></td>
                      <td style={{ color: 'var(--text-tertiary)', fontSize: '0.8rem', fontFamily: 'monospace' }}>{t.id}</td>
                    </tr>
                  ))}
                  {teams.length === 0 && (
                    <tr>
                      <td colSpan="5" style={{ textAlign: 'center', padding: '32px', color: 'var(--text-tertiary)' }}>
                        No teams found for this season. Run Sync from Admin Controls.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          {/* SCHEDULE / GAMES TAB */}
          {activeTab === 'games' && (
            <div className="data-table-wrapper">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Date & Time</th>
                    <th>Status</th>
                    <th>Matchup</th>
                    <th>Score</th>
                    <th>Venue</th>
                  </tr>
                </thead>
                <tbody>
                  {processedGames.map(g => (
                    <React.Fragment key={g.id}>
                      <tr 
                        onClick={() => toggleGame(g.game_id)} 
                        style={{ cursor: 'pointer', background: expandedGameId === g.game_id ? 'var(--bg-surface-alt)' : '' }}
                      >
                        <td style={{ fontWeight: '500', whiteSpace: 'nowrap' }}>{g.date_played} {g.time}</td>
                        <td>
                          <span className={`badge ${g.status === '4' ? 'badge-success' : g.status === '1' ? 'badge-neutral' : 'badge-warning'}`}>
                            {g.status === '4' ? 'Final' : g.status === '1' ? 'Scheduled' : 'Live'}
                          </span>
                        </td>
                        <td style={{ fontWeight: '600' }}>
                          {getTeamName(g.visiting_team)} <span style={{ fontWeight: '400', color: 'var(--text-tertiary)' }}>@</span> {getTeamName(g.home_team)}
                        </td>
                        <td style={{ fontWeight: '700', color: g.status === '4' ? 'var(--text-primary)' : 'var(--text-tertiary)' }}>
                          {g.status === '4' || g.status === '3' ? `${g.visiting_goal_count} - ${g.home_goal_count}` : '-'}
                        </td>
                        <td style={{ color: 'var(--text-secondary)' }}>{g.venue_name || '-'}</td>
                      </tr>
                      {expandedGameId === g.game_id && (
                        <tr>
                          <td colSpan="5" style={{ padding: '0' }}>
                            {!gameSummaries[g.game_id] ? (
                              <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-secondary)' }}>Loading Box Score Details...</div>
                            ) : (
                              <GameSummaryDetail summary={gameSummaries[g.game_id]} getTeamName={getTeamName} isFutureGame={g.isFutureGame} />
                            )}
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                  {processedGames.length === 0 && (
                    <tr>
                      <td colSpan="5" style={{ textAlign: 'center', padding: '36px 16px', color: 'var(--text-tertiary)' }}>
                        <div style={{ fontSize: '1.2rem', marginBottom: '6px' }}>📅</div>
                        <div style={{ fontWeight: '600', color: 'var(--text-secondary)', marginBottom: '4px' }}>No Game Schedule Found</div>
                        <div style={{ fontSize: '0.85rem' }}>The official game schedule for this season has not been published by the PWHL yet.</div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          {/* TOP SCORERS TAB */}
          {activeTab === 'stats' && (
            <div>
              <div className="filter-bar" style={{ borderRadius: '12px 12px 0 0', border: '1px solid var(--border-primary)', borderBottom: 'none' }}>
                <div className="search-input-wrapper">
                  <span className="search-icon">🔍</span>
                  <input 
                    type="text"
                    className="input-field"
                    placeholder="Search player..."
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                  />
                </div>
                <select className="input-field" style={{ width: '200px' }} value={teamFilter} onChange={e => setTeamFilter(e.target.value)}>
                  <option value="all">All Teams</option>
                  {teams.map(t => <option key={t.id} value={t.id}>{t.city} {t.name}</option>)}
                </select>
              </div>

              <div className="data-table-wrapper" style={{ borderRadius: '0 0 12px 12px' }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Rank</th>
                      <th>Player</th>
                      <th>Team</th>
                      <th>GP</th>
                      <th>Goals</th>
                      <th>Assists</th>
                      <th>Points</th>
                      <th>PIM</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredStats.map((s, idx) => (
                      <tr key={s.id || idx}>
                        <td style={{ fontWeight: '700', color: 'var(--text-tertiary)', width: '60px' }}>#{idx + 1}</td>
                        <td style={{ fontWeight: '600' }}>{s.name}</td>
                        <td>{getTeamName(s.team_id)}</td>
                        <td>{s.games_played}</td>
                        <td>{s.goals}</td>
                        <td>{s.assists}</td>
                        <td style={{ fontWeight: '800', color: 'var(--accent-action)', fontSize: '0.95rem' }}>{s.points}</td>
                        <td>{s.penalty_minutes}</td>
                      </tr>
                    ))}
                    {filteredStats.length === 0 && (
                      <tr>
                        <td colSpan="8" style={{ textAlign: 'center', padding: '32px', color: 'var(--text-tertiary)' }}>
                          No stats record found.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* PROJECTIONS & VORP TAB */}
          {activeTab === 'projections' && (
            <div>
              <div className="filter-bar" style={{ borderRadius: '12px 12px 0 0', border: '1px solid var(--border-primary)', borderBottom: 'none' }}>
                <div className="search-input-wrapper">
                  <span className="search-icon">🔍</span>
                  <input 
                    type="text"
                    className="input-field"
                    placeholder="Search projected player..."
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                  />
                </div>
                <select className="input-field" style={{ width: '180px' }} value={teamFilter} onChange={e => setTeamFilter(e.target.value)}>
                  <option value="all">All Teams</option>
                  {teams.map(t => <option key={t.id} value={t.id}>{t.city} {t.name}</option>)}
                </select>
                <select className="input-field" style={{ width: '160px' }} value={posFilter} onChange={e => setPosFilter(e.target.value)}>
                  <option value="all">All Positions</option>
                  <option value="F">Forwards</option>
                  <option value="D">Defense</option>
                  <option value="G">Goalies</option>
                </select>
              </div>

              <div className="data-table-wrapper" style={{ borderRadius: '0 0 12px 12px' }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Rank</th>
                      <th>Player</th>
                      <th>Team</th>
                      <th>Pos</th>
                      <th>Projected FPTS</th>
                      <th>VORP Score</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredProjections.map((p, idx) => {
                      const fpts = p.projectedFPP ?? p.fantasyPoints;
                      return (
                        <tr key={`${p.id || p.playerId}_${idx}`}>
                          <td style={{ fontWeight: '700', color: 'var(--text-tertiary)', width: '60px' }}>#{p.overallRank || idx + 1}</td>
                          <td style={{ fontWeight: '600' }}>{p.playerName || p.name}</td>
                          <td>{getTeamName(p.teamId, p.playerId)}</td>
                          <td>
                            <span className={`badge ${p.position === 'D' ? 'badge-primary' : p.position === 'G' ? 'badge-warning' : 'badge-neutral'}`}>
                              {p.position}
                            </span>
                          </td>
                          <td style={{ fontWeight: '800', color: 'var(--accent-action)', fontSize: '0.95rem' }}>
                            {fpts != null ? Number(fpts).toFixed(2) : '-'}
                          </td>
                          <td style={{ fontWeight: '700', color: (p.vorpScore || 0) >= 0 ? 'var(--accent-success, #10B981)' : 'var(--text-tertiary)' }}>
                            {p.vorpScore != null ? (p.vorpScore >= 0 ? `+${Number(p.vorpScore).toFixed(2)}` : Number(p.vorpScore).toFixed(2)) : '-'}
                          </td>
                          <td>
                            <span className="badge badge-success">Computed</span>
                          </td>
                        </tr>
                      );
                    })}
                    {filteredProjections.length === 0 && (
                      <tr>
                        <td colSpan="7" style={{ textAlign: 'center', padding: '32px', color: 'var(--text-tertiary)' }}>
                          No projections generated yet for Season {selectedSeason}. Run "Generate Projections" in Admin Controls!
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* SEASONS & WEEKS TAB */}
          {activeTab === 'seasons' && (
            <div className="data-table-wrapper">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Season ID</th>
                    <th>Season Name</th>
                    <th>Start Date</th>
                    <th>End Date</th>
                    <th>Calendar Weeks</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {seasons.map(s => (
                    <tr key={s.id}>
                      <td style={{ fontWeight: '700', fontFamily: 'monospace' }}>{s.season_id}</td>
                      <td style={{ fontWeight: '600' }}>{s.season_name}</td>
                      <td>{s.start_date || '-'}</td>
                      <td>{s.end_date || '-'}</td>
                      <td>
                        <span className="badge badge-neutral">
                          {Array.isArray(s.calendarWeeks) ? `${s.calendarWeeks.length} Weeks` : 'Auto-Generated'}
                        </span>
                      </td>
                      <td>
                        {String(s.season_id) === String(selectedSeason) ? (
                          <span className="badge badge-success">Active View</span>
                        ) : (
                          <span className="badge badge-neutral">Archived</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
