import React, { useState, useEffect } from 'react';
import { db, functions } from '../firebase';
import { collection, getDocs, doc, updateDoc, onSnapshot, setDoc } from 'firebase/firestore';
import { runFullSync, autoGenerateMissingWeeks } from '../services/pwhlService';
import DataHub from './DataHub';
import { useTimeTravel } from '../contexts/TimeTravelContext';
import { httpsCallable } from 'firebase/functions';

export default function AdminPanel() {
  const [mainTab, setMainTab] = useState('controls'); // 'controls' | 'datahub'
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
    async function getDocsWithTimeout(colRef, timeoutMs = 5000) {
      return Promise.race([
        getDocs(colRef),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Connection timed out. This often happens if the browser is using a cached connection to a non-running Firestore emulator.")), timeoutMs)
        )
      ]);
    }

    async function fetchUsersAndSeasons() {
      try {
        const querySnapshot = await getDocsWithTimeout(collection(db, "users"), 5000);
        const usersList = querySnapshot.docs.map(doc => ({
          id: doc.id,
          ...doc.data()
        }));
        setUsers(usersList);
        
        const seasonsSnap = await getDocsWithTimeout(collection(db, 'pwhl_seasons'), 5000);
        const seasonList = seasonsSnap.docs.map(d => ({id: d.id, ...d.data()}));
        seasonList.sort((a, b) => new Date(b.start_date) - new Date(a.start_date));
        setSeasons(seasonList);
      } catch (err) {
        console.error("[AdminPanel] fetchUsersAndSeasons error:", err);
        if (err.message && err.message.includes("Connection timed out")) {
          setError('Failed to load Admin Panel: Firestore connection timed out. Please perform a hard refresh (Cmd+Shift+R or Ctrl+F5).');
        } else {
          setError('Failed to fetch data. Ensure you have admin privileges. Error: ' + err.message);
        }
      } finally {
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
    setProjectionsLog('Running projections engine...');
    try {
      let resData = null;
      try {
        const generateSeasonProjectionsFunc = httpsCallable(functions, 'generateSeasonProjections');
        const res = await generateSeasonProjectionsFunc({ seasonId: projectionsSeasonId });
        if (res.data?.success && res.data?.processedCount > 0) {
          resData = res.data;
        }
      } catch (cloudErr) {
        console.warn("Cloud function execution skipped/failed, using client projections engine fallback:", cloudErr);
      }

      if (!resData) {
        setProjectionsLog('Running projections calculation engine in client fallback mode...');
        resData = await generateSeasonProjectionsClient(projectionsSeasonId);
      }

      if (resData?.success) {
        const { processedCount, baselines } = resData;
        const successMsg = `Successfully processed ${processedCount} players!\nBaselines - F: ${baselines.forward}, D: ${baselines.defense}, G: ${baselines.goalie}`;
        setProjectionsLog(successMsg);
        alert(`Projections Generated Successfully!\n\n${successMsg}`);
      } else {
        throw new Error(resData?.error || 'Failed to generate projections.');
      }
    } catch (err) {
      setProjectionsLog(`Error: ${err.message}`);
      alert(`Projections Generation Failed: ${err.message}`);
      console.error("Projections Generation Error:", err);
    } finally {
      setIsProcessing(false);
    }
  };

  if (loading) {
    return (
      <div className="dashboard-container" style={{ padding: '60px 24px', textAlign: 'center', color: 'var(--text-secondary)' }}>
        Loading Admin Panel...
      </div>
    );
  }

  return (
    <div className="dashboard-container">
      {/* Header */}
      <header className="dashboard-header">
        <h1>Admin Console</h1>
        <p>Manage application settings, run data pipelines, warp simulation time, and inspect PWHL data.</p>
      </header>

      {error && (
        <div style={{ padding: '16px 20px', background: 'rgba(220, 38, 38, 0.08)', border: '1px solid var(--accent-danger)', borderRadius: '10px', color: 'var(--accent-danger)', marginBottom: '24px', fontSize: '0.9rem' }}>
          {error}
        </div>
      )}

      {/* Top-Level Navigation Tabs */}
      <div className="tabs-navigation" style={{ marginBottom: '28px' }}>
        <button 
          className={`tab-btn ${mainTab === 'controls' ? 'active' : ''}`}
          onClick={() => setMainTab('controls')}
        >
          ⚙️ System Controls
        </button>
        <button 
          className={`tab-btn ${mainTab === 'datahub' ? 'active' : ''}`}
          onClick={() => setMainTab('datahub')}
        >
          📊 PWHL Data Hub
        </button>
      </div>

      {mainTab === 'controls' && (
        <>
          {/* Admin Control Cards Grid */}
          <div className="admin-grid">
            
            {/* Card 1: Data Pipeline */}
            <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '14px' }}>
                <div>
                  <h3 style={{ fontSize: '1.25rem', fontWeight: '700', marginBottom: '4px' }}>Data Pipeline</h3>
                  <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Sync PWHL Seasons, Teams, Rosters, and Stats into Firebase.</p>
                </div>
                <span style={{ fontSize: '1.5rem' }}>🔄</span>
              </div>

              <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginTop: 'auto', marginBottom: '12px' }}>
                <select 
                  className="input-field" 
                  style={{ flex: 1 }}
                  value={syncTargetSeason}
                  onChange={e => setSyncTargetSeason(e.target.value)}
                >
                  <option value="all">All Seasons</option>
                  {seasons.map(s => (
                    <option key={s.id} value={s.season_id}>{s.season_name}</option>
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
                background: 'var(--bg-surface-alt)', 
                border: '1px solid var(--border-primary)', 
                padding: '10px 12px', 
                borderRadius: '8px',
                maxHeight: '120px',
                overflowY: 'auto',
                fontSize: '0.78rem',
                color: 'var(--text-secondary)',
                fontFamily: 'monospace',
                margin: 0
              }}>
                {syncLog || 'No sync log recorded for this session.'}
              </pre>
            </div>

            {/* Card 2: Active PWHL Season */}
            <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '14px' }}>
                <div>
                  <h3 style={{ fontSize: '1.25rem', fontWeight: '700', marginBottom: '4px' }}>Active Season</h3>
                  <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Define the active season for the entire fantasy application.</p>
                </div>
                <span style={{ fontSize: '1.5rem' }}>🗓️</span>
              </div>
              
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: 'auto' }}>
                <label style={{ fontSize: '0.8rem', fontWeight: '600', color: 'var(--text-secondary)' }}>Target Season</label>
                <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                  <select 
                    className="input-field" 
                    style={{ flex: 1 }}
                    value={localActiveSeasonId}
                    onChange={e => setLocalActiveSeasonId(e.target.value)}
                  >
                    {seasons.map(s => (
                      <option key={s.id} value={s.season_id}>{s.season_name}</option>
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

            {/* Card 3: Simulation Mode */}
            <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '14px' }}>
                <div>
                  <h3 style={{ fontSize: '1.25rem', fontWeight: '700', marginBottom: '4px' }}>Simulation Mode</h3>
                  <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Provision a isolated 8-team sandbox league environment.</p>
                </div>
                <span style={{ fontSize: '1.5rem' }}>⚡</span>
              </div>
              
              <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: '1.4', marginBottom: '14px' }}>
                Provisions 7 bot managers, pre-calculates 28 H2H weekly matchups, and tags all nodes safely.
              </p>

              <button 
                className="btn-primary" 
                style={{ 
                  background: 'var(--accent-action)',
                  marginTop: 'auto',
                  justifyContent: 'center'
                }}
                onClick={handleStartTestSeason}
                disabled={isSimulating}
              >
                {isSimulating ? 'Initializing...' : 'Start Sandbox League ⚡'}
              </button>

              {simLog && (
                <div style={{ marginTop: '10px', padding: '8px 12px', background: 'rgba(5, 150, 105, 0.08)', color: 'var(--accent-action)', borderRadius: '6px', fontSize: '0.78rem', textAlign: 'center' }}>
                  {simLog}
                </div>
              )}
            </div>

            {/* Card 4: Time Machine */}
            <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '14px' }}>
                <div>
                  <h3 style={{ fontSize: '1.25rem', fontWeight: '700', marginBottom: '4px' }}>Time Machine</h3>
                  <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Warp the system's simulated clock date.</p>
                </div>
                <span style={{ fontSize: '1.5rem' }}>🛸</span>
              </div>

              <div style={{ background: 'var(--bg-surface-alt)', border: '1px solid var(--border-primary)', padding: '12px', borderRadius: '8px', marginBottom: '14px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.82rem', marginBottom: '6px' }}>
                  <span style={{ color: 'var(--text-secondary)' }}>Real Today:</span>
                  <span style={{ fontWeight: '600' }}>{new Date().toLocaleDateString()}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.82rem', alignItems: 'center' }}>
                  <span style={{ color: 'var(--text-secondary)' }}>Simulated Date:</span>
                  <span className={`badge ${simulationState.testModeActive ? 'badge-primary' : 'badge-neutral'}`}>
                    {simulationState.testModeActive && simulationState.current_simulated_date
                      ? simulationState.current_simulated_date
                      : 'Real Clock'}
                  </span>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '8px', marginTop: 'auto' }}>
                <input 
                  type="date" 
                  className="input-field" 
                  style={{ flexGrow: 1 }}
                  value={jumpDate} 
                  onChange={(e) => setJumpDate(e.target.value)}
                />
                <button 
                  className="btn-secondary" 
                  style={{ whiteSpace: 'nowrap' }}
                  onClick={handleJumpToDate}
                  disabled={isUpdatingDate}
                >
                  {isUpdatingDate ? 'Warping...' : 'Jump'}
                </button>
              </div>
            </div>

            {/* Card 5: Pre-Season Projections Engine */}
            <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '14px' }}>
                <div>
                  <h3 style={{ fontSize: '1.25rem', fontWeight: '700', marginBottom: '4px' }}>Pre-Season Projections</h3>
                  <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Compute VORP rankings and fantasy point projections.</p>
                </div>
                <span style={{ fontSize: '1.5rem' }}>🔮</span>
              </div>

              <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginTop: 'auto' }}>
                <select 
                  className="input-field" 
                  style={{ flex: 1 }}
                  value={projectionsSeasonId}
                  onChange={e => setProjectionsSeasonId(e.target.value)}
                >
                  {seasons.map(s => (
                    <option key={s.id} value={s.season_id}>{s.season_name}</option>
                  ))}
                </select>
                <button 
                  className="btn-primary" 
                  onClick={handleGenerateProjections} 
                  disabled={isProcessing}
                >
                  {isProcessing ? 'Computing...' : 'Generate Projections'}
                </button>
              </div>

              {projectionsLog && (
                <div style={{ marginTop: '10px', padding: '8px 12px', background: projectionsLog.startsWith('Error') ? 'rgba(220, 38, 38, 0.08)' : 'rgba(74, 85, 104, 0.08)', color: projectionsLog.startsWith('Error') ? 'var(--accent-danger)' : 'var(--accent-primary)', borderRadius: '6px', fontSize: '0.78rem' }}>
                  {projectionsLog}
                </div>
              )}
            </div>

          </div>

          {/* User Management Section */}
          <div className="data-table-wrapper" style={{ marginTop: '8px' }}>
            <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--border-primary)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <h3 style={{ fontSize: '1.2rem', fontWeight: '700', fontFamily: 'Outfit, sans-serif' }}>User Access Management</h3>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: '2px 0 0 0' }}>Manage roles and administrator permissions.</p>
              </div>
              <span className="badge badge-neutral">{users.length} Users Registered</span>
            </div>

            <table className="data-table">
              <thead>
                <tr>
                  <th>User Email</th>
                  <th>Current Role</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map(user => (
                  <tr key={user.id}>
                    <td style={{ fontWeight: '600' }}>{user.email}</td>
                    <td>
                      <span className={`badge ${user.role === 'admin' ? 'badge-primary' : 'badge-neutral'}`}>
                        {(user.role || 'user').toUpperCase()}
                      </span>
                    </td>
                    <td>
                      {user.email !== 'justinemerick79@gmail.com' ? (
                        <button 
                          onClick={() => toggleRole(user.id, user.role)}
                          className="btn-secondary" 
                          style={{ padding: '6px 14px', fontSize: '0.8rem' }}
                        >
                          {user.role === 'admin' ? 'Demote to User' : 'Promote to Admin'}
                        </button>
                      ) : (
                        <span className="badge badge-warning">Super Admin</span>
                      )}
                    </td>
                  </tr>
                ))}
                {users.length === 0 && (
                  <tr>
                    <td colSpan="3" style={{ textAlign: 'center', padding: '32px', color: 'var(--text-tertiary)' }}>
                      No registered users found.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Embedded Data Hub Tab */}
      {mainTab === 'datahub' && (
        <DataHub />
      )}

    </div>
  );
}
