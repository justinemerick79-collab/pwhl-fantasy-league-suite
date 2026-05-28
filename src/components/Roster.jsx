import React from 'react';

export default function Roster({ activeLeagueId }) {
  if (!activeLeagueId) {
    return (
      <div className="dashboard-container" style={{ textAlign: 'center', padding: '100px 20px' }}>
        <h2>No Active League</h2>
        <p style={{ color: 'var(--text-muted)' }}>Select or join a league to view your roster.</p>
      </div>
    );
  }

  // Placeholder static roster data
  const rosterSlots = [
    { pos: 'F', player: 'Marie-Philip Poulin', team: 'MTL', stats: '4G, 2A' },
    { pos: 'F', player: 'Sarah Nurse', team: 'TOR', stats: '2G, 3A' },
    { pos: 'F', player: 'Taylor Heise', team: 'MIN', stats: '3G, 1A' },
    { pos: 'D', player: 'Megan Keller', team: 'BOS', stats: '1G, 4A' },
    { pos: 'D', player: 'Erin Ambrose', team: 'MTL', stats: '0G, 5A' },
    { pos: 'G', player: 'Aerin Frankel', team: 'BOS', stats: '2W, .930 SV%' },
    { pos: 'BN', player: 'Empty', team: '', stats: '' },
    { pos: 'BN', player: 'Empty', team: '', stats: '' },
  ];

  return (
    <div className="dashboard-container">
      <header className="dashboard-header" style={{ marginBottom: '32px' }}>
        <h1>My Roster</h1>
        <p>Manage your starting lineup and bench.</p>
      </header>

      <div className="glass-panel" style={{ padding: 0, overflow: 'hidden' }}>
        <table className="data-table">
          <thead>
            <tr>
              <th style={{ width: '80px', textAlign: 'center' }}>Pos</th>
              <th>Player</th>
              <th>Team</th>
              <th>Recent Stats</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {rosterSlots.map((slot, idx) => (
              <tr key={idx}>
                <td style={{ textAlign: 'center' }}>
                  <span className={`pill ${slot.pos === 'BN' ? '' : 'pill-primary'}`} style={{ opacity: slot.pos === 'BN' ? 0.5 : 1 }}>
                    {slot.pos}
                  </span>
                </td>
                <td style={{ fontWeight: slot.player === 'Empty' ? 'normal' : '600', color: slot.player === 'Empty' ? 'var(--text-muted)' : 'var(--text-main)', fontStyle: slot.player === 'Empty' ? 'italic' : 'normal' }}>
                  {slot.player}
                </td>
                <td style={{ color: 'var(--text-muted)' }}>{slot.team || '-'}</td>
                <td style={{ color: 'var(--text-muted)' }}>{slot.stats || '-'}</td>
                <td>
                  <button className="text-btn" style={{ fontSize: '0.85rem' }}>Move</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
