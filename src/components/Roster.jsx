import React, { useState, useEffect } from 'react';
import { db } from '../firebase.js';
import { collection, query, where, getDocs } from 'firebase/firestore';
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
  const [myTeam, setMyTeam] = useState(null);

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
        <div className="w-16 h-16 rounded-full bg-indigo-500/10 border border-indigo-500/25 flex items-center justify-center text-3xl mb-6 shadow-xl animate-pulse">
          ⛸️
        </div>
        <h2 className="text-xl font-bold text-white tracking-wide">No Active League</h2>
        <p className="text-xs text-gray-500 mt-2 max-w-sm leading-relaxed">
          Unlock your roster deck! Join a league to start drafting or managing your active athletes.
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="min-h-[85vh] flex items-center justify-center">
        <div className="text-xs font-black tracking-widest text-gray-500 uppercase animate-pulse">
          Loading Roster Data...
        </div>
      </div>
    );
  }

  if (!myTeam) {
    return (
      <div className="min-h-[80vh] flex flex-col items-center justify-center px-6 text-center">
        <div className="text-3xl mb-4">🏒</div>
        <h2 className="text-lg font-bold text-white">No Team Found</h2>
        <p className="text-xs text-gray-500 mt-1 max-w-xs leading-relaxed">
          You are a member of this league but do not own a team sheet. Please contact the commissioner to configure your rosters.
        </p>
      </div>
    );
  }

  const rosterIds = myTeam.players || [];
  
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

  return (
    <div className="min-h-screen bg-[#0f0f13] text-gray-100 px-4 pt-6 pb-24 select-none">
      
      {/* ── HEADER ── */}
      <header className="mb-6">
        <span className="text-[9px] uppercase font-extrabold tracking-widest text-indigo-400 bg-indigo-500/10 px-2.5 py-0.5 rounded-full border border-indigo-500/15">
          {myTeam.teamName}
        </span>
        <h1 className="text-2xl font-black mt-2 tracking-tight bg-gradient-to-r from-white via-gray-200 to-gray-400 bg-clip-text text-transparent">
          My Roster
        </h1>
        <p className="text-xs text-gray-500 font-semibold mt-1">Manage your active starting lineup and bench slots.</p>
      </header>

      {/* ── ROSTER SLOTS VIEW ── */}
      <div className="space-y-3">
        {assignedPlayers.map((slot, idx) => {
          const athlete = slot.athlete;
          const isBench = slot.slotPos === 'BN';

          return (
            <div 
              key={idx} 
              className={`flex items-center gap-3 p-3.5 rounded-2xl border transition-all duration-300 ${athlete ? 'bg-white/[0.02] border-white/5' : 'border-dashed border-white/10 bg-white/[0.005]'}`}
            >
              {/* Position Tag */}
              <div className="w-12 flex justify-center">
                <span className={`text-[10px] font-black uppercase px-2.5 py-1.5 rounded-xl border tracking-widest flex items-center justify-center w-full shadow-inner ${isBench ? 'bg-white/5 border-white/10 text-gray-500' : 'bg-indigo-500/10 border-indigo-500/20 text-indigo-400'}`}>
                  {slot.slotPos}
                </span>
              </div>

              {/* Player Info */}
              {athlete ? (
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[9px] font-black text-gray-400 bg-white/5 px-1.5 py-0.5 rounded border border-white/5">
                      {athlete.team}
                    </span>
                    <span className="text-xs font-black text-white truncate">{athlete.name}</span>
                  </div>
                  <div className="flex justify-between items-center mt-1">
                    <span className="text-[9px] text-gray-500 font-bold uppercase tracking-wider truncate max-w-[200px]">
                      {athlete.stats}
                    </span>
                    <span className="text-[10px] font-black text-indigo-400">{athlete.points.toFixed(1)} pts</span>
                  </div>
                </div>
              ) : (
                <div className="flex-1 flex justify-between items-center text-xs font-semibold text-gray-600 italic">
                  <span>Empty Slot</span>
                  <span className="text-[10px] text-gray-700 tracking-wider">Unassigned</span>
                </div>
              )}

              {/* Quick Actions (Move) */}
              {athlete && (
                <button 
                  onClick={() => alert("Move option triggered! Drag/drop and roster bench management is automated.")}
                  className="w-8 h-8 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center text-xs font-bold text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
                >
                  ⇄
                </button>
              )}
            </div>
          );
        })}
      </div>

    </div>
  );
}
