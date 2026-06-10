import React, { useState, useEffect, useRef } from 'react';
import { db } from '../firebase.js';
import { doc, getDoc, collection, query, where, getDocs } from 'firebase/firestore';
import { useAuth } from '../contexts/AuthContext';
import { useTimeTravel } from '../contexts/TimeTravelContext';
import { normalizePosition, fetchPlayerGameHistory } from '../services/pwhlService';
import { saveDailyLineup, getDailyLineup, getLocalDateStr } from '../services/leagueService';
import PlayerCardModal from './PlayerCardModal';

export default function Roster({ activeLeagueId }) {
  const { currentUser } = useAuth();
  const { activeSeasonId, getSimulatedDate } = useTimeTravel();
  
  const [loading, setLoading] = useState(true);
  const [loadingLeague, setLoadingLeague] = useState(true);
  const [myTeam, setMyTeam] = useState(null);
  const [leagueData, setLeagueData] = useState(null);
  const [playersMap, setPlayersMap] = useState({});
  const [isUpdating, setIsUpdating] = useState(false);
  const [selectedCardPlayer, setSelectedCardPlayer] = useState(null);
  const [gameHistory, setGameHistory] = useState([]);

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
  const lastSimDateStrRef = useRef('');
  const lastLeagueIdRef = useRef('');
  const lastWeekRef = useRef(null);
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
        const seasonId = activeSeasonId ? String(activeSeasonId) : '5';
        const seasonDoc = await getDoc(doc(db, 'pwhl_seasons', seasonId));
        let weeks = [];
        if (seasonDoc.exists() && seasonDoc.data().weeks) {
          weeks = seasonDoc.data().weeks;
        }
        setSeasonWeeks(weeks);

        const targetDate = parseDateStr(selectedDateStr);
        let cw = leagueData.currentWeek || 1;

        if (weeks.length > 0) {
          const matchedWeek = weeks.find(w => {
            const s = new Date(w.start);
            const e = new Date(w.end);
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
          const baseTime = new Date("2024-01-01T03:00:00-08:00").getTime();
          const weekMs = 7 * 24 * 60 * 60 * 1000;
          const start = new Date(baseTime + (cw - 1) * weekMs);
          weekStartStr = start.toISOString();
        }

        const weekStart = new Date(weekStartStr);
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

  // Load dynamic players map & daily stats
  useEffect(() => {
    if (!activeLeagueId || !leagueData || !selectedDateStr) return;
    
    async function loadDynamicPlayersAndStats() {
      setLineupLoading(true);
      try {
        const seasonsSnap = await getDocs(collection(db, 'pwhl_seasons'));
        const seasons = seasonsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        
        const seasonId = activeSeasonId ? String(activeSeasonId) : '5';
        const qActive = query(collection(db, 'pwhl_players'), where('season_id', 'in', [seasonId, Number(seasonId)]));
        const snapActive = await getDocs(qActive);
        
        let resolvedSeasonId = seasonId;
        let rawPlayers = snapActive.docs.map(d => d.data());
        let isFallback = false;
        
        const currentSeasonDoc = seasons.find(s => String(s.season_id) === String(seasonId));

        if (rawPlayers.length === 0 && seasons.length > 0) {
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
            isFallback = true;
            
            const qPrev = query(collection(db, 'pwhl_players'), where('season_id', 'in', [resolvedSeasonId, Number(resolvedSeasonId)]));
            const snapPrev = await getDocs(qPrev);
            rawPlayers = snapPrev.docs.map(d => d.data());
          }
        }
        
        const teamsQuery = query(collection(db, 'pwhl_teams'), where('season_id', 'in', [resolvedSeasonId, Number(resolvedSeasonId)]));
        const teamsSnap = await getDocs(teamsQuery);
        const teamsMap = {};
        teamsSnap.forEach(d => {
          const t = d.data();
          teamsMap[String(t.id)] = { code: t.code || t.name || t.id, logo: t.team_logo_url || '' };
        });
        
        // Fetch daily stats for the selected date
        let statsData = { skaters: {}, goalies: {} };
        let pointsMap = {};

        if (!isFallback) {
          const { fetchWeeklyPlayerPoints } = await import('../services/statsEngine');
          const simDate = getSimulatedDate();
          
          const dayStart = new Date(selectedDateStr);
          dayStart.setHours(0, 0, 0, 0);
          const dayEnd = new Date(selectedDateStr);
          dayEnd.setHours(23, 59, 59, 999);
          
          const result = await fetchWeeklyPlayerPoints(resolvedSeasonId, dayStart, dayEnd, simDate, leagueData?.scoringSettings);
          statsData = { skaters: result.skaters, goalies: result.goalies };
          pointsMap = result.pointsMap || {};
          setDailyPointsMap(pointsMap);
        }
        
        const map = {};
        rawPlayers.forEach(p => {
          const pId = p.player_id || p.id;
          if (!pId) return;
          
          const normPos = normalizePosition(p.position);
          const isGoalie = normPos === 'G';
          let gp = 0, g_w = 0, a_otl = 0, pm_ga = 0, sog_sv = 0;
          let statsStr = '';
          
          if (!isFallback) {
            if (isGoalie) {
              const g = statsData.goalies[pId] || {};
              gp = g.gamesPlayed || 0;
              g_w = g.wins || 0;
              pm_ga = g.goalsAgainst || 0;
              sog_sv = g.shotsSaved || 0;
              const gaa = gp > 0 ? (pm_ga / gp).toFixed(2) : '0.00';
              statsStr = `${g_w}W, ${sog_sv}SV, ${gaa}GAA`;
            } else {
              const s = statsData.skaters[pId] || {};
              gp = s.gamesPlayed || 0;
              g_w = s.goals || 0;
              a_otl = s.assists || 0;
              pm_ga = s.plusMinus || 0;
              statsStr = `${g_w}G, ${a_otl}A, ${pm_ga > 0 ? `+${pm_ga}` : pm_ga} +/-`;
            }
          } else {
            statsStr = isGoalie ? '0W, 0SV, 0.00GAA' : '0G, 0A, 0 +/-';
          }
          
          const rating = p.rating || (isGoalie ? 85 : (normPos === 'D' ? 82 : 84));
          const actualTeamId = String(p.current_team_id || p.team_id || '');
          
          map[String(pId)] = {
            ...p,
            id: String(pId),
            name: p.name || `${p.first_name || ''} ${p.last_name || ''}`.trim() || 'Unknown Player',
            pos: normPos,
            jersey_number: p.tp_jersey_number || p.jersey_number || '',
            teamId: actualTeamId,
            teamCode: teamsMap[actualTeamId]?.code || p.team_name || 'FA',
            teamLogo: teamsMap[actualTeamId]?.logo,
            team: teamsMap[actualTeamId]?.code || p.team_name || 'FA',
            rating,
            stats: statsStr,
            points: pointsMap[pId] || 0.0,
            raw: p
          };
        });
        
        setPlayersMap(map);

        // Fetch daily games list for the selected date
        const gListSnap = await getDocs(query(collection(db, 'pwhl_games'), where('season_id', 'in', [resolvedSeasonId, Number(resolvedSeasonId)])));
        const gList = gListSnap.docs.map(d => d.data());
        const dailyGames = gList.filter(g => {
          const gDateStr = g.date_played || g.date;
          if (!gDateStr) return false;
          return getLocalDateStr(new Date(gDateStr)) === selectedDateStr;
        });
        setPwhlGamesToday(dailyGames);

        // Fetch daily lineup state
        if (myTeam) {
          const lineup = await getDailyLineup(activeLeagueId, myTeam.id, selectedDateStr);
          setDailyLineup(lineup);
        }
      } catch (err) {
        console.error("Error loading dynamic players and stats:", err);
      } finally {
        setLineupLoading(false);
      }
    }
    
    loadDynamicPlayersAndStats();
  }, [activeLeagueId, activeSeasonId, leagueData, selectedDateStr, myTeam?.id]);

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

  if (loading || loadingLeague) {
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

  const getTeamBranding = (teamCode) => {
    switch (teamCode) {
      case 'BOS':
        return { gradient: 'from-emerald-800 to-slate-900', borderColor: 'border-emerald-500/35', glowColor: 'shadow-emerald-500/10' };
      case 'MIN':
        return { gradient: 'from-purple-800 to-slate-900', borderColor: 'border-purple-500/35', glowColor: 'shadow-purple-500/10' };
      case 'MTL':
        return { gradient: 'from-rose-900 to-slate-900', borderColor: 'border-rose-500/35', glowColor: 'shadow-rose-500/10' };
      case 'NY':
        return { gradient: 'from-teal-800 to-slate-900', borderColor: 'border-teal-500/35', glowColor: 'shadow-teal-500/10' };
      case 'OTT':
        return { gradient: 'from-red-800 to-slate-900', borderColor: 'border-red-500/35', glowColor: 'shadow-red-500/10' };
      case 'TOR':
        return { gradient: 'from-blue-900 to-slate-900', borderColor: 'border-blue-500/35', glowColor: 'shadow-blue-500/10' };
      default:
        return { gradient: 'from-indigo-900 to-slate-900', borderColor: 'border-indigo-500/35', glowColor: 'shadow-indigo-500/10' };
    }
  };

  const handlePlayerClick = async (p) => {
    const owner = myTeam ? { label: myTeam.name, color: 'bg-indigo-50 text-indigo-600 border-indigo-200' } : null;
    let gp = 0, g_w = 0, a_otl = 0, pm_ga = 0, sog_sv = 0, blk_so = 0, hits = 0;
    if (p.raw) {
      gp = p.raw.gp || 0;
      g_w = p.raw.g_w || 0;
      a_otl = p.raw.a_otl || 0;
      pm_ga = p.raw.pm_ga || 0;
      sog_sv = p.raw.sog_sv || 0;
      blk_so = p.raw.blk_so || 0;
      hits = p.raw.hits || 0;
    }
    const tCode = p.teamCode || p.team || 'FA';
    const playerObj = {
      ...p,
      owner,
      gp, g_w, a_otl, pm_ga, sog_sv, blk_so, hits
    };
    setSelectedCardPlayer(playerObj);
    setGameHistory([]);
    const history = await fetchPlayerGameHistory(p.id, p.pos, tCode, activeSeasonId, getSimulatedDate(), leagueData?.scoringSettings);
    setGameHistory(history);
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

    const slots = p.pos === 'F' ? ['F1', 'F2', 'F3', 'F4', 'F5', 'F6'] :
                  p.pos === 'D' ? ['D1', 'D2', 'D3', 'D4'] : ['G1'];
    
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
      <div className="overflow-x-auto rounded-xl border border-gray-200 shadow-sm bg-white mb-8">
        <table className="w-full text-left border-collapse min-w-[600px]">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              <th className="px-4 py-3 text-[10px] font-black uppercase tracking-widest text-gray-400">Slot</th>
              <th className="px-4 py-3 text-[10px] font-black uppercase tracking-widest text-gray-400">Player</th>
              <th className="px-4 py-3 text-[10px] font-black uppercase tracking-widest text-gray-400">Team</th>
              <th className="px-4 py-3 text-[10px] font-black uppercase tracking-widest text-gray-400">Daily Pts</th>
              <th className="px-4 py-3 text-[10px] font-black uppercase tracking-widest text-gray-400 text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {slots.map(slot => {
              const pId = dailyLineup.activeLineup[slot.key];
              const p = pId ? playersMap[pId] : null;
              const isLocked = p ? isPlayerLocked(p) : false;

              let posColor = "bg-gray-100 text-gray-600 border-gray-200";
              if (slot.pos === 'F') posColor = "bg-indigo-50 text-indigo-600 border-indigo-100";
              if (slot.pos === 'D') posColor = "bg-emerald-50 text-emerald-600 border-emerald-100";
              if (slot.pos === 'G') posColor = "bg-purple-50 text-purple-600 border-purple-100";

              return (
                <tr 
                  key={slot.key} 
                  className={`hover:bg-gray-50/50 transition-colors ${!isReadOnly && !isLocked ? 'cursor-grab' : ''}`}
                  draggable={!isReadOnly && !isLocked && !!p}
                  onDragStart={(e) => handleDragStart(e, pId, { type: 'active', slot: slot.key })}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => handleDrop(e, { type: 'active', slot: slot.key })}
                >
                  <td className="px-4 py-3 whitespace-nowrap w-16">
                    <span className={`text-[10px] font-black uppercase px-2 py-1 rounded border tracking-widest ${posColor}`}>
                      {slot.key}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {p ? (
                      <>
                        <div className="flex items-center gap-2 cursor-pointer group" onClick={() => handlePlayerClick(p)}>
                          <span className="text-sm font-bold text-gray-900 group-hover:text-indigo-600 transition-colors">{p.name}</span>
                          {isLocked && <span title="Locked" className="text-xs">🔒</span>}
                        </div>
                        <div className="text-[10px] text-gray-500 font-semibold tracking-wide uppercase mt-0.5 truncate max-w-[250px]">
                          {p.stats}
                        </div>
                      </>
                    ) : (
                      <span className="text-xs font-semibold text-gray-300 italic">Empty Slot</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {p ? (
                      <span className="text-[10px] font-black text-gray-600 bg-gray-100 px-1.5 py-0.5 rounded border border-gray-200">
                        {p.team}
                      </span>
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
                        className="px-3 py-1.5 bg-white border border-gray-200 text-gray-600 hover:border-red-300 hover:text-red-600 rounded-lg text-[10px] font-black uppercase tracking-wider transition-all shadow-sm active:scale-95"
                      >
                        Bench
                      </button>
                    )}
                    {isLocked && p && (
                      <span className="text-[10px] font-black text-gray-300 uppercase tracking-widest px-2">LOCKED</span>
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
        className="overflow-x-auto rounded-xl border border-gray-200 shadow-sm bg-white mb-8"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => handleDrop(e, { type: 'bench', index: dailyLineup.bench.length })}
      >
        <table className="w-full text-left border-collapse min-w-[600px]">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              <th className="px-4 py-3 text-[10px] font-black uppercase tracking-widest text-gray-400">Pos</th>
              <th className="px-4 py-3 text-[10px] font-black uppercase tracking-widest text-gray-400">Player</th>
              <th className="px-4 py-3 text-[10px] font-black uppercase tracking-widest text-gray-400">Team</th>
              <th className="px-4 py-3 text-[10px] font-black uppercase tracking-widest text-gray-400">Daily Pts</th>
              <th className="px-4 py-3 text-[10px] font-black uppercase tracking-widest text-gray-400 text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {benchPlayers.length === 0 && (
              <tr>
                <td colSpan="5" className="px-4 py-8 text-center text-xs font-bold text-gray-400 italic">
                  No players on the bench.
                </td>
              </tr>
            )}
            {benchPlayers.map((p, idx) => {
              const isLocked = isPlayerLocked(p);
              
              // Resolve active slots of same position for swapping
              const positionSlots = [];
              if (p.pos === 'F') {
                for (let i = 1; i <= fLimit; i++) positionSlots.push(`F${i}`);
              } else if (p.pos === 'D') {
                for (let i = 1; i <= dLimit; i++) positionSlots.push(`D${i}`);
              } else if (p.pos === 'G') {
                for (let i = 1; i <= gLimit; i++) positionSlots.push(`G${i}`);
              }
              
              const emptySlotExists = positionSlots.some(s => !dailyLineup.activeLineup[s]);

              let posColor = "bg-gray-100 text-gray-600";
              if (p.pos === 'F') posColor = "bg-indigo-50 text-indigo-600 border-indigo-100";
              if (p.pos === 'D') posColor = "bg-emerald-50 text-emerald-600 border-emerald-100";
              if (p.pos === 'G') posColor = "bg-purple-50 text-purple-600 border-purple-100";

              return (
                <tr 
                  key={p.id} 
                  className={`hover:bg-gray-50/50 transition-colors ${!isReadOnly && !isLocked ? 'cursor-grab' : ''}`}
                  draggable={!isReadOnly && !isLocked}
                  onDragStart={(e) => handleDragStart(e, p.id, { type: 'bench', index: idx })}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => handleDrop(e, { type: 'bench', index: idx })}
                >
                  <td className="px-4 py-3 whitespace-nowrap w-16">
                    <span className={`text-[10px] font-black uppercase px-2 py-1 rounded border tracking-widest ${posColor}`}>
                      {p.pos}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2 cursor-pointer group" onClick={() => handlePlayerClick(p)}>
                      <span className="text-sm font-bold text-gray-900 group-hover:text-indigo-600 transition-colors">{p.name}</span>
                      {isLocked && <span title="Locked" className="text-xs">🔒</span>}
                    </div>
                    <div className="text-[10px] text-gray-500 font-semibold tracking-wide uppercase mt-0.5 truncate max-w-[250px]">
                      {p.stats}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-[10px] font-black text-gray-600 bg-gray-100 px-1.5 py-0.5 rounded border border-gray-200">
                      {p.team}
                    </span>
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
                            className="px-3 py-1.5 bg-white border border-gray-200 text-gray-600 hover:border-indigo-300 hover:text-indigo-600 rounded-lg text-[10px] font-black uppercase tracking-wider transition-all shadow-sm active:scale-95"
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
                            className="px-2.5 py-1.5 bg-white border border-gray-200 text-gray-600 hover:border-indigo-300 rounded-lg text-[10px] font-black uppercase tracking-wider shadow-sm"
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
                      <span className="text-[10px] font-black text-gray-300 uppercase tracking-widest px-2">LOCKED</span>
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
    <div className="font-sans select-none antialiased">
      <header className="mb-6 flex justify-between items-end flex-wrap gap-4">
        <div>
          <span className="text-[10px] uppercase font-black tracking-widest text-indigo-600 bg-indigo-50 px-3 py-1.5 rounded-full border border-indigo-100 shadow-sm shadow-indigo-100/10">
            {myTeam.teamName}
          </span>
          <h1 className="font-sports text-3xl font-black mt-3 tracking-tight text-gray-900">
            My Roster Lineup
          </h1>
          <p className="text-xs text-gray-400 font-semibold tracking-wide mt-0.5">Manage daily starting lineups and lock in your active players.</p>
        </div>
        
        <div className="text-right">
           <div className="text-[10px] uppercase tracking-widest text-gray-400 font-black mb-1">Week {resolvedCurrentWeek} Roster Status</div>
           <div className="flex gap-2">
             <span className="text-xs font-bold px-2.5 py-1.5 rounded bg-indigo-50 text-indigo-600 border border-indigo-100">Starters Mon-Sun</span>
           </div>
        </div>
      </header>

      {/* Date Toggle strip */}
      <div className="mb-6 bg-gray-50 border border-gray-200 rounded-[24px] p-3 shadow-sm">
        <div className="flex justify-between items-center mb-3 px-1 select-none">
          <button
            onClick={() => {
              const currentD = parseDateStr(selectedDateStr);
              currentD.setDate(currentD.getDate() - 7);
              setSelectedDateStr(getLocalDateStr(currentD));
            }}
            disabled={resolvedCurrentWeek <= 1}
            className="px-3 py-1.5 bg-white border border-gray-200 rounded-xl hover:bg-gray-50 text-[10px] font-black uppercase tracking-wider text-indigo-600 shadow-sm disabled:opacity-40 disabled:hover:bg-white active:scale-95 transition-all cursor-pointer disabled:cursor-not-allowed"
          >
            ◀ Week
          </button>
          <span className="text-[10px] font-black uppercase text-gray-400 tracking-widest text-center">
            Week {resolvedCurrentWeek} Days
          </span>
          <button
            onClick={() => {
              const currentD = parseDateStr(selectedDateStr);
              currentD.setDate(currentD.getDate() + 7);
              setSelectedDateStr(getLocalDateStr(currentD));
            }}
            disabled={seasonWeeks.length > 0 && resolvedCurrentWeek >= seasonWeeks.length}
            className="px-3 py-1.5 bg-white border border-gray-200 rounded-xl hover:bg-gray-50 text-[10px] font-black uppercase tracking-wider text-indigo-600 shadow-sm disabled:opacity-40 disabled:hover:bg-white active:scale-95 transition-all cursor-pointer disabled:cursor-not-allowed"
          >
            Week ▶
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
                className={`flex-1 min-w-[76px] py-3 px-2 rounded-2xl flex flex-col items-center justify-center transition-all border snap-center ${
                  isSelected
                    ? 'bg-gradient-to-br from-indigo-600 to-indigo-700 text-white border-indigo-500 shadow-md shadow-indigo-600/15 scale-105'
                    : 'bg-white text-gray-700 border-gray-200 hover:border-indigo-200'
                }`}
              >
                <span className={`text-[10px] font-black uppercase tracking-wider ${isSelected ? 'text-indigo-100' : 'text-gray-400'}`}>
                  {day.label.split(' ')[0]}
                </span>
                <span className="text-sm font-sports font-black mt-1">
                  {day.date.getDate()}
                </span>
                {isToday && (
                  <span className={`w-1.5 h-1.5 rounded-full mt-1.5 ${isSelected ? 'bg-white' : 'bg-indigo-600'}`}></span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {isReadOnly && (
        <div className="mb-6 p-4 bg-amber-50 border border-amber-100 rounded-3xl flex items-center gap-3 animate-scale-up">
          <div className="w-10 h-10 rounded-2xl bg-white border border-amber-100 flex items-center justify-center text-xl text-amber-600 shadow-sm">
            🔒
          </div>
          <div>
            <h4 className="text-xs font-black uppercase tracking-wider text-amber-900">Lineup is read-only</h4>
            <p className="text-[10px] text-amber-600 font-semibold mt-0.5 leading-normal">
              {isPending ? "Roster is locked until the draft starts." : "This date is in the past and cannot be edited."}
            </p>
          </div>
        </div>
      )}

      {lineupLoading ? (
        <div className="min-h-[40vh] flex items-center justify-center">
          <div className="text-xs font-black tracking-widest text-gray-300 uppercase animate-pulse">Syncing Daily Lineup...</div>
        </div>
      ) : (
        <div className={`${isPending ? 'blur-[1.5px] opacity-45 pointer-events-none' : ''} transition-all duration-300`}>
          <h3 className="text-sm font-black uppercase tracking-wider text-gray-900 mb-3 ml-1 flex items-center gap-2">
            <span>⛸️</span> Active Starters for {selectedDateStr}
          </h3>
          {renderActiveRosterTable()}

          <h3 className="text-sm font-black uppercase tracking-wider text-gray-900 mb-3 ml-1 flex items-center gap-2 mt-4">
            <span>🛋️</span> Bench
          </h3>
          {renderBenchTable()}
        </div>
      )}

      <PlayerCardModal 
        player={selectedCardPlayer} 
        gameHistory={gameHistory} 
        teamBranding={selectedCardPlayer ? getTeamBranding(selectedCardPlayer.teamCode) : {}} 
        onClose={() => setSelectedCardPlayer(null)} 
      />
    </div>
  );
}
