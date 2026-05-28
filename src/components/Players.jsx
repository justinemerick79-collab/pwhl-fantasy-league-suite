import React, { useState } from 'react';

export default function Players({ activeLeagueId }) {
  const [filterAvailability, setFilterAvailability] = useState('all');
  const [filterTeam, setFilterTeam] = useState('all');
  const [filterPosition, setFilterPosition] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');

  if (!activeLeagueId) {
    return (
      <div className="dashboard-container" style={{ textAlign: 'center', padding: '100px 20px' }}>
        <h2>No Active League</h2>
        <p style={{ color: 'var(--text-muted)' }}>Select or join a league to view the player database.</p>
      </div>
    );
  }

  return (
    <div className="dashboard-container">
      <header className="dashboard-header" style={{ marginBottom: '32px' }}>
        <h1>Player Database</h1>
        <p>Scout, add, and evaluate PWHL talent.</p>
      </header>

      {/* Filter Bar */}
      <div className="glass-panel" style={{ marginBottom: '24px', padding: '16px 24px' }}>
        <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
          
          <input 
            type="text" 
            className="input-field" 
            placeholder="Search player name..." 
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{ minWidth: '200px', flex: 1 }}
          />

          <select className="input-field" value={filterAvailability} onChange={e => setFilterAvailability(e.target.value)} style={{ width: 'auto' }}>
            <option value="all">All Players</option>
            <option value="available">Available (Free Agents)</option>
            <option value="rostered">On Roster</option>
          </select>

          <select className="input-field" value={filterTeam} onChange={e => setFilterTeam(e.target.value)} style={{ width: 'auto' }}>
            <option value="all">All Teams</option>
            <option value="BOS">Boston</option>
            <option value="MIN">Minnesota</option>
            <option value="MTL">Montreal</option>
            <option value="NY">New York</option>
            <option value="OTT">Ottawa</option>
            <option value="TOR">Toronto</option>
          </select>

          <select className="input-field" value={filterPosition} onChange={e => setFilterPosition(e.target.value)} style={{ width: 'auto' }}>
            <option value="all">All Positions</option>
            <option value="skaters">All Skaters</option>
            <option value="F">Forwards</option>
            <option value="D">Defense</option>
            <option value="G">Goalies</option>
          </select>
        </div>
      </div>

      {/* Players Table Placeholder */}
      <div className="glass-panel" style={{ padding: 0, overflowX: 'auto' }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>Player</th>
              <th>Pos</th>
              <th>Team</th>
              <th>Status</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td colSpan="5" style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
                <em>Player database will load here. Backend integration pending.</em>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
