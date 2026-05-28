import React, { useState, useEffect } from 'react';
import { db } from '../firebase';
import { collection, getDocs, doc, updateDoc } from 'firebase/firestore';
import { runFullSync } from '../services/pwhlService';
import DataHub from './DataHub';
import { useTimeTravel } from '../contexts/TimeTravelContext';
import { setDoc } from 'firebase/firestore';

function TimeTravelSettings() {
  const { timeTravelState } = useTimeTravel();
  const [localEnabled, setLocalEnabled] = useState(false);
  const [localDate, setLocalDate] = useState('2024-09-01');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (timeTravelState) {
      setLocalEnabled(timeTravelState.enabled);
      setLocalDate(timeTravelState.date || '2024-09-01');
    }
  }, [timeTravelState]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await setDoc(doc(db, 'app_settings', 'time_travel'), {
        enabled: localEnabled,
        date: localDate
      }, { merge: true });
    } catch (err) {
      alert("Failed to save time travel settings: " + err.message);
      console.error("Time Travel Save Error:", err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontWeight: '600' }}>Enable Time Travel</span>
        <label className="switch">
          <input type="checkbox" checked={localEnabled} onChange={e => setLocalEnabled(e.target.checked)} />
          <span className="slider round"></span>
        </label>
      </div>
      
      {localEnabled && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' }}>
          <label style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>Simulated Date (Time fixed at 8:00am PST)</label>
          <input 
            type="date" 
            className="input-field" 
            value={localDate} 
            min="2024-09-01"
            onChange={e => setLocalDate(e.target.value)} 
          />
        </div>
      )}

      <button className="btn-secondary" style={{ marginTop: '8px' }} onClick={handleSave} disabled={saving}>
        {saving ? 'Updating...' : 'Apply Global Time'}
      </button>
      
      {timeTravelState?.enabled && (
        <div style={{ marginTop: '8px', padding: '8px', background: 'rgba(255,0,0,0.2)', color: '#ff7675', borderRadius: '4px', fontSize: '0.85rem', textAlign: 'center' }}>
          ⚠️ App is currently simulating {timeTravelState.date}
        </div>
      )}
    </div>
  );
}

export default function AdminPanel() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  
  const [syncLog, setSyncLog] = useState('');
  const [isSyncing, setIsSyncing] = useState(false);
  
  const [seasons, setSeasons] = useState([]);
  const [syncTargetSeason, setSyncTargetSeason] = useState('all');

  useEffect(() => {
    async function fetchUsersAndSeasons() {
      try {
        const querySnapshot = await getDocs(collection(db, "users"));
        const usersList = querySnapshot.docs.map(doc => ({
          id: doc.id,
          ...doc.data()
        }));
        setUsers(usersList);
        
        // Fetch seasons for the sync dropdown
        const seasonsSnap = await getDocs(collection(db, 'pwhl_seasons'));
        const seasonList = seasonsSnap.docs.map(d => ({id: d.id, ...d.data()}));
        seasonList.sort((a, b) => new Date(b.start_date) - new Date(a.start_date));
        setSeasons(seasonList);
      } catch (err) {
        setError('Failed to fetch data. Ensure you have admin privileges.');
        console.error(err);
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

        {/* Time Travel Mode Card */}
        <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '16px' }}>
            <div>
              <h2 style={{ fontSize: '1.5rem', marginBottom: '4px' }}>QA Time Travel</h2>
              <p style={{ color: 'var(--text-muted)' }}>Simulate the app at a specific date for testing.</p>
            </div>
            <span style={{ fontSize: '2rem' }}>🕰️</span>
          </div>
          
          <div style={{ background: 'rgba(0,0,0,0.2)', padding: '16px', borderRadius: '12px', border: '1px solid var(--border-color)', marginBottom: '16px' }}>
             <TimeTravelSettings />
          </div>
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
                    {user.role.toUpperCase()}
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
