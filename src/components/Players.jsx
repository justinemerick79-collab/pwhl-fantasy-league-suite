import React, { useState, useEffect } from 'react';
import { db } from '../firebase.js';
import { doc, getDoc, collection, query, where, getDocs } from 'firebase/firestore';
import { useAuth } from '../contexts/AuthContext';
import { useTimeTravel } from '../contexts/TimeTravelContext';
import PlayerCardModal from './PlayerCardModal';
import { fetchAggregatedStats } from '../services/statsEngine';
import { submitAddDrop } from '../services/leagueService.js';
import { normalizePosition } from '../services/pwhlService.js';

export default function Players({ activeLeagueId }) {
  const { currentUser } = useAuth();
  const { timeTravelState, getSimulatedDate, activeSeasonId } = useTimeTravel();
  
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

  // Dynamic players list, PWHL teams mapping, and aggregated stats data
  const [playersList, setPlayersList] = useState([]);
  const [pwhlTeams, setPwhlTeams] = useState({});
  const [statsData, setStatsData] = useState({ skaters: {}, goalies: {} });

  // Complete game details & box score summaries for history
  const [gamesList, setGamesList] = useState([]);
  const [gameSummariesList, setGameSummariesList] = useState([]);

  // Sorting state
  const [sortColumn, setSortColumn] = useState('points');
  const [sortDirection, setSortDirection] = useState('desc');

  // Modal active state for Add/Drop trigger
  const [selectedScoutPlayer, setSelectedScoutPlayer] = useState(null);
  const [selectedDropPlayer, setSelectedDropPlayer] = useState('');

  // Selected player card state
  const [selectedCardPlayer, setSelectedCardPlayer] = useState(null);

  // Fallback player universe flag
  const [isFallbackUniverse, setIsFallbackUniverse] = useState(false);

  const [statViewMode, setStatViewMode] = useState('projections');
  const [projectionsList, setProjectionsList] = useState([]);
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

  // Load dynamic player stats, PWHL teams, league rosters, and player universe
  const fetchScoutingData = async () => {
    if (!activeLeagueId || !currentUser) return;
    setLoading(true);
    try {
      // 1. Fetch fantasy league teams & rosters
      const leagueTeamsSnap = await getDocs(collection(db, `fantasy_leagues/${activeLeagueId}/teams`));
      const lTeams = leagueTeamsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      setTeamsList(lTeams);
      const userTeam = lTeams.find(t => t.ownerId === currentUser.uid);
      if (userTeam) {
        setMyTeam(userTeam);
      }
 
      // 2. Fetch PWHL seasons
      const seasonsSnap = await getDocs(collection(db, 'pwhl_seasons'));
      const seasons = seasonsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
 
      const seasonId = activeSeasonId ? String(activeSeasonId) : '5';
 
      // Resolve active player universe & fallback to previous regular season if needed
      const playersQuery = query(collection(db, 'pwhl_players'), where('season_id', 'in', [seasonId, Number(seasonId)]));
      const playersSnap = await getDocs(playersQuery);
      
      let resolvedSeasonId = seasonId;
      let rawPlayers = playersSnap.docs.map(d => d.data());
      let fallbackActive = false;
      
      if (rawPlayers.length === 0 && seasons.length > 0) {
        const currentSeasonDoc = seasons.find(s => String(s.season_id) === String(seasonId));
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
          fallbackActive = true;
          
          console.log(`[Universe Resolver] Upcoming season ${seasonId} has no players. Falling back to previous Regular Season ${resolvedSeasonId} with zeroed stats.`);
          
          const prevPlayersQuery = query(collection(db, 'pwhl_players'), where('season_id', 'in', [resolvedSeasonId, Number(resolvedSeasonId)]));
          const prevPlayersSnap = await getDocs(prevPlayersQuery);
          rawPlayers = prevPlayersSnap.docs.map(d => d.data());
        }
      }
      
      setIsFallbackUniverse(fallbackActive);
 
      // 3. Fetch PWHL Teams to map team codes and logos for the resolved season
      const teamsQuery = query(collection(db, 'pwhl_teams'), where('season_id', 'in', [resolvedSeasonId, Number(resolvedSeasonId)]));
      const teamsSnap = await getDocs(teamsQuery);
      const teamsMap = {};
      teamsSnap.forEach(d => {
        const t = d.data();
        teamsMap[String(t.id)] = {
          code: t.code || t.name || t.id,
          logo: t.team_logo_url || ''
        };
      });
      setPwhlTeams(teamsMap);
 
      // 4. Set mapped players
      const pList = rawPlayers.map(p => {
        const id = p.player_id || p.id || d.id.split("_")[1];
        return {
          id: id ? String(id) : p.id || '',
          first_name: p.first_name || '',
          last_name: p.last_name || '',
          name: p.name || `${p.first_name || ''} ${p.last_name || ''}`.trim() || 'Unknown Player',
          pos: normalizePosition(p.position),
          team_id: p.current_team_id || p.team_id || '',
          jersey_number: p.tp_jersey_number || p.jersey_number || '',
          player_image: p.player_image || '',
          shoots: p.shoots || '',
          hometown: p.hometown || p.homeplace || '',
          height: p.height || p.h || '',
          weight: p.weight || p.w || '',
          birthdate: p.birthdate || p.rawbirthdate || '',
          ...p
        };
      });
      setPlayersList(pList);
 
      // 5. Fetch games for this resolved season
      const gamesQuery = query(collection(db, 'pwhl_games'), where('season_id', 'in', [resolvedSeasonId, Number(resolvedSeasonId)]));
      const gamesSnap = await getDocs(gamesQuery);
      const gList = gamesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      setGamesList(gList);
 
      // 6. Fetch game summaries for this resolved season
      const summariesQuery = query(collection(db, 'pwhl_game_summaries'), where('season_id', 'in', [resolvedSeasonId, Number(resolvedSeasonId)]));
      const summariesSnap = await getDocs(summariesQuery);
      const summariesList = summariesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      setGameSummariesList(summariesList);
 
      // 7. Fetch aggregated box score stats (or skip if fallback)
      let aggStats = { skaters: {}, goalies: {} };
      if (!fallbackActive) {
        const simDate = getSimulatedDate();
        aggStats = await fetchAggregatedStats(resolvedSeasonId, simDate);
      }
      setStatsData(aggStats);

      // 8. Fetch upcoming season projections
      let projList = [];
      try {
        const projectionsSnap = await getDocs(collection(db, `pwhl_projections/${seasonId}/player_projections`));
        projList = projectionsSnap.docs.map(d => d.data());
      } catch (err) {
        console.error("Error loading projections in scouting:", err);
      }
      setProjectionsList(projList);

      // 9. Fetch last season stats
      let prevStats = [];
      try {
        const currentSeasonDoc = seasons.find(s => String(s.season_id) === String(seasonId));
        const currentStartDate = currentSeasonDoc ? new Date(currentSeasonDoc.start_date) : new Date();
        const prevRegularSeasons = seasons.filter(s => {
          const isRegular = (s.playoff === '0' || s.playoff === 0) && (s.career === '1' || s.career === 1);
          const startsBefore = new Date(s.start_date) < currentStartDate;
          return isRegular && startsBefore;
        });
        prevRegularSeasons.sort((a, b) => new Date(b.start_date) - new Date(a.start_date));
        const prevRegSeason = prevRegularSeasons[0];
        if (prevRegSeason) {
          const prevSeasonId = String(prevRegSeason.season_id);
          const prevStatsSnap = await getDocs(
            query(collection(db, 'pwhl_player_stats'), where('season_id', '==', prevSeasonId))
          );
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
      } catch (err) {
        console.error("Error loading last season stats in scouting:", err);
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
  }, [activeLeagueId, currentUser, transactionLoading, timeTravelState?.enabled, timeTravelState?.date]);

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

  if (loading || loadingLeague) {
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

  // Perform Add/Drop Transaction
  const handleScoutingTransaction = async () => {
    if (isPending) return;
    if (!activeLeagueId || !myTeam || !selectedScoutPlayer) return;
    setTransactionLoading(true);
    try {
      await submitAddDrop(
        activeLeagueId,
        myTeam.id,
        currentUser.uid,
        selectedScoutPlayer.id,
        selectedDropPlayer || null
      );
      alert(`Scouting Acquisition Successful! Added ${selectedScoutPlayer.name}.`);
      setSelectedScoutPlayer(null);
      setSelectedDropPlayer('');
    } catch (err) {
      console.error(err);
      alert(err.message || 'Acquisition transaction rejected.');
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

  // Compile full processed stats & mapping for sorting/filtering
  const processedPlayers = playersList.map(player => {
    const owner = getPlayerOwnerInfo(player.id);
    const proj = projectionsList.find(p => String(p.playerId) === String(player.id));
    const lastSeason = lastSeasonStats.find(p => String(p.playerId) === String(player.id));

    let activeStats = {};
    let overallRank = 999;

    if (statViewMode === 'projections') {
      activeStats = proj?.projected_season_stats || {};
      overallRank = proj?.overallRank !== undefined ? Number(proj.overallRank) : 999;
    } else if (statViewMode === 'lastSeason') {
      activeStats = lastSeason?.stats || {};
    } else {
      // currentSeason
      if (player.pos === 'G') {
        activeStats = statsData.goalies[player.id] || {};
      } else {
        activeStats = statsData.skaters[player.id] || {};
      }
    }

    const points = calculatePointsForMode(player, activeStats);
    const teamInfo = pwhlTeams[player.team_id] || { code: player.team_name || player.team_id || 'FA', logo: '' };
    const teamCode = teamInfo.code;
    const teamLogo = teamInfo.logo;

    let gp = 0, g_w = 0, a_otl = 0, pm_ga = 0, sog_sv = 0, blk_so = 0, hits = 0;
    if (player.pos === 'G') {
      gp = activeStats.gamesPlayed || 0;
      g_w = activeStats.wins || 0;
      a_otl = activeStats.overtimeLosses || activeStats.otl || 0;
      pm_ga = activeStats.goalsAgainst || activeStats.ga || 0;
      sog_sv = activeStats.shotsSaved || activeStats.saves || 0;
      blk_so = activeStats.shutouts || 0;
      hits = '-';
    } else {
      gp = activeStats.gamesPlayed || 0;
      g_w = activeStats.goals || 0;
      a_otl = activeStats.assists || 0;
      pm_ga = activeStats.plusMinus || 0;
      sog_sv = activeStats.shotsOnGoal || activeStats.shots || 0;
      blk_so = activeStats.blockedShots || activeStats.blocks || 0;
      hits = activeStats.hits || 0;
    }

    return {
      ...player,
      owner,
      points,
      teamCode,
      teamLogo,
      gp,
      g_w,
      a_otl,
      pm_ga,
      sog_sv,
      blk_so,
      hits,
      overallRank
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
    return <span className="ml-1 text-[8px] text-indigo-600">{sortDirection === 'asc' ? '▲' : '▼'}</span>;
  };

  // Team visual branding picker
  const getTeamBranding = (teamCode) => {
    switch (teamCode) {
      case 'BOS':
        return {
          gradient: 'from-emerald-800 to-slate-900',
          borderColor: 'border-emerald-500/35',
          glowColor: 'shadow-emerald-500/10'
        };
      case 'MIN':
        return {
          gradient: 'from-purple-800 to-slate-900',
          borderColor: 'border-purple-500/35',
          glowColor: 'shadow-purple-500/10'
        };
      case 'MTL':
        return {
          gradient: 'from-rose-950 to-slate-900',
          borderColor: 'border-rose-500/35',
          glowColor: 'shadow-rose-500/10'
        };
      case 'NY':
        return {
          gradient: 'from-teal-800 to-slate-900',
          borderColor: 'border-teal-500/35',
          glowColor: 'shadow-teal-500/10'
        };
      case 'OTT':
        return {
          gradient: 'from-red-800 to-slate-900',
          borderColor: 'border-red-500/35',
          glowColor: 'shadow-red-500/10'
        };
      case 'TOR':
        return {
          gradient: 'from-blue-900 to-slate-900',
          borderColor: 'border-blue-500/35',
          glowColor: 'shadow-blue-500/10'
        };
      default:
        return {
          gradient: 'from-indigo-900 to-slate-900',
          borderColor: 'border-indigo-500/35',
          glowColor: 'shadow-indigo-500/10'
        };
    }
  };

  // Compile game history list for the Player Card Modal
  const compileGameHistory = (player) => {
    if (!gamesList.length || !gameSummariesList.length) return [];
    
    const cutoff = getSimulatedDate();
    const isGoalie = player.pos === 'G';
    const playerIdStr = String(player.id);
    const defaultScoring = {
      skaters: { goals: 2, assists: 1, plusMinus: 0.5, ppp: 0.5, shp: 0.5, sog: 0.1, hits: 0.1, blocks: 0.5, defensePoints: 0.5 },
      goalies: { wins: 4, otl: 1, ga: -2, saves: 0.2, shutouts: 3 }
    };
    const scoring = leagueData?.scoringSettings || defaultScoring;

    const playerGames = [];

    gameSummariesList.forEach(summary => {
      // Find corresponding game doc
      const gameDoc = gamesList.find(g => String(g.game_id) === String(summary.id));
      if (!gameDoc) return;

      // Status '4' is Final
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
        // Search home players
        const homePlayer = (summary.home_team_lineup?.players || []).find(p => String(p.player_id) === playerIdStr);
        // Search visitor players
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

          // Compute assists, ppGoals, shGoals, ppAssists, shAssists from scoring plays (goals array) for this player in this summary
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

          if (player.pos === 'D' || player.pos === 'Defense') {
            pts += (goals + assists) * (matrix.defensePoints || 0);
          }
        }
      }

      if (participated) {
        // Resolve opponent and score
        const teamCode = player.teamCode;
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

    // Sort by date descending
    playerGames.sort((a, b) => new Date(b.gameDate) - new Date(a.gameDate));
    return playerGames.slice(0, 5); // Return last 5 games
  };

  // Compile active variables for Selected Card Player
  const gameHistory = selectedCardPlayer ? compileGameHistory(selectedCardPlayer) : [];
  const teamBranding = selectedCardPlayer ? getTeamBranding(selectedCardPlayer.teamCode) : null;

  return (
    <div className="font-sans select-none antialiased animate-fade-in">
      
      {/* ── HEADER ── */}
      <header className="mb-6">
        <span className="text-[10px] uppercase font-black tracking-widest text-indigo-600 bg-indigo-50 px-3 py-1.5 rounded-full border border-indigo-100 shadow-sm shadow-indigo-100/10">
          Scouting Database
        </span>
        <h1 className="font-sports text-3xl font-black mt-3 tracking-tight text-gray-900">
          PWHL Athletes
        </h1>
        <p className="text-xs text-gray-400 font-semibold tracking-wide mt-0.5">Research stats, evaluate availability, and secure free agents.</p>
      </header>

      {/* ── CENTRAL ACQUISITIONS LOCKED BANNER (Pre-Draft) ── */}
      {isPending && (
        <div className="mb-6 p-4.5 bg-indigo-50 border border-indigo-100 rounded-3xl flex items-center gap-3.5 animate-scale-up">
          <div className="w-10 h-10 rounded-2xl bg-white border border-indigo-100 flex items-center justify-center text-xl text-indigo-600 shadow-sm animate-pulse">
            🔒
          </div>
          <div>
            <h4 className="text-xs font-black uppercase tracking-wider text-indigo-900">Acquisitions Locked</h4>
            <p className="text-[10px] text-indigo-500 font-semibold mt-0.5 leading-normal">Player pool acquisitions are locked until the draft completes.</p>
          </div>
        </div>
      )}

      {/* ── STATS VIEW MODE TOGGLE ── */}
      {isPreseason ? (
        <div className="flex bg-gray-100 p-1 rounded-2xl w-fit mb-6">
          <button 
            onClick={() => setStatViewMode('projections')}
            className={`px-4 py-2 text-[10px] font-black uppercase tracking-wider rounded-xl transition-all active:scale-95 ${statViewMode === 'projections' ? 'bg-white text-indigo-600 shadow-sm border border-gray-200/20' : 'text-gray-400 hover:text-gray-600'}`}
          >
            Projections
          </button>
          <button 
            onClick={() => setStatViewMode('lastSeason')}
            className={`px-4 py-2 text-[10px] font-black uppercase tracking-wider rounded-xl transition-all active:scale-95 ${statViewMode === 'lastSeason' ? 'bg-white text-indigo-600 shadow-sm border border-gray-200/20' : 'text-gray-400 hover:text-gray-600'}`}
          >
            Last Season
          </button>
        </div>
      ) : (
        <div className="flex bg-indigo-50 p-1.5 rounded-2xl w-fit mb-6 border border-indigo-100">
          <span className="px-3 py-1.5 text-[10px] font-black uppercase tracking-wider text-indigo-600">
            Current Season Stats
          </span>
        </div>
      )}

      {/* ── ROW OF FILTERS (HORIZONTAL LOBBY CONTROL BAR) ── */}
      <div className="bg-white border border-gray-200 p-5 rounded-[24px] shadow-sm flex flex-wrap items-end gap-4 mb-6">
        {/* Search */}
        <div className="flex-1 min-w-[200px]">
          <label className="block text-[9px] uppercase font-black text-gray-400 mb-2">Search Athlete</label>
          <input 
            type="text" 
            placeholder="Type name..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2.5 text-xs text-gray-800 placeholder-gray-400 focus:outline-none focus:bg-white focus:border-indigo-500 shadow-inner transition-all"
          />
        </div>

        {/* Availability */}
        <div className="w-full sm:w-auto min-w-[140px]">
          <label className="block text-[9px] uppercase font-black text-gray-400 mb-2">Availability</label>
          <select 
            value={filterAvailability} 
            onChange={(e) => setFilterAvailability(e.target.value)}
            className="w-full bg-white border border-gray-200 rounded-xl px-3 py-2.5 text-[10px] font-black text-gray-500 focus:outline-none focus:border-indigo-500 shadow-sm transition-all"
          >
            <option value="all">All Players</option>
            <option value="available">Free Agents</option>
            <option value="rostered">Rostered (Other)</option>
            <option value="mine">My Roster</option>
          </select>
        </div>

        {/* Position */}
        <div className="w-full sm:w-auto min-w-[145px]">
          <label className="block text-[9px] uppercase font-black text-gray-400 mb-2">Role/Position</label>
          <select 
            value={filterPosition} 
            onChange={(e) => setFilterPosition(e.target.value)}
            className="w-full bg-white border border-gray-200 rounded-xl px-3 py-2.5 text-[10px] font-black text-gray-500 focus:outline-none focus:border-indigo-500 shadow-sm transition-all"
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
          <label className="block text-[9px] uppercase font-black text-gray-400 mb-2">PWHL Team</label>
          <select 
            value={filterTeam} 
            onChange={(e) => setFilterTeam(e.target.value)}
            className="w-full bg-white border border-gray-200 rounded-xl px-3 py-2.5 text-[10px] font-black text-gray-500 focus:outline-none focus:border-indigo-500 shadow-sm transition-all"
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
        <div className="text-center py-20 text-xs text-gray-400 font-bold italic border border-dashed border-gray-200 rounded-[28px] bg-white shadow-sm">
          No athletes matching scouting criteria found.
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-[24px] shadow-sm overflow-hidden transition-all">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-gray-50/75 border-b border-gray-100">
                  <th 
                    onClick={() => handleSort('name')}
                    className="px-5 py-4 text-[10px] font-black uppercase text-gray-400 tracking-wider cursor-pointer hover:text-indigo-600 transition-colors"
                  >
                    <div className="flex items-center">Player {renderSortIndicator('name')}</div>
                  </th>
                  <th 
                    onClick={() => handleSort('pos')}
                    className="px-4 py-4 text-[10px] font-black uppercase text-gray-400 tracking-wider text-center cursor-pointer hover:text-indigo-600 transition-colors w-20"
                  >
                    <div className="flex items-center justify-center">Pos {renderSortIndicator('pos')}</div>
                  </th>
                  <th 
                    onClick={() => handleSort('teamCode')}
                    className="px-4 py-4 text-[10px] font-black uppercase text-gray-400 tracking-wider text-center cursor-pointer hover:text-indigo-600 transition-colors w-20"
                  >
                    <div className="flex items-center justify-center">Team {renderSortIndicator('teamCode')}</div>
                  </th>
                  <th className="px-4 py-4 text-[10px] font-black uppercase text-gray-400 tracking-wider text-center w-28">Status</th>
                  <th 
                    onClick={() => handleSort('gp')}
                    className="px-3 py-4 text-[10px] font-black uppercase text-gray-400 tracking-wider text-center cursor-pointer hover:text-indigo-600 transition-colors w-16"
                  >
                    <div className="flex items-center justify-center">GP {renderSortIndicator('gp')}</div>
                  </th>
                  <th 
                    onClick={() => handleSort('g_w')}
                    className="px-3 py-4 text-[10px] font-black uppercase text-gray-400 tracking-wider text-center cursor-pointer hover:text-indigo-600 transition-colors w-16"
                  >
                    <div className="flex items-center justify-center">G/W {renderSortIndicator('g_w')}</div>
                  </th>
                  <th 
                    onClick={() => handleSort('a_otl')}
                    className="px-3 py-4 text-[10px] font-black uppercase text-gray-400 tracking-wider text-center cursor-pointer hover:text-indigo-600 transition-colors w-16"
                  >
                    <div className="flex items-center justify-center">A/OTL {renderSortIndicator('a_otl')}</div>
                  </th>
                  <th 
                    onClick={() => handleSort('pm_ga')}
                    className="px-3 py-4 text-[10px] font-black uppercase text-gray-400 tracking-wider text-center cursor-pointer hover:text-indigo-600 transition-colors w-20"
                  >
                    <div className="flex items-center justify-center">+/- / GA {renderSortIndicator('pm_ga')}</div>
                  </th>
                  <th 
                    onClick={() => handleSort('sog_sv')}
                    className="px-3 py-4 text-[10px] font-black uppercase text-gray-400 tracking-wider text-center cursor-pointer hover:text-indigo-600 transition-colors w-20"
                  >
                    <div className="flex items-center justify-center">SOG/SV {renderSortIndicator('sog_sv')}</div>
                  </th>
                  <th 
                    onClick={() => handleSort('blk_so')}
                    className="px-3 py-4 text-[10px] font-black uppercase text-gray-400 tracking-wider text-center cursor-pointer hover:text-indigo-600 transition-colors w-20"
                  >
                    <div className="flex items-center justify-center">Blk/SO {renderSortIndicator('blk_so')}</div>
                  </th>
                  <th 
                    onClick={() => handleSort('hits')}
                    className="px-3 py-4 text-[10px] font-black uppercase text-gray-400 tracking-wider text-center cursor-pointer hover:text-indigo-600 transition-colors w-16"
                  >
                    <div className="flex items-center justify-center">Hits {renderSortIndicator('hits')}</div>
                  </th>
                  <th 
                    onClick={() => handleSort('points')}
                    className="px-4 py-4 text-[10px] font-black uppercase text-gray-400 tracking-wider text-center cursor-pointer hover:text-indigo-600 transition-colors w-24"
                  >
                    <div className="flex items-center justify-center">FPTS {renderSortIndicator('points')}</div>
                  </th>
                  <th className="px-5 py-4 text-[10px] font-black uppercase text-gray-400 tracking-wider text-right w-28">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {sortedPlayers.map(player => {
                  const isFA = player.owner.status === 'available';
                  
                  // Position specific styling
                  let posClass = "border-indigo-100 bg-indigo-50 text-indigo-600";
                  if (player.pos === 'D') {
                    posClass = "border-emerald-100 bg-emerald-50 text-emerald-600";
                  } else if (player.pos === 'G') {
                    posClass = "border-purple-100 bg-purple-50 text-purple-600";
                  }

                  return (
                    <tr 
                      key={player.id} 
                      className="hover:bg-indigo-50/20 transition-all duration-150"
                    >
                      {/* Player info */}
                      <td className="px-5 py-3.5">
                        <div className="flex items-center gap-3">
                          {player.player_image ? (
                            <img 
                              src={player.player_image} 
                              alt={player.name} 
                              className="w-8 h-8 rounded-xl border border-gray-100 object-cover shadow-sm shrink-0" 
                            />
                          ) : (
                            <div className="w-8 h-8 rounded-xl bg-gray-50 border border-gray-100 flex items-center justify-center text-xs text-gray-400 shrink-0">
                              🥅
                            </div>
                          )}
                          <div>
                            <div className="flex flex-col">
                              <div className="flex items-center gap-1.5">
                                {player.jersey_number && (
                                  <span className="text-[9px] font-extrabold text-gray-400">#{player.jersey_number}</span>
                                )}
                                <span 
                                  onClick={() => setSelectedCardPlayer(player)}
                                  className="text-xs font-black text-gray-800 hover:text-indigo-600 cursor-pointer transition-colors hover:underline"
                                >
                                  {player.name}
                                </span>
                              </div>
                              {statViewMode === 'projections' && player.overallRank && player.overallRank !== 999 && (
                                <span className="text-[8px] font-black text-indigo-500 uppercase tracking-wide mt-0.5">
                                  VORP Rank #{player.overallRank}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      </td>

                      {/* Position */}
                      <td className="px-4 py-3.5 text-center">
                        <span className={`text-[9px] font-black uppercase px-2 py-0.5 rounded-lg border tracking-widest ${posClass}`}>
                          {player.pos}
                        </span>
                      </td>

                      {/* Team */}
                      <td className="px-4 py-3.5 text-center">
                        <span className="text-[9px] font-black text-gray-500 bg-gray-50 px-1.5 py-0.5 rounded border border-gray-200">
                          {player.teamCode}
                        </span>
                      </td>

                      {/* Owner Status */}
                      <td className="px-4 py-3.5 text-center">
                        <span className={`text-[9px] font-black uppercase px-2.5 py-1 rounded-lg border tracking-wider text-center block truncate max-w-[120px] mx-auto ${player.owner.color}`}>
                          {player.owner.label}
                        </span>
                      </td>

                      {/* Games Played */}
                      <td className="px-3 py-3.5 text-center text-xs font-bold text-gray-600">
                        {player.gp}
                      </td>

                      {/* Goals or Wins */}
                      <td className="px-3 py-3.5 text-center text-xs font-semibold text-gray-600">
                        {player.g_w}
                      </td>

                      {/* Assists or OTL */}
                      <td className="px-3 py-3.5 text-center text-xs font-semibold text-gray-600">
                        {player.a_otl}
                      </td>

                      {/* Plus-Minus or Goals Against */}
                      <td className="px-3 py-3.5 text-center text-xs font-semibold text-gray-600">
                        {player.pos === 'G' ? player.pm_ga : (player.pm_ga > 0 ? `+${player.pm_ga}` : player.pm_ga)}
                      </td>

                      {/* SOG or Saves */}
                      <td className="px-3 py-3.5 text-center text-xs font-semibold text-gray-600">
                        {player.sog_sv}
                      </td>

                      {/* Blocks or Shutouts */}
                      <td className="px-3 py-3.5 text-center text-xs font-semibold text-gray-600">
                        {player.blk_so}
                      </td>

                      {/* Hits */}
                      <td className="px-3 py-3.5 text-center text-xs font-semibold text-gray-600">
                        {player.hits}
                      </td>

                      {/* Total Points */}
                      <td className="px-4 py-3.5 text-center font-sports text-xs font-black text-indigo-600 bg-indigo-50/20">
                        {player.points.toFixed(1)}
                      </td>

                      {/* Acquire Action */}
                      <td className="px-5 py-3.5 text-right">
                        {isFA && myTeam && !isPending && (
                          <button
                            onClick={() => setSelectedScoutPlayer(player)}
                            className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-[9px] font-black uppercase tracking-wider rounded-lg text-white active:scale-95 transition-all shadow-md shadow-indigo-600/10"
                          >
                            Acquire
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

      {/* ── ACQUIRE TRANSACTION DIALOG ── */}
      {selectedScoutPlayer && myTeam && !isPending && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-sm flex items-center justify-center p-6 z-50">
          <div className="w-full max-w-sm bg-white border border-gray-200 rounded-[32px] p-6 shadow-2xl relative animate-scale-up">
            <h3 className="text-xs font-black uppercase text-gray-400 tracking-wider">Scouting Waiver Pickup</h3>
            
            <div className="mt-4 p-4 rounded-2xl bg-gray-50 border border-gray-200">
              <span className="text-[9px] uppercase font-black tracking-widest text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded border border-indigo-100">ACQUIRE</span>
              <p className="text-sm font-black text-gray-800 mt-2">{selectedScoutPlayer.name}</p>
              <p className="text-[10px] text-gray-400 font-bold mt-0.5">{selectedScoutPlayer.pos} • {selectedScoutPlayer.teamCode}</p>
            </div>

            <div className="mt-4">
              <label className="block text-[10px] uppercase font-black tracking-widest text-gray-500 mb-2">Designated Drop Player</label>
              <select 
                value={selectedDropPlayer} 
                onChange={e => setSelectedDropPlayer(e.target.value)}
                className="w-full bg-white border border-gray-200 rounded-2xl px-4 py-3.5 text-xs text-gray-700 focus:outline-none focus:border-indigo-500 shadow-sm"
              >
                <option value="">No Player (Add Only)</option>
                {(myTeam.players || []).map(pId => {
                  const pDetail = playersList.find(p => p.id === pId) || { name: pId };
                  return <option key={pId} value={pId}>Drop: {pDetail.name}</option>;
                })}
              </select>
              <p className="text-[9px] text-gray-400 font-semibold mt-2">Note: Dropped athletes will be placed on waivers for 48 hours.</p>
            </div>

            <div className="flex gap-3 mt-6">
              <button 
                onClick={() => {
                  setSelectedScoutPlayer(null);
                  setSelectedDropPlayer('');
                }}
                disabled={transactionLoading}
                className="flex-1 py-3.5 bg-gray-50 hover:bg-gray-100 border border-gray-200 rounded-2xl text-[10px] font-black uppercase text-gray-500 tracking-wider active:scale-95 transition-transform"
              >
                Cancel
              </button>
              <button 
                onClick={handleScoutingTransaction}
                disabled={transactionLoading}
                className="flex-1 py-3.5 bg-gradient-to-r from-indigo-600 to-violet-600 text-[10px] font-black uppercase text-white tracking-wider rounded-2xl active:scale-95 transition-transform shadow-md shadow-indigo-600/10"
              >
                {transactionLoading ? 'Executing...' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── PLAYER PLAY CARD MODAL ── */}
      <PlayerCardModal 
        player={selectedCardPlayer} 
        gameHistory={gameHistory} 
        teamBranding={teamBranding} 
        onClose={() => setSelectedCardPlayer(null)} 
      />

    </div>
  );
}
