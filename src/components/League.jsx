import React, { useState, useEffect } from 'react';
import { db } from '../firebase.js';
import { doc, getDoc, updateDoc, collection, getDocs } from 'firebase/firestore';
import { useAuth } from '../contexts/AuthContext';

export default function League({ activeLeagueId }) {
  const { currentUser } = useAuth();
  const [activeTab, setActiveTab] = useState('scoreboard'); // 'scoreboard' | 'standings' | 'playoffs' | 'manager'
  const [leagueData, setLeagueData] = useState(null);
  const [teams, setTeams] = useState([]);
  const [loading, setLoading] = useState(true);

  // Activation State
  const [draftDate, setDraftDate] = useState('');
  const [activating, setActivating] = useState(false);
  const [activateError, setActivateError] = useState('');

  const fetchLeagueDetails = async () => {
    if (!activeLeagueId) return;
    setLoading(true);
    try {
      const docRef = doc(db, 'fantasy_leagues', activeLeagueId);
      const snap = await getDoc(docRef);
      if (snap.exists()) {
        setLeagueData(snap.data());
      }

      const tSnap = await getDocs(collection(db, `fantasy_leagues/${activeLeagueId}/teams`));
      setTeams(tSnap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch (err) {
      console.error("Error fetching league:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLeagueDetails();
  }, [activeLeagueId]);

  if (!activeLeagueId) {
    return (
      <div className="min-h-[80vh] flex flex-col items-center justify-center px-6 text-center select-none">
        <div className="w-16 h-16 rounded-full bg-indigo-500/10 border border-indigo-500/25 flex items-center justify-center text-3xl mb-6 shadow-xl animate-pulse">
          🏆
        </div>
        <h2 className="text-xl font-bold text-white tracking-wide">No Active League</h2>
        <p className="text-xs text-gray-500 mt-2 max-w-sm leading-relaxed">
          Unlock your command center! Select or join a league to view schedules, standings, and playoff brackets.
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="min-h-[85vh] flex items-center justify-center">
        <div className="text-xs font-black tracking-widest text-gray-500 uppercase animate-pulse">
          Loading League Command Center...
        </div>
      </div>
    );
  }

  if (!leagueData) {
    return (
      <div className="min-h-[80vh] flex flex-col items-center justify-center px-6 text-center">
        <h2 className="text-lg font-bold text-white">League Not Found</h2>
      </div>
    );
  }

  const isCommish = currentUser && currentUser.uid === leagueData.ownerId;
  const isPending = leagueData.status === 'pending';
  const isFull = leagueData.members.length >= leagueData.maxTeams;

  const handleActivateLeague = async (e) => {
    e.preventDefault();
    setActivateError('');
    if (!draftDate) {
      setActivateError("Please select a draft date.");
      return;
    }
    
    setActivating(true);
    try {
      const docRef = doc(db, 'fantasy_leagues', activeLeagueId);
      await updateDoc(docRef, {
        status: 'active',
        draftDate: new Date(draftDate).toISOString()
      });
      alert("League Activated successfully!");
      fetchLeagueDetails();
    } catch (err) {
      console.error(err);
      setActivateError("Failed to activate league.");
    } finally {
      setActivating(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0f0f13] text-gray-100 px-4 pt-6 pb-24 select-none">
      
      {/* ── LEAGUE HEADER ── */}
      <header className="mb-6">
        <div className="flex items-center gap-3">
          <span className="text-[9px] uppercase font-extrabold tracking-widest text-indigo-400 bg-indigo-500/10 px-2.5 py-0.5 rounded-full border border-indigo-500/15">
            League Central
          </span>
          <span className={`text-[9px] uppercase font-extrabold tracking-widest px-2.5 py-0.5 rounded-full border ${isPending ? 'bg-amber-500/10 border-amber-500/15 text-amber-400' : 'bg-emerald-500/10 border-emerald-500/15 text-emerald-400'}`}>
            {leagueData.status}
          </span>
        </div>
        <h1 className="text-2xl font-black mt-2 tracking-tight bg-gradient-to-r from-white via-gray-200 to-gray-400 bg-clip-text text-transparent">
          {leagueData.name}
        </h1>
        <p className="text-xs text-gray-500 font-semibold mt-1">Manage weekly standings, playoff trees, and commissioner configurations.</p>
      </header>

      {/* ── TAB NAVIGATION ── */}
      <div className="flex p-1 bg-black/40 border border-white/5 rounded-2xl mb-6 shadow-inner overflow-x-auto scrollbar-none">
        {[
          { key: 'scoreboard', label: '📊 Scores' },
          { key: 'standings', label: '🏆 Standings' },
          { key: 'playoffs', label: '🌲 Bracket' },
          ...(isCommish ? [{ key: 'manager', label: '⚙️ Commissioner' }] : [])
        ].map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex-1 min-w-[80px] py-3 text-[10px] font-black uppercase tracking-wider rounded-xl transition-all duration-300 ${activeTab === tab.key ? 'bg-gradient-to-r from-indigo-600 to-violet-500 text-white shadow-md' : 'text-gray-400 hover:text-gray-200'}`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="space-y-4">
        
        {/* ── TAB 1: WEEKLY SCOREBOARDS ── */}
        {activeTab === 'scoreboard' && (
          <div className="space-y-4">
            <h3 className="text-sm font-black uppercase tracking-wider text-gray-400 mb-2">H2H Matchup Arena</h3>
            
            {/* Matchup Pair 1 */}
            <div className="bg-white/[0.02] border border-white/5 p-5 rounded-3xl relative overflow-hidden">
              <div className="flex justify-between items-center text-[9px] text-gray-500 font-bold uppercase tracking-wider mb-4">
                <span>Matchup A</span>
                <span className="text-emerald-400 flex items-center gap-1">
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-500"></span>
                  </span>
                  Active
                </span>
              </div>
              <div className="flex justify-between items-center">
                <div className="flex items-center gap-2.5">
                  <span className="text-xl">🐍</span>
                  <span className="text-xs font-black text-white">Montreal Vipers</span>
                </div>
                <span className="text-sm font-black text-white">142.5</span>
              </div>
              <div className="flex justify-between items-center mt-3.5">
                <div className="flex items-center gap-2.5">
                  <span className="text-xl">❄️</span>
                  <span className="text-xs font-black text-white">Toronto Blizzard</span>
                </div>
                <span className="text-sm font-black text-white">128.0</span>
              </div>
            </div>

            {/* Matchup Pair 2 */}
            <div className="bg-white/[0.02] border border-white/5 p-5 rounded-3xl opacity-75">
              <div className="flex justify-between items-center text-[9px] text-gray-500 font-bold uppercase tracking-wider mb-4">
                <span>Matchup B</span>
                <span>Ready</span>
              </div>
              <div className="flex justify-between items-center">
                <div className="flex items-center gap-2.5">
                  <span className="text-xl">🦁</span>
                  <span className="text-xs font-black text-white">Boston Pride</span>
                </div>
                <span className="text-sm font-black text-white">0.0</span>
              </div>
              <div className="flex justify-between items-center mt-3.5">
                <div className="flex items-center gap-2.5">
                  <span className="text-xl">⚡</span>
                  <span className="text-xs font-black text-white">Ottawa Charge</span>
                </div>
                <span className="text-sm font-black text-white">0.0</span>
              </div>
            </div>
          </div>
        )}

        {/* ── TAB 2: STANDINGS LEADERBOARD ── */}
        {activeTab === 'standings' && (
          <div className="space-y-4">
            <h3 className="text-sm font-black uppercase tracking-wider text-gray-400">Leaderboard Rankings</h3>

            <div className="overflow-hidden border border-white/5 rounded-3xl bg-white/[0.01]">
              <div className="grid grid-cols-12 bg-white/5 p-3.5 text-[10px] font-black uppercase text-gray-500 tracking-wider">
                <div className="col-span-2">Rk</div>
                <div className="col-span-6">Team</div>
                <div className="col-span-2 text-right">W-L</div>
                <div className="col-span-2 text-right">Pts</div>
              </div>

              <div className="divide-y divide-white/5">
                {teams.length === 0 ? (
                  <div className="p-8 text-center text-xs text-gray-500">Standings loading or empty.</div>
                ) : (
                  [...teams]
                    .sort((a,b) => (b.points || 0) - (a.points || 0))
                    .map((team, idx) => (
                      <div key={team.id} className="grid grid-cols-12 p-4 text-xs items-center">
                        <div className="col-span-2 font-black text-gray-400">{idx + 1}</div>
                        <div className="col-span-6 font-bold text-white flex items-center gap-2.5">
                          <span>{idx === 0 ? '🐍' : idx === 1 ? '❄️' : '🏒'}</span>
                          <span className="truncate">{team.teamName}</span>
                          {team.ownerId === currentUser.uid && <span className="text-[8px] bg-indigo-500/20 text-indigo-400 px-1 py-0.2 rounded font-black">YOU</span>}
                        </div>
                        <div className="col-span-2 text-right font-medium text-gray-400">0-0</div>
                        <div className="col-span-2 text-right font-black text-white">0.0</div>
                      </div>
                    ))
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── TAB 3: PLAYOFF BRACKET FLOWCHART ── */}
        {activeTab === 'playoffs' && (
          <div className="space-y-4">
            <h3 className="text-sm font-black uppercase tracking-wider text-gray-400 mb-2">Playoff Tree Bracket</h3>
            
            <div className="space-y-6 relative pl-4 border-l border-white/5 py-2 select-none">
              {/* Semifinal 1 */}
              <div className="relative">
                <div className="absolute -left-[21px] top-4 w-4 h-[1px] bg-white/10"></div>
                <span className="text-[9px] uppercase font-black text-indigo-400 tracking-wider">Semifinal Match A</span>
                <div className="bg-white/[0.02] border border-white/5 p-3 rounded-2xl mt-1 space-y-1">
                  <div className="flex justify-between text-xs font-bold text-white">
                    <span>#1 Seed</span>
                    <span className="text-gray-500">-</span>
                  </div>
                  <div className="flex justify-between text-xs font-bold text-gray-400">
                    <span>#4 Seed</span>
                    <span className="text-gray-500">-</span>
                  </div>
                </div>
              </div>

              {/* Semifinal 2 */}
              <div className="relative">
                <div className="absolute -left-[21px] top-4 w-4 h-[1px] bg-white/10"></div>
                <span className="text-[9px] uppercase font-black text-indigo-400 tracking-wider">Semifinal Match B</span>
                <div className="bg-white/[0.02] border border-white/5 p-3 rounded-2xl mt-1 space-y-1">
                  <div className="flex justify-between text-xs font-bold text-white">
                    <span>#2 Seed</span>
                    <span className="text-gray-500">-</span>
                  </div>
                  <div className="flex justify-between text-xs font-bold text-gray-400">
                    <span>#3 Seed</span>
                    <span className="text-gray-500">-</span>
                  </div>
                </div>
              </div>

              {/* Championship Match */}
              <div className="relative pt-4 border-t border-white/5 mt-4">
                <span className="text-[9px] uppercase font-black text-amber-400 tracking-wider flex items-center gap-1">👑 PWHL Championship Final</span>
                <div className="bg-gradient-to-tr from-amber-500/10 to-transparent border border-amber-500/20 p-4 rounded-3xl mt-1 space-y-1.5">
                  <div className="flex justify-between text-xs font-black text-white">
                    <span>Winner Match A</span>
                    <span className="text-amber-400">Ready</span>
                  </div>
                  <div className="flex justify-between text-xs font-black text-white">
                    <span>Winner Match B</span>
                    <span className="text-amber-400">Ready</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── TAB 4: COMMISSIONER TOOLS ── */}
        {activeTab === 'manager' && isCommish && (
          <div className="space-y-4">
            <h3 className="text-sm font-black uppercase tracking-wider text-rose-400 mb-2">⚙️ Commissioner Rules & Status</h3>

            {isPending ? (
              <div className="space-y-4">
                <div className="bg-[#16161c] border border-white/10 p-5 rounded-3xl">
                  <span className="text-[9px] uppercase font-black text-indigo-400">Recruitment Invite Code</span>
                  <div className="flex items-center justify-between mt-3 bg-black/40 border border-white/5 px-4 py-2.5 rounded-2xl">
                    <span className="text-base font-black tracking-widest text-white">{leagueData.inviteCode}</span>
                    <button 
                      onClick={() => {
                        navigator.clipboard.writeText(leagueData.inviteCode);
                        alert("Invite code copied!");
                      }}
                      className="text-[9px] uppercase font-black text-indigo-400 hover:text-indigo-300"
                    >
                      Copy
                    </button>
                  </div>
                </div>

                {isFull && (
                  <form onSubmit={handleActivateLeague} className="bg-gradient-to-tr from-indigo-500/10 to-transparent border border-indigo-500/20 p-5 rounded-3xl space-y-4">
                    <h4 className="text-xs font-black text-white">Ready for Activation</h4>
                    <p className="text-[10px] text-gray-500 leading-relaxed">Your league is fully occupied. Enter a draft schedule date to activate weekly H2H points tracking. Activating will lock rules settings.</p>
                    
                    {activateError && <div className="text-xs font-black text-rose-500 bg-rose-500/10 p-2.5 rounded-xl">{activateError}</div>}

                    <div>
                      <label className="block text-[9px] uppercase font-black tracking-widest text-gray-500 mb-2">Draft Schedule</label>
                      <input 
                        type="datetime-local" 
                        value={draftDate} 
                        onChange={e => setDraftDate(e.target.value)} 
                        required 
                        className="w-full bg-black/40 border border-white/10 rounded-2xl px-4 py-3 text-xs text-white focus:outline-none"
                      />
                    </div>

                    <button 
                      type="submit" 
                      disabled={activating}
                      className="w-full py-3.5 bg-gradient-to-r from-indigo-600 to-violet-500 rounded-2xl text-xs font-black uppercase tracking-wider text-white active:scale-95 transition-transform"
                    >
                      {activating ? 'Configuring arena...' : 'Activate League & Lock Rules'}
                    </button>
                  </form>
                )}
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex items-center gap-2 text-emerald-400 bg-emerald-500/10 border border-emerald-500/15 p-4 rounded-2xl text-xs font-black uppercase">
                  <span>🔒 League settings are locked & active.</span>
                </div>

                <div className="bg-white/[0.02] border border-white/5 p-5 rounded-3xl space-y-3">
                  <h4 className="text-xs font-black uppercase tracking-wider text-gray-400 border-b border-white/5 pb-2">Active Configuration</h4>
                  <div className="flex justify-between text-xs py-1">
                    <span className="text-gray-500">Match-up Duration</span>
                    <span className="font-bold">{leagueData.scheduleSettings?.matchupDuration || 1} Week(s)</span>
                  </div>
                  <div className="flex justify-between text-xs py-1">
                    <span className="text-gray-500">Playoff Entrants</span>
                    <span className="font-bold">{leagueData.scheduleSettings?.playoffTeams || 4} Teams</span>
                  </div>
                  <div className="flex justify-between text-xs py-1">
                    <span className="text-gray-500">Draft Date</span>
                    <span className="font-bold">{leagueData.draftDate ? new Date(leagueData.draftDate).toLocaleString() : 'N/A'}</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

    </div>
  );
}
