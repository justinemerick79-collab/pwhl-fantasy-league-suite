import React, { useState, useEffect } from 'react';
import { 
  Trophy, Shield, Settings, Users, Calendar, Award, Zap, RotateCw, Trash2, Check, Lock, ChevronRight, Activity, Wrench, Clock, ArrowRightLeft, Send, X, AlertCircle, CheckCircle2, User, Plus
} from 'lucide-react';
import { db } from '../firebase.js';
import { doc, getDoc, updateDoc, collection, getDocs, deleteDoc } from 'firebase/firestore';
import { useAuth } from '../contexts/AuthContext';
import { 
  randomizeDraftOrder, submitTradeProposal, respondToTrade, cancelTradeProposal, cancelWaiverClaim, vetoTrade 
} from '../services/leagueService.js';

export default function League({ activeLeagueId, initialTab, setActiveLeagueId }) {
  const { currentUser } = useAuth();
  const [leagueData, setLeagueData] = useState(null);
  const [teams, setTeams] = useState([]);
  const [loading, setLoading] = useState(true);

  // Transactions & Waivers states
  const [waiverClaims, setWaiverClaims] = useState([]);
  const [trades, setTrades] = useState([]);
  const [playersMap, setPlayersMap] = useState({});
  const [showProposeModal, setShowProposeModal] = useState(false);
  const [tradePartnerId, setTradePartnerId] = useState('');
  const [tradeSends, setTradeSends] = useState([]);
  const [tradeReceives, setTradeReceives] = useState([]);
  const [tradeSubmitting, setTradeSubmitting] = useState(false);
  const [proposerDrops, setProposerDrops] = useState([]);
  const [acceptTradeTarget, setAcceptTradeTarget] = useState(null);
  const [receiverDrops, setReceiverDrops] = useState([]);

  // Trade Settings states
  const [tradeReviewHours, setTradeReviewHours] = useState(48);
  const [enableVetoes, setEnableVetoes] = useState(true);
  const [vetoThreshold, setVetoThreshold] = useState(3);
  const [notifyAcceptedTrades, setNotifyAcceptedTrades] = useState(true);

  // My Team Settings states
  const [teamNameInput, setTeamNameInput] = useState('');
  const [teamAvatarInput, setTeamAvatarInput] = useState('🏒');
  const [savingTeam, setSavingTeam] = useState(false);

  // Commissioner Settings Editor Form states
  const [matchupWeeksInput, setMatchupWeeksInput] = useState(1);
  const [playoffTeamsInput, setPlayoffTeamsInput] = useState(4);
  const [savingSettings, setSavingSettings] = useState(false);

  // Skater scoring states
  const [skaterGoals, setSkaterGoals] = useState(2);
  const [skaterAssists, setSkaterAssists] = useState(1);
  const [skaterPlusMinus, setSkaterPlusMinus] = useState(0.5);
  const [skaterPpp, setSkaterPpp] = useState(0.5);
  const [skaterShp, setSkaterShp] = useState(0.5);
  const [skaterSog, setSkaterSog] = useState(0.1);
  const [skaterHits, setSkaterHits] = useState(0.1);
  const [skaterBlocks, setSkaterBlocks] = useState(0.5);
  const [skaterDefensePoints, setSkaterDefensePoints] = useState(0.5);

  // Goalie scoring states
  const [goalieWins, setGoalieWins] = useState(4);
  const [goalieOtl, setGoalieOtl] = useState(1);
  const [goalieGa, setGoalieGa] = useState(-2);
  const [goalieSaves, setGoalieSaves] = useState(0.2);
  const [goalieShutouts, setGoalieShutouts] = useState(3);

  // Draft Activation States
  const [draftDate, setDraftDate] = useState('');
  const [activating, setActivating] = useState(false);
  const [activateError, setActivateError] = useState('');
  const [randomizing, setRandomizing] = useState(false);

  // Roster Configuration states
  const [forwardsStarters, setForwardsStarters] = useState(6);
  const [forwardsMax, setForwardsMax] = useState(10);
  const [defenseStarters, setDefenseStarters] = useState(4);
  const [defenseMax, setDefenseMax] = useState(8);
  const [goaliesStarters, setGoaliesStarters] = useState(1);
  const [goaliesMax, setGoaliesMax] = useState(3);
  const [benchSize, setBenchSize] = useState(4);

  const handleRandomizeOrder = async () => {
    setRandomizing(true);
    try {
      await randomizeDraftOrder(activeLeagueId);
      alert("Draft order randomized successfully!");
      await fetchLeagueDetails();
    } catch (err) {
      console.error(err);
      alert("Failed to randomize draft order: " + err.message);
    } finally {
      setRandomizing(false);
    }
  };

  const fetchLeagueDetails = async () => {
    if (!activeLeagueId) return;
    setLoading(true);
    try {
      const docRef = doc(db, 'fantasy_leagues', activeLeagueId);
      const snap = await getDoc(docRef);
      if (snap.exists()) {
        const data = snap.data();
        setLeagueData(data);
        if (data.scheduleSettings) {
          setMatchupWeeksInput(data.scheduleSettings.matchupDuration || 1);
          setPlayoffTeamsInput(data.scheduleSettings.playoffTeams || 4);
        }
        if (data.tradeSettings) {
          setTradeReviewHours(data.tradeSettings.tradeReviewHours ?? 48);
          setEnableVetoes(data.tradeSettings.enableVetoes !== false);
          setVetoThreshold(data.tradeSettings.vetoThreshold ?? 3);
          setNotifyAcceptedTrades(data.tradeSettings.notifyAcceptedTrades !== false);
        }
        if (data.rosterSettings) {
          const r = data.rosterSettings;
          setForwardsStarters(r.forwards?.starters ?? 6);
          setForwardsMax(r.forwards?.max ?? 10);
          setDefenseStarters(r.defense?.starters ?? 4);
          setDefenseMax(r.defense?.max ?? 8);
          setGoaliesStarters(r.goalies?.starters ?? 1);
          setGoaliesMax(r.goalies?.max ?? 3);
          setBenchSize(r.bench ?? 4);
        }
        if (data.scoringSettings) {
          const s = data.scoringSettings.skaters || {};
          setSkaterGoals(s.goals ?? 2);
          setSkaterAssists(s.assists ?? 1);
          setSkaterPlusMinus(s.plusMinus ?? 0.5);
          setSkaterPpp(s.ppp ?? 0.5);
          setSkaterShp(s.shp ?? 0.5);
          setSkaterSog(s.sog ?? 0.1);
          setSkaterHits(s.hits ?? 0.1);
          setSkaterBlocks(s.blocks ?? 0.5);
          setSkaterDefensePoints(s.defensePoints ?? 0.5);

          const g = data.scoringSettings.goalies || {};
          setGoalieWins(g.wins ?? 4);
          setGoalieOtl(g.otl ?? 1);
          setGoalieGa(g.ga ?? -2);
          setGoalieSaves(g.saves ?? 0.2);
          setGoalieShutouts(g.shutouts ?? 3);
        }
      }

      const tSnap = await getDocs(collection(db, `fantasy_leagues/${activeLeagueId}/teams`));
      const loadedTeams = tSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      setTeams(loadedTeams);
      
      const userTeam = currentUser ? loadedTeams.find(t => t.ownerId === currentUser.uid) : null;
      if (userTeam) {
        setTeamNameInput(userTeam.teamName || '');
        setTeamAvatarInput(userTeam.avatar || '🏒');
      }

      // Fetch Waiver Claims & Trades
      const claimsSnap = await getDocs(collection(db, `fantasy_leagues/${activeLeagueId}/waiver_claims`));
      setWaiverClaims(claimsSnap.docs.map(d => ({ id: d.id, ...d.data() })));

      const tradesSnap = await getDocs(collection(db, `fantasy_leagues/${activeLeagueId}/trades`));
      setTrades(tradesSnap.docs.map(d => ({ id: d.id, ...d.data() })));

      // Fetch Players dictionary for mapping names in transactions
      const playersSnap = await getDocs(collection(db, "pwhl_players"));
      const pMap = {};
      playersSnap.forEach(pDoc => {
        const pData = pDoc.data();
        const id = pData.player_id || pData.id || pDoc.id.split('_')[1];
        if (id) {
          pMap[String(id)] = {
            id: String(id),
            name: pData.name || `${pData.first_name || ''} ${pData.last_name || ''}`.trim(),
            pos: pData.position || 'F',
            teamCode: pData.team_code || pData.team_id || ''
          };
        }
      });
      setPlayersMap(pMap);
    } catch (err) {
      console.error("Error fetching league details:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLeagueDetails();
  }, [activeLeagueId, currentUser]);

  if (!activeLeagueId) {
    return (
      <div className="min-h-[80vh] flex flex-col items-center justify-center px-6 text-center select-none">
        <div className="w-16 h-16 rounded-full bg-indigo-50 border border-indigo-100 flex items-center justify-center text-3xl mb-6 shadow-sm animate-pulse">
          🏆
        </div>
        <h2 className="text-xl font-sports font-black text-gray-900 tracking-tight">No Active League</h2>
        <p className="text-xs text-gray-500 mt-2 max-w-sm font-semibold leading-relaxed">
          Unlock your command center! Select or join a league to view schedules, standings, and playoff brackets.
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="min-h-[80vh] flex items-center justify-center">
        <div className="text-xs font-black tracking-widest text-gray-400 uppercase animate-pulse">
          Loading League Hub...
        </div>
      </div>
    );
  }

  if (!leagueData) {
    return (
      <div className="min-h-[80vh] flex flex-col items-center justify-center px-6 text-center">
        <h2 className="text-lg font-sports font-black text-gray-900 leading-tight">League Not Found</h2>
      </div>
    );
  }

  const myTeam = currentUser ? teams.find(t => t.ownerId === currentUser.uid) : null;
  const isCommish = currentUser && leagueData && currentUser.uid === leagueData.ownerId;
  const isCommissioner = isCommish;
  const isPending = leagueData && (
    leagueData.status === 'pending' || 
    (leagueData.members && leagueData.members.length < leagueData.maxTeams) || 
    !leagueData.draftDate
  );
  const isFull = (leagueData.members || []).length >= (leagueData.maxTeams || 6);
  const isDraftScheduled = !!leagueData.draftDate;

  // Handle Roster/Settings edits save
  const handleSaveLeagueSettings = async (e) => {
    e.preventDefault();
    if (isDraftScheduled) return;
    setSavingSettings(true);
    try {
      const docRef = doc(db, 'fantasy_leagues', activeLeagueId);
      await updateDoc(docRef, {
        scheduleSettings: {
          matchupDuration: parseInt(matchupWeeksInput),
          playoffTeams: parseInt(playoffTeamsInput),
          playoffDuration: 1
        },
        rosterSettings: {
          forwards: {
            starters: parseInt(forwardsStarters),
            max: parseInt(forwardsMax)
          },
          defense: {
            starters: parseInt(defenseStarters),
            max: parseInt(defenseMax)
          },
          goalies: {
            starters: parseInt(goaliesStarters),
            max: parseInt(goaliesMax)
          },
          bench: parseInt(benchSize)
        },
        scoringSettings: {
          skaters: {
            goals: parseFloat(skaterGoals),
            assists: parseFloat(skaterAssists),
            plusMinus: parseFloat(skaterPlusMinus),
            ppp: parseFloat(skaterPpp),
            shp: parseFloat(skaterShp),
            sog: parseFloat(skaterSog),
            hits: parseFloat(skaterHits),
            blocks: parseFloat(skaterBlocks),
            defensePoints: parseFloat(skaterDefensePoints)
          },
          goalies: {
            wins: parseFloat(goalieWins),
            otl: parseFloat(goalieOtl),
            ga: parseFloat(goalieGa),
            saves: parseFloat(goalieSaves),
            shutouts: parseFloat(goalieShutouts)
          }
        },
        tradeSettings: {
          tradeReviewHours: parseInt(tradeReviewHours, 10),
          enableVetoes: enableVetoes,
          vetoThreshold: parseInt(vetoThreshold, 10),
          notifyAcceptedTrades: notifyAcceptedTrades
        }
      });
      alert("League configurations updated successfully!");
      fetchLeagueDetails();
    } catch (err) {
      console.error(err);
      alert("Failed to update league rules.");
    } finally {
      setSavingSettings(false);
    }
  };

  // Handle unscheduling the draft
  const handleUnscheduleDraft = async () => {
    if (!isPending) {
      alert("Draft has already started or completed and cannot be unscheduled.");
      return;
    }
    if (window.confirm("Are you sure you want to unschedule this draft? This will clear the schedule date and unlock rules settings.")) {
      try {
        const docRef = doc(db, 'fantasy_leagues', activeLeagueId);
        await updateDoc(docRef, {
          draftDate: null
        });
        alert("Draft successfully unscheduled. Roster and Scoring settings are now unlocked!");
        fetchLeagueDetails();
      } catch (err) {
        console.error(err);
        alert("Failed to unschedule draft.");
      }
    }
  };

  // Handle scheduling the draft (Full check enforces this!)
  const handleActivateLeague = async (e) => {
    e.preventDefault();
    setActivateError('');
    if (!isFull) {
      setActivateError("The draft cannot be scheduled until all spots in the league are filled.");
      return;
    }
    if (!draftDate) {
      setActivateError("Please select a draft date.");
      return;
    }
    
    setActivating(true);
    try {
      const docRef = doc(db, 'fantasy_leagues', activeLeagueId);
      await updateDoc(docRef, {
        draftDate: new Date(draftDate).toISOString()
      });
      alert("Draft scheduled successfully! Scoring and Schedule settings are now locked.");
      fetchLeagueDetails();
    } catch (err) {
      console.error(err);
      setActivateError("Failed to schedule draft.");
    } finally {
      setActivating(false);
    }
  };

  // Handle Team profile updates
  const handleUpdateTeamProfile = async (e) => {
    e.preventDefault();
    if (!myTeam || !teamNameInput.trim()) return;
    setSavingTeam(true);
    try {
      const teamRef = doc(db, `fantasy_leagues/${activeLeagueId}/teams`, myTeam.id);
      await updateDoc(teamRef, {
        teamName: teamNameInput.trim(),
        avatar: teamAvatarInput
      });
      alert("Team profile updated successfully!");
      fetchLeagueDetails();
    } catch (err) {
      console.error(err);
      alert("Failed to update team profile.");
    } finally {
      setSavingTeam(false);
    }
  };

  // Handle Deleting the league
  const handleDeleteLeague = async () => {
    if (window.confirm("🔴 DANGER ZONE: Are you absolutely sure you want to delete this league? This will permanently wipe all team sheets, rosters, and schedules. This action is irreversible.")) {
      try {
        const docRef = doc(db, 'fantasy_leagues', activeLeagueId);
        await deleteDoc(docRef);
        alert("League deleted successfully.");
        if (setActiveLeagueId) {
          setActiveLeagueId(null, '');
        }
      } catch (err) {
        console.error(err);
        alert("Failed to delete league.");
      }
    }
  };

  // Dynamic titles and subtitles
  let tabTitle = "League Central";
  let tabSub = "Manage weekly standings, playoff trees, and commissioner configurations.";
  if (initialTab === 'standings') {
    tabTitle = "Standings & Playoffs";
    tabSub = "Track leaderboard rankings and playoff tree qualifiers.";
  } else if (initialTab === 'transactions') {
    tabTitle = "Waivers & Trades Central";
    tabSub = "Track dynamic rolling waiver priority, active claims, and trade proposals.";
  } else if (initialTab === 'schedule') {
    tabTitle = "Settings & Team";
    tabSub = "Customize your team profile and review active league rules.";
  } else if (initialTab === 'manager') {
    tabTitle = "LM Toolset";
    tabSub = "Commissioner controls for drafts, settings, and recruitment.";
  }

  return (
    <div className="min-h-screen px-4 pt-6 pb-24 font-sans select-none antialiased text-slate-800">
      
      {/* ── LEAGUE HEADER ── */}
      <header className="mb-6 flex justify-between items-end flex-wrap gap-4">
        <div>
          <h1 className="font-sports text-3xl font-black tracking-tight text-slate-900">
            {leagueData.name}
          </h1>
          <p className="text-xs text-slate-500 font-medium mt-1">{tabSub}</p>
        </div>
        <div>
          <span className={`text-[10px] uppercase font-black tracking-widest px-2.5 py-1 rounded-lg border shadow-xs ${isPending ? 'bg-amber-50 border-amber-200 text-amber-700' : 'bg-emerald-50 border-emerald-200 text-emerald-700'}`}>
            {leagueData.status}
          </span>
        </div>
      </header>

      {/* ── CONDITIONAL RENDERING BASED ON PROP (NO DOUBLE-NESTED TABS!) ── */}
      <div className="space-y-6">
        
        {/* ── 1. STANDINGS & PLAYOFF BRACKET VIEW ── */}
        {initialTab === 'standings' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
            
            {/* Leaderboard panel (lg:col-span-7) */}
            <div className="lg:col-span-7 bg-white border border-slate-200/80 rounded-2xl overflow-hidden shadow-sm">
              <div className="px-6 py-4.5 border-b border-slate-200 bg-slate-50 flex justify-between items-center">
                <h3 className="text-xs font-black uppercase tracking-wider text-slate-900 flex items-center gap-2">
                  <Trophy className="w-4 h-4 text-amber-500" /> Leaderboard Rankings
                </h3>
                <span className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">{teams.length} Teams Active</span>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50/50 text-[9px] font-black uppercase text-slate-500 tracking-wider">
                      <th className="px-6 py-3.5 w-16 text-center">Rank</th>
                      <th className="px-6 py-3.5">Team</th>
                      <th className="px-6 py-3.5 text-center">Record</th>
                      <th className="px-6 py-3.5 text-right font-sports">Points</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {teams.length === 0 ? (
                      <tr>
                        <td colSpan="4" className="p-8 text-center text-xs text-slate-400 font-bold italic">Standings loading or empty.</td>
                      </tr>
                    ) : (
                      [...teams]
                        .sort((a, b) => {
                          const gamesA = (a.wins || 0) + (a.losses || 0) + (a.ties || 0);
                          const gamesB = (b.wins || 0) + (b.losses || 0) + (b.ties || 0);
                          const winPctA = gamesA > 0 ? ((a.wins || 0) + 0.5 * (a.ties || 0)) / gamesA : 0;
                          const winPctB = gamesB > 0 ? ((b.wins || 0) + 0.5 * (b.ties || 0)) / gamesB : 0;
                          if (winPctB !== winPctA) {
                            return winPctB - winPctA;
                          }
                          return (b.points || 0) - (a.points || 0);
                        })
                        .map((team, idx) => (
                          <tr key={team.id} className="hover:bg-slate-50 transition-colors text-xs">
                            <td className="px-6 py-4 text-center font-black text-slate-400">{idx + 1}</td>
                            <td className="px-6 py-4 font-black text-slate-900 flex items-center gap-2.5">
                              <div className="w-7 h-7 rounded-lg bg-indigo-50 border border-indigo-200 flex items-center justify-center text-xs font-black text-indigo-700 shrink-0">
                                {team.teamName ? team.teamName.slice(0, 2).toUpperCase() : 'TM'}
                              </div>
                              <span className="truncate max-w-[140px] sm:max-w-none">{team.teamName}</span>
                              {team.ownerId === currentUser.uid && (
                                <span className="text-[8px] bg-indigo-50 border border-indigo-200 text-indigo-700 px-1.5 py-0.5 rounded-lg font-black uppercase tracking-wide">
                                  YOU
                                </span>
                              )}
                            </td>
                            <td className="px-6 py-4 text-center font-semibold text-slate-600">
                              {team.wins || 0}-{team.losses || 0}-{team.ties || 0}
                            </td>
                            <td className="px-6 py-4 text-right font-black text-indigo-600">
                              {team.points !== undefined ? Number(team.points).toFixed(1) : '0.0'}
                            </td>
                          </tr>
                        ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Playoff Bracket Tree (lg:col-span-5) */}
            <div className="lg:col-span-5 bg-white border border-slate-200/80 p-6 rounded-2xl shadow-sm">
              <h3 className="text-xs font-black uppercase tracking-wider text-slate-900 border-b border-slate-200 pb-4 mb-5 flex items-center gap-2">
                <Shield className="w-4 h-4 text-indigo-600" /> Playoff Bracket Tree
              </h3>
              
              <div className="space-y-6 relative pl-4 border-l-2 border-slate-200 py-2">
                {/* Semifinal 1 */}
                <div className="relative">
                  <div className="absolute -left-[22px] top-4 w-4 h-[2px] bg-slate-200"></div>
                  <span className="text-[9px] uppercase font-black text-indigo-600 tracking-wider">Semifinal Match A</span>
                  <div className="bg-slate-50 border border-slate-200 p-3.5 rounded-xl mt-1 space-y-1.5 shadow-xs">
                    <div className="flex justify-between text-xs font-bold text-slate-900">
                      <span>#1 Seed</span>
                      <span className="text-slate-400 font-semibold">-</span>
                    </div>
                    <div className="flex justify-between text-xs font-bold text-slate-500">
                      <span>#4 Seed</span>
                      <span className="text-slate-400 font-semibold">-</span>
                    </div>
                  </div>
                </div>

                {/* Semifinal 2 */}
                <div className="relative">
                  <div className="absolute -left-[22px] top-4 w-4 h-[2px] bg-slate-200"></div>
                  <span className="text-[9px] uppercase font-black text-indigo-600 tracking-wider">Semifinal Match B</span>
                  <div className="bg-slate-50 border border-slate-200 p-3.5 rounded-xl mt-1 space-y-1.5 shadow-xs">
                    <div className="flex justify-between text-xs font-bold text-slate-900">
                      <span>#2 Seed</span>
                      <span className="text-slate-400 font-semibold">-</span>
                    </div>
                    <div className="flex justify-between text-xs font-bold text-slate-500">
                      <span>#3 Seed</span>
                      <span className="text-slate-400 font-semibold">-</span>
                    </div>
                  </div>
                </div>

                {/* Championship Match */}
                <div className="relative pt-5 border-t border-slate-200 mt-5">
                  <div className="absolute -left-[22px] top-9 w-4 h-[2px] bg-amber-400"></div>
                  <span className="text-[9px] uppercase font-black text-amber-700 tracking-wider flex items-center gap-1.5">
                    <Trophy className="w-3.5 h-3.5 text-amber-600" /> PWHL Championship Final
                  </span>
                  <div className="bg-amber-50 border border-amber-200 p-4.5 rounded-2xl mt-1.5 space-y-2 shadow-xs">
                    <div className="flex justify-between text-xs font-black text-slate-900">
                      <span>Winner Match A</span>
                      <span className="text-amber-700 font-black">Ready</span>
                    </div>
                    <div className="flex justify-between text-xs font-black text-slate-900">
                      <span>Winner Match B</span>
                      <span className="text-amber-700 font-black">Ready</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

          </div>
        )}

        {/* ── TRANSACTIONS, WAIVERS & TRADES HUB ── */}
        {initialTab === 'transactions' && (
          <div className="space-y-8 animate-fade-in">
            {/* Top Action Bar */}
            <div className="flex flex-wrap justify-between items-center bg-white border border-slate-200/80 p-5 rounded-2xl shadow-sm gap-4">
              <div>
                <h3 className="text-xs font-black uppercase text-slate-900 tracking-wider flex items-center gap-2">
                  <ArrowRightLeft className="w-4 h-4 text-indigo-600" /> League Transactions Central
                </h3>
                <p className="text-[10px] text-slate-500 font-medium mt-0.5">Submit waiver claims, propose trades with rival owners, and track rolling waiver priority.</p>
              </div>
              {myTeam && (
                <button 
                  onClick={() => setShowProposeModal(true)}
                  className="px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-[10px] font-black uppercase tracking-wider shadow-sm active:scale-95 transition-all cursor-pointer flex items-center gap-1.5 ml-auto"
                >
                  <Send className="w-3.5 h-3.5" /> Propose Trade
                </button>
              )}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
              
              {/* 1. ROLLING WAIVER PRIORITY STANDINGS (lg:col-span-4) */}
              <div className="lg:col-span-4 bg-white border border-slate-200/80 rounded-2xl overflow-hidden shadow-sm">
                <div className="px-6 py-4.5 border-b border-slate-200 bg-slate-50 flex justify-between items-center">
                  <h3 className="text-xs font-black uppercase tracking-wider text-slate-900 flex items-center gap-2">
                    <Clock className="w-4 h-4 text-amber-500" /> Rolling Waiver Order
                  </h3>
                  <span className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">Priority Rank</span>
                </div>

                <div className="p-4 space-y-2.5">
                  {(() => {
                    const waiverOrder = leagueData?.waiverOrder || teams.map(t => t.id);
                    const orderedTeams = waiverOrder.map(tId => teams.find(t => t.id === tId)).filter(Boolean);
                    
                    if (orderedTeams.length === 0) {
                      return <div className="text-center py-6 text-xs text-slate-500 font-bold italic">No waiver order initialized.</div>;
                    }

                    return orderedTeams.map((team, idx) => {
                      const isMe = team.ownerId === currentUser.uid;
                      return (
                        <div 
                          key={team.id} 
                          className={`flex items-center justify-between p-3 rounded-xl border transition-all ${
                            isMe 
                              ? 'bg-indigo-50 border-indigo-200' 
                              : 'bg-slate-50 border-slate-200'
                          }`}
                        >
                          <div className="flex items-center gap-3">
                            <span className={`w-6 h-6 rounded-lg flex items-center justify-center text-[10px] font-black ${
                              idx === 0 
                                ? 'bg-amber-400 text-slate-900 shadow-xs' 
                                : 'bg-slate-200 text-slate-700'
                            }`}>
                              #{idx + 1}
                            </span>
                            <div>
                              <span className="text-xs font-black text-slate-900 block">{team.teamName}</span>
                              <span className="text-[9px] text-slate-500 font-medium block">
                                {idx === 0 ? 'Highest Priority (#1 Waiver Claim)' : `${idx + 1}${idx === 1 ? 'nd' : idx === 2 ? 'rd' : 'th'} in Order`}
                              </span>
                            </div>
                          </div>
                          {isMe && (
                            <span className="text-[8px] font-black uppercase text-indigo-700 bg-indigo-100 border border-indigo-200 px-2 py-0.5 rounded-lg">YOUR RANK</span>
                          )}
                        </div>
                      );
                    });
                  })()}
                </div>
              </div>

              {/* 2. MY ACTIVE PENDING WAIVER CLAIMS (lg:col-span-4) */}
              <div className="lg:col-span-4 bg-white border border-slate-200/80 rounded-2xl overflow-hidden shadow-sm">
                <div className="px-6 py-4.5 border-b border-slate-200 bg-slate-50 flex justify-between items-center">
                  <h3 className="text-xs font-black uppercase tracking-wider text-slate-900 flex items-center gap-2">
                    <Zap className="w-4 h-4 text-indigo-600" /> My Pending Claims
                  </h3>
                  <span className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">
                    {myTeam ? waiverClaims.filter(c => c.teamId === myTeam.id).length : 0} Active
                  </span>
                </div>

                <div className="p-4 space-y-3">
                  {(() => {
                    const myClaims = myTeam ? waiverClaims.filter(c => c.teamId === myTeam.id) : [];
                    if (myClaims.length === 0) {
                      return (
                        <div className="text-center py-10 text-xs text-slate-400 font-bold italic border border-dashed border-slate-200 rounded-xl bg-slate-50">
                          No active waiver claims submitted.
                        </div>
                      );
                    }

                    return myClaims.map(claim => {
                      const addP = playersMap[claim.playerId] || { name: claim.playerId, pos: 'F', teamCode: '' };
                      const dropP = claim.dropPlayerId ? (playersMap[claim.dropPlayerId] || { name: claim.dropPlayerId }) : null;

                      return (
                        <div key={claim.id} className="p-4 bg-slate-50 border border-slate-200 rounded-xl relative shadow-xs">
                          <div className="flex items-center justify-between">
                            <span className="text-[9px] font-black uppercase text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-lg">
                              WAIVER CLAIM
                            </span>
                            <button 
                              onClick={async () => {
                                if (window.confirm(`Cancel waiver claim for ${addP.name}?`)) {
                                  await cancelWaiverClaim(activeLeagueId, myTeam.id, currentUser.uid, claim.playerId);
                                  fetchLeagueDetails();
                                }
                              }}
                              className="text-[9px] font-black uppercase text-rose-600 hover:text-rose-700 bg-rose-50 hover:bg-rose-100 px-2 py-0.5 rounded-lg border border-rose-200 transition-all cursor-pointer"
                            >
                              Cancel Claim
                            </button>
                          </div>

                          <div className="mt-3">
                            <div className="flex items-center gap-2 text-xs font-black text-emerald-700">
                              <Plus className="w-3.5 h-3.5" /> Add: {addP.name} ({addP.pos} • {addP.teamCode})
                            </div>
                            {dropP ? (
                              <div className="flex items-center gap-2 text-xs font-bold text-rose-600 mt-1">
                                <Trash2 className="w-3.5 h-3.5" /> Drop: {dropP.name}
                              </div>
                            ) : (
                              <div className="text-[10px] font-medium text-slate-500 mt-1">Drop: None (Free Roster Space)</div>
                            )}
                          </div>
                        </div>
                      );
                    });
                  })()}
                </div>
              </div>

              {/* 3. TRADE CENTRAL HUB (lg:col-span-4) */}
              <div className="lg:col-span-4 bg-white border border-slate-200/80 rounded-2xl overflow-hidden shadow-sm">
                <div className="px-6 py-4.5 border-b border-slate-200 bg-slate-50 flex justify-between items-center">
                  <h3 className="text-xs font-black uppercase tracking-wider text-slate-900 flex items-center gap-2">
                    <ArrowRightLeft className="w-4 h-4 text-emerald-600" /> Trade Central
                  </h3>
                  <span className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">Proposals</span>
                </div>

                <div className="p-4 space-y-4">
                  {/* Incoming Proposals */}
                  <div>
                    <h4 className="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-2">Incoming Proposals</h4>
                    {(() => {
                      const incoming = myTeam ? trades.filter(t => t.receiverTeamId === myTeam.id && t.status === 'pending') : [];
                      if (incoming.length === 0) {
                        return <div className="text-center py-4 text-[10px] text-slate-400 italic bg-slate-50 rounded-xl border border-slate-200">No incoming trade offers.</div>;
                      }

                      return incoming.map(trade => {
                        const proposerTeam = teams.find(t => t.id === trade.proposerTeamId);
                        const sendsNames = trade.proposerSends.map(id => playersMap[id]?.name || id).join(', ');
                        const receivesNames = trade.receiverSends.map(id => playersMap[id]?.name || id).join(', ');

                        return (
                          <div key={trade.id} className="p-4 bg-slate-50 border border-slate-200 rounded-xl mb-3 shadow-xs">
                            <div className="flex items-center justify-between text-xs font-black text-slate-900 mb-2">
                              <span>Offer from {proposerTeam?.teamName || 'Rival Team'}</span>
                            </div>
                            <div className="text-[10px] text-slate-700 space-y-1">
                              <p className="text-emerald-700 font-bold">You Receive: {sendsNames}</p>
                              <p className="text-rose-600 font-bold">You Send: {receivesNames}</p>
                            </div>
                            <div className="flex gap-2 mt-3">
                              <button 
                                onClick={async () => {
                                  // Check if accepting causes net extra players on full roster
                                  const rosterSettings = leagueData?.rosterSettings || { bench: 4, forwards: { starters: 6 }, defense: { starters: 4 }, goalies: { starters: 1 } };
                                  const maxRosterSize = (rosterSettings.bench ?? 4) + (rosterSettings.forwards?.starters ?? 6) + (rosterSettings.defense?.starters ?? 4) + (rosterSettings.goalies?.starters ?? 1);
                                  const netGain = trade.proposerSends.length - trade.receiverSends.length;
                                  const currentRoster = (myTeam.players || []).length;
                                  
                                  if (netGain > 0 && (currentRoster + netGain) > maxRosterSize) {
                                    setAcceptTradeTarget(trade);
                                    setReceiverDrops([]);
                                  } else {
                                    try {
                                      await respondToTrade(activeLeagueId, trade.id, currentUser.uid, 'accept');
                                      alert("Trade Accepted!");
                                      fetchLeagueDetails();
                                    } catch (err) {
                                      alert(err.message);
                                    }
                                  }
                                }}
                                className="flex-1 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-[9px] font-black uppercase text-white rounded-lg cursor-pointer shadow-xs"
                              >
                                Accept
                              </button>
                              <button 
                                onClick={async () => {
                                  try {
                                    await respondToTrade(activeLeagueId, trade.id, currentUser.uid, 'reject');
                                    alert("Trade Rejected.");
                                    fetchLeagueDetails();
                                  } catch (err) {
                                    alert(err.message);
                                  }
                                }}
                                className="flex-1 py-1.5 bg-slate-100 hover:bg-slate-200 border border-slate-200 text-[9px] font-black uppercase text-slate-700 rounded-lg cursor-pointer"
                              >
                                Reject
                              </button>
                            </div>
                          </div>
                        );
                      });
                    })()}
                  </div>

                  {/* Accepted Trades Under Review */}
                  <div>
                    <h4 className="text-[10px] font-black uppercase tracking-widest text-amber-700 mb-2 flex items-center gap-1">
                      <Clock className="w-3 h-3 text-amber-600" /> Trades Under Review
                    </h4>
                    {(() => {
                      const underReview = trades.filter(t => t.status === 'accepted');
                      const vetoThreshold = leagueData?.tradeSettings?.vetoThreshold ?? 3;
                      
                      if (underReview.length === 0) {
                        return <div className="text-center py-4 text-[10px] text-slate-400 italic bg-slate-50 rounded-xl border border-slate-200">No trades currently in review.</div>;
                      }

                      return underReview.map(trade => {
                        const proposerTeam = teams.find(t => t.id === trade.proposerTeamId);
                        const receiverTeam = teams.find(t => t.id === trade.receiverTeamId);
                        const sendsNames = trade.proposerSends.map(id => playersMap[id]?.name || id).join(', ');
                        const receivesNames = trade.receiverSends.map(id => playersMap[id]?.name || id).join(', ');
                        const vetoesCount = (trade.vetoes || []).length;
                        const isMyTrade = myTeam && (myTeam.id === trade.proposerTeamId || myTeam.id === trade.receiverTeamId);
                        const hasVetoed = (trade.vetoes || []).includes(currentUser.uid);

                        return (
                          <div key={trade.id} className="p-4 bg-slate-50 border border-amber-200 rounded-xl mb-3 shadow-xs">
                            <div className="flex items-center justify-between text-xs font-black text-slate-900 mb-1.5">
                              <span>{proposerTeam?.teamName || 'Team A'} ⇄ {receiverTeam?.teamName || 'Team B'}</span>
                              <span className="text-[9px] font-bold text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-lg">
                                Review Active
                              </span>
                            </div>
                            
                            <div className="text-[10px] text-slate-700 space-y-0.5 mb-2.5">
                              <p><strong className="text-slate-600">{proposerTeam?.teamName}:</strong> Sends {sendsNames}</p>
                              <p><strong className="text-slate-600">{receiverTeam?.teamName}:</strong> Sends {receivesNames}</p>
                            </div>

                            {/* Veto Progress Bar */}
                            <div className="mt-2 pt-2 border-t border-slate-200">
                              <div className="flex justify-between items-center text-[9px] font-bold text-slate-500 mb-1">
                                <span>Veto Progress</span>
                                <span className={vetoesCount > 0 ? "text-rose-600 font-black" : "text-slate-500"}>{vetoesCount} / {vetoThreshold} Vetoes</span>
                              </div>
                              <div className="w-full h-1.5 bg-slate-200 rounded-full overflow-hidden">
                                <div 
                                  className="h-full bg-rose-500 transition-all duration-300"
                                  style={{ width: `${Math.min(100, (vetoesCount / vetoThreshold) * 100)}%` }}
                                />
                              </div>

                              {!isMyTrade && (
                                <button
                                  disabled={hasVetoed}
                                  onClick={async () => {
                                    if (window.confirm(`Cast a veto vote against this trade? (${vetoesCount + 1}/${vetoThreshold} votes will be logged)`)) {
                                      try {
                                        await vetoTrade(activeLeagueId, trade.id, currentUser.uid);
                                        alert("Veto vote logged successfully.");
                                        fetchLeagueDetails();
                                      } catch (err) {
                                        alert(err.message);
                                      }
                                    }
                                  }}
                                  className="mt-2.5 w-full py-1.5 bg-rose-50 hover:bg-rose-100 border border-rose-200 text-rose-700 text-[9px] font-black uppercase rounded-lg transition-all disabled:opacity-40 cursor-pointer"
                                >
                                  {hasVetoed ? 'Veto Voted' : 'Veto This Trade'}
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      });
                    })()}
                  </div>

                  {/* Outgoing Proposals */}
                  <div>
                    <h4 className="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-2">Outgoing Proposals</h4>
                    {(() => {
                      const outgoing = myTeam ? trades.filter(t => t.proposerTeamId === myTeam.id && t.status === 'pending') : [];
                      if (outgoing.length === 0) {
                        return <div className="text-center py-4 text-[10px] text-slate-400 italic bg-slate-50 rounded-xl border border-slate-200">No outgoing trade offers pending.</div>;
                      }

                      return outgoing.map(trade => {
                        const receiverTeam = teams.find(t => t.id === trade.receiverTeamId);
                        const sendsNames = trade.proposerSends.map(id => playersMap[id]?.name || id).join(', ');
                        const receivesNames = trade.receiverSends.map(id => playersMap[id]?.name || id).join(', ');

                        return (
                          <div key={trade.id} className="p-4 bg-slate-50 border border-slate-200 rounded-xl mb-3 shadow-xs">
                            <div className="flex items-center justify-between text-xs font-black text-slate-900 mb-2">
                              <span>Sent to {receiverTeam?.teamName || 'Rival Team'}</span>
                              <button 
                                onClick={async () => {
                                  try {
                                    await cancelTradeProposal(activeLeagueId, trade.id, currentUser.uid);
                                    alert("Trade Proposal Cancelled.");
                                    fetchLeagueDetails();
                                  } catch (err) {
                                    alert(err.message);
                                  }
                                }}
                                className="text-[9px] font-black text-rose-600 hover:underline cursor-pointer"
                              >
                                Cancel
                              </button>
                            </div>
                            <div className="text-[10px] text-slate-700 space-y-1">
                              <p className="text-rose-600 font-bold">You Send: {sendsNames}</p>
                              <p className="text-emerald-700 font-bold">You Get: {receivesNames}</p>
                            </div>
                          </div>
                        );
                      });
                    })()}
                  </div>

                </div>
              </div>

            </div>
          </div>
        )}

        {/* ── 2. SETTINGS & TEAM PROFILE VIEW ── */}
        {initialTab === 'schedule' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
            
            {/* My Team Settings Profile (Change team name & Select Logo) */}
            {myTeam && (
              <form onSubmit={handleUpdateTeamProfile} className="lg:col-span-7 bg-white border border-slate-200/80 p-6 rounded-2xl shadow-sm space-y-5">
                <div className="flex items-center gap-3 border-b border-slate-200 pb-4">
                  <div className="w-12 h-12 rounded-xl bg-indigo-50 border border-indigo-200 flex items-center justify-center text-lg font-black text-indigo-700 shadow-xs">
                    {teamNameInput ? teamNameInput.slice(0, 2).toUpperCase() : 'TM'}
                  </div>
                  <div>
                    <h3 className="text-xs font-black uppercase tracking-wider text-slate-900">My Team Settings</h3>
                    <p className="text-[10px] text-slate-500 font-medium mt-0.5">Customize your roster identity & team profile.</p>
                  </div>
                </div>

                <div>
                  <label className="block text-[10px] uppercase font-black tracking-widest text-slate-500 mb-2">Team Name</label>
                  <input 
                    type="text" 
                    value={teamNameInput}
                    onChange={e => setTeamNameInput(e.target.value)}
                    required
                    maxLength={30}
                    placeholder="Enter team name"
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-xs text-slate-900 font-bold focus:outline-none focus:border-indigo-600"
                  />
                </div>

                <button
                  type="submit"
                  disabled={savingTeam}
                  className="w-full py-3.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-[10px] font-black uppercase tracking-wider shadow-sm active:scale-95 transition-transform cursor-pointer"
                >
                  {savingTeam ? 'Saving team profile...' : 'Save Team Profile'}
                </button>
              </form>
            )}

            {/* League configuration details (Read Only) */}
            <div className="lg:col-span-5 bg-white border border-slate-200/80 p-6 rounded-2xl shadow-sm space-y-4">
              <h3 className="text-xs font-black uppercase tracking-wider text-slate-900 border-b border-slate-200 pb-4 mb-2 flex items-center gap-2">
                <Settings className="w-4 h-4 text-indigo-600" /> League Rules Settings
              </h3>
              
              <div className="flex justify-between text-xs py-1">
                <span className="text-slate-500 font-medium">Match-up Duration</span>
                <span className="font-black text-slate-800">{leagueData.scheduleSettings?.matchupDuration || 1} Week(s)</span>
              </div>
              <div className="flex justify-between text-xs py-1">
                <span className="text-slate-500 font-medium">Playoff Entrants</span>
                <span className="font-black text-slate-800">{leagueData.scheduleSettings?.playoffTeams || 4} Teams</span>
              </div>
              <div className="flex justify-between text-xs py-1">
                <span className="text-slate-500 font-medium">Draft Schedule Date</span>
                <span className="font-black text-slate-800">{leagueData.draftDate ? new Date(leagueData.draftDate).toLocaleString() : 'Not Scheduled'}</span>
              </div>
              <div className="flex justify-between text-xs py-1">
                <span className="text-slate-500 font-medium">Recruitment Limit</span>
                <span className="font-black text-slate-800">{leagueData.maxTeams} Franchises</span>
              </div>
            </div>

          </div>
        )}

        {/* ── 3. COMMISSIONER MANAGER TOOLSET VIEW ── */}
        {initialTab === 'manager' && isCommish && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
            
            {/* LEFT COLUMN: Configurations & Scheduling (lg:col-span-7) */}
            <div className="lg:col-span-7 space-y-6">
              
              {/* Rules & Scoring Configurations Form */}
              <form onSubmit={handleSaveLeagueSettings} className="bg-white border border-slate-200/80 p-6 rounded-2xl shadow-sm space-y-5">
                <div className="border-b border-slate-200 pb-3">
                  <h3 className="text-xs font-black uppercase tracking-wider text-slate-900">Define League Configurations</h3>
                  <p className="text-[10px] text-slate-500 font-medium mt-0.5">Define schedule limits and precise skater/goalie scoring points weights.</p>
                </div>
                
                {isDraftScheduled && (
                  <div className="p-3 bg-amber-50 border border-amber-200 text-amber-800 rounded-xl text-[10px] font-bold leading-normal flex items-center gap-2">
                    <Lock className="w-4 h-4 text-amber-600 shrink-0" />
                    <span>Scoring, schedule, and playoff settings are fully locked because a draft date is scheduled. Unschedule the draft below to edit rules.</span>
                  </div>
                )}

                {/* Matchup & Playoff Selectors */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-[10px] uppercase font-black text-slate-500 mb-2">Match-up Duration</label>
                    <select
                      disabled={isDraftScheduled}
                      value={matchupWeeksInput}
                      onChange={e => setMatchupWeeksInput(e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-xs text-slate-900 font-bold focus:outline-none focus:border-indigo-600 disabled:opacity-60 cursor-pointer"
                    >
                      <option value={1}>1 Week Matchups</option>
                      <option value={2}>2 Weeks Matchups</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-[10px] uppercase font-black text-slate-400 mb-2">Playoff Entrants</label>
                    <select
                      disabled={isDraftScheduled}
                      value={playoffTeamsInput}
                      onChange={e => setPlayoffTeamsInput(e.target.value)}
                      className="w-full bg-gray-50 border border-gray-200 rounded-2xl px-4 py-3 text-xs text-gray-700 font-bold focus:outline-none focus:border-indigo-500 shadow-sm disabled:opacity-60"
                    >
                      <option value={4}>4 Teams Playoff</option>
                      <option value={6}>6 Teams Playoff</option>
                      <option value={8}>8 Teams Playoff</option>
                    </select>
                  </div>
                </div>

                {/* Roster Size Configuration */}
                <div className="border-t border-slate-100 pt-5">
                  <h4 className="text-xs font-bold text-slate-800 mb-4">Roster Sheet Size</h4>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                    <div>
                      <label className="block text-[8px] uppercase font-black text-gray-400 mb-1">Forwards Starters</label>
                      <input 
                        type="number"
                        min="1"
                        max="15"
                        disabled={isDraftScheduled}
                        value={forwardsStarters}
                        onChange={e => setForwardsStarters(e.target.value)}
                        className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-2 text-xs font-bold text-gray-700 disabled:opacity-60 focus:bg-white focus:border-indigo-500 shadow-inner focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-[8px] uppercase font-black text-gray-400 mb-1">Forwards Max</label>
                      <input 
                        type="number"
                        min="1"
                        max="20"
                        disabled={isDraftScheduled}
                        value={forwardsMax}
                        onChange={e => setForwardsMax(e.target.value)}
                        className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-2 text-xs font-bold text-gray-700 disabled:opacity-60 focus:bg-white focus:border-indigo-500 shadow-inner focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-[8px] uppercase font-black text-gray-400 mb-1">Defense Starters</label>
                      <input 
                        type="number"
                        min="1"
                        max="10"
                        disabled={isDraftScheduled}
                        value={defenseStarters}
                        onChange={e => setDefenseStarters(e.target.value)}
                        className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-2 text-xs font-bold text-gray-700 disabled:opacity-60 focus:bg-white focus:border-indigo-500 shadow-inner focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-[8px] uppercase font-black text-gray-400 mb-1">Defense Max</label>
                      <input 
                        type="number"
                        min="1"
                        max="15"
                        disabled={isDraftScheduled}
                        value={defenseMax}
                        onChange={e => setDefenseMax(e.target.value)}
                        className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-2 text-xs font-bold text-gray-700 disabled:opacity-60 focus:bg-white focus:border-indigo-500 shadow-inner focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-[8px] uppercase font-black text-gray-400 mb-1">Goalie Starters</label>
                      <input 
                        type="number"
                        min="1"
                        max="5"
                        disabled={isDraftScheduled}
                        value={goaliesStarters}
                        onChange={e => setGoaliesStarters(e.target.value)}
                        className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-2 text-xs font-bold text-gray-700 disabled:opacity-60 focus:bg-white focus:border-indigo-500 shadow-inner focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-[8px] uppercase font-black text-gray-400 mb-1">Goalies Max</label>
                      <input 
                        type="number"
                        min="1"
                        max="10"
                        disabled={isDraftScheduled}
                        value={goaliesMax}
                        onChange={e => setGoaliesMax(e.target.value)}
                        className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-2 text-xs font-bold text-gray-700 disabled:opacity-60 focus:bg-white focus:border-indigo-500 shadow-inner focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-[8px] uppercase font-black text-gray-400 mb-1">Bench Size</label>
                      <input 
                        type="number"
                        min="0"
                        max="15"
                        disabled={isDraftScheduled}
                        value={benchSize}
                        onChange={e => setBenchSize(e.target.value)}
                        className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-2 text-xs font-bold text-gray-700 disabled:opacity-60 focus:bg-white focus:border-indigo-500 shadow-inner focus:outline-none"
                      />
                    </div>
                  </div>
                </div>

                {/* Skater Scoring Settings Grid */}
                <div className="border-t border-gray-100 pt-5">
                  <h4 className="text-[10px] font-black uppercase text-indigo-600 bg-indigo-50 border border-indigo-100 px-3 py-1.5 rounded-lg inline-block mb-4 tracking-widest shadow-xs">⛸️ Skater Scoring Rules</h4>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                    {[
                      { label: "Goals (G)", val: skaterGoals, set: setSkaterGoals },
                      { label: "Assists (A)", val: skaterAssists, set: setSkaterAssists },
                      { label: "Plus/Minus (+/-)", val: skaterPlusMinus, set: setSkaterPlusMinus },
                      { label: "Powerplay (PPP)", val: skaterPpp, set: setSkaterPpp },
                      { label: "Shorthanded (SHP)", val: skaterShp, set: setSkaterShp },
                      { label: "Shots (SOG)", val: skaterSog, set: setSkaterSog },
                      { label: "Hits", val: skaterHits, set: setSkaterHits },
                      { label: "Blocks", val: skaterBlocks, set: setSkaterBlocks },
                      { label: "Def. Pts", val: skaterDefensePoints, set: setSkaterDefensePoints }
                    ].map((item, idx) => (
                      <div key={idx}>
                        <label className="block text-[8px] uppercase font-black text-gray-400 mb-1">{item.label}</label>
                        <input 
                          type="number" 
                          step="0.1"
                          disabled={isDraftScheduled}
                          value={item.val}
                          onChange={e => item.set(e.target.value)}
                          className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-2 text-xs font-bold text-gray-700 disabled:opacity-60 focus:bg-white focus:border-indigo-500 shadow-inner focus:outline-none"
                        />
                      </div>
                    ))}
                  </div>
                </div>

                {/* Goalie Scoring Settings Grid */}
                <div className="border-t border-gray-100 pt-5">
                  <h4 className="text-[10px] font-black uppercase text-purple-600 bg-purple-50 border border-purple-100 px-3 py-1.5 rounded-lg inline-block mb-4 tracking-widest shadow-xs">[Goalie] Goalie Scoring Rules</h4>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                    {[
                      { label: "Wins (W)", val: goalieWins, set: setGoalieWins },
                      { label: "OT Loss (OTL)", val: goalieOtl, set: setGoalieOtl },
                      { label: "Goals Against (GA)", val: goalieGa, set: setGoalieGa },
                      { label: "Saves (SV)", val: goalieSaves, set: setGoalieSaves },
                      { label: "Shutouts (SO)", val: goalieShutouts, set: setGoalieShutouts }
                    ].map((item, idx) => (
                      <div key={idx}>
                        <label className="block text-[8px] uppercase font-black text-gray-400 mb-1">{item.label}</label>
                        <input 
                          type="number" 
                          step="0.1"
                          disabled={isDraftScheduled}
                          value={item.val}
                          onChange={e => item.set(e.target.value)}
                          className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-2 text-xs font-bold text-gray-700 disabled:opacity-60 focus:bg-white focus:border-indigo-500 shadow-inner focus:outline-none"
                        />
                      </div>
                    ))}
                  </div>
                </div>

                {/* Trade Review & Veto Rules */}
                <div className="border-t border-gray-100 pt-5 space-y-3">
                  <h4 className="text-[10px] font-black uppercase text-indigo-600 bg-indigo-50 border border-indigo-100 px-3 py-1.5 rounded-lg inline-block mb-2 tracking-widest shadow-xs">
                    🔄 Trade Review & Veto Rules
                  </h4>
                  
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-[8px] uppercase font-black text-gray-400 mb-1">
                        Trade Review Duration
                      </label>
                      <select
                        value={tradeReviewHours}
                        onChange={e => setTradeReviewHours(e.target.value)}
                        disabled={isDraftScheduled || !isCommissioner}
                        className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-2 text-xs font-bold text-gray-700 disabled:opacity-60 focus:bg-white focus:border-indigo-500 shadow-inner focus:outline-none cursor-pointer"
                      >
                        <option value="0">Instant (No Review Window)</option>
                        <option value="24">24 Hours</option>
                        <option value="48">48 Hours (Standard Default)</option>
                        <option value="72">72 Hours</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-[8px] uppercase font-black text-gray-400 mb-1">
                        Veto Threshold (Votes Needed)
                      </label>
                      <input
                        type="number"
                        min="1"
                        max="10"
                        value={vetoThreshold}
                        onChange={e => setVetoThreshold(e.target.value)}
                        disabled={isDraftScheduled || !isCommissioner || !enableVetoes}
                        className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-2 text-xs font-bold text-gray-700 disabled:opacity-60 focus:bg-white focus:border-indigo-500 shadow-inner focus:outline-none"
                      />
                    </div>
                  </div>

                  <div className="flex flex-col sm:flex-row gap-4 pt-1">
                    <label className="flex items-center gap-2 text-xs text-gray-700 font-bold cursor-pointer">
                      <input 
                        type="checkbox"
                        checked={enableVetoes}
                        onChange={e => setEnableVetoes(e.target.checked)}
                        disabled={isDraftScheduled || !isCommissioner}
                        className="rounded border-gray-300 text-indigo-600 focus:ring-0"
                      />
                      <span>Enable Manager Trade Veto System</span>
                    </label>

                    <label className="flex items-center gap-2 text-xs text-gray-700 font-bold cursor-pointer">
                      <input 
                        type="checkbox"
                        checked={notifyAcceptedTrades}
                        onChange={e => setNotifyAcceptedTrades(e.target.checked)}
                        disabled={isDraftScheduled || !isCommissioner}
                        className="rounded border-gray-300 text-indigo-600 focus:ring-0"
                      />
                      <span>Email All Managers When Trade Accepted</span>
                    </label>
                  </div>
                </div>

                {!isDraftScheduled && (
                  <button
                    type="submit"
                    disabled={savingSettings}
                    className="w-full mt-4 py-3.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-2xl text-[10px] font-black uppercase tracking-wider shadow-md shadow-indigo-600/10 active:scale-95 transition-transform"
                  >
                    {savingSettings ? 'Saving configurations...' : 'Save Scoring & Roster Rules'}
                  </button>
                )}
              </form>

              {/* Draft Event Scheduler */}
              {isPending && (
                <div>
                  {!isDraftScheduled ? (
                    <form onSubmit={handleActivateLeague} className="bg-white border border-indigo-200 p-6 rounded-[32px] shadow-sm space-y-4">
                      <h4 className="text-sm font-black text-gray-900 uppercase tracking-tight">Schedule Draft Event</h4>
                      <p className="text-[11px] text-gray-400 font-semibold leading-normal">Your league capacity is fully met! Schedule a draft date to lock settings and prepare the draft arena.</p>
                      
                      {activateError && <div className="text-xs font-black text-rose-600 bg-rose-50 border border-rose-100 p-3 rounded-xl">{activateError}</div>}

                      <div>
                        <label className="block text-[10px] uppercase font-black tracking-widest text-gray-500 mb-2">Draft Date & Time</label>
                        <input 
                          type="datetime-local" 
                          value={draftDate} 
                          onChange={e => setDraftDate(e.target.value)} 
                          required 
                          className="w-full bg-white border border-gray-200 rounded-2xl px-4 py-3.5 text-xs text-gray-700 focus:outline-none focus:border-indigo-500 shadow-sm"
                        />
                      </div>

                      <button 
                        type="submit" 
                        disabled={activating}
                        className="w-full py-4 bg-gradient-to-r from-indigo-600 to-violet-600 text-xs font-black uppercase tracking-wider text-white rounded-2xl active:scale-95 transition-transform shadow-lg shadow-indigo-600/10"
                      >
                        {activating ? 'Locking configurations...' : 'Lock Rules & Schedule Draft'}
                      </button>
                    </form>
                  ) : (
                    <div className="bg-indigo-50 border border-indigo-100 p-6 rounded-[32px] text-center shadow-sm space-y-4">
                      <div className="w-12 h-12 bg-white border border-indigo-200 rounded-2xl flex items-center justify-center text-xl mx-auto text-indigo-600 animate-pulse">
                        ⚡
                      </div>
                      <div>
                        <h4 className="text-xs font-black uppercase tracking-wider text-indigo-900">Draft Scheduled & Locked</h4>
                        <p className="text-[10px] text-indigo-600 font-semibold mt-1">
                          Scheduled on: {new Date(leagueData.draftDate).toLocaleString()}
                        </p>
                      </div>

                      <button
                        onClick={handleUnscheduleDraft}
                        className="w-full py-3.5 bg-white border border-indigo-200 text-indigo-600 hover:bg-indigo-50/50 rounded-2xl text-[10px] font-black uppercase tracking-wider active:scale-95 transition-all shadow-sm"
                      >
                        🔓 Unschedule Draft & Unlock Rules
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* Draft Order Management */}
              <div className="bg-white border border-gray-200 p-6 rounded-[32px] shadow-sm space-y-4 mt-6">
                <h4 className="text-sm font-black text-gray-900 uppercase tracking-tight flex items-center justify-between">
                  <span>Draft Selection Sequence</span>
                  {isDraftScheduled ? (
                    <span className="text-[9px] bg-indigo-50 text-indigo-600 px-2 py-0.5 rounded-full border border-indigo-100 uppercase tracking-widest font-black">
                      🔒 Locked
                    </span>
                  ) : (
                    <span className="text-[9px] bg-amber-50 text-amber-600 px-2 py-0.5 rounded-full border border-amber-100 uppercase tracking-widest font-black">
                      🔓 Unlocked
                    </span>
                  )}
                </h4>
                <p className="text-[11px] text-gray-400 font-semibold leading-normal">
                  Teams are slotted into the draft order as they join. The commissioner can randomize the order until the draft is scheduled.
                </p>

                <div className="space-y-2">
                  {(leagueData.draftOrder || leagueData.members || []).map((uid, idx) => {
                    const team = teams.find(t => t.ownerId === uid);
                    return (
                      <div key={uid} className="flex items-center justify-between bg-gray-50 border border-gray-150 p-3 rounded-2xl">
                        <div className="flex items-center gap-3 text-left">
                          <span className="w-6 h-6 rounded-lg bg-indigo-50 border border-indigo-100 flex items-center justify-center text-[10px] font-black text-indigo-600">
                            {idx + 1}
                          </span>
                          <span className="text-xs font-black text-gray-800">
                            {team ? team.teamName : `Owner (${uid.slice(0, 6)})`}
                          </span>
                        </div>
                        <span className="text-[10px] font-black text-gray-400 uppercase tracking-wider">
                          {uid === leagueData.ownerId ? '👑 LM' : 'Member'}
                        </span>
                      </div>
                    );
                  })}
                </div>

                {!isDraftScheduled && (
                  <button
                    onClick={handleRandomizeOrder}
                    disabled={randomizing}
                    className="w-full py-3.5 bg-indigo-50 hover:bg-indigo-100/70 border border-indigo-200 text-indigo-600 rounded-2xl text-[10px] font-black uppercase tracking-wider active:scale-95 transition-all shadow-sm flex items-center justify-center gap-2"
                  >
                    🔀 {randomizing ? 'Shuffling...' : 'Randomize Draft Order'}
                  </button>
                )}
              </div>

              {/* Locked Draft Banner */}
              {!isPending && (
                <div className="bg-emerald-50 border border-emerald-100 p-5 rounded-[32px] text-center shadow-sm space-y-2">
                  <div className="w-10 h-10 bg-white border border-emerald-200 rounded-xl flex items-center justify-center text-lg mx-auto text-emerald-600">
                    🔒
                  </div>
                  <h4 className="text-xs font-black uppercase tracking-wider text-emerald-800">Draft Started / Finished</h4>
                  <p className="text-[10px] text-emerald-600 font-semibold leading-normal">
                    Draft has commenced! The draft cannot be unscheduled, and scoring, schedule, and playoff settings are permanently locked.
                  </p>
                </div>
              )}
            </div>

            {/* RIGHT COLUMN: Recruitment & Roster Tracker (lg:col-span-5) */}
            <div className="lg:col-span-5 space-y-6">
              
              {/* Recruitment Key Card */}
              {isPending && (
                <div className="bg-white border border-gray-200 p-6 rounded-[32px] shadow-sm">
                  <span className="text-[10px] uppercase font-black text-indigo-600 bg-indigo-50 px-2.5 py-1 rounded-full border border-indigo-100">Recruitment Key</span>
                  <p className="text-xs text-gray-400 mt-2 font-semibold leading-relaxed">Share this key with league invitees so they can join a team sheet.</p>
                  
                  <div className="flex items-center justify-between mt-4 bg-gray-50 border border-gray-200 px-4 py-3 rounded-2xl shadow-inner">
                    <span className="text-lg font-black tracking-widest text-indigo-600">{leagueData.inviteCode}</span>
                    <button 
                      onClick={() => {
                        navigator.clipboard.writeText(leagueData.inviteCode);
                        alert("Recruitment Key copied successfully!");
                      }}
                      className="text-[10px] font-black uppercase text-indigo-600 hover:text-indigo-700 bg-indigo-50 border border-indigo-100 px-3 py-1.5 rounded-xl transition-all"
                    >
                      Copy
                    </button>
                  </div>
                </div>
              )}

              {/* League Roster / Teams Tracker */}
              <div className="bg-white border border-gray-200 p-6 rounded-[32px] shadow-sm">
                <div className="border-b border-gray-100 pb-3 mb-4 flex justify-between items-center">
                  <h3 className="text-xs font-black uppercase tracking-wider text-gray-800">👥 League Roster Tracker</h3>
                  <span className="text-[10px] text-indigo-600 font-black bg-indigo-50 px-2 py-0.5 rounded border border-indigo-100 shadow-sm">{teams.length} / {leagueData.maxTeams}</span>
                </div>
                
                {/* Roster tracker lists */}
                <div className="space-y-3.5">
                  {teams.map((team, idx) => (
                    <div key={team.id} className="flex justify-between items-center p-3 rounded-2xl bg-gray-50 border border-gray-200 shadow-sm">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span className="text-2xl shrink-0">{team.avatar || '🏒'}</span>
                        <div className="min-w-0">
                          <span className="text-xs font-black text-gray-800 block truncate">{team.teamName}</span>
                          <span className="text-[9px] text-gray-400 font-bold block mt-0.5 truncate">Joined: {team.joinedAt ? new Date(team.joinedAt.toDate()).toLocaleDateString() : 'N/A'}</span>
                        </div>
                      </div>
                      <span className="text-[9px] font-black text-gray-400 uppercase tracking-widest bg-white border border-gray-200 px-2.5 py-1 rounded-xl">
                        {team.ownerId === leagueData.ownerId ? 'Commish' : `Team ${idx + 1}`}
                      </span>
                    </div>
                  ))}

                  {/* Empty slots placeholders */}
                  {Array.from({ length: leagueData.maxTeams - teams.length }).map((_, i) => (
                    <div key={i} className="flex justify-between items-center p-3 rounded-2xl border border-dashed border-gray-200 bg-white/30 italic text-gray-300 text-xs">
                      <span>Waiting for owner...</span>
                      <span className="text-[9px] font-black uppercase tracking-widest text-gray-300">Open Slot</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Recruitment Progress warning */}
              {!isFull && (
                <div className="bg-white border border-gray-200 p-6 rounded-[32px] shadow-sm text-center">
                  <div className="w-12 h-12 bg-amber-50 border border-amber-100 rounded-2xl flex items-center justify-center text-xl mx-auto mb-4 text-amber-500">
                    👥
                  </div>
                  <h4 className="text-xs font-black uppercase tracking-wider text-gray-800">Recruitment In Progress</h4>
                  <p className="text-[10px] text-gray-400 font-semibold mt-2.5 max-w-[240px] mx-auto leading-relaxed">
                    Draft scheduling is locked until all spots are filled. Share the recruitment code above.
                    (Currently {leagueData.members.length} of {leagueData.maxTeams} joined).
                  </p>
                </div>
              )}

            </div>

            {/* DANGER ZONE */}
            <div className="lg:col-span-12 bg-red-50 border border-red-200 p-6 rounded-xl space-y-3 mt-4">
              <h4 className="text-xs font-bold uppercase tracking-wider text-red-700">Danger Zone</h4>
              <p className="text-xs text-red-600 font-medium leading-normal">Permanently destroy this league document, all corresponding player rosters, and team sheets. This action is irreversible.</p>
              <button
                type="button"
                onClick={handleDeleteLeague}
                className="w-full py-3 bg-red-600 hover:bg-red-500 text-white rounded-lg text-xs font-semibold active:scale-95 transition-transform cursor-pointer"
              >
                Delete League
              </button>
            </div>

          </div>
        )}
      </div>

      {/* ── PROPOSE TRADE MODAL ── */}
      {showProposeModal && myTeam && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-md z-50 flex items-center justify-center p-4">
          <div className="w-full max-w-lg bg-white border border-slate-200/80 rounded-2xl p-6 shadow-xl relative animate-scale-up max-h-[85vh] overflow-y-auto text-slate-800">
            <div className="flex justify-between items-center border-b border-slate-200 pb-3">
              <h3 className="text-xs font-black uppercase text-slate-900 tracking-wider flex items-center gap-2">
                <ArrowRightLeft className="w-4 h-4 text-indigo-600" /> Propose Trade Deal
              </h3>
              <button onClick={() => setShowProposeModal(false)} className="text-slate-400 hover:text-slate-700 cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="mt-4 space-y-4">
              <div>
                <label className="block text-[10px] uppercase font-black tracking-widest text-slate-500 mb-2">Select Partner Team</label>
                <select 
                  value={tradePartnerId} 
                  onChange={e => {
                    setTradePartnerId(e.target.value);
                    setTradeReceives([]);
                  }}
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-xs text-slate-900 focus:outline-none focus:border-indigo-600 cursor-pointer"
                >
                  <option value="">-- Choose Target Team --</option>
                  {teams.filter(t => t.id !== myTeam.id).map(t => (
                    <option key={t.id} value={t.id}>{t.teamName}</option>
                  ))}
                </select>
              </div>

              {/* Assets to Send */}
              <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl">
                <h4 className="text-[10px] font-black uppercase text-rose-600 tracking-wider mb-2">Players You Send</h4>
                <div className="space-y-1.5 max-h-36 overflow-y-auto pr-1">
                  {(myTeam.players || []).map(pId => {
                    const p = playersMap[pId] || { name: pId, pos: 'F' };
                    const isChecked = tradeSends.includes(pId);
                    return (
                      <label key={pId} className="flex items-center gap-2.5 text-xs text-slate-800 cursor-pointer hover:text-slate-900 font-medium">
                        <input 
                          type="checkbox"
                          checked={isChecked}
                          onChange={e => {
                            if (e.target.checked) setTradeSends([...tradeSends, pId]);
                            else setTradeSends(tradeSends.filter(id => id !== pId));
                          }}
                          className="rounded border-slate-300 text-indigo-600 focus:ring-0"
                        />
                        <span>{p.name} <span className="text-[9px] text-slate-500 font-bold">({p.pos})</span></span>
                      </label>
                    );
                  })}
                </div>
              </div>

              {/* Assets to Receive */}
              {tradePartnerId && (
                <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl">
                  <h4 className="text-[10px] font-black uppercase text-emerald-600 tracking-wider mb-2">Players You Receive</h4>
                  <div className="space-y-1.5 max-h-36 overflow-y-auto pr-1">
                    {(teams.find(t => t.id === tradePartnerId)?.players || []).map(pId => {
                      const p = playersMap[pId] || { name: pId, pos: 'F' };
                      const isChecked = tradeReceives.includes(pId);
                      return (
                        <label key={pId} className="flex items-center gap-2.5 text-xs text-slate-800 cursor-pointer hover:text-slate-900 font-medium">
                          <input 
                            type="checkbox"
                            checked={isChecked}
                            onChange={e => {
                              if (e.target.checked) setTradeReceives([...tradeReceives, pId]);
                              else setTradeReceives(tradeReceives.filter(id => id !== pId));
                            }}
                            className="rounded border-slate-300 text-indigo-600 focus:ring-0"
                          />
                          <span>{p.name} <span className="text-[9px] text-slate-500 font-bold">({p.pos})</span></span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Mandatory Drop Selector if Asymmetric Trade Causes Roster Overage */}
              {(() => {
                const rosterSettings = leagueData?.rosterSettings || { bench: 4, forwards: { starters: 6 }, defense: { starters: 4 }, goalies: { starters: 1 } };
                const maxRosterSize = (rosterSettings.bench ?? 4) + (rosterSettings.forwards?.starters ?? 6) + (rosterSettings.defense?.starters ?? 4) + (rosterSettings.goalies?.starters ?? 1);
                const netGain = tradeReceives.length - tradeSends.length;
                const currentRoster = (myTeam.players || []).length;
                const dropsNeeded = (currentRoster + netGain) - maxRosterSize;
                const undroppableList = leagueData?.undroppable_players || [];

                if (dropsNeeded <= 0) return null;

                return (
                  <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl space-y-2">
                    <div className="flex items-center gap-2 text-amber-800 text-[10px] font-bold">
                      <AlertCircle className="w-4 h-4 text-amber-600 shrink-0" />
                      <span>Roster Overage: Select {dropsNeeded} player(s) to drop upon trade execution.</span>
                    </div>
                    <div className="space-y-1 max-h-32 overflow-y-auto pt-1">
                      {(myTeam.players || []).filter(id => !tradeSends.includes(id)).map(pId => {
                        const p = playersMap[pId] || { name: pId, pos: 'F' };
                        const isUndrop = undroppableList.includes(String(pId));
                        const isChecked = proposerDrops.includes(pId);

                        return (
                          <label key={pId} className={`flex items-center gap-2 text-xs font-semibold ${isUndrop ? 'opacity-40 cursor-not-allowed text-slate-400' : 'text-slate-800 cursor-pointer'}`}>
                            <input 
                              type="checkbox"
                              disabled={isUndrop}
                              checked={isChecked}
                              onChange={e => {
                                if (e.target.checked) setProposerDrops([...proposerDrops, pId]);
                                else setProposerDrops(proposerDrops.filter(id => id !== pId));
                              }}
                              className="rounded border-slate-300 text-indigo-600"
                            />
                            <span>{p.name} {isUndrop && <span className="text-[8px] text-amber-600 font-bold uppercase">(Can't Drop)</span>}</span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}
            </div>

            <div className="mt-6 flex justify-end gap-3 border-t border-slate-200 pt-4">
              <button 
                onClick={() => setShowProposeModal(false)}
                className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-black uppercase tracking-wider rounded-xl transition-all"
              >
                Cancel
              </button>
              <button 
                onClick={handleProposeTrade}
                disabled={submittingTrade || !tradePartnerId || (tradeSends.length === 0 && tradeReceives.length === 0)}
                className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-black uppercase tracking-wider rounded-xl disabled:opacity-50 transition-all shadow-sm"
              >
                {submittingTrade ? 'Submitting...' : 'Send Proposal'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── ACCEPT TRADE DROP SELECTION MODAL ── */}
      {acceptTradeTarget && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-md z-50 flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white border border-slate-200/80 rounded-2xl p-6 shadow-xl relative animate-scale-up text-slate-800">
            <h3 className="text-xs font-black uppercase text-amber-700 tracking-wider mb-2 flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-amber-600" /> Mandatory Roster Drop Selection
            </h3>
            <p className="text-xs text-slate-600 font-medium mb-4">
              Accepting this trade gives your team net extra players. Select player(s) from your current roster to drop upon trade execution.
            </p>

            <div className="space-y-2 border border-slate-200 rounded-xl p-3 max-h-48 overflow-y-auto mb-5 bg-slate-50">
              {(myTeam?.players || []).map(pId => {
                const p = playersMap[pId] || { name: pId, pos: 'F' };
                const isUndrop = (leagueData?.undroppable_players || []).includes(String(pId));
                const isChecked = receiverDrops.includes(pId);

                return (
                  <label key={pId} className={`flex items-center gap-2.5 text-xs font-semibold ${isUndrop ? 'opacity-40 cursor-not-allowed text-slate-400' : 'text-slate-800 cursor-pointer'}`}>
                    <input 
                      type="checkbox"
                      disabled={isUndrop}
                      checked={isChecked}
                      onChange={e => {
                        if (e.target.checked) setReceiverDrops([...receiverDrops, pId]);
                        else setReceiverDrops(receiverDrops.filter(id => id !== pId));
                      }}
                      className="rounded border-slate-300 text-indigo-600"
                    />
                    <span>{p.name} {isUndrop && <span className="text-[8px] text-amber-600 font-bold uppercase">(Can't Drop)</span>}</span>
                  </label>
                );
              })}
            </div>

            <div className="flex justify-end gap-3">
              <button
                onClick={() => {
                  setAcceptTradeTarget(null);
                  setReceiverDrops([]);
                }}
                className="px-4 py-2 bg-slate-100 text-slate-700 text-xs font-black uppercase tracking-wider rounded-xl hover:bg-slate-200"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  try {
                    await respondToTrade(activeLeagueId, acceptTradeTarget.id, currentUser.uid, 'accept', receiverDrops);
                    alert("Trade Accepted with designated drop players!");
                    setAcceptTradeTarget(null);
                    setReceiverDrops([]);
                    fetchLeagueDetails();
                  } catch (err) {
                    alert(err.message);
                  }
                }}
                disabled={submittingTrade}
                className="px-5 py-2 bg-indigo-600 text-white text-xs font-black uppercase tracking-wider rounded-xl hover:bg-indigo-500 shadow-sm"
              >
                Confirm Acceptance
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
