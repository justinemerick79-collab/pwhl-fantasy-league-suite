import React, { useState, useEffect } from 'react';
import { db } from '../firebase.js';
import { collection, query, where, getDocs } from 'firebase/firestore';
import { useAuth } from '../contexts/AuthContext';
import { submitAddDrop } from '../services/leagueService.js';

// Premium Complete PWHL Scouting Database
const PWHL_SCOUTING_POOL = [
  { id: "pwhl_1", name: "Marie-Philip Poulin", pos: "F", team: "MTL", rating: 94, stats: "2G, 1A, +3", points: 28.5 },
  { id: "pwhl_2", name: "Natalie Spooner", pos: "F", team: "TOR", rating: 92, stats: "3G, 1A, +2", points: 34.0 },
  { id: "pwhl_3", name: "Sarah Nurse", pos: "F", team: "TOR", rating: 89, stats: "1G, 1A, +1", points: 19.0 },
  { id: "pwhl_4", name: "Hilary Knight", pos: "F", team: "BOS", rating: 90, stats: "1G, 0A, -1", points: 14.5 },
  { id: "pwhl_5", name: "Alex Carpenter", pos: "F", team: "NY", rating: 88, stats: "1G, 2A, +1", points: 21.0 },
  { id: "pwhl_6", name: "Brianne Jenner", pos: "F", team: "OTT", rating: 87, stats: "0G, 2A, 0", points: 12.0 },
  { id: "pwhl_7", name: "Kendall Coyne Schofield", pos: "F", team: "MIN", rating: 89, stats: "1G, 1A, 0", points: 15.5 },
  { id: "pwhl_8", name: "Erin Ambrose", pos: "D", team: "MTL", rating: 91, stats: "0G, 3A, +2", points: 22.0 },
  { id: "pwhl_9", name: "Renata Fast", pos: "D", team: "TOR", rating: 90, stats: "1G, 0A, +1", points: 18.5 },
  { id: "pwhl_10", name: "Megan Keller", pos: "D", team: "BOS", rating: 89, stats: "0G, 2A, -1", points: 15.0 },
  { id: "pwhl_11", name: "Jocelyne Larocque", pos: "D", team: "TOR", rating: 86, stats: "0G, 1A, 0", points: 11.5 },
  { id: "pwhl_12", name: "Aerin Frankel", pos: "G", team: "BOS", rating: 93, stats: "2W, 58SV, 1.95GAA", points: 42.0 },
  { id: "pwhl_13", name: "Ann-Renée Desbiens", pos: "G", team: "MTL", rating: 91, stats: "1W, 54SV, 2.45GAA", points: 32.0 },
  { id: "pwhl_14", name: "Nicole Hensley", pos: "G", team: "MIN", rating: 88, stats: "1W, 52SV, 2.80GAA", points: 27.5 }
];

export default function Players({ activeLeagueId }) {
  const { currentUser } = useAuth();
  
  // Search & Filter state
  const [searchQuery, setSearchQuery] = useState('');
  const [filterPosition, setFilterPosition] = useState('all');
  const [filterTeam, setFilterTeam] = useState('all');
  const [filterAvailability, setFilterAvailability] = useState('all');

  // Active database loader states
  const [loading, setLoading] = useState(true);
  const [teamsList, setTeamsList] = useState([]);
  const [myTeam, setMyTeam] = useState(null);
  const [transactionLoading, setTransactionLoading] = useState(false);

  // Modal active state for Add/Drop trigger
  const [selectedScoutPlayer, setSelectedScoutPlayer] = useState(null);
  const [selectedDropPlayer, setSelectedDropPlayer] = useState('');

  // Load team data dynamically
  const fetchTeamsAndRosters = async () => {
    if (!activeLeagueId || !currentUser) return;
    setLoading(true);
    try {
      const snap = await getDocs(collection(db, `fantasy_leagues/${activeLeagueId}/teams`));
      const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      setTeamsList(list);

      const userTeam = list.find(t => t.ownerId === currentUser.uid);
      if (userTeam) {
        setMyTeam(userTeam);
      }
    } catch (err) {
      console.error("Error fetching teams for scouting:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTeamsAndRosters();
  }, [activeLeagueId, currentUser, transactionLoading]);

  if (!activeLeagueId) {
    return (
      <div className="min-h-[80vh] flex flex-col items-center justify-center px-6 text-center select-none">
        <div className="w-16 h-16 rounded-full bg-indigo-500/10 border border-indigo-500/25 flex items-center justify-center text-3xl mb-6 shadow-xl animate-pulse">
          🔍
        </div>
        <h2 className="text-xl font-bold text-white tracking-wide">No Active League</h2>
        <p className="text-xs text-gray-500 mt-2 max-w-sm leading-relaxed">
          Start scouting! Select an active league dashboard first to view the PWHL player database.
        </p>
      </div>
    );
  }

  // Map each player ID to its owner team document inside the league
  const getPlayerOwnerInfo = (playerId) => {
    const owningTeam = teamsList.find(t => (t.players || []).includes(playerId));
    if (!owningTeam) return { status: "available", label: "FA", color: "text-emerald-400 bg-emerald-500/10 border-emerald-500/15" };
    
    if (owningTeam.ownerId === currentUser.uid) {
      return { status: "mine", label: "Your Team", color: "text-indigo-400 bg-indigo-500/15 border-indigo-500/20" };
    }
    
    return { status: "rostered", label: owningTeam.teamName, color: "text-gray-400 bg-white/5 border-white/5" };
  };

  // Perform Add/Drop Transaction
  const handleScoutingTransaction = async () => {
    if (!activeLeagueId || !myTeam || !selectedScoutPlayer) return;
    setTransactionLoading(true);
    try {
      await submitAddDrop(
        activeLeagueId,
        myTeam.id,
        currentUser.uid,
        selectedScoutPlayer.id,
        selectedDropPlayer || null
      );
      alert(`Scouting Acquisition Successful! Added ${selectedScoutPlayer.name}.`);
      setSelectedScoutPlayer(null);
      setSelectedDropPlayer('');
    } catch (err) {
      console.error(err);
      alert(err.message || 'Acquisition transaction rejected.');
    } finally {
      setTransactionLoading(false);
    }
  };

  // Filter player list
  const filteredPlayers = PWHL_SCOUTING_POOL.filter(player => {
    // 1. Search filter
    const matchesSearch = player.name.toLowerCase().includes(searchQuery.toLowerCase());
    if (!matchesSearch) return false;

    // 2. Position filter
    if (filterPosition !== 'all') {
      if (filterPosition === 'skaters' && player.pos === 'G') return false;
      if (filterPosition !== 'skaters' && player.pos !== filterPosition) return false;
    }

    // 3. Team filter
    if (filterTeam !== 'all' && player.team !== filterTeam) return false;

    // 4. Availability filter
    const owner = getPlayerOwnerInfo(player.id);
    if (filterAvailability === 'available' && owner.status !== 'available') return false;
    if (filterAvailability === 'rostered' && owner.status === 'available') return false;

    return true;
  });

  return (
    <div className="min-h-screen bg-[#0f0f13] text-gray-100 px-4 pt-6 pb-24 select-none">
      
      {/* ── HEADER ── */}
      <header className="mb-6">
        <span className="text-[9px] uppercase font-extrabold tracking-widest text-indigo-400 bg-indigo-500/10 px-2.5 py-0.5 rounded-full border border-indigo-500/15">
          Scouting Database
        </span>
        <h1 className="text-2xl font-black mt-2 tracking-tight bg-gradient-to-r from-white via-gray-200 to-gray-400 bg-clip-text text-transparent">
          PWHL Athletes
        </h1>
        <p className="text-xs text-gray-500 font-semibold mt-1">Research stats, evaluate availability, and secure free agents.</p>
      </header>

      {/* ── SEARCH & FILTER CONTROLS ── */}
      <div className="bg-white/[0.02] border border-white/5 p-4 rounded-3xl mb-6 space-y-3">
        <input 
          type="text" 
          placeholder="Search athlete by name..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full bg-black/40 border border-white/10 rounded-2xl px-4 py-3 text-xs text-white focus:outline-none focus:border-indigo-500"
        />
        
        <div className="grid grid-cols-3 gap-2.5">
          {/* Availability */}
          <select 
            value={filterAvailability} 
            onChange={(e) => setFilterAvailability(e.target.value)}
            className="bg-black/40 border border-white/10 rounded-xl px-2.5 py-2.5 text-[10px] font-bold text-gray-400 focus:outline-none"
          >
            <option value="all" className="text-black">All Players</option>
            <option value="available" className="text-black">Free Agents</option>
            <option value="rostered" className="text-black">Rostered Only</option>
          </select>

          {/* Position */}
          <select 
            value={filterPosition} 
            onChange={(e) => setFilterPosition(e.target.value)}
            className="bg-black/40 border border-white/10 rounded-xl px-2.5 py-2.5 text-[10px] font-bold text-gray-400 focus:outline-none"
          >
            <option value="all" className="text-black">All Roles</option>
            <option value="skaters" className="text-black">Skaters Only</option>
            <option value="F" className="text-black">Forwards</option>
            <option value="D" className="text-black">Defense</option>
            <option value="G" className="text-black">Goalies</option>
          </select>

          {/* PWHL Team */}
          <select 
            value={filterTeam} 
            onChange={(e) => setFilterTeam(e.target.value)}
            className="bg-black/40 border border-white/10 rounded-xl px-2.5 py-2.5 text-[10px] font-bold text-gray-400 focus:outline-none"
          >
            <option value="all" className="text-black">All Teams</option>
            {["BOS", "MIN", "MTL", "NY", "OTT", "TOR"].map(t => (
              <option key={t} value={t} className="text-black">{t}</option>
            ))}
          </select>
        </div>
      </div>

      {/* ── SCOUTING ROSTER LIST ── */}
      {loading ? (
        <div className="py-20 text-center text-gray-500 text-xs font-black tracking-widest animate-pulse">Syncing scouts database...</div>
      ) : filteredPlayers.length === 0 ? (
        <div className="text-center py-16 text-xs text-gray-500 italic border border-dashed border-white/5 rounded-2xl">
          No athletes matching scouting criteria found.
        </div>
      ) : (
        <div className="space-y-3.5">
          {filteredPlayers.map(athlete => {
            const owner = getPlayerOwnerInfo(athlete.id);
            const isFA = owner.status === 'available';

            return (
              <div 
                key={athlete.id} 
                className="bg-white/[0.02] border border-white/5 p-4 rounded-2xl flex justify-between items-center transition-all hover:bg-white/[0.04]"
              >
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-[9px] font-black text-gray-400 bg-white/5 px-1.5 py-0.5 rounded border border-white/5">{athlete.pos}</span>
                    <span className="text-[10px] text-gray-400 font-bold">{athlete.team}</span>
                    <span className="text-xs font-black text-white">{athlete.name}</span>
                  </div>
                  <p className="text-[9px] text-gray-500 font-semibold mt-1 uppercase tracking-wider">{athlete.stats}</p>
                  <p className="text-[10px] text-indigo-400 font-bold mt-0.5">{athlete.points.toFixed(1)} pts</p>
                </div>

                <div className="flex items-center gap-3">
                  {/* Status Indicator */}
                  <span className={`text-[9px] font-black uppercase px-2.5 py-1 rounded-lg border tracking-wider text-center max-w-[90px] truncate ${owner.color}`}>
                    {owner.label}
                  </span>

                  {/* Acquire CTA (Only for Free Agents) */}
                  {isFA && myTeam && (
                    <button
                      onClick={() => setSelectedScoutPlayer(athlete)}
                      className="px-3.5 py-2 bg-gradient-to-r from-indigo-600 to-violet-500 hover:from-indigo-500 hover:to-violet-400 text-[10px] font-black uppercase tracking-wider rounded-xl text-white active:scale-95 transition-transform"
                    >
                      Acquire
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── ACQUIRE TRANSACTION DIALOG ── */}
      {selectedScoutPlayer && myTeam && (
        <div className="fixed inset-0 bg-black/85 backdrop-blur-sm flex items-center justify-center p-6 z-50">
          <div className="w-full max-w-sm bg-[#16161c] border border-white/10 rounded-3xl p-6 shadow-2xl relative">
            <h3 className="text-sm font-black uppercase text-gray-400 tracking-wider">Scouting Waiver Pickup</h3>
            
            <div className="mt-4 p-4 rounded-2xl bg-white/[0.02] border border-white/5">
              <span className="text-[9px] uppercase font-extrabold tracking-widest text-indigo-400 bg-indigo-500/10 px-2 py-0.5 rounded border border-indigo-500/15">ACQUIRE</span>
              <p className="text-sm font-black text-white mt-2">{selectedScoutPlayer.name}</p>
              <p className="text-[10px] text-gray-500 mt-0.5">{selectedScoutPlayer.pos} • {selectedScoutPlayer.team}</p>
            </div>

            <div className="mt-4">
              <label className="block text-[10px] uppercase font-black tracking-widest text-gray-500 mb-2">Designated Drop Player</label>
              <select 
                value={selectedDropPlayer} 
                onChange={e => setSelectedDropPlayer(e.target.value)}
                className="w-full bg-black/40 border border-white/10 rounded-2xl px-4 py-3 text-xs text-white focus:outline-none"
              >
                <option value="" className="text-black">No Player (Add Only)</option>
                {(myTeam.players || []).map(pId => {
                  const pDetail = PWHL_SCOUTING_POOL.find(p => p.id === pId) || { name: pId };
                  return <option key={pId} value={pId} className="text-black">Drop: {pDetail.name}</option>;
                })}
              </select>
              <p className="text-[9px] text-gray-600 mt-2">Note: Dropped athletes will be placed on waivers for 48 hours.</p>
            </div>

            <div className="flex gap-3 mt-6">
              <button 
                onClick={() => {
                  setSelectedScoutPlayer(null);
                  setSelectedDropPlayer('');
                }}
                disabled={transactionLoading}
                className="flex-1 py-3.5 bg-white/5 hover:bg-white/10 border border-white/5 rounded-2xl text-[10px] font-black uppercase text-gray-400 tracking-wider active:scale-95 transition-transform"
              >
                Cancel
              </button>
              <button 
                onClick={handleScoutingTransaction}
                disabled={transactionLoading}
                className="flex-1 py-3.5 bg-gradient-to-r from-indigo-600 to-violet-500 rounded-2xl text-[10px] font-black uppercase text-white tracking-wider active:scale-95 transition-transform shadow-lg"
              >
                {transactionLoading ? 'Executing...' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
