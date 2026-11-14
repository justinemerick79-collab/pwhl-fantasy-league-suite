import React, { useState, useEffect } from 'react';
import { 
  Trophy, Users, Calendar, Zap, RotateCw, LogOut, Shield, Activity, 
  ChevronDown, User, Check, Copy, Plus, Ticket, Play, ArrowRight, Search, SlidersHorizontal, Layers, Filter, UserPlus, UserMinus, UserCheck, ArrowUpDown, Clock, Lock, AlertTriangle, ArrowRightLeft
} from 'lucide-react';
import { db } from '../firebase.js';
import { doc, getDoc, collection, query, where, getDocs } from 'firebase/firestore';
import { useAuth } from '../contexts/AuthContext';
import { useTimeTravel } from '../contexts/TimeTravelContext';
import { useData } from '../contexts/DataContext';
import PlayerCardModal from './PlayerCardModal';
import { fetchAggregatedStats } from '../services/statsEngine';
import { submitAddDrop, submitWaiverClaim } from '../services/leagueService.js';
import { normalizePosition } from '../services/pwhlService.js';

export default function Players({ activeLeagueId, onProposeTrade }) {
  const { currentUser } = useAuth();
  const { simulationState, leagueSimState, getSimulatedDate, activeSeasonId } = useTimeTravel();
  const { seasons, seasonsLoading, seasonCache, loadingStates, loadSeasonData } = useData();
  const seasonId = activeSeasonId ? String(activeSeasonId) : '5';

  useEffect(() => {
    if (seasonId && !seasonsLoading) {
      loadSeasonData(seasonId);
    }
  }, [seasonId, seasonsLoading, loadSeasonData]);

  const activeSeasonData = seasonCache[seasonId] || {
    playersList: [],
    pwhlTeams: {},
    projectionsList: [],
    gamesList: [],
    resolvedSeasonId: seasonId,
    isFallbackUniverse: false
  };

  const {
    playersList,
    pwhlTeams,
    projectionsList,
    gamesList,
    resolvedSeasonId,
    isFallbackUniverse
  } = activeSeasonData;

  const seasonDataLoading = loadingStates[seasonId] === true;
  
  // Search & Filter state
  const [searchQuery, setSearchQuery] = useState('');
  const [filterPosition, setFilterPosition] = useState('all');
  const [filterTeam, setFilterTeam] = useState('all');
  const [filterAvailability, setFilterAvailability] = useState('all');

  // Active database loader states
  const [loading, setLoading] = useState(true);
  const [loadingLeague, setLoadingLeague] = useState(true);
  const [teamsList, setTeamsList] = useState([]);
  const [myTeam, setMyTeam] = useState(null);
  const [leagueData, setLeagueData] = useState(null);
  const [transactionLoading, setTransactionLoading] = useState(false);
  const [waiverPlayerIds, setWaiverPlayerIds] = useState(new Set());

  // Dynamic player stats data
  const [statsData, setStatsData] = useState({ skaters: {}, goalies: {} });

  // Sorting state
  const [sortColumn, setSortColumn] = useState('points');
  const [sortDirection, setSortDirection] = useState('desc');

  // Modal active state for Add/Drop trigger
  const [selectedScoutPlayer, setSelectedScoutPlayer] = useState(null);
  const [selectedDropPlayer, setSelectedDropPlayer] = useState('');

  // Selected player card state
  const [selectedCardPlayer, setSelectedCardPlayer] = useState(null);

  const [statViewMode, setStatViewMode] = useState('projections');
  const [lastSeasonStats, setLastSeasonStats] = useState([]);

  // Fetch league status details
  useEffect(() => {
    if (!activeLeagueId) return;
    setLoadingLeague(true);
    const docRef = doc(db, 'fantasy_leagues', activeLeagueId);
    getDoc(docRef).then((snap) => {
      if (snap.exists()) {
        setLeagueData(snap.data());
      }
      setLoadingLeague(false);
    }).catch(err => {
      console.error("Error loading league status:", err);
      setLoadingLeague(false);
    });
  }, [activeLeagueId]);

  const fetchScoutingData = async () => {
    if (!activeLeagueId || !currentUser || !resolvedSeasonId) return;
    setLoading(true);
    try {
      // 1. Prepare fantasy league teams & rosters query
      const fetchLeagueTeams = getDocs(collection(db, `fantasy_leagues/${activeLeagueId}/teams`));
      const fetchLeagueWaivers = getDocs(collection(db, `fantasy_leagues/${activeLeagueId}/waivers`));
      
      // 2. Prepare aggregated stats query (or skip if fallback)
      let fetchStats = Promise.resolve({ skaters: {}, goalies: {} });
      if (!isFallbackUniverse) {
        const simDate = getSimulatedDate();
        fetchStats = fetchAggregatedStats(resolvedSeasonId, simDate);
      }

      // 3. Prepare previous season stats query
      let fetchPrevStats = Promise.resolve([]);
      const currentSeasonDoc = seasons.find(s => String(s.season_id) === String(activeSeasonId));
      const currentStartDate = currentSeasonDoc ? new Date(currentSeasonDoc.start_date) : new Date();
      const prevRegularSeasons = seasons.filter(s => {
        const isRegular = (s.playoff === '0' || s.playoff === 0) && (s.career === '1' || s.career === 1);
        const startsBefore = new Date(s.start_date) < currentStartDate;
        return isRegular && startsBefore;
      });
      
      if (prevRegularSeasons.length > 0) {
        prevRegularSeasons.sort((a, b) => new Date(b.start_date) - new Date(a.start_date));
        const prevRegSeason = prevRegularSeasons[0];
        const prevSeasonId = String(prevRegSeason.season_id);
        fetchPrevStats = getDocs(query(collection(db, 'pwhl_player_stats'), where('season_id', '==', prevSeasonId)));
      }

      // Execute all database queries concurrently
      const [leagueTeamsSnap, aggStats, prevStatsSnap, waiversSnap] = await Promise.all([
        fetchLeagueTeams,
        fetchStats,
        fetchPrevStats,
        fetchLeagueWaivers
      ]);

      // Set fantasy league teams & rosters
      const lTeams = leagueTeamsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      setTeamsList(lTeams);
      const userTeam = lTeams.find(t => t.ownerId === currentUser.uid);
      if (userTeam) {
        setMyTeam(userTeam);
      }

      // Set active waivers set
      const wSet = new Set();
      if (waiversSnap) {
        waiversSnap.forEach(wDoc => wSet.add(wDoc.id));
      }
      setWaiverPlayerIds(wSet);

      // Set dynamic player stats
      setStatsData(aggStats);

      // Set previous season stats
      let prevStats = [];
      if (prevStatsSnap && prevStatsSnap.docs) {
        prevStats = prevStatsSnap.docs.map(d => {
          const data = d.data();
          const pId = String(data.player_id);
          return {
            playerId: pId,
            stats: {
              gamesPlayed: Number(data.games_played || 0),
              goals: Number(data.goals || 0),
              assists: Number(data.assists || 0),
              plusMinus: Number(data.plus_minus || 0),
              powerPlayPoints: Number(data.power_play_points || 0),
              shortHandedPoints: Number(data.short_handed_points || 0),
              shotsOnGoal: Number(data.shots || data.shots_on || 0),
              blockedShots: Number(data.shots_blocked_by_player || 0),
              hits: Number(data.hits || 0),
              wins: Number(data.wins || 0),
              overtimeLosses: Number(data.ot_loss || data.overtime_losses || 0),
              goalsAgainst: Number(data.goals_against || 0),
              shotsSaved: Number(data.saves || 0),
              shutouts: Number(data.shutouts || 0),
            }
          };
        });
      }
      setLastSeasonStats(prevStats);
    } catch (err) {
      console.error("Error loading scouting database:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchScoutingData();
  }, [
    activeLeagueId, 
    currentUser, 
    transactionLoading, 
    leagueSimState.isSimulation, 
    leagueSimState.simulatedDate, 
    simulationState.testModeActive, 
    simulationState.current_simulated_date, 
    resolvedSeasonId, 
    isFallbackUniverse
  ]);

  useEffect(() => {
    if (statViewMode === 'projections') {
      setSortColumn('overallRank');
      setSortDirection('asc');
    } else {
      setSortColumn('points');
      setSortDirection('desc');
    }
  }, [statViewMode]);

  let isPreseason = true;
  if (leagueData && leagueData.status !== 'pending' && leagueData.status !== 'drafting') {
    const validGames = gamesList.filter(g => g.date_played || g.date);
    validGames.sort((a, b) => new Date(a.date_played || a.date) - new Date(b.date_played || b.date));
    if (validGames.length > 0) {
      const simDate = getSimulatedDate();
      const firstGameDate = new Date(validGames[0].date_played || validGames[0].date);
      if (firstGameDate <= simDate) {
        isPreseason = false;
      }
    }
  }

  useEffect(() => {
    if (!isPreseason && statViewMode !== 'currentSeason') {
      setStatViewMode('currentSeason');
    } else if (isPreseason && statViewMode === 'currentSeason') {
      setStatViewMode('projections');
    }
  }, [isPreseason, statViewMode]);

  if (!activeLeagueId) {
    return (
      <div className="min-h-[80vh] flex flex-col items-center justify-center px-6 text-center select-none animate-fade-in">
        <div className="w-16 h-16 rounded-full bg-indigo-50 border border-indigo-100 flex items-center justify-center text-3xl mb-6 shadow-sm animate-pulse">
          🔍
        </div>
        <h2 className="text-xl font-sports font-black text-gray-900 tracking-tight">No Active League</h2>
        <p className="text-xs text-gray-500 mt-2 max-w-sm font-semibold leading-relaxed">
          Start scouting! Select an active league dashboard first to view the PWHL player database.
        </p>
      </div>
    );
  }

  if (loading || loadingLeague || seasonsLoading || seasonDataLoading) {
    return (
      <div className="min-h-[80vh] flex items-center justify-center select-none animate-fade-in">
        <div className="text-xs font-black tracking-widest text-gray-400 uppercase animate-pulse">
          Syncing scouts database...
        </div>
      </div>
    );
  }

  const isPending = leagueData && (
    leagueData.status === 'pending' || 
    (leagueData.members && leagueData.members.length < leagueData.maxTeams) || 
    !leagueData.draftDate
  );

  // Map each player ID to its owner team document inside the league
  const getPlayerOwnerInfo = (playerId) => {
    const owningTeam = teamsList.find(t => (t.players || []).includes(playerId));
    if (!owningTeam) return { status: "available", label: "FA", color: "text-emerald-600 bg-emerald-50 border-emerald-100" };
    
    if (owningTeam.ownerId === currentUser.uid) {
      return { status: "mine", label: "Your Team", color: "text-indigo-600 bg-indigo-50 border-indigo-100" };
    }
    
    return { status: "rostered", label: owningTeam.teamName, color: "text-gray-500 bg-gray-50 border-gray-200" };
  };

  // Perform Add/Drop or Waiver Claim Transaction
  const handleScoutingTransaction = async () => {
    if (isPending) return;
    if (!activeLeagueId || !myTeam || !selectedScoutPlayer) return;

    const rosterSettings = leagueData?.rosterSettings || { bench: 4, forwards: { starters: 6 }, defense: { starters: 4 }, goalies: { starters: 1 } };
    const maxRosterSize = (rosterSettings.bench ?? 4) + 
                          (rosterSettings.forwards?.starters ?? 6) + 
                          (rosterSettings.defense?.starters ?? 4) + 
                          (rosterSettings.goalies?.starters ?? 1);
    const myRosterCount = (myTeam.players || []).length;

    if (myRosterCount >= maxRosterSize && !selectedDropPlayer) {
      alert(`Your roster is full (${myRosterCount}/${maxRosterSize}). You must select a player to drop to complete this transaction.`);
      return;
    }

    setTransactionLoading(true);
    try {
      const isOnWaivers = waiverPlayerIds.has(selectedScoutPlayer.id);
      if (isOnWaivers) {
        await submitWaiverClaim(
          activeLeagueId,
          myTeam.id,
          currentUser.uid,
          selectedScoutPlayer.id,
          selectedDropPlayer || null
        );
        alert(`Waiver Claim Submitted! Claim for ${selectedScoutPlayer.name} will be processed upon waiver expiration.`);
      } else {
        await submitAddDrop(
          activeLeagueId,
          myTeam.id,
          currentUser.uid,
          selectedScoutPlayer.id,
          selectedDropPlayer || null
        );
        alert(`Free Agency Acquisition Successful! Added ${selectedScoutPlayer.name}.`);
      }
      setSelectedScoutPlayer(null);
      setSelectedDropPlayer('');
      fetchScoutingData();
    } catch (err) {
      console.error(err);
      alert(err.message || 'Transaction rejected.');
    } finally {
      setTransactionLoading(false);
    }
  };

  // Compute fantasy points client-side
  const calculatePointsForMode = (player, statsObj) => {
    if (statViewMode === 'currentSeason' && isFallbackUniverse) return 0.0;
    
    const defaultScoring = {
      skaters: { goals: 2, assists: 1, plusMinus: 0.5, ppp: 0.5, shp: 0.5, sog: 0.1, hits: 0.1, blocks: 0.5, defensePoints: 0.5 },
      goalies: { wins: 4, otl: 1, ga: -2, saves: 0.2, shutouts: 3 }
    };
    const scoring = leagueData?.scoringSettings || defaultScoring;
    
    if (player.pos === 'G') {
      const matrix = scoring.goalies || defaultScoring.goalies;
      let pts = 0;
      pts += (statsObj.wins || 0) * (matrix.wins || 0);
      pts += (statsObj.overtimeLosses || statsObj.otl || 0) * (matrix.otl || 0);
      pts += (statsObj.goalsAgainst || statsObj.ga || 0) * (matrix.ga || 0);
      pts += (statsObj.shotsSaved || statsObj.saves || 0) * (matrix.saves || 0);
      pts += (statsObj.shutouts || 0) * (matrix.shutouts || 0);
      return Math.round(pts * 100) / 100;
    } else {
      const matrix = scoring.skaters || defaultScoring.skaters;
      let pts = 0;
      pts += (statsObj.goals || 0) * (matrix.goals || 0);
      pts += (statsObj.assists || 0) * (matrix.assists || 0);
      pts += (statsObj.plusMinus || 0) * (matrix.plusMinus || 0);
      pts += (statsObj.powerPlayPoints || statsObj.ppp || 0) * (matrix.ppp || 0);
      pts += (statsObj.shortHandedPoints || statsObj.shp || 0) * (matrix.shp || 0);
      pts += (statsObj.shotsOnGoal || statsObj.shots || 0) * (matrix.sog || 0);
      pts += (statsObj.hits || 0) * (matrix.hits || 0);
      pts += (statsObj.blockedShots || statsObj.blocks || 0) * (matrix.blocks || 0);
      
      if (player.pos === 'D' || player.pos === 'Defense') {
        pts += ((statsObj.goals || 0) + (statsObj.assists || 0)) * (matrix.defensePoints || 0);
      }
      return Math.round(pts * 100) / 100;
    }
  };

  // Prepare full list of players with dynamic properties
  const undroppableList = leagueData?.undroppable_players || [];

  const processedPlayers = playersList.map(player => {
    let statsObj = {};
    if (statViewMode === 'projections') {
      statsObj = player.projections || {};
    } else if (statViewMode === 'lastSeason') {
      const pIdStr = String(player.id);
      const match = lastSeasonStats.find(s => String(s.player_id) === pIdStr);
      statsObj = match || {};
    } else {
      const pIdStr = String(player.id);
      if (player.pos === 'G') {
        statsObj = statsData.goalies?.[pIdStr] || {};
      } else {
        statsObj = statsData.skaters?.[pIdStr] || {};
      }
    }

    const calculatedPoints = calculatePointsForMode(player, statsObj);
    const owner = getPlayerOwnerInfo(player.id);
    const teamInfo = pwhlTeams[player.team_id] || {};
    const teamCode = teamInfo.code || player.team_name || player.team_id || 'FA';
    const teamLogo = teamInfo.team_logo_url || '';

    const normPos = normalizePosition(player.position || player.pos);
    const name = player.name || `${player.first_name || ''} ${player.last_name || ''}`.trim() || 'Unknown Player';
    const jersey_number = player.tp_jersey_number || player.jersey_number || '';

    let gp = statsObj.gamesPlayed || statsObj.gp || 0;
    let g_w = player.pos === 'G' ? (statsObj.wins || 0) : (statsObj.goals || 0);
    let a_otl = player.pos === 'G' ? (statsObj.overtimeLosses || statsObj.otl || 0) : (statsObj.assists || 0);
    let pm_ga = player.pos === 'G' ? (statsObj.goalsAgainst || statsObj.ga || 0) : (statsObj.plusMinus || 0);
    let sog_sv = player.pos === 'G' ? (statsObj.shotsSaved || statsObj.saves || 0) : (statsObj.shotsOnGoal || statsObj.shots || 0);
    let blk_so = player.pos === 'G' ? (statsObj.shutouts || 0) : (statsObj.blockedShots || statsObj.blocks || 0);
    let hits = player.pos === 'G' ? '-' : (statsObj.hits || 0);

    const isUndroppable = undroppableList.includes(String(player.id));
    const isOnWaivers = waiverPlayerIds.has(String(player.id));

    return {
      ...player,
      name,
      pos: normPos,
      jersey_number,
      teamCode,
      teamLogo,
      owner,
      gp,
      g_w,
      a_otl,
      pm_ga,
      sog_sv,
      blk_so,
      hits,
      points: calculatedPoints,
      overallRank: player.overallRank,
      isUndroppable,
      isOnWaivers
    };
  });

  // Filter players list
  const filteredPlayers = processedPlayers.filter(player => {
    // 1. Search filter
    const matchesSearch = player.name.toLowerCase().includes(searchQuery.toLowerCase());
    if (!matchesSearch) return false;

    // 2. Position filter
    if (filterPosition !== 'all') {
      if (filterPosition === 'skaters' && player.pos === 'G') return false;
      if (filterPosition !== 'skaters' && player.pos !== filterPosition) return false;
    }

    // 3. PWHL Team filter
    if (filterTeam !== 'all') {
      if (player.teamCode !== filterTeam && player.team_id !== filterTeam) return false;
    }

    // 4. Availability filter
    if (filterAvailability !== 'all') {
      if (filterAvailability === 'available' && player.owner.status !== 'available') return false;
      if (filterAvailability === 'rostered' && player.owner.status !== 'rostered') return false;
      if (filterAvailability === 'mine' && player.owner.status !== 'mine') return false;
    }

    return true;
  });

  // Dynamic sorting
  const handleSort = (column) => {
    if (sortColumn === column) {
      setSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(column);
      setSortDirection('desc');
    }
  };

  const sortedPlayers = [...filteredPlayers].sort((a, b) => {
    let valA = a[sortColumn];
    let valB = b[sortColumn];

    if (sortColumn === 'name') {
      valA = a.name.toLowerCase();
      valB = b.name.toLowerCase();
    }

    // Handle goalie vs skater hit sorting representation
    if (valA === '-') valA = -1;
    if (valB === '-') valB = -1;

    if (valA < valB) return sortDirection === 'asc' ? -1 : 1;
    if (valA > valB) return sortDirection === 'asc' ? 1 : -1;
    return 0;
  });

  // Get list of unique PWHL teams dynamically for filter options
  const uniqueTeams = Array.from(new Set(playersList.map(p => pwhlTeams[p.team_id]?.code || p.team_name || p.team_id).filter(Boolean))).sort();

  // Helper to render sort arrows next to column headers
  const renderSortIndicator = (column) => {
    if (sortColumn !== column) return null;
    return <span className="ml-1 text-[8px] text-indigo-400">{sortDirection === 'asc' ? '▲' : '▼'}</span>;
  };

  return (
    <div className="font-sans select-none antialiased animate-fade-in text-slate-800">
      
      {/* ── HEADER ── */}
      <header className="mb-6 border-b pb-4" style={{ borderColor: '#E5E5E3' }}>
        <h1 className="font-sports text-2xl font-bold tracking-tight text-slate-800">
          Players
        </h1>
        <p className="text-xs text-slate-500 font-medium mt-0.5">Scout stats, filter positions, and manage roster acquisitions.</p>
      </header>

      {/* ── CENTRAL ACQUISITIONS LOCKED BANNER ── */}
      {isPending && (
        <div className="mb-6 p-3.5 bg-slate-50 border border-slate-200 rounded-xl flex items-center gap-3">
          <Lock className="w-4 h-4 text-slate-500 shrink-0" />
          <div>
            <h4 className="text-xs font-bold text-slate-800">Acquisitions Locked</h4>
            <p className="text-[11px] text-slate-500 font-medium mt-0.5">Player pool acquisitions will unlock once the draft completes.</p>
          </div>
        </div>
      )}

      {/* ── STATS VIEW MODE TOGGLE ── */}
      {isPreseason ? (
        <div className="flex bg-white p-1 rounded-xl w-fit mb-6 border border-slate-200">
          <button 
            onClick={() => setStatViewMode('projections')}
            className={`px-4 py-1.5 text-xs font-semibold rounded-lg transition-all cursor-pointer ${statViewMode === 'projections' ? 'bg-slate-700 text-white' : 'text-slate-500 hover:text-slate-800'}`}
          >
            Projections
          </button>
          <button 
            onClick={() => setStatViewMode('lastSeason')}
            className={`px-4 py-1.5 text-xs font-semibold rounded-lg transition-all cursor-pointer ${statViewMode === 'lastSeason' ? 'bg-slate-700 text-white' : 'text-slate-500 hover:text-slate-800'}`}
          >
            Last Season
          </button>
        </div>
      ) : null}

      {/* ── ROW OF FILTERS (HORIZONTAL LOBBY CONTROL BAR) ── */}
      <div className="bg-white border border-slate-200/80 p-5 rounded-2xl shadow-sm flex flex-wrap items-end gap-4 mb-6">
        {/* Search */}
        <div className="flex-1 min-w-[200px] relative">
          <label className="block text-[9px] uppercase font-black text-slate-500 mb-2">Search Athlete</label>
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-3" />
            <input 
              type="text" 
              placeholder="Type athlete name..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-slate-50 border border-slate-200 rounded-xl pl-10 pr-4 py-2.5 text-xs text-slate-900 placeholder-slate-400 focus:outline-none focus:border-indigo-600 transition-all"
            />
          </div>
        </div>

        {/* Availability */}
        <div className="w-full sm:w-auto min-w-[140px]">
          <label className="block text-[9px] uppercase font-black text-slate-500 mb-2">Availability</label>
          <select 
            value={filterAvailability} 
            onChange={(e) => setFilterAvailability(e.target.value)}
            className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5 text-[10px] font-black text-slate-800 focus:outline-none focus:border-indigo-600 transition-all cursor-pointer"
          >
            <option value="all">All Players</option>
            <option value="available">Free Agents & Waivers</option>
            <option value="rostered">Rostered (Other)</option>
            <option value="mine">My Roster</option>
          </select>
        </div>

        {/* Position */}
        <div className="w-full sm:w-auto min-w-[145px]">
          <label className="block text-[9px] uppercase font-black text-slate-500 mb-2">Role/Position</label>
          <select 
            value={filterPosition} 
            onChange={(e) => setFilterPosition(e.target.value)}
            className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5 text-[10px] font-black text-slate-800 focus:outline-none focus:border-indigo-600 transition-all cursor-pointer"
          >
            <option value="all">All Roles</option>
            <option value="skaters">Skaters Only</option>
            <option value="F">Forwards</option>
            <option value="D">Defense</option>
            <option value="G">Goalies</option>
          </select>
        </div>

        {/* PWHL Team */}
        <div className="w-full sm:w-auto min-w-[140px]">
          <label className="block text-[9px] uppercase font-black text-slate-500 mb-2">PWHL Team</label>
          <select 
            value={filterTeam} 
            onChange={(e) => setFilterTeam(e.target.value)}
            className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5 text-[10px] font-black text-slate-800 focus:outline-none focus:border-indigo-600 transition-all cursor-pointer"
          >
            <option value="all">All Teams</option>
            {uniqueTeams.map(t => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>
      </div>

      {/* ── UNIFIED PLAYER GRID TABLE ── */}
      {sortedPlayers.length === 0 ? (
        <div className="text-center py-20 text-xs text-slate-500 font-bold italic border border-dashed border-slate-300 rounded-2xl bg-white shadow-xs flex flex-col items-center justify-center gap-2">
          <Search className="w-8 h-8 text-slate-400 mb-1" />
          <span>No athletes matching scouting criteria found.</span>
        </div>
      ) : (
        <div className="bg-white border border-slate-200/80 rounded-2xl shadow-sm overflow-hidden transition-all">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse min-w-[800px]">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200">
                  <th 
                    onClick={() => handleSort('name')}
                    className="px-5 py-4 text-[10px] font-black uppercase text-slate-500 tracking-wider cursor-pointer hover:text-indigo-600 transition-colors"
                  >
                    <div className="flex items-center">Player {renderSortIndicator('name')}</div>
                  </th>
                  <th 
                    onClick={() => handleSort('pos')}
                    className="px-4 py-4 text-[10px] font-black uppercase text-slate-500 tracking-wider text-center cursor-pointer hover:text-indigo-600 transition-colors w-20"
                  >
                    <div className="flex items-center justify-center">Pos {renderSortIndicator('pos')}</div>
                  </th>
                  <th 
                    onClick={() => handleSort('teamCode')}
                    className="px-4 py-4 text-[10px] font-black uppercase text-slate-500 tracking-wider text-center cursor-pointer hover:text-indigo-600 transition-colors w-20"
                  >
                    <div className="flex items-center justify-center">Team {renderSortIndicator('teamCode')}</div>
                  </th>
                  <th className="px-4 py-4 text-[10px] font-black uppercase text-slate-500 tracking-wider text-center w-28">Status</th>
                  <th 
                    onClick={() => handleSort('gp')}
                    className="px-3 py-4 text-[10px] font-black uppercase text-slate-500 tracking-wider text-center cursor-pointer hover:text-indigo-600 transition-colors w-16"
                  >
                    <div className="flex items-center justify-center">GP {renderSortIndicator('gp')}</div>
                  </th>
                  <th 
                    onClick={() => handleSort('g_w')}
                    className="px-3 py-4 text-[10px] font-black uppercase text-slate-500 tracking-wider text-center cursor-pointer hover:text-indigo-600 transition-colors w-16"
                  >
                    <div className="flex items-center justify-center">G/W {renderSortIndicator('g_w')}</div>
                  </th>
                  <th 
                    onClick={() => handleSort('a_otl')}
                    className="px-3 py-4 text-[10px] font-black uppercase text-slate-500 tracking-wider text-center cursor-pointer hover:text-indigo-600 transition-colors w-16"
                  >
                    <div className="flex items-center justify-center">A/OTL {renderSortIndicator('a_otl')}</div>
                  </th>
                  <th 
                    onClick={() => handleSort('pm_ga')}
                    className="px-3 py-4 text-[10px] font-black uppercase text-slate-500 tracking-wider text-center cursor-pointer hover:text-indigo-600 transition-colors w-20"
                  >
                    <div className="flex items-center justify-center">+/- / GA {renderSortIndicator('pm_ga')}</div>
                  </th>
                  <th 
                    onClick={() => handleSort('sog_sv')}
                    className="px-3 py-4 text-[10px] font-black uppercase text-slate-500 tracking-wider text-center cursor-pointer hover:text-indigo-600 transition-colors w-20"
                  >
                    <div className="flex items-center justify-center">SOG/SV {renderSortIndicator('sog_sv')}</div>
                  </th>
                  <th 
                    onClick={() => handleSort('blk_so')}
                    className="px-3 py-4 text-[10px] font-black uppercase text-slate-500 tracking-wider text-center cursor-pointer hover:text-indigo-600 transition-colors w-20"
                  >
                    <div className="flex items-center justify-center">Blk/SO {renderSortIndicator('blk_so')}</div>
                  </th>
                  <th 
                    onClick={() => handleSort('hits')}
                    className="px-3 py-4 text-[10px] font-black uppercase text-slate-500 tracking-wider text-center cursor-pointer hover:text-indigo-600 transition-colors w-16"
                  >
                    <div className="flex items-center justify-center">Hits {renderSortIndicator('hits')}</div>
                  </th>
                  <th 
                    onClick={() => handleSort('points')}
                    className="px-4 py-4 text-[10px] font-black uppercase text-slate-500 tracking-wider text-center cursor-pointer hover:text-indigo-600 transition-colors w-24"
                  >
                    <div className="flex items-center justify-center">FPTS {renderSortIndicator('points')}</div>
                  </th>
                  <th className="px-5 py-4 text-[10px] font-black uppercase text-slate-500 tracking-wider text-right w-32">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {sortedPlayers.map((player, idx) => {
                  const isFA = player.owner.status === 'available';

                  return (
                    <tr 
                      key={`${player.id || player.player_id}_${idx}`} 
                      className="hover:bg-slate-50 transition-all duration-150"
                    >
                      {/* Player info */}
                      <td className="px-5 py-3.5">
                        <div className="flex items-center gap-3">
                          {player.player_image ? (
                            <img 
                              src={player.player_image} 
                              alt={player.name} 
                              className="w-8 h-8 rounded-lg border border-slate-200 object-cover shrink-0" 
                            />
                          ) : (
                            <div className="w-8 h-8 rounded-lg bg-slate-100 border border-slate-200 flex items-center justify-center text-xs text-slate-500 shrink-0 font-bold">
                              {player.name.slice(0, 1)}
                            </div>
                          )}
                          <div>
                            <div className="flex flex-col">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                {player.jersey_number && (
                                  <span className="text-[9px] font-semibold text-slate-400">#{player.jersey_number}</span>
                                )}
                                <span 
                                  onClick={() => setSelectedCardPlayer(player)}
                                  className="text-xs font-bold text-slate-800 hover:text-slate-600 cursor-pointer transition-colors"
                                >
                                  {player.name}
                                </span>

                                {player.isUndroppable && (
                                  <span className="text-[8px] font-black text-amber-300 bg-amber-500/20 border border-amber-500/40 px-1.5 py-0.5 rounded flex items-center gap-1 shrink-0">
                                    <Shield className="w-2.5 h-2.5" /> CAN'T CUT
                                  </span>
                                )}
                              </div>
                              {statViewMode === 'projections' && player.overallRank && player.overallRank !== 999 && (
                                <span className="text-[8px] font-black text-indigo-400 uppercase tracking-wide mt-0.5">
                                  VORP Rank #{player.overallRank}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      </td>

                      {/* Position */}
                      <td className="px-4 py-3.5 text-center">
                        <span className="text-xs font-semibold text-slate-500">
                          {player.pos}
                        </span>
                      </td>

                      {/* Team */}
                      <td className="px-4 py-3.5 text-center">
                        <span className="text-[10px] font-semibold text-slate-600">
                          {player.teamCode}
                        </span>
                      </td>

                      {/* Owner Status */}
                      <td className="px-4 py-3.5 text-center">
                        {player.isOnWaivers ? (
                          <span className="text-[9px] font-black uppercase px-2.5 py-1 rounded-lg border tracking-wider text-center block truncate max-w-[120px] mx-auto text-amber-400 bg-amber-500/10 border-amber-500/30">
                            Waivers
                          </span>
                        ) : (
                          <span className={`text-[9px] font-black uppercase px-2.5 py-1 rounded-lg border tracking-wider text-center block truncate max-w-[120px] mx-auto ${player.owner.color}`}>
                            {player.owner.label}
                          </span>
                        )}
                      </td>

                      {/* Games Played */}
                      <td className="px-3 py-3.5 text-center text-xs font-bold text-slate-300">
                        {player.gp}
                      </td>

                      {/* Goals or Wins */}
                      <td className="px-3 py-3.5 text-center text-xs font-semibold text-slate-300">
                        {player.g_w}
                      </td>

                      {/* Assists or OTL */}
                      <td className="px-3 py-3.5 text-center text-xs font-semibold text-slate-300">
                        {player.a_otl}
                      </td>

                      {/* Plus-Minus or Goals Against */}
                      <td className="px-3 py-3.5 text-center text-xs font-semibold text-slate-300">
                        {player.pos === 'G' ? player.pm_ga : (player.pm_ga > 0 ? `+${player.pm_ga}` : player.pm_ga)}
                      </td>

                      {/* SOG or Saves */}
                      <td className="px-3 py-3.5 text-center text-xs font-semibold text-slate-300">
                        {player.sog_sv}
                      </td>

                      {/* Blocks or Shutouts */}
                      <td className="px-3 py-3.5 text-center text-xs font-semibold text-slate-300">
                        {player.blk_so}
                      </td>

                      {/* Hits */}
                      <td className="px-3 py-3.5 text-center text-xs font-semibold text-slate-300">
                        {player.hits}
                      </td>

                      {/* Total Points */}
                      <td className="px-4 py-3.5 text-center font-sports text-xs font-black text-indigo-400 bg-indigo-500/10">
                        {player.points.toFixed(1)}
                      </td>

                      {/* Acquire / Trade Action */}
                      <td className="px-5 py-3.5 text-right">
                        {isFA && myTeam && !isPending && (
                          <button
                            onClick={() => setSelectedScoutPlayer(player)}
                            className={`px-3 py-1.5 text-[9px] font-black uppercase tracking-wider rounded-xl text-white active:scale-95 transition-all shadow-md cursor-pointer flex items-center gap-1 ml-auto ${
                              player.isOnWaivers 
                                ? 'bg-amber-600 hover:bg-amber-500 shadow-amber-600/20' 
                                : 'bg-indigo-600 hover:bg-indigo-500 shadow-indigo-600/20'
                            }`}
                          >
                            {player.isOnWaivers ? (
                              <>
                                <Clock className="w-3 h-3" /> Claim
                              </>
                            ) : (
                              <>
                                <UserPlus className="w-3 h-3" /> Acquire
                              </>
                            )}
                          </button>
                        )}
                        {!isFA && player.owner.status === 'rostered' && player.owner.status !== 'mine' && myTeam && !isPending && onProposeTrade && (
                          <button
                            onClick={() => onProposeTrade(player)}
                            className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-[9px] font-black uppercase tracking-wider rounded-xl text-white active:scale-95 transition-all shadow-md shadow-emerald-600/20 cursor-pointer flex items-center gap-1 ml-auto"
                          >
                            <ArrowRightLeft className="w-3 h-3" /> Trade
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── ACQUIRE / WAIVER CLAIM TRANSACTION DIALOG ── */}
      {selectedScoutPlayer && myTeam && !isPending && (() => {
        const rosterSettings = leagueData?.rosterSettings || { bench: 4, forwards: { starters: 6 }, defense: { starters: 4 }, goalies: { starters: 1 } };
        const maxRosterSize = (rosterSettings.bench ?? 4) + 
                              (rosterSettings.forwards?.starters ?? 6) + 
                              (rosterSettings.defense?.starters ?? 4) + 
                              (rosterSettings.goalies?.starters ?? 1);
        const isRosterFull = (myTeam.players || []).length >= maxRosterSize;
        const isOnWaivers = selectedScoutPlayer.isOnWaivers;

        return (
          <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-md flex items-center justify-center p-4 z-50">
            <div className="w-full max-w-sm bg-white border border-slate-200/80 rounded-2xl p-6 shadow-xl relative animate-scale-up text-slate-800">
              <h3 className="text-xs font-black uppercase text-slate-500 tracking-wider">
                {isOnWaivers ? 'Waiver Claim Proposal' : 'Free Agency Acquisition'}
              </h3>
              
              <div className="mt-4 p-4 rounded-xl bg-slate-50 border border-slate-200">
                <span className={`text-[9px] uppercase font-black tracking-widest px-2 py-0.5 rounded-lg border ${
                  isOnWaivers ? 'text-amber-700 bg-amber-50 border-amber-200' : 'text-indigo-700 bg-indigo-50 border-indigo-200'
                }`}>
                  {isOnWaivers ? 'WAIVER CLAIM' : 'ACQUIRE'}
                </span>
                <p className="text-sm font-black text-slate-900 mt-2">{selectedScoutPlayer.name}</p>
                <p className="text-[10px] text-slate-500 font-bold mt-0.5">{selectedScoutPlayer.pos} • {selectedScoutPlayer.teamCode}</p>
              </div>

              {isRosterFull && (
                <div className="mt-3 p-3 bg-amber-50 border border-amber-200 rounded-xl flex items-center gap-2 text-amber-800 text-[10px] font-bold">
                  <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                  <span>Roster Full ({maxRosterSize}/{maxRosterSize}): Mandatory drop selection required.</span>
                </div>
              )}

              <div className="mt-4">
                <label className="block text-[10px] uppercase font-black tracking-widest text-slate-500 mb-2 flex justify-between">
                  <span>Designated Drop Player</span>
                  {isRosterFull && <span className="text-amber-700 font-black">* REQUIRED</span>}
                </label>
                <select 
                  value={selectedDropPlayer} 
                  onChange={e => setSelectedDropPlayer(e.target.value)}
                  className={`w-full bg-slate-50 border rounded-xl px-4 py-3 text-xs text-slate-900 font-semibold focus:outline-none cursor-pointer ${
                    isRosterFull && !selectedDropPlayer ? 'border-amber-400 focus:border-amber-500' : 'border-slate-200 focus:border-indigo-600'
                  }`}
                >
                  <option value="">{isRosterFull ? "-- Select player to drop --" : "No Player (Add Only)"}</option>
                  {(myTeam.players || []).map(pId => {
                    const pDetail = playersList.find(p => p.id === pId) || { name: pId };
                    const isUndrop = undroppableList.includes(String(pId));
                    return (
                      <option key={pId} value={pId} disabled={isUndrop}>
                        Drop: {pDetail.name} {isUndrop ? '(UNDROPPABLE)' : ''}
                      </option>
                    );
                  })}
                </select>
                <p className="text-[9px] text-slate-500 font-medium mt-2">
                  {isOnWaivers 
                    ? "Waiver claim will be processed daily at simulation rollover." 
                    : "Note: Dropped athletes will be placed on waivers for 48 hours."}
                </p>
              </div>

              <div className="flex gap-3 mt-6">
                <button 
                  onClick={() => {
                    setSelectedScoutPlayer(null);
                    setSelectedDropPlayer('');
                  }}
                  className="flex-1 py-2.5 bg-slate-100 hover:bg-slate-200 rounded-xl text-[10px] font-black uppercase text-slate-700 tracking-wider cursor-pointer transition-colors"
                >
                  Cancel
                </button>
                <button 
                  disabled={transactionLoading || (isRosterFull && !selectedDropPlayer)}
                  onClick={handleScoutingTransaction}
                  className="flex-1 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-[10px] font-black uppercase text-white tracking-wider rounded-xl disabled:opacity-40 cursor-pointer shadow-sm transition-all"
                >
                  {transactionLoading ? 'Executing...' : (isOnWaivers ? 'Submit Claim' : 'Confirm Add')}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      <PlayerCardModal 
        player={selectedCardPlayer} 
        onClose={() => setSelectedCardPlayer(null)} 
        onProposeTrade={onProposeTrade}
      />

    </div>
  );
}
