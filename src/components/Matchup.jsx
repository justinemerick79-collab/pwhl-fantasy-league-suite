import React, { useState, useEffect } from 'react';
import { db } from '../firebase.js';
import { doc, getDoc, collection, getDocs } from 'firebase/firestore';
import { useAuth } from '../contexts/AuthContext';

// Mock active categories comparative schema for pending background blur
const CATEGORIES_PLACEHOLDER = [
  { name: "Goals (G)", valA: 0, valB: 0 },
  { name: "Assists (A)", valA: 0, valB: 0 },
  { name: "Plus/Minus (+/-)", valA: 0, valB: 0 },
  { name: "Saves (SV)", valA: 0, valB: 0 },
  { name: "Wins (W)", valA: 0, valB: 0 }
];

export default function Matchup({ activeLeagueId, setCurrentTab }) {
  const { currentUser } = useAuth();
  const [activeTab, setActiveTab] = useState('scoreboard'); // 'scoreboard' | 'rosters' (Used for mobile aspect stack)
  const [leagueData, setLeagueData] = useState(null);
  const [teams, setTeams] = useState([]);
  const [loading, setLoading] = useState(true);
  const [timeLeft, setTimeLeft] = useState({ days: 0, hours: 0, minutes: 0, seconds: 0, totalMs: 0 });

  useEffect(() => {
    if (!activeLeagueId) return;
    setLoading(true);
    
    // 1. Fetch league document details
    const docRef = doc(db, 'fantasy_leagues', activeLeagueId);
    getDoc(docRef).then((snap) => {
      if (snap.exists()) {
        setLeagueData(snap.data());
      }
    }).catch(err => {
      console.error("Error loading league status:", err);
    });

    // 2. Fetch league teams list to show factual team names in background
    const tRef = collection(db, `fantasy_leagues/${activeLeagueId}/teams`);
    getDocs(tRef).then((snap) => {
      setTeams(snap.docs.map(d => ({ id: d.id, ...d.data() })));
      setLoading(false);
    }).catch(err => {
      console.error("Error loading teams list:", err);
      setLoading(false);
    });
  }, [activeLeagueId]);

  useEffect(() => {
    if (!leagueData || !leagueData.draftDate) return;

    const calculateTimeLeft = () => {
      const difference = new Date(leagueData.draftDate) - new Date();
      if (difference <= 0) {
        setTimeLeft({ days: 0, hours: 0, minutes: 0, seconds: 0, totalMs: difference });
        return;
      }

      const days = Math.floor(difference / (1000 * 60 * 60 * 24));
      const hours = Math.floor((difference / (1000 * 60 * 60)) % 24);
      const minutes = Math.floor((difference / 1000 / 60) % 60);
      const seconds = Math.floor((difference / 1000) % 60);

      setTimeLeft({ days, hours, minutes, seconds, totalMs: difference });
    };

    calculateTimeLeft();
    const interval = setInterval(calculateTimeLeft, 1000);
    return () => clearInterval(interval);
  }, [leagueData]);

  if (!activeLeagueId) {
    return (
      <div className="min-h-[80vh] flex flex-col items-center justify-center px-6 text-center select-none">
        <div className="w-20 h-20 rounded-full bg-indigo-50 border border-indigo-100 flex items-center justify-center text-4xl mb-6 shadow-md animate-pulse">
          🏆
        </div>
        <h2 className="text-2xl font-sports font-black text-gray-900 tracking-tight">No Active League</h2>
        <p className="text-gray-500 mt-2 max-w-sm text-xs font-semibold leading-relaxed">
          Unlock your team command center! Create or join a fantasy league in the League tab to view live weekly matchups.
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="min-h-[80vh] flex items-center justify-center">
        <div className="text-xs font-black tracking-widest text-gray-400 uppercase animate-pulse">
          Syncing Matchup Data...
        </div>
      </div>
    );
  }

  const isPending = leagueData && (
    leagueData.status === 'pending' || 
    (leagueData.members && leagueData.members.length < leagueData.maxTeams) || 
    !leagueData.draftDate
  );
  const isCommissioner = leagueData && currentUser && currentUser.uid === leagueData.ownerId;
  const hasDraftDate = leagueData && !!leagueData.draftDate;
  
  // Imminent threshold: less than 1 hour away (or date has passed but status is still pending)
  const isDraftImminent = hasDraftDate && (timeLeft.totalMs <= 60 * 60 * 1000);
  
  // Factual check if the league is full or waiting for teams
  const isFull = leagueData && leagueData.members && (leagueData.members.length >= leagueData.maxTeams);

  // Extract factual team details from Firestore loaded lists
  const myTeam = teams.find(t => t.ownerId === currentUser?.uid) || { teamName: "My Team", avatar: "🏒" };
  const oppTeam = teams.find(t => t.ownerId !== currentUser?.uid) || { teamName: "Waiting for Opponent", avatar: "🥅" };

  return (
    <div className="relative font-sans select-none antialiased">
      
      {/* ── HEADER ── */}
      <div className="flex justify-between items-center mb-6">
        <div>
          <span className="text-[10px] uppercase font-black tracking-widest text-indigo-600 bg-indigo-50 px-3 py-1.5 rounded-full border border-indigo-100">
            Week 1
          </span>
          <h1 className="font-sports text-3xl font-black mt-3 tracking-tight text-gray-900">
            Active Matchup
          </h1>
          <p className="text-xs text-gray-400 font-semibold tracking-wide mt-0.5">Oct 14 - Oct 20</p>
        </div>
        
        {/* Pulsing Live Badge */}
        <div className="flex items-center gap-2 bg-emerald-50 border border-emerald-100 px-3 py-1.5 rounded-full">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
          </span>
          <span className="text-[10px] uppercase font-black text-emerald-600 tracking-wider">LIVE Tracker</span>
        </div>
      </div>

      {/* ── 1. DRAFT STATUS BANNER/CARD AT THE TOP (Pre-Draft State) ── */}
      {isPending && (
        <div className="mb-8 animate-scale-up">
          
          {/* STATE 1: WAITING FOR LEAGUE TO FILL */}
          {!isFull && (
            <div className="w-full bg-white border border-gray-200 rounded-[28px] p-6 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div className="flex items-center gap-4 text-left">
                <div className="w-14 h-14 rounded-2xl bg-indigo-50 border border-indigo-100 flex items-center justify-center text-2xl text-indigo-600 shadow-inner">
                  👥
                </div>
                <div>
                  <h2 className="font-sports text-xl font-black text-gray-900 leading-tight">Waiting for League to Fill</h2>
                  <p className="text-xs text-gray-400 font-semibold mt-1">
                    Franchise Recruitment: {leagueData.members.length} of {leagueData.maxTeams} teams joined
                  </p>
                </div>
              </div>

              {/* Invite Code Panel */}
              <div className="flex items-center gap-3 bg-gray-50 border border-gray-200 px-4 py-2.5 rounded-2xl shadow-inner">
                <span className="text-[10px] font-black text-gray-400 uppercase tracking-widest px-1">Invite Code:</span>
                <span className="text-sm font-black tracking-widest text-indigo-600">{leagueData.inviteCode}</span>
                <button 
                  onClick={() => {
                    navigator.clipboard.writeText(leagueData.inviteCode);
                    alert("Invite Code copied successfully!");
                  }}
                  className="text-[10px] font-black uppercase text-indigo-600 bg-white border border-gray-200 px-3 py-1.5 rounded-xl hover:bg-gray-50 active:scale-95 transition-all shadow-sm"
                >
                  Copy
                </button>
              </div>

              {isCommissioner ? (
                <button
                  onClick={() => setCurrentTab('manager')}
                  className="px-6 py-4 bg-indigo-600 hover:bg-indigo-500 text-white rounded-2xl text-xs font-black uppercase tracking-wider shadow-md shadow-indigo-600/10 active:scale-95 transition-transform"
                >
                  ⚙️ LM Toolset
                </button>
              ) : (
                <div className="py-3 px-5 bg-gray-50 border border-gray-200 rounded-2xl text-xs font-black uppercase text-gray-400 tracking-wider">
                  Waiting for members
                </div>
              )}
            </div>
          )}

          {/* STATE 2: LEAGUE FULL, DRAFT NOT SCHEDULED */}
          {isFull && !hasDraftDate && (
            <div className="w-full bg-white border border-amber-200 rounded-[28px] p-6 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div className="flex items-center gap-4 text-left">
                <div className="w-14 h-14 rounded-2xl bg-amber-50 border border-amber-100 flex items-center justify-center text-2xl text-amber-500 animate-bounce">
                  📅
                </div>
                <div>
                  <h2 className="font-sports text-xl font-black text-gray-900 leading-tight">Draft Not Scheduled</h2>
                  <p className="text-xs text-gray-500 font-semibold mt-1">
                    League is full and locked! The League Manager must schedule the draft in the LM Toolset.
                  </p>
                </div>
              </div>

              {isCommissioner ? (
                <button
                  onClick={() => setCurrentTab('manager')}
                  className="px-6 py-4 bg-indigo-600 hover:bg-indigo-500 text-white rounded-2xl text-xs font-black uppercase tracking-wider shadow-md shadow-indigo-600/10 active:scale-95 transition-transform"
                >
                  ⚙️ Edit Draft Settings
                </button>
              ) : (
                <div className="py-3 px-5 bg-gray-50 border border-gray-200 rounded-2xl text-xs font-black uppercase text-gray-400 tracking-wider">
                  Waiting for Commissioner
                </div>
              )}
            </div>
          )}

          {/* STATE 3: DRAFT SCHEDULED */}
          {isFull && hasDraftDate && !isDraftImminent && (
            <div className="w-full bg-white border border-gray-200 rounded-[28px] p-6 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div className="flex items-center gap-4 text-left">
                <div className="w-14 h-14 rounded-2xl bg-indigo-50 border border-indigo-100 flex items-center justify-center text-2xl text-indigo-600">
                  💜
                </div>
                <div>
                  <h2 className="font-sports text-xl font-black text-gray-900 leading-tight">Draft Scheduled</h2>
                  <p className="text-xs text-gray-400 font-semibold mt-1">
                    Lobby opens: {new Date(leagueData.draftDate).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
                  </p>
                </div>
              </div>

              {/* Countdown Panel */}
              <div className="flex items-center gap-2 bg-gray-50 border border-gray-200 p-3 rounded-2xl shadow-inner">
                <span className="text-[10px] font-black text-gray-400 uppercase tracking-widest px-1 mr-1">Countdown:</span>
                <span className="text-sm font-black text-indigo-600 bg-indigo-50 px-2.5 py-1.5 rounded-xl border border-indigo-100">{timeLeft.days}d</span>
                <span className="text-sm font-black text-indigo-600 bg-indigo-50 px-2.5 py-1.5 rounded-xl border border-indigo-100">{timeLeft.hours}h</span>
                <span className="text-sm font-black text-indigo-600 bg-indigo-50 px-2.5 py-1.5 rounded-xl border border-indigo-100">{timeLeft.minutes}m</span>
                <span className="text-sm font-black text-indigo-600 bg-indigo-50 px-2.5 py-1.5 rounded-xl border border-indigo-100 animate-pulse">{timeLeft.seconds}s</span>
              </div>

              {isCommissioner && (
                <button
                  onClick={() => setCurrentTab('manager')}
                  className="px-6 py-4 bg-white border border-gray-200 text-gray-700 hover:bg-gray-50 rounded-2xl text-xs font-black uppercase tracking-wider active:scale-95 transition-all shadow-sm"
                >
                  ⚙️ Edit Settings
                </button>
              )}
            </div>
          )}

          {/* STATE 4: DRAFT IMMINENT */}
          {isFull && hasDraftDate && isDraftImminent && (
            <div className="w-full bg-white border-2 border-indigo-500 rounded-[28px] p-6 shadow-md flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div className="flex items-center gap-4 text-left">
                <div className="w-14 h-14 rounded-2xl bg-indigo-50 border border-indigo-100 flex items-center justify-center text-2xl text-indigo-600 animate-pulse">
                  ⚡
                </div>
                <div>
                  <h2 className="font-sports text-xl font-black text-gray-900 leading-tight">Draft is Imminent!</h2>
                  <p className="text-xs text-gray-400 font-semibold mt-1">
                    {timeLeft.totalMs > 0 ? `Lobby opens in: ${timeLeft.minutes}m ${timeLeft.seconds}s` : 'Draft lobby is now OPEN!'}
                  </p>
                </div>
              </div>

              <button
                onClick={() => alert("Connecting to live draft socket...")}
                className="px-8 py-4.5 bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-white rounded-2xl text-xs font-black uppercase tracking-wider shadow-xl shadow-indigo-600/20 active:scale-95 transition-transform animate-pulse"
              >
                ENTER DRAFT
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── 2. PRE-DRAFT MATCHUP SHADOW SHEET (PREMIUM RESPONSIVE DESKTOP GRID) ── */}
      <div className={`${isPending ? 'blur-[1.5px] opacity-45 pointer-events-none' : ''} transition-all duration-300`}>
        
        {/* RESPONSIVE LAYOUT CONTAINER */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          
          {/* LEFT PANEL (H2H Duel Card) */}
          <div className="lg:col-span-4 space-y-6">
            
            {/* HEAD-TO-HEAD DUEL CARD */}
            <div className="bg-white border border-gray-200 rounded-[32px] p-6 shadow-sm relative overflow-hidden">
              <div className="flex justify-between items-center">
                {/* Team A */}
                <div className="text-center w-[40%] flex flex-col items-center">
                  <div className="w-16 h-16 rounded-3xl bg-indigo-50 border border-indigo-100 flex items-center justify-center text-3xl shadow-sm">
                    {myTeam.avatar || '🏒'}
                  </div>
                  <h3 className="text-xs font-black text-gray-800 mt-3 truncate w-full">{myTeam.teamName}</h3>
                  <p className="text-[10px] text-indigo-600 font-bold mt-0.5">You</p>
                  
                  <p className="text-3xl font-black text-gray-900 mt-3 tracking-tight">0.0</p>
                  <p className="text-[9px] text-gray-400 font-black uppercase tracking-wider mt-1">Proj: 0.0</p>
                </div>

                {/* VS Score Counter */}
                <div className="flex flex-col items-center justify-center w-[20%]">
                  <div className="text-[10px] font-black text-gray-400 tracking-widest uppercase mb-1">VS</div>
                  <div className="w-12 h-6 rounded-full bg-gray-50 border border-gray-200 flex items-center justify-center text-[10px] font-black text-gray-500">
                    0-0
                  </div>
                </div>

                {/* Team B */}
                <div className="text-center w-[40%] flex flex-col items-center">
                  <div className="w-16 h-16 rounded-3xl bg-gray-50 border border-gray-200 flex items-center justify-center text-3xl shadow-sm">
                    {oppTeam.avatar || '🥅'}
                  </div>
                  <h3 className="text-xs font-black text-gray-800 mt-3 truncate w-full">{oppTeam.teamName}</h3>
                  <p className="text-[10px] text-gray-400 font-bold mt-0.5">Opponent</p>
                  
                  <p className="text-3xl font-black text-gray-900 mt-3 tracking-tight">0.0</p>
                  <p className="text-[9px] text-gray-400 font-black uppercase tracking-wider mt-1">Proj: 0.0</p>
                </div>
              </div>

              {/* Win Probability Bar */}
              <div className="mt-6 pt-5 border-t border-gray-100">
                <div className="flex justify-between text-[10px] text-gray-400 font-black uppercase tracking-wider mb-2">
                  <span>Win Probability</span>
                  <span className="text-indigo-600">50% MTL</span>
                </div>
                <div className="h-2 rounded-full bg-gray-100 overflow-hidden flex">
                  <div className="h-full bg-gradient-to-r from-indigo-600 to-indigo-500" style={{ width: '50%' }}></div>
                  <div className="h-full bg-gray-200" style={{ width: '50%' }}></div>
                </div>
              </div>
            </div>

            {/* Mobile-Only Tabs Selector (Hidden on Desktop) */}
            <div className="flex lg:hidden p-1 bg-gray-100 border border-gray-200 rounded-2xl shadow-inner">
              <button
                onClick={() => setActiveTab('scoreboard')}
                className={`flex-1 py-3 text-[10px] font-black uppercase tracking-wider rounded-xl transition-all duration-200 ${activeTab === 'scoreboard' ? 'bg-white text-indigo-600 shadow-sm border border-gray-200' : 'text-gray-400 hover:text-gray-600'}`}
              >
                🏆 Categories
              </button>
              <button
                onClick={() => setActiveTab('rosters')}
                className={`flex-1 py-3 text-[10px] font-black uppercase tracking-wider rounded-xl transition-all duration-200 ${activeTab === 'rosters' ? 'bg-white text-indigo-600 shadow-sm border border-gray-200' : 'text-gray-400 hover:text-gray-600'}`}
              >
                ⛸️ Roster Compare
              </button>
            </div>
            
          </div>

          {/* RIGHT PANEL (Widescreen side-by-side or toggled columns) */}
          <div className="lg:col-span-8 space-y-6">
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              
              {/* 1. scoreboard categories panel */}
              <div className={`lg:block ${activeTab === 'scoreboard' ? 'block' : 'hidden'}`}>
                <h3 className="text-xs font-black uppercase tracking-wider text-gray-400 mb-3.5 flex items-center gap-1.5">🏆 Live Categories Duel</h3>
                <div className="space-y-3">
                  {CATEGORIES_PLACEHOLDER.map((cat, idx) => (
                    <div key={idx} className="bg-white border border-gray-200 rounded-2xl p-4 flex flex-col gap-3 shadow-sm hover:border-indigo-100 transition-all duration-200">
                      <div className="flex justify-between items-center text-xs font-bold">
                        <span className="text-sm text-gray-400">0</span>
                        <span className="text-[10px] font-black uppercase text-gray-500 tracking-wider">
                          {cat.name}
                        </span>
                        <span className="text-sm text-gray-400">0</span>
                      </div>
                      <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden flex">
                        <div className="h-full bg-gray-200" style={{ width: '50%' }}></div>
                        <div className="h-full bg-gray-200" style={{ width: '50%' }}></div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* 2. roster comparisons list */}
              <div className={`lg:block ${activeTab === 'rosters' ? 'block' : 'hidden'}`}>
                <h3 className="text-xs font-black uppercase tracking-wider text-gray-400 mb-3.5 flex items-center gap-1.5">⛸️ Roster Comparisons</h3>
                <div className="space-y-3">
                  <div className="bg-gray-50 border border-gray-200 rounded-2xl p-3 flex justify-between text-[9px] font-black uppercase text-gray-400 tracking-widest px-4 shadow-inner">
                    <span>{myTeam.teamName.split(' ').pop()} Athletes</span>
                    <span>POS</span>
                    <span>{oppTeam.teamName.split(' ').pop()} Athletes</span>
                  </div>

                  <div className="text-center py-16 px-4 text-xs font-bold text-gray-300 italic border border-dashed border-gray-200 rounded-[24px] bg-white/50 shadow-sm flex flex-col items-center justify-center gap-2">
                    <span className="text-2xl">🥅</span>
                    <span>No active rosters. Comparisons will sync post-draft.</span>
                  </div>
                </div>
              </div>

            </div>

          </div>
          
        </div>
        
      </div>

    </div>
  );
}
