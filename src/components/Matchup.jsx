import React, { useState, useEffect } from 'react';
import { db } from '../firebase.js';
import { doc, getDoc, collection, getDocs, query, where, updateDoc } from 'firebase/firestore';
import { useAuth } from '../contexts/AuthContext';
import { useTimeTravel } from '../contexts/TimeTravelContext';

export default function Matchup({ activeLeagueId, setCurrentTab }) {
  const { currentUser } = useAuth();
  const { activeSeasonId, getSimulatedDate, simulationState } = useTimeTravel();
  const [activeTab, setActiveTab] = useState('scoreboard'); // 'scoreboard' | 'rosters' (Used for mobile aspect stack)
  const [leagueData, setLeagueData] = useState(null);
  const [teams, setTeams] = useState([]);
  const [loading, setLoading] = useState(true);
  const [timeLeft, setTimeLeft] = useState({ days: 0, hours: 0, minutes: 0, seconds: 0, totalMs: 0 });
  const [isDraftDetailsOpen, setIsDraftDetailsOpen] = useState(false);

  const [weeklyMatchups, setWeeklyMatchups] = useState([]);
  const [matchupsLoading, setMatchupsLoading] = useState(true);
  const [playerStats, setPlayerStats] = useState({});

  const [playersMap, setPlayersMap] = useState({});
  const [seasonWeeks, setSeasonWeeks] = useState([]);
  const [isOffWeek, setIsOffWeek] = useState(false);
  const [weekDateRange, setWeekDateRange] = useState('');

  useEffect(() => {
    if (!activeLeagueId) return;
    setLoading(true);
    
    // 1. Fetch league document details
    const docRef = doc(db, 'fantasy_leagues', activeLeagueId);
    getDoc(docRef).then((snap) => {
      if (snap.exists()) {
        setLeagueData(snap.data());
      }
    }).catch(err => {
      console.error("Error loading league status:", err);
    });

    // 2. Fetch league teams list to show factual team names in background
    const tRef = collection(db, `fantasy_leagues/${activeLeagueId}/teams`);
    getDocs(tRef).then((snap) => {
      setTeams(snap.docs.map(d => ({ id: d.id, ...d.data() })));
      setLoading(false);
    }).catch(err => {
      console.error("Error loading teams list:", err);
      setLoading(false);
    });
  }, [activeLeagueId]);

  // Load dynamic players and season weeks list from Firestore
  useEffect(() => {
    if (!activeLeagueId) return;
    
    async function loadSeasonAndPlayers() {
      try {
        const seasonsSnap = await getDocs(collection(db, 'pwhl_seasons'));
        const seasons = seasonsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        
        const seasonId = activeSeasonId ? String(activeSeasonId) : '5';
        
        // Find season doc to get weeks array
        const currentSeasonDoc = seasons.find(s => String(s.season_id) === String(seasonId));
        if (currentSeasonDoc && currentSeasonDoc.weeks) {
          setSeasonWeeks(currentSeasonDoc.weeks);
        } else {
          setSeasonWeeks([]);
        }
        
        const qActive = query(collection(db, 'pwhl_players'), where('season_id', 'in', [seasonId, Number(seasonId)]));
        const snapActive = await getDocs(qActive);
        
        let resolvedSeasonId = seasonId;
        let rawPlayers = snapActive.docs.map(d => d.data());
        
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
          teamsMap[String(t.id)] = t.code || t.name || t.id;
        });
        
        const map = {};
        rawPlayers.forEach(p => {
          const pId = p.player_id || p.id;
          if (!pId) return;
          const rating = p.rating || (p.position === 'G' ? 85 : (p.position === 'D' ? 82 : 84));
          map[String(pId)] = {
            id: String(pId),
            name: p.name || `${p.first_name || ''} ${p.last_name || ''}`.trim() || 'Unknown Player',
            pos: p.position || 'F',
            team: teamsMap[p.current_team_id || p.team_id] || p.team_name || 'FA',
            rating
          };
        });
        
        setPlayersMap(map);
      } catch (err) {
        console.error("Error loading season/players in Matchup:", err);
      }
    }
    
    loadSeasonAndPlayers();
  }, [activeLeagueId, activeSeasonId, leagueData]);

  // Fetch matchups and player stats when leagueData updates
  useEffect(() => {
    if (!activeLeagueId || !leagueData) return;
    const currentWeek = leagueData.currentWeek || 1;
    const matchupsRef = collection(db, `fantasy_leagues/${activeLeagueId}/matchups`);
    setMatchupsLoading(true);
    
    getDocs(matchupsRef).then((snap) => {
      const allMatchups = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      const filtered = allMatchups.filter(m => m.week === currentWeek);
      setWeeklyMatchups(filtered);
      setMatchupsLoading(false);
    }).catch(err => {
      console.error("Error loading matchups:", err);
      setMatchupsLoading(false);
    });

    // Fetch player fantasy points for this league
    const statsRef = collection(db, 'pwhl_season_player_stats');
    getDocs(statsRef).then((snap) => {
      const statsMap = {};
      snap.docs.forEach(d => {
        const data = d.data();
        if (data.leagueId === activeLeagueId) {
          statsMap[data.playerId] = data.fantasyPoints || 0.0;
        }
      });
      setPlayerStats(statsMap);
    }).catch(err => {
      console.error("Error loading player stats:", err);
    });
  }, [activeLeagueId, leagueData]);

  useEffect(() => {
    if (!leagueData || !leagueData.draftDate) return;

    const calculateTimeLeft = () => {
      const difference = new Date(leagueData.draftDate) - getSimulatedDate();
      if (difference <= 0) {
        setTimeLeft({ days: 0, hours: 0, minutes: 0, seconds: 0, totalMs: difference });
        return;
      }

      const days = Math.floor(difference / (1000 * 60 * 60 * 24));
      const hours = Math.floor((difference / (1000 * 60 * 60)) % 24);
      const minutes = Math.floor((difference / 1000 / 60) % 60);
      const seconds = Math.floor((difference / 1000) % 60);

      setTimeLeft({ days, hours, minutes, seconds, totalMs: difference });
    };

    calculateTimeLeft();
    const interval = setInterval(calculateTimeLeft, 1000);
    return () => clearInterval(interval);
  }, [leagueData]);

  // Resolve week date range and off-week status when seasonWeeks/currentWeek updates
  useEffect(() => {
    if (!leagueData) return;
    const currentWeek = leagueData.currentWeek || 1;
    
    if (seasonWeeks && seasonWeeks.length > 0) {
      const wk = seasonWeeks.find(w => w.week === currentWeek);
      if (wk) {
        setIsOffWeek(!!wk.isOffWeek);
        const start = new Date(wk.start);
        const end = new Date(wk.end);
        const options = { month: 'short', day: 'numeric' };
        setWeekDateRange(`${start.toLocaleDateString('en-US', options)} - ${end.toLocaleDateString('en-US', options)}`);
        return;
      }
    }
    
    setIsOffWeek(false);
    // Fallback date calculation
    const baseTime = new Date("2024-01-01T03:00:00-08:00").getTime();
    const weekMs = 7 * 24 * 60 * 60 * 1000;
    const start = new Date(baseTime + (currentWeek - 1) * weekMs);
    const end = new Date(baseTime + currentWeek * weekMs - 1000);
    const options = { month: 'short', day: 'numeric' };
    setWeekDateRange(`${start.toLocaleDateString('en-US', options)} - ${end.toLocaleDateString('en-US', options)}`);
  }, [leagueData, seasonWeeks]);

  if (!activeLeagueId) {
    return (
      <div className="min-h-[80vh] flex flex-col items-center justify-center px-6 text-center select-none">
        <div className="w-20 h-20 rounded-full bg-indigo-50 border border-indigo-100 flex items-center justify-center text-4xl mb-6 shadow-md animate-pulse">
          🏆
        </div>
        <h2 className="text-2xl font-sports font-black text-gray-900 tracking-tight">No Active League</h2>
        <p className="text-gray-500 mt-2 max-w-sm text-xs font-semibold leading-relaxed">
          Unlock your team command center! Create or join a fantasy league in the League tab to view live weekly matchups.
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="min-h-[80vh] flex items-center justify-center">
        <div className="text-xs font-black tracking-widest text-gray-400 uppercase animate-pulse">
          Syncing Matchup Data...
        </div>
      </div>
    );
  }

  const isPending = leagueData && (
    leagueData.status === 'pending' || 
    (leagueData.members && leagueData.members.length < leagueData.maxTeams) || 
    !leagueData.draftDate
  );
  const isCommissioner = leagueData && currentUser && currentUser.uid === leagueData.ownerId;
  const hasDraftDate = leagueData && !!leagueData.draftDate;
  
  // Imminent threshold: less than 1 hour away (or date has passed but status is still pending)
  const isDraftImminent = hasDraftDate && (timeLeft.totalMs <= 60 * 60 * 1000);
  
  // Factual check if the league is full or waiting for teams
  const isFull = leagueData && leagueData.members && (leagueData.members.length >= leagueData.maxTeams);

  // Extract factual team details from Firestore loaded lists
  const myTeam = teams.find(t => t.ownerId === currentUser?.uid) || { teamName: "My Team", avatar: "🏒" };
  const oppTeam = teams.find(t => t.ownerId !== currentUser?.uid) || { teamName: "Waiting for Opponent", avatar: "🥅" };

  const currentWeek = leagueData?.currentWeek || 1;

  const myTeamMatchup = myTeam ? weeklyMatchups.find(m => m.homeTeamId === myTeam.id || m.awayTeamId === myTeam.id) : null;
  const isHome = myTeam && myTeamMatchup && myTeam.id === myTeamMatchup.homeTeamId;
  const myScore = myTeamMatchup ? (isHome ? myTeamMatchup.homeScore : myTeamMatchup.awayScore) : 0.0;
  const oppScore = myTeamMatchup ? (isHome ? myTeamMatchup.awayScore : myTeamMatchup.homeScore) : 0.0;

  const oppTeamId = myTeamMatchup ? (isHome ? myTeamMatchup.awayTeamId : myTeamMatchup.homeTeamId) : null;
  const resolvedOppTeam = teams.find(t => t.id === oppTeamId) || oppTeam;

  let winProb = 50;
  if (myTeamMatchup && (myScore > 0 || oppScore > 0)) {
    winProb = Math.round((myScore / (myScore + oppScore)) * 100);
    if (winProb < 5) winProb = 5;
    if (winProb > 95) winProb = 95;
  }

  const buildStartingLineups = () => {
    if (!myTeam || !resolvedOppTeam) return [];
    
    const myPlayers = myTeam.players || [];
    const oppPlayers = resolvedOppTeam.players || [];

    const slots = [
      { label: "F", pos: "F" },
      { label: "F", pos: "F" },
      { label: "F", pos: "F" },
      { label: "F", pos: "F" },
      { label: "F", pos: "F" },
      { label: "F", pos: "F" },
      { label: "D", pos: "D" },
      { label: "D", pos: "D" },
      { label: "D", pos: "D" },
      { label: "D", pos: "D" },
      { label: "G", pos: "G" }
    ];

    const myUnused = [...myPlayers];
    const oppUnused = [...oppPlayers];

    const getMockPos = (id) => {
      const numId = parseInt(String(id).replace(/^\D+/g, ''), 10);
      if (!isNaN(numId)) {
        if (numId >= 12 && numId <= 14) return "G";
        if (numId >= 8 && numId <= 11) return "D";
      }
      return "F";
    };

    return slots.map((slot) => {
      const myMatchIdx = myUnused.findIndex(id => {
        const info = playersMap[id] || {};
        const pos = info.pos || getMockPos(id);
        return pos === slot.pos;
      });
      let myP = null;
      if (myMatchIdx !== -1) {
        myP = myUnused[myMatchIdx];
        myUnused.splice(myMatchIdx, 1);
      }

      const oppMatchIdx = oppUnused.findIndex(id => {
        const info = playersMap[id] || {};
        const pos = info.pos || getMockPos(id);
        return pos === slot.pos;
      });
      let oppP = null;
      if (oppMatchIdx !== -1) {
        oppP = oppUnused[oppMatchIdx];
        oppUnused.splice(oppMatchIdx, 1);
      }

      return {
        slotLabel: slot.label,
        slotPos: slot.pos,
        myPlayer: myP ? { id: myP, ...playersMap[myP] } : null,
        oppPlayer: oppP ? { id: oppP, ...playersMap[oppP] } : null
      };
    });
  };

  const comparisonLineups = buildStartingLineups();

  return (
    <div className="relative font-sans select-none antialiased">
      
      {/* ── HEADER ── */}
      <div className="flex justify-between items-center mb-6">
        <div>
          <span className="text-[10px] uppercase font-black tracking-widest text-indigo-600 bg-indigo-50 px-3 py-1.5 rounded-full border border-indigo-100">
            Week {currentWeek}
          </span>
          <h1 className="font-sports text-3xl font-black mt-3 tracking-tight text-gray-900">
            Active Matchup
          </h1>
          <p className="text-xs text-gray-400 font-semibold tracking-wide mt-0.5">{weekDateRange}</p>
        </div>
        
        {/* Pulsing Live Badge */}
        <div className="flex items-center gap-2 bg-emerald-50 border border-emerald-100 px-3 py-1.5 rounded-full">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
          </span>
          <span className="text-[10px] uppercase font-black text-emerald-600 tracking-wider">LIVE Tracker</span>
        </div>
      </div>

      {/* ── 1. DRAFT STATUS BANNER/CARD AT THE TOP (Pre-Draft State) ── */}
      {isPending && (
        <div className="mb-8 animate-scale-up">
          
          {/* STATE 1: WAITING FOR LEAGUE TO FILL */}
          {!isFull && (
            <div className="w-full bg-white border border-gray-200 rounded-[28px] p-6 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div className="flex items-center gap-4 text-left">
                <div className="w-14 h-14 rounded-2xl bg-indigo-50 border border-indigo-100 flex items-center justify-center text-2xl text-indigo-600 shadow-inner">
                  👥
                </div>
                <div>
                  <h2 className="font-sports text-xl font-black text-gray-900 leading-tight">Waiting for League to Fill</h2>
                  <p className="text-xs text-gray-400 font-semibold mt-1">
                    Franchise Recruitment: {leagueData.members.length} of {leagueData.maxTeams} teams joined
                  </p>
                </div>
              </div>

              {/* Invite Code Panel */}
              <div className="flex items-center gap-3 bg-gray-50 border border-gray-200 px-4 py-2.5 rounded-2xl shadow-inner">
                <span className="text-[10px] font-black text-gray-400 uppercase tracking-widest px-1">Invite Code:</span>
                <span className="text-sm font-black tracking-widest text-indigo-600">{leagueData.inviteCode}</span>
                <button 
                  onClick={() => {
                    navigator.clipboard.writeText(leagueData.inviteCode);
                    alert("Invite Code copied successfully!");
                  }}
                  className="text-[10px] font-black uppercase text-indigo-600 bg-white border border-gray-200 px-3 py-1.5 rounded-xl hover:bg-gray-50 active:scale-95 transition-all shadow-sm"
                >
                  Copy
                </button>
              </div>

              {isCommissioner ? (
                <button
                  onClick={() => setCurrentTab('manager')}
                  className="px-6 py-4 bg-indigo-600 hover:bg-indigo-500 text-white rounded-2xl text-xs font-black uppercase tracking-wider shadow-md shadow-indigo-600/10 active:scale-95 transition-transform"
                >
                  ⚙️ LM Toolset
                </button>
              ) : (
                <div className="py-3 px-5 bg-gray-50 border border-gray-200 rounded-2xl text-xs font-black uppercase text-gray-400 tracking-wider">
                  Waiting for members
                </div>
              )}
            </div>
          )}

          {/* STATE 2: LEAGUE FULL, DRAFT NOT SCHEDULED */}
          {isFull && !hasDraftDate && (
            <div className="w-full bg-white border border-amber-200 rounded-[28px] p-6 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div className="flex items-center gap-4 text-left">
                <div className="w-14 h-14 rounded-2xl bg-amber-50 border border-amber-100 flex items-center justify-center text-2xl text-amber-500 animate-bounce">
                  📅
                </div>
                <div>
                  <h2 className="font-sports text-xl font-black text-gray-900 leading-tight">Draft Not Scheduled</h2>
                  <p className="text-xs text-gray-505 font-semibold mt-1">
                    League is full and locked! The League Manager must schedule the draft in the LM Toolset.
                  </p>
                </div>
              </div>

              {isCommissioner ? (
                <div className="flex gap-2">
                  {simulationState?.testModeActive && (
                    <button
                      onClick={() => setIsDraftDetailsOpen(true)}
                      className="px-5 py-4 bg-indigo-600 hover:bg-indigo-500 text-white rounded-2xl text-xs font-black uppercase tracking-wider active:scale-95 transition-all shadow-md shadow-indigo-600/10"
                    >
                      📋 Draft Lobby
                    </button>
                  )}
                  <button
                    onClick={() => setCurrentTab('manager')}
                    className="px-6 py-4 bg-white border border-gray-200 text-gray-700 hover:bg-gray-50 rounded-2xl text-xs font-black uppercase tracking-wider shadow-sm active:scale-95 transition-transform"
                  >
                    ⚙️ Edit Draft Settings
                  </button>
                </div>
              ) : (
                <div className="py-3 px-5 bg-gray-50 border border-gray-200 rounded-2xl text-xs font-black uppercase text-gray-400 tracking-wider">
                  Waiting for Commissioner
                </div>
              )}
            </div>
          )}

          {/* STATE 3: DRAFT SCHEDULED */}
          {isFull && hasDraftDate && !isDraftImminent && (
            <div className="w-full bg-white border border-gray-200 rounded-[28px] p-6 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div className="flex items-center gap-4 text-left">
                <div className="w-14 h-14 rounded-2xl bg-indigo-50 border border-indigo-100 flex items-center justify-center text-2xl text-indigo-600">
                  💜
                </div>
                <div>
                  <h2 className="font-sports text-xl font-black text-gray-900 leading-tight">Draft Scheduled</h2>
                  <p className="text-xs text-gray-400 font-semibold mt-1">
                    Lobby opens: {new Date(leagueData.draftDate).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
                  </p>
                </div>
              </div>

              {/* Countdown Panel */}
              <div className="flex items-center gap-2 bg-gray-50 border border-gray-200 p-3 rounded-2xl shadow-inner">
                <span className="text-[10px] font-black text-gray-400 uppercase tracking-widest px-1 mr-1">Countdown:</span>
                <span className="text-sm font-black text-indigo-600 bg-indigo-50 px-2.5 py-1.5 rounded-xl border border-indigo-100">{timeLeft.days}d</span>
                <span className="text-sm font-black text-indigo-600 bg-indigo-50 px-2.5 py-1.5 rounded-xl border border-indigo-100">{timeLeft.hours}h</span>
                <span className="text-sm font-black text-indigo-600 bg-indigo-50 px-2.5 py-1.5 rounded-xl border border-indigo-100">{timeLeft.minutes}m</span>
                <span className="text-sm font-black text-indigo-600 bg-indigo-50 px-2.5 py-1.5 rounded-xl border border-indigo-100 animate-pulse">{timeLeft.seconds}s</span>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => setIsDraftDetailsOpen(true)}
                  className="px-5 py-4 bg-indigo-600 hover:bg-indigo-500 text-white rounded-2xl text-xs font-black uppercase tracking-wider active:scale-95 transition-all shadow-md shadow-indigo-600/10"
                >
                  📋 Draft Lobby
                </button>
                {isCommissioner && (
                  <button
                    onClick={() => setCurrentTab('manager')}
                    className="px-5 py-4 bg-white border border-gray-200 text-gray-700 hover:bg-gray-50 rounded-2xl text-xs font-black uppercase tracking-wider active:scale-95 transition-all shadow-sm"
                  >
                    ⚙️ LM Settings
                  </button>
                )}
              </div>
            </div>
          )}

          {/* STATE 4: DRAFT IMMINENT */}
          {isFull && hasDraftDate && isDraftImminent && (
            <div className="w-full bg-white border-2 border-indigo-500 rounded-[28px] p-6 shadow-md flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div className="flex items-center gap-4 text-left">
                <div className="w-14 h-14 rounded-2xl bg-indigo-50 border border-indigo-100 flex items-center justify-center text-2xl text-indigo-600 animate-pulse">
                  ⚡
                </div>
                <div>
                  <h2 className="font-sports text-xl font-black text-gray-900 leading-tight">Draft is Imminent!</h2>
                  <p className="text-xs text-gray-400 font-semibold mt-1">
                    {timeLeft.totalMs > 0 ? `Lobby opens in: ${timeLeft.minutes}m ${timeLeft.seconds}s` : 'Draft lobby is now OPEN!'}
                  </p>
                </div>
              </div>

              <button
                onClick={() => setIsDraftDetailsOpen(true)}
                className="px-8 py-4.5 bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-white rounded-2xl text-xs font-black uppercase tracking-wider shadow-xl shadow-indigo-600/20 active:scale-95 transition-transform animate-pulse"
              >
                ENTER DRAFT
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── DRAFT DETAILS & LOBBY MODAL ── */}
      {isDraftDetailsOpen && leagueData && (
        <div className="fixed inset-0 bg-slate-950/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white border border-gray-200 w-full max-w-lg rounded-[36px] overflow-hidden shadow-2xl flex flex-col max-h-[85vh] animate-scale-up">
            
            {/* Modal Header */}
            <div className="p-6 border-b border-gray-100 flex items-center justify-between">
              <div>
                <span className="text-[9px] uppercase font-black text-indigo-600 bg-indigo-50 px-2.5 py-1 rounded-full border border-indigo-100">
                  {leagueData.status === 'drafting' ? '⚡ Drafting Live' : leagueData.status === 'active' ? '🏆 Recap' : '📅 Scheduled'}
                </span>
                <h3 className="font-sports text-xl font-black text-gray-900 mt-2">
                  Draft Arena Details
                </h3>
              </div>
              <button 
                onClick={() => setIsDraftDetailsOpen(false)}
                className="w-10 h-10 rounded-full bg-gray-50 border border-gray-200 flex items-center justify-center hover:bg-gray-100 active:scale-95 transition-all text-gray-500 font-bold"
              >
                ✕
              </button>
            </div>

            {/* Modal Content */}
            <div className="p-6 overflow-y-auto space-y-5 text-left">
              <div>
                <label className="text-[10px] font-black text-gray-400 uppercase tracking-widest block mb-1">Scheduled Start Time</label>
                <span className="text-sm font-black text-gray-800">
                  {leagueData.draftDate ? new Date(leagueData.draftDate).toLocaleString() : 'Not Scheduled (Simulation Mode)'}
                </span>
              </div>

              {/* Countdown Ticker */}
              {leagueData.status !== 'drafting' && leagueData.status !== 'active' && (
                <div>
                  <label className="text-[10px] font-black text-gray-400 uppercase tracking-widest block mb-2">Countdown</label>
                  <div className="flex gap-2">
                    <span className="text-xs font-black text-indigo-600 bg-indigo-50 px-2.5 py-1.5 rounded-xl border border-indigo-100">{timeLeft.days}d</span>
                    <span className="text-xs font-black text-indigo-600 bg-indigo-50 px-2.5 py-1.5 rounded-xl border border-indigo-100">{timeLeft.hours}h</span>
                    <span className="text-xs font-black text-indigo-600 bg-indigo-50 px-2.5 py-1.5 rounded-xl border border-indigo-100">{timeLeft.minutes}m</span>
                    <span className="text-xs font-black text-indigo-600 bg-indigo-50 px-2.5 py-1.5 rounded-xl border border-indigo-100 animate-pulse">{timeLeft.seconds}s</span>
                  </div>
                </div>
              )}

              {/* Draft Order List */}
              <div>
                <label className="text-[10px] font-black text-gray-400 uppercase tracking-widest block mb-2">Locked Snake Draft Order</label>
                <div className="space-y-2 border border-gray-100 rounded-2xl p-4 bg-gray-50/50">
                  {(leagueData.draftOrder || leagueData.members || []).map((uid, idx) => {
                    const team = teams.find(t => t.ownerId === uid);
                    return (
                      <div key={uid} className="flex items-center justify-between bg-white border border-gray-150 p-2.5 rounded-xl shadow-sm">
                        <div className="flex items-center gap-3">
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
              </div>
            </div>

            {/* Modal Footer / CTA */}
            <div className="p-6 border-t border-gray-100 bg-gray-50/50 flex flex-col gap-3">
              {(() => {
                const isDraftActive = leagueData.status === 'drafting';
                const isDraftCompleted = leagueData.status === 'active';
                const isLobbyOpen = hasDraftDate && (timeLeft.totalMs <= 60 * 60 * 1000); // 1 hour
                const isTestAdmin = simulationState?.testModeActive && isCommissioner;
                const canEnter = isLobbyOpen || isDraftActive || isDraftCompleted || isTestAdmin;

                let buttonText = "Enter Draft Room";
                if (isDraftCompleted) buttonText = "View Draft Recap";
                else if (isDraftActive) buttonText = "Enter Live Draft ⚡";
                else if (isTestAdmin && !hasDraftDate) buttonText = "Start & Enter Draft Room ⚡";

                return (
                  <>
                    <button
                      onClick={async () => {
                        if (isTestAdmin && leagueData.status !== 'drafting' && leagueData.status !== 'active') {
                          // Update draftDate to 1 minute in the future
                          const simulatedNow = getSimulatedDate();
                          const newDraftDate = new Date(simulatedNow.getTime() + 60000).toISOString();
                          try {
                            const leagueRef = doc(db, 'fantasy_leagues', activeLeagueId);
                            await updateDoc(leagueRef, { draftDate: newDraftDate });
                          } catch (err) {
                            console.error("Failed to fast-start draft in simulation mode:", err);
                          }
                        }
                        setIsDraftDetailsOpen(false);
                        setCurrentTab('draft_room');
                      }}
                      disabled={!canEnter}
                      className={`w-full py-4 rounded-2xl text-xs font-black uppercase tracking-wider transition-all active:scale-95 shadow-md flex items-center justify-center gap-2 ${canEnter ? 'bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-white shadow-indigo-600/10' : 'bg-gray-100 border border-gray-200 text-gray-400 cursor-not-allowed shadow-none'}`}
                    >
                      {buttonText}
                    </button>
                    {!canEnter && (
                      <span className="text-[10px] text-gray-400 font-semibold text-center mt-1">
                        🔒 Draft Lobby opens 1 hour prior to scheduled date
                      </span>
                    )}
                  </>
                );
              })()}
            </div>
          </div>
        </div>
      )}

      {/* ── 2. PRE-DRAFT MATCHUP SHADOW SHEET (PREMIUM RESPONSIVE DESKTOP GRID) ── */}
      {isOffWeek ? (
        <div className="w-full bg-white border border-gray-200 rounded-[32px] p-8 shadow-sm flex flex-col items-center justify-center text-center gap-4 animate-scale-up min-h-[40vh]">
          <div className="w-16 h-16 rounded-2xl bg-indigo-50 border border-indigo-100 flex items-center justify-center text-3xl shadow-inner">
            💤
          </div>
          <div>
            <h2 className="font-sports text-2xl font-black text-gray-900 leading-tight">Off Week</h2>
            <p className="text-xs text-gray-400 font-semibold mt-2 max-w-sm mx-auto">
              No PWHL games are scheduled for this week. No matchups will occur, so sit back, relax, and rest your roster!
            </p>
          </div>
        </div>
      ) : (
        <div className={`${isPending ? 'blur-[1.5px] opacity-45 pointer-events-none' : ''} transition-all duration-300`}>
        
        {/* RESPONSIVE LAYOUT CONTAINER */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          
          {/* LEFT PANEL (H2H Duel Card) */}
          <div className="lg:col-span-4 space-y-6">
            
            {/* HEAD-TO-HEAD DUEL CARD */}
            <div className="bg-white border border-gray-200 rounded-[32px] p-6 shadow-sm relative overflow-hidden">
              <div className="flex justify-between items-center">
                {/* Team A */}
                <div className="text-center w-[40%] flex flex-col items-center">
                  <div className="w-16 h-16 rounded-3xl bg-indigo-50 border border-indigo-100 flex items-center justify-center text-3xl shadow-sm">
                    {myTeam.avatar || '🏒'}
                  </div>
                  <h3 className="text-xs font-black text-gray-800 mt-3 truncate w-full">{myTeam.teamName}</h3>
                  <p className="text-[10px] text-indigo-600 font-bold mt-0.5">You</p>
                  
                  <p className="text-3xl font-black text-gray-900 mt-3 tracking-tight">{myScore.toFixed(1)}</p>
                  <p className="text-[9px] text-gray-400 font-black uppercase tracking-wider mt-1">
                    Proj: {myTeamMatchup ? (myScore * 1.15).toFixed(1) : '0.0'}
                  </p>
                </div>

                {/* VS Score Counter */}
                <div className="flex flex-col items-center justify-center w-[20%]">
                  <div className="text-[10px] font-black text-gray-400 tracking-widest uppercase mb-1">VS</div>
                  <div className="w-12 h-6 rounded-full bg-gray-50 border border-gray-200 flex items-center justify-center text-[10px] font-black text-gray-500">
                    {myTeam ? `${myTeam.wins || 0}-${myTeam.losses || 0}-${myTeam.ties || 0}` : "0-0"}
                  </div>
                </div>

                {/* Team B */}
                <div className="text-center w-[40%] flex flex-col items-center">
                  <div className="w-16 h-16 rounded-3xl bg-gray-50 border border-gray-200 flex items-center justify-center text-3xl shadow-sm">
                    {resolvedOppTeam.avatar || '🥅'}
                  </div>
                  <h3 className="text-xs font-black text-gray-800 mt-3 truncate w-full">{resolvedOppTeam.teamName}</h3>
                  <p className="text-[10px] text-gray-400 font-bold mt-0.5">Opponent</p>
                  
                  <p className="text-3xl font-black text-gray-900 mt-3 tracking-tight">{oppScore.toFixed(1)}</p>
                  <p className="text-[9px] text-gray-400 font-black uppercase tracking-wider mt-1">
                    Proj: {myTeamMatchup ? (oppScore * 1.15).toFixed(1) : '0.0'}
                  </p>
                </div>
              </div>

              {/* Win Probability Bar */}
              <div className="mt-6 pt-5 border-t border-gray-100">
                <div className="flex justify-between text-[10px] text-gray-400 font-black uppercase tracking-wider mb-2">
                  <span>Win Probability</span>
                  <span className="text-indigo-600">{winProb}% {myTeam.teamName.split(' ').pop()}</span>
                </div>
                <div className="h-2 rounded-full bg-gray-100 overflow-hidden flex">
                  <div className="h-full bg-gradient-to-r from-indigo-600 to-indigo-500" style={{ width: `${winProb}%` }}></div>
                  <div className="h-full bg-gray-200" style={{ width: `${100 - winProb}%` }}></div>
                </div>
              </div>
            </div>

            {/* Mobile-Only Tabs Selector (Hidden on Desktop) */}
            <div className="flex lg:hidden p-1 bg-gray-100 border border-gray-200 rounded-2xl shadow-inner">
              <button
                onClick={() => setActiveTab('scoreboard')}
                className={`flex-1 py-3 text-[10px] font-black uppercase tracking-wider rounded-xl transition-all duration-200 ${activeTab === 'scoreboard' ? 'bg-white text-indigo-600 shadow-sm border border-gray-200' : 'text-gray-400 hover:text-gray-600'}`}
              >
                🏆 Matchups
              </button>
              <button
                onClick={() => setActiveTab('rosters')}
                className={`flex-1 py-3 text-[10px] font-black uppercase tracking-wider rounded-xl transition-all duration-200 ${activeTab === 'rosters' ? 'bg-white text-indigo-600 shadow-sm border border-gray-200' : 'text-gray-400 hover:text-gray-600'}`}
              >
                ⛸️ Roster Compare
              </button>
            </div>
            
          </div>

          {/* RIGHT PANEL (Widescreen side-by-side or toggled columns) */}
          <div className="lg:col-span-8 space-y-6">
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              
              {/* 1. scoreboard matchups panel */}
              <div className={`lg:block ${activeTab === 'scoreboard' ? 'block' : 'hidden'}`}>
                <h3 className="text-xs font-black uppercase tracking-wider text-gray-400 mb-3.5 flex items-center gap-1.5">🏆 Week {currentWeek} Scoreboard</h3>
                <div className="space-y-3">
                  {matchupsLoading ? (
                    <div className="text-center py-8 text-xs text-gray-400 font-bold italic animate-pulse">
                      Loading scoreboard matchups...
                    </div>
                  ) : weeklyMatchups.length === 0 ? (
                    <div className="text-center py-8 text-xs text-gray-400 font-bold italic">
                      No matchups found for this week.
                    </div>
                  ) : (
                    weeklyMatchups.map((m) => {
                      const hTeam = teams.find(t => t.id === m.homeTeamId) || { teamName: m.homeTeamName || "Home Team", avatar: "🏒" };
                      const aTeam = teams.find(t => t.id === m.awayTeamId) || { teamName: m.awayTeamName || "Away Team", avatar: "🥅" };
                      const hScore = m.homeScore || 0;
                      const aScore = m.awayScore || 0;

                      let ratio = 50;
                      if (hScore > 0 || aScore > 0) {
                        ratio = Math.round((hScore / (hScore + aScore)) * 100);
                      }

                      return (
                        <div key={m.id} className="bg-white border border-gray-200 rounded-2xl p-4 flex flex-col gap-3 shadow-sm hover:border-indigo-100 transition-all duration-200">
                          <div className="flex justify-between items-center text-xs font-bold">
                            {/* Home Team */}
                            <div className="flex items-center gap-1.5 min-w-0 flex-1">
                              <span className="text-base shrink-0">{hTeam.avatar || '🏒'}</span>
                              <span className="truncate text-gray-700">{hTeam.teamName}</span>
                            </div>

                            {/* Scores */}
                            <div className="flex items-center gap-2 px-3 shrink-0">
                              <span className={`font-black ${hScore >= aScore ? 'text-gray-900' : 'text-gray-400'}`}>{hScore.toFixed(1)}</span>
                              <span className="text-gray-300 font-semibold">-</span>
                              <span className={`font-black ${aScore >= hScore ? 'text-gray-900' : 'text-gray-400'}`}>{aScore.toFixed(1)}</span>
                            </div>

                            {/* Away Team */}
                            <div className="flex items-center gap-1.5 min-w-0 flex-1 justify-end text-right">
                              <span className="truncate text-gray-700">{aTeam.teamName}</span>
                              <span className="text-base shrink-0">{aTeam.avatar || '🥅'}</span>
                            </div>
                          </div>

                          {/* Visual progress bar */}
                          <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden flex">
                            <div className="h-full bg-indigo-600" style={{ width: `${ratio}%` }}></div>
                            <div className="h-full bg-violet-400" style={{ width: `${100 - ratio}%` }}></div>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              {/* 2. roster comparisons list */}
              <div className={`lg:block ${activeTab === 'rosters' ? 'block' : 'hidden'}`}>
                <h3 className="text-xs font-black uppercase tracking-wider text-gray-400 mb-3.5 flex items-center gap-1.5">⛸️ Starting Lineups Compare</h3>
                <div className="space-y-3">
                  <div className="bg-gray-50 border border-gray-200 rounded-2xl p-3 flex justify-between text-[9px] font-black uppercase text-gray-400 tracking-widest px-4 shadow-inner">
                    <span>{myTeam.teamName.split(' ').pop()} Athletes</span>
                    <span>POS</span>
                    <span>{resolvedOppTeam.teamName.split(' ').pop()} Athletes</span>
                  </div>

                  {myTeam?.players?.length > 0 || resolvedOppTeam?.players?.length > 0 ? (
                    comparisonLineups.map((row, idx) => {
                      const myP = row.myPlayer;
                      const oppP = row.oppPlayer;
                      const myPts = myP ? (playerStats[myP.id] || 0.0) : 0.0;
                      const oppPts = oppP ? (playerStats[oppP.id] || 0.0) : 0.0;

                      return (
                        <div key={idx} className="bg-white border border-gray-200 rounded-2xl p-3 flex justify-between items-center text-xs shadow-sm">
                          {/* My Player */}
                          <div className="flex-1 min-w-0 pr-2">
                            {myP ? (
                              <div className="truncate">
                                <span className="font-black text-gray-800">{myP.name}</span>
                                <span className="text-[10px] text-indigo-600 font-bold block mt-0.5">{myPts.toFixed(1)} pts</span>
                              </div>
                            ) : (
                              <span className="text-gray-300 italic">Empty Slot</span>
                            )}
                          </div>

                          {/* Position */}
                          <div className="w-10 text-center shrink-0">
                            <span className="text-[9px] font-black uppercase px-2 py-0.5 rounded border border-indigo-100 bg-indigo-50 text-indigo-600">
                              {row.slotPos}
                            </span>
                          </div>

                          {/* Opponent Player */}
                          <div className="flex-1 min-w-0 pl-2 text-right">
                            {oppP ? (
                              <div className="truncate">
                                <span className="font-black text-gray-800">{oppP.name}</span>
                                <span className="text-[10px] text-gray-400 font-bold block mt-0.5">{oppPts.toFixed(1)} pts</span>
                              </div>
                            ) : (
                              <span className="text-gray-300 italic">Empty Slot</span>
                            )}
                          </div>
                        </div>
                      );
                    })
                  ) : (
                    <div className="text-center py-16 px-4 text-xs font-bold text-gray-300 italic border border-dashed border-gray-200 rounded-[24px] bg-white/50 shadow-sm flex flex-col items-center justify-center gap-2">
                      <span className="text-2xl">🥅</span>
                      <span>No active rosters. Comparisons will sync post-draft.</span>
                    </div>
                  )}
                </div>
              </div>

            </div>

          </div>
          
        </div>
      </div>
      )}

    </div>
  );
}
