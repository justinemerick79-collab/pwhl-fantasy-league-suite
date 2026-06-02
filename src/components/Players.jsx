import React, { useState, useEffect } from 'react';
import { db } from '../firebase.js';
import { doc, getDoc, collection, query, where, getDocs } from 'firebase/firestore';
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
  const [loadingLeague, setLoadingLeague] = useState(true);
  const [teamsList, setTeamsList] = useState([]);
  const [myTeam, setMyTeam] = useState(null);
  const [leagueData, setLeagueData] = useState(null);
  const [transactionLoading, setTransactionLoading] = useState(false);

  // Modal active state for Add/Drop trigger
  const [selectedScoutPlayer, setSelectedScoutPlayer] = useState(null);
  const [selectedDropPlayer, setSelectedDropPlayer] = useState('');

  // Fetch league status details
  useEffect(() => {
    if (!activeLeagueId) return;
    setLoadingLeague(true);
    const docRef = doc(db, 'fantasy_leagues', activeLeagueId);
    getDoc(docRef).then((snap) => {
      if (snap.exists()) {
        setLeagueData(snap.data());
      }
      setLoadingLeague(false);
    }).catch(err => {
      console.error("Error loading league status:", err);
      setLoadingLeague(false);
    });
  }, [activeLeagueId]);

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
        <div className="w-16 h-16 rounded-full bg-indigo-50 border border-indigo-100 flex items-center justify-center text-3xl mb-6 shadow-sm animate-pulse">
          🔍
        </div>
        <h2 className="text-xl font-sports font-black text-gray-900 tracking-tight">No Active League</h2>
        <p className="text-xs text-gray-500 mt-2 max-w-sm font-semibold leading-relaxed">
          Start scouting! Select an active league dashboard first to view the PWHL player database.
        </p>
      </div>
    );
  }

  if (loading || loadingLeague) {
    return (
      <div className="min-h-[80vh] flex items-center justify-center">
        <div className="text-xs font-black tracking-widest text-gray-400 uppercase animate-pulse">
          Syncing scouts database...
        </div>
      </div>
    );
  }

  const isPending = leagueData && (
    leagueData.status === 'pending' || 
    (leagueData.members && leagueData.members.length < leagueData.maxTeams) || 
    !leagueData.draftDate
  );

  // Map each player ID to its owner team document inside the league
  const getPlayerOwnerInfo = (playerId) => {
    const owningTeam = teamsList.find(t => (t.players || []).includes(playerId));
    if (!owningTeam) return { status: "available", label: "FA", color: "text-emerald-600 bg-emerald-50 border-emerald-100" };
    
    if (owningTeam.ownerId === currentUser.uid) {
      return { status: "mine", label: "Your Team", color: "text-indigo-600 bg-indigo-50 border-indigo-100" };
    }
    
    return { status: "rostered", label: owningTeam.teamName, color: "text-gray-500 bg-gray-50 border-gray-200" };
  };

  // Perform Add/Drop Transaction
  const handleScoutingTransaction = async () => {
    if (isPending) return;
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
    <div className="font-sans select-none antialiased">
      
      {/* ── HEADER ── */}
      <header className="mb-6">
        <span className="text-[10px] uppercase font-black tracking-widest text-indigo-600 bg-indigo-50 px-3 py-1.5 rounded-full border border-indigo-100 shadow-sm shadow-indigo-100/10">
          Scouting Database
        </span>
        <h1 className="font-sports text-3xl font-black mt-3 tracking-tight text-gray-900">
          PWHL Athletes
        </h1>
        <p className="text-xs text-gray-400 font-semibold tracking-wide mt-0.5">Research stats, evaluate availability, and secure free agents.</p>
      </header>

      {/* ── CENTRAL ACQUISITIONS LOCKED BANNER (Pre-Draft) ── */}
      {isPending && (
        <div className="mb-6 p-4.5 bg-indigo-50 border border-indigo-100 rounded-3xl flex items-center gap-3.5 animate-scale-up">
          <div className="w-10 h-10 rounded-2xl bg-white border border-indigo-100 flex items-center justify-center text-xl text-indigo-600 shadow-sm animate-pulse">
            🔒
          </div>
          <div>
            <h4 className="text-xs font-black uppercase tracking-wider text-indigo-900">Acquisitions Locked</h4>
            <p className="text-[10px] text-indigo-500 font-semibold mt-0.5 leading-normal">Player pool acquisitions are locked until the draft completes.</p>
          </div>
        </div>
      )}

      {/* ── RESPONSIVE DESKTOP SPLIT GRID ── */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        
        {/* LEFT COLUMN: FILTERS SIDEBAR (lg:col-span-4 - sticky on desktop!) */}
        <div className="lg:col-span-4 lg:sticky lg:top-24 space-y-4">
          <h3 className="text-xs font-black uppercase tracking-wider text-gray-400 mb-1 hidden lg:block">🔍 Search & Filters</h3>
          <div className="bg-white border border-gray-200 p-5 rounded-[28px] shadow-sm space-y-4">
            <div>
              <label className="block text-[9px] uppercase font-black text-gray-400 mb-2">Search Athlete</label>
              <input 
                type="text" 
                placeholder="Type name..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-gray-50 border border-gray-200 rounded-2xl px-4 py-3 text-xs text-gray-800 placeholder-gray-400 focus:outline-none focus:bg-white focus:border-indigo-500 shadow-inner"
              />
            </div>
            
            <div className="space-y-3.5">
              {/* Availability */}
              <div>
                <label className="block text-[9px] uppercase font-black text-gray-400 mb-2">Availability</label>
                <select 
                  value={filterAvailability} 
                  onChange={(e) => setFilterAvailability(e.target.value)}
                  className="w-full bg-white border border-gray-200 rounded-xl px-3 py-2.5 text-[10px] font-black text-gray-500 focus:outline-none focus:border-indigo-500 shadow-sm"
                >
                  <option value="all">All Players</option>
                  <option value="available">Free Agents</option>
                  <option value="rostered">Rostered Only</option>
                </select>
              </div>

              {/* Position */}
              <div>
                <label className="block text-[9px] uppercase font-black text-gray-400 mb-2">Role/Position</label>
                <select 
                  value={filterPosition} 
                  onChange={(e) => setFilterPosition(e.target.value)}
                  className="w-full bg-white border border-gray-200 rounded-xl px-3 py-2.5 text-[10px] font-black text-gray-500 focus:outline-none focus:border-indigo-500 shadow-sm"
                >
                  <option value="all">All Roles</option>
                  <option value="skaters">Skaters Only</option>
                  <option value="F">Forwards</option>
                  <option value="D">Defense</option>
                  <option value="G">Goalies</option>
                </select>
              </div>

              {/* PWHL Team */}
              <div>
                <label className="block text-[9px] uppercase font-black text-gray-400 mb-2">PWHL Team</label>
                <select 
                  value={filterTeam} 
                  onChange={(e) => setFilterTeam(e.target.value)}
                  className="w-full bg-white border border-gray-200 rounded-xl px-3 py-2.5 text-[10px] font-black text-gray-500 focus:outline-none focus:border-indigo-500 shadow-sm"
                >
                  <option value="all">All Teams</option>
                  {["BOS", "MIN", "MTL", "NY", "OTT", "TOR"].map(t => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>
        </div>

        {/* RIGHT COLUMN: SEARCH SCOUTING LIST (lg:col-span-8) */}
        <div className="lg:col-span-8 space-y-4">
          <h3 className="text-xs font-black uppercase tracking-wider text-gray-400 mb-1 hidden lg:block">📈 Star Scouting Pool</h3>
          
          {filteredPlayers.length === 0 ? (
            <div className="text-center py-20 text-xs text-gray-400 font-bold italic border border-dashed border-gray-300 rounded-[32px] bg-white/50 shadow-sm">
              No athletes matching scouting criteria found.
            </div>
          ) : (
            <div className="space-y-4">
              
              {/* Mobile View Lists */}
              <div className="block md:hidden space-y-3">
                {filteredPlayers.map(athlete => {
                  const owner = getPlayerOwnerInfo(athlete.id);
                  const isFA = owner.status === 'available';

                  return (
                    <div 
                      key={athlete.id} 
                      className="bg-white border border-gray-200 p-4.5 rounded-2xl flex justify-between items-center transition-all shadow-sm hover:shadow-md"
                    >
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-[9px] font-black text-gray-500 bg-gray-50 px-1.5 py-0.5 rounded border border-gray-200">{athlete.pos}</span>
                          <span className="text-[10px] text-gray-400 font-bold">{athlete.team}</span>
                          <span className="text-xs font-black text-gray-800">{athlete.name}</span>
                        </div>
                        <p className="text-[9px] text-gray-400 font-black uppercase mt-1 tracking-wider">{athlete.stats}</p>
                        <p className="text-[10px] text-indigo-600 font-black mt-0.5">{athlete.points.toFixed(1)} pts</p>
                      </div>

                      <div className="flex items-center gap-3">
                        <span className={`text-[9px] font-black uppercase px-2.5 py-1 rounded-lg border tracking-wider text-center max-w-[120px] truncate ${owner.color}`}>
                          {owner.label}
                        </span>

                        {isFA && myTeam && !isPending && (
                          <button
                            onClick={() => setSelectedScoutPlayer(athlete)}
                            className="px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-[10px] font-black uppercase tracking-wider rounded-xl text-white active:scale-95 transition-transform shadow-md shadow-indigo-600/10"
                          >
                            Acquire
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Desktop View Sports Cards Grids */}
              <div className="hidden md:grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {filteredPlayers.map(athlete => {
                  const owner = getPlayerOwnerInfo(athlete.id);
                  const isFA = owner.status === 'available';

                  // Choose theme colors based on position
                  let posColorClass = "border-indigo-100 bg-indigo-50 text-indigo-600";
                  if (athlete.pos === 'D') {
                    posColorClass = "border-emerald-100 bg-emerald-50 text-emerald-600";
                  } else if (athlete.pos === 'G') {
                    posColorClass = "border-purple-100 bg-purple-50 text-purple-600";
                  }

                  return (
                    <div 
                      key={athlete.id}
                      className="bg-white border border-gray-200 rounded-[24px] p-4 flex flex-col justify-between shadow-sm relative overflow-hidden transition-all duration-200 hover:shadow-md hover:border-indigo-200 min-h-[160px]"
                    >
                      {/* Top Bar: Position and Rating */}
                      <div className="flex justify-between items-start">
                        <span className={`text-[9px] font-black uppercase px-2.5 py-1 rounded-lg border tracking-widest shadow-inner ${posColorClass}`}>
                          {athlete.pos}
                        </span>
                        
                        <div className="text-right">
                          <span className="font-sports text-lg font-bold text-gray-800 leading-none block">{athlete.rating}</span>
                          <span className="text-[9px] font-black text-gray-400 uppercase tracking-widest mt-0.5 block">OVR</span>
                        </div>
                      </div>

                      {/* Middle: Details */}
                      <div className="my-3">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[9px] font-black text-gray-500 bg-gray-50 px-1 rounded border border-gray-200">{athlete.team}</span>
                          <span className="text-xs font-black text-gray-800 truncate block">{athlete.name}</span>
                        </div>
                        <span className="text-[9px] text-gray-400 font-bold uppercase tracking-wider block mt-1 truncate">{athlete.stats}</span>
                      </div>

                      {/* Bottom Bar: Points and Actions */}
                      <div className="flex justify-between items-center pt-2.5 border-t border-gray-100 gap-2">
                        <div>
                          <span className="text-sm font-sports font-bold text-indigo-600 leading-none">{athlete.points.toFixed(1)}</span>
                          <span className="text-[8px] font-black text-gray-400 uppercase tracking-widest ml-1">pts</span>
                        </div>

                        <div className="flex items-center gap-1.5 max-w-[60%] shrink-0">
                          <span className={`text-[8.5px] font-black uppercase px-2 py-1 rounded-lg border tracking-wider text-center truncate ${owner.color}`}>
                            {owner.label === 'Your Team' ? 'Mine' : (owner.label === 'FA' ? 'FA' : owner.label)}
                          </span>

                          {isFA && myTeam && !isPending && (
                            <button
                              onClick={() => setSelectedScoutPlayer(athlete)}
                              className="px-2.5 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-[9px] font-black uppercase tracking-wider rounded-lg text-white active:scale-95 transition-all shadow-md shadow-indigo-600/10"
                            >
                              Add
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

            </div>
          )}
        </div>


      </div>

      {/* ── ACQUIRE TRANSACTION DIALOG ── */}
      {selectedScoutPlayer && myTeam && !isPending && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-sm flex items-center justify-center p-6 z-50">
          <div className="w-full max-w-sm bg-white border border-gray-200 rounded-[32px] p-6 shadow-2xl relative animate-scale-up">
            <h3 className="text-xs font-black uppercase text-gray-400 tracking-wider">Scouting Waiver Pickup</h3>
            
            <div className="mt-4 p-4 rounded-2xl bg-gray-50 border border-gray-200">
              <span className="text-[9px] uppercase font-black tracking-widest text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded border border-indigo-100">ACQUIRE</span>
              <p className="text-sm font-black text-gray-800 mt-2">{selectedScoutPlayer.name}</p>
              <p className="text-[10px] text-gray-400 font-bold mt-0.5">{selectedScoutPlayer.pos} • {selectedScoutPlayer.team}</p>
            </div>

            <div className="mt-4">
              <label className="block text-[10px] uppercase font-black tracking-widest text-gray-500 mb-2">Designated Drop Player</label>
              <select 
                value={selectedDropPlayer} 
                onChange={e => setSelectedDropPlayer(e.target.value)}
                className="w-full bg-white border border-gray-200 rounded-2xl px-4 py-3.5 text-xs text-gray-700 focus:outline-none focus:border-indigo-500 shadow-sm"
              >
                <option value="">No Player (Add Only)</option>
                {(myTeam.players || []).map(pId => {
                  const pDetail = PWHL_SCOUTING_POOL.find(p => p.id === pId) || { name: pId };
                  return <option key={pId} value={pId}>Drop: {pDetail.name}</option>;
                })}
              </select>
              <p className="text-[9px] text-gray-400 font-semibold mt-2">Note: Dropped athletes will be placed on waivers for 48 hours.</p>
            </div>

            <div className="flex gap-3 mt-6">
              <button 
                onClick={() => {
                  setSelectedScoutPlayer(null);
                  setSelectedDropPlayer('');
                }}
                disabled={transactionLoading}
                className="flex-1 py-3.5 bg-gray-50 hover:bg-gray-100 border border-gray-200 rounded-2xl text-[10px] font-black uppercase text-gray-500 tracking-wider active:scale-95 transition-transform"
              >
                Cancel
              </button>
              <button 
                onClick={handleScoutingTransaction}
                disabled={transactionLoading}
                className="flex-1 py-3.5 bg-gradient-to-r from-indigo-600 to-violet-600 text-[10px] font-black uppercase text-white tracking-wider rounded-2xl active:scale-95 transition-transform shadow-md shadow-indigo-600/10"
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
