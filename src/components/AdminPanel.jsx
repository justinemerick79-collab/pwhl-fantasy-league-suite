import React, { useState, useEffect } from 'react';
import { db, functions } from '../firebase';
import { collection, getDocs, doc, updateDoc, onSnapshot, setDoc } from 'firebase/firestore';
import { runFullSync, autoGenerateMissingWeeks } from '../services/pwhlService';
import DataHub from './DataHub';
import { useTimeTravel } from '../contexts/TimeTravelContext';
import { httpsCallable } from 'firebase/functions';



export default function AdminPanel() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  
  const [syncLog, setSyncLog] = useState('');
  const [isSyncing, setIsSyncing] = useState(false);
  
  const [seasons, setSeasons] = useState([]);
  const [syncTargetSeason, setSyncTargetSeason] = useState('all');

  const [isSimulating, setIsSimulating] = useState(false);
  const [simLog, setSimLog] = useState('');

  const [simulationState, setSimulationState] = useState({
    testModeActive: false,
    current_simulated_date: '',
    active_test_league_id: ''
  });
  const [jumpDate, setJumpDate] = useState('');
  const [isUpdatingDate, setIsUpdatingDate] = useState(false);

  const { activeSeasonId } = useTimeTravel();
  const [localActiveSeasonId, setLocalActiveSeasonId] = useState('5');
  const [isApplyingSeason, setIsApplyingSeason] = useState(false);

  const [projectionsSeasonId, setProjectionsSeasonId] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [projectionsLog, setProjectionsLog] = useState('');

  // Automatically generate missing calendar weeks for existing seasons on mount
  useEffect(() => {
    autoGenerateMissingWeeks().then((count) => {
      if (count > 0) {
        console.log(`[Admin] Automatically generated missing calendar weeks for ${count} seasons.`);
      }
    }).catch(console.error);
  }, []);

  useEffect(() => {
    if (activeSeasonId) {
      setLocalActiveSeasonId(activeSeasonId);
    }
  }, [activeSeasonId]);

  useEffect(() => {
    if (seasons.length > 0 && !projectionsSeasonId) {
      setProjectionsSeasonId(String(seasons[0].season_id));
    }
  }, [seasons, projectionsSeasonId]);

  const handleApplyActiveSeason = async () => {
    setIsApplyingSeason(true);
    try {
      const selected = seasons.find(s => String(s.season_id) === String(localActiveSeasonId));
      const sName = selected ? selected.season_name : `Season ${localActiveSeasonId}`;
      
      await setDoc(doc(db, 'app_settings', 'active_season'), {
        active_season_id: localActiveSeasonId,
        active_season_name: sName
      }, { merge: true });
      
      alert(`App-wide active PWHL season updated to: ${sName}`);
    } catch (err) {
      alert("Failed to update active season: " + err.message);
      console.error("Active Season Save Error:", err);
    } finally {
      setIsApplyingSeason(false);
    }
  };

  useEffect(() => {
    const unsub = onSnapshot(
      doc(db, "admin_settings", "simulation_state"), 
      (docSnap) => {
        if (docSnap.exists()) {
          const data = docSnap.data();
          setSimulationState(data);
          if (data.current_simulated_date) {
            setJumpDate(data.current_simulated_date);
          }
        }
      },
      (err) => {
        console.warn("Time Machine subscription error (doc may not exist or permission denied):", err);
      }
    );
    return () => unsub();
  }, []);

  useEffect(() => {
    // Helper to race getDocs with a timeout to prevent hanging on cached emulator connections
    async function getDocsWithTimeout(colRef, timeoutMs = 5000) {
      return Promise.race([
        getDocs(colRef),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Connection timed out. This often happens if the browser is using a cached connection to a non-running Firestore emulator.")), timeoutMs)
        )
      ]);
    }

    async function fetchUsersAndSeasons() {
      console.log("[AdminPanel] fetchUsersAndSeasons: start");
      try {
        console.log("[AdminPanel] fetchUsersAndSeasons: fetching users...");
        const querySnapshot = await getDocsWithTimeout(collection(db, "users"), 5000);
        console.log("[AdminPanel] fetchUsersAndSeasons: users size =", querySnapshot.size);
        const usersList = querySnapshot.docs.map(doc => ({
          id: doc.id,
          ...doc.data()
        }));
        setUsers(usersList);
        
        // Fetch seasons for the sync dropdown
        console.log("[AdminPanel] fetchUsersAndSeasons: fetching seasons...");
        const seasonsSnap = await getDocsWithTimeout(collection(db, 'pwhl_seasons'), 5000);
        console.log("[AdminPanel] fetchUsersAndSeasons: seasons size =", seasonsSnap.size);
        const seasonList = seasonsSnap.docs.map(d => ({id: d.id, ...d.data()}));
        seasonList.sort((a, b) => new Date(b.start_date) - new Date(a.start_date));
        setSeasons(seasonList);
      } catch (err) {
        console.error("[AdminPanel] fetchUsersAndSeasons error:", err);
        if (err.message && err.message.includes("Connection timed out")) {
          setError('Failed to load Admin Panel: Firestore connection timed out. If you recently started/stopped Firebase emulators, please perform a hard refresh (Cmd+Shift+R or Ctrl+F5) to clear the browser\'s cached connection.');
        } else {
          setError('Failed to fetch data. Ensure you have admin privileges. Error: ' + err.message);
        }
      } finally {
        console.log("[AdminPanel] fetchUsersAndSeasons: finally, setting loading=false");
        setLoading(false);
      }
    }
    fetchUsersAndSeasons();
  }, []);

  async function toggleRole(userId, currentRole) {
    const newRole = currentRole === 'admin' ? 'user' : 'admin';
    try {
      await updateDoc(doc(db, "users", userId), { role: newRole });
      setUsers(users.map(user => 
        user.id === userId ? { ...user, role: newRole } : user
      ));
    } catch (err) {
      alert('Failed to update role. ' + err.message);
    }
  }

  async function handleSync() {
    setIsSyncing(true);
    setSyncLog(`Starting Sync for ${syncTargetSeason === 'all' ? 'All Seasons' : 'Season ' + syncTargetSeason}...`);
    try {
      await runFullSync((msg) => setSyncLog(prev => prev + '\n' + msg), syncTargetSeason);
      alert('PWHL Data Sync Completed Successfully!');
    } catch (err) {
      setSyncLog(prev => prev + '\nError: ' + err.message);
      console.error(err);
    } finally {
      setIsSyncing(false);
    }
  }

  async function handleStartTestSeason() {
    setIsSimulating(true);
    setSimLog('Triggering backend initialization...');
    try {
      const initializeTestEnvironment = httpsCallable(functions, 'initializeTestEnvironment');
      const res = await initializeTestEnvironment();
      
      if (res.data?.success) {
        const newLeagueId = res.data.active_test_league_id;
        setSimLog(`Success! Test League Created: ${newLeagueId}`);
        alert(`Simulation Sandbox Successfully Active!\nLeague: ${res.data.leagueName || "Simulation Test League"}\nID: ${newLeagueId}`);
        
        // Save the new league ID as the active league and refresh the page to auto-load
        localStorage.setItem('pwhl_active_league', newLeagueId);
        window.location.reload();
      } else {
        throw new Error(res.data?.error || 'Failed to initialize test environment.');
      }
    } catch (err) {
      setSimLog(`Error: ${err.message}`);
      alert(`Simulation Mode Initialization Failed:\n${err.message}`);
      console.error("Simulation Initialization Error:", err);
    } finally {
      setIsSimulating(false);
    }
  }

  async function handleJumpToDate() {
    if (!jumpDate) {
      alert("Please select a date first.");
      return;
    }
    setIsUpdatingDate(true);
    try {
      const simStateRef = doc(db, "admin_settings", "simulation_state");
      await setDoc(simStateRef, {
        testModeActive: true,
        current_simulated_date: jumpDate
      }, { merge: true });
      alert(`Central system clock warped to: ${jumpDate}`);
    } catch (err) {
      alert("Failed to warp central system clock: " + err.message);
      console.error(err);
    } finally {
      setIsUpdatingDate(false);
    }
  }

  const handleGenerateProjections = async () => {
    if (!projectionsSeasonId) {
      alert("Please select a season first.");
      return;
    }
    setIsProcessing(true);
    setProjectionsLog('Calling projections engine on the cloud...');
    try {
      const generateSeasonProjectionsFunc = httpsCallable(functions, 'generateSeasonProjections');
      const res = await generateSeasonProjectionsFunc({ seasonId: projectionsSeasonId });
      
      if (res.data?.success) {
        const { processedCount, baselines } = res.data;
        const successMsg = `Successfully processed ${processedCount} players!\nBaselines - F: ${baselines.forward}, D: ${baselines.defense}, G: ${baselines.goalie}`;
        setProjectionsLog(successMsg);
        alert(`Projections Generated Successfully!\n\n${successMsg}`);
      } else {
        throw new Error(res.data?.error || 'Failed to generate projections.');
      }
    } catch (err) {
      setProjectionsLog(`Error: ${err.message}`);
      alert(`Projections Generation Failed: ${err.message}`);
      console.error("Projections Generation Error:", err);
    } finally {
      setIsProcessing(false);
    }
  };

  if (loading) return <div style={{ padding: '60px 40px', color: 'var(--text-main)' }}>Loading Admin Panel...</div>;

  return (
    <div className="dashboard-container">
      <header className="dashboard-header">
        <h1>Admin Console</h1>
        <p>Manage users and app-wide settings.</p>
      </header>

      {error && <div className="error-message">{error}</div>}

      <div className="grid-layout" style={{ marginBottom: '24px' }}>
        <div className="glass-panel">
          <h2 style={{ marginBottom: '16px', fontSize: '1.5rem' }}>Data Pipeline</h2>
          <p style={{ color: 'var(--text-muted)', marginBottom: '16px' }}>
            Pull the latest Seasons, Teams, Rosters, Games, and Stats from the official PWHL API into Firebase.
          </p>
          <div style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
            <select 
              className="input-field" 
              style={{ width: '250px', background: 'rgba(255,255,255,0.1)' }}
              value={syncTargetSeason}
              onChange={e => setSyncTargetSeason(e.target.value)}
            >
              <option value="all" style={{ color: '#000' }}>All Seasons</option>
              {seasons.map(s => (
                <option key={s.id} value={s.season_id} style={{ color: '#000' }}>{s.season_name}</option>
              ))}
            </select>
            <button 
              className="btn-primary" 
              onClick={handleSync} 
              disabled={isSyncing}
            >
              {isSyncing ? 'Syncing...' : 'Run Sync'}
            </button>
          </div>
          <pre style={{ 
            marginTop: '16px', 
            background: 'rgba(0,0,0,0.3)', 
            padding: '12px', 
            borderRadius: '8px',
            maxHeight: '200px',
            overflowY: 'auto',
            fontSize: '0.85rem'
          }}>
            {syncLog || 'No syncs run yet this session.'}
          </pre>
        </div>

        {/* Active PWHL Season Selection Card */}
        <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '16px' }}>
            <div>
              <h2 style={{ fontSize: '1.5rem', marginBottom: '4px' }}>Active Season</h2>
              <p style={{ color: 'var(--text-muted)' }}>Define the active season for the entire fantasy app.</p>
            </div>
            <span style={{ fontSize: '2rem' }}>🗓️</span>
          </div>
          
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: 'auto' }}>
            <label style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>Current Active Season</label>
            <div style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
              <select 
                className="input-field" 
                style={{ flex: 1, background: 'rgba(255,255,255,0.1)' }}
                value={localActiveSeasonId}
                onChange={e => setLocalActiveSeasonId(e.target.value)}
              >
                {seasons.map(s => (
                  <option key={s.id} value={s.season_id} style={{ color: '#000' }}>{s.season_name}</option>
                ))}
              </select>
              <button 
                className="btn-primary" 
                onClick={handleApplyActiveSeason} 
                disabled={isApplyingSeason}
              >
                {isApplyingSeason ? 'Applying...' : 'Apply Season'}
              </button>
            </div>
          </div>
        </div>



        {/* Simulation Mode Card */}
        <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '16px' }}>
            <div>
              <h2 style={{ fontSize: '1.5rem', marginBottom: '4px' }}>Simulation Mode</h2>
              <p style={{ color: 'var(--text-muted)' }}>Generate a complete safe testing environment.</p>
            </div>
            <span style={{ fontSize: '2rem' }}>⚡</span>
          </div>
          
          <div style={{ 
            background: 'rgba(0,0,0,0.2)', 
            padding: '20px', 
            borderRadius: '12px', 
            border: '1px solid var(--border-color)', 
            display: 'flex',
            flexDirection: 'column',
            gap: '16px',
            flexGrow: 1,
            justifyContent: 'center'
          }}>
            <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', lineHeight: '1.5', margin: 0 }}>
              Instantly provisions a sandbox environment containing:
            </p>
            <ul style={{ 
              fontSize: '0.85rem', 
              color: 'var(--text-main)', 
              margin: '0 0 8px 0', 
              paddingLeft: '20px',
              display: 'flex',
              flexDirection: 'column',
              gap: '6px'
            }}>
              <li>7 Bot Users with automatic teams</li>
              <li>1 Active 8-Team League (Simulation Test League)</li>
              <li>28 Weekly H2H Matchups pre-scheduled</li>
              <li>All test nodes tagged with <code style={{ background: 'rgba(255,255,255,0.1)', padding: '2px 6px', borderRadius: '4px' }}>isTestNode: true</code></li>
            </ul>

            <button 
              className="btn-primary" 
              style={{ 
                background: 'linear-gradient(135deg, #10B981, #059669)',
                boxShadow: '0 4px 14px rgba(16, 185, 129, 0.4)',
                border: 'none',
                fontWeight: '700',
                transition: 'transform 0.2s, box-shadow 0.2s',
                cursor: 'pointer'
              }}
              onClick={handleStartTestSeason}
              disabled={isSimulating}
            >
              {isSimulating ? 'Initializing Environment...' : 'Start Test Season ⚡'}
            </button>
          </div>

          {simLog && (
            <div style={{ 
              marginTop: '16px', 
              padding: '12px', 
              background: 'rgba(16, 185, 129, 0.1)', 
              color: '#34D399', 
              borderRadius: '8px', 
              fontSize: '0.85rem', 
              textAlign: 'center',
              border: '1px solid rgba(16, 185, 129, 0.2)'
            }}>
              {simLog}
            </div>
          )}
        </div>

        {/* Time Machine Card */}
        <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '16px' }}>
            <div>
              <h2 style={{ fontSize: '1.5rem', marginBottom: '4px' }}>Time Machine</h2>
              <p style={{ color: 'var(--text-muted)' }}>Control and warp the application's central clock.</p>
            </div>
            <span style={{ fontSize: '2rem' }}>🛸</span>
          </div>

          <div style={{ 
            background: 'rgba(0,0,0,0.2)', 
            padding: '16px', 
            borderRadius: '12px', 
            border: '1px solid var(--border-color)', 
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
            marginBottom: '16px'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.9rem' }}>
              <span style={{ color: 'var(--text-muted)' }}>Real-World Date:</span>
              <span style={{ fontWeight: '600' }}>{new Date().toLocaleDateString()}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.9rem', alignItems: 'center' }}>
              <span style={{ color: 'var(--text-muted)' }}>Simulated Clock:</span>
              <span style={{ 
                fontWeight: '700', 
                color: simulationState.testModeActive ? 'var(--primary-color)' : 'var(--text-main)',
                background: simulationState.testModeActive ? 'rgba(108, 92, 231, 0.1)' : 'transparent',
                padding: simulationState.testModeActive ? '2px 8px' : '0',
                borderRadius: '4px'
              }}>
                {simulationState.testModeActive && simulationState.current_simulated_date
                  ? new Date(simulationState.current_simulated_date).toLocaleDateString()
                  : 'Real-Time Clock Active'}
              </span>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: 'auto' }}>
            <label style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>Set Simulated Date</label>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input 
                type="date" 
                className="input-field" 
                style={{ flexGrow: 1 }}
                value={jumpDate} 
                onChange={(e) => setJumpDate(e.target.value)}
              />
              <button 
                className="btn-primary" 
                style={{ padding: '8px 16px', fontSize: '0.85rem', whiteSpace: 'nowrap', cursor: 'pointer' }}
                onClick={handleJumpToDate}
                disabled={isUpdatingDate}
              >
                {isUpdatingDate ? 'Warping...' : 'Jump to Date'}
              </button>
            </div>
          </div>
        </div>

        {/* Pre-Season Projections Engine Card */}
        <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '16px' }}>
            <div>
              <h2 style={{ fontSize: '1.5rem', marginBottom: '4px' }}>Pre-Season Projections</h2>
              <p style={{ color: 'var(--text-muted)' }}>Compute player projections, positional baselines, and VORP ranks.</p>
            </div>
            <span style={{ fontSize: '2rem' }}>🔮</span>
          </div>
          
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: 'auto' }}>
            <label style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>Target Season</label>
            <div style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
              <select 
                className="input-field" 
                style={{ flex: 1, background: 'rgba(255,255,255,0.1)' }}
                value={projectionsSeasonId}
                onChange={e => setProjectionsSeasonId(e.target.value)}
              >
                {seasons.map(s => (
                  <option key={s.id} value={s.season_id} style={{ color: '#000' }}>{s.season_name}</option>
                ))}
              </select>
              <button 
                className="btn-primary" 
                style={{ whiteSpace: 'nowrap', cursor: 'pointer' }}
                onClick={handleGenerateProjections} 
                disabled={isProcessing}
              >
                {isProcessing ? 'Computing Math...' : 'Generate Projections'}
              </button>
            </div>
          </div>

          {projectionsLog && (
            <div style={{ 
              marginTop: '16px', 
              padding: '12px', 
              background: projectionsLog.startsWith('Error') ? 'rgba(239, 68, 68, 0.1)' : 'rgba(108, 92, 231, 0.1)', 
              color: projectionsLog.startsWith('Error') ? '#F87171' : 'var(--primary-color)', 
              borderRadius: '8px', 
              fontSize: '0.85rem', 
              textAlign: 'center',
              border: projectionsLog.startsWith('Error') ? '1px solid rgba(239, 68, 68, 0.2)' : '1px solid rgba(108, 92, 231, 0.2)'
            }}>
              {projectionsLog}
            </div>
          )}
        </div>
      </div>

      <div className="glass-panel" style={{ padding: '0', overflow: 'hidden' }}>
        <h2 style={{ padding: '24px', fontSize: '1.5rem', borderBottom: '1px solid var(--border-color)' }}>User Management</h2>
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
          <thead>
            <tr style={{ background: 'rgba(0,0,0,0.3)', borderBottom: '1px solid var(--border-color)' }}>
              <th style={{ padding: '16px 24px', color: 'var(--text-muted)', fontWeight: '500' }}>Email</th>
              <th style={{ padding: '16px 24px', color: 'var(--text-muted)', fontWeight: '500' }}>Role</th>
              <th style={{ padding: '16px 24px', color: 'var(--text-muted)', fontWeight: '500' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map(user => (
              <tr key={user.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                <td style={{ padding: '16px 24px' }}>{user.email}</td>
                <td style={{ padding: '16px 24px' }}>
                  <span style={{ 
                    padding: '4px 8px', 
                    borderRadius: '4px', 
                    fontSize: '0.85rem',
                    fontWeight: '600',
                    background: user.role === 'admin' ? 'rgba(108, 92, 231, 0.2)' : 'rgba(255, 255, 255, 0.1)',
                    color: user.role === 'admin' ? 'var(--primary-color)' : 'var(--text-main)'
                  }}>
                    {(user.role || 'user').toUpperCase()}
                  </span>
                </td>
                <td style={{ padding: '16px 24px' }}>
                  {user.email !== 'justinemerick79@gmail.com' ? (
                    <button 
                      onClick={() => toggleRole(user.id, user.role)}
                      className="btn-secondary" 
                      style={{ padding: '8px 16px', fontSize: '0.9rem' }}
                    >
                      {user.role === 'admin' ? 'Demote to User' : 'Promote to Admin'}
                    </button>
                  ) : (
                    <span style={{ color: 'var(--text-muted)', fontSize: '0.9rem', fontStyle: 'italic' }}>Super Admin</span>
                  )}
                </td>
              </tr>
            ))}
            {users.length === 0 && (
              <tr>
                <td colSpan="3" style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)' }}>
                  No users found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Data Hub embedded within Admin Panel */}
      <DataHub />

    </div>
  );
}
