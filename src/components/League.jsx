import React, { useState, useEffect } from 'react';
import { db } from '../firebase';
import { doc, getDoc, updateDoc } from 'firebase/firestore';
import { useAuth } from '../contexts/AuthContext';

export default function League({ activeLeagueId }) {
  const { currentUser } = useAuth();
  const [activeTab, setActiveTab] = useState('scoreboard');
  const [leagueData, setLeagueData] = useState(null);
  const [loading, setLoading] = useState(true);

  // Activation State
  const [draftDate, setDraftDate] = useState('');
  const [activating, setActivating] = useState(false);
  const [activateError, setActivateError] = useState('');

  useEffect(() => {
    if (!activeLeagueId) return;
    async function fetchLeague() {
      setLoading(true);
      try {
        const docRef = doc(db, 'fantasy_leagues', activeLeagueId);
        const snap = await getDoc(docRef);
        if (snap.exists()) {
          setLeagueData(snap.data());
        }
      } catch (err) {
        console.error("Error fetching league:", err);
      } finally {
        setLoading(false);
      }
    }
    fetchLeague();
  }, [activeLeagueId]);

  if (!activeLeagueId) {
    return (
      <div className="dashboard-container" style={{ textAlign: 'center', padding: '100px 20px' }}>
        <h2>No Active League</h2>
        <p style={{ color: 'var(--text-muted)' }}>Select or join a league to view its dashboard.</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="dashboard-container" style={{ textAlign: 'center', padding: '100px 20px' }}>
        <p>Loading League Data...</p>
      </div>
    );
  }

  if (!leagueData) {
     return (
      <div className="dashboard-container" style={{ textAlign: 'center', padding: '100px 20px' }}>
        <h2>League Not Found</h2>
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
      setActivateError("Please select a draft date and time.");
      return;
    }
    
    setActivating(true);
    try {
      const docRef = doc(db, 'fantasy_leagues', activeLeagueId);
      await updateDoc(docRef, {
        status: 'active',
        draftDate: new Date(draftDate).toISOString()
      });
      // Update local state to reflect the change immediately
      setLeagueData(prev => ({ ...prev, status: 'active', draftDate: new Date(draftDate).toISOString() }));
      alert("League Activated Successfully!");
    } catch (err) {
      console.error(err);
      setActivateError("Failed to activate league.");
    } finally {
      setActivating(false);
    }
  };

  // Helper function to render a read-only stat row
  const ReadOnlyRow = ({ label, value }) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '12px 0', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span style={{ fontWeight: 'bold' }}>{value}</span>
    </div>
  );

  return (
    <div className="dashboard-container">
      <header className="dashboard-header" style={{ marginBottom: '32px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '8px' }}>
          <h1 style={{ margin: 0 }}>{leagueData.name}</h1>
          {leagueData.status === 'pending' ? (
            <span className="pill pill-secondary">Pending</span>
          ) : (
            <span className="pill pill-primary">Active</span>
          )}
        </div>
        <p>Your league's command center.</p>
      </header>

      <div className="tabs" style={{ marginBottom: '32px' }}>
        <button className={`tab ${activeTab === 'scoreboard' ? 'active' : ''}`} onClick={() => setActiveTab('scoreboard')}>Scoreboard</button>
        <button className={`tab ${activeTab === 'standings' ? 'active' : ''}`} onClick={() => setActiveTab('standings')}>Standings</button>
        <button className={`tab ${activeTab === 'schedule' ? 'active' : ''}`} onClick={() => setActiveTab('schedule')}>Schedule</button>
        <button className={`tab ${activeTab === 'playoffs' ? 'active' : ''}`} onClick={() => setActiveTab('playoffs')}>Playoff Bracket</button>
        {isCommish && (
          <button className={`tab ${activeTab === 'manager' ? 'active' : ''}`} onClick={() => setActiveTab('manager')}>Manager Tools</button>
        )}
      </div>

      <div className="glass-panel">
        {activeTab === 'scoreboard' && (
          <div>
            <h2 style={{ fontSize: '1.5rem', marginBottom: '16px' }}>Weekly Scoreboard</h2>
            <p style={{ color: 'var(--text-muted)' }}>Displays the current matchups and live scores across the league for this week.</p>
          </div>
        )}
        
        {activeTab === 'standings' && (
          <div>
            <h2 style={{ fontSize: '1.5rem', marginBottom: '16px' }}>League Standings</h2>
            <p style={{ color: 'var(--text-muted)' }}>Displays the ranked list of teams by Win/Loss record and total points.</p>
          </div>
        )}

        {activeTab === 'schedule' && (
          <div>
            <h2 style={{ fontSize: '1.5rem', marginBottom: '16px' }}>Schedule & Results</h2>
            <p style={{ color: 'var(--text-muted)' }}>Filter by team to see their past results and upcoming matchups.</p>
          </div>
        )}

        {activeTab === 'playoffs' && (
          <div>
            <h2 style={{ fontSize: '1.5rem', marginBottom: '16px' }}>Playoff Bracket</h2>
            <p style={{ color: 'var(--text-muted)' }}>The road to the championship. Visual bracket of the postseason.</p>
          </div>
        )}

        {activeTab === 'manager' && isCommish && (
          <div>
            <h2 style={{ fontSize: '1.5rem', marginBottom: '8px', color: 'var(--secondary-color)' }}>Commissioner Tools</h2>
            
            {isPending ? (
              <div style={{ maxWidth: '600px', marginTop: '24px' }}>
                <div style={{ background: 'rgba(0,0,0,0.3)', padding: '24px', borderRadius: '12px', border: '1px solid var(--border-color)', marginBottom: '32px' }}>
                  <h3 style={{ marginBottom: '16px', color: 'var(--primary-color)' }}>Activation Status</h3>
                  
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' }}>
                    <span style={{ color: 'var(--secondary-color)', fontSize: '1.2rem' }}>✓</span>
                    <span>League Created</span>
                  </div>
                  
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    {isFull ? (
                      <span style={{ color: 'var(--secondary-color)', fontSize: '1.2rem' }}>✓</span>
                    ) : (
                      <span style={{ color: 'var(--text-muted)', fontSize: '1.2rem' }}>○</span>
                    )}
                    <span style={{ color: isFull ? 'var(--text-main)' : 'var(--text-muted)' }}>
                      Members Joined ({leagueData.members.length} / {leagueData.maxTeams})
                    </span>
                  </div>
                  
                  {!isFull && (
                    <div style={{ marginTop: '24px', padding: '16px', background: 'rgba(255,255,255,0.05)', borderRadius: '8px' }}>
                      <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', marginBottom: '8px' }}>Share this code with friends to join:</p>
                      <p style={{ fontSize: '1.5rem', fontWeight: 'bold', letterSpacing: '2px', color: 'var(--primary-color)' }}>{leagueData.inviteCode}</p>
                    </div>
                  )}
                </div>

                {isFull && (
                  <form onSubmit={handleActivateLeague} style={{ background: 'rgba(108, 92, 231, 0.1)', padding: '32px', borderRadius: '12px', border: '1px solid rgba(108, 92, 231, 0.3)' }}>
                    <h3 style={{ marginBottom: '16px', fontSize: '1.3rem' }}>Ready to Activate</h3>
                    <p style={{ color: 'var(--text-muted)', marginBottom: '24px' }}>
                      Your league is full! Set a draft date to activate the league. 
                      <strong> Activating the league will permanently lock all roster sizes, scoring, and playoff settings.</strong>
                    </p>
                    
                    {activateError && <div className="error-message">{activateError}</div>}
                    
                    <div style={{ marginBottom: '24px' }}>
                      <label style={{ display: 'block', marginBottom: '8px', fontWeight: '600' }}>Draft Date & Time</label>
                      <input 
                        type="datetime-local" 
                        className="input-field" 
                        style={{ background: 'rgba(0,0,0,0.5)' }}
                        value={draftDate}
                        onChange={e => setDraftDate(e.target.value)}
                        required
                      />
                    </div>
                    
                    <button type="submit" className="btn-primary" disabled={activating} style={{ width: '100%', fontSize: '1.1rem', padding: '16px' }}>
                      {activating ? 'Activating...' : 'Activate League & Lock Settings'}
                    </button>
                  </form>
                )}
              </div>
            ) : (
              <div style={{ marginTop: '24px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '32px', color: 'var(--secondary-color)', background: 'rgba(0, 206, 201, 0.1)', padding: '16px', borderRadius: '8px' }}>
                  <span style={{ fontSize: '1.2rem' }}>🔒</span>
                  <span>League settings are locked.</span>
                </div>

                <div style={{ display: 'flex', gap: '32px', flexWrap: 'wrap' }}>
                  
                  {/* Basic & Schedule Info */}
                  <div style={{ flex: '1 1 300px', background: 'rgba(0,0,0,0.2)', padding: '24px', borderRadius: '12px', border: '1px solid var(--border-color)' }}>
                    <h3 style={{ marginBottom: '20px', fontSize: '1.2rem', color: 'var(--primary-color)', borderBottom: '1px solid var(--border-color)', paddingBottom: '8px' }}>League Rules</h3>
                    <ReadOnlyRow label="Match-up Duration" value={`${leagueData.scheduleSettings.matchupDuration} Week(s)`} />
                    <ReadOnlyRow label="Playoff Teams" value={leagueData.scheduleSettings.playoffTeams} />
                    <ReadOnlyRow label="Playoff Match-up" value={`${leagueData.scheduleSettings.playoffDuration} Week(s)`} />
                    <ReadOnlyRow label="Draft Date" value={new Date(leagueData.draftDate).toLocaleString()} />
                  </div>

                  {/* Roster Settings */}
                  <div style={{ flex: '1 1 300px', background: 'rgba(0,0,0,0.2)', padding: '24px', borderRadius: '12px', border: '1px solid var(--border-color)' }}>
                    <h3 style={{ marginBottom: '20px', fontSize: '1.2rem', color: 'var(--primary-color)', borderBottom: '1px solid var(--border-color)', paddingBottom: '8px' }}>Roster Structure</h3>
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', color: 'var(--text-muted)', fontSize: '0.8rem', textTransform: 'uppercase', fontWeight: 'bold' }}>
                      <span>Position</span>
                      <div style={{ display: 'flex', gap: '24px', width: '120px', justifyContent: 'flex-end' }}>
                        <span>Start</span>
                        <span>Max</span>
                      </div>
                    </div>
                    
                    {['forwards', 'defense', 'goalies'].map(pos => (
                      <div key={pos} style={{ display: 'flex', justifyContent: 'space-between', padding: '12px 0', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                        <span style={{ textTransform: 'capitalize' }}>{pos}</span>
                        <div style={{ display: 'flex', gap: '24px', width: '120px', justifyContent: 'flex-end', fontWeight: 'bold' }}>
                          <span>{leagueData.rosterSettings[pos].starters}</span>
                          <span style={{ color: 'var(--text-muted)' }}>{leagueData.rosterSettings[pos].max}</span>
                        </div>
                      </div>
                    ))}
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '12px 0', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                      <span>Bench</span>
                      <span style={{ fontWeight: 'bold' }}>{leagueData.rosterSettings.bench}</span>
                    </div>
                  </div>

                </div>
                
                {/* Scoring Settings */}
                <div style={{ marginTop: '32px', background: 'rgba(0,0,0,0.2)', padding: '24px', borderRadius: '12px', border: '1px solid var(--border-color)' }}>
                  <h3 style={{ marginBottom: '20px', fontSize: '1.2rem', color: 'var(--primary-color)', borderBottom: '1px solid var(--border-color)', paddingBottom: '8px' }}>Scoring System</h3>
                  <div style={{ display: 'flex', gap: '32px', flexWrap: 'wrap' }}>
                    <div style={{ flex: '1 1 300px' }}>
                      <h4 style={{ color: 'var(--text-muted)', marginBottom: '16px', textTransform: 'uppercase' }}>Skaters</h4>
                      {Object.entries(leagueData.scoringSettings.skaters).map(([key, value]) => (
                        <ReadOnlyRow key={key} label={key.replace(/([A-Z])/g, ' $1').trim().toUpperCase()} value={value} />
                      ))}
                    </div>
                    <div style={{ flex: '1 1 300px' }}>
                      <h4 style={{ color: 'var(--text-muted)', marginBottom: '16px', textTransform: 'uppercase' }}>Goalies</h4>
                      {Object.entries(leagueData.scoringSettings.goalies).map(([key, value]) => (
                        <ReadOnlyRow key={key} label={key.toUpperCase()} value={value} />
                      ))}
                    </div>
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
