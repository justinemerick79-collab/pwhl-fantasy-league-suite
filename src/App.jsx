import React, { useState, useEffect } from 'react';
import './index.css';
import AuthModal from './components/AuthModal';
import AdminPanel from './components/AdminPanel';
import LeagueHub from './components/LeagueHub';
import Matchup from './components/Matchup';
import Roster from './components/Roster';
import Players from './components/Players';
import League from './components/League';
import { useAuth } from './contexts/AuthContext';
import { db } from './firebase.js';
import { collection, query, where, getDocs, doc, getDoc } from 'firebase/firestore';

function App() {
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [currentTab, setCurrentTab] = useState('matchup'); // 'matchup', 'roster', 'players', 'leagueCentral'
  const [isAdminView, setIsAdminView] = useState(false);
  
  const [activeLeagueId, setActiveLeagueId] = useState(localStorage.getItem('pwhl_active_league') || null);
  const [activeLeagueName, setActiveLeagueName] = useState('Select League');
  const [myLeagues, setMyLeagues] = useState([]);
  const [loadingLeagues, setLoadingLeagues] = useState(false);
  
  // Custom dropdown states
  const [isSwitchMenuOpen, setIsSwitchMenuOpen] = useState(false);
  const [isAccountMenuOpen, setIsAccountMenuOpen] = useState(false);
  
  // Launcher popup modals triggered from various UI components
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showJoinModal, setShowJoinModal] = useState(false);

  const { currentUser, isAdmin, logout } = useAuth();

  // Load user leagues list dynamically
  const fetchUserLeagues = async () => {
    if (!currentUser) {
      setMyLeagues([]);
      return;
    }
    setLoadingLeagues(true);
    try {
      const q = query(collection(db, 'fantasy_leagues'), where('members', 'array-contains', currentUser.uid));
      const snap = await getDocs(q);
      const leagues = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      setMyLeagues(leagues);
      
      // Update active league name if one is already selected
      if (activeLeagueId) {
        const active = leagues.find(l => l.id === activeLeagueId);
        if (active) {
          setActiveLeagueName(active.name);
        } else {
          setActiveLeagueId(null);
          localStorage.removeItem('pwhl_active_league');
          setActiveLeagueName('Select League');
        }
      }
    } catch (err) {
      console.error("Error loading leagues:", err);
    } finally {
      setLoadingLeagues(false);
    }
  };

  useEffect(() => {
    fetchUserLeagues();
  }, [currentUser, activeLeagueId]);

  const handleSetActiveLeague = (id, name) => {
    setActiveLeagueId(id);
    if (id) {
      localStorage.setItem('pwhl_active_league', id);
      setActiveLeagueName(name);
    } else {
      localStorage.removeItem('pwhl_active_league');
      setActiveLeagueName('Select League');
    }
    setIsSwitchMenuOpen(false);
  };

  const handleSignOut = async () => {
    await logout();
    handleSetActiveLeague(null, '');
    setIsAccountMenuOpen(false);
  };

  return (
    <div className="min-h-screen bg-[#0f0f13] text-gray-100 font-sans selection:bg-indigo-500/30 selection:text-white">
      
      {/* ── 1. GLOBAL PREMIUM NAVIGATION BAR ── */}
      <nav className="sticky top-0 z-40 bg-[#0f0f13]/80 border-b border-white/5 backdrop-blur-md px-4 py-3.5 flex justify-between items-center select-none">
        <div className="flex items-center gap-3">
          <div 
            onClick={() => handleSetActiveLeague(null, '')}
            className="text-lg font-black tracking-tighter bg-gradient-to-r from-indigo-400 via-violet-400 to-indigo-300 bg-clip-text text-transparent cursor-pointer hover:opacity-90 active:scale-95 transition-transform"
          >
            PWHL Fantasy
          </div>

          {/* Active League Switcher dropdown (Only shown when logged in and inside a league) */}
          {currentUser && activeLeagueId && (
            <div className="relative">
              <button 
                onClick={() => setIsSwitchMenuOpen(!isSwitchMenuOpen)}
                className="flex items-center gap-1.5 bg-white/5 border border-white/10 px-2.5 py-1.5 rounded-xl text-xs font-bold text-gray-200 active:scale-95 transition-transform"
              >
                <span className="max-w-[100px] truncate">{activeLeagueName}</span>
                <span className="text-[9px] text-indigo-400">▼</span>
              </button>

              {isSwitchMenuOpen && (
                <div className="absolute left-0 mt-2 w-56 rounded-2xl bg-[#16161c] border border-white/10 shadow-2xl p-2 z-50">
                  <div className="text-[9px] font-black text-gray-500 px-3 py-1.5 uppercase tracking-widest border-b border-white/5 mb-1">Switch Leagues</div>
                  
                  {myLeagues.map(l => (
                    <button
                      key={l.id}
                      onClick={() => handleSetActiveLeague(l.id, l.name)}
                      className={`w-full text-left px-3 py-2 text-xs font-bold rounded-xl transition-colors truncate flex items-center justify-between ${activeLeagueId === l.id ? 'bg-indigo-600 text-white' : 'text-gray-300 hover:bg-white/5'}`}
                    >
                      <span className="truncate">{l.name}</span>
                      {activeLeagueId === l.id && <span className="text-[10px]">✓</span>}
                    </button>
                  ))}

                  <div className="border-t border-white/5 my-1.5"></div>
                  
                  {/* Actions inside upper switcher drop-down */}
                  <button 
                    onClick={() => { setShowCreateModal(true); setIsSwitchMenuOpen(false); }}
                    className="w-full text-left px-3 py-2 text-xs font-bold text-indigo-400 hover:bg-indigo-500/10 rounded-xl transition-colors"
                  >
                    ➕ Create New League
                  </button>
                  <button 
                    onClick={() => { setShowJoinModal(true); setIsSwitchMenuOpen(false); }}
                    className="w-full text-left px-3 py-2 text-xs font-bold text-indigo-400 hover:bg-indigo-500/10 rounded-xl transition-colors"
                  >
                    🚪 Join Another League
                  </button>
                  
                  <div className="border-t border-white/5 my-1.5"></div>
                  
                  <button 
                    onClick={() => handleSetActiveLeague(null, '')}
                    className="w-full text-left px-3 py-2 text-xs font-bold text-gray-400 hover:bg-white/5 rounded-xl transition-colors"
                  >
                    🏠 League Selector
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right Nav Account Operations */}
        <div className="flex items-center gap-3">
          {currentUser ? (
            <div className="relative">
              <button 
                onClick={() => setIsAccountMenuOpen(!isAccountMenuOpen)}
                className="w-8 h-8 rounded-full bg-indigo-500/10 border border-indigo-500/25 flex items-center justify-center font-black text-xs text-indigo-400 shadow-lg active:scale-95 transition-transform"
              >
                {currentUser.email ? currentUser.email.charAt(0).toUpperCase() : "U"}
              </button>

              {isAccountMenuOpen && (
                <div className="absolute right-0 mt-2 w-48 rounded-2xl bg-[#16161c] border border-white/10 shadow-2xl p-2 z-50">
                  <div className="px-3 py-2 text-[10px] text-gray-500 truncate border-b border-white/5 mb-1.5">
                    Signed in as<br/><strong className="text-gray-200 font-bold text-xs truncate block">{currentUser.email}</strong>
                  </div>
                  
                  {isAdmin && (
                    <button 
                      onClick={() => { setIsAdminView(!isAdminView); setIsAccountMenuOpen(false); }}
                      className={`w-full text-left px-3 py-2 text-xs font-bold rounded-xl transition-colors ${isAdminView ? 'bg-purple-600 text-white' : 'text-purple-400 hover:bg-purple-500/10'}`}
                    >
                      🛡️ Admin Console
                    </button>
                  )}

                  <button 
                    onClick={handleSignOut}
                    className="w-full text-left px-3 py-2 text-xs font-bold text-rose-400 hover:bg-rose-500/10 rounded-xl transition-colors mt-1"
                  >
                    🚪 Sign Out
                  </button>
                </div>
              )}
            </div>
          ) : (
            <button 
              onClick={() => setIsAuthModalOpen(true)}
              className="bg-gradient-to-r from-indigo-600 to-violet-500 text-white px-4 py-2 rounded-xl text-xs font-black uppercase tracking-wider shadow-lg shadow-indigo-600/15 active:scale-95 transition-transform"
            >
              Enter Arena
            </button>
          )}
        </div>
      </nav>

      {/* ── 2. STAGE 1: NOT LOGGED IN LANDING PAGE ── */}
      {!currentUser && (
        <div className="px-6 py-12 max-w-lg mx-auto flex flex-col items-center text-center justify-center min-h-[80vh] select-none">
          <div className="w-20 h-20 rounded-3xl bg-gradient-to-tr from-indigo-600 to-violet-500 flex items-center justify-center text-4xl shadow-xl shadow-indigo-600/20 border border-indigo-400/20 mb-8 animate-bounce">
            ⛸️
          </div>
          
          <h1 className="text-4xl font-black tracking-tight leading-none bg-gradient-to-r from-white via-gray-200 to-gray-400 bg-clip-text text-transparent">
            PWHL FANTASY
          </h1>
          <p className="text-sm font-bold uppercase tracking-widest text-indigo-400 mt-3">The Arena is Waiting</p>
          
          <p className="text-gray-400 text-xs mt-4 leading-relaxed max-w-sm">
            Join the premium home of Professional Women's Hockey League fantasy pools. Build custom rules leagues, draft star players, trade assets atomically, and compete with friends.
          </p>

          <button
            onClick={() => setIsAuthModalOpen(true)}
            className="mt-8 px-8 py-4 bg-gradient-to-r from-indigo-600 to-violet-500 text-white text-xs font-black uppercase tracking-wider rounded-2xl shadow-xl shadow-indigo-600/20 active:scale-95 transition-transform w-full"
          >
            Create Your Team Command Center
          </button>
          
          <div className="grid grid-cols-2 gap-4 w-full mt-12 text-left">
            <div className="bg-white/[0.02] border border-white/5 p-4 rounded-2xl">
              <span className="text-lg">⚡</span>
              <h4 className="text-xs font-bold mt-2 text-white">Atomic Swaps</h4>
              <p className="text-[10px] text-gray-500 mt-1">Acquire free agents instantly with strict limit protections.</p>
            </div>
            <div className="bg-white/[0.02] border border-white/5 p-4 rounded-2xl">
              <span className="text-lg">⏰</span>
              <h4 className="text-xs font-bold mt-2 text-white">Rolling Waivers</h4>
              <p className="text-[10px] text-gray-500 mt-1">48-hour time travel deadline claim evaluations.</p>
            </div>
          </div>
        </div>
      )}

      {/* ── 3. STAGE 2: LOGGED IN ADMIN VIEW OVERRIDE ── */}
      {currentUser && isAdminView && <AdminPanel />}

      {/* ── 4. STAGE 3: LOGGED IN BUT NOT IN ACTIVE LEAGUE ── */}
      {currentUser && !isAdminView && !activeLeagueId && (
        <div className="px-4 py-8 max-w-md mx-auto">
          {loadingLeagues ? (
            <div className="py-20 text-center text-gray-500 text-xs font-black tracking-widest animate-pulse">Syncing fantasy rosters...</div>
          ) : myLeagues.length === 0 ? (
            
            // Onboarding sub-state: Logged in, but 0 leagues
            <div className="text-center py-12 px-6 bg-white/[0.02] border border-white/5 rounded-3xl backdrop-blur-md select-none mt-10">
              <span className="text-4xl">🥅</span>
              <h2 className="text-xl font-bold tracking-tight text-white mt-4">Welcome to PWHL Fantasy!</h2>
              <p className="text-xs text-gray-500 mt-2 max-w-xs mx-auto leading-relaxed">
                You are not currently managing teams in any fantasy leagues. Select an option below to enter the arena.
              </p>
              
              <div className="space-y-3 mt-8">
                <button 
                  onClick={() => setShowCreateModal(true)}
                  className="w-full py-4 bg-gradient-to-r from-indigo-600 to-violet-500 rounded-2xl text-xs font-black uppercase tracking-wider text-white shadow-lg active:scale-95 transition-transform"
                >
                  ➕ Create a League
                </button>
                <button 
                  onClick={() => setShowJoinModal(true)}
                  className="w-full py-4 bg-white/5 hover:bg-white/10 border border-white/15 rounded-2xl text-xs font-black uppercase tracking-wider text-gray-300 active:scale-95 transition-transform"
                >
                  🚪 Join an Existing League
                </button>
              </div>
            </div>
          ) : (
            
            // Selection sub-state: Logged in, has 1-N leagues (Horizontal swipable card selector)
            <div>
              <header className="mb-6">
                <span className="text-[9px] uppercase font-extrabold tracking-widest text-indigo-400 bg-indigo-500/10 px-2.5 py-0.5 rounded-full border border-indigo-500/15">Dashboard</span>
                <h1 className="text-2xl font-black mt-1 leading-tight tracking-tight">Your Team Rosters</h1>
                <p className="text-xs text-gray-500 font-semibold mt-1">Swipe left/right to browse and select active fantasy leagues.</p>
              </header>

              {/* Horizontal Roster Cards Swipe Selector */}
              <div className="flex gap-4 overflow-x-auto pb-6 snap-x snap-mandatory scrollbar-none px-1">
                
                {myLeagues.map((league, idx) => {
                  const isOwner = league.ownerId === currentUser.uid;
                  return (
                    <div 
                      key={league.id}
                      onClick={() => handleSetActiveLeague(league.id, league.name)}
                      className="snap-center shrink-0 w-[280px] bg-gradient-to-b from-white/5 to-white/[0.01] border border-white/5 p-6 rounded-3xl flex flex-col justify-between shadow-xl relative overflow-hidden active:scale-[0.98] transition-transform cursor-pointer"
                    >
                      <div className="absolute top-0 right-0 w-24 h-24 bg-indigo-500/5 rounded-full blur-2xl"></div>
                      
                      <div>
                        <div className="flex justify-between items-start">
                          <span className="text-[8px] uppercase font-black tracking-widest text-gray-500 bg-white/5 border border-white/5 px-2 py-0.5 rounded-md">
                            {isOwner ? "Commissioner" : "Co-owner"}
                          </span>
                          <span className="text-[10px] font-black text-indigo-400">#{idx + 1}</span>
                        </div>
                        
                        <h3 className="text-lg font-black text-white mt-4 leading-tight truncate">{league.name}</h3>
                        <p className="text-[10px] text-gray-500 font-bold uppercase tracking-wider mt-1">{league.members.length} / {league.maxTeams} Members</p>
                      </div>

                      <div className="mt-8 border-t border-white/5 pt-4 flex items-center justify-between">
                        <span className="text-[10px] uppercase font-black tracking-widest text-indigo-400">Enter Team</span>
                        <span className="w-8 h-8 rounded-full bg-white/5 flex items-center justify-center text-xs font-black">➜</span>
                      </div>
                    </div>
                  );
                })}

                {/* Final Swipable Card: Actions to Create or Join */}
                <div className="snap-center shrink-0 w-[240px] border border-dashed border-white/10 p-6 rounded-3xl bg-white/[0.005] flex flex-col justify-between shadow-xl select-none">
                  <div>
                    <h3 className="text-sm font-black text-gray-400 uppercase tracking-wider">New Journey</h3>
                    <p className="text-[10px] text-gray-600 mt-1">Assemble another roster or enter a friend's command post.</p>
                  </div>
                  
                  <div className="space-y-2 mt-8">
                    <button 
                      onClick={() => setShowCreateModal(true)}
                      className="w-full py-3 bg-gradient-to-r from-indigo-600 to-violet-500 rounded-2xl text-[9px] font-black uppercase text-white tracking-wider active:scale-95 transition-transform"
                    >
                      ➕ Create League
                    </button>
                    <button 
                      onClick={() => setShowJoinModal(true)}
                      className="w-full py-3 bg-white/5 hover:bg-white/10 border border-white/5 rounded-2xl text-[9px] font-black uppercase text-gray-300 tracking-wider active:scale-95 transition-transform"
                    >
                      🚪 Join League
                    </button>
                  </div>
                </div>

              </div>
            </div>
          )}
        </div>
      )}

      {/* ── 5. STAGE 4: SELECTED LEAGUE ACTIVE VIEWS ── */}
      {currentUser && !isAdminView && activeLeagueId && (
        <main className="pb-24">
          {currentTab === 'matchup' && <Matchup activeLeagueId={activeLeagueId} />}
          {currentTab === 'roster' && <Roster activeLeagueId={activeLeagueId} />}
          {currentTab === 'players' && <Players activeLeagueId={activeLeagueId} />}
          {currentTab === 'leagueCentral' && <League activeLeagueId={activeLeagueId} />}

          {/* ACTIVE TEAM NAVIGATION SUB-MENU (MOBILE TAB BAR) */}
          <nav className="fixed bottom-0 left-0 right-0 h-16 bg-[#16161c]/95 border-t border-white/5 backdrop-blur-lg flex justify-around items-center px-2 z-40">
            <button 
              onClick={() => setCurrentTab('matchup')}
              className={`flex flex-col items-center justify-center w-16 h-12 rounded-xl transition-all ${currentTab === 'matchup' ? 'text-indigo-400 scale-105 font-bold' : 'text-gray-500 hover:text-gray-300'}`}
            >
              <span className="text-sm">🆚</span>
              <span className="text-[9px] tracking-tight font-extrabold uppercase mt-0.5">Matchup</span>
            </button>

            <button 
              onClick={() => setCurrentTab('roster')}
              className={`flex flex-col items-center justify-center w-16 h-12 rounded-xl transition-all ${currentTab === 'roster' ? 'text-indigo-400 scale-105 font-bold' : 'text-gray-500 hover:text-gray-300'}`}
            >
              <span className="text-sm">⛸️</span>
              <span className="text-[9px] tracking-tight font-extrabold uppercase mt-0.5">Roster</span>
            </button>

            <button 
              onClick={() => setCurrentTab('players')}
              className={`flex flex-col items-center justify-center w-16 h-12 rounded-xl transition-all ${currentTab === 'players' ? 'text-indigo-400 scale-105 font-bold' : 'text-gray-500 hover:text-gray-300'}`}
            >
              <span className="text-sm">🔍</span>
              <span className="text-[9px] tracking-tight font-extrabold uppercase mt-0.5">Players</span>
            </button>

            <button 
              onClick={() => setCurrentTab('leagueCentral')}
              className={`flex flex-col items-center justify-center w-16 h-12 rounded-xl transition-all ${currentTab === 'leagueCentral' ? 'text-indigo-400 scale-105 font-bold' : 'text-gray-500 hover:text-gray-300'}`}
            >
              <span className="text-sm">🏆</span>
              <span className="text-[9px] tracking-tight font-extrabold uppercase mt-0.5">League</span>
            </button>
          </nav>
        </main>
      )}

      {/* ── 6. FLOATING DIALOG OVERLAYS (CREATE / JOIN LEAGUE POPUPS) ── */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-50 overflow-y-auto">
          <div className="w-full max-w-sm my-8">
            <div className="bg-[#16161c] border border-white/10 rounded-3xl p-6 relative">
              <button 
                onClick={() => setShowCreateModal(false)}
                className="absolute top-4 right-4 text-gray-400 text-lg hover:text-white"
              >
                &times;
              </button>
              <LeagueHub activeLeagueId={null} setActiveLeagueId={handleSetActiveLeague} />
            </div>
          </div>
        </div>
      )}

      {showJoinModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="w-full max-w-sm bg-[#16161c] border border-white/10 rounded-3xl p-6 relative">
            <button 
              onClick={() => setShowJoinModal(false)}
              className="absolute top-4 right-4 text-gray-400 text-lg hover:text-white"
            >
              &times;
            </button>
            <LeagueHub activeLeagueId={null} setActiveLeagueId={handleSetActiveLeague} />
          </div>
        </div>
      )}

      {/* Auth Modals */}
      <AuthModal isOpen={isAuthModalOpen} onClose={() => { setIsAuthModalOpen(false); fetchUserLeagues(); }} />
    </div>
  );
}

export default App;
