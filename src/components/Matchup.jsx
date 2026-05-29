import React, { useState } from 'react';

// Premium Mock Active Matchup Data
const MOCK_MATCHUP_DETAILS = {
  week: "Week 1",
  dateRange: "Oct 14 - Oct 20",
  teamA: {
    name: "Montreal Vipers",
    short: "MTL",
    avatar: "🐍",
    owner: "You",
    score: 142.5,
    projected: 151.0,
    players: [
      { id: "p1", name: "Marie-Philip Poulin", pos: "F", team: "MTL", points: 28.5, stats: "2G, 1A, +3" },
      { id: "p2", name: "Sarah Nurse", pos: "F", team: "TOR", points: 19.0, stats: "1G, 1A, +1" },
      { id: "p3", name: "Laura Stacey", pos: "F", team: "MTL", points: 12.5, stats: "0G, 2A, 0" },
      { id: "p4", name: "Erin Ambrose", pos: "D", team: "MTL", points: 22.0, stats: "0G, 3A, +2" },
      { id: "p5", name: "Renata Fast", pos: "D", team: "TOR", points: 18.5, stats: "1G, 0A, +1" },
      { id: "p6", name: "Aerin Frankel", pos: "G", team: "BOS", points: 42.0, stats: "2W, 58SV, 1.95GAA" }
    ]
  },
  teamB: {
    name: "Toronto Blizzard",
    short: "TOR",
    avatar: "❄️",
    owner: "Alex",
    score: 128.0,
    projected: 142.5,
    players: [
      { id: "p7", name: "Natalie Spooner", pos: "F", team: "TOR", points: 34.0, stats: "3G, 1A, +2" },
      { id: "p8", name: "Hilary Knight", pos: "F", team: "BOS", points: 14.5, stats: "1G, 0A, -1" },
      { id: "p9", name: "Alex Carpenter", pos: "F", team: "NY", points: 21.0, stats: "1G, 2A, +1" },
      { id: "p10", name: "Megan Keller", pos: "D", team: "BOS", points: 15.0, stats: "0G, 2A, -1" },
      { id: "p11", name: "Jocelyne Larocque", pos: "D", team: "TOR", points: 11.5, stats: "0G, 1A, 0" },
      { id: "p12", name: "Ann-Renée Desbiens", pos: "G", team: "MTL", points: 32.0, stats: "1W, 54SV, 2.45GAA" }
    ]
  },
  categories: [
    { name: "Goals (G)", valA: 4, valB: 6 },
    { name: "Assists (A)", valA: 7, valB: 6 },
    { name: "Plus/Minus (+/-)", valA: 7, valB: 2 },
    { name: "Saves (SV)", valA: 58, valB: 54 },
    { name: "Wins (W)", valA: 2, valB: 1 }
  ]
};

export default function Matchup({ activeLeagueId }) {
  const [activeTab, setActiveTab] = useState('scoreboard'); // 'scoreboard' | 'rosters'

  if (!activeLeagueId) {
    return (
      <div className="min-h-[80vh] flex flex-col items-center justify-center px-6 text-center select-none">
        <div className="w-20 h-20 rounded-full bg-indigo-500/10 border border-indigo-500/25 flex items-center justify-center text-4xl mb-6 shadow-xl shadow-indigo-500/5 animate-pulse">
          🏆
        </div>
        <h2 className="text-2xl font-bold text-white tracking-wide">No Active League</h2>
        <p className="text-gray-400 mt-2 max-w-sm text-sm leading-relaxed">
          Unlock your team command center! Create or join a fantasy league in the League tab to view live weekly matchups.
        </p>
      </div>
    );
  }

  const { teamA, teamB, categories, week, dateRange } = MOCK_MATCHUP_DETAILS;

  // Compute category leader totals
  const totalCategories = categories.length;
  let winsA = 0;
  let winsB = 0;
  categories.forEach(cat => {
    if (cat.valA > cat.valB) winsA++;
    else if (cat.valB > cat.valA) winsB++;
  });

  return (
    <div className="min-h-screen bg-[#0f0f13] text-gray-100 px-4 pt-6 pb-24 font-sans antialiased">
      
      {/* ── HEADER NAVIGATION ── */}
      <div className="flex justify-between items-center mb-6">
        <div>
          <span className="text-xs uppercase font-extrabold tracking-widest text-indigo-400 bg-indigo-500/10 px-2.5 py-1 rounded-full border border-indigo-500/20">
            {week}
          </span>
          <h1 className="text-2xl font-black mt-2 tracking-tight bg-gradient-to-r from-white via-gray-200 to-gray-400 bg-clip-text text-transparent">
            Active Matchup
          </h1>
          <p className="text-xs text-gray-500 font-semibold tracking-wide">{dateRange}</p>
        </div>
        
        {/* Pulsing Live Badge */}
        <div className="flex items-center gap-2 bg-emerald-500/10 border border-emerald-500/20 px-3 py-1.5 rounded-full">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
          </span>
          <span className="text-[10px] uppercase font-black text-emerald-400 tracking-wider">LIVE Tracker</span>
        </div>
      </div>

      {/* ── CARD GRID: THE HEAD-TO-HEAD DUEL ── */}
      <div className="relative overflow-hidden rounded-3xl border border-white/5 bg-gradient-to-b from-white/5 to-white/[0.01] backdrop-blur-xl p-6 shadow-2xl mb-6">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-32 h-[1px] bg-gradient-to-r from-transparent via-indigo-500/50 to-transparent"></div>
        
        <div className="flex justify-between items-center">
          {/* Team A (You) */}
          <div className="text-center w-[40%] flex flex-col items-center">
            <div className="w-16 h-16 rounded-2xl bg-gradient-to-tr from-indigo-600 to-violet-500 flex items-center justify-center text-3xl shadow-lg shadow-indigo-600/20 border border-indigo-400/20 transition-transform active:scale-95 duration-200">
              {teamA.avatar}
            </div>
            <h3 className="text-sm font-bold text-white mt-3 truncate w-full">{teamA.name}</h3>
            <p className="text-xs text-indigo-400 font-semibold mt-0.5">{teamA.owner}</p>
            
            <p className="text-3xl font-black text-white mt-3 tracking-tight">{teamA.score.toFixed(1)}</p>
            <p className="text-[10px] text-gray-500 font-bold uppercase tracking-wider mt-1">Proj: {teamA.projected.toFixed(1)}</p>
          </div>

          {/* Opponent Tracker Indicator */}
          <div className="flex flex-col items-center justify-center w-[20%]">
            <div className="text-[10px] font-black text-gray-500 tracking-widest uppercase mb-1">VS</div>
            <div className="w-12 h-6 rounded-full bg-white/5 border border-white/10 flex items-center justify-center text-[10px] font-black text-gray-400">
              {winsA}-{winsB}
            </div>
          </div>

          {/* Team B */}
          <div className="text-center w-[40%] flex flex-col items-center">
            <div className="w-16 h-16 rounded-2xl bg-gradient-to-tr from-gray-800 to-gray-700 border border-white/10 flex items-center justify-center text-3xl shadow-lg shadow-black/20 transition-transform active:scale-95 duration-200">
              {teamB.avatar}
            </div>
            <h3 className="text-sm font-bold text-white mt-3 truncate w-full">{teamB.name}</h3>
            <p className="text-xs text-gray-400 font-semibold mt-0.5">{teamB.owner}</p>
            
            <p className="text-3xl font-black text-white mt-3 tracking-tight">{teamB.score.toFixed(1)}</p>
            <p className="text-[10px] text-gray-500 font-bold uppercase tracking-wider mt-1">Proj: {teamB.projected.toFixed(1)}</p>
          </div>
        </div>

        {/* Projections Progress Meter */}
        <div className="mt-6 pt-5 border-t border-white/5">
          <div className="flex justify-between text-[10px] text-gray-400 font-extrabold uppercase tracking-wider mb-2">
            <span>Win Probability</span>
            <span className="text-indigo-400">62% MTL</span>
          </div>
          <div className="h-1.5 rounded-full bg-white/5 overflow-hidden flex">
            <div className="h-full bg-gradient-to-r from-indigo-500 to-violet-500" style={{ width: '62%' }}></div>
            <div className="h-full bg-gray-700" style={{ width: '38%' }}></div>
          </div>
        </div>
      </div>

      {/* ── TABS SELECTOR ── */}
      <div className="flex p-1 bg-black/40 border border-white/5 rounded-2xl mb-6 shadow-inner">
        <button
          onClick={() => setActiveTab('scoreboard')}
          className={`flex-1 py-3 text-xs font-black uppercase tracking-wider rounded-xl transition-all duration-300 ${activeTab === 'scoreboard' ? 'bg-gradient-to-r from-indigo-600 to-violet-500 text-white shadow-md' : 'text-gray-400 hover:text-gray-200'}`}
        >
          🏆 Categories Breakdown
        </button>
        <button
          onClick={() => setActiveTab('rosters')}
          className={`flex-1 py-3 text-xs font-black uppercase tracking-wider rounded-xl transition-all duration-300 ${activeTab === 'rosters' ? 'bg-gradient-to-r from-indigo-600 to-violet-500 text-white shadow-md' : 'text-gray-400 hover:text-gray-200'}`}
        >
          ⛸️ Roster Compare
        </button>
      </div>

      {/* ── TAB 1: SLEEPER-STYLE CATEGORIES BREAKDOWN ── */}
      {activeTab === 'scoreboard' && (
        <div className="space-y-3">
          {categories.map((cat, idx) => {
            const isALeading = cat.valA > cat.valB;
            const isBLeading = cat.valB > cat.valA;
            const total = cat.valA + cat.valB;
            const pctA = total > 0 ? (cat.valA / total) * 100 : 50;

            return (
              <div key={idx} className="bg-white/[0.02] border border-white/5 rounded-2xl p-4 flex flex-col gap-3 backdrop-blur-md">
                <div className="flex justify-between items-center text-xs font-bold">
                  <span className={`text-sm ${isALeading ? 'text-indigo-400 font-extrabold scale-105' : 'text-gray-400'} transition-all`}>
                    {cat.valA}
                  </span>
                  <span className="text-[10px] font-black uppercase text-gray-500 tracking-wider">
                    {cat.name}
                  </span>
                  <span className={`text-sm ${isBLeading ? 'text-indigo-400 font-extrabold scale-105' : 'text-gray-400'} transition-all`}>
                    {cat.valB}
                  </span>
                </div>
                
                {/* Visual comparative slide bar */}
                <div className="h-1.5 rounded-full bg-white/5 overflow-hidden flex">
                  <div 
                    className={`h-full transition-all duration-500 ${isALeading ? 'bg-gradient-to-r from-indigo-500 to-violet-500' : 'bg-gray-800'}`} 
                    style={{ width: `${pctA}%` }}
                  ></div>
                  <div 
                    className={`h-full transition-all duration-500 ${isBLeading ? 'bg-gradient-to-l from-indigo-500 to-violet-500' : 'bg-gray-800'}`} 
                    style={{ width: `${100 - pctA}%` }}
                  ></div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── TAB 2: ROSTER COMPARISON ── */}
      {activeTab === 'rosters' && (
        <div className="space-y-4">
          <div className="bg-white/[0.01] border border-white/5 rounded-2xl p-3 flex justify-between text-[10px] font-black uppercase text-gray-500 tracking-widest px-4 mb-2">
            <span>{teamA.short} Athletes</span>
            <span>POS</span>
            <span>{teamB.short} Athletes</span>
          </div>

          {Array.from({ length: Math.max(teamA.players.length, teamB.players.length) }).map((_, idx) => {
            const playerA = teamA.players[idx];
            const playerB = teamB.players[idx];
            
            return (
              <div key={idx} className="flex gap-2 items-center bg-white/[0.02] border border-white/5 rounded-2xl p-3 relative overflow-hidden">
                
                {/* Player A (Left) */}
                {playerA ? (
                  <div className="w-[45%] flex flex-col justify-center">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-bold text-gray-400 px-1 bg-white/5 rounded">{playerA.team}</span>
                      <span className="text-xs font-black text-white truncate">{playerA.name.split(' ').pop()}</span>
                    </div>
                    <span className="text-[9px] text-indigo-400 font-bold mt-1 uppercase tracking-wider">{playerA.stats}</span>
                    <span className="text-[10px] text-gray-500 font-semibold mt-0.5">{playerA.points.toFixed(1)} pts</span>
                  </div>
                ) : (
                  <div className="w-[45%] text-xs font-medium text-gray-600 italic">Empty Slot</div>
                )}

                {/* Position Marker */}
                <div className="w-[10%] flex items-center justify-center">
                  <div className="w-8 h-8 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center text-[10px] font-black text-indigo-400 shadow-md">
                    {playerA?.pos || playerB?.pos || "BN"}
                  </div>
                </div>

                {/* Player B (Right) */}
                {playerB ? (
                  <div className="w-[45%] flex flex-col justify-center text-right">
                    <div className="flex items-center gap-2 justify-end">
                      <span className="text-xs font-black text-white truncate">{playerB.name.split(' ').pop()}</span>
                      <span className="text-[10px] font-bold text-gray-400 px-1 bg-white/5 rounded">{playerB.team}</span>
                    </div>
                    <span className="text-[9px] text-indigo-400 font-bold mt-1 uppercase tracking-wider">{playerB.stats}</span>
                    <span className="text-[10px] text-gray-500 font-semibold mt-0.5">{playerB.points.toFixed(1)} pts</span>
                  </div>
                ) : (
                  <div className="w-[45%] text-right text-xs font-medium text-gray-600 italic">Empty Slot</div>
                )}
                
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
