import React, { useState, useEffect } from 'react';
import { db } from '../firebase';
import { collection, query, where, getDocs, doc, getDoc } from 'firebase/firestore';
import { fetchGameSummary } from '../services/pwhlService';
import { fetchAggregatedStats } from '../services/statsEngine';
import { useTimeTravel } from '../contexts/TimeTravelContext';


function GameSummaryDetail({ summary, getTeamName, isFutureGame }) {
  if (!summary) return null;

  if (isFutureGame) {
    return (
      <div style={{ padding: '24px', textAlign: 'center', background: 'rgba(0,0,0,0.3)' }}>
        <h3 style={{ color: 'var(--text-muted)' }}>Game has not started</h3>
        <p style={{ color: 'var(--text-muted)' }}>Player stats will appear here once the game begins.</p>
      </div>
    );
  }

  // 1. Calculate power play assists for skaters dynamically from goals array
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
    // 1. Aggregate skaters by player_id to handle duplicates
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
    
    // 2. Aggregate goalies by player_id from top-level summary.goalies to handle duplicates/stints
    const rawGoalies = isHome ? (summary.goalies?.home || []) : (summary.goalies?.visitor || []);
    const goalieMap = {};
    rawGoalies.forEach(g => {
      const id = String(g.player_id);
      
      // Calculate total seconds of stint
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
      
      // Re-format accumulated seconds back to MM:SS
      const m = Math.floor(g.totalSeconds / 60);
      const s = g.totalSeconds % 60;
      const formattedTOI = `${m}:${s.toString().padStart(2, '0')}`;

      return {
        ...g,
        jersey_number: lineupGoalie?.jersey_number || g.jersey_number || '-',
        toi_formatted: formattedTOI,
      };
    });

    return (
      <div style={{ marginBottom: '24px' }}>
        <h3 style={{ marginBottom: '12px' }}>{getTeamName(teamObj?.id || teamObj)} ({isHome ? 'Home' : 'Visitor'})</h3>
        
        <h4 style={{ color: 'var(--text-muted)', marginBottom: '8px', fontSize: '0.9rem' }}>Skaters</h4>
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table" style={{ background: 'rgba(0,0,0,0.4)', fontSize: '0.85rem' }}>
            <thead>
              <tr>
                <th>#</th>
                <th>Player</th>
                <th>Pos</th>
                <th>TOI</th>
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
              {skaters.map(p => {
                const ppa = ppAssistsMap[String(p.player_id)] || 0;
                return (
                  <tr key={p.player_id}>
                    <td>{p.jersey_number}</td>
                    <td style={{ fontWeight: '500', whiteSpace: 'nowrap' }}>{p.first_name} {p.last_name}</td>
                    <td>{p.position_str}</td>
                    <td>-</td>
                    <td>{p.goals}</td>
                    <td>{p.assists}</td>
                    <td>{p.plusminus}</td>
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
          <>
            <h4 style={{ color: 'var(--text-muted)', margin: '16px 0 8px 0', fontSize: '0.9rem' }}>Goalies</h4>
            <div style={{ overflowX: 'auto' }}>
              <table className="data-table" style={{ background: 'rgba(0,0,0,0.4)', fontSize: '0.85rem' }}>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Player</th>
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
                  {goalies.map(g => {
                    return (
                      <tr key={g.player_id}>
                        <td>{g.jersey_number}</td>
                        <td style={{ fontWeight: '500', whiteSpace: 'nowrap' }}>{g.first_name} {g.last_name}</td>
                        <td>{g.toi_formatted}</td>
                        <td>{g.shots_against}</td>
                        <td>{g.saves}</td>
                        <td>{g.goals_against}</td>
                        <td>{g.loss || 0}</td>
                        <td>{g.ot_loss || 0}</td>
                        <td>{g.shootout_loss || 0}</td>
                        <td>{g.shutout || 0}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    );
  };

  return (
    <div style={{ padding: '24px', background: 'rgba(0,0,0,0.3)', borderTop: '1px solid var(--border-color)', borderBottom: '1px solid var(--border-color)' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
        {renderTeamStats(summary.visitor_team_lineup, summary.visitor, false)}
        {renderTeamStats(summary.home_team_lineup, summary.home, true)}
      </div>
    </div>
  );
}

export default function DataHub() {
  const { timeTravelState, getSimulatedDate } = useTimeTravel();
  
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

  // Game Expansion State
  const [expandedGameId, setExpandedGameId] = useState(null);
  const [gameSummaries, setGameSummaries] = useState({});

  // Filters
  const [teamFilter, setTeamFilter] = useState('all');
  const [posFilter, setPosFilter] = useState('all');

  // Helper to race getDocs with a timeout to prevent hanging on cached emulator connections
  async function getDocsWithTimeout(colRef, timeoutMs = 5000) {
    return Promise.race([
      getDocs(colRef),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Connection timed out. This often happens if the browser is using a cached connection to a non-running Firestore emulator.")), timeoutMs)
      )
    ]);
  }

  // Fetch Seasons
  useEffect(() => {
    async function fetchSeasons() {
      try {
        const snap = await getDocsWithTimeout(collection(db, 'pwhl_seasons'), 5000);
        const seasonList = snap.docs.map(d => ({id: d.id, ...d.data()}));
        seasonList.sort((a, b) => new Date(b.start_date) - new Date(a.start_date));
        setSeasons(seasonList);
        
        if (seasonList.length > 0 && !selectedSeason) {
          // Default to 2025-26 season if possible
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

  // Sync selected season to local storage globally
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

        // Fetch Teams
        const teamQ = query(collection(db, 'pwhl_teams'), where('season_id', 'in', [seasonIdStr, seasonIdNum]));
        const teamSnap = await getDocsWithTimeout(teamQ, 5000);
        const teamList = teamSnap.docs.map(d => ({id: d.id, ...d.data()}));
        setTeams(teamList);

        // Fetch Players
        const playerQ = query(collection(db, 'pwhl_players'), where('season_id', 'in', [seasonIdStr, seasonIdNum]));
        const playerSnap = await getDocsWithTimeout(playerQ, 5000);
        const playerList = playerSnap.docs.map(d => ({id: d.id, ...d.data()}));
        setPlayers(playerList);

        // Fetch Games
        const gameQ = query(collection(db, 'pwhl_games'), where('season_id', 'in', [seasonIdStr, seasonIdNum]));
        const gameSnap = await getDocsWithTimeout(gameQ, 5000);
        const gameList = gameSnap.docs.map(d => ({id: d.id, ...d.data()}));
        gameList.sort((a, b) => new Date(a.date_played) - new Date(b.date_played));
        setGames(gameList);

        // Fetch Stats
        const statQ = query(collection(db, 'pwhl_player_stats'), where('season_id', 'in', [seasonIdStr, seasonIdNum]));
        const statSnap = await getDocsWithTimeout(statQ, 5000);
        const statList = statSnap.docs.map(d => ({id: d.id, ...d.data()}));
        statList.sort((a, b) => parseInt(b.points) - parseInt(a.points)); 
        setStats(statList);
        
        // Fetch comprehensive stats for Players Tab
        const simulatedDate = getSimulatedDate();
        console.log('[DataHub] Fetching aggregated stats for season:', seasonIdStr, 'cutoff:', simulatedDate);
        const aggStats = await fetchAggregatedStats(seasonIdStr, simulatedDate);
        console.log('[DataHub] Skaters aggregated:', Object.keys(aggStats.skaters).length, 'Goalies:', Object.keys(aggStats.goalies).length);
        setPlayerStats(aggStats);
        
      } catch (err) {
        console.error("Error fetching data in DataHub:", err);
        setError('Failed to fetch stats/teams data: ' + err.message);
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, [selectedSeason, timeTravelState?.enabled, timeTravelState?.date]);

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
            // Fallback to API if not yet synced to backend
            const summary = await fetchGameSummary(gameId);
            setGameSummaries(prev => ({ ...prev, [gameId]: summary }));
          }
        } catch (err) {
          console.error("Failed to fetch game summary", err);
        }
      }
    }
  };

  const getTeamName = (teamId) => {
    const t = teams.find(t => t.id === teamId);
    return t ? `${t.city} ${t.name}` : teamId;
  };

  const getTeamLogo = (teamId) => {
    const t = teams.find(t => t.id === teamId);
    return t ? t.team_logo_url : '';
  };

  const filteredPlayers = players.filter(p => {
    if (teamFilter !== 'all' && p.current_team_id !== teamFilter) return false;
    if (posFilter !== 'all' && p.position !== posFilter) return false;
    return true;
  });

  const filteredStats = stats.filter(s => {
    if (teamFilter !== 'all' && s.team_id !== teamFilter) return false;
    return true;
  });

  const simulatedDate = getSimulatedDate();
  const processedGames = games.map(g => {
    let gCopy = { ...g };
    if (timeTravelState?.enabled) {
      // Game date strings are usually "YYYY-MM-DD" in date_played
      const gDateStr = g.date_played ? g.date_played : g.date;
      const gDate = new Date(gDateStr);
      
      if (gDate >= simulatedDate) {
        gCopy.status = '1'; // Scheduled
        gCopy.visiting_goal_count = '-';
        gCopy.home_goal_count = '-';
        gCopy.isFutureGame = true;
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
        {playersToRender.map(p => {
          // player_id in game summaries matches roster's 'player_id' field (which is the raw API 'id')
          const sId = String(p.player_id || p.id?.split('_').pop() || '');
          const s = playerStats.skaters[sId] || { 
            gamesPlayed: 0, goals: 0, assists: 0, powerPlayGoals: 0, powerPlayAssists: 0, powerPlayPoints: 0,
            shortHandedGoals: 0, shortHandedAssists: 0, shortHandedPoints: 0, timeOnIce: 0, averageTimeOnIce: 0,
            pim: 0, plusMinus: 0
          };
          return (
            <tr key={p.id}>
              <td style={{ display: 'flex', alignItems: 'center', gap: '12px', fontWeight: '600' }}>
                {p.player_image && <img src={p.player_image} alt={p.name} style={{ width: '40px', height: '40px', borderRadius: '50%', objectFit: 'cover' }} />}
                {p.name}
              </td>
              <td>
                {getTeamLogo(p.current_team_id) && <img src={getTeamLogo(p.current_team_id)} alt="logo" width="24" style={{ verticalAlign: 'middle', marginRight: '8px' }} />}
                {getTeamName(p.current_team_id)}
              </td>
              <td><span className="pill pill-primary">{p.position}</span></td>
              <td>{s.gamesPlayed}</td>
              <td>{s.goals}</td>
              <td>{s.assists}</td>
              <td style={{ fontWeight: 'bold' }}>{s.goals + s.assists}</td>
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
      </tbody>
    </table>
  );

  const renderGoalieTable = (playersToRender) => (
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
        {playersToRender.map(p => {
          const sId = String(p.player_id || p.id?.split('_').pop() || '');
          const g = playerStats.goalies[sId] || { 
            gamesPlayed: 0, wins: 0, losses: 0, overtimeLosses: 0, shotsSaved: 0, goalsAgainst: 0,
            timeOnIce: 0, averageTimeOnIce: 0
          };
          return (
            <tr key={p.id}>
              <td style={{ display: 'flex', alignItems: 'center', gap: '12px', fontWeight: '600' }}>
                {p.player_image && <img src={p.player_image} alt={p.name} style={{ width: '40px', height: '40px', borderRadius: '50%', objectFit: 'cover' }} />}
                {p.name}
              </td>
              <td>
                {getTeamLogo(p.current_team_id) && <img src={getTeamLogo(p.current_team_id)} alt="logo" width="24" style={{ verticalAlign: 'middle', marginRight: '8px' }} />}
                {getTeamName(p.current_team_id)}
              </td>
              <td><span className="pill pill-secondary">{p.position}</span></td>
              <td>{g.gamesPlayed}</td>
              <td>{g.wins}</td>
              <td>{g.losses}</td>
              <td>{g.overtimeLosses}</td>
              <td>{g.shotsSaved}</td>
              <td>{g.goalsAgainst}</td>
              <td>{formatTOI(g.timeOnIce)}</td>
              <td>{formatTOI(g.averageTimeOnIce)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  if (error) {
    return (
      <div style={{ marginTop: '48px', padding: '24px', background: 'rgba(255, 0, 0, 0.1)', border: '1px solid rgba(255, 0, 0, 0.2)', borderRadius: '8px', color: '#ff7675' }}>
        <h3 style={{ margin: '0 0 8px 0' }}>Error Loading Data Hub</h3>
        <p style={{ margin: 0, fontSize: '0.9rem' }}>{error}</p>
      </div>
    );
  }

  if (seasons.length === 0) return <div>No season data found. Run Sync from Admin Panel.</div>;

  return (
    <div style={{ marginTop: '48px' }}>
      <header className="dashboard-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1>Data Hub</h1>
          <p>Explore official PWHL statistics and rosters.</p>
        </div>
        <select 
          className="input-field" 
          style={{ width: '300px', fontSize: '1.1rem', background: 'rgba(255,255,255,0.1)' }}
          value={selectedSeason}
          onChange={(e) => setSelectedSeason(e.target.value)}
        >
          {seasons.map(s => (
            <option key={s.id} value={s.season_id} style={{ color: '#000' }}>
              {s.season_name}
            </option>
          ))}
        </select>
      </header>

      <div className="tabs">
        <button className={`tab ${activeTab === 'teams' ? 'active' : ''}`} onClick={() => setActiveTab('teams')}>Teams</button>
        <button className={`tab ${activeTab === 'players' ? 'active' : ''}`} onClick={() => setActiveTab('players')}>Players</button>
        <button className={`tab ${activeTab === 'games' ? 'active' : ''}`} onClick={() => setActiveTab('games')}>Schedule</button>
        <button className={`tab ${activeTab === 'stats' ? 'active' : ''}`} onClick={() => setActiveTab('stats')}>Top Scorers</button>
      </div>

      <div className="glass-panel" style={{ padding: '0', overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: '40px', textAlign: 'center' }}>Loading Data...</div>
        ) : (
          <>
            {/* TEAMS TAB */}
            {activeTab === 'teams' && (
              <div style={{ overflowX: 'auto' }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Logo</th>
                      <th>City</th>
                      <th>Name</th>
                      <th>Division</th>
                    </tr>
                  </thead>
                  <tbody>
                    {teams.map(t => (
                      <tr key={t.id}>
                        <td>{t.team_logo_url && <img src={t.team_logo_url} alt={t.name} width="40" />}</td>
                        <td style={{ fontWeight: '600' }}>{t.city}</td>
                        <td>{t.name}</td>
                        <td>{t.division}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* PLAYERS TAB */}
            {activeTab === 'players' && (
              <div style={{ padding: '24px' }}>
                <div className="filter-group">
                  <select className="input-field" style={{ width: '200px' }} value={teamFilter} onChange={e => setTeamFilter(e.target.value)}>
                    <option value="all" style={{ color: '#000' }}>All Teams</option>
                    {teams.map(t => <option key={t.id} value={t.id} style={{ color: '#000' }}>{t.city} {t.name}</option>)}
                  </select>
                  <select className="input-field" style={{ width: '200px' }} value={posFilter} onChange={e => setPosFilter(e.target.value)}>
                    <option value="all" style={{ color: '#000' }}>All Positions</option>
                    <option value="F" style={{ color: '#000' }}>Forwards</option>
                    <option value="D" style={{ color: '#000' }}>Defense</option>
                    <option value="G" style={{ color: '#000' }}>Goalies</option>
                  </select>
                </div>
                
                <div style={{ overflowX: 'auto', margin: '-24px', marginTop: '0' }}>
                  {(posFilter === 'all' || posFilter === 'F' || posFilter === 'D') && (
                    <div style={{ marginBottom: posFilter === 'all' ? '48px' : '0' }}>
                      {posFilter === 'all' && <h3 style={{ padding: '24px 24px 16px', margin: 0, borderBottom: '1px solid var(--border-color)', background: 'rgba(0,0,0,0.2)' }}>Skaters</h3>}
                      {renderSkaterTable(filteredPlayers.filter(p => p.position !== 'G'))}
                    </div>
                  )}
                  {(posFilter === 'all' || posFilter === 'G') && (
                    <div>
                      {posFilter === 'all' && <h3 style={{ padding: '24px 24px 16px', margin: 0, borderBottom: '1px solid var(--border-color)', background: 'rgba(0,0,0,0.2)' }}>Goalies</h3>}
                      {renderGoalieTable(filteredPlayers.filter(p => p.position === 'G'))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* GAMES TAB */}
            {activeTab === 'games' && (
              <div style={{ overflowX: 'auto' }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Date</th>
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
                          style={{ cursor: 'pointer', background: expandedGameId === g.game_id ? 'rgba(255,255,255,0.05)' : '' }}
                        >
                          <td>{g.date_played} {g.time}</td>
                          <td><span className="pill pill-primary">{g.status === '4' ? 'Final' : g.status === '1' ? 'Scheduled' : 'Live'}</span></td>
                          <td>
                            {getTeamName(g.visiting_team)} @ {getTeamName(g.home_team)}
                          </td>
                          <td style={{ fontWeight: 'bold' }}>
                            {g.status === '4' || g.status === '3' ? `${g.visiting_goal_count} - ${g.home_goal_count}` : '-'}
                          </td>
                          <td>{g.venue_name}</td>
                        </tr>
                        {expandedGameId === g.game_id && (
                          <tr style={{ background: 'rgba(0,0,0,0.2)' }}>
                            <td colSpan="5" style={{ padding: '0' }}>
                              {!gameSummaries[g.game_id] ? (
                                <div style={{ padding: '24px', textAlign: 'center' }}>Loading Game Summary...</div>
                              ) : (
                                <GameSummaryDetail summary={gameSummaries[g.game_id]} getTeamName={getTeamName} isFutureGame={g.isFutureGame} />
                              )}
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* STATS TAB */}
            {activeTab === 'stats' && (
               <div style={{ padding: '24px' }}>
                 <div className="filter-group">
                   <select className="input-field" style={{ width: '200px' }} value={teamFilter} onChange={e => setTeamFilter(e.target.value)}>
                     <option value="all" style={{ color: '#000' }}>All Teams</option>
                     {teams.map(t => <option key={t.id} value={t.id} style={{ color: '#000' }}>{t.city} {t.name}</option>)}
                   </select>
                 </div>
                 
                 <div style={{ overflowX: 'auto', margin: '-24px', marginTop: '0' }}>
                   <table className="data-table">
                     <thead>
                       <tr>
                         <th>Player</th>
                         <th>Team</th>
                         <th>GP</th>
                         <th>G</th>
                         <th>A</th>
                         <th>PTS</th>
                         <th>PIM</th>
                       </tr>
                     </thead>
                     <tbody>
                       {filteredStats.map(s => (
                         <tr key={s.id}>
                           <td style={{ fontWeight: '600' }}>{s.name}</td>
                           <td>{getTeamName(s.team_id)}</td>
                           <td>{s.games_played}</td>
                           <td>{s.goals}</td>
                           <td>{s.assists}</td>
                           <td style={{ fontWeight: 'bold', color: 'var(--primary-color)' }}>{s.points}</td>
                           <td>{s.penalty_minutes}</td>
                         </tr>
                       ))}
                     </tbody>
                   </table>
                 </div>
               </div>
            )}
            
          </>
        )}
      </div>
    </div>
  );
}
