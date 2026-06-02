import React, { useState, useEffect } from 'react';
import { db } from '../firebase.js';
import { doc, getDoc, collection, query, where, getDocs } from 'firebase/firestore';
import { useAuth } from '../contexts/AuthContext';

// Consolidated Star Athlete Database
const PWHL_ATHLETES_DB = {
  pwhl_1: { name: "Marie-Philip Poulin", pos: "F", team: "MTL", rating: 94, stats: "2G, 1A, +3", points: 28.5 },
  pwhl_2: { name: "Natalie Spooner", pos: "F", team: "TOR", rating: 92, stats: "3G, 1A, +2", points: 34.0 },
  pwhl_3: { name: "Sarah Nurse", pos: "F", team: "TOR", rating: 89, stats: "1G, 1A, +1", points: 19.0 },
  pwhl_4: { name: "Hilary Knight", pos: "F", team: "BOS", rating: 90, stats: "1G, 0A, -1", points: 14.5 },
  pwhl_5: { name: "Alex Carpenter", pos: "F", team: "NY", rating: 88, stats: "1G, 2A, +1", points: 21.0 },
  pwhl_6: { name: "Brianne Jenner", pos: "F", team: "OTT", rating: 87, stats: "0G, 2A, 0", points: 12.0 },
  pwhl_7: { name: "Kendall Coyne Schofield", pos: "F", team: "MIN", rating: 89, stats: "1G, 1A, 0", points: 15.5 },
  pwhl_8: { name: "Erin Ambrose", pos: "D", team: "MTL", rating: 91, stats: "0G, 3A, +2", points: 22.0 },
  pwhl_9: { name: "Renata Fast", pos: "D", team: "TOR", rating: 90, stats: "1G, 0A, +1", points: 18.5 },
  pwhl_10: { name: "Megan Keller", pos: "D", team: "BOS", rating: 89, stats: "0G, 2A, -1", points: 15.0 },
  pwhl_11: { name: "Jocelyne Larocque", pos: "D", team: "TOR", rating: 86, stats: "0G, 1A, 0", points: 11.5 },
  pwhl_12: { name: "Aerin Frankel", pos: "G", team: "BOS", rating: 93, stats: "2W, 58SV, 1.95GAA", points: 42.0 },
  pwhl_13: { name: "Ann-Renée Desbiens", pos: "G", team: "MTL", rating: 91, stats: "1W, 54SV, 2.45GAA", points: 32.0 },
  pwhl_14: { name: "Nicole Hensley", pos: "G", team: "MIN", rating: 88, stats: "1W, 52SV, 2.80GAA", points: 27.5 }
};

export default function Roster({ activeLeagueId }) {
  const { currentUser } = useAuth();
  const [loading, setLoading] = useState(true);
  const [loadingLeague, setLoadingLeague] = useState(true);
  const [myTeam, setMyTeam] = useState(null);
  const [leagueData, setLeagueData] = useState(null);

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
      console.error("Error fetching league status:", err);
      setLoadingLeague(false);
    });
  }, [activeLeagueId]);

  useEffect(() => {
    if (!activeLeagueId || !currentUser) return;
    
    async function fetchUserRoster() {
      setLoading(true);
      try {
        const q = query(
          collection(db, `fantasy_leagues/${activeLeagueId}/teams`), 
          where('ownerId', '==', currentUser.uid)
        );
        const snap = await getDocs(q);
        if (!snap.empty) {
          setMyTeam({ id: snap.docs[0].id, ...snap.docs[0].data() });
        } else {
          setMyTeam(null);
        }
      } catch (err) {
        console.error("Error fetching user roster:", err);
      } finally {
        setLoading(false);
      }
    }
    fetchUserRoster();
  }, [activeLeagueId, currentUser]);

  if (!activeLeagueId) {
    return (
      <div className="min-h-[80vh] flex flex-col items-center justify-center px-6 text-center select-none">
        <div className="w-16 h-16 rounded-full bg-indigo-50 border border-indigo-100 flex items-center justify-center text-3xl mb-6 shadow-sm animate-pulse">
          ⛸️
        </div>
        <h2 className="text-xl font-sports font-black text-gray-900 tracking-tight">No Active League</h2>
        <p className="text-xs text-gray-500 mt-2 max-w-sm font-semibold leading-relaxed">
          Unlock your roster deck! Join a league to start drafting or managing your active athletes.
        </p>
      </div>
    );
  }

  if (loading || loadingLeague) {
    return (
      <div className="min-h-[80vh] flex items-center justify-center">
        <div className="text-xs font-black tracking-widest text-gray-400 uppercase animate-pulse">
          Loading Roster Data...
        </div>
      </div>
    );
  }

  if (!myTeam) {
    return (
      <div className="min-h-[80vh] flex flex-col items-center justify-center px-6 text-center">
        <div className="text-3xl mb-4">🏒</div>
        <h2 className="text-lg font-sports font-black text-gray-900 leading-tight">No Team Found</h2>
        <p className="text-xs text-gray-500 mt-2 max-w-xs font-semibold leading-relaxed">
          You are a member of this league but do not own a team sheet. Please contact the commissioner to configure your rosters.
        </p>
      </div>
    );
  }

  const rosterIds = myTeam.players || [];
  const isPending = leagueData && (
    leagueData.status === 'pending' || 
    (leagueData.members && leagueData.members.length < leagueData.maxTeams) || 
    !leagueData.draftDate
  );
  
  // Roster Slot Mapping Schema:
  // Forwards (6 slots), Defense (4 slots), Goalie (1 slot), Bench (4 slots)
  const layoutSlots = [
    { label: "Forward", key: "F_1", pos: "F" },
    { label: "Forward", key: "F_2", pos: "F" },
    { label: "Forward", key: "F_3", pos: "F" },
    { label: "Forward", key: "F_4", pos: "F" },
    { label: "Forward", key: "F_5", pos: "F" },
    { label: "Forward", key: "F_6", pos: "F" },
    { label: "Defense", key: "D_1", pos: "D" },
    { label: "Defense", key: "D_2", pos: "D" },
    { label: "Defense", key: "D_3", pos: "D" },
    { label: "Defense", key: "D_4", pos: "D" },
    { label: "Goalie", key: "G_1", pos: "G" },
    { label: "Bench", key: "BN_1", pos: "BN" },
    { label: "Bench", key: "BN_2", pos: "BN" },
    { label: "Bench", key: "BN_3", pos: "BN" },
    { label: "Bench", key: "BN_4", pos: "BN" }
  ];

  // Distribute active athlete IDs to matching position slots dynamically
  const assignedPlayers = [];
  const unusedIds = [...rosterIds];

  layoutSlots.forEach(slot => {
    let matchIdx = -1;
    if (slot.pos !== 'BN') {
      // Find first player ID matching starting role F/D/G
      matchIdx = unusedIds.findIndex(id => PWHL_ATHLETES_DB[id]?.pos === slot.pos);
    } else {
      // BN matches any remaining player ID
      matchIdx = 0;
    }

    if (matchIdx !== -1 && unusedIds.length > 0) {
      const pId = unusedIds[matchIdx];
      assignedPlayers.push({
        slotLabel: slot.label,
        slotPos: slot.pos,
        athlete: { id: pId, ...PWHL_ATHLETES_DB[pId] }
      });
      unusedIds.splice(matchIdx, 1);
    } else {
      assignedPlayers.push({
        slotLabel: slot.label,
        slotPos: slot.pos,
        athlete: null
      });
    }
  });

  const starters = assignedPlayers.filter(slot => slot.slotPos !== 'BN');
  const bench = assignedPlayers.filter(slot => slot.slotPos === 'BN');

  const renderAthleteCard = (slot, idx) => {
    const athlete = slot.athlete;
    const isBench = slot.slotPos === 'BN';
    
    // Choose theme colors based on position
    let posColorClass = "border-indigo-100 bg-indigo-50 text-indigo-600";
    let accentBorder = "hover:border-indigo-300";
    if (slot.slotPos === 'D') {
      posColorClass = "border-emerald-100 bg-emerald-50 text-emerald-600";
      accentBorder = "hover:border-emerald-300";
    } else if (slot.slotPos === 'G') {
      posColorClass = "border-purple-100 bg-purple-50 text-purple-600";
      accentBorder = "hover:border-purple-300";
    } else if (isBench) {
      posColorClass = "border-gray-200 bg-gray-50 text-gray-400";
      accentBorder = "hover:border-gray-300";
    }

    if (!athlete) {
      return (
        <div key={idx} className="bg-white/50 border border-dashed border-gray-200 rounded-[24px] p-4 flex flex-col items-center justify-center text-center min-h-[140px] shadow-sm select-none">
          <span className={`text-[9px] font-black uppercase px-2.5 py-1 rounded-lg border tracking-widest ${posColorClass} mb-3`}>
            {slot.slotPos}
          </span>
          <span className="text-xs font-bold text-gray-300 italic">Empty Slot</span>
          <span className="text-[9px] uppercase tracking-wider font-black text-gray-300 mt-1">Unassigned</span>
        </div>
      );
    }

    return (
      <div 
        key={athlete.id || idx} 
        className={`bg-white border border-gray-200 rounded-[24px] p-4 flex flex-col justify-between shadow-sm relative overflow-hidden transition-all duration-200 hover:shadow-md ${accentBorder} min-h-[155px]`}
      >
        {/* Top bar: Position and OVR */}
        <div className="flex justify-between items-start">
          <span className={`text-[9px] font-black uppercase px-2.5 py-1 rounded-lg border tracking-widest shadow-inner ${posColorClass}`}>
            {slot.slotPos}
          </span>
          
          <div className="text-right">
            <span className="font-sports text-lg font-bold text-gray-800 leading-none block">{athlete.rating}</span>
            <span className="text-[9px] font-black text-gray-400 uppercase tracking-widest mt-0.5 block">OVR</span>
          </div>
        </div>

        {/* Center: Avatar/Emoji and Name */}
        <div className="my-3 flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-gray-50 border border-gray-100 flex items-center justify-center text-xl shadow-inner shrink-0">
            {slot.slotPos === 'G' ? '🥅' : '🏒'}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-[9px] font-black text-gray-500 bg-gray-50 px-1 rounded border border-gray-200">{athlete.team}</span>
              <span className="text-xs font-black text-gray-800 truncate block">{athlete.name}</span>
            </div>
            <span className="text-[9px] text-gray-400 font-bold uppercase tracking-wider block mt-1 truncate">{athlete.stats}</span>
          </div>
        </div>

        {/* Bottom bar: Points and swap action */}
        <div className="flex justify-between items-center pt-2.5 border-t border-gray-100">
          <div>
            <span className="text-sm font-sports font-bold text-indigo-600 leading-none">{athlete.points.toFixed(1)}</span>
            <span className="text-[8px] font-black text-gray-400 uppercase tracking-widest ml-1">pts</span>
          </div>

          <button 
            onClick={() => alert("Move option triggered! Roster management is automated.")}
            disabled={isPending}
            className="w-8 h-8 rounded-xl bg-gray-50 border border-gray-200 flex items-center justify-center text-xs font-bold text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 active:scale-95 transition-all"
          >
            ⇄
          </button>
        </div>
      </div>
    );
  };

  const renderSlotRow = (slot, idx) => {
    const athlete = slot.athlete;
    const isBench = slot.slotPos === 'BN';

    return (
      <div 
        key={slot.key || idx} 
        className={`flex items-center gap-3.5 p-3.5 rounded-2xl border transition-all duration-200 ${athlete ? 'bg-white border-gray-200 shadow-sm' : 'border-dashed border-gray-300 bg-white/50'}`}
      >
        {/* Position Tag */}
        <div className="w-12 flex justify-center">
          <span className={`text-[10px] font-black uppercase px-2 py-1.5 rounded-xl border tracking-widest flex items-center justify-center w-full shadow-inner ${isBench ? 'bg-gray-50 border-gray-200 text-gray-400' : 'bg-indigo-50 border-indigo-100 text-indigo-600'}`}>
            {slot.slotPos}
          </span>
        </div>

        {/* Player Info */}
        {athlete ? (
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[9px] font-black text-gray-500 bg-gray-50 px-1.5 py-0.5 rounded border border-gray-200">
                {athlete.team}
              </span>
              <span className="text-xs font-black text-gray-800 truncate">{athlete.name}</span>
            </div>
            <div className="flex justify-between items-center mt-1">
              <span className="text-[9px] text-gray-400 font-black uppercase tracking-wider truncate max-w-[200px]">
                {athlete.stats}
              </span>
              <span className="text-[10px] font-black text-indigo-600">{athlete.points.toFixed(1)} pts</span>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex justify-between items-center text-xs font-bold text-gray-300 italic">
            <span>Empty Slot</span>
            <span className="text-[9px] uppercase tracking-wider font-black text-gray-300">Unassigned</span>
          </div>
        )}

        {/* Quick Actions (Move) */}
        {athlete && (
          <button 
            onClick={() => alert("Move option triggered! Drag/drop and roster bench management is automated.")}
            disabled={isPending}
            className="w-8 h-8 rounded-xl bg-gray-50 border border-gray-200 flex items-center justify-center text-xs font-bold text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 active:scale-95 transition-all"
          >
            ⇄
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="font-sans select-none antialiased">
      
      {/* ── HEADER ── */}
      <header className="mb-6">
        <span className="text-[10px] uppercase font-black tracking-widest text-indigo-600 bg-indigo-50 px-3 py-1.5 rounded-full border border-indigo-100 shadow-sm shadow-indigo-100/10">
          {myTeam.teamName}
        </span>
        <h1 className="font-sports text-3xl font-black mt-3 tracking-tight text-gray-900">
          My Roster
        </h1>
        <p className="text-xs text-gray-400 font-semibold tracking-wide mt-0.5">Manage your active starting lineup and bench slots.</p>
      </header>

      {/* ── CENTRAL LOCKED BANNER (Pre-Draft) ── */}
      {isPending && (
        <div className="mb-6 p-4.5 bg-indigo-50 border border-indigo-100 rounded-3xl flex items-center gap-3.5 animate-scale-up">
          <div className="w-10 h-10 rounded-2xl bg-white border border-indigo-100 flex items-center justify-center text-xl text-indigo-600 shadow-sm animate-pulse">
            🔒
          </div>
          <div>
            <h4 className="text-xs font-black uppercase tracking-wider text-indigo-900">Lineup is locked</h4>
            <p className="text-[10px] text-indigo-500 font-semibold mt-0.5 leading-normal">Your roster lineup is frozen and locked until the draft completes.</p>
          </div>
        </div>
      )}

      {/* ── ROSTER RESPONSIVE DESKTOP SPLIT GRID ── */}
      <div className={`${isPending ? 'blur-[1.5px] opacity-45 pointer-events-none' : ''} transition-all duration-300 grid grid-cols-1 lg:grid-cols-12 gap-8 items-start`}>
        
        {/* LEFT COLUMN: ACTIVE STARTERS (lg:col-span-8) */}
        <div className="lg:col-span-8 space-y-4">
          <h3 className="text-xs font-black uppercase tracking-wider text-gray-400 mb-1 hidden lg:block">⛸️ Active Starting Lineup</h3>
          
          {/* Mobile compact lists display */}
          <div className="block md:hidden space-y-3">
            {starters.map((slot, idx) => renderSlotRow(slot, idx))}
          </div>

          {/* Desktop Visual Cards Grids */}
          <div className="hidden md:block space-y-6">
            
            {/* Forwards Section */}
            <div>
              <h4 className="text-[10px] font-black uppercase text-indigo-600 bg-indigo-50 border border-indigo-100 px-3.5 py-1.5 rounded-xl inline-block mb-3.5 tracking-widest shadow-sm">⚡ Starting Forwards</h4>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {starters.filter(s => s.slotPos === 'F').map((slot, idx) => renderAthleteCard(slot, idx))}
              </div>
            </div>

            {/* Defense Section */}
            <div>
              <h4 className="text-[10px] font-black uppercase text-emerald-600 bg-emerald-50 border border-emerald-100 px-3.5 py-1.5 rounded-xl inline-block mb-3.5 tracking-widest shadow-sm">🛡️ Starting Defense</h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {starters.filter(s => s.slotPos === 'D').map((slot, idx) => renderAthleteCard(slot, idx))}
              </div>
            </div>

            {/* Goalie Section */}
            <div>
              <h4 className="text-[10px] font-black uppercase text-purple-600 bg-purple-50 border border-purple-100 px-3.5 py-1.5 rounded-xl inline-block mb-3.5 tracking-widest shadow-sm">🥅 Starting Goalie</h4>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {starters.filter(s => s.slotPos === 'G').map((slot, idx) => renderAthleteCard(slot, idx))}
              </div>
            </div>

          </div>

        </div>

        {/* RIGHT COLUMN: FRANCHISE BENCH (lg:col-span-4) */}
        <div className="lg:col-span-4 space-y-4">
          <h3 className="text-xs font-black uppercase tracking-wider text-gray-400 mb-1 hidden lg:block">🛋️ Roster Bench</h3>
          
          {/* Mobile lists display */}
          <div className="block md:hidden space-y-3">
            {bench.map((slot, idx) => renderSlotRow(slot, idx))}
          </div>

          {/* Desktop Visual Card Grid */}
          <div className="hidden md:block">
            <div className="grid grid-cols-1 gap-4">
              {bench.map((slot, idx) => renderAthleteCard(slot, idx))}
            </div>
          </div>
        </div>
        
      </div>

    </div>
  );
}
