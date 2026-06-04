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
import { initializeDraft, submitDraftPick } from '../services/leagueService';

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

  // Tabs within Draft Room: 'lobby' | 'rosters'
  const [subTab, setSubTab] = useState('lobby'); 
  const [selectedRecapTab, setSelectedRecapTab] = useState('round'); // 'round' | 'team'

  // Timer Countdown state
  const [secondsLeft, setSecondsLeft] = useState(60);
  const [lobbySecondsLeft, setLobbySecondsLeft] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Ref to hold current state to prevent stale closure inside timer loop
  const draftStateRef = useRef(null);
  draftStateRef.current = draftState;

  // 1. Fetch PWHL Player Universe (with fallback, matches Players.jsx resolution)
  useEffect(() => {
    const loadPlayersAndTeams = async () => {
      setPlayersLoading(true);
      try {
        const seasonsSnap = await getDocs(collection(db, 'pwhl_seasons'));
        const seasons = seasonsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

        const seasonId = activeSeasonId ? String(activeSeasonId) : '5';
        const playersQuery = query(collection(db, 'pwhl_players'), where('season_id', 'in', [seasonId, Number(seasonId)]));
        const playersSnap = await getDocs(playersQuery);

        let resolvedSeasonId = seasonId;
        let rawPlayers = playersSnap.docs.map(d => d.data());

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

            const prevPlayersQuery = query(collection(db, 'pwhl_players'), where('season_id', 'in', [resolvedSeasonId, Number(resolvedSeasonId)]));
            const prevPlayersSnap = await getDocs(prevPlayersQuery);
            rawPlayers = prevPlayersSnap.docs.map(d => d.data());
          }
        }

        const teamsQuery = query(collection(db, 'pwhl_teams'), where('season_id', 'in', [resolvedSeasonId, Number(resolvedSeasonId)]));
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
        setPwhlTeams(teamsMap);

        const mappedList = rawPlayers.map((p, idx) => {
          return {
            id: String(p.player_id || p.id || `p_${idx}`),
            name: `${p.first_name || ''} ${p.last_name || ''}`.trim(),
            pos: p.position || 'F',
            teamId: String(p.team_id || ''),
            jersey: p.jersey_number || '-',
            shoots: p.shoots || 'L',
            height: p.height || '-',
            birthDate: p.birth_date || '-'
          };
        });
        setAllPlayers(mappedList);
      } catch (err) {
        console.error("Failed to load players universe in draft room:", err);
      } finally {
        setPlayersLoading(false);
      }
    };

    loadPlayersAndTeams();
  }, [activeSeasonId]);

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
  useEffect(() => {
    if (!draftState || draftState.status !== 'active') return;

    const updateTimer = async () => {
      const deadline = draftState.pickDeadline;
      if (!deadline) return;

      const now = getSimulatedDate().getTime();
      const deadlineMs = deadline.seconds * 1000 + Math.floor(deadline.nanoseconds / 1000000);
      const diffSecs = Math.max(0, Math.floor((deadlineMs - now) / 1000));
      setSecondsLeft(diffSecs);

      // Trigger client-side Auto-pick if timer runs out AND it's current user's turn
      if (diffSecs === 0 && draftStateRef.current?.currentTeamOnClock === currentUser?.uid && !isSubmitting) {
        console.log("[Draft Room] Time expired! Auto-picking top available player...");
        triggerAutoPick();
      }
    };

    updateTimer();
    const interval = setInterval(updateTimer, 1000);
    return () => clearInterval(interval);
  }, [draftState, getSimulatedDate, currentUser]);

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

  // Find the top available player for Auto-Pick, respecting position limits of the picker
  const getTopAvailablePlayer = (pickerUid) => {
    if (!pickerUid) return null;
    const myRosterIds = activeRosters[pickerUid] || [];
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
    const forwardsLimit = rosterSettings.forwards?.max ?? 10;
    const defenseLimit = rosterSettings.defense?.max ?? 8;
    const goaliesLimit = rosterSettings.goalies?.max ?? 3;

    const available = allPlayers.filter(p => {
      if (draftedSet.has(p.id)) return false;
      if (p.pos === 'F' && posCounts.F >= forwardsLimit) return false;
      if (p.pos === 'D' && posCounts.D >= defenseLimit) return false;
      if (p.pos === 'G' && posCounts.G >= goaliesLimit) return false;
      return true;
    });

    if (available.length === 0) return null;
    
    // Prioritize Goalies if we don't have enough goalies to start and goalie limit is not met
    const goalies = available.filter(p => p.pos === 'G');
    if (goalies.length > 0 && posCounts.G < (rosterSettings.goalies?.starters ?? 1)) {
      return goalies[0];
    }
    return available[0];
  };

  const triggerAutoPick = async () => {
    const topPlayer = getTopAvailablePlayer(currentUser.uid);
    if (!topPlayer) return;
    setIsSubmitting(true);
    try {
      await submitDraftPick(activeLeagueId, currentUser.uid, topPlayer.id, true);
    } catch (err) {
      console.error("Auto-pick failed:", err);
    } finally {
      setIsSubmitting(false);
    }
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

  // Available players sorted and filtered
  const filteredPlayers = allPlayers
    .filter(p => !draftedSet.has(p.id))
    .filter(p => {
      if (posFilter === 'ALL') return true;
      return p.pos === posFilter;
    })
    .filter(p => p.name.toLowerCase().includes(searchQuery.toLowerCase()));

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

        {/* Countdown Ring */}
        <div className="flex items-center gap-4">
          <div className="flex flex-col items-center">
            <span className={`text-3xl font-sports font-black leading-none ${isMyTurn ? 'text-white' : 'text-indigo-600'}`}>
              {secondsLeft}s
            </span>
            <span className={`text-[9px] font-black uppercase tracking-wider mt-1 ${isMyTurn ? 'text-indigo-300' : 'text-gray-400'}`}>Time Left</span>
          </div>

          <button
            onClick={() => setCurrentTab('matchup')}
            className={`px-5 py-3 rounded-2xl text-[10px] font-black uppercase tracking-wider transition-all active:scale-95 ${isMyTurn ? 'bg-white/10 text-white hover:bg-white/20' : 'bg-gray-100 text-gray-500 hover:bg-gray-200/70 border border-gray-200'}`}
          >
            Leave Lobby
          </button>
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
              My Roster Sheet
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
                            <span className="text-xs font-black text-gray-800">{team ? team.teamName : `Owner (${uid.slice(0, 6)})`}</span>
                            {isUser && <span className="text-[8px] bg-indigo-100 text-indigo-700 px-1.5 py-0.5 rounded font-black uppercase tracking-wider">You</span>}
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

          {/* Subtab 2: My Team Roster Preview */}
          {subTab === 'rosters' && (
            <div className="bg-white border border-gray-200 rounded-[32px] p-6 shadow-sm space-y-4">
              <h3 className="font-sports text-sm font-black text-gray-900 uppercase tracking-tight">Roster Command Sheet</h3>
              <p className="text-[11px] text-gray-400 font-semibold leading-relaxed">Ensure you fill all available positional slots during the draft process.</p>
              
              {/* Positional Slots Grid */}
              <div className="space-y-2">
                {(() => {
                  const myPIds = activeRosters[currentUser?.uid] || [];
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
            
            {/* Search and Filters Header */}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-gray-100 pb-5">
              <h3 className="font-sports text-base font-black text-gray-900 uppercase tracking-tight">Available Player Universe</h3>
              
              {/* Filters */}
              <div className="flex flex-wrap items-center gap-3">
                <input 
                  type="text" 
                  placeholder="Search player name..." 
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  className="bg-gray-50 border border-gray-200 rounded-xl px-3.5 py-2 text-xs focus:outline-none focus:border-indigo-500 shadow-inner w-44"
                />

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

            {/* Players Grid Table */}
            <div className="overflow-x-auto min-h-[40vh]">
              <table className="w-full border-collapse text-left text-xs font-semibold">
                <thead>
                  <tr className="border-b border-gray-150 text-[10px] uppercase font-black text-gray-400 tracking-widest">
                    <th className="py-3 px-4">#</th>
                    <th className="py-3 px-4">Name</th>
                    <th className="py-3 px-4">Pos</th>
                    <th className="py-3 px-4">Team</th>
                    <th className="py-3 px-4">Shoots</th>
                    <th className="py-3 px-4 text-center">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {filteredPlayers.length === 0 ? (
                    <tr>
                      <td colSpan="6" className="py-12 text-center text-gray-400 text-xs font-bold uppercase tracking-widest">No available players match query.</td>
                    </tr>
                  ) : (
                    filteredPlayers.map((player, idx) => {
                      const pTeam = pwhlTeams[player.teamId] || {};
                      return (
                        <tr key={player.id} className="hover:bg-gray-50/50">
                          <td className="py-3 px-4 text-gray-400">{player.jersey}</td>
                          <td className="py-3 px-4">
                            <span className="font-black text-indigo-600 hover:underline cursor-pointer">{player.name}</span>
                          </td>
                          <td className="py-3 px-4">
                            <span className={`px-2 py-0.5 rounded text-[9px] font-black border ${player.pos === 'G' ? 'bg-amber-50 text-amber-600 border-amber-100' : player.pos === 'D' ? 'bg-emerald-50 text-emerald-600 border-emerald-100' : 'bg-indigo-50 text-indigo-600 border-indigo-100'}`}>
                              {player.pos}
                            </span>
                          </td>
                          <td className="py-3 px-4">
                            <div className="flex items-center gap-1.5">
                              {pTeam.logo && <img src={pTeam.logo} alt="" className="w-4.5 h-4.5 object-contain" />}
                              <span className="font-bold text-gray-600">{pTeam.code || '-'}</span>
                            </div>
                          </td>
                          <td className="py-3 px-4 text-gray-400">{player.shoots}</td>
                          <td className="py-3 px-4 text-center">
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
                                  className={`px-4 py-2 rounded-xl text-[9px] font-black uppercase tracking-wider transition-all active:scale-95 shadow-sm ${
                                    isMyTurn && !isLimitReached
                                      ? 'bg-gradient-to-r from-indigo-600 to-violet-600 text-white shadow-indigo-600/10 hover:from-indigo-500 hover:to-violet-500' 
                                      : 'bg-gray-100 text-gray-400 border border-gray-200 cursor-not-allowed shadow-none'
                                  }`}
                                >
                                  {isLimitReached ? 'Limit Reached' : 'Draft Player'}
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

    </div>
  );
}
