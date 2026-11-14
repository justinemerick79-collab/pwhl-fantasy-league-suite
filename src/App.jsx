import React, { useState, useEffect } from 'react';
import { 
  Trophy, Users, Calendar, Zap, RotateCw, LogOut, Shield, Activity, 
  ChevronDown, User, Check, Copy, Plus, Ticket, Play, ArrowRight, Search, SlidersHorizontal, Layers, Home, Settings
} from 'lucide-react';
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
  const [isSyncingStats, setIsSyncingStats] = useState(false);

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

  const handleTriggerSimulationDailySync = async () => {
    setIsSyncingStats(true);
    try {
      const triggerFn = httpsCallable(functions, 'triggerSimulationDailySync');
      const res = await triggerFn({ leagueId: activeLeagueId });
      if (res.data?.success) {
        alert(`Successfully sync'd game stats for date: ${res.data.dateStr}`);
        window.location.reload();
      } else {
        throw new Error(res.data?.error || "Unknown error during daily sync.");
      }
    } catch (err) {
      console.error("Simulation sync failed:", err);
      alert("Simulation Sync Failed:\n" + err.message);
    } finally {
      setIsSyncingStats(false);
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
      const validTabs = ['matchup', 'roster', 'players', 'standings', 'transactions', 'settings', 'manager'];
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
    <div className="min-h-screen text-slate-800 font-sans" style={{ backgroundColor: '#FAFAF8' }}>
      
      {(simulationState?.testModeActive || leagueSimState.isSimulation) && (
        <div className="border-b px-4 py-2 flex flex-col md:flex-row justify-between items-center gap-3 z-50" style={{ backgroundColor: '#F5F5F3', borderColor: '#E5E5E3' }}>
          <div className="flex items-center gap-3 flex-wrap justify-center md:justify-start">
            <span className="flex items-center gap-1.5 text-[10px] font-bold tracking-wider uppercase text-slate-600">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse"></span>
              {leagueSimState.isSimulation ? 'League Simulation' : 'Simulation Active'}
            </span>
            <span className="text-xs font-medium text-slate-500">
              Season: <strong className="text-slate-800">{activeSeasonName}</strong>
            </span>
          </div>
          <div className="flex items-center gap-2 text-xs font-medium text-slate-500">
            <Calendar className="w-3.5 h-3.5 text-slate-400" />
            <span>
              {getCurrentSimDateStr() ? (
                <>Simulated: <strong className="text-slate-800">{new Date(getCurrentSimDateStr() + 'T08:00:00-08:00').toLocaleDateString(undefined, { dateStyle: 'full' })}</strong></>
              ) : (
                <>Today: <strong className="text-slate-800">{new Date().toLocaleDateString(undefined, { dateStyle: 'full' })}</strong></>
              )}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={handleAdvanceDay} disabled={isDayAdvancing || isSkippingWeek || isTeardownLoading}
              className="bg-slate-700 hover:bg-slate-600 disabled:bg-slate-300 text-white text-[10px] font-semibold uppercase tracking-wider px-3 py-1.5 rounded-lg active:scale-95 transition-all flex items-center gap-1.5 cursor-pointer disabled:cursor-not-allowed">
              <Zap className="w-3 h-3" /> {isDayAdvancing ? 'Advancing...' : '+1 Day'}
            </button>
            <button onClick={handleSkipToEndOfWeek} disabled={isDayAdvancing || isSkippingWeek || isTeardownLoading}
              className="bg-slate-700 hover:bg-slate-600 disabled:bg-slate-300 text-white text-[10px] font-semibold uppercase tracking-wider px-3 py-1.5 rounded-lg active:scale-95 transition-all flex items-center gap-1.5 cursor-pointer disabled:cursor-not-allowed">
              <Play className="w-3 h-3" /> {isSkippingWeek ? 'Skipping...' : 'Skip to Week End'}
            </button>
            <button onClick={handleTriggerSimulationDailySync} disabled={isDayAdvancing || isSkippingWeek || isTeardownLoading || isSyncingStats}
              className="bg-emerald-700 hover:bg-emerald-600 disabled:bg-slate-300 text-white text-[10px] font-semibold uppercase tracking-wider px-3 py-1.5 rounded-lg active:scale-95 transition-all flex items-center gap-1.5 cursor-pointer disabled:cursor-not-allowed">
              <RotateCw className={`w-3 h-3 ${isSyncingStats ? 'animate-spin' : ''}`} /> {isSyncingStats ? 'Syncing...' : 'Sync Stats'}
            </button>
            <button onClick={handleDeactivateSimulation} disabled={isDayAdvancing || isSkippingWeek || isTeardownLoading}
              className="bg-white hover:bg-red-50 border text-slate-600 hover:text-red-600 disabled:bg-slate-100 disabled:text-slate-400 text-[10px] font-semibold uppercase tracking-wider px-3 py-1.5 rounded-lg active:scale-95 transition-all flex items-center gap-1.5 cursor-pointer disabled:cursor-not-allowed" style={{ borderColor: '#E5E5E3' }}>
              <LogOut className="w-3 h-3" /> {isTeardownLoading ? 'Deactivating...' : 'Deactivate'}
            </button>
          </div>
        </div>
      )}

      {/* ── 1. GLOBAL NAVIGATION HEADER ── */}
      <nav className="bg-white border-b px-6 py-3 flex justify-between items-center z-40 select-none" style={{ borderColor: '#E5E5E3' }}>
        {/* Left Branding & League Selector */}
        <div className="flex items-center gap-4">
          <div 
            onClick={handleNavHome}
            className="flex items-center gap-2.5 cursor-pointer group"
          >
            <div className="w-8 h-8 rounded-lg flex items-center justify-center font-sports font-black text-white text-sm transition-all" style={{ backgroundColor: '#4A5568' }}>
              PW
            </div>
            <div>
              <span className="font-sports font-bold text-sm tracking-tight text-slate-800 block leading-none">
                PWHL Fantasy
              </span>
              <span className="text-[9px] uppercase font-semibold tracking-widest text-slate-400 block mt-0.5">
                League Suite
              </span>
            </div>
          </div>

          {/* Active League Dropdown Selector */}
          {currentUser && activeLeagueId && (
            <div className="relative">
              <button 
                onClick={() => setIsSwitchMenuOpen(!isSwitchMenuOpen)}
                className="flex items-center gap-2 bg-white hover:bg-gray-50 border px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-600 transition-all cursor-pointer" style={{ borderColor: '#E5E5E3' }}
              >
                <span className="max-w-[160px] truncate">{activeLeagueName}</span>
                <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
              </button>

              {isSwitchMenuOpen && (
                <div className="absolute left-0 mt-1.5 w-60 rounded-xl bg-white border shadow-lg p-1.5 z-50 animate-scale-up" style={{ borderColor: '#E5E5E3' }}>
                  <div className="px-3 py-1.5 text-[9px] font-semibold uppercase tracking-wider text-slate-400 border-b mb-1" style={{ borderColor: '#F0F0EE' }}>My Leagues</div>
                  {myLeagues.map(l => (
                    <button
                      key={l.id}
                      onClick={() => handleSetActiveLeague(l.id, l.name)}
                      className={`w-full text-left px-3 py-2 text-xs font-medium rounded-lg transition-colors flex items-center justify-between cursor-pointer ${activeLeagueId === l.id ? 'bg-slate-100 text-slate-800 font-semibold' : 'text-slate-600 hover:bg-slate-50'}`}
                    >
                      <span className="truncate">{l.name}</span>
                      {activeLeagueId === l.id && <Check className="w-3.5 h-3.5 text-slate-500" />}
                    </button>
                  ))}

                  <div className="border-t my-1" style={{ borderColor: '#F0F0EE' }}></div>
                  
                  <button 
                    onClick={() => { setShowCreateModal(true); setIsSwitchMenuOpen(false); }}
                    className="w-full text-left px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 rounded-lg transition-colors flex items-center gap-2 cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5 text-slate-400" /> Create New League
                  </button>
                  <button 
                    onClick={() => { setShowJoinModal(true); setIsSwitchMenuOpen(false); }}
                    className="w-full text-left px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 rounded-lg transition-colors flex items-center gap-2 cursor-pointer"
                  >
                    <Ticket className="w-3.5 h-3.5 text-slate-400" /> Join Another League
                  </button>
                  
                  <div className="border-t my-1" style={{ borderColor: '#F0F0EE' }}></div>
                  
                  <button 
                    onClick={() => handleSetActiveLeague(null, '')}
                    className="w-full text-left px-3 py-2 text-xs font-medium text-slate-500 hover:bg-slate-50 rounded-lg transition-colors flex items-center gap-2 cursor-pointer"
                  >
                    <Home className="w-3.5 h-3.5 text-slate-400" /> League Selector
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right Account Operations */}
        <div className="flex items-center gap-2">
          {currentUser && activeLeagueId && (
            <button 
              onClick={() => setCurrentTab('settings')}
              className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors cursor-pointer ${currentTab === 'settings' || currentTab === 'manager' ? 'bg-slate-200 text-slate-700' : 'hover:bg-slate-100 text-slate-400'}`}
              title="League Settings"
            >
              <Settings className="w-4 h-4" />
            </button>
          )}
          {currentUser ? (
            <div className="relative">
              <button 
                onClick={() => setIsAccountMenuOpen(!isAccountMenuOpen)}
                className="w-8 h-8 rounded-lg bg-slate-100 border flex items-center justify-center font-semibold text-xs text-slate-600 active:scale-95 transition-transform cursor-pointer" style={{ borderColor: '#E5E5E3' }}
              >
                {currentUser.email ? currentUser.email.charAt(0).toUpperCase() : "U"}
              </button>

              {isAccountMenuOpen && (
                <div className="absolute right-0 mt-1.5 w-52 rounded-xl bg-white border shadow-lg p-1.5 z-50" style={{ borderColor: '#E5E5E3' }}>
                  <div className="px-3 py-2 text-[10px] text-slate-400 truncate border-b mb-1" style={{ borderColor: '#F0F0EE' }}>
                    Signed in as<br/><strong className="text-slate-700 font-semibold text-xs truncate block">{currentUser.email}</strong>
                  </div>
                  
                  {isAdmin && (
                    <button 
                      onClick={() => { setIsAdminView(!isAdminView); setIsAccountMenuOpen(false); }}
                      className={`w-full text-left px-3 py-2 text-xs font-medium rounded-lg transition-colors flex items-center gap-2 cursor-pointer ${isAdminView ? 'bg-slate-700 text-white' : 'text-slate-600 hover:bg-slate-50'}`}
                    >
                      <Shield className="w-3.5 h-3.5" /> Admin Console
                    </button>
                  )}

                  <button 
                    onClick={handleSignOut}
                    className="w-full text-left px-3 py-2 text-xs font-medium text-red-600 hover:bg-red-50 rounded-lg transition-colors mt-0.5 flex items-center gap-2 cursor-pointer"
                  >
                    <LogOut className="w-3.5 h-3.5" /> Sign Out
                  </button>
                </div>
              )}
            </div>
          ) : (
            <button 
              onClick={() => { setAuthModalMode('login'); setIsAuthModalOpen(true); }}
              className="text-white px-4 py-2 rounded-lg text-xs font-semibold active:scale-95 transition-transform cursor-pointer" style={{ backgroundColor: '#4A5568' }}
            >
              Log in
            </button>
          )}
        </div>
      </nav>

      {/* ── SUB-HEADER NAVIGATION BAR (5 CORE TABS) ── */}
      {currentUser && activeLeagueId && !isAdminView && currentTab !== 'draft_room' && currentTab !== 'settings' && currentTab !== 'manager' && (
        <div className="bg-white border-b px-4 flex overflow-x-auto scrollbar-none select-none justify-center" style={{ borderColor: '#E5E5E3' }}>
          <div className="flex gap-0">
            {[
              { key: 'matchup', label: 'Matchup' },
              { key: 'roster', label: 'Roster' },
              { key: 'players', label: 'Players' },
              { key: 'standings', label: 'Standings' },
              { key: 'transactions', label: 'Transactions' },
            ].map(tab => {
              const isActive = currentTab === tab.key;
              return (
                <button
                  key={tab.key}
                  onClick={() => setCurrentTab(tab.key)}
                  className={`py-3 px-5 text-xs font-semibold tracking-wide border-b-2 transition-all duration-150 cursor-pointer ${isActive ? 'text-slate-800 font-bold' : 'border-transparent text-slate-400 hover:text-slate-600'}`}
                  style={isActive ? { borderColor: '#4A5568' } : {}}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* ── 2. STAGE 1: LANDING PAGE (NOT LOGGED IN) ── */}
      {!currentUser && (
        <div className="max-w-3xl mx-auto px-6 py-20 animate-fade-in">
          <div className="text-center max-w-xl mx-auto">
            <p className="text-[11px] uppercase font-semibold tracking-widest text-slate-400 mb-3">
              Professional Fantasy Sports Platform
            </p>
            <h1 className="font-sports text-4xl sm:text-5xl font-extrabold text-slate-800 tracking-tight leading-tight">
              PWHL Fantasy League Suite
            </h1>
            <p className="text-sm text-slate-500 mt-4 font-medium leading-relaxed max-w-md mx-auto">
              The premier fantasy hockey platform for the Professional Women's Hockey League. Draft rosters, manage daily lineups, and compete head-to-head.
            </p>
            <div className="mt-10 flex gap-3 justify-center">
              <button
                onClick={() => { setAuthModalMode('login'); setIsAuthModalOpen(true); }}
                className="px-6 py-3 text-white text-xs font-semibold rounded-lg active:scale-95 transition-all cursor-pointer" style={{ backgroundColor: '#4A5568' }}
              >
                Log in
              </button>
              <button
                onClick={() => { setAuthModalMode('signup'); setIsAuthModalOpen(true); }}
                className="px-6 py-3 bg-white border text-xs font-semibold text-slate-600 active:scale-95 transition-all cursor-pointer rounded-lg" style={{ borderColor: '#E5E5E3' }}
              >
                Create Account
              </button>
            </div>
          </div>
          
          <div className="mt-16 flex justify-center gap-12 text-center">
            <div>
              <Activity className="w-6 h-6 text-slate-400 mx-auto mb-2" />
              <p className="text-xs font-semibold text-slate-600">Live Matchups</p>
              <p className="text-[11px] text-slate-400 mt-0.5">Head-to-head weekly</p>
            </div>
            <div>
              <Trophy className="w-6 h-6 text-slate-400 mx-auto mb-2" />
              <p className="text-xs font-semibold text-slate-600">League Standings</p>
              <p className="text-[11px] text-slate-400 mt-0.5">Playoff bracket system</p>
            </div>
            <div>
              <Users className="w-6 h-6 text-slate-400 mx-auto mb-2" />
              <p className="text-xs font-semibold text-slate-600">Player Scouting</p>
              <p className="text-[11px] text-slate-400 mt-0.5">Full PWHL stat database</p>
            </div>
          </div>
        </div>
      )}

      {/* ── 3. STAGE 2: ADMIN PANEL OVERRIDE ── */}
      {currentUser && isAdminView && <AdminPanel />}

      {/* ── 4. STAGE 3: LOGGED IN - NO LEAGUES ONBOARDING ── */}
      {currentUser && !isAdminView && !activeLeagueId && (
        <div className="px-4 py-16 max-w-3xl mx-auto min-h-[80vh] flex flex-col justify-center select-none">
          {loadingLeagues ? (
            <div className="py-20 text-center text-slate-400 text-xs font-medium tracking-wider animate-pulse">Loading leagues...</div>
          ) : (
            <div className="space-y-10">
              <header className="text-center mb-4 max-w-md mx-auto">
                <h2 className="font-sports text-3xl font-extrabold text-slate-800 leading-tight">Get Started</h2>
                <p className="text-sm text-slate-500 font-medium mt-2">Create a league as commissioner or join an existing one with an invite code.</p>
              </header>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="bg-white border p-8 rounded-xl text-center flex flex-col justify-between hover:border-slate-300 transition-colors" style={{ borderColor: '#E5E5E3' }}>
                  <div>
                    <Trophy className="w-7 h-7 text-slate-400 mx-auto mb-4" />
                    <h3 className="text-base font-bold text-slate-800">Start a League</h3>
                    <p className="text-xs text-slate-500 mt-2 max-w-[240px] mx-auto">Define custom rules, configure scoring, and draft rosters.</p>
                  </div>
                  <button 
                    onClick={() => setShowCreateModal(true)}
                    className="w-full py-3 rounded-lg text-xs font-semibold text-white active:scale-95 transition-transform mt-8 cursor-pointer" style={{ backgroundColor: '#4A5568' }}
                  >
                    Create New League
                  </button>
                </div>

                <div className="bg-white border p-8 rounded-xl text-center flex flex-col justify-between hover:border-slate-300 transition-colors" style={{ borderColor: '#E5E5E3' }}>
                  <div>
                    <Ticket className="w-7 h-7 text-slate-400 mx-auto mb-4" />
                    <h3 className="text-base font-bold text-slate-800">Join a League</h3>
                    <p className="text-xs text-slate-500 mt-2 max-w-[240px] mx-auto">Enter an invite code to join an active recruitment lobby.</p>
                  </div>
                  <button 
                    onClick={() => setShowJoinModal(true)}
                    className="w-full py-3 bg-white border rounded-lg text-xs font-semibold text-slate-600 active:scale-95 transition-transform mt-8 cursor-pointer" style={{ borderColor: '#E5E5E3' }}
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
          {currentTab === 'players' && (
            <Players 
              activeLeagueId={activeLeagueId} 
              onProposeTrade={(targetPlayer) => {
                setCurrentTab('transactions');
              }} 
            />
          )}
          {currentTab === 'standings' && <League activeLeagueId={activeLeagueId} initialTab="standings" setActiveLeagueId={handleSetActiveLeague} />}
          {currentTab === 'transactions' && <League activeLeagueId={activeLeagueId} initialTab="transactions" setActiveLeagueId={handleSetActiveLeague} />}
          {currentTab === 'settings' && <League activeLeagueId={activeLeagueId} initialTab="schedule" setActiveLeagueId={handleSetActiveLeague} />}
          {currentTab === 'manager' && isCommissioner && <League activeLeagueId={activeLeagueId} initialTab="manager" setActiveLeagueId={handleSetActiveLeague} />}
          {currentTab === 'draft_room' && <DraftRoom activeLeagueId={activeLeagueId} setCurrentTab={setCurrentTab} />}

          {/* Bottom nav bar removed for web-first top navigation styling */}
        </main>
      )}

      {/* ── 6. FLOATING MODAL OVERLAYS (CREATE / JOIN LOBBIES) ── */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center p-4 z-50 overflow-y-auto">
          <div className="w-full max-w-sm my-8 animate-scale-up">
            <div className="bg-white border rounded-2xl p-6 relative shadow-xl" style={{ borderColor: '#E5E5E3' }}>
              <button 
                onClick={() => setShowCreateModal(false)}
                className="absolute top-4 right-4 text-slate-400 text-lg hover:text-slate-600 transition-colors cursor-pointer"
              >
                &times;
              </button>
              <LeagueHub activeLeagueId={null} setActiveLeagueId={handleSetActiveLeague} />
            </div>
          </div>
        </div>
      )}

      {showJoinModal && (
        <div className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="w-full max-w-sm animate-scale-up">
            <div className="bg-white border rounded-2xl p-6 relative shadow-xl" style={{ borderColor: '#E5E5E3' }}>
              <button 
                onClick={() => setShowJoinModal(false)}
                className="absolute top-4 right-4 text-slate-400 text-lg hover:text-slate-600 transition-colors cursor-pointer"
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
