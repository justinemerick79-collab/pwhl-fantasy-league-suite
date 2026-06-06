import React, { useState, useEffect, useRef } from 'react';
import { db } from '../firebase.js';
import { 
  doc, 
  getDoc, 
  getDocs, 
  collection, 
  query, 
  where, 
  onSnapshot,
  updateDoc
} from 'firebase/firestore';
import { useAuth } from '../contexts/AuthContext';
import { useTimeTravel } from '../contexts/TimeTravelContext';
import { initializeDraft, submitDraftPick, toggleAutoDraftStatus } from '../services/leagueService';
import { fetchDraftEligiblePlayers } from '../services/pwhlService';

export default function DraftRoom({ activeLeagueId, setCurrentTab }) {
  const { currentUser } = useAuth();
  const { activeSeasonId, getSimulatedDate, simulationState } = useTimeTravel();

  const [leagueData, setLeagueData] = useState(null);
  const [teams, setTeams] = useState([]);
  const [draftState, setDraftState] = useState(null);
  const [loading, setLoading] = useState(true);

  // PWHL Player Universe
  const [allPlayers, setAllPlayers] = useState([]);
  const [pwhlTeams, setPwhlTeams] = useState({});
  const [playersLoading, setPlayersLoading] = useState(true);

  // Search & Filter States
  const [searchQuery, setSearchQuery] = useState('');
  const [posFilter, setPosFilter] = useState('ALL'); // 'ALL' | 'F' | 'D' | 'G'

  // Stat view toggle & player card modal
  const [statViewMode, setStatViewMode] = useState('projections');
  const [selectedCardPlayer, setSelectedCardPlayer] = useState(null);
  const [prevSeasonId, setPrevSeasonId] = useState(null);

  // Tabs within Draft Room: 'lobby' | 'rosters'
  const [subTab, setSubTab] = useState('lobby'); 
  const [selectedRosterUserId, setSelectedRosterUserId] = useState(null);
  const [selectedRecapTab, setSelectedRecapTab] = useState('round'); // 'round' | 'team'

  // Timer Countdown state
  const [secondsLeft, setSecondsLeft] = useState(60);
  const [lobbySecondsLeft, setLobbySecondsLeft] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Refs to hold current state to prevent stale closures inside timer loop
  const draftStateRef = useRef(null);
  draftStateRef.current = draftState;
  const allPlayersRef = useRef([]);
  allPlayersRef.current = allPlayers;
  const leagueDataRef = useRef(null);
  leagueDataRef.current = leagueData;
  const isSubmittingRef = useRef(false);
  isSubmittingRef.current = isSubmitting;
  const pwhlTeamsRef = useRef({});
  pwhlTeamsRef.current = pwhlTeams;

  // Team branding helper for player card modal
  const getTeamBranding = (teamCode) => {
    const brands = {
      BOS: { gradient: 'from-green-800 to-green-950', border: 'border-green-500', glow: 'shadow-green-500/20' },
      MIN: { gradient: 'from-purple-800 to-purple-950', border: 'border-purple-500', glow: 'shadow-purple-500/20' },
      MTL: { gradient: 'from-red-800 to-red-950', border: 'border-red-500', glow: 'shadow-red-500/20' },
      NY:  { gradient: 'from-sky-800 to-sky-950', border: 'border-sky-500', glow: 'shadow-sky-500/20' },
      OTT: { gradient: 'from-red-700 to-gray-900', border: 'border-red-400', glow: 'shadow-red-400/20' },
      TOR: { gradient: 'from-blue-800 to-blue-950', border: 'border-blue-500', glow: 'shadow-blue-500/20' },
    };
    return brands[teamCode] || { gradient: 'from-gray-700 to-gray-900', border: 'border-gray-500', glow: 'shadow-gray-500/20' };
  };

  // 1. Fetch PWHL Player Universe using centralized service (fixes team resolution)
  useEffect(() => {
    const loadPlayersAndTeams = async () => {
      setPlayersLoading(true);
      try {
        const seasonId = activeSeasonId ? String(activeSeasonId) : '5';
        const selectedSeasonId = statViewMode === 'projections' ? seasonId : prevSeasonId || seasonId;

        // Resolve prevSeasonId if not yet set
        if (!prevSeasonId) {
          const seasonsSnap = await getDocs(collection(db, 'pwhl_seasons'));
          const seasons = seasonsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
          const currentSeasonDoc = seasons.find(s => String(s.season_id) === String(seasonId));
          const currentStartDate = currentSeasonDoc ? new Date(currentSeasonDoc.start_date) : new Date();
          const prevRegularSeasons = seasons.filter(s => {
            const isRegular = (s.playoff === '0' || s.playoff === 0) && (s.career === '1' || s.career === 1);
            const startsBefore = new Date(s.start_date) < currentStartDate;
            return isRegular && startsBefore;
          });
          prevRegularSeasons.sort((a, b) => new Date(b.start_date) - new Date(a.start_date));
          if (prevRegularSeasons.length > 0) {
            setPrevSeasonId(String(prevRegularSeasons[0].season_id));
          }
        }

        // Use centralized service that correctly resolves teamId via current_team_id || latest_team_id || team_id
        const players = await fetchDraftEligiblePlayers(seasonId, selectedSeasonId);
        setAllPlayers(players);

        // Also fetch PWHL teams for display
        const teamsQuery = query(collection(db, 'pwhl_teams'), where('season_id', 'in', [seasonId, Number(seasonId)]));
        const teamsSnap = await getDocs(teamsQuery);
        const teamsMap = {};
        teamsSnap.forEach(d => {
          const t = d.data();
          teamsMap[String(t.id)] = {
            name: t.name,
            code: t.code || t.name || t.id,
            logo: t.team_logo_url || ''
          };
        });

        // Also try the previous season teams if current season has none
        if (Object.keys(teamsMap).length === 0 && prevSeasonId) {
          const prevTeamsQuery = query(collection(db, 'pwhl_teams'), where('season_id', 'in', [prevSeasonId, Number(prevSeasonId)]));
          const prevTeamsSnap = await getDocs(prevTeamsQuery);
          prevTeamsSnap.forEach(d => {
            const t = d.data();
            teamsMap[String(t.id)] = {
              name: t.name,
              code: t.code || t.name || t.id,
              logo: t.team_logo_url || ''
            };
          });
        }
        setPwhlTeams(teamsMap);
      } catch (err) {
        console.error("Failed to load players universe in draft room:", err);
      } finally {
        setPlayersLoading(false);
      }
    };

    loadPlayersAndTeams();
  }, [activeSeasonId, statViewMode, prevSeasonId]);

  // 2. Fetch main league details and teams list
  useEffect(() => {
    if (!activeLeagueId) return;

    const leagueRef = doc(db, 'fantasy_leagues', activeLeagueId);
    const getLeague = async () => {
      try {
        const snap = await getDoc(leagueRef);
        if (snap.exists()) {
          const data = snap.data();
          setLeagueData(data);

          // Fetch teams in league
          const teamsSnap = await getDocs(collection(leagueRef, 'teams'));
          const list = teamsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
          setTeams(list);

          // Check if draft state document exists
          const draftStateRef = doc(db, `fantasy_leagues/${activeLeagueId}/draft`, 'state');
          const draftSnap = await getDoc(draftStateRef);
          if (!draftSnap.exists()) {
            const now = getSimulatedDate().getTime();
            const startDate = data.draftDate ? new Date(data.draftDate).getTime() : 0;
            if (!data.draftDate || now >= startDate) {
              const dOrder = data.draftOrder || data.members || [];
              await initializeDraft(activeLeagueId, dOrder);
            } else {
              setLoading(false);
            }
          }
        }
      } catch (err) {
        console.error("Failed to load league details in draft room:", err);
      }
    };

    getLeague();
  }, [activeLeagueId]);

  // 3. Listen to real-time draft state shifts
  useEffect(() => {
    if (!activeLeagueId) return;

    const draftStateRef = doc(db, `fantasy_leagues/${activeLeagueId}/draft`, 'state');
    const unsubscribe = onSnapshot(draftStateRef, (snap) => {
      if (snap.exists()) {
        const d = snap.data();
        setDraftState(d);
        setLoading(false);
      } else {
        setDraftState(null);
      }
    });

    return () => unsubscribe();
  }, [activeLeagueId]);

  // Lobby Countdown check & Auto-start when reaches 0
  useEffect(() => {
    if (!leagueData || !leagueData.draftDate) return;
    const isDraftActiveOrCompleted = draftState && (draftState.status === 'active' || draftState.status === 'completed');
    if (isDraftActiveOrCompleted) return;

    const checkAndStart = async () => {
      const now = getSimulatedDate().getTime();
      const startDate = new Date(leagueData.draftDate).getTime();
      const diff = Math.max(0, Math.floor((startDate - now) / 1000));
      setLobbySecondsLeft(diff);

      if (diff === 0 && !draftState) {
        try {
          const draftStateRef = doc(db, `fantasy_leagues/${activeLeagueId}/draft`, 'state');
          const draftSnap = await getDoc(draftStateRef);
          if (!draftSnap.exists()) {
            const dOrder = leagueData.draftOrder || leagueData.members || [];
            await initializeDraft(activeLeagueId, dOrder);
          }
        } catch (err) {
          console.error("Failed to auto-start draft at countdown 0:", err);
        }
      }
    };

    checkAndStart();
    const interval = setInterval(checkAndStart, 1000);
    return () => clearInterval(interval);
  }, [leagueData, draftState, getSimulatedDate, activeLeagueId]);

  // 4. Timer Loop & Auto-pick triggers
  // Uses Date.now() to match the deadline's real-clock basis (set by leagueService via Date.now() + 60000).
  // Any connected client can trigger auto-picks for whoever is on the clock — not limited to the current user.
  useEffect(() => {
    if (!draftState || draftState.status !== 'active') return;

    const updateTimer = async () => {
      const deadline = draftStateRef.current?.pickDeadline;
      if (!deadline) return;

      const now = Date.now();
      const deadlineMs = deadline.seconds * 1000 + Math.floor((deadline.nanoseconds || 0) / 1000000);
      const diffSecs = Math.max(0, Math.floor((deadlineMs - now) / 1000));
      setSecondsLeft(diffSecs);

      // Auto-pick: any connected client triggers for whoever is on the clock
      if (draftStateRef.current?.status === 'active' && !isSubmittingRef.current) {
        const pickerUid = draftStateRef.current?.currentTeamOnClock;
        const isUserAutoDraftOn = draftStateRef.current?.autoDraftUsers?.[pickerUid] === true;
        
        if (pickerUid && (diffSecs === 0 || (isUserAutoDraftOn && diffSecs <= 57))) {
          console.log(`[Draft Room] Triggering Auto-Pick for ${pickerUid}...`);
          triggerAutoPickForUser(pickerUid, diffSecs === 0);
        }
      }
    };

    updateTimer();
    const interval = setInterval(updateTimer, 1000);
    return () => clearInterval(interval);
  }, [draftState]);

  // Helper to compile drafted player IDs
  const getDraftedPlayerIds = () => {
    if (!draftState) return new Set();
    const picks = draftState.picks || [];
    const set = new Set();
    picks.forEach(p => {
      if (p.playerId) set.add(p.playerId);
    });
    return set;
  };

  const draftedSet = getDraftedPlayerIds();

  // Find the top available player for Auto-Pick, sorted by projected fantasy points,
  // respecting position limits of the picker's roster.
  const getTopAvailablePlayer = (pickerUid) => {
    if (!pickerUid) return null;
    const currentDraftState = draftStateRef.current;
    const currentAllPlayers = allPlayersRef.current;
    const currentLeagueData = leagueDataRef.current;
    if (!currentDraftState || !currentAllPlayers.length) return null;

    const rosters = currentDraftState.activeRosters || {};
    const pickerRosterIds = rosters[pickerUid] || [];
    const posCounts = { F: 0, D: 0, G: 0 };
    pickerRosterIds.forEach(pId => {
      const p = currentAllPlayers.find(pl => pl.id === pId);
      if (p && (p.pos === 'F' || p.pos === 'D' || p.pos === 'G')) {
        posCounts[p.pos]++;
      }
    });

    const rosterSettings = currentLeagueData?.rosterSettings || { bench: 4, forwards: { starters: 6, max: 10 }, defense: { starters: 4, max: 8 }, goalies: { starters: 1, max: 3 } };
    const forwardsLimit = rosterSettings.forwards?.max ?? 10;
    const defenseLimit = rosterSettings.defense?.max ?? 8;
    const goaliesLimit = rosterSettings.goalies?.max ?? 3;
    
    // Calculate required starters to prevent getting stuck
    const fStarters = rosterSettings.forwards?.starters ?? 6;
    const dStarters = rosterSettings.defense?.starters ?? 4;
    const gStarters = rosterSettings.goalies?.starters ?? 1;
    const benchSlots = rosterSettings.bench ?? 4;
    
    const totalRosterSize = fStarters + dStarters + gStarters + benchSlots;
    const picksRemaining = totalRosterSize - pickerRosterIds.length;
    
    const fNeeded = Math.max(0, fStarters - posCounts.F);
    const dNeeded = Math.max(0, dStarters - posCounts.D);
    const gNeeded = Math.max(0, gStarters - posCounts.G);
    const totalNeeded = fNeeded + dNeeded + gNeeded;
    
    let mustDraftF = false;
    let mustDraftD = false;
    let mustDraftG = false;
    
    if (picksRemaining <= totalNeeded) {
      if (fNeeded > 0) mustDraftF = true;
      if (dNeeded > 0) mustDraftD = true;
      if (gNeeded > 0) mustDraftG = true;
    }

    // Build the drafted set from the latest draft state
    const currentPicks = currentDraftState.picks || [];
    const currentDraftedSet = new Set(currentPicks.map(p => p.playerId).filter(Boolean));

    // Filter available players respecting position limits and requirements
    const available = currentAllPlayers.filter(p => {
      if (currentDraftedSet.has(p.id)) return false;
      
      // Force draft required position if running out of bench slots
      if (picksRemaining <= totalNeeded) {
        if (p.pos === 'F' && !mustDraftF) return false;
        if (p.pos === 'D' && !mustDraftD) return false;
        if (p.pos === 'G' && !mustDraftG) return false;
      }
      
      if (p.pos === 'F' && posCounts.F >= forwardsLimit) return false;
      if (p.pos === 'D' && posCounts.D >= defenseLimit) return false;
      if (p.pos === 'G' && posCounts.G >= goaliesLimit) return false;
      return true;
    });

    if (available.length === 0) return null;

    // Sort by projected fantasy points (highest first) using the league's scoring settings
    const defaultScoringFallback = {
      skaters: { goals: 2, assists: 1, plusMinus: 0.5, ppp: 0.5, shp: 0.5, sog: 0.1, hits: 0.1, blocks: 0.5, defensePoints: 0.5 },
      goalies: { wins: 4, otl: 1, ga: -2, saves: 0.2, shutouts: 3 }
    };
    const scoring = currentLeagueData?.scoringSettings || defaultScoringFallback;
    const seasonIdStr = activeSeasonId ? String(activeSeasonId) : '5';

    const calcFpts = (player) => {
      const stats = player.stats?.[seasonIdStr] || {};
      let pts = 0;
      if (player.pos === 'G') {
        const m = scoring.goalies || defaultScoringFallback.goalies;
        pts += (stats.wins || 0) * (m.wins || 0);
        pts += (stats.overtimeLosses || stats.otl || 0) * (m.otl || 0);
        pts += (stats.goalsAgainst || stats.ga || 0) * (m.ga || 0);
        pts += (stats.shotsSaved || stats.saves || 0) * (m.saves || 0);
        pts += (stats.shutouts || 0) * (m.shutouts || 0);
      } else {
        const m = scoring.skaters || defaultScoringFallback.skaters;
        pts += (stats.goals || 0) * (m.goals || 0);
        pts += (stats.assists || 0) * (m.assists || 0);
        pts += (stats.plusMinus || 0) * (m.plusMinus || 0);
        pts += (stats.powerPlayPoints || stats.ppp || 0) * (m.ppp || 0);
        pts += (stats.shortHandedPoints || stats.shp || 0) * (m.shp || 0);
        pts += (stats.shotsOnGoal || stats.shots || 0) * (m.sog || 0);
        pts += (stats.hits || 0) * (m.hits || 0);
        pts += (stats.blockedShots || stats.blocks || 0) * (m.blocks || 0);
        if (player.pos === 'D') {
          pts += ((stats.goals || 0) + (stats.assists || 0)) * (m.defensePoints || 0);
        }
      }
      return pts;
    };

    // Sort by projected FPTS descending, then by overallRank ascending as tiebreaker
    available.sort((a, b) => {
      const fptsA = calcFpts(a);
      const fptsB = calcFpts(b);
      if (fptsB !== fptsA) return fptsB - fptsA;
      return (a.overallRank || 999) - (b.overallRank || 999);
    });

    return available[0];
  };

  // Auto-pick for any user whose clock has expired or who has auto-draft enabled
  const triggerAutoPickForUser = async (pickerUid, timedOut = false) => {
    if (isSubmittingRef.current) return;
    const topPlayer = getTopAvailablePlayer(pickerUid);
    if (!topPlayer) return;
    setIsSubmitting(true);
    try {
      await submitDraftPick(activeLeagueId, pickerUid, topPlayer.id, true, timedOut);
    } catch (err) {
      // Another client may have already submitted; ignore duplicate errors gracefully
      if (!err.message?.includes('already selected')) {
        console.error("Auto-pick failed:", err);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  // Keep the old triggerAutoPick for the LM force-pick button
  const triggerAutoPick = async () => {
    const pickerUid = draftStateRef.current?.currentTeamOnClock || currentUser?.uid;
    await triggerAutoPickForUser(pickerUid, false);
  };

  const handleSelectPlayer = async (playerId) => {
    if (isSubmitting || !draftState) return;
    if (draftState.currentTeamOnClock !== currentUser?.uid) {
      alert("It is not your turn to pick!");
      return;
    }

    const player = allPlayers.find(p => p.id === playerId);
    if (player) {
      const myRosterIds = activeRosters[currentUser?.uid] || [];
      const posCounts = { F: 0, D: 0, G: 0 };
      myRosterIds.forEach(pId => {
        const pl = allPlayers.find(x => x.id === pId);
        if (pl) {
          const pos = pl.pos;
          if (pos === 'F' || pos === 'D' || pos === 'G') posCounts[pos]++;
        }
      });
      const rosterSettings = leagueData?.rosterSettings || { bench: 4, forwards: { starters: 6, max: 10 }, defense: { starters: 4, max: 8 }, goalies: { starters: 1, max: 3 } };
      const maxLimit = player.pos === 'F' ? (rosterSettings.forwards?.max ?? 10) :
                       player.pos === 'D' ? (rosterSettings.defense?.max ?? 8) :
                       (rosterSettings.goalies?.max ?? 3);
      if (posCounts[player.pos] >= maxLimit) {
        alert(`Draft Pick Failed: Roster limit exceeded for position ${player.pos}. Maximum allowed is ${maxLimit}.`);
        return;
      }
    }
    
    setIsSubmitting(true);
    try {
      await submitDraftPick(activeLeagueId, currentUser.uid, playerId);
    } catch (err) {
      console.error(err);
      alert("Draft Pick Failed: " + err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Force Auto-Pick for current picker (LM Commissioner override tool)
  const handleLMForceAutoPick = async () => {
    if (!draftState || isSubmitting) return;
    const pickerUid = draftState.currentTeamOnClock;
    const topPlayer = getTopAvailablePlayer(pickerUid);
    if (!topPlayer) return;

    setIsSubmitting(true);
    try {
      await submitDraftPick(activeLeagueId, pickerUid, topPlayer.id, true);
      alert(`Forced pick of ${topPlayer.name} for team.`);
    } catch (err) {
      console.error(err);
      alert("Force Pick Failed: " + err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (loading || playersLoading) {
    return (
      <div className="min-h-[80vh] flex items-center justify-center select-none">
        <div className="text-xs font-black tracking-widest text-gray-400 uppercase animate-pulse">
          Connecting to Arena Draft Feed...
        </div>
      </div>
    );
  }

  const isLM = currentUser && currentUser.uid === leagueData?.ownerId;
  const picks = draftState?.picks || [];
  const activeRosters = draftState?.activeRosters || {};
  const draftOrder = draftState?.draftOrder || [];
  const currentTeamId = draftState?.currentTeamOnClock;
  const currentRound = draftState?.currentRound || 1;
  const currentPickIndex = draftState?.currentPickIndex || 0;
  const isMyTurn = currentTeamId === currentUser?.uid;

  // Compile visual stats maps
  const getTeamName = (uid) => {
    const t = teams.find(team => team.ownerId === uid);
    return t ? t.teamName : `Owner (${uid.slice(0, 6)})`;
  };

  // Resolve active stats for each player based on statViewMode
  const activeSeasonIdStr = activeSeasonId ? String(activeSeasonId) : '5';
  const resolvedStatKey = statViewMode === 'projections' ? activeSeasonIdStr : (prevSeasonId || activeSeasonIdStr);

  // Scoring settings from this league (same defaults as leagueService.js)
  const defaultScoring = {
    skaters: { goals: 2, assists: 1, plusMinus: 0.5, ppp: 0.5, shp: 0.5, sog: 0.1, hits: 0.1, blocks: 0.5, defensePoints: 0.5 },
    goalies: { wins: 4, otl: 1, ga: -2, saves: 0.2, shutouts: 3 }
  };
  const leagueScoring = leagueData?.scoringSettings || defaultScoring;

  const processedPlayers = allPlayers.map(player => {
    const activeStats = player.stats?.[resolvedStatKey] || {};
    const pTeam = pwhlTeams[player.teamId] || {};
    
    // Calculate fantasy points using the league's scoring settings
    let fpts = 0;
    if (player.pos === 'G') {
      const matrix = leagueScoring.goalies || defaultScoring.goalies;
      fpts += (activeStats.wins || 0) * (matrix.wins || 0);
      fpts += (activeStats.overtimeLosses || activeStats.otl || 0) * (matrix.otl || 0);
      fpts += (activeStats.goalsAgainst || activeStats.ga || 0) * (matrix.ga || 0);
      fpts += (activeStats.shotsSaved || activeStats.saves || 0) * (matrix.saves || 0);
      fpts += (activeStats.shutouts || 0) * (matrix.shutouts || 0);
    } else {
      const matrix = leagueScoring.skaters || defaultScoring.skaters;
      fpts += (activeStats.goals || 0) * (matrix.goals || 0);
      fpts += (activeStats.assists || 0) * (matrix.assists || 0);
      fpts += (activeStats.plusMinus || 0) * (matrix.plusMinus || 0);
      fpts += (activeStats.powerPlayPoints || activeStats.ppp || 0) * (matrix.ppp || 0);
      fpts += (activeStats.shortHandedPoints || activeStats.shp || 0) * (matrix.shp || 0);
      fpts += (activeStats.shotsOnGoal || activeStats.shots || 0) * (matrix.sog || 0);
      fpts += (activeStats.hits || 0) * (matrix.hits || 0);
      fpts += (activeStats.blockedShots || activeStats.blocks || 0) * (matrix.blocks || 0);
      // Defense bonus: extra points per point scored by defensemen
      if (player.pos === 'D' || player.pos === 'Defense') {
        fpts += ((activeStats.goals || 0) + (activeStats.assists || 0)) * (matrix.defensePoints || 0);
      }
    }
    fpts = Math.round(fpts * 100) / 100;

    return { ...player, activeStats, pTeam, fpts };
  });

  // Available players sorted and filtered
  const filteredPlayers = processedPlayers
    .filter(p => !draftedSet.has(p.id))
    .filter(p => {
      if (posFilter === 'ALL') return true;
      return p.pos === posFilter;
    })
    .filter(p => p.name.toLowerCase().includes(searchQuery.toLowerCase()))
    .sort((a, b) => {
      if (statViewMode === 'projections') {
        return (a.overallRank || 999) - (b.overallRank || 999);
      }
      return (b.fpts || 0) - (a.fpts || 0);
    });

  const isDraftActiveOrCompleted = draftState && (draftState.status === 'active' || draftState.status === 'completed');

  // Render pre-draft lobby countdown view
  if (!isDraftActiveOrCompleted && leagueData?.draftDate && getSimulatedDate().getTime() < new Date(leagueData.draftDate).getTime()) {
    return (
      <div className="font-sans antialiased text-gray-800 select-none min-h-[70vh] flex flex-col items-center justify-center text-center p-6 bg-white border border-gray-200 rounded-[32px] shadow-sm animate-scale-up">
        <div className="w-full text-left mb-4">
          <button 
            onClick={() => setCurrentTab('matchup')}
            className="text-xs font-black uppercase text-indigo-600 bg-indigo-50 border border-indigo-100 px-3 py-1.5 rounded-xl hover:bg-indigo-100/50 active:scale-95 transition-all flex items-center gap-1.5"
          >
            ← Back to Matchups
          </button>
        </div>
        
        <div className="w-20 h-20 rounded-3xl bg-indigo-50 border border-indigo-100 flex items-center justify-center text-4xl mb-6 shadow-inner animate-pulse">
          ⏱️
        </div>
        
        <h1 className="font-sports text-3xl font-black text-gray-900 tracking-tight">
          Draft Lobby is Open!
        </h1>
        <p className="text-xs text-gray-400 font-semibold mt-2 max-w-md mx-auto">
          The snake draft will commence automatically once the scheduled start time is reached.
        </p>

        {/* Countdown Ring */}
        <div className="my-8 bg-gradient-to-r from-indigo-900 via-violet-950 to-indigo-900 text-white border-2 border-indigo-500 rounded-[32px] px-10 py-6 shadow-xl shadow-indigo-600/10 flex flex-col items-center min-w-[240px]">
          <span className="text-4xl font-sports font-black leading-none text-white tracking-tight animate-pulse">
            {lobbySecondsLeft}s
          </span>
          <span className="text-[9px] font-black uppercase tracking-widest mt-1.5 text-indigo-300">
            Commencing In
          </span>
        </div>

        {/* Info panel */}
        <div className="w-full max-w-sm border border-gray-100 rounded-2xl p-4 bg-gray-50/50 space-y-2 text-left">
          <label className="text-[10px] font-black text-gray-400 uppercase tracking-widest block mb-2">Snake Draft Order</label>
          {(leagueData.draftOrder || leagueData.members || []).map((uid, idx) => {
            const team = teams.find(t => t.ownerId === uid);
            return (
              <div key={uid} className="flex items-center justify-between bg-white border border-gray-150 p-2 rounded-xl shadow-sm">
                <div className="flex items-center gap-2.5">
                  <span className="w-5 h-5 rounded-md bg-indigo-50 border border-indigo-100 flex items-center justify-center text-[9px] font-black text-indigo-600">
                    {idx + 1}
                  </span>
                  <span className="text-xs font-black text-gray-800">
                    {team ? team.teamName : `Owner (${uid.slice(0, 6)})`}
                  </span>
                </div>
                <span className="text-[9px] font-bold text-gray-400 uppercase tracking-wider">
                  {uid === leagueData.ownerId ? '👑 LM' : 'Member'}
                </span>
              </div>
            );
          })}
        </div>
        
        {isLM && simulationState?.testModeActive && (
          <button
            onClick={async () => {
              try {
                // Instantly start by setting draftDate to now
                const nowIso = getSimulatedDate().toISOString();
                const leagueRef = doc(db, 'fantasy_leagues', activeLeagueId);
                await updateDoc(leagueRef, { draftDate: nowIso });
                const dOrder = leagueData.draftOrder || leagueData.members || [];
                await initializeDraft(activeLeagueId, dOrder);
              } catch (err) {
                console.error("Failed to start draft instantly:", err);
              }
            }}
            className="mt-6 px-6 py-3.5 bg-slate-900 hover:bg-slate-800 text-white text-xs font-black uppercase tracking-wider rounded-2xl active:scale-95 transition-all shadow-md"
          >
            ⚡ Start Draft Instantly
          </button>
        )}
      </div>
    );
  }

  // Render post-draft recap view
  if (draftState?.status === 'completed') {
    return (
      <div className="font-sans antialiased text-gray-800 select-none">
        {/* Header */}
        <div className="flex justify-between items-center mb-8">
          <div>
            <button 
              onClick={() => setCurrentTab('matchup')}
              className="text-xs font-black uppercase text-indigo-600 bg-indigo-50 border border-indigo-100 px-3 py-1.5 rounded-xl hover:bg-indigo-100/50 active:scale-95 transition-all mb-4 flex items-center gap-1.5"
            >
              ← Back to Matchups
            </button>
            <h1 className="font-sports text-3xl font-black text-gray-900 tracking-tight">
              Draft Summary & Recap
            </h1>
            <p className="text-xs text-gray-400 font-semibold mt-1">Review the picks that structured this season's roster sheets.</p>
          </div>

          {/* Toggle Recap Mode */}
          <div className="bg-gray-100 p-1.5 rounded-2xl border border-gray-200 flex gap-1.5">
            <button
              onClick={() => setSelectedRecapTab('round')}
              className={`px-4 py-2 text-[10px] font-black uppercase tracking-wider rounded-xl transition-all ${selectedRecapTab === 'round' ? 'bg-white text-indigo-600 shadow-sm' : 'text-gray-400 hover:text-gray-600'}`}
            >
              Round Grid
            </button>
            <button
              onClick={() => setSelectedRecapTab('team')}
              className={`px-4 py-2 text-[10px] font-black uppercase tracking-wider rounded-xl transition-all ${selectedRecapTab === 'team' ? 'bg-white text-indigo-600 shadow-sm' : 'text-gray-400 hover:text-gray-600'}`}
            >
              By Team
            </button>
          </div>
        </div>

        {/* Recap: Round Grid */}
        {selectedRecapTab === 'round' && (
          <div className="bg-white border border-gray-200 rounded-[32px] p-6 shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-xs font-semibold">
                <thead>
                  <tr className="border-b border-gray-150 text-[10px] uppercase font-black text-gray-400 tracking-widest">
                    <th className="py-4 px-4">Pick</th>
                    <th className="py-4 px-4">Round</th>
                    <th className="py-4 px-4">Fantasy Team</th>
                    <th className="py-4 px-4">Drafted Player</th>
                    <th className="py-4 px-4">Pos</th>
                    <th className="py-4 px-4">PWHL Team</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {picks.map((pick, idx) => {
                    const player = allPlayers.find(p => p.id === pick.playerId) || {};
                    const pTeam = pwhlTeams[player.teamId] || {};
                    return (
                      <tr key={idx} className="hover:bg-gray-50/50">
                        <td className="py-3.5 px-4 font-black text-gray-900">#{pick.pickNumber}</td>
                        <td className="py-3.5 px-4 text-gray-500">Round {pick.round}</td>
                        <td className="py-3.5 px-4 font-bold text-gray-800">{getTeamName(pick.userId)}</td>
                        <td className="py-3.5 px-4">
                          <span className="font-black text-indigo-600 hover:underline cursor-pointer">{player.name || `Player ID (${pick.playerId})`}</span>
                        </td>
                        <td className="py-3.5 px-4">
                          <span className={`px-2 py-0.5 rounded text-[10px] font-black border ${player.pos === 'G' ? 'bg-amber-50 text-amber-600 border-amber-100' : player.pos === 'D' ? 'bg-emerald-50 text-emerald-600 border-emerald-100' : 'bg-indigo-50 text-indigo-600 border-indigo-100'}`}>
                            {player.pos}
                          </span>
                        </td>
                        <td className="py-3.5 px-4 flex items-center gap-2">
                          {pTeam.logo && <img src={pTeam.logo} alt="" className="w-5 h-5 object-contain" />}
                          <span className="font-bold text-gray-700">{pTeam.code || '-'}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Recap: By Team */}
        {selectedRecapTab === 'team' && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {draftOrder.map((uid, idx) => {
              const teamPicks = picks.filter(p => p.userId === uid);
              return (
                <div key={uid} className="bg-white border border-gray-200 rounded-[32px] p-6 shadow-sm flex flex-col justify-between">
                  <div>
                    <div className="flex justify-between items-center mb-4 pb-3 border-b border-gray-100">
                      <h4 className="font-sports text-sm font-black text-gray-900">{getTeamName(uid)}</h4>
                      <span className="text-[9px] font-black text-gray-400 bg-gray-50 border border-gray-200 px-2 py-1 rounded-lg">Slot #{idx + 1}</span>
                    </div>
                    <div className="space-y-2">
                      {teamPicks.map((pick, pIdx) => {
                        const player = allPlayers.find(p => p.id === pick.playerId) || {};
                        return (
                          <div key={pIdx} className="flex justify-between items-center text-xs p-2 bg-gray-50 border border-gray-150 rounded-xl">
                            <div className="flex items-center gap-2">
                              <span className="text-[9px] font-black text-indigo-600 bg-indigo-50 px-1.5 py-0.5 rounded border border-indigo-100">Pick {pick.pickNumber}</span>
                              <span className="font-black text-gray-800">{player.name}</span>
                            </div>
                            <span className="text-[9px] font-black text-gray-400 uppercase">{player.pos}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="font-sans antialiased text-gray-800 select-none">
      
      {/* ── ON THE CLOCK HEADER BANNER ── */}
      <div className={`w-full rounded-[32px] p-6 shadow-md mb-8 flex flex-col md:flex-row md:items-center justify-between gap-6 transition-all duration-300 ${isMyTurn ? 'bg-gradient-to-r from-indigo-900 via-violet-950 to-indigo-900 border-2 border-indigo-500 text-white animate-pulse' : 'bg-white border border-gray-200 text-gray-800'}`}>
        <div className="flex items-center gap-4 text-left">
          <div className={`w-14 h-14 rounded-2xl flex items-center justify-center text-2xl shadow-inner ${isMyTurn ? 'bg-white/10 text-indigo-400 animate-spin' : 'bg-indigo-50 border border-indigo-100 text-indigo-600'}`}>
            ⚡
          </div>
          <div>
            <h2 className={`font-sports text-xl font-black leading-tight ${isMyTurn ? 'text-white' : 'text-gray-900'}`}>
              {isMyTurn ? '🚨 YOU ARE ON THE CLOCK!' : 'Draft Lobby Active'}
            </h2>
            <p className={`text-xs font-semibold mt-1 ${isMyTurn ? 'text-indigo-200' : 'text-gray-400'}`}>
              Round {currentRound} | Pick #{currentPickIndex + 1} Overall | Team On Clock: <span className="font-black underline">{getTeamName(currentTeamId)}</span>
            </p>
          </div>
        </div>

        {/* Countdown Ring & Controls */}
        <div className="flex items-center gap-4">
          <div className="flex flex-col items-center">
            <span className={`text-3xl font-sports font-black leading-none ${isMyTurn ? 'text-white' : 'text-indigo-600'}`}>
              {secondsLeft}s
            </span>
            <span className={`text-[9px] font-black uppercase tracking-wider mt-1 ${isMyTurn ? 'text-indigo-300' : 'text-gray-400'}`}>Time Left</span>
          </div>

          <div className="flex flex-col gap-2 border-l border-gray-200/30 pl-4">
            <button
              onClick={() => setCurrentTab('matchup')}
              className={`px-5 py-2 rounded-xl text-[10px] font-black uppercase tracking-wider transition-all active:scale-95 ${isMyTurn ? 'bg-white/10 text-white hover:bg-white/20' : 'bg-gray-100 text-gray-500 hover:bg-gray-200/70 border border-gray-200'}`}
            >
              Leave Lobby
            </button>
            <button
              onClick={async () => {
                const currentStatus = draftState?.autoDraftUsers?.[currentUser?.uid] === true;
                await toggleAutoDraftStatus(activeLeagueId, currentUser?.uid, !currentStatus);
              }}
              className={`px-5 py-2 rounded-xl text-[10px] font-black uppercase tracking-wider transition-all active:scale-95 ${draftState?.autoDraftUsers?.[currentUser?.uid] === true ? 'bg-amber-400 text-amber-900 hover:bg-amber-500' : isMyTurn ? 'bg-white/10 text-white hover:bg-white/20' : 'bg-gray-100 text-gray-500 hover:bg-gray-200/70 border border-gray-200'}`}
            >
              {draftState?.autoDraftUsers?.[currentUser?.uid] === true ? 'Auto-Draft: ON' : 'Auto-Draft: OFF'}
            </button>
          </div>
        </div>
      </div>

      {/* ── MAIN WORKSPACE GRID ── */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        
        {/* LEFT COLUMN: Sidebar (Draft Order list & Roster preview) (lg:col-span-4) */}
        <div className="lg:col-span-4 space-y-6">
          
          {/* Draft Lobby Sub-tab navigation */}
          <div className="bg-gray-100 p-1 rounded-2xl border border-gray-200 flex">
            <button 
              onClick={() => setSubTab('lobby')}
              className={`flex-1 py-3 text-[10px] font-black uppercase tracking-wider rounded-xl transition-all ${subTab === 'lobby' ? 'bg-white text-indigo-600 shadow-sm' : 'text-gray-400 hover:text-gray-600'}`}
            >
              Draft Queue
            </button>
            <button 
              onClick={() => setSubTab('rosters')}
              className={`flex-1 py-3 text-[10px] font-black uppercase tracking-wider rounded-xl transition-all ${subTab === 'rosters' ? 'bg-white text-indigo-600 shadow-sm' : 'text-gray-400 hover:text-gray-600'}`}
            >
              Roster Sheet
            </button>
          </div>

          {/* Subtab 1: Draft Queue order list */}
          {subTab === 'lobby' && (
            <div className="bg-white border border-gray-200 rounded-[32px] p-6 shadow-sm space-y-4">
              <h3 className="font-sports text-sm font-black text-gray-900 uppercase tracking-tight">Draft Pick Sequence</h3>
              <div className="space-y-2">
                {draftOrder.map((uid, idx) => {
                  const isActivePicker = currentTeamId === uid;
                  const team = teams.find(t => t.ownerId === uid);
                  const isUser = currentUser?.uid === uid;
                  
                  // Simple logic to show what player they drafted last
                  const userPicks = picks.filter(p => p.userId === uid);
                  const lastPick = userPicks.length > 0 ? userPicks[userPicks.length - 1] : null;
                  const lastPlayer = lastPick ? allPlayers.find(p => p.id === lastPick.playerId) : null;

                  return (
                    <div key={uid} className={`flex items-center justify-between p-3.5 rounded-2xl transition-all border ${isActivePicker ? 'bg-gradient-to-tr from-indigo-50 to-violet-50 border-indigo-200 shadow-sm animate-pulse' : 'bg-gray-50 border-gray-150'}`}>
                      <div className="flex items-center gap-3 text-left">
                        <span className={`w-6 h-6 rounded-lg flex items-center justify-center text-[10px] font-black ${isActivePicker ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/10' : 'bg-white border border-gray-200 text-gray-500'}`}>
                          {idx + 1}
                        </span>
                        <div>
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => {
                                setSelectedRosterUserId(uid);
                                setSubTab('rosters');
                              }}
                              className="text-xs font-black text-gray-800 hover:text-indigo-600 hover:underline transition-all text-left"
                            >
                              {team ? team.teamName : `Owner (${uid.slice(0, 6)})`}
                            </button>
                            {isUser && <span className="text-[8px] bg-indigo-100 text-indigo-700 px-1.5 py-0.5 rounded font-black uppercase tracking-wider">You</span>}
                            {draftState?.autoDraftUsers?.[uid] === true && <span className="text-[8px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded font-black uppercase tracking-wider" title="Auto-Draft is ON">Auto</span>}
                          </div>
                          {lastPlayer && (
                            <span className="text-[9px] text-gray-400 font-semibold block mt-0.5">
                              Picked: {lastPlayer.name} ({lastPlayer.pos})
                            </span>
                          )}
                        </div>
                      </div>
                      
                      <div className="flex items-center gap-1.5">
                        {isActivePicker && <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-ping"></span>}
                        <span className={`text-[9px] uppercase font-black tracking-wider ${isActivePicker ? 'text-indigo-600' : 'text-gray-400'}`}>
                          {isActivePicker ? 'Clock' : 'Waiting'}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Subtab 2: Team Roster Preview */}
          {subTab === 'rosters' && (
            <div className="bg-white border border-gray-200 rounded-[32px] p-6 shadow-sm space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-sports text-sm font-black text-gray-900 uppercase tracking-tight">Roster Command Sheet</h3>
                  <p className="text-[11px] text-gray-400 font-semibold leading-relaxed mt-1">Review positional slots during the draft.</p>
                </div>
                <select
                  value={selectedRosterUserId || currentUser?.uid}
                  onChange={(e) => setSelectedRosterUserId(e.target.value)}
                  className="text-xs font-black text-gray-800 bg-gray-50 border border-gray-200 rounded-xl px-3 py-2 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 max-w-[150px] cursor-pointer"
                >
                  {(leagueData.draftOrder || leagueData.members || []).map(uid => {
                    const t = teams.find(team => team.ownerId === uid);
                    const name = t ? t.teamName : `Owner (${uid.slice(0,6)})`;
                    return <option key={uid} value={uid}>{uid === currentUser?.uid ? `${name} (You)` : name}</option>;
                  })}
                </select>
              </div>
              
              {/* Positional Slots Grid */}
              <div className="space-y-2">
                {(() => {
                  const activeRosterUserId = selectedRosterUserId || currentUser?.uid;
                  const myPIds = activeRosters[activeRosterUserId] || [];
                  const myRosterPlayers = myPIds.map(id => allPlayers.find(p => p.id === id)).filter(Boolean);
                  
                  // Grid of standard lineup slots dynamically generated from settings
                  const rSettings = leagueData?.rosterSettings || { bench: 4, forwards: { starters: 6 }, defense: { starters: 4 }, goalies: { starters: 1 } };
                  const slots = [];
                  
                  const fStarters = rSettings.forwards?.starters ?? 6;
                  for (let i = 1; i <= fStarters; i++) {
                    slots.push({ label: `F${i}`, pos: "F" });
                  }
                  
                  const dStarters = rSettings.defense?.starters ?? 4;
                  for (let i = 1; i <= dStarters; i++) {
                    slots.push({ label: `D${i}`, pos: "D" });
                  }
                  
                  const gStarters = rSettings.goalies?.starters ?? 1;
                  for (let i = 1; i <= gStarters; i++) {
                    slots.push({ label: gStarters === 1 ? "G" : `G${i}`, pos: "G" });
                  }
                  
                  const benchCount = rSettings.bench ?? 4;
                  for (let i = 1; i <= benchCount; i++) {
                    slots.push({ label: `BN${i}`, pos: "BENCH" });
                  }

                  const unused = [...myRosterPlayers];

                  return slots.map((slot, sIdx) => {
                    let matchedPlayer = null;
                    if (slot.pos === "BENCH") {
                      // Bench handles overflow
                      if (unused.length > 0) {
                        matchedPlayer = unused[0];
                        unused.splice(0, 1);
                      }
                    } else {
                      const idx = unused.findIndex(p => p.pos === slot.pos);
                      if (idx !== -1) {
                        matchedPlayer = unused[idx];
                        unused.splice(idx, 1);
                      }
                    }

                    return (
                      <div key={sIdx} className="flex items-center justify-between bg-gray-50 border border-gray-150 p-3 rounded-2xl">
                        <div className="flex items-center gap-3">
                          <span className="w-8 h-8 rounded-lg bg-indigo-50 border border-indigo-100 flex items-center justify-center text-[10px] font-black text-indigo-600">
                            {slot.label}
                          </span>
                          <span className={`text-xs font-black ${matchedPlayer ? 'text-gray-800' : 'text-gray-400'}`}>
                            {matchedPlayer ? matchedPlayer.name : 'Open Position'}
                          </span>
                        </div>
                        {matchedPlayer && (
                          <span className="text-[10px] font-black text-gray-400 uppercase">
                            {matchedPlayer.pos}
                          </span>
                        )}
                      </div>
                    );
                  });
                })()}
              </div>
            </div>
          )}
        </div>

        {/* RIGHT COLUMN: Available Player Directory (lg:col-span-8) */}
        <div className="lg:col-span-8 space-y-6">
          <div className="bg-white border border-gray-200 rounded-[32px] p-6 shadow-sm space-y-6">
            
            {/* Stat View Toggle */}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-gray-100 pb-5">
              <h3 className="font-sports text-base font-black text-gray-900 uppercase tracking-tight">Available Player Universe</h3>
              
              <div className="flex flex-wrap items-center gap-3">
                {/* Projections / Last Season Toggle */}
                <div className="bg-gray-100 p-1 rounded-xl border border-gray-200 flex gap-1">
                  <button
                    onClick={() => setStatViewMode('projections')}
                    className={`px-4 py-1.5 text-[9px] font-black uppercase tracking-wider rounded-lg transition-all ${statViewMode === 'projections' ? 'bg-white text-indigo-600 shadow-sm' : 'text-gray-400 hover:text-gray-600'}`}
                  >
                    📊 Projections
                  </button>
                  <button
                    onClick={() => setStatViewMode('lastSeason')}
                    className={`px-4 py-1.5 text-[9px] font-black uppercase tracking-wider rounded-lg transition-all ${statViewMode === 'lastSeason' ? 'bg-white text-indigo-600 shadow-sm' : 'text-gray-400 hover:text-gray-600'}`}
                  >
                    📋 Last Season
                  </button>
                </div>

                {/* Search */}
                <input 
                  type="text" 
                  placeholder="Search player name..." 
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  className="bg-gray-50 border border-gray-200 rounded-xl px-3.5 py-2 text-xs focus:outline-none focus:border-indigo-500 shadow-inner w-44"
                />

                {/* Position Filter */}
                <div className="bg-gray-100 p-1 rounded-xl border border-gray-200 flex gap-1">
                  {['ALL', 'F', 'D', 'G'].map(pos => (
                    <button
                      key={pos}
                      onClick={() => setPosFilter(pos)}
                      className={`px-3 py-1 text-[9px] font-black uppercase tracking-wider rounded-lg transition-all ${posFilter === pos ? 'bg-white text-indigo-600 shadow-sm' : 'text-gray-400 hover:text-gray-600'}`}
                    >
                      {pos}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Players Grid Table — Combined Skater + Goalie Columns */}
            <div className="overflow-x-auto min-h-[40vh]">
              <table className="w-full border-collapse text-left text-xs font-semibold min-w-[1100px]">
                <thead>
                  <tr className="border-b border-gray-150 text-[10px] uppercase font-black text-gray-400 tracking-widest">
                    <th className="py-3 px-2 sticky left-0 bg-white z-10">#</th>
                    <th className="py-3 px-2 sticky left-8 bg-white z-10 min-w-[140px]">Name</th>
                    <th className="py-3 px-2">Pos</th>
                    <th className="py-3 px-2">Team</th>
                    <th className="py-3 px-2 text-center">GP</th>
                    {/* Skater Stats */}
                    <th className="py-3 px-2 text-center">G</th>
                    <th className="py-3 px-2 text-center">A</th>
                    <th className="py-3 px-2 text-center">+/-</th>
                    <th className="py-3 px-2 text-center">PPP</th>
                    <th className="py-3 px-2 text-center">SHP</th>
                    <th className="py-3 px-2 text-center">SOG</th>
                    <th className="py-3 px-2 text-center">HIT</th>
                    <th className="py-3 px-2 text-center">BLK</th>
                    {/* Goalie Stats */}
                    <th className="py-3 px-2 text-center">W</th>
                    <th className="py-3 px-2 text-center">L</th>
                    <th className="py-3 px-2 text-center">OTL</th>
                    <th className="py-3 px-2 text-center">GA</th>
                    <th className="py-3 px-2 text-center">SV</th>
                    <th className="py-3 px-2 text-center">SO</th>
                    {/* Fantasy */}
                    <th className="py-3 px-2 text-center">FPTS</th>
                    <th className="py-3 px-2 text-center">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {filteredPlayers.length === 0 ? (
                    <tr>
                      <td colSpan="21" className="py-12 text-center text-gray-400 text-xs font-bold uppercase tracking-widest">No available players match query.</td>
                    </tr>
                  ) : (
                    filteredPlayers.map((player) => {
                      const s = player.activeStats || {};
                      const isGoalie = player.pos === 'G';
                      return (
                        <tr key={player.id} className="hover:bg-gray-50/50">
                          <td className="py-3 px-2 text-gray-400 sticky left-0 bg-white">{player.jersey}</td>
                          <td className="py-3 px-2 sticky left-8 bg-white">
                            <span 
                              className="font-black text-indigo-600 hover:underline cursor-pointer"
                              onClick={() => setSelectedCardPlayer(player)}
                            >
                              {player.name}
                            </span>
                          </td>
                          <td className="py-3 px-2">
                            <span className={`px-2 py-0.5 rounded text-[9px] font-black border ${player.pos === 'G' ? 'bg-amber-50 text-amber-600 border-amber-100' : player.pos === 'D' ? 'bg-emerald-50 text-emerald-600 border-emerald-100' : 'bg-indigo-50 text-indigo-600 border-indigo-100'}`}>
                              {player.pos}
                            </span>
                          </td>
                          <td className="py-3 px-2">
                            <div className="flex items-center gap-1.5">
                              {player.pTeam?.logo && <img src={player.pTeam.logo} alt="" className="w-4 h-4 object-contain" />}
                              <span className="font-bold text-gray-600">{player.pTeam?.code || '-'}</span>
                            </div>
                          </td>
                          <td className="py-3 px-2 text-center text-gray-500">{s.gamesPlayed || '-'}</td>
                          {/* Skater stat columns */}
                          <td className="py-3 px-2 text-center">{!isGoalie ? (s.goals || 0) : '-'}</td>
                          <td className="py-3 px-2 text-center">{!isGoalie ? (s.assists || 0) : '-'}</td>
                          <td className="py-3 px-2 text-center">{!isGoalie ? (s.plusMinus || 0) : '-'}</td>
                          <td className="py-3 px-2 text-center">{!isGoalie ? (s.powerPlayPoints || 0) : '-'}</td>
                          <td className="py-3 px-2 text-center">{!isGoalie ? (s.shortHandedPoints || 0) : '-'}</td>
                          <td className="py-3 px-2 text-center">{!isGoalie ? (s.shotsOnGoal || 0) : '-'}</td>
                          <td className="py-3 px-2 text-center">{!isGoalie ? (s.hits || 0) : '-'}</td>
                          <td className="py-3 px-2 text-center">{!isGoalie ? (s.blockedShots || 0) : '-'}</td>
                          {/* Goalie stat columns */}
                          <td className="py-3 px-2 text-center">{isGoalie ? (s.wins || 0) : '-'}</td>
                          <td className="py-3 px-2 text-center">{isGoalie ? (s.losses || 0) : '-'}</td>
                          <td className="py-3 px-2 text-center">{isGoalie ? (s.overtimeLosses || 0) : '-'}</td>
                          <td className="py-3 px-2 text-center">{isGoalie ? (s.goalsAgainst || 0) : '-'}</td>
                          <td className="py-3 px-2 text-center">{isGoalie ? (s.shotsSaved || 0) : '-'}</td>
                          <td className="py-3 px-2 text-center">{isGoalie ? (s.shutouts || 0) : '-'}</td>
                          {/* Fantasy Points */}
                          <td className="py-3 px-2 text-center font-black text-indigo-600">{player.fpts ? player.fpts.toFixed(1) : '-'}</td>
                          {/* Action */}
                          <td className="py-3 px-2 text-center">
                            {(() => {
                              const myRosterIds = activeRosters[currentUser?.uid] || [];
                              const posCounts = { F: 0, D: 0, G: 0 };
                              myRosterIds.forEach(pId => {
                                const p = allPlayers.find(pl => pl.id === pId);
                                if (p) {
                                  const pos = p.pos;
                                  if (pos === 'F' || pos === 'D' || pos === 'G') {
                                    posCounts[pos]++;
                                  }
                                }
                              });
                              const rosterSettings = leagueData?.rosterSettings || { bench: 4, forwards: { starters: 6, max: 10 }, defense: { starters: 4, max: 8 }, goalies: { starters: 1, max: 3 } };
                              const maxLimit = player.pos === 'F' ? (rosterSettings.forwards?.max ?? 10) :
                                               player.pos === 'D' ? (rosterSettings.defense?.max ?? 8) :
                                               (rosterSettings.goalies?.max ?? 3);
                              const isLimitReached = posCounts[player.pos] >= maxLimit;

                              return (
                                <button
                                  onClick={() => handleSelectPlayer(player.id)}
                                  disabled={!isMyTurn || isSubmitting || isLimitReached}
                                  className={`px-3 py-1.5 rounded-xl text-[9px] font-black uppercase tracking-wider transition-all active:scale-95 shadow-sm ${
                                    isMyTurn && !isLimitReached
                                      ? 'bg-gradient-to-r from-indigo-600 to-violet-600 text-white shadow-indigo-600/10 hover:from-indigo-500 hover:to-violet-500' 
                                      : 'bg-gray-100 text-gray-400 border border-gray-200 cursor-not-allowed shadow-none'
                                  }`}
                                >
                                  {isLimitReached ? 'Limit' : 'Draft'}
                                </button>
                              );
                            })()}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            {/* Commissioner Toolset Controls */}
            {isLM && (
              <div className="bg-slate-50 border border-slate-200 p-6 rounded-[28px] text-left mt-6 flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                  <h4 className="text-xs font-black uppercase tracking-wider text-slate-800">LM Commissioner Tools</h4>
                  <p className="text-[10px] text-slate-400 font-semibold mt-1">Force-pick for current manager on the clock or automatically trigger picks to test sandbox flow.</p>
                </div>
                <button
                  onClick={handleLMForceAutoPick}
                  disabled={isSubmitting}
                  className="px-5 py-3.5 bg-slate-800 hover:bg-slate-700 text-white text-[10px] font-black uppercase tracking-wider rounded-2xl active:scale-95 transition-all shadow-md shadow-slate-800/10"
                >
                  ⚡ Force Auto-Pick for turn
                </button>
              </div>
            )}

            {/* Recent Picks Log ticker */}
            <div className="border-t border-gray-100 pt-5 text-left">
              <h4 className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-3">Live Selection Log</h4>
              <div className="space-y-1.5 max-h-[140px] overflow-y-auto pr-2">
                {picks.length === 0 ? (
                  <span className="text-[10px] text-gray-400 font-bold uppercase tracking-wider">No selections made yet.</span>
                ) : (
                  [...picks].reverse().map((pick, pIdx) => {
                    const player = allPlayers.find(p => p.id === pick.playerId) || {};
                    return (
                      <div key={pIdx} className="text-xs flex items-center justify-between py-1 border-b border-gray-50 last:border-b-0">
                        <span className="text-gray-400 font-bold">Round {pick.round}, Pick {pick.pickNumber}</span>
                        <span className="font-semibold text-gray-700">
                          <span className="font-black text-gray-900">{getTeamName(pick.userId)}</span> selected <span className="font-black text-indigo-600">{player.name} ({player.pos})</span>
                        </span>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

          </div>
        </div>

      </div>

      {/* ── PLAYER CARD MODAL ── */}
      {selectedCardPlayer && (() => {
        const p = selectedCardPlayer;
        const s = p.activeStats || {};
        const teamInfo = p.pTeam || {};
        const branding = getTeamBranding(teamInfo.code);
        const isGoalie = p.pos === 'G';

        // Check if draft button should be enabled
        const myRosterIds = activeRosters[currentUser?.uid] || [];
        const posCounts = { F: 0, D: 0, G: 0 };
        myRosterIds.forEach(pId => {
          const pl = allPlayers.find(x => x.id === pId);
          if (pl) {
            const pos = pl.pos;
            if (pos === 'F' || pos === 'D' || pos === 'G') posCounts[pos]++;
          }
        });
        const rosterSettings = leagueData?.rosterSettings || { bench: 4, forwards: { starters: 6, max: 10 }, defense: { starters: 4, max: 8 }, goalies: { starters: 1, max: 3 } };
        const maxLimit = p.pos === 'F' ? (rosterSettings.forwards?.max ?? 10) :
                         p.pos === 'D' ? (rosterSettings.defense?.max ?? 8) :
                         (rosterSettings.goalies?.max ?? 3);
        const isLimitReached = posCounts[p.pos] >= maxLimit;
        const isDrafted = draftedSet.has(p.id);

        return (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4 animate-fade-in" onClick={() => setSelectedCardPlayer(null)}>
            <div 
              className="bg-white rounded-[32px] shadow-2xl max-w-md w-full overflow-hidden animate-scale-up"
              onClick={e => e.stopPropagation()}
            >
              {/* Card Header with Team Branding */}
              <div className={`bg-gradient-to-br ${branding.gradient} p-6 text-white relative overflow-hidden`}>
                <div className="absolute inset-0 bg-gradient-to-t from-black/30 to-transparent" />
                <div className="relative z-10">
                  <div className="flex justify-between items-start">
                    <div>
                      <div className="flex items-center gap-2 mb-2">
                        <span className={`px-2.5 py-0.5 rounded-lg text-[10px] font-black border ${p.pos === 'G' ? 'bg-amber-500/20 text-amber-200 border-amber-400/30' : p.pos === 'D' ? 'bg-emerald-500/20 text-emerald-200 border-emerald-400/30' : 'bg-white/20 text-white/90 border-white/30'}`}>
                          {p.pos}
                        </span>
                        <span className="text-[10px] font-bold text-white/60">#{p.jersey}</span>
                      </div>
                      <h2 className="font-sports text-2xl font-black tracking-tight leading-tight">{p.name}</h2>
                    </div>
                    <button 
                      onClick={() => setSelectedCardPlayer(null)}
                      className="w-8 h-8 rounded-xl bg-white/10 hover:bg-white/20 flex items-center justify-center text-white/70 hover:text-white transition-all"
                    >
                      ✕
                    </button>
                  </div>
                  <div className="flex items-center gap-3 mt-3">
                    {teamInfo.logo && <img src={teamInfo.logo} alt="" className="w-6 h-6 object-contain" />}
                    <span className="text-sm font-bold text-white/80">{teamInfo.name || teamInfo.code || 'Free Agent'}</span>
                  </div>
                </div>
              </div>

              {/* Player Details */}
              <div className="p-6 space-y-5">
                {/* Bio Row */}
                <div className="grid grid-cols-3 gap-3">
                  <div className="bg-gray-50 border border-gray-150 rounded-xl p-3 text-center">
                    <span className="text-[9px] font-black text-gray-400 uppercase tracking-wider block">Shoots</span>
                    <span className="text-sm font-black text-gray-800 block mt-0.5">{p.shoots}</span>
                  </div>
                  <div className="bg-gray-50 border border-gray-150 rounded-xl p-3 text-center">
                    <span className="text-[9px] font-black text-gray-400 uppercase tracking-wider block">Height</span>
                    <span className="text-sm font-black text-gray-800 block mt-0.5">{p.height}</span>
                  </div>
                  <div className="bg-gray-50 border border-gray-150 rounded-xl p-3 text-center">
                    <span className="text-[9px] font-black text-gray-400 uppercase tracking-wider block">Rank</span>
                    <span className="text-sm font-black text-gray-800 block mt-0.5">{p.overallRank && p.overallRank !== 999 ? `#${p.overallRank}` : '-'}</span>
                  </div>
                </div>

                {/* Stats Section */}
                <div>
                  <h4 className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-3">
                    {statViewMode === 'projections' ? '📊 Projected Stats' : '📋 Last Season Stats'}
                  </h4>
                  {isGoalie ? (
                    <div className="grid grid-cols-3 gap-2">
                      {[
                        { label: 'GP', val: s.gamesPlayed },
                        { label: 'W', val: s.wins },
                        { label: 'L', val: s.losses },
                        { label: 'OTL', val: s.overtimeLosses },
                        { label: 'GA', val: s.goalsAgainst },
                        { label: 'SV', val: s.shotsSaved },
                        { label: 'SO', val: s.shutouts },
                        { label: 'FPTS', val: p.fpts?.toFixed(1) },
                      ].map(stat => (
                        <div key={stat.label} className="bg-gray-50 border border-gray-100 rounded-lg p-2 text-center">
                          <span className="text-[8px] font-black text-gray-400 uppercase block">{stat.label}</span>
                          <span className="text-xs font-black text-gray-800 block">{stat.val || 0}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="grid grid-cols-3 gap-2">
                      {[
                        { label: 'GP', val: s.gamesPlayed },
                        { label: 'G', val: s.goals },
                        { label: 'A', val: s.assists },
                        { label: '+/-', val: s.plusMinus },
                        { label: 'PPP', val: s.powerPlayPoints },
                        { label: 'SHP', val: s.shortHandedPoints },
                        { label: 'SOG', val: s.shotsOnGoal },
                        { label: 'HIT', val: s.hits },
                        { label: 'BLK', val: s.blockedShots },
                        { label: 'FPTS', val: p.fpts?.toFixed(1) },
                      ].map(stat => (
                        <div key={stat.label} className="bg-gray-50 border border-gray-100 rounded-lg p-2 text-center">
                          <span className="text-[8px] font-black text-gray-400 uppercase block">{stat.label}</span>
                          <span className="text-xs font-black text-gray-800 block">{stat.val || 0}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Draft Action */}
                <div className="pt-2 border-t border-gray-100">
                  {isDrafted ? (
                    <div className="w-full py-3 rounded-2xl bg-gray-100 text-center text-[10px] font-black uppercase tracking-wider text-gray-400">
                      Already Drafted
                    </div>
                  ) : isLimitReached ? (
                    <div className="w-full py-3 rounded-2xl bg-amber-50 border border-amber-100 text-center text-[10px] font-black uppercase tracking-wider text-amber-600">
                      Position Limit Reached ({p.pos})
                    </div>
                  ) : (
                    <button
                      onClick={() => {
                        handleSelectPlayer(p.id);
                        setSelectedCardPlayer(null);
                      }}
                      disabled={!isMyTurn || isSubmitting}
                      className={`w-full py-3.5 rounded-2xl text-xs font-black uppercase tracking-wider transition-all active:scale-[0.98] ${
                        isMyTurn
                          ? 'bg-gradient-to-r from-indigo-600 to-violet-600 text-white shadow-lg shadow-indigo-600/20 hover:from-indigo-500 hover:to-violet-500'
                          : 'bg-gray-100 text-gray-400 border border-gray-200 cursor-not-allowed'
                      }`}
                    >
                      {isSubmitting ? '⏳ Submitting...' : isMyTurn ? `⚡ Draft ${p.name}` : 'Not Your Turn'}
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        );
      })()}

    </div>
  );
}
