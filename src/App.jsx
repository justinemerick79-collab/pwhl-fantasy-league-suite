import React, { useState, useEffect } from 'react';
import './index.css';
import AuthModal from './components/AuthModal';
import AdminPanel from './components/AdminPanel';
import LeagueHub from './components/LeagueHub';
import Matchup from './components/Matchup';
import Roster from './components/Roster';
import Players from './components/Players';
import League from './components/League';
import DraftRoom from './components/DraftRoom';
import { useAuth } from './contexts/AuthContext';
import { useTimeTravel } from './contexts/TimeTravelContext';
import { db, functions } from './firebase.js';
import { collection, query, where, getDocs, doc, getDoc, updateDoc } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';

function App() {
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [authModalMode, setAuthModalMode] = useState('login'); // 'login' | 'signup'
  
  // Top-Level navigation tabs: 'matchup', 'roster', 'players', 'standings', 'settings', 'manager'
  const [currentTab, setCurrentTab] = useState('matchup'); 
  const [isAdminView, setIsAdminView] = useState(false);
  
  const [activeLeagueId, setActiveLeagueId] = useState(localStorage.getItem('pwhl_active_league') || null);
  const [activeLeagueName, setActiveLeagueName] = useState('Select League');
  const [activeLeagueData, setActiveLeagueData] = useState(null);
  const [myLeagues, setMyLeagues] = useState([]);
  const [loadingLeagues, setLoadingLeagues] = useState(false);
  
  // Dropdown States
  const [isSwitchMenuOpen, setIsSwitchMenuOpen] = useState(false);
  const [isAccountMenuOpen, setIsAccountMenuOpen] = useState(false);
  
  // Creation/Join launcher popups
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showJoinModal, setShowJoinModal] = useState(false);

  const { currentUser, isAdmin, logout } = useAuth();

  const { simulationState, leagueSimState, getSimulatedDate, isSimulationActive, activeSeasonName, setActiveLeagueId: setTimeTravelLeagueId } = useTimeTravel();
  const [isDayAdvancing, setIsDayAdvancing] = useState(false);
  const [isSkippingWeek, setIsSkippingWeek] = useState(false);
  const [isTeardownLoading, setIsTeardownLoading] = useState(false);

  const getDateStr = (date) => {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  };

  const getCurrentSimDateStr = () => {
    // Per-league simulation takes priority
    if (leagueSimState.isSimulation && leagueSimState.simulatedDate) {
      return leagueSimState.simulatedDate.split('T')[0];
    }
    // Fallback to global
    if (simulationState?.current_simulated_date) {
      return simulationState.current_simulated_date.split('T')[0];
    }
    return null;
  };

  const advanceSimulationDate = async (targetDateStr) => {
    try {
      // Per-league simulation: write to league doc
      if (leagueSimState.isSimulation && activeLeagueId) {
        const leagueRef = doc(db, "fantasy_leagues", activeLeagueId);
        await updateDoc(leagueRef, { simulatedDate: targetDateStr });
        console.log(`Advanced league ${activeLeagueId} simulation to: ${targetDateStr}`);
      }
      // Always update global simulation state so backend trigger fires
      const simStateRef = doc(db, "admin_settings", "simulation_state");
      await updateDoc(simStateRef, { current_simulated_date: targetDateStr });
      console.log("Advanced global simulation date to:", targetDateStr);
    } catch (err) {
      throw err;
    }
  };

  const handleAdvanceDay = async () => {
    setIsDayAdvancing(true);
    try {
      const currentDateStr = getCurrentSimDateStr();
      let baseDate;
      if (currentDateStr) {
        const [year, month, day] = currentDateStr.split('-').map(Number);
        baseDate = new Date(year, month - 1, day);
      } else {
        baseDate = new Date();
      }
      baseDate.setDate(baseDate.getDate() + 1);
      await advanceSimulationDate(getDateStr(baseDate));
    } catch (err) {
      console.error("Failed to advance simulated date:", err);
      alert("Failed to advance simulated date: " + err.message);
    } finally {
      setIsDayAdvancing(false);
    }
  };

  const handleSkipToEndOfWeek = async () => {
    setIsSkippingWeek(true);
    try {
      // Find the end of the current week from season data
      const currentDateStr = getCurrentSimDateStr();
      if (!currentDateStr) throw new Error("No simulated date set");

      const [year, month, day] = currentDateStr.split('-').map(Number);
      const currentDate = new Date(year, month - 1, day);

      // Try to find the week end from the league's season weeks
      let weekEndStr = null;
      if (activeLeagueData?.season_id) {
        const seasonRef = doc(db, "pwhl_seasons", String(activeLeagueData.season_id));
        const seasonSnap = await getDoc(seasonRef);
        if (seasonSnap.exists() && seasonSnap.data().weeks) {
          const weeks = seasonSnap.data().weeks;
          const matchedWeek = weeks.find(w => {
            const ws = new Date(w.start);
            const we = new Date(w.end);
            return currentDate >= ws && currentDate <= we;
          });
          if (matchedWeek) {
            weekEndStr = matchedWeek.end.split('T')[0];
          }
        }
      }

      // Fallback: advance to next Sunday
      if (!weekEndStr) {
        const daysUntilSunday = (7 - currentDate.getDay()) % 7 || 7;
        const sunday = new Date(currentDate);
        sunday.setDate(sunday.getDate() + daysUntilSunday);
        weekEndStr = getDateStr(sunday);
      }

      await advanceSimulationDate(weekEndStr);
    } catch (err) {
      console.error("Failed to skip to end of week:", err);
      alert("Failed to skip to end of week: " + err.message);
    } finally {
      setIsSkippingWeek(false);
    }
  };

  const handleDeactivateSimulation = async () => {
    if (!window.confirm("Are you sure you want to deactivate simulation mode? This will delete all generated bot users, remove the simulation league, and reset the simulated date.")) {
      return;
    }
    setIsTeardownLoading(true);
    try {
      const deactivateSimulationFn = httpsCallable(functions, 'deactivateSimulation');
      const res = await deactivateSimulationFn();
      if (res.data?.success) {
        alert("Simulation deactivated successfully! Cleaned up sandbox environment.");
        localStorage.removeItem('pwhl_active_league');
        window.location.reload();
      } else {
        throw new Error(res.data?.error || "Unknown error during teardown.");
      }
    } catch (err) {
      console.error("Simulation teardown failed:", err);
      alert("Simulation Deactivation Failed:\n" + err.message);
    } finally {
      setIsTeardownLoading(false);
    }
  };

  // Helper to race a promise with a timeout to prevent hanging on cached emulator connections
  const withTimeout = (promise, timeoutMs = 5000) => {
    return Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Firebase connection timed out. If you recently started/stopped Firebase emulators, please perform a hard refresh (Cmd+Shift+R or Ctrl+F5) to clear the browser's cached connections.")), timeoutMs)
      )
    ]);
  };

  // Helper to sync the state to the URL path
  const updateUrl = (adminView, tab, leagueId) => {
    let path = '/';
    if (adminView) {
      path = '/admin-console';
    } else if (leagueId) {
      path = `/${tab}`;
    }
    if (window.location.pathname !== path) {
      window.history.pushState(null, '', path);
    }
  };

  // Helper to parse the current URL path and update the component state
  const parsePathAndSetState = (path) => {
    if (!currentUser) return;
    
    if (path === '/admin-console') {
      if (isAdmin) {
        setIsAdminView(true);
      } else {
        setIsAdminView(false);
        updateUrl(false, currentTab, activeLeagueId);
      }
    } else {
      setIsAdminView(false);
      const tabName = path.slice(1); // strip leading slash
      const validTabs = ['matchup', 'roster', 'players', 'standings', 'settings', 'manager'];
      if (validTabs.includes(tabName)) {
        setCurrentTab(tabName);
      } else {
        // Fallback/Default path
        if (activeLeagueId) {
          setCurrentTab('matchup');
        }
      }
    }
  };

  // Load user leagues list
  const fetchUserLeagues = async () => {
    if (!currentUser) {
      setMyLeagues([]);
      return;
    }
    setLoadingLeagues(true);
    try {
      const q = query(collection(db, 'fantasy_leagues'), where('members', 'array-contains', currentUser.uid));
      const snap = await withTimeout(getDocs(q), 5000);
      const leagues = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      setMyLeagues(leagues);
      
      if (leagues.length > 0) {
        let selected = leagues.find(l => l.id === activeLeagueId);
        
        // Auto-Active Default: If no active league is set, automatically default to the first league
        if (!selected) {
          selected = leagues[0];
          handleSetActiveLeague(selected.id, selected.name);
        } else {
          setActiveLeagueName(selected.name);
          setActiveLeagueData(selected);
        }
      } else {
        // Clear active league if user is in 0 leagues
        setActiveLeagueId(null);
        localStorage.removeItem('pwhl_active_league');
        setActiveLeagueName('Select League');
        setActiveLeagueData(null);
      }
    } catch (err) {
      console.error("Error loading leagues:", err);
      if (err.message && err.message.includes("timed out")) {
        alert(err.message);
      }
    } finally {
      setLoadingLeagues(false);
    }
  };

  // Sync state to URL changes
  useEffect(() => {
    if (!currentUser) {
      if (window.location.pathname !== '/') {
        window.history.replaceState(null, '', '/');
      }
      return;
    }
    updateUrl(isAdminView, currentTab, activeLeagueId);
  }, [isAdminView, currentTab, activeLeagueId, currentUser]);

  // Handle URL path parsing on initial load and when dependencies change
  useEffect(() => {
    if (currentUser) {
      parsePathAndSetState(window.location.pathname);
    }
  }, [currentUser, activeLeagueId, isAdmin]);

  // Listen for browser back/forward buttons (popstate)
  useEffect(() => {
    const handlePopState = () => {
      parsePathAndSetState(window.location.pathname);
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [activeLeagueId, isAdmin, currentTab]);

  // Sync activeLeagueId to Time Travel Context
  useEffect(() => {
    if (setTimeTravelLeagueId) {
      setTimeTravelLeagueId(activeLeagueId);
    }
  }, [activeLeagueId, setTimeTravelLeagueId]);

  useEffect(() => {
    fetchUserLeagues();
  }, [currentUser, activeLeagueId]);

  const handleSetActiveLeague = async (id, name) => {
    setActiveLeagueId(id);
    // Sync per-league simulation context
    if (setTimeTravelLeagueId) setTimeTravelLeagueId(id);
    if (id) {
      localStorage.setItem('pwhl_active_league', id);
      setActiveLeagueName(name);
      try {
        const lSnap = await withTimeout(getDoc(doc(db, 'fantasy_leagues', id)), 5000);
        if (lSnap.exists()) {
          setActiveLeagueData(lSnap.data());
        }
      } catch (e) {
        console.error(e);
        if (e.message && e.message.includes("timed out")) {
          alert(e.message);
        }
      }
    } else {
      localStorage.removeItem('pwhl_active_league');
      setActiveLeagueName('Select League');
      setActiveLeagueData(null);
    }
    setIsSwitchMenuOpen(false);
  };

  const handleSignOut = async () => {
    await logout();
    handleSetActiveLeague(null, '');
    setIsAccountMenuOpen(false);
  };

  // Handler for clicking the brand/home link
  const handleNavHome = () => {
    setIsAdminView(false);
    if (activeLeagueId) {
      setCurrentTab('matchup');
      updateUrl(false, 'matchup', activeLeagueId);
    } else {
      updateUrl(false, 'matchup', null);
    }
  };

  const isCommissioner = activeLeagueData && currentUser && currentUser.uid === activeLeagueData.ownerId;

  return (
    <div className="min-h-screen bg-[#F8F9FA] text-[#111827] font-sans selection:bg-indigo-500/20">
      
      {(simulationState?.testModeActive || leagueSimState.isSimulation) && (
        <div className="bg-gradient-to-r from-slate-900 via-indigo-950 to-slate-900 text-white border-b border-indigo-900/40 px-4 py-2.5 flex flex-col md:flex-row justify-between items-center gap-3 z-50 shadow-md">
          {/* Left section: status + season */}
          <div className="flex items-center gap-3 flex-wrap justify-center md:justify-start">
            <span className="flex items-center gap-1.5 bg-indigo-500/20 border border-indigo-400/30 text-indigo-300 px-2.5 py-1 rounded-full text-[10px] font-black tracking-wider uppercase animate-pulse">
              <span className="w-1.5 h-1.5 rounded-full bg-indigo-400"></span>
              {leagueSimState.isSimulation ? 'League Simulation' : 'Simulation Active'}
            </span>
            <span className="text-xs font-bold text-slate-300">
              Season: <strong className="text-white font-extrabold">{activeSeasonName}</strong>
            </span>
          </div>

          {/* Middle section: date display */}
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-300">
            <span className="text-base">📅</span>
            <span>
              {getCurrentSimDateStr() ? (
                <>Simulated Date: <strong className="text-amber-400 font-extrabold">{new Date(getCurrentSimDateStr() + 'T08:00:00-08:00').toLocaleDateString(undefined, { dateStyle: 'full' })}</strong></>
              ) : (
                <>Real Date: <strong className="text-emerald-400 font-extrabold">{new Date().toLocaleDateString(undefined, { dateStyle: 'full' })}</strong></>
              )}
            </span>
          </div>

          {/* Right section: actions */}
          <div className="flex items-center gap-2.5">
            <button
              onClick={handleAdvanceDay}
              disabled={isDayAdvancing || isSkippingWeek || isTeardownLoading}
              className="bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-800 text-white text-[10px] font-black uppercase tracking-wider px-3.5 py-1.5 rounded-xl shadow-lg shadow-indigo-600/20 hover:scale-[1.03] active:scale-95 transition-all duration-200 flex items-center gap-1 cursor-pointer disabled:cursor-not-allowed"
            >
              {isDayAdvancing ? 'Advancing...' : '+1 Day ⚡'}
            </button>
            <button
              onClick={handleSkipToEndOfWeek}
              disabled={isDayAdvancing || isSkippingWeek || isTeardownLoading}
              className="bg-violet-600 hover:bg-violet-500 disabled:bg-violet-800 text-white text-[10px] font-black uppercase tracking-wider px-3.5 py-1.5 rounded-xl shadow-lg shadow-violet-600/20 hover:scale-[1.03] active:scale-95 transition-all duration-200 flex items-center gap-1 cursor-pointer disabled:cursor-not-allowed"
            >
              {isSkippingWeek ? 'Skipping...' : 'Skip to Week End ⏭️'}
            </button>
            <button
              onClick={handleDeactivateSimulation}
              disabled={isDayAdvancing || isSkippingWeek || isTeardownLoading}
              className="bg-slate-800 hover:bg-rose-950/80 border border-slate-700 hover:border-rose-800/40 text-slate-300 hover:text-rose-200 disabled:bg-slate-900 disabled:text-slate-600 text-[10px] font-black uppercase tracking-wider px-3.5 py-1.5 rounded-xl hover:scale-[1.03] active:scale-95 transition-all duration-200 flex items-center gap-1 cursor-pointer disabled:cursor-not-allowed"
            >
              {isTeardownLoading ? 'Deactivating...' : 'Deactivate 🚪'}
            </button>
          </div>
        </div>
      )}

      {/* ── 1. STICKY GLOBAL NAVIGATION BAR ── */}
      <nav className="sticky top-0 z-40 bg-white/80 border-b border-gray-200 backdrop-blur-md px-4 py-3.5 flex justify-between items-center select-none shadow-sm shadow-gray-100">
        <div className="flex items-center gap-3">
          <div 
            onClick={handleNavHome}
            className="font-sports text-xl font-bold tracking-tight bg-gradient-to-r from-indigo-600 to-violet-600 bg-clip-text text-transparent cursor-pointer hover:opacity-90 transition-opacity"
          >
            PWHL Fantasy
          </div>

          {/* Active League Switcher Dropdown (Inside active league) */}
          {currentUser && activeLeagueId && (
            <div className="relative">
              <button 
                onClick={() => setIsSwitchMenuOpen(!isSwitchMenuOpen)}
                className="flex items-center gap-1 bg-[#F3F4F6] border border-gray-200 px-2.5 py-1.5 rounded-xl text-xs font-bold text-gray-700 active:scale-95 transition-transform"
              >
                <span className="max-w-[100px] truncate">{activeLeagueName}</span>
                <span className="text-[8px] text-indigo-500">▼</span>
              </button>

              {isSwitchMenuOpen && (
                <div className="absolute left-0 mt-2 w-56 rounded-2xl bg-white border border-gray-200 shadow-2xl p-2 z-50">
                  <div className="text-[9px] font-black text-gray-400 px-3 py-1.5 uppercase tracking-widest border-b border-gray-100 mb-1">Switch Leagues</div>
                  
                  {myLeagues.map(l => (
                    <button
                      key={l.id}
                      onClick={() => handleSetActiveLeague(l.id, l.name)}
                      className={`w-full text-left px-3 py-2 text-xs font-bold rounded-xl transition-colors truncate flex items-center justify-between ${activeLeagueId === l.id ? 'bg-indigo-50 text-indigo-600' : 'text-gray-600 hover:bg-gray-50'}`}
                    >
                      <span className="truncate">{l.name}</span>
                      {activeLeagueId === l.id && <span className="text-[10px] text-indigo-600">✓</span>}
                    </button>
                  ))}

                  <div className="border-t border-gray-100 my-1.5"></div>
                  
                  <button 
                    onClick={() => { setShowCreateModal(true); setIsSwitchMenuOpen(false); }}
                    className="w-full text-left px-3 py-2 text-xs font-bold text-indigo-600 hover:bg-indigo-50 rounded-xl transition-colors"
                  >
                    ➕ Create New League
                  </button>
                  <button 
                    onClick={() => { setShowJoinModal(true); setIsSwitchMenuOpen(false); }}
                    className="w-full text-left px-3 py-2 text-xs font-bold text-indigo-600 hover:bg-indigo-50 rounded-xl transition-colors"
                  >
                    🚪 Join Another League
                  </button>
                  
                  <div className="border-t border-gray-100 my-1.5"></div>
                  
                  <button 
                    onClick={() => handleSetActiveLeague(null, '')}
                    className="w-full text-left px-3 py-2 text-xs font-bold text-gray-500 hover:bg-gray-50 rounded-xl transition-colors"
                  >
                    🏠 League Selector
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right Account Operations */}
        <div className="flex items-center gap-3">
          {currentUser ? (
            <div className="relative">
              <button 
                onClick={() => setIsAccountMenuOpen(!isAccountMenuOpen)}
                className="w-8 h-8 rounded-full bg-indigo-50 border border-indigo-100 flex items-center justify-center font-black text-xs text-indigo-600 shadow-sm active:scale-95 transition-transform"
              >
                {currentUser.email ? currentUser.email.charAt(0).toUpperCase() : "U"}
              </button>

              {isAccountMenuOpen && (
                <div className="absolute right-0 mt-2 w-48 rounded-2xl bg-white border border-gray-200 shadow-2xl p-2 z-50">
                  <div className="px-3 py-2 text-[10px] text-gray-400 truncate border-b border-gray-100 mb-1.5">
                    Signed in as<br/><strong className="text-gray-700 font-bold text-xs truncate block">{currentUser.email}</strong>
                  </div>
                  
                  {isAdmin && (
                    <button 
                      onClick={() => { setIsAdminView(!isAdminView); setIsAccountMenuOpen(false); }}
                      className={`w-full text-left px-3 py-2 text-xs font-bold rounded-xl transition-colors ${isAdminView ? 'bg-purple-600 text-white' : 'text-purple-600 hover:bg-purple-50'}`}
                    >
                      🛡️ Admin Console
                    </button>
                  )}

                  <button 
                    onClick={handleSignOut}
                    className="w-full text-left px-3 py-2 text-xs font-bold text-rose-500 hover:bg-rose-50 rounded-xl transition-colors mt-1"
                  >
                    🚪 Sign Out
                  </button>
                </div>
              )}
            </div>
          ) : (
            <button 
              onClick={() => { setAuthModalMode('login'); setIsAuthModalOpen(true); }}
              className="bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-xl text-xs font-bold uppercase tracking-wider shadow-md active:scale-95 transition-transform"
            >
              Log-in
            </button>
          )}
        </div>
      </nav>

      {/* ── SUB-HEADER NAVIGATION BAR (TOP WEB TABS) ── */}
      {currentUser && activeLeagueId && !isAdminView && currentTab !== 'draft_room' && (
        <div className="bg-white border-b border-gray-200 px-4 flex overflow-x-auto scrollbar-none select-none shadow-sm shadow-gray-100/50 justify-center">
          <div className="flex gap-2 max-w-sm sm:max-w-none">
            {[
              { key: 'matchup', label: '📊 Matchup' },
              { key: 'roster', label: '⛸️ Roster' },
              { key: 'players', label: '🔍 Players' },
              { key: 'standings', label: '🏆 Standings' },
              { key: 'settings', label: '⚙️ Settings' },
              ...(isCommissioner ? [{ key: 'manager', label: '🛡️ LM Toolset' }] : [])
            ].map(tab => (
              <button
                key={tab.key}
                onClick={() => setCurrentTab(tab.key)}
                className={`py-3.5 px-4 text-xs font-black uppercase tracking-wider border-b-2 transition-all duration-200 flex items-center gap-2 ${currentTab === tab.key ? 'border-indigo-600 text-indigo-600 font-extrabold' : 'border-transparent text-gray-400 hover:text-gray-600 hover:border-gray-200'}`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── 2. STAGE 1: MINIMALIST SPORTS LANDING PAGE (NOT LOGGED IN) ── */}
      {!currentUser && (
        <div className="px-4 py-12 max-w-6xl mx-auto min-h-[80vh] flex flex-col lg:flex-row items-center gap-12 justify-center select-none">
          {/* Left Column: Brand & Hero Header */}
          <div className="flex-1 text-center lg:text-left max-w-md">
            <h1 className="font-sports text-6xl lg:text-7xl font-black tracking-tight leading-none bg-gradient-to-r from-gray-900 to-gray-700 bg-clip-text text-transparent mb-6">
              PWHL FANTASY
            </h1>
            <p className="text-sm text-gray-500 font-semibold leading-relaxed mb-8">
              Experience the inaugural PWHL season! Draft your ultimate team of star athletes, manage live weekly matchups, and lead your franchise to the championship.
            </p>
            <div className="space-y-3.5 sm:space-y-0 sm:flex sm:gap-4 max-w-xs sm:max-w-none mx-auto lg:mx-0">
              <button
                onClick={() => { setAuthModalMode('login'); setIsAuthModalOpen(true); }}
                className="w-full sm:w-auto px-8 py-4.5 bg-gradient-to-r from-indigo-600 to-violet-600 text-white text-xs font-black uppercase tracking-wider rounded-2xl shadow-xl shadow-indigo-600/10 active:scale-95 transition-transform"
              >
                Log-in
              </button>
              <button
                onClick={() => { setAuthModalMode('signup'); setIsAuthModalOpen(true); }}
                className="w-full sm:w-auto px-8 py-4.5 bg-white border border-gray-200 rounded-2xl text-xs font-black uppercase text-gray-700 tracking-wider hover:bg-gray-50 active:scale-95 transition-transform"
              >
                Create Account
              </button>
            </div>
          </div>
          
          {/* Right Column: Styled Graphic preview */}
          <div className="flex-1 w-full max-w-lg rounded-[40px] overflow-hidden border border-gray-200 bg-white shadow-2xl relative aspect-[4/3] flex items-center justify-center">
            <div className="absolute inset-0 bg-gradient-to-tr from-indigo-500/10 via-[#F8F9FA] to-emerald-500/10"></div>
            <div className="absolute inset-0 opacity-[0.03] bg-[radial-gradient(#6C5CE7_1px,transparent_1px)] [background-size:16px_16px]"></div>
            
            <div className="relative text-center p-8 z-10 flex flex-col items-center">
              <div className="flex -space-x-4 mb-6">
                <div className="w-20 h-20 rounded-full bg-gradient-to-tr from-indigo-600 to-violet-500 border-4 border-white flex items-center justify-center text-3xl shadow-lg font-black text-white">💜</div>
                <div className="w-20 h-20 rounded-full bg-gradient-to-tr from-emerald-500 to-teal-500 border-4 border-white flex items-center justify-center text-3xl shadow-lg font-black text-white">🏆</div>
                <div className="w-20 h-20 rounded-full bg-gradient-to-tr from-indigo-700 to-pink-500 border-4 border-white flex items-center justify-center text-3xl shadow-lg font-black text-white">⚡</div>
              </div>
              <span className="text-[11px] uppercase font-black tracking-widest text-indigo-600 bg-indigo-50 px-4 py-2 rounded-full border border-indigo-100 shadow-sm">
                Inaugural PWHL Season
              </span>
              <p className="text-[10px] text-gray-400 font-bold uppercase tracking-widest mt-4">Draft Star Athletes • Compete Weekly • Claim the Cup</p>
            </div>
          </div>
        </div>
      )}

      {/* ── 3. STAGE 2: ADMIN PANEL OVERRIDE ── */}
      {currentUser && isAdminView && <AdminPanel />}

      {/* ── 4. STAGE 3: LOGGED IN - NO LEAGUES ONBOARDING ── */}
      {currentUser && !isAdminView && !activeLeagueId && (
        <div className="px-4 py-12 max-w-4xl mx-auto min-h-[85vh] flex flex-col justify-center select-none">
          {loadingLeagues ? (
            <div className="py-20 text-center text-gray-400 text-xs font-black tracking-widest animate-pulse">Establishing arena...</div>
          ) : (
            <div className="space-y-10">
              <header className="text-center mb-4 max-w-md mx-auto">
                <h2 className="font-sports text-5xl font-black text-gray-900 leading-tight">Welcome to the Arena</h2>
                <p className="text-xs text-gray-400 font-semibold mt-2">Get started by creating a league to act as commissioner or join a friend's active draft lobby.</p>
              </header>

              {/* Grid Layout: Side-by-Side on wide screens */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                {/* Card 1: Start a League */}
                <div className="bg-white border border-gray-200 p-8 rounded-[36px] shadow-sm text-center flex flex-col justify-between">
                  <div>
                    <div className="w-16 h-16 rounded-2xl bg-indigo-50 border border-indigo-100 flex items-center justify-center text-3xl mx-auto mb-5 font-black text-indigo-600">
                      🏆
                    </div>
                    <h3 className="text-lg font-black text-gray-800 leading-tight">Start a League</h3>
                    <p className="text-xs text-gray-400 mt-2 max-w-[240px] mx-auto font-medium">Become commissioner, define custom rules, and draft roster sheets.</p>
                  </div>
                  <button 
                    onClick={() => setShowCreateModal(true)}
                    className="w-full py-4 bg-gradient-to-r from-indigo-600 to-violet-600 rounded-2xl text-[10px] font-black uppercase text-white tracking-wider active:scale-95 transition-transform mt-8 shadow-md shadow-indigo-600/10"
                  >
                    Create New League
                  </button>
                </div>

                {/* Card 2: Join a League */}
                <div className="bg-white border border-gray-200 p-8 rounded-[36px] shadow-sm text-center flex flex-col justify-between">
                  <div>
                    <div className="w-16 h-16 rounded-2xl bg-emerald-50 border border-emerald-100 flex items-center justify-center text-3xl mx-auto mb-5 font-black text-emerald-600">
                      🎟️
                    </div>
                    <h3 className="text-lg font-black text-gray-800 leading-tight">Join a League</h3>
                    <p className="text-xs text-gray-400 mt-2 max-w-[240px] mx-auto font-medium">Enter an invite code to join a friend's active recruitment lobby.</p>
                  </div>
                  <button 
                    onClick={() => setShowJoinModal(true)}
                    className="w-full py-4 bg-emerald-600 hover:bg-emerald-500 rounded-2xl text-[10px] font-black uppercase text-white tracking-wider active:scale-95 transition-transform mt-8 shadow-md shadow-emerald-600/10"
                  >
                    Join Existing League
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── 5. STAGE 4: SELECTED LEAGUE ACTIVE VIEW & TAB CONTROLS ── */}
      {currentUser && !isAdminView && activeLeagueId && (
        <main className="max-w-6xl mx-auto px-4 py-8">
          
          {/* Tab Routing */}
          {currentTab === 'matchup' && <Matchup activeLeagueId={activeLeagueId} setCurrentTab={setCurrentTab} />}
          {currentTab === 'roster' && <Roster activeLeagueId={activeLeagueId} />}
          {currentTab === 'players' && <Players activeLeagueId={activeLeagueId} />}
          {currentTab === 'standings' && <League activeLeagueId={activeLeagueId} initialTab="standings" setActiveLeagueId={handleSetActiveLeague} />}
          {currentTab === 'settings' && <League activeLeagueId={activeLeagueId} initialTab="schedule" setActiveLeagueId={handleSetActiveLeague} />}
          {currentTab === 'manager' && isCommissioner && <League activeLeagueId={activeLeagueId} initialTab="manager" setActiveLeagueId={handleSetActiveLeague} />}
          {currentTab === 'draft_room' && <DraftRoom activeLeagueId={activeLeagueId} setCurrentTab={setCurrentTab} />}

          {/* Bottom nav bar removed for web-first top navigation styling */}
        </main>
      )}

      {/* ── 6. FLOATING MODAL OVERLAYS (CREATE / JOIN LOBBIES) ── */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4 z-50 overflow-y-auto">
          <div className="w-full max-w-sm my-8 animate-scale-up">
            <div className="bg-white border border-gray-200 rounded-[32px] p-6 relative shadow-2xl">
              <button 
                onClick={() => setShowCreateModal(false)}
                className="absolute top-4 right-4 text-gray-400 text-lg hover:text-gray-700 transition-colors"
              >
                &times;
              </button>
              <LeagueHub activeLeagueId={null} setActiveLeagueId={handleSetActiveLeague} />
            </div>
          </div>
        </div>
      )}

      {showJoinModal && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="w-full max-w-sm animate-scale-up">
            <div className="bg-white border border-gray-200 rounded-[32px] p-6 relative shadow-2xl">
              <button 
                onClick={() => setShowJoinModal(false)}
                className="absolute top-4 right-4 text-gray-400 text-lg hover:text-gray-700 transition-colors"
              >
                &times;
              </button>
              <LeagueHub activeLeagueId={null} setActiveLeagueId={handleSetActiveLeague} />
            </div>
          </div>
        </div>
      )}

      {/* Authentication Dialog */}
      <AuthModal 
        isOpen={isAuthModalOpen} 
        onClose={() => { setIsAuthModalOpen(false); fetchUserLeagues(); }} 
      />
    </div>
  );
}

export default App;
