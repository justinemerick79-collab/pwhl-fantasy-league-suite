import React, { useState, useEffect } from 'react';
import './index.css';
import AuthModal from './components/AuthModal';
import AdminPanel from './components/AdminPanel';
import DataHub from './components/DataHub';
import LeagueHub from './components/LeagueHub';
import Matchup from './components/Matchup';
import Roster from './components/Roster';
import Players from './components/Players';
import League from './components/League';
import { useAuth } from './contexts/AuthContext';
import { db } from './firebase';
import { collection, query, where, getDocs } from 'firebase/firestore';

function App() {
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [currentView, setCurrentView] = useState('matchup'); // 'matchup', 'roster', 'players', 'leagueCentral', 'admin', 'league'
  
  const [activeLeagueId, setActiveLeagueId] = useState(localStorage.getItem('pwhl_active_league') || null);
  const [activeLeagueName, setActiveLeagueName] = useState('Create or Join League');
  const [isAccountMenuOpen, setIsAccountMenuOpen] = useState(false);
  
  const { currentUser, isAdmin, logout } = useAuth();

  useEffect(() => {
    if (!currentUser) return;
    
    async function fetchUserLeagues() {
      try {
        const q = query(collection(db, 'fantasy_leagues'), where('members', 'array-contains', currentUser.uid));
        const snap = await getDocs(q);
        const leagues = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        
        if (leagues.length > 0) {
          let selected = leagues.find(l => l.id === activeLeagueId);
          if (!selected) {
            selected = leagues[0];
            handleSetActiveLeague(selected.id);
          }
          setActiveLeagueName(selected.name);
        } else {
          setActiveLeagueName('Create or Join League');
        }
      } catch (err) {
        console.error("Error fetching leagues for nav:", err);
      }
    }
    
    fetchUserLeagues();
  }, [currentUser, activeLeagueId]);

  const handleSetActiveLeague = (id) => {
    setActiveLeagueId(id);
    localStorage.setItem('pwhl_active_league', id);
  };

  return (
    <>
      <nav className="nav-bar">
        <div style={{ display: 'flex', alignItems: 'center', gap: '32px' }}>
          <div className="nav-brand" onClick={() => setCurrentView('matchup')} style={{cursor: 'pointer'}}>PWHL Fantasy</div>
          
          {currentUser && (
            <div 
              style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', background: 'rgba(255,255,255,0.05)', padding: '6px 12px', borderRadius: '8px', border: '1px solid var(--border-color)' }}
              onClick={() => setCurrentView('league')}
              title="Change Active League"
            >
              <span style={{ fontSize: '0.9rem', fontWeight: '600', color: 'var(--text-main)' }}>{activeLeagueName}</span>
              <span style={{ fontSize: '0.8rem', color: 'var(--primary-color)' }}>⚙️</span>
            </div>
          )}
        </div>
        
        <div className="nav-links">
          <a href="#" onClick={(e) => { e.preventDefault(); setCurrentView('matchup'); }} style={{ color: currentView === 'matchup' ? 'var(--primary-color)' : 'var(--text-muted)' }}>Matchup</a>
          <a href="#" onClick={(e) => { e.preventDefault(); setCurrentView('roster'); }} style={{ color: currentView === 'roster' ? 'var(--primary-color)' : 'var(--text-muted)' }}>Roster</a>
          <a href="#" onClick={(e) => { e.preventDefault(); setCurrentView('players'); }} style={{ color: currentView === 'players' ? 'var(--primary-color)' : 'var(--text-muted)' }}>Players</a>
          <a href="#" onClick={(e) => { e.preventDefault(); setCurrentView('leagueCentral'); }} style={{ color: currentView === 'leagueCentral' ? 'var(--primary-color)' : 'var(--text-muted)' }}>League</a>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          {currentUser ? (
            <div className="account-menu-container">
              <button 
                className="btn-secondary" 
                onClick={() => setIsAccountMenuOpen(!isAccountMenuOpen)}
                style={{ display: 'flex', alignItems: 'center', gap: '8px' }}
              >
                Account
                <span style={{ fontSize: '0.8em' }}>▼</span>
              </button>
              
              {isAccountMenuOpen && (
                <div className="account-dropdown">
                  <div style={{ padding: '8px 20px', color: 'var(--text-muted)', fontSize: '0.85rem', wordBreak: 'break-all' }}>
                    Signed in as<br/><strong style={{ color: 'var(--text-main)' }}>{currentUser.email}</strong>
                  </div>
                  <div className="account-dropdown-divider"></div>
                  
                  <button className="account-dropdown-item" onClick={() => { setCurrentView('league'); setIsAccountMenuOpen(false); }}>
                    My Leagues
                  </button>
                  
                  {isAdmin && (
                    <button className="account-dropdown-item" onClick={() => { setCurrentView('admin'); setIsAccountMenuOpen(false); }}>
                      Admin Console
                    </button>
                  )}
                  
                  <div className="account-dropdown-divider"></div>
                  
                  <button className="account-dropdown-item" onClick={() => { logout(); setIsAccountMenuOpen(false); }}>
                    Sign Out
                  </button>
                </div>
              )}
            </div>
          ) : (
            <button className="btn-primary" onClick={() => setIsAuthModalOpen(true)}>Sign In</button>
          )}
        </div>
      </nav>

      {currentView === 'matchup' && <Matchup activeLeagueId={activeLeagueId} />}
      {currentView === 'roster' && <Roster activeLeagueId={activeLeagueId} />}
      {currentView === 'players' && <Players activeLeagueId={activeLeagueId} />}
      {currentView === 'leagueCentral' && <League activeLeagueId={activeLeagueId} />}

      {currentView === 'admin' && <AdminPanel />}
      {currentView === 'league' && <LeagueHub activeLeagueId={activeLeagueId} setActiveLeagueId={handleSetActiveLeague} />}

      <AuthModal isOpen={isAuthModalOpen} onClose={() => setIsAuthModalOpen(false)} />
    </>
  );
}

export default App;
