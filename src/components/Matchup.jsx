import React from 'react';

export default function Matchup({ activeLeagueId }) {
  if (!activeLeagueId) {
    return (
      <div className="dashboard-container" style={{ textAlign: 'center', padding: '100px 20px' }}>
        <h2>No Active League</h2>
        <p style={{ color: 'var(--text-muted)' }}>Select or join a league to view your matchups.</p>
      </div>
    );
  }

  return (
    <div className="dashboard-container">
      <header className="dashboard-header" style={{ marginBottom: '32px' }}>
        <h1>Matchup</h1>
        <p>Week 1 • Oct 14 - Oct 20</p>
      </header>

      <div style={{ display: 'flex', gap: '24px', alignItems: 'flex-start', flexWrap: 'wrap' }}>
        
        {/* Scoreboard / H2H Summary */}
        <div className="glass-panel" style={{ flex: '1 1 100%' }}>
          <h2 style={{ textAlign: 'center', marginBottom: '24px', color: 'var(--text-muted)', fontSize: '1rem', textTransform: 'uppercase', letterSpacing: '2px' }}>Current Matchup</h2>
          
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            {/* Team 1 (User) */}
            <div style={{ textAlign: 'center', flex: 1 }}>
              <div style={{ width: '80px', height: '80px', borderRadius: '50%', background: 'var(--primary-color)', margin: '0 auto 16px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '2rem', fontWeight: 'bold' }}>
                YT
              </div>
              <h3 style={{ fontSize: '1.5rem' }}>Your Team</h3>
              <p style={{ fontSize: '2.5rem', fontWeight: '800', marginTop: '8px' }}>142.5</p>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>Proj: 150.0</p>
            </div>
            
            {/* VS */}
            <div style={{ fontSize: '1.2rem', color: 'var(--text-muted)', fontWeight: 'bold', padding: '0 20px' }}>VS</div>
            
            {/* Team 2 (Opponent) */}
            <div style={{ textAlign: 'center', flex: 1 }}>
               <div style={{ width: '80px', height: '80px', borderRadius: '50%', background: 'rgba(255,255,255,0.1)', border: '2px solid var(--border-color)', margin: '0 auto 16px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '2rem', fontWeight: 'bold' }}>
                OP
              </div>
              <h3 style={{ fontSize: '1.5rem' }}>Opponent Team</h3>
              <p style={{ fontSize: '2.5rem', fontWeight: '800', marginTop: '8px' }}>128.0</p>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>Proj: 145.5</p>
            </div>
          </div>
        </div>

        {/* Breakdown Placeholder */}
        <div className="glass-panel" style={{ flex: '1 1 100%' }}>
          <h2 style={{ fontSize: '1.2rem', marginBottom: '16px' }}>Detailed Breakdown</h2>
          <p style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>Detailed category or player-by-player scoring comparison will go here.</p>
        </div>

      </div>
    </div>
  );
}
