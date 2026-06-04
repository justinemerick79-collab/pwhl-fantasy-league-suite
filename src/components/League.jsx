import React, { useState, useEffect } from 'react';
import { db } from '../firebase.js';
import { doc, getDoc, updateDoc, collection, getDocs, deleteDoc } from 'firebase/firestore';
import { useAuth } from '../contexts/AuthContext';
import { randomizeDraftOrder } from '../services/leagueService.js';

export default function League({ activeLeagueId, initialTab, setActiveLeagueId }) {
  const { currentUser } = useAuth();
  const [leagueData, setLeagueData] = useState(null);
  const [teams, setTeams] = useState([]);
  const [loading, setLoading] = useState(true);

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
      
      const userTeam = loadedTeams.find(t => t.ownerId === currentUser.uid);
      if (userTeam) {
        setTeamNameInput(userTeam.teamName || '');
        setTeamAvatarInput(userTeam.avatar || '🏒');
      }
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

  const myTeam = teams.find(t => t.ownerId === currentUser.uid);
  const isCommish = currentUser && currentUser.uid === leagueData.ownerId;
  const isPending = leagueData && (
    leagueData.status === 'pending' || 
    (leagueData.members && leagueData.members.length < leagueData.maxTeams) || 
    !leagueData.draftDate
  );
  const isFull = leagueData.members.length >= leagueData.maxTeams;
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
  } else if (initialTab === 'schedule') {
    tabTitle = "Settings & Team";
    tabSub = "Customize your team profile and review active league rules.";
  } else if (initialTab === 'manager') {
    tabTitle = "LM Toolset";
    tabSub = "Commissioner controls for drafts, settings, and recruitment.";
  }

  return (
    <div className="min-h-screen px-4 pt-6 pb-24 font-sans select-none antialiased">
      
      {/* ── LEAGUE HEADER ── */}
      <header className="mb-6">
        <div className="flex items-center gap-3">
          <span className="text-[10px] uppercase font-black tracking-widest text-indigo-600 bg-indigo-50 px-3 py-1.5 rounded-full border border-indigo-100 shadow-sm shadow-indigo-100/10">
            {tabTitle}
          </span>
          <span className={`text-[10px] uppercase font-black tracking-widest px-3 py-1.5 rounded-full border shadow-sm ${isPending ? 'bg-amber-50 border-amber-100 text-amber-600' : 'bg-emerald-50 border-emerald-100 text-emerald-600'}`}>
            {leagueData.status}
          </span>
        </div>
        <h1 className="font-sports text-3xl font-black mt-3 tracking-tight text-gray-900">
          {leagueData.name}
        </h1>
        <p className="text-xs text-gray-400 font-semibold mt-0.5">{tabSub}</p>
      </header>

      {/* ── CONDITIONAL RENDERING BASED ON PROP (NO DOUBLE-NESTED TABS!) ── */}
      <div className="space-y-6">
        
        {/* ── 1. STANDINGS & PLAYOFF BRACKET VIEW ── */}
        {initialTab === 'standings' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
            
            {/* Leaderboard panel (lg:col-span-7) */}
            <div className="lg:col-span-7 bg-white border border-gray-200 rounded-[32px] overflow-hidden shadow-sm">
              <div className="px-6 py-4.5 border-b border-gray-100 bg-gray-50/50 flex justify-between items-center">
                <h3 className="text-xs font-black uppercase tracking-wider text-gray-800">🏆 Leaderboard Rankings</h3>
                <span className="text-[10px] text-gray-400 font-bold uppercase tracking-wider">{teams.length} Teams Active</span>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-gray-100 bg-gray-50/30 text-[9px] font-black uppercase text-gray-400 tracking-wider">
                      <th className="px-6 py-3.5 w-16 text-center">Rank</th>
                      <th className="px-6 py-3.5">Team</th>
                      <th className="px-6 py-3.5 text-center">Record</th>
                      <th className="px-6 py-3.5 text-right font-sports">Points</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {teams.length === 0 ? (
                      <tr>
                        <td colSpan="4" className="p-8 text-center text-xs text-gray-300 font-bold italic">Standings loading or empty.</td>
                      </tr>
                    ) : (
                      [...teams]
                        .sort((a, b) => (b.points || 0) - (a.points || 0))
                        .map((team, idx) => (
                          <tr key={team.id} className="hover:bg-gray-50/50 transition-colors text-xs">
                            <td className="px-6 py-4 text-center font-black text-gray-400">{idx + 1}</td>
                            <td className="px-6 py-4 font-black text-gray-800 flex items-center gap-2.5">
                              <span className="text-lg shrink-0">{team.avatar || '🏒'}</span>
                              <span className="truncate max-w-[140px] sm:max-w-none">{team.teamName}</span>
                              {team.ownerId === currentUser.uid && (
                                <span className="text-[8px] bg-indigo-50 border border-indigo-100 text-indigo-600 px-1.5 py-0.5 rounded font-black uppercase tracking-wide">
                                  YOU
                                </span>
                              )}
                            </td>
                            <td className="px-6 py-4 text-center font-semibold text-gray-400">
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
            <div className="lg:col-span-5 bg-white border border-gray-200 p-6 rounded-[32px] shadow-sm">
              <h3 className="text-xs font-black uppercase tracking-wider text-gray-800 border-b border-gray-100 pb-4 mb-5 flex items-center gap-1.5">🏒 Playoff Bracket Tree</h3>
              
              <div className="space-y-6 relative pl-4 border-l-2 border-indigo-50 py-2">
                {/* Semifinal 1 */}
                <div className="relative">
                  <div className="absolute -left-[22px] top-4 w-4 h-[2px] bg-indigo-100"></div>
                  <span className="text-[9px] uppercase font-black text-indigo-600 tracking-wider">Semifinal Match A</span>
                  <div className="bg-gray-50 border border-gray-200 p-3.5 rounded-2xl mt-1 space-y-1.5 shadow-sm">
                    <div className="flex justify-between text-xs font-bold text-gray-800">
                      <span>#1 Seed</span>
                      <span className="text-gray-400 font-semibold">-</span>
                    </div>
                    <div className="flex justify-between text-xs font-bold text-gray-400">
                      <span>#4 Seed</span>
                      <span className="text-gray-400 font-semibold">-</span>
                    </div>
                  </div>
                </div>

                {/* Semifinal 2 */}
                <div className="relative">
                  <div className="absolute -left-[22px] top-4 w-4 h-[2px] bg-indigo-100"></div>
                  <span className="text-[9px] uppercase font-black text-indigo-600 tracking-wider">Semifinal Match B</span>
                  <div className="bg-gray-50 border border-gray-200 p-3.5 rounded-2xl mt-1 space-y-1.5 shadow-sm">
                    <div className="flex justify-between text-xs font-bold text-gray-800">
                      <span>#2 Seed</span>
                      <span className="text-gray-400 font-semibold">-</span>
                    </div>
                    <div className="flex justify-between text-xs font-bold text-gray-400">
                      <span>#3 Seed</span>
                      <span className="text-gray-400 font-semibold">-</span>
                    </div>
                  </div>
                </div>

                {/* Championship Match */}
                <div className="relative pt-5 border-t border-gray-100 mt-5">
                  <div className="absolute -left-[22px] top-9 w-4 h-[2px] bg-amber-200"></div>
                  <span className="text-[9px] uppercase font-black text-amber-600 tracking-wider flex items-center gap-1.5">👑 PWHL Championship Final</span>
                  <div className="bg-gradient-to-tr from-amber-500/5 to-transparent border border-amber-200 p-4.5 rounded-3xl mt-1.5 space-y-2 shadow-sm">
                    <div className="flex justify-between text-xs font-black text-gray-800">
                      <span>Winner Match A</span>
                      <span className="text-amber-600 font-black">Ready</span>
                    </div>
                    <div className="flex justify-between text-xs font-black text-gray-800">
                      <span>Winner Match B</span>
                      <span className="text-amber-600 font-black">Ready</span>
                    </div>
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
              <form onSubmit={handleUpdateTeamProfile} className="lg:col-span-7 bg-white border border-gray-200 p-6 rounded-[32px] shadow-sm space-y-5">
                <div className="flex items-center gap-3 border-b border-gray-100 pb-4">
                  <div className="w-12 h-12 rounded-2xl bg-indigo-50 border border-indigo-100 flex items-center justify-center text-2xl shadow-inner">
                    {teamAvatarInput}
                  </div>
                  <div>
                    <h3 className="text-xs font-black uppercase tracking-wider text-gray-800">My Team Settings</h3>
                    <p className="text-[10px] text-gray-400 font-semibold mt-0.5">Customize your roster identity & choose a franchise avatar.</p>
                  </div>
                </div>

                <div>
                  <label className="block text-[10px] uppercase font-black tracking-widest text-gray-400 mb-2">Team Name</label>
                  <input 
                    type="text" 
                    value={teamNameInput}
                    onChange={e => setTeamNameInput(e.target.value)}
                    required
                    maxLength={30}
                    placeholder="Enter team name"
                    className="w-full bg-gray-50 border border-gray-200 rounded-2xl px-4 py-3.5 text-xs text-gray-700 font-bold focus:outline-none focus:bg-white focus:border-indigo-500 shadow-inner"
                  />
                </div>

                <div>
                  <label className="block text-[10px] uppercase font-black tracking-widest text-gray-400 mb-2.5">Select Franchise Avatar</label>
                  <div className="grid grid-cols-7 gap-2 max-w-sm sm:max-w-none">
                    {['🏒', '⛸️', '🏆', '👑', '🦁', '❄️', '🐍', '⚡', '🌟', '🛡️', '💜', '🔥', '☄️', '🥅'].map(emoji => (
                      <button
                        key={emoji}
                        type="button"
                        onClick={() => setTeamAvatarInput(emoji)}
                        className={`w-10 h-10 rounded-xl flex items-center justify-center text-lg transition-all border ${teamAvatarInput === emoji ? 'bg-indigo-50 border-indigo-300 scale-110 shadow-sm' : 'bg-gray-50 border-gray-200 hover:bg-gray-100 active:scale-95'}`}
                      >
                        {emoji}
                      </button>
                    ))}
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={savingTeam}
                  className="w-full py-3.5 bg-gradient-to-r from-indigo-600 to-violet-600 text-white rounded-2xl text-[10px] font-black uppercase tracking-wider shadow-md shadow-indigo-600/10 active:scale-95 transition-transform"
                >
                  {savingTeam ? 'Saving team profile...' : 'Save Team Profile'}
                </button>
              </form>
            )}

            {/* League configuration details (Read Only) */}
            <div className="lg:col-span-5 bg-white border border-gray-200 p-6 rounded-[32px] shadow-sm space-y-4">
              <h3 className="text-xs font-black uppercase tracking-wider text-gray-800 border-b border-gray-100 pb-4 mb-2 flex items-center gap-1.5">⚙️ League Rules Settings</h3>
              
              <div className="flex justify-between text-xs py-1">
                <span className="text-gray-400 font-semibold">Match-up Duration</span>
                <span className="font-black text-gray-800">{leagueData.scheduleSettings?.matchupDuration || 1} Week(s)</span>
              </div>
              <div className="flex justify-between text-xs py-1">
                <span className="text-gray-400 font-semibold">Playoff Entrants</span>
                <span className="font-black text-gray-800">{leagueData.scheduleSettings?.playoffTeams || 4} Teams</span>
              </div>
              <div className="flex justify-between text-xs py-1">
                <span className="text-gray-400 font-semibold">Draft Schedule Date</span>
                <span className="font-black text-gray-800">{leagueData.draftDate ? new Date(leagueData.draftDate).toLocaleString() : 'Not Scheduled'}</span>
              </div>
              <div className="flex justify-between text-xs py-1">
                <span className="text-gray-400 font-semibold">Recruitment Limit</span>
                <span className="font-black text-gray-800">{leagueData.maxTeams} Franchises</span>
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
              <form onSubmit={handleSaveLeagueSettings} className="bg-white border border-gray-200 p-6 rounded-[32px] shadow-sm space-y-5">
                <div className="border-b border-gray-100 pb-3">
                  <h3 className="text-xs font-black uppercase tracking-wider text-gray-800">Define League Configurations</h3>
                  <p className="text-[10px] text-gray-400 font-semibold mt-0.5">Define schedule limits and precise skater/goalie scoring points weights.</p>
                </div>
                
                {isDraftScheduled && (
                  <div className="p-3 bg-amber-50 border border-amber-100 text-amber-700 rounded-2xl text-[10px] font-bold leading-normal flex items-center gap-2">
                    <span>🔒</span>
                    <span>Scoring, schedule, and playoff settings are fully locked because a draft date is scheduled. Unschedule the draft below to edit rules.</span>
                  </div>
                )}

                {/* Matchup & Playoff Selectors */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-[10px] uppercase font-black text-gray-400 mb-2">Match-up Duration</label>
                    <select
                      disabled={isDraftScheduled}
                      value={matchupWeeksInput}
                      onChange={e => setMatchupWeeksInput(e.target.value)}
                      className="w-full bg-gray-50 border border-gray-200 rounded-2xl px-4 py-3 text-xs text-gray-700 font-bold focus:outline-none focus:border-indigo-500 shadow-sm disabled:opacity-60"
                    >
                      <option value={1}>1 Week Matchups</option>
                      <option value={2}>2 Weeks Matchups</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-[10px] uppercase font-black text-gray-400 mb-2">Playoff Entrants</label>
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
                <div className="border-t border-gray-100 pt-5">
                  <h4 className="text-[10px] font-black uppercase text-emerald-600 bg-emerald-50 border border-emerald-100 px-3 py-1.5 rounded-full inline-block mb-4 tracking-widest shadow-sm">📋 Roster Sheet Size</h4>
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
                  <h4 className="text-[10px] font-black uppercase text-indigo-600 bg-indigo-50 border border-indigo-100 px-3 py-1.5 rounded-full inline-block mb-4 tracking-widest shadow-sm">⛸️ Skater Scoring Rules</h4>
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
                  <h4 className="text-[10px] font-black uppercase text-purple-600 bg-purple-50 border border-purple-100 px-3 py-1.5 rounded-full inline-block mb-4 tracking-widest shadow-sm">🥅 Goalie Scoring Rules</h4>
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

            {/* DANGER ZONE - FULL WIDTH AT THE BOTTOM (lg:col-span-12) */}
            <div className="lg:col-span-12 bg-red-50 border border-red-100 p-6 rounded-[32px] shadow-sm space-y-4 mt-4">
              <h4 className="text-xs font-black uppercase tracking-wider text-red-700">Danger Zone</h4>
              <p className="text-[10px] text-red-500 font-semibold leading-normal">Permanently destroy this league document, all corresponding player rosters, and team sheets. This action is irreversible.</p>
              <button
                type="button"
                onClick={handleDeleteLeague}
                className="w-full py-3.5 bg-red-600 hover:bg-red-500 text-white rounded-2xl text-[10px] font-black uppercase tracking-wider shadow-sm active:scale-95 transition-transform"
              >
                Delete League
              </button>
            </div>

          </div>
        )}
      </div>

    </div>
  );
}
