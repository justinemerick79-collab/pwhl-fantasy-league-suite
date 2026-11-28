import { useState, useEffect, useRef } from 'react';
import { 
  Users, Shield, Activity, 
  Lock, ChevronLeft, ChevronRight
} from 'lucide-react';
import { db } from '../firebase.js';
import { doc, getDoc, collection, query, where, getDocs } from 'firebase/firestore';
import { useAuth } from '../contexts/AuthContext';
import { useTimeTravel } from '../contexts/TimeTravelContext';
import { useData } from '../contexts/DataContext';
import { normalizePosition } from '../services/pwhlService';
import { saveDailyLineup, getDailyLineup, getLocalDateStr, getPSTDateStr } from '../services/leagueService';
import PlayerCardModal from './PlayerCardModal';
import { useLiveDay } from '../hooks/useLiveStats';
import LiveBadge from './LiveBadge';
import PwhlTeamLabel from './PwhlTeamLabel';

const getActiveStatsText = (player, stats) => {
  if (!stats) return '';
  const isGoalie = player.position === 'G' || player.pos === 'G';
  
  if (isGoalie) {
    const parts = [];
    if (stats.timeOnIce !== undefined) {
      const m = Math.floor(stats.timeOnIce / 60);
      const s = stats.timeOnIce % 60;
      parts.push(`${m}:${String(s).padStart(2, '0')} TOI`);
    }
    if (stats.wins > 0) parts.push('W');
    else if (stats.losses > 0) parts.push('L');
    else if (stats.overtimeLosses > 0) parts.push('OTL');
    
    if (stats.saves !== undefined) parts.push(`${stats.saves} Sv`);
    if (stats.goalsAgainst !== undefined) parts.push(`${stats.goalsAgainst} GA`);
    if (stats.shutouts > 0) parts.push(`${stats.shutouts} SO`);
    return parts.join(', ');
  } else {
    const parts = [];
    if (stats.goals) parts.push(stats.goals === 1 ? '1 Goal' : `${stats.goals} Goals`);
    if (stats.assists) parts.push(stats.assists === 1 ? '1 Assist' : `${stats.assists} Assists`);
    if (stats.plusMinus !== undefined && stats.plusMinus !== 0) {
      parts.push(`${stats.plusMinus > 0 ? '+' : ''}${stats.plusMinus} +/-`);
    }
    if (stats.sog) parts.push(stats.sog === 1 ? '1 Shot' : `${stats.sog} Shots`);
    if (stats.hits) parts.push(stats.hits === 1 ? '1 Hit' : `${stats.hits} Hits`);
    if (stats.blocks) parts.push(stats.blocks === 1 ? '1 Block' : `${stats.blocks} Blocks`);
    if (stats.ppp) parts.push(stats.ppp === 1 ? '1 PPP' : `${stats.ppp} PPP`);
    if (stats.shp) parts.push(stats.shp === 1 ? '1 SHP' : `${stats.shp} SHP`);
    if (stats.pim) parts.push(`${stats.pim} PIM`);
    return parts.join(', ');
  }
};

export default function Roster({ activeLeagueId }) {
  const { currentUser } = useAuth();
  const { activeSeasonId, getSimulatedDate } = useTimeTravel();
  const { seasons, seasonsLoading, seasonCache, loadingStates, loadSeasonData } = useData();
  
  const [loading, setLoading] = useState(true);
  const [loadingLeague, setLoadingLeague] = useState(true);
  const [myTeam, setMyTeam] = useState(null);
  const [leagueData, setLeagueData] = useState(null);

  // Season data from DataContext — must be after leagueData declaration
  const seasonId = leagueData?.season_id 
    ? String(leagueData.season_id) 
    : (activeSeasonId ? String(activeSeasonId) : '5');

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
    gamesList
    } = activeSeasonData;

  const seasonDataLoading = loadingStates[seasonId] === true;
  const [playersMap, setPlayersMap] = useState({});
  const [isUpdating, setIsUpdating] = useState(false);
  const [selectedCardPlayer, setSelectedCardPlayer] = useState(null);

  // Safe parser: avoids UTC midnight shift when parsing "YYYY-MM-DD" strings
  const parseDateStr = (dateStr) => {
    if (!dateStr) return new Date();
    if (dateStr.includes('T') || dateStr.includes(' ')) return new Date(dateStr);
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(y, m - 1, d, 12, 0, 0);
  };

  // Daily lineups states
  const [resolvedCurrentWeek, setResolvedCurrentWeek] = useState(1);
  const [selectedDateStr, setSelectedDateStr] = useState(''); // "YYYY-MM-DD"
  // Live status of the day being viewed; its version reloads the day's points
  // whenever the server updates them during games.
  const liveDay = useLiveDay(selectedDateStr);
  const liveVersion = liveDay?.version || 0;
  const lastSimDateStrRef = useRef('');
  const lastLeagueIdRef = useRef('');
  const [weekDates, setWeekDates] = useState([]);
  const [seasonWeeks, setSeasonWeeks] = useState([]);
  const [dailyLineup, setDailyLineup] = useState({ activeLineup: {}, bench: [] });
  const [pwhlGamesToday, setPwhlGamesToday] = useState([]);
  const [dailyPointsMap, setDailyPointsMap] = useState({});
  const [lineupLoading, setLineupLoading] = useState(false);

  // Drag and drop states
  const [draggingPlayerId, setDraggingPlayerId] = useState(null);
  const [draggingSource, setDraggingSource] = useState(null); // { type: 'active', slot: 'F1' } or { type: 'bench', index: 0 }

  // Load league data
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
      console.error("Error fetching league status:", err);
      setLoadingLeague(false);
    });
  }, [activeLeagueId]);

  // Load team data
  useEffect(() => {
    if (!activeLeagueId || !currentUser) return;
    
    async function fetchUserRoster() {
      setLoading(true);
      try {
        const q = query(
          collection(db, `fantasy_leagues/${activeLeagueId}/teams`), 
          where('ownerId', '==', currentUser.uid)
        );
        const snap = await getDocs(q);
        if (!snap.empty) {
          setMyTeam({ id: snap.docs[0].id, ...snap.docs[0].data() });
        } else {
          setMyTeam(null);
        }
      } catch (err) {
        console.error("Error fetching user roster:", err);
      } finally {
        setLoading(false);
      }
    }
    fetchUserRoster();
  }, [activeLeagueId, currentUser]);

  // Effect 1: Sync selectedDateStr to simDateStr when simulation date or league changes
  useEffect(() => {
    const simDate = getSimulatedDate();
    const simDateStr = getLocalDateStr(simDate);
    const hasSimDateChanged = simDateStr !== lastSimDateStrRef.current;
    const hasLeagueChanged = activeLeagueId !== lastLeagueIdRef.current;

    if (hasSimDateChanged || hasLeagueChanged || !selectedDateStr) {
      lastSimDateStrRef.current = simDateStr;
      lastLeagueIdRef.current = activeLeagueId;
      setSelectedDateStr(simDateStr);
    }
  }, [activeLeagueId, getSimulatedDate, selectedDateStr]);

  // Effect 2: Resolve week, seasonWeeks, and weekDates based on selectedDateStr
  useEffect(() => {
    if (!leagueData || !selectedDateStr) return;

    async function resolveWeekAndDays() {
      try {
        const seasonId = leagueData?.season_id 
          ? String(leagueData.season_id) 
          : (activeSeasonId ? String(activeSeasonId) : '5');
        const seasonDoc = await getDoc(doc(db, 'pwhl_seasons', seasonId));
        let weeks = [];
        if (seasonDoc.exists() && seasonDoc.data().weeks) {
          weeks = seasonDoc.data().weeks;
        }
        setSeasonWeeks(weeks);

        const targetDate = parseDateStr(selectedDateStr);
        targetDate.setHours(12, 0, 0, 0);
        let cw = leagueData.currentWeek || 1;

        if (weeks.length > 0) {
          const matchedWeek = weeks.find(w => {
            const s = parseDateStr(getPSTDateStr(w.start));
            s.setHours(0, 0, 0, 0);
            const e = parseDateStr(getPSTDateStr(w.end));
            e.setHours(23, 59, 59, 999);
            return targetDate >= s && targetDate <= e;
          });
          if (matchedWeek) {
            cw = matchedWeek.week;
          }
        }
        setResolvedCurrentWeek(cw);

        let weekStartStr = "2024-01-01";
        const wk = weeks.find(w => w.week === cw);
        if (wk) {
          weekStartStr = wk.start;
        } else {
          const baseTime = parseDateStr("2024-01-01").getTime();
          const weekMs = 7 * 24 * 60 * 60 * 1000;
          const start = new Date(baseTime + (cw - 1) * weekMs);
          weekStartStr = getLocalDateStr(start);
        }

        const weekStart = parseDateStr(weekStartStr.split('T')[0]);
        weekStart.setHours(12, 0, 0, 0);
        const days = [];
        for (let i = 0; i < 7; i++) {
          const d = new Date(weekStart);
          d.setDate(weekStart.getDate() + i);
          const dStr = getLocalDateStr(d);
          const label = d.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric' });
          days.push({ date: d, dateStr: dStr, label });
        }
        setWeekDates(days);
      } catch (err) {
        console.error("Error resolving week dates:", err);
      }
    }

    resolveWeekAndDays();
  }, [leagueData, activeSeasonId, selectedDateStr]);

  // Load dynamic players map & daily stats from context cached data
  useEffect(() => {
    if (!activeLeagueId || !leagueData || !selectedDateStr || seasonsLoading || seasonDataLoading) return;
    
    async function loadDynamicPlayersAndStats() {
      setLineupLoading(true);
      try {
        const seasonId = leagueData?.season_id 
          ? String(leagueData.season_id) 
          : (activeSeasonId ? String(activeSeasonId) : '5');
        
        // Filter daily games list for the selected date from context cached games
        const dailyGames = gamesList.filter(g => {
          const gDateStr = g.date_played || g.date;
          if (!gDateStr) return false;
          return (gDateStr || '').split('T')[0].split(' ')[0] === selectedDateStr;
        });
        setPwhlGamesToday(dailyGames);
        
        // Fetch daily stats and points for the selected date
        let pointsMap = {};
        let statsMap = {};
        const isFallback = playersList.length === 0 || (seasons.find(s => String(s.season_id) === String(seasonId))?.start_date && !playersList.some(p => String(p.season_id) === String(seasonId)));

        if (!isFallback) {
          const { fetchDailyPlayerPointsFromSnapshot } = await import('../services/statsEngine');
          const simDate = getSimulatedDate();
          
          const dayStart = parseDateStr(selectedDateStr);
          dayStart.setHours(0, 0, 0, 0);
          const dayEnd = parseDateStr(selectedDateStr);
          dayEnd.setHours(23, 59, 59, 999);
          
          const result = await fetchDailyPlayerPointsFromSnapshot(seasonId, dayStart, dayEnd, simDate, leagueData?.scoringSettings, activeLeagueId);
          pointsMap = result.pointsMap[selectedDateStr] || {};
          statsMap = result.statsMap[selectedDateStr] || {};
          setDailyPointsMap(pointsMap);
        }
        
        const map = {};
        playersList.forEach(p => {
          const pId = p.id;
          if (!pId) return;
          
          const normPos = normalizePosition(p.position);
          const isGoalie = normPos === 'G';
          const actualTeamId = String(p.current_team_id || p.team_id || '');
          
          const statsObj = statsMap[pId];
          const hasGame = dailyGames.some(g => 
            String(g.home_team) === actualTeamId || 
            String(g.visiting_team) === actualTeamId
          );
          
          let statsStr;
          if (hasGame) {
            if (statsObj) {
              statsStr = getActiveStatsText({ ...p, pos: normPos }, statsObj) || 'No stats obtained';
            } else {
              statsStr = 'Did Not Play / No Stats';
            }
          } else {
            statsStr = 'No Game Today';
          }
          
          const rating = p.rating || (isGoalie ? 85 : (normPos === 'D' ? 82 : 84));
          
          map[String(pId)] = {
            ...p,
            id: String(pId),
            name: p.name || `${p.first_name || ''} ${p.last_name || ''}`.trim() || 'Unknown Player',
            pos: normPos,
            jersey_number: p.tp_jersey_number || p.jersey_number || '',
            teamId: actualTeamId,
            teamCode: pwhlTeams[actualTeamId]?.code || p.team_name || 'FA',
            teamLogo: pwhlTeams[actualTeamId]?.logo,
            team: pwhlTeams[actualTeamId]?.code || p.team_name || 'FA',
            rating,
            stats: statsStr,
            points: pointsMap[pId] || 0.0,
            raw: p
          };
        });

        // Fetch daily lineup state
        const lineup = myTeam ? await getDailyLineup(activeLeagueId, myTeam.id, selectedDateStr) : null;

        // Safeguard: a player on this fantasy roster must never vanish, even with no
        // player doc in this season's list (the server keeps one, but the screen must
        // not depend on it). Use the player's doc from any season for the name, the
        // lineup slot for the position, and show no PWHL team.
        const slotPos = {};
        Object.entries(lineup?.activeLineup || {}).forEach(([slot, id]) => { if (id) slotPos[String(id)] = slot[0]; });
        const rosterIds = new Set([...(myTeam?.players || []), ...Object.keys(slotPos), ...(lineup?.bench || [])].map(String));
        const missingIds = [...rosterIds].filter(id => !map[id]);
        const namesById = {};
        for (let i = 0; i < missingIds.length; i += 30) {
          const chunk = missingIds.slice(i, i + 30);
          const snap = await getDocs(query(collection(db, 'pwhl_players'), where('player_id', 'in', chunk)));
          snap.forEach(d => { const x = d.data(); namesById[String(x.player_id)] = x; });
        }
        missingIds.forEach(id => {
          const older = namesById[id] || {};
          const pos = slotPos[id] || normalizePosition(older.position) || 'F';
          map[id] = {
            id, name: older.name || `${older.first_name || ''} ${older.last_name || ''}`.trim() || `Player ${id}`,
            pos, jersey_number: older.tp_jersey_number || '', teamId: '', teamCode: 'FA', team: 'FA',
            rating: pos === 'G' ? 85 : pos === 'D' ? 82 : 84,
            stats: 'Not in this season\'s player list', points: pointsMap[id] || 0.0, raw: older,
          };
        });

        setPlayersMap(map);
        if (lineup) setDailyLineup(lineup);
      } catch (err) {
        console.error("Error loading dynamic players and stats:", err);
      } finally {
        setLineupLoading(false);
      }
    }
    
    loadDynamicPlayersAndStats();
  // myTeam rather than myTeam?.id: the effect also branches on the object
  // itself. It is set by the league-loading effect above, never here, so
  // tracking its identity cannot loop.
  }, [activeLeagueId, activeSeasonId, leagueData, selectedDateStr, myTeam, playersList, pwhlTeams,
      gamesList, seasonsLoading, seasonDataLoading, getSimulatedDate, seasons, liveVersion]);

  if (!activeLeagueId) {
    return (
      <div className="min-h-[80vh] flex flex-col items-center justify-center px-6 text-center select-none">
        <div className="w-16 h-16 rounded-full bg-indigo-50 border border-indigo-100 flex items-center justify-center text-3xl mb-6 shadow-sm animate-pulse">
           skating
        </div>
        <h2 className="text-xl font-sports font-black text-gray-900 tracking-tight">No Active League</h2>
        <p className="text-xs text-gray-505 mt-2 max-w-sm font-semibold leading-relaxed">
          Unlock your roster deck! Join a league to start drafting or managing your active athletes.
        </p>
      </div>
    );
  }

  if (loading || loadingLeague || seasonsLoading || seasonDataLoading) {
    return (
      <div className="min-h-[80vh] flex items-center justify-center">
        <div className="text-xs font-black tracking-widest text-gray-400 uppercase animate-pulse">
          Loading Roster Data...
        </div>
      </div>
    );
  }

  if (!myTeam) {
    return (
      <div className="min-h-[80vh] flex flex-col items-center justify-center px-6 text-center">
        <div className="text-3xl mb-4">🏒</div>
        <h2 className="text-lg font-sports font-black text-gray-900 leading-tight">No Team Found</h2>
        <p className="text-xs text-gray-550 mt-2 max-w-xs font-semibold leading-relaxed">
          You are a member of this league but do not own a team sheet. Please contact the commissioner to configure your rosters.
        </p>
      </div>
    );
  }

  const rosterSettings = leagueData?.rosterSettings || { bench: 4, forwards: { starters: 6 }, defense: { starters: 4 }, goalies: { starters: 1 } };
  const fLimit = rosterSettings.forwards?.starters ?? 6;
  const dLimit = rosterSettings.defense?.starters ?? 4;
  const gLimit = rosterSettings.goalies?.starters ?? 1;

  const isPending = leagueData && (
    leagueData.status === 'pending' || 
    (leagueData.members && leagueData.members.length < leagueData.maxTeams) || 
    !leagueData.draftDate
  );

  const simDate = getSimulatedDate();
  const simDateStr = getLocalDateStr(simDate);
  const isReadOnly = isPending || (selectedDateStr < simDateStr);


  const handlePlayerClick = (p) => {
    setSelectedCardPlayer(p);
  };

  // Lock checking function
  const isPlayerLocked = (player) => {
    if (isReadOnly) return true;
    if (!player || !player.teamId) return false;
    const game = pwhlGamesToday.find(g => {
      return String(g.home_team) === player.teamId || String(g.visiting_team) === player.teamId;
    });

    if (game) {
      const gameStart = new Date(game.date_played || game.date);
      return simDate >= gameStart;
    }
    return false;
  };

  // Click validation and movement actions
  const handleMoveToActive = async (playerId) => {
    if (isReadOnly || isUpdating) return;
    const p = playersMap[playerId];
    if (!p || isPlayerLocked(p)) return;

    const slots = [];
    if (p.pos === 'F') {
      for (let i = 1; i <= fLimit; i++) slots.push(`F${i}`);
    } else if (p.pos === 'D') {
      for (let i = 1; i <= dLimit; i++) slots.push(`D${i}`);
    } else if (p.pos === 'G') {
      for (let i = 1; i <= gLimit; i++) slots.push(`G${i}`);
    }
    
    const emptySlot = slots.find(s => !dailyLineup.activeLineup[s]);
    if (!emptySlot) {
      alert(`No empty active slots for position ${p.pos}.`);
      return;
    }

    const newActiveLineup = { ...dailyLineup.activeLineup, [emptySlot]: playerId };
    const newBench = dailyLineup.bench.filter(id => id !== playerId);

    setIsUpdating(true);
    try {
      await saveDailyLineup(activeLeagueId, myTeam.id, selectedDateStr, newActiveLineup, newBench);
      setDailyLineup({ activeLineup: newActiveLineup, bench: newBench });
    } catch (err) {
      console.error("Error moving player:", err);
      alert(err.message);
    } finally {
      setIsUpdating(false);
    }
  };

  const handleSwapFromSelect = async (benchPlayerId, activeSlot) => {
    if (isReadOnly || isUpdating) return;
    const bp = playersMap[benchPlayerId];
    if (!bp || isPlayerLocked(bp)) return;

    // Verify position eligibility
    const slotPos = activeSlot.charAt(0); // 'F', 'D', or 'G'
    if (bp.pos !== slotPos) {
      alert(`Cannot place non-${slotPos === 'F' ? 'Forward' : slotPos === 'D' ? 'Defenseman' : 'Goalie'} ${bp.name} in slot ${activeSlot}.`);
      return;
    }

    const activePlayerId = dailyLineup.activeLineup[activeSlot];
    const ap = playersMap[activePlayerId];
    if (ap && isPlayerLocked(ap)) {
      alert(`Cannot swap: ${ap.name}'s game has already started.`);
      return;
    }

    const newActiveLineup = { ...dailyLineup.activeLineup, [activeSlot]: benchPlayerId };
    let newBench = dailyLineup.bench.filter(id => id !== benchPlayerId);
    if (activePlayerId) {
      newBench.push(activePlayerId);
    }

    setIsUpdating(true);
    try {
      await saveDailyLineup(activeLeagueId, myTeam.id, selectedDateStr, newActiveLineup, newBench);
      setDailyLineup({ activeLineup: newActiveLineup, bench: newBench });
    } catch (err) {
      console.error("Error swapping player:", err);
      alert(err.message);
    } finally {
      setIsUpdating(false);
    }
  };

  const handleMoveToBench = async (playerId, slotKey) => {
    if (isReadOnly || isUpdating) return;
    const p = playersMap[playerId];
    if (!p || isPlayerLocked(p)) return;

    const newActiveLineup = { ...dailyLineup.activeLineup };
    newActiveLineup[slotKey] = null;
    const newBench = [...dailyLineup.bench, playerId];

    setIsUpdating(true);
    try {
      await saveDailyLineup(activeLeagueId, myTeam.id, selectedDateStr, newActiveLineup, newBench);
      setDailyLineup({ activeLineup: newActiveLineup, bench: newBench });
    } catch (err) {
      console.error("Error moving player to bench:", err);
      alert(err.message);
    } finally {
      setIsUpdating(false);
    }
  };

  // HTML5 Drag and Drop handlers
  const handleDragStart = (e, playerId, source) => {
    const p = playersMap[playerId];
    if (isPlayerLocked(p)) {
      e.preventDefault();
      return;
    }
    setDraggingPlayerId(playerId);
    setDraggingSource(source);
    e.dataTransfer.setData('text/plain', playerId);
  };

  const handleDrop = async (e, target) => {
    e.preventDefault();
    if (!draggingPlayerId || !draggingSource) return;

    const isSameTarget = (
      (draggingSource.type === 'active' && target.type === 'active' && draggingSource.slot === target.slot) ||
      (draggingSource.type === 'bench' && target.type === 'bench' && draggingSource.index === target.index)
    );
    if (isSameTarget) return;

    const newActiveLineup = { ...dailyLineup.activeLineup };
    let newBench = [...dailyLineup.bench];

    const playerToMove = draggingPlayerId;
    const playerAtTarget = target.type === 'active' ? newActiveLineup[target.slot] : newBench[target.index];

    // Verify player position eligibility for the target slot
    if (target.type === 'active') {
      const p = playersMap[playerToMove];
      const slotPos = target.slot.charAt(0); // 'F', 'D', or 'G'
      if (p.pos !== slotPos) {
        alert(`Cannot place non-${slotPos === 'F' ? 'Forward' : slotPos === 'D' ? 'Defenseman' : 'Goalie'} ${p.name} in slot ${target.slot}.`);
        return;
      }
    }
    // If swapping an active player back to the dragging source slot, verify their eligibility
    if (playerAtTarget && draggingSource.type === 'active') {
      const p = playersMap[playerAtTarget];
      const slotPos = draggingSource.slot.charAt(0); // 'F', 'D', or 'G'
      if (p.pos !== slotPos) {
        alert(`Cannot place non-${slotPos === 'F' ? 'Forward' : slotPos === 'D' ? 'Defenseman' : 'Goalie'} ${p.name} in slot ${draggingSource.slot}.`);
        return;
      }
    }

    // Verify target player is not locked
    const targetPlayer = playersMap[playerAtTarget];
    if (isPlayerLocked(targetPlayer)) {
      alert("Cannot swap: the other player's game has already started.");
      return;
    }

    if (draggingSource.type === 'active') {
      newActiveLineup[draggingSource.slot] = null;
    } else {
      newBench = newBench.filter(id => id !== playerToMove);
    }

    if (target.type === 'active') {
      newActiveLineup[target.slot] = playerToMove;
    } else {
      newBench.push(playerToMove);
    }

    if (playerAtTarget) {
      if (draggingSource.type === 'active') {
        newActiveLineup[draggingSource.slot] = playerAtTarget;
      } else {
        newBench.push(playerAtTarget);
      }
    }

    newBench = newBench.filter(Boolean);

    setIsUpdating(true);
    try {
      await saveDailyLineup(activeLeagueId, myTeam.id, selectedDateStr, newActiveLineup, newBench);
      setDailyLineup({ activeLineup: newActiveLineup, bench: newBench });
    } catch (err) {
      console.error("Failed to save daily lineup:", err);
      alert(err.message);
    } finally {
      setIsUpdating(false);
      setDraggingPlayerId(null);
      setDraggingSource(null);
    }
  };

  const renderActiveRosterTable = () => {
    const slots = [];
    // Forwards F1..F6
    for (let i = 1; i <= fLimit; i++) slots.push({ key: `F${i}`, label: 'F', pos: 'F' });
    // Defense D1..D4
    for (let i = 1; i <= dLimit; i++) slots.push({ key: `D${i}`, label: 'D', pos: 'D' });
    // Goalies G1
    for (let i = 1; i <= gLimit; i++) slots.push({ key: `G${i}`, label: 'G', pos: 'G' });

    return (
      <div className="overflow-x-auto rounded-2xl border border-slate-200/80 shadow-sm bg-white mb-8">
        <table className="w-full text-left border-collapse min-w-[600px]">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200">
              <th className="px-4 py-3 text-[10px] font-black uppercase tracking-widest text-slate-500">Slot</th>
              <th className="px-4 py-3 text-[10px] font-black uppercase tracking-widest text-slate-500">Player</th>
              <th className="px-4 py-3 text-[10px] font-black uppercase tracking-widest text-slate-500">Team</th>
              <th className="px-4 py-3 text-[10px] font-black uppercase tracking-widest text-slate-500">Daily Pts</th>
              <th className="px-4 py-3 text-[10px] font-black uppercase tracking-widest text-slate-500 text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {slots.map(slot => {
              const pId = dailyLineup.activeLineup[slot.key];
              const p = pId ? playersMap[pId] : null;
              const isLocked = p ? isPlayerLocked(p) : false;


              return (
                <tr 
                  key={slot.key} 
                  className={`hover:bg-slate-50 transition-colors ${!isReadOnly && !isLocked ? 'cursor-grab' : ''}`}
                  draggable={!isReadOnly && !isLocked && !!p}
                  onDragStart={(e) => handleDragStart(e, pId, { type: 'active', slot: slot.key })}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => handleDrop(e, { type: 'active', slot: slot.key })}
                >
                  <td className="px-4 py-3 whitespace-nowrap w-16">
                    <span className="text-xs font-semibold text-slate-500">
                      {slot.key}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {p ? (
                      <>
                        <div className="flex items-center gap-2 cursor-pointer group flex-wrap" onClick={() => handlePlayerClick(p)}>
                          <span className="text-sm font-bold text-slate-900 group-hover:text-indigo-600 transition-colors">{p.name}</span>
                          {isLocked && <Lock className="w-3.5 h-3.5 text-amber-500 inline" />}
                          {(leagueData?.undroppable_players || []).includes(String(p.id)) && (
                            <span className="text-[8px] font-black text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded-lg flex items-center gap-1 shrink-0">
                              <Shield className="w-2.5 h-2.5 text-amber-600" /> CAN'T CUT
                            </span>
                          )}
                        </div>
                        <div className="text-[10px] text-slate-500 font-semibold tracking-wide uppercase mt-0.5 truncate max-w-[250px]">
                          {p.stats}
                        </div>
                      </>
                    ) : (
                      <span className="text-xs font-semibold text-slate-400 italic">Empty Slot</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {p ? (
                      <PwhlTeamLabel code={p.team} className="text-[10px] font-black text-slate-700 bg-slate-100 px-2 py-0.5 rounded-lg border border-slate-200" />
                    ) : '-'}
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-sm font-sports font-bold text-indigo-600">
                      {p ? (dailyPointsMap[p.id] || 0.0).toFixed(1) : '0.0'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {p && !isReadOnly && !isLocked && (
                      <button 
                        onClick={() => handleMoveToBench(p.id, slot.key)}
                        disabled={isUpdating}
                        className="px-3 py-1.5 bg-slate-100 border border-slate-200 text-slate-700 hover:border-rose-300 hover:text-rose-600 rounded-xl text-[10px] font-black uppercase tracking-wider transition-all shadow-xs active:scale-95 cursor-pointer"
                      >
                        Bench
                      </button>
                    )}
                    {isLocked && p && (
                      <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest px-2">LOCKED</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  };

  const renderBenchTable = () => {
    const benchPlayers = dailyLineup.bench.map(pId => playersMap[pId]).filter(Boolean);

    return (
      <div 
        className="overflow-x-auto rounded-2xl border border-slate-200/80 shadow-sm bg-white mb-8"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => handleDrop(e, { type: 'bench', index: dailyLineup.bench.length })}
      >
        <table className="w-full text-left border-collapse min-w-[600px]">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200">
              <th className="px-4 py-3 text-[10px] font-black uppercase tracking-widest text-slate-500">Pos</th>
              <th className="px-4 py-3 text-[10px] font-black uppercase tracking-widest text-slate-500">Player</th>
              <th className="px-4 py-3 text-[10px] font-black uppercase tracking-widest text-slate-500">Team</th>
              <th className="px-4 py-3 text-[10px] font-black uppercase tracking-widest text-slate-500">Daily Pts</th>
              <th className="px-4 py-3 text-[10px] font-black uppercase tracking-widest text-slate-500 text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {benchPlayers.length === 0 && (
              <tr>
                <td colSpan="5" className="px-4 py-8 text-center text-xs font-bold text-slate-400 italic">
                  No players on the bench.
                </td>
              </tr>
            )}
            {benchPlayers.map((p, idx) => {
              const isLocked = isPlayerLocked(p);
              
              const positionSlots = [];
              if (p.pos === 'F') {
                for (let i = 1; i <= fLimit; i++) positionSlots.push(`F${i}`);
              } else if (p.pos === 'D') {
                for (let i = 1; i <= dLimit; i++) positionSlots.push(`D${i}`);
              } else if (p.pos === 'G') {
                for (let i = 1; i <= gLimit; i++) positionSlots.push(`G${i}`);
              }
              
              const emptySlotExists = positionSlots.some(s => !dailyLineup.activeLineup[s]);


              return (
                <tr 
                  key={p.id} 
                  className={`hover:bg-slate-50 transition-colors ${!isReadOnly && !isLocked ? 'cursor-grab' : ''}`}
                  draggable={!isReadOnly && !isLocked}
                  onDragStart={(e) => handleDragStart(e, p.id, { type: 'bench', index: idx })}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => handleDrop(e, { type: 'bench', index: idx })}
                >
                  <td className="px-4 py-3 whitespace-nowrap w-16">
                    <span className="text-xs font-semibold text-slate-500">
                      {p.pos}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2 cursor-pointer group flex-wrap" onClick={() => handlePlayerClick(p)}>
                      <span className="text-sm font-bold text-slate-900 group-hover:text-indigo-600 transition-colors">{p.name}</span>
                      {isLocked && <Lock className="w-3.5 h-3.5 text-amber-500 inline" />}
                      {(leagueData?.undroppable_players || []).includes(String(p.id)) && (
                        <span className="text-[8px] font-black text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded-lg flex items-center gap-1 shrink-0">
                          <Shield className="w-2.5 h-2.5 text-amber-600" /> CAN'T CUT
                        </span>
                      )}
                    </div>
                    <div className="text-[10px] text-slate-500 font-semibold tracking-wide uppercase mt-0.5 truncate max-w-[250px]">
                      {p.stats}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <PwhlTeamLabel code={p.team} className="text-[10px] font-black text-slate-700 bg-slate-100 px-2 py-0.5 rounded-lg border border-slate-200" />
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-sm font-sports font-bold text-indigo-600">
                      {(dailyPointsMap[p.id] || 0.0).toFixed(1)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {!isReadOnly && !isLocked && (
                      <div className="flex items-center justify-end gap-2">
                        {emptySlotExists ? (
                          <button 
                            onClick={() => handleMoveToActive(p.id)}
                            disabled={isUpdating}
                            className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-[10px] font-black uppercase tracking-wider transition-all shadow-xs active:scale-95 cursor-pointer"
                          >
                            Activate
                          </button>
                        ) : (
                          <select 
                            defaultValue="" 
                            onChange={(e) => {
                              if (e.target.value) {
                                handleSwapFromSelect(p.id, e.target.value);
                                e.target.value = "";
                              }
                            }} 
                            disabled={isUpdating}
                            className="px-2.5 py-1.5 bg-slate-50 border border-slate-200 text-slate-700 hover:border-indigo-500 rounded-xl text-[10px] font-black uppercase tracking-wider shadow-xs cursor-pointer"
                          >
                            <option value="" disabled>Swap with...</option>
                            {positionSlots.map(s => {
                              const activeP = playersMap[dailyLineup.activeLineup[s]];
                              return (
                                <option key={s} value={s}>
                                  {s}: {activeP ? activeP.name : 'Empty'}
                                </option>
                              );
                            })}
                          </select>
                        )}
                      </div>
                    )}
                    {isLocked && (
                      <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest px-2">LOCKED</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  };

  return (
    <div className="font-sans select-none antialiased text-slate-800">
      <header className="mb-6 flex justify-between items-end flex-wrap gap-4 border-b pb-4" style={{ borderColor: '#E5E5E3' }}>
        <div>
          <h1 className="font-sports text-2xl font-bold tracking-tight text-slate-800">
            {myTeam?.teamName || 'My Team Roster'}
          </h1>
          <p className="text-xs text-slate-500 font-medium mt-0.5 flex items-center gap-2 flex-wrap">Manage daily starting lineups and lock in active players. <LiveBadge liveDay={liveDay} /></p>
        </div>
      </header>

      {/* Date Toggle strip */}
      <div className="mb-6 bg-white border border-slate-200/80 rounded-2xl p-3 shadow-sm">
        <div className="flex justify-between items-center mb-3 px-1 select-none">
          <button
            onClick={() => {
              const currentD = parseDateStr(selectedDateStr);
              currentD.setDate(currentD.getDate() - 7);
              setSelectedDateStr(getLocalDateStr(currentD));
            }}
            disabled={resolvedCurrentWeek <= 1}
            className="px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-xl hover:bg-slate-100 text-[10px] font-black uppercase tracking-wider text-indigo-700 shadow-xs disabled:opacity-40 active:scale-95 transition-all cursor-pointer disabled:cursor-not-allowed flex items-center gap-1"
          >
            <ChevronLeft className="w-3.5 h-3.5" /> Week
          </button>
          <span className="text-[10px] font-black uppercase text-slate-500 tracking-widest text-center">
            Week {resolvedCurrentWeek} Days
          </span>
          <button
            onClick={() => {
              const currentD = parseDateStr(selectedDateStr);
              currentD.setDate(currentD.getDate() + 7);
              setSelectedDateStr(getLocalDateStr(currentD));
            }}
            disabled={seasonWeeks.length > 0 && resolvedCurrentWeek >= seasonWeeks.length}
            className="px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-xl hover:bg-slate-100 text-[10px] font-black uppercase tracking-wider text-indigo-700 shadow-xs disabled:opacity-40 active:scale-95 transition-all cursor-pointer disabled:cursor-not-allowed flex items-center gap-1"
          >
            Week <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
        
        <div className="flex gap-2.5 overflow-x-auto pb-2 pt-1 px-1 scrollbar-none snap-x select-none">
          {weekDates.map(day => {
            const isSelected = day.dateStr === selectedDateStr;
            const isToday = day.dateStr === getLocalDateStr(simDate);
            return (
              <button
                key={day.dateStr}
                onClick={() => setSelectedDateStr(day.dateStr)}
                className={`flex-1 min-w-[72px] py-2.5 px-2 rounded-xl flex flex-col items-center justify-center transition-all border snap-center cursor-pointer ${
                  isSelected
                    ? 'bg-slate-700 text-white border-slate-700'
                    : 'bg-slate-50 text-slate-700 border-slate-200 hover:border-slate-300'
                }`}
              >
                <span className={`text-[10px] font-semibold uppercase tracking-wider ${isSelected ? 'text-slate-200' : 'text-slate-500'}`}>
                  {day.label.split(' ')[0]}
                </span>
                <span className="text-sm font-bold mt-0.5">
                  {day.date.getDate()}
                </span>
                {isToday && (
                  <span className={`w-1.5 h-1.5 rounded-full mt-1 ${isSelected ? 'bg-white' : 'bg-slate-700'}`}></span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {isReadOnly && (
        <div className="mb-6 p-3.5 bg-amber-50 border border-amber-200 rounded-xl flex items-center gap-3">
          <Lock className="w-4 h-4 text-amber-600 shrink-0" />
          <div>
            <h4 className="text-xs font-bold text-amber-800">Lineup is read-only</h4>
            <p className="text-[11px] text-amber-700 font-medium mt-0.5">
              {isPending ? "Roster is locked until the draft starts." : "This date is in the past and cannot be edited."}
            </p>
          </div>
        </div>
      )}

      {lineupLoading ? (
        <div className="min-h-[40vh] flex items-center justify-center">
          <div className="text-xs font-black tracking-widest text-slate-400 uppercase animate-pulse">Syncing Daily Lineup...</div>
        </div>
      ) : (
        <div className={`${isPending ? 'blur-[1.5px] opacity-45 pointer-events-none' : ''} transition-all duration-300`}>
          <h3 className="text-xs font-bold text-slate-700 mb-3 flex items-center gap-2">
            <Activity className="w-3.5 h-3.5 text-slate-500" /> Active Starters for {selectedDateStr}
          </h3>
          {renderActiveRosterTable()}

          <h3 className="text-xs font-bold text-slate-700 mb-3 flex items-center gap-2 mt-6">
            <Users className="w-3.5 h-3.5 text-slate-500" /> Bench
          </h3>
          {renderBenchTable()}
        </div>
      )}

      <PlayerCardModal 
        player={selectedCardPlayer} 
        onClose={() => setSelectedCardPlayer(null)} 
      />
    </div>
  );
}
