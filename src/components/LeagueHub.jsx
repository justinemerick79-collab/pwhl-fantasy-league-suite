import React, { useState, useEffect } from 'react';
import { db } from '../firebase';
import { collection, addDoc, query, where, getDocs, updateDoc, doc, getDoc, arrayUnion, serverTimestamp } from 'firebase/firestore';
import { useAuth } from '../contexts/AuthContext';

function generateInviteCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export default function LeagueHub({ activeLeagueId, setActiveLeagueId }) {
  const { currentUser } = useAuth();
  
  const [activeTab, setActiveTab] = useState('my-leagues'); // 'my-leagues', 'create', 'join'
  const [myLeagues, setMyLeagues] = useState([]);
  const [userMap, setUserMap] = useState({});
  const [loading, setLoading] = useState(true);

  // --- Create Form State ---
  const [createName, setCreateName] = useState('');
  const [createMaxTeams, setCreateMaxTeams] = useState(6);
  const [matchupDuration, setMatchupDuration] = useState(1);
  const [playoffTeams, setPlayoffTeams] = useState(4);
  const [playoffDuration, setPlayoffDuration] = useState(1);
  
  const [createLoading, setCreateLoading] = useState(false);

  const [settings, setSettings] = useState({
    forwards: { starters: 6, max: 10 },
    defense: { starters: 4, max: 8 },
    goalies: { starters: 1, max: 3 },
    bench: 4
  });

  const [scoring, setScoring] = useState({
    skaters: {
      goals: 2,
      assists: 1,
      plusMinus: 0.5,
      ppp: 0.5,
      shp: 0.5,
      sog: 0.1,
      hits: 0.1,
      blocks: 0.5,
      defensePoints: 0.5
    },
    goalies: {
      wins: 4,
      otl: 1,
      ga: -2,
      saves: 0.2,
      shutouts: 3
    }
  });

  // --- Join Form State ---
  const [joinCode, setJoinCode] = useState('');
  const [joinLoading, setJoinLoading] = useState(false);
  const [joinError, setJoinError] = useState('');

  useEffect(() => {
    if (!currentUser) return;
    async function fetchMyLeagues() {
      setLoading(true);
      try {
        const q = query(collection(db, 'fantasy_leagues'), where('members', 'array-contains', currentUser.uid));
        const snap = await getDocs(q);
        const leagues = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        setMyLeagues(leagues);

        const uids = new Set();
        leagues.forEach(l => l.members.forEach(m => uids.add(m)));
        if (uids.size > 0) {
          const map = {};
          for (const uid of Array.from(uids)) {
             const userSnap = await getDoc(doc(db, 'users', uid));
             if (userSnap.exists()) {
               map[uid] = userSnap.data().email;
             }
          }
          setUserMap(map);
        }
      } catch (err) {
        console.error("Error fetching leagues:", err);
      } finally {
        setLoading(false);
      }
    }
    fetchMyLeagues();
  }, [currentUser, activeTab]);

  const handleSettingChange = (position, field, value) => {
    setSettings(prev => ({
      ...prev,
      [position]: {
        ...prev[position],
        [field]: value
      }
    }));
  };

  const handleScoringChange = (category, field, value) => {
    setScoring(prev => ({
      ...prev,
      [category]: {
        ...prev[category],
        [field]: value
      }
    }));
  };

  const handleCreateLeague = async (e) => {
    e.preventDefault();
    if (!createName) return;
    
    // Validation
    if (parseInt(settings.forwards.max) < parseInt(settings.forwards.starters)) return alert("Forwards Max cannot be less than Starters.");
    if (parseInt(settings.defense.max) < parseInt(settings.defense.starters)) return alert("Defense Max cannot be less than Starters.");
    if (parseInt(settings.goalies.max) < parseInt(settings.goalies.starters)) return alert("Goalies Max cannot be less than Starters.");

    setCreateLoading(true);
    try {
      const inviteCode = generateInviteCode();
      
      const numericScoring = {
        skaters: {
          goals: parseFloat(scoring.skaters.goals) || 0,
          assists: parseFloat(scoring.skaters.assists) || 0,
          plusMinus: parseFloat(scoring.skaters.plusMinus) || 0,
          ppp: parseFloat(scoring.skaters.ppp) || 0,
          shp: parseFloat(scoring.skaters.shp) || 0,
          sog: parseFloat(scoring.skaters.sog) || 0,
          hits: parseFloat(scoring.skaters.hits) || 0,
          blocks: parseFloat(scoring.skaters.blocks) || 0,
          defensePoints: parseFloat(scoring.skaters.defensePoints) || 0,
        },
        goalies: {
          wins: parseFloat(scoring.goalies.wins) || 0,
          otl: parseFloat(scoring.goalies.otl) || 0,
          ga: parseFloat(scoring.goalies.ga) || 0,
          saves: parseFloat(scoring.goalies.saves) || 0,
          shutouts: parseFloat(scoring.goalies.shutouts) || 0,
        }
      };

      await addDoc(collection(db, 'fantasy_leagues'), {
        name: createName,
        ownerId: currentUser.uid,
        maxTeams: parseInt(createMaxTeams),
        inviteCode,
        members: [currentUser.uid],
        status: 'pending', // 'pending' | 'active'
        scheduleSettings: {
          matchupDuration: parseInt(matchupDuration),
          playoffTeams: parseInt(playoffTeams),
          playoffDuration: parseInt(playoffDuration)
        },
        rosterSettings: {
          forwards: { starters: parseInt(settings.forwards.starters), max: parseInt(settings.forwards.max) },
          defense: { starters: parseInt(settings.defense.starters), max: parseInt(settings.defense.max) },
          goalies: { starters: parseInt(settings.goalies.starters), max: parseInt(settings.goalies.max) },
          bench: parseInt(settings.bench)
        },
        scoringSettings: numericScoring,
        createdAt: serverTimestamp()
      });
      alert(`League created! Your invite code is ${inviteCode}`);
      setCreateName('');
      setActiveTab('my-leagues');
    } catch (err) {
      console.error(err);
      alert('Failed to create league.');
    } finally {
      setCreateLoading(false);
    }
  };

  const handleJoinLeague = async (e) => {
    e.preventDefault();
    setJoinError('');
    if (!joinCode) return;
    
    setJoinLoading(true);
    try {
      const q = query(collection(db, 'fantasy_leagues'), where('inviteCode', '==', joinCode.toUpperCase()));
      const snap = await getDocs(q);
      
      if (snap.empty) {
        setJoinError('Invalid invite code. League not found.');
        return;
      }

      const leagueDoc = snap.docs[0];
      const leagueData = leagueDoc.data();

      if (leagueData.members.includes(currentUser.uid)) {
        setJoinError('You are already a member of this league.');
        return;
      }

      if (leagueData.members.length >= leagueData.maxTeams) {
        setJoinError('This league is already full.');
        return;
      }

      await updateDoc(doc(db, 'fantasy_leagues', leagueDoc.id), {
        members: arrayUnion(currentUser.uid)
      });
      
      alert(`Successfully joined ${leagueData.name}!`);
      setJoinCode('');
      setActiveTab('my-leagues');

    } catch (err) {
      console.error(err);
      setJoinError('Failed to join league. Please try again.');
    } finally {
      setJoinLoading(false);
    }
  };

  if (!currentUser) return <div style={{ padding: '40px' }}>Please sign in to access leagues.</div>;

  const totalTeamSize = parseInt(settings.forwards.starters) + parseInt(settings.defense.starters) + parseInt(settings.goalies.starters) + parseInt(settings.bench);

  return (
    <div className="dashboard-container">
      <header className="dashboard-header" style={{ marginBottom: '24px' }}>
        <h1>League Hub</h1>
        <p>Manage your fantasy leagues, compete with friends, and chase glory.</p>
      </header>

      <div className="tabs" style={{ marginBottom: '24px' }}>
        <button className={`tab ${activeTab === 'my-leagues' ? 'active' : ''}`} onClick={() => setActiveTab('my-leagues')}>My Leagues</button>
        <button className={`tab ${activeTab === 'create' ? 'active' : ''}`} onClick={() => setActiveTab('create')}>Create League</button>
        <button className={`tab ${activeTab === 'join' ? 'active' : ''}`} onClick={() => setActiveTab('join')}>Join League</button>
      </div>

      <div className="glass-panel">
        {activeTab === 'my-leagues' && (
          <div>
            <h2 style={{ fontSize: '1.5rem', marginBottom: '16px' }}>My Leagues</h2>
            {loading ? (
              <p>Loading...</p>
            ) : myLeagues.length === 0 ? (
              <p style={{ color: 'var(--text-muted)' }}>You haven't joined any leagues yet. Create or join one to get started!</p>
            ) : (
              <div style={{ display: 'grid', gap: '24px', gridTemplateColumns: 'repeat(auto-fill, minmax(350px, 1fr))' }}>
                {myLeagues.map(league => (
                  <div key={league.id} style={{ 
                    background: 'linear-gradient(145deg, rgba(255,255,255,0.05) 0%, rgba(0,0,0,0.2) 100%)',
                    padding: '24px', 
                    borderRadius: '16px', 
                    border: '1px solid rgba(255,255,255,0.1)',
                    boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
                    display: 'flex',
                    flexDirection: 'column'
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '8px' }}>
                      <h3 style={{ fontSize: '1.4rem', margin: 0, fontWeight: '700', letterSpacing: '0.5px' }}>{league.name}</h3>
                      <span style={{ 
                        background: 'rgba(255,255,255,0.1)', 
                        padding: '6px 12px', 
                        borderRadius: '20px', 
                        fontSize: '0.8rem', 
                        fontWeight: '600' 
                      }}>
                        {league.members.length} / {league.maxTeams}
                      </span>
                    </div>
                    
                    <div style={{ marginBottom: '16px' }}>
                      {league.status === 'pending' ? (
                        <span className="pill pill-secondary">Pending (Waiting for Draft)</span>
                      ) : (
                        <span className="pill pill-primary">Active</span>
                      )}
                    </div>

                    {league.ownerId === currentUser.uid && (
                      <div style={{ 
                        background: 'rgba(255, 255, 255, 0.05)', 
                        border: '1px solid rgba(255, 255, 255, 0.2)',
                        padding: '12px 16px', 
                        borderRadius: '8px', 
                        fontSize: '0.9rem', 
                        display: 'flex', 
                        justifyContent: 'space-between', 
                        alignItems: 'center', 
                        marginBottom: '24px',
                        marginTop: '16px'
                      }}>
                        <span style={{ color: 'var(--text-muted)', textTransform: 'uppercase', fontSize: '0.75rem', fontWeight: 'bold', letterSpacing: '1px' }}>Invite Code</span>
                        <span style={{ fontWeight: 'bold', letterSpacing: '3px', color: 'var(--primary-color)', fontSize: '1.2rem' }}>{league.inviteCode}</span>
                      </div>
                    )}
                    
                    <div style={{ marginTop: 'auto', paddingTop: league.ownerId !== currentUser.uid ? '24px' : '0' }}>
                      <h4 style={{ marginBottom: '12px', fontSize: '0.85rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '1px' }}>League Roster</h4>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                          {Array.from({ length: league.maxTeams }).map((_, idx) => {
                            const memberUid = league.members[idx];
                            if (memberUid) {
                              const isCommish = memberUid === league.ownerId;
                              return (
                                <div key={idx} style={{ 
                                  display: 'flex', 
                                  alignItems: 'center', 
                                  padding: '12px 16px', 
                                  background: 'rgba(0,0,0,0.4)', 
                                  borderRadius: '8px',
                                  border: isCommish ? '1px solid rgba(255,255,255,0.15)' : '1px solid transparent'
                                }}>
                                  <span style={{ width: '32px', color: 'var(--text-muted)', fontWeight: '600', fontSize: '0.9rem' }}>{idx + 1}</span>
                                  <span style={{ flex: 1, fontWeight: '500', fontSize: '0.95rem' }}>
                                    {userMap[memberUid] || 'Loading...'} 
                                    {memberUid === currentUser.uid && <span style={{color: 'var(--primary-color)', fontSize: '0.75rem', marginLeft: '8px', textTransform: 'uppercase', fontWeight: 'bold'}}>(You)</span>}
                                  </span>
                                  {isCommish && <span style={{ color: 'var(--primary-color)', fontSize: '0.7rem', fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Commish</span>}
                                </div>
                              );
                            } else {
                              return (
                                <div key={idx} style={{ 
                                  display: 'flex', 
                                  alignItems: 'center', 
                                  padding: '12px 16px', 
                                  background: 'rgba(255,255,255,0.02)', 
                                  borderRadius: '8px',
                                  border: '1px dashed rgba(255,255,255,0.1)',
                                  opacity: 0.8
                                }}>
                                  <span style={{ width: '32px', color: 'var(--text-muted)', fontSize: '0.9rem' }}>{idx + 1}</span>
                                  <span style={{ color: 'var(--text-muted)', fontStyle: 'italic', fontSize: '0.9rem' }}>Empty Slot</span>
                                </div>
                              );
                            }
                          })}
                      </div>
                    </div>
                    
                    <div style={{ marginTop: '24px', paddingTop: '16px', borderTop: '1px solid var(--border-color)', display: 'flex', justifyContent: 'center' }}>
                      {activeLeagueId === league.id ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--secondary-color)', fontWeight: 'bold' }}>
                          <span style={{ fontSize: '1.2rem' }}>✓</span> Currently Active League
                        </div>
                      ) : (
                        <button 
                          className="btn-secondary" 
                          style={{ width: '100%', borderColor: 'var(--primary-color)', color: 'var(--primary-color)' }}
                          onClick={() => setActiveLeagueId(league.id)}
                        >
                          Set as Active League
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === 'create' && (
          <div>
            <h2 style={{ fontSize: '1.5rem', marginBottom: '8px' }}>Create a New League</h2>
            <p style={{ color: 'var(--text-muted)', marginBottom: '32px' }}>Configure all your league settings here. Once the league is full, you can activate it and lock these settings in.</p>
            
            <form onSubmit={handleCreateLeague} style={{ display: 'flex', flexDirection: 'column', gap: '40px' }}>
              
              {/* Section 1: Basics & Schedule */}
              <div>
                <h3 style={{ fontSize: '1.2rem', color: 'var(--primary-color)', marginBottom: '16px', borderBottom: '1px solid var(--border-color)', paddingBottom: '8px' }}>1. Basics & Schedule</h3>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '24px' }}>
                  <div>
                    <label style={{ display: 'block', marginBottom: '8px', color: 'var(--text-muted)' }}>League Name</label>
                    <input type="text" className="input-field" value={createName} onChange={e => setCreateName(e.target.value)} placeholder="e.g. Office Hockey Pool" required />
                  </div>
                  <div>
                    <label style={{ display: 'block', marginBottom: '8px', color: 'var(--text-muted)' }}>Number of Teams (4 - 10)</label>
                    <select className="input-field" value={createMaxTeams} onChange={e => setCreateMaxTeams(e.target.value)} style={{ background: 'rgba(255,255,255,0.1)' }}>
                      {[4, 5, 6, 7, 8, 9, 10].map(num => <option key={num} value={num} style={{ color: '#000' }}>{num}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={{ display: 'block', marginBottom: '8px', color: 'var(--text-muted)' }}>Match-up Duration</label>
                    <select className="input-field" value={matchupDuration} onChange={e => setMatchupDuration(e.target.value)} style={{ background: 'rgba(255,255,255,0.1)' }}>
                      <option value="1" style={{ color: '#000' }}>1 Week</option>
                      <option value="2" style={{ color: '#000' }}>2 Weeks</option>
                    </select>
                  </div>
                  <div>
                    <label style={{ display: 'block', marginBottom: '8px', color: 'var(--text-muted)' }}>Playoff Teams</label>
                    <select className="input-field" value={playoffTeams} onChange={e => setPlayoffTeams(e.target.value)} style={{ background: 'rgba(255,255,255,0.1)' }}>
                      <option value="2" style={{ color: '#000' }}>2 Teams</option>
                      <option value="4" style={{ color: '#000' }}>4 Teams</option>
                      <option value="6" style={{ color: '#000' }}>6 Teams</option>
                    </select>
                  </div>
                  <div>
                    <label style={{ display: 'block', marginBottom: '8px', color: 'var(--text-muted)' }}>Playoff Match-up Duration</label>
                    <select className="input-field" value={playoffDuration} onChange={e => setPlayoffDuration(e.target.value)} style={{ background: 'rgba(255,255,255,0.1)' }}>
                      <option value="1" style={{ color: '#000' }}>1 Week</option>
                      <option value="2" style={{ color: '#000' }}>2 Weeks</option>
                    </select>
                  </div>
                </div>
              </div>

              {/* Section 2: Roster Settings */}
              <div>
                <h3 style={{ fontSize: '1.2rem', color: 'var(--primary-color)', marginBottom: '16px', borderBottom: '1px solid var(--border-color)', paddingBottom: '8px' }}>2. Roster Sizes</h3>
                
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '24px' }}>
                   {/* Forwards */}
                   <div style={{ background: 'rgba(0,0,0,0.2)', padding: '16px', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
                    <div style={{ fontWeight: '600', marginBottom: '16px' }}>Forwards (F)</div>
                    <div style={{ display: 'flex', gap: '16px' }}>
                      <div style={{ flex: 1 }}>
                        <label style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Starters</label>
                        <input type="number" min="0" className="input-field" value={settings.forwards.starters} onChange={e => handleSettingChange('forwards', 'starters', e.target.value)} />
                      </div>
                      <div style={{ flex: 1 }}>
                        <label style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Max</label>
                        <input type="number" min="0" className="input-field" value={settings.forwards.max} onChange={e => handleSettingChange('forwards', 'max', e.target.value)} />
                      </div>
                    </div>
                  </div>

                  {/* Defense */}
                  <div style={{ background: 'rgba(0,0,0,0.2)', padding: '16px', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
                    <div style={{ fontWeight: '600', marginBottom: '16px' }}>Defense (D)</div>
                    <div style={{ display: 'flex', gap: '16px' }}>
                      <div style={{ flex: 1 }}>
                        <label style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Starters</label>
                        <input type="number" min="0" className="input-field" value={settings.defense.starters} onChange={e => handleSettingChange('defense', 'starters', e.target.value)} />
                      </div>
                      <div style={{ flex: 1 }}>
                        <label style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Max</label>
                        <input type="number" min="0" className="input-field" value={settings.defense.max} onChange={e => handleSettingChange('defense', 'max', e.target.value)} />
                      </div>
                    </div>
                  </div>

                  {/* Goalies */}
                  <div style={{ background: 'rgba(0,0,0,0.2)', padding: '16px', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
                    <div style={{ fontWeight: '600', marginBottom: '16px' }}>Goalies (G)</div>
                    <div style={{ display: 'flex', gap: '16px' }}>
                      <div style={{ flex: 1 }}>
                        <label style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Starters</label>
                        <input type="number" min="0" className="input-field" value={settings.goalies.starters} onChange={e => handleSettingChange('goalies', 'starters', e.target.value)} />
                      </div>
                      <div style={{ flex: 1 }}>
                        <label style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Max</label>
                        <input type="number" min="0" className="input-field" value={settings.goalies.max} onChange={e => handleSettingChange('goalies', 'max', e.target.value)} />
                      </div>
                    </div>
                  </div>
                  
                  {/* Bench & Total */}
                  <div style={{ background: 'rgba(0,0,0,0.2)', padding: '16px', borderRadius: '8px', border: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                     <div style={{ display: 'flex', gap: '16px' }}>
                      <div style={{ flex: 1 }}>
                        <label style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontWeight: '600' }}>Bench Slots (BN)</label>
                        <input type="number" min="0" className="input-field" value={settings.bench} onChange={e => setSettings(p => ({ ...p, bench: e.target.value }))} />
                      </div>
                      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: 'rgba(108, 92, 231, 0.1)', borderRadius: '8px', border: '1px solid rgba(108, 92, 231, 0.3)' }}>
                        <div style={{ fontSize: '0.8rem', color: 'var(--primary-color)', fontWeight: 'bold' }}>Total Size</div>
                        <div style={{ fontSize: '1.5rem', fontWeight: '800' }}>{totalTeamSize}</div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Section 3: Scoring */}
              <div>
                <h3 style={{ fontSize: '1.2rem', color: 'var(--primary-color)', marginBottom: '16px', borderBottom: '1px solid var(--border-color)', paddingBottom: '8px' }}>3. Scoring System</h3>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '24px' }}>
                   {/* Skaters */}
                   <div style={{ background: 'rgba(0,0,0,0.2)', padding: '24px', borderRadius: '12px', border: '1px solid var(--border-color)' }}>
                    <h4 style={{ color: 'var(--primary-color)', marginBottom: '16px', fontSize: '1rem', textTransform: 'uppercase', letterSpacing: '1px' }}>Skaters</h4>
                    <div style={{ display: 'grid', gap: '12px' }}>
                      {[
                        { key: 'goals', label: 'Goals (G)' },
                        { key: 'assists', label: 'Assists (A)' },
                        { key: 'plusMinus', label: 'Plus/Minus (+/-)' },
                        { key: 'ppp', label: 'Power Play Points (PPP)' },
                        { key: 'shp', label: 'Short Handed Points (SHP)' },
                        { key: 'sog', label: 'Shots on Goal (SOG)' },
                        { key: 'hits', label: 'Hits (HIT)' },
                        { key: 'blocks', label: 'Blocked Shots (BLK)' },
                        { key: 'defensePoints', label: 'Defense Points (DEF)' },
                      ].map(stat => (
                        <div key={stat.key} style={{ display: 'grid', gridTemplateColumns: '1fr 80px', gap: '16px', alignItems: 'center' }}>
                          <label style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>{stat.label}</label>
                          <input type="number" step="0.1" className="input-field" style={{ padding: '6px', textAlign: 'right' }} value={scoring.skaters[stat.key]} onChange={e => handleScoringChange('skaters', stat.key, e.target.value)} />
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Goalies */}
                  <div style={{ background: 'rgba(0,0,0,0.2)', padding: '24px', borderRadius: '12px', border: '1px solid var(--border-color)' }}>
                    <h4 style={{ color: 'var(--primary-color)', marginBottom: '16px', fontSize: '1rem', textTransform: 'uppercase', letterSpacing: '1px' }}>Goalies</h4>
                    <div style={{ display: 'grid', gap: '12px' }}>
                      {[
                        { key: 'wins', label: 'Wins (W)' },
                        { key: 'otl', label: 'Overtime Losses (OTL)' },
                        { key: 'ga', label: 'Goals Against (GA)' },
                        { key: 'saves', label: 'Saves (SV)' },
                        { key: 'shutouts', label: 'Shutouts (SHO)' },
                      ].map(stat => (
                        <div key={stat.key} style={{ display: 'grid', gridTemplateColumns: '1fr 80px', gap: '16px', alignItems: 'center' }}>
                          <label style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>{stat.label}</label>
                          <input type="number" step="0.1" className="input-field" style={{ padding: '6px', textAlign: 'right' }} value={scoring.goalies[stat.key]} onChange={e => handleScoringChange('goalies', stat.key, e.target.value)} />
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
              
              <div style={{ position: 'sticky', bottom: '20px', background: 'rgba(15,15,19,0.9)', padding: '16px', borderRadius: '12px', border: '1px solid var(--border-color)', backdropFilter: 'blur(10px)', zIndex: 10 }}>
                <button type="submit" className="btn-primary" disabled={createLoading} style={{ width: '100%', fontSize: '1.2rem', padding: '16px' }}>
                  {createLoading ? 'Creating League...' : 'Create League'}
                </button>
              </div>
            </form>
          </div>
        )}

        {activeTab === 'join' && (
          <div style={{ maxWidth: '500px' }}>
            <h2 style={{ fontSize: '1.5rem', marginBottom: '16px' }}>Join an Existing League</h2>
            <form onSubmit={handleJoinLeague} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              {joinError && <div className="error-message">{joinError}</div>}
              <div>
                <label style={{ display: 'block', marginBottom: '8px', color: 'var(--text-muted)' }}>Invite Code</label>
                <input 
                  type="text" 
                  className="input-field" 
                  value={joinCode} 
                  onChange={e => setJoinCode(e.target.value.toUpperCase())}
                  placeholder="Enter 6-character code"
                  maxLength={6}
                  required
                  style={{ textTransform: 'uppercase', letterSpacing: '2px', fontWeight: 'bold' }}
                />
              </div>
              <button type="submit" className="btn-primary" disabled={joinLoading || joinCode.length !== 6} style={{ marginTop: '8px' }}>
                {joinLoading ? 'Joining...' : 'Join League'}
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
