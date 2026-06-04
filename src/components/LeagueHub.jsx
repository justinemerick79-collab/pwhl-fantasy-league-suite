import React, { useState, useEffect } from 'react';
import { db } from '../firebase.js';
import { 
  collection, 
  query, 
  where, 
  getDocs, 
  updateDoc, 
  doc, 
  getDoc, 
  arrayUnion, 
  serverTimestamp,
  addDoc
} from 'firebase/firestore';
import { useAuth } from '../contexts/AuthContext';
import { useTimeTravel } from '../contexts/TimeTravelContext';
import { submitAddDrop } from '../services/leagueService.js';

const GENERIC_TEAM_NAMES = [
  "Boston Fleet", "Minnesota Frost", "Montreal Victoires", "New York Sirens",
  "Ottawa Charge", "Toronto Sceptres", "Boston Whitecaps", "Minnesota Muskies",
  "Montreal Maroons", "New York Sound", "Ottawa Alerts", "Toronto Aeros",
  "Great Lakes Royals", "East Coast Rush", "North Star Pride", "Wave Athletic Club"
];

export default function LeagueHub({ activeLeagueId, setActiveLeagueId }) {
  const { currentUser } = useAuth();
  
  // Outer Launcher Tab: 'my-leagues' | 'create' | 'join'
  const [launcherTab, setLauncherTab] = useState('my-leagues');
  
  // Inner Active Dashboard Tab: 'standings' | 'scoreboard' | 'market' | 'settings'
  const [activeDashTab, setActiveDashTab] = useState('standings');
  
  // Database States
  const [myLeagues, setMyLeagues] = useState([]);
  const [userMap, setUserMap] = useState({});
  const [loading, setLoading] = useState(true);
  const [activeLeague, setActiveLeague] = useState(null);
  const [activeLeagueTeams, setActiveLeagueTeams] = useState([]);
  const [myTeam, setMyTeam] = useState(null);

  // Form States - Create
  const [createName, setCreateName] = useState('');
  const [createMaxTeams, setCreateMaxTeams] = useState(6);
  const [matchupDuration, setMatchupDuration] = useState(1);
  const [playoffTeams, setPlayoffTeams] = useState(4);
  const [playoffDuration, setPlayoffDuration] = useState(1);
  const [createLoading, setCreateLoading] = useState(false);
  const [rosterLimits, setRosterLimits] = useState({
    forwards: { starters: 6, max: 10 },
    defense: { starters: 4, max: 8 },
    goalies: { starters: 1, max: 3 },
    bench: 4
  });

  // Form States - Join
  const [joinCode, setJoinCode] = useState('');
  const [joinLoading, setJoinLoading] = useState(false);
  const [joinError, setJoinError] = useState('');

  // Transaction States
  const [selectedMarketPlayer, setSelectedMarketPlayer] = useState(null);
  const [selectedDropPlayer, setSelectedDropPlayer] = useState('');
  const [transactionLoading, setTransactionLoading] = useState(false);
  const [marketSearch, setMarketSearch] = useState('');
  const [marketFilter, setMarketFilter] = useState('ALL');

  const { activeSeasonId } = useTimeTravel();
  const [playersPool, setPlayersPool] = useState([]);

  // Load dynamic players pool from Firestore
  useEffect(() => {
    if (!activeLeagueId) return;
    
    async function loadMarketPlayers() {
      try {
        const seasonsSnap = await getDocs(collection(db, 'pwhl_seasons'));
        const seasons = seasonsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        
        const seasonId = activeSeasonId ? String(activeSeasonId) : '5';
        
        const qActive = query(collection(db, 'pwhl_players'), where('season_id', 'in', [seasonId, Number(seasonId)]));
        const snapActive = await getDocs(qActive);
        
        let resolvedSeasonId = seasonId;
        let rawPlayers = snapActive.docs.map(d => d.data());
        
        if (rawPlayers.length === 0 && seasons.length > 0) {
          const currentSeasonDoc = seasons.find(s => String(s.season_id) === String(seasonId));
          const currentStartDate = currentSeasonDoc ? new Date(currentSeasonDoc.start_date) : new Date();
          const prevRegularSeasons = seasons.filter(s => {
            const isRegular = (s.playoff === '0' || s.playoff === 0) && (s.career === '1' || s.career === 1);
            const startsBefore = new Date(s.start_date) < currentStartDate;
            return isRegular && startsBefore;
          });
          
          if (prevRegularSeasons.length > 0) {
            prevRegularSeasons.sort((a, b) => new Date(b.start_date) - new Date(a.start_date));
            const prevRegSeason = prevRegularSeasons[0];
            resolvedSeasonId = prevRegSeason.season_id.toString();
            
            const qPrev = query(collection(db, 'pwhl_players'), where('season_id', 'in', [resolvedSeasonId, Number(resolvedSeasonId)]));
            const snapPrev = await getDocs(qPrev);
            rawPlayers = snapPrev.docs.map(d => d.data());
          }
        }
        
        const teamsQuery = query(collection(db, 'pwhl_teams'), where('season_id', 'in', [resolvedSeasonId, Number(resolvedSeasonId)]));
        const teamsSnap = await getDocs(teamsQuery);
        const teamsMap = {};
        teamsSnap.forEach(d => {
          const t = d.data();
          teamsMap[String(t.id)] = t.code || t.name || t.id;
        });
        
        const pool = rawPlayers.map(p => {
          const pId = p.player_id || p.id;
          const rating = p.rating || (p.position === 'G' ? 85 : (p.position === 'D' ? 82 : 84));
          return {
            id: String(pId),
            name: p.name || `${p.first_name || ''} ${p.last_name || ''}`.trim() || 'Unknown Player',
            pos: p.position || 'F',
            team: teamsMap[p.current_team_id || p.team_id] || p.team_name || 'FA',
            rating
          };
        });
        
        setPlayersPool(pool);
      } catch (err) {
        console.error("Error loading market players in LeagueHub:", err);
      }
    }
    
    loadMarketPlayers();
  }, [activeLeagueId, activeSeasonId]);

  // Load user leagues list
  useEffect(() => {
    if (!currentUser) return;
    async function fetchLeagues() {
      setLoading(true);
      try {
        const q = query(collection(db, 'fantasy_leagues'), where('members', 'array-contains', currentUser.uid));
        const snap = await getDocs(q);
        const leagues = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        setMyLeagues(leagues);

        const uids = new Set();
        leagues.forEach(l => l.members.forEach(m => uids.add(m)));
        if (uids.size > 0) {
          const map = {};
          for (const uid of Array.from(uids)) {
             const userSnap = await getDoc(doc(db, 'users', uid));
             if (userSnap.exists()) {
               map[uid] = userSnap.data().email || userSnap.data().username || uid;
             } else {
               map[uid] = uid.substring(0, 6);
             }
          }
          setUserMap(map);
        }
      } catch (err) {
        console.error("Error fetching leagues:", err);
      } finally {
        setLoading(false);
      }
    }
    fetchLeagues();
  }, [currentUser, launcherTab, activeLeagueId]);

  // Load active league details, teams, and current user team
  useEffect(() => {
    if (!activeLeagueId || !currentUser) {
      setActiveLeague(null);
      setActiveLeagueTeams([]);
      setMyTeam(null);
      return;
    }
    async function fetchActiveLeagueDetails() {
      try {
        const lSnap = await getDoc(doc(db, 'fantasy_leagues', activeLeagueId));
        if (lSnap.exists()) {
          setActiveLeague({ id: lSnap.id, ...lSnap.data() });
        }

        const tSnap = await getDocs(collection(db, `fantasy_leagues/${activeLeagueId}/teams`));
        const teams = tSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        setActiveLeagueTeams(teams);

        const userTeam = teams.find(t => t.ownerId === currentUser.uid);
        if (userTeam) {
          setMyTeam(userTeam);
        }
      } catch (err) {
        console.error("Error loading active league detail:", err);
      }
    }
    fetchActiveLeagueDetails();
  }, [activeLeagueId, currentUser, transactionLoading]);

  // Handlers
  const handleCreateLeague = async (e) => {
    e.preventDefault();
    if (!createName) return;
    setCreateLoading(true);
    try {
      const inviteCode = Math.random().toString(36).substring(2, 8).toUpperCase();
      const defaultScoring = {
        skaters: { goals: 2, assists: 1, plusMinus: 0.5, ppp: 0.5, shp: 0.5, sog: 0.1, hits: 0.1, blocks: 0.5, defensePoints: 0.5 },
        goalies: { wins: 4, otl: 1, ga: -2, saves: 0.2, shutouts: 3 }
      };

      const leagueRef = await addDoc(collection(db, 'fantasy_leagues'), {
        name: createName,
        ownerId: currentUser.uid,
        commissionerId: currentUser.uid,
        maxTeams: parseInt(createMaxTeams),
        inviteCode,
        members: [currentUser.uid],
        userIds: [currentUser.uid],
        status: 'pending', // Initialize as pending until commissioner fills & activates!
        rosterSettings: rosterLimits,
        scoringSettings: defaultScoring,
        scheduleSettings: {
          matchupDuration: parseInt(matchupDuration),
          playoffTeams: parseInt(playoffTeams),
          playoffDuration: parseInt(playoffDuration)
        },
        waiverOrder: [currentUser.uid],
        createdAt: serverTimestamp()
      });

      // Issue random generic team name
      const randomTeamName = GENERIC_TEAM_NAMES[Math.floor(Math.random() * GENERIC_TEAM_NAMES.length)];

      // Create owner's team document with empty rosters initially
      await addDoc(collection(db, `fantasy_leagues/${leagueRef.id}/teams`), {
        ownerId: currentUser.uid,
        teamName: randomTeamName,
        joinedAt: serverTimestamp(),
        players: [] // Empty roster initially!
      });

      alert(`League created! Invite Code: ${inviteCode}`);
      setCreateName('');
      setLauncherTab('my-leagues');
      setActiveLeagueId(leagueRef.id);
    } catch (err) {
      console.error(err);
      alert('Failed to create league.');
    } finally {
      setCreateLoading(false);
    }
  };

  const handleJoinLeague = async (e) => {
    e.preventDefault();
    setJoinError('');
    if (!joinCode || joinCode.length !== 6) return;
    setJoinLoading(true);
    try {
      const q = query(collection(db, 'fantasy_leagues'), where('inviteCode', '==', joinCode.toUpperCase()));
      const snap = await getDocs(q);
      
      if (snap.empty) {
        setJoinError('League not found.');
        return;
      }

      const leagueDoc = snap.docs[0];
      const leagueData = leagueDoc.data();

      if (leagueData.members.includes(currentUser.uid)) {
        setJoinError('Already joined.');
        return;
      }

      if (leagueData.members.length >= leagueData.maxTeams) {
        setJoinError('League full.');
        return;
      }

      const updatedMembers = [...leagueData.members, currentUser.uid];
      await updateDoc(doc(db, 'fantasy_leagues', leagueDoc.id), {
        members: updatedMembers,
        userIds: updatedMembers
      });

      // Issue random generic team name for joining user
      const randomTeamName = GENERIC_TEAM_NAMES[Math.floor(Math.random() * GENERIC_TEAM_NAMES.length)];

      await addDoc(collection(db, `fantasy_leagues/${leagueDoc.id}/teams`), {
        ownerId: currentUser.uid,
        teamName: randomTeamName,
        joinedAt: serverTimestamp(),
        players: [] // Empty roster initially!
      });
      
      alert(`Joined ${leagueData.name}!`);
      setJoinCode('');
      setLauncherTab('my-leagues');
      setActiveLeagueId(leagueDoc.id);
    } catch (err) {
      console.error(err);
      setJoinError('Failed to join league.');
    } finally {
      setJoinLoading(false);
    }
  };

  // Atomic transaction Add/Drop handler
  const handleMarketTransaction = async () => {
    if (!activeLeagueId || !myTeam || !selectedMarketPlayer) return;
    setTransactionLoading(true);
    try {
      await submitAddDrop(
        activeLeagueId,
        myTeam.id,
        currentUser.uid,
        selectedMarketPlayer.id,
        selectedDropPlayer || null
      );
      alert(`Successfully acquired ${selectedMarketPlayer.name}!`);
      setSelectedMarketPlayer(null);
      setSelectedDropPlayer('');
    } catch (err) {
      console.error(err);
      alert(err.message || 'Transaction failed.');
    } finally {
      setTransactionLoading(false);
    }
  };

  if (!currentUser) {
    return (
      <div className="min-h-screen bg-[#0f0f13] text-gray-100 flex flex-col items-center justify-center p-6 text-center select-none">
        <div className="w-16 h-16 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-3xl mb-6 shadow-xl shadow-indigo-500/5 animate-pulse">
          🔒
        </div>
        <h2 className="text-xl font-bold tracking-tight text-white">Authentication Required</h2>
        <p className="text-gray-400 mt-2 max-w-sm text-sm">Please sign in to access and manage your fantasy leagues.</p>
      </div>
    );
  }

  // Determine all players already owned in active league to filter Marketplace
  const allOwnedPlayerIds = new Set();
  activeLeagueTeams.forEach(team => {
    (team.players || []).forEach(pId => allOwnedPlayerIds.add(pId));
  });

  const freeAgents = playersPool.filter(p => !allOwnedPlayerIds.has(p.id))
    .filter(p => p.name.toLowerCase().includes(marketSearch.toLowerCase()))
    .filter(p => marketFilter === 'ALL' || p.pos === marketFilter);

  return (
    <div className="min-h-screen bg-[#0f0f13] text-gray-100 font-sans antialiased pb-24">
      
      {/* ── CASE 1: LAUNCHER SHELL (NO ACTIVE LEAGUE SELECT OR CONFIGURING TABS) ── */}
      {!activeLeague ? (
        <div className="px-4 pt-6">
          <header className="mb-6">
            <h1 className="text-2xl font-black tracking-tight bg-gradient-to-r from-white to-gray-400 bg-clip-text text-transparent">
              League Launcher
            </h1>
            <p className="text-xs text-gray-500 mt-1 font-semibold">Join or create a command post to begin fantasy matchups.</p>
          </header>

          {/* Launcher Tabs */}
          <div className="flex p-1 bg-black/40 border border-white/5 rounded-2xl mb-6 shadow-inner">
            {['my-leagues', 'create', 'join'].map(tab => (
              <button
                key={tab}
                onClick={() => setLauncherTab(tab)}
                className={`flex-1 py-3 text-[10px] font-black uppercase tracking-wider rounded-xl transition-all duration-300 ${launcherTab === tab ? 'bg-gradient-to-r from-indigo-600 to-violet-500 text-white shadow-md' : 'text-gray-400 hover:text-gray-200'}`}
              >
                {tab.replace('-', ' ')}
              </button>
            ))}
          </div>

          <div className="space-y-4">
            {launcherTab === 'my-leagues' && (
              <div>
                {loading ? (
                  <div className="py-20 text-center text-gray-500 text-xs font-semibold animate-pulse">Retrieving joined leagues...</div>
                ) : myLeagues.length === 0 ? (
                  <div className="text-center py-20 px-6 border border-dashed border-white/10 rounded-2xl bg-white/[0.01]">
                    <span className="text-3xl">🥅</span>
                    <h3 className="text-sm font-bold mt-4">No Joined Leagues</h3>
                    <p className="text-xs text-gray-500 mt-1.5 max-w-xs mx-auto">Create a league to act as commissioner or insert an invite code to join a friend's lobby.</p>
                  </div>
                ) : (
                  <div className="grid gap-4 sm:grid-cols-2">
                    {myLeagues.map(league => (
                      <div 
                        key={league.id} 
                        onClick={() => setActiveLeagueId(league.id)}
                        className="bg-gradient-to-b from-white/5 to-white/[0.01] border border-white/5 p-5 rounded-3xl relative overflow-hidden backdrop-blur-md shadow-lg active:scale-[0.98] transition-transform duration-200 cursor-pointer"
                      >
                        <div className="absolute top-0 right-0 w-24 h-24 bg-indigo-500/5 rounded-full blur-2xl"></div>
                        <div className="flex justify-between items-start">
                          <div>
                            <h3 className="text-base font-black text-white leading-tight">{league.name}</h3>
                            <span className="inline-flex text-[9px] uppercase font-black text-indigo-400 bg-indigo-500/10 px-2.5 py-0.5 rounded-full border border-indigo-500/15 mt-2">
                              {league.members.length} / {league.maxTeams} Teams
                            </span>
                          </div>
                          <span className="w-8 h-8 rounded-full bg-white/5 flex items-center justify-center text-xs font-black">➜</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {launcherTab === 'create' && (
              <form onSubmit={handleCreateLeague} className="space-y-5 bg-white/[0.02] border border-white/5 p-6 rounded-3xl">
                <div>
                  <label className="block text-[10px] uppercase font-black tracking-widest text-gray-500 mb-2">League Name</label>
                  <input 
                    type="text" 
                    value={createName} 
                    onChange={e => setCreateName(e.target.value)} 
                    placeholder="e.g. PWHL Division Cup" 
                    required 
                    className="w-full bg-black/40 border border-white/10 rounded-2xl px-4 py-3 text-sm text-white focus:outline-none focus:border-indigo-500 transition-colors"
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-[10px] uppercase font-black tracking-widest text-gray-500 mb-2">Max Teams</label>
                    <select 
                      value={createMaxTeams} 
                      onChange={e => setCreateMaxTeams(e.target.value)}
                      className="w-full bg-black/40 border border-white/10 rounded-2xl px-4 py-3 text-sm text-white focus:outline-none focus:border-indigo-500 transition-colors"
                    >
                      {[4, 6, 8, 10].map(n => <option key={n} value={n} className="text-black">{n} Teams</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] uppercase font-black tracking-widest text-gray-500 mb-2">Waiver Period</label>
                    <div className="w-full bg-black/20 border border-white/5 rounded-2xl px-4 py-3 text-sm text-indigo-400 font-bold flex items-center justify-center">
                      48 Hours
                    </div>
                  </div>
                </div>

                <button 
                  type="submit" 
                  disabled={createLoading}
                  className="w-full py-4 bg-gradient-to-r from-indigo-600 to-violet-500 rounded-2xl text-xs font-black uppercase tracking-wider text-white shadow-lg active:scale-95 transition-transform disabled:opacity-50 mt-4"
                >
                  {createLoading ? 'Establishing Roster Engine...' : 'Deploy League'}
                </button>
              </form>
            )}

            {launcherTab === 'join' && (
              <form onSubmit={handleJoinLeague} className="space-y-4 bg-white/[0.02] border border-white/5 p-6 rounded-3xl">
                {joinError && <div className="text-xs font-black text-rose-500 bg-rose-500/10 border border-rose-500/15 p-3 rounded-xl">{joinError}</div>}
                <div>
                  <label className="block text-[10px] uppercase font-black tracking-widest text-gray-500 mb-2">Secret Invite Code</label>
                  <input 
                    type="text" 
                    value={joinCode} 
                    onChange={e => setJoinCode(e.target.value.toUpperCase())}
                    placeholder="Enter 6-character code"
                    maxLength={6}
                    required
                    className="w-full bg-black/40 border border-white/10 rounded-2xl px-4 py-3 text-sm text-white text-center font-bold tracking-widest placeholder-gray-600 focus:outline-none focus:border-indigo-500 transition-colors"
                  />
                </div>
                <button 
                  type="submit" 
                  disabled={joinLoading || joinCode.length !== 6}
                  className="w-full py-4 bg-gradient-to-r from-indigo-600 to-violet-500 rounded-2xl text-xs font-black uppercase tracking-wider text-white shadow-lg active:scale-95 transition-transform disabled:opacity-50"
                >
                  {joinLoading ? 'Validating credentials...' : 'Enter Arena'}
                </button>
              </form>
            )}
          </div>
        </div>
      ) : (
        
        // ── CASE 2: ACTIVE LEAGUE COMMAND Hub (BOTTOM NAVIGATION DRIVEN) ──
        <div>
          {/* Active League Title Banner */}
          <div className="px-4 pt-6 pb-2 bg-gradient-to-b from-white/[0.02] to-transparent border-b border-white/5 flex justify-between items-center">
            <div>
              <span className="text-[9px] uppercase font-extrabold tracking-widest text-indigo-400 bg-indigo-500/10 px-2 py-0.5 rounded-full border border-indigo-500/15">
                Active League Hub
              </span>
              <h2 className="text-lg font-black text-white mt-1 leading-tight">{activeLeague.name}</h2>
            </div>
            
            {/* Quick Exit League Toggle */}
            <button 
              onClick={() => setActiveLeagueId(null)}
              className="text-[10px] uppercase font-black text-gray-400 bg-white/5 border border-white/10 px-3 py-1.5 rounded-xl hover:text-white"
            >
              Exit
            </button>
          </div>

          <div className="px-4 pt-4">
            {/* SUB-TAB 1: LEAGUE STANDINGS */}
            {activeDashTab === 'standings' && (
              <div className="space-y-4">
                <div className="flex justify-between items-center">
                  <h3 className="text-sm font-black uppercase tracking-wider text-gray-400">🏆 Season Standings</h3>
                </div>

                <div className="overflow-hidden border border-white/5 rounded-3xl bg-white/[0.01]">
                  <div className="grid grid-cols-12 bg-white/5 p-3.5 text-[10px] font-black uppercase text-gray-500 tracking-wider">
                    <div className="col-span-2">Rk</div>
                    <div className="col-span-6">Team</div>
                    <div className="col-span-2 text-right">W-L</div>
                    <div className="col-span-2 text-right">Pts</div>
                  </div>

                  <div className="divide-y divide-white/5">
                    {activeLeagueTeams.length === 0 ? (
                      <div className="p-8 text-center text-xs text-gray-500">No teams found in standings.</div>
                    ) : (
                      [...activeLeagueTeams]
                        .sort((a,b) => (b.points || 0) - (a.points || 0))
                        .map((team, idx) => (
                          <div key={team.id} className="grid grid-cols-12 p-4 text-xs items-center">
                            <div className="col-span-2 font-black text-gray-400">{idx + 1}</div>
                            <div className="col-span-6 font-bold text-white flex items-center gap-2">
                              <span>{idx === 0 ? '🐍' : idx === 1 ? '❄️' : '🏒'}</span>
                              <span className="truncate">{team.teamName}</span>
                              {team.ownerId === currentUser.uid && <span className="text-[8px] bg-indigo-500/20 text-indigo-400 px-1 py-0.2 rounded font-black">YOU</span>}
                            </div>
                            <div className="col-span-2 text-right font-medium text-gray-400">0-0</div>
                            <div className="col-span-2 text-right font-black text-white">0.0</div>
                          </div>
                        ))
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* SUB-TAB 2: LEAGUE SCOREBOARD */}
            {activeDashTab === 'scoreboard' && (
              <div className="space-y-4">
                <h3 className="text-sm font-black uppercase tracking-wider text-gray-400">📊 H2H Weekly Matchups</h3>

                <div className="space-y-4">
                  {/* Mock H2H Pairs */}
                  <div className="bg-white/[0.02] border border-white/5 p-4 rounded-3xl">
                    <div className="flex justify-between text-[10px] text-gray-500 font-bold uppercase tracking-wider mb-3">
                      <span>Matchup 1</span>
                      <span className="text-indigo-400">Active Matchup</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <div className="flex items-center gap-2">
                        <span className="text-lg">🐍</span>
                        <span className="text-xs font-bold">Montreal Vipers</span>
                      </div>
                      <span className="text-xs font-black">142.5</span>
                    </div>
                    <div className="flex justify-between items-center mt-2">
                      <div className="flex items-center gap-2">
                        <span className="text-lg">❄️</span>
                        <span className="text-xs font-bold">Toronto Blizzard</span>
                      </div>
                      <span className="text-xs font-black">128.0</span>
                    </div>
                  </div>

                  <div className="bg-white/[0.02] border border-white/5 p-4 rounded-3xl opacity-75">
                    <div className="flex justify-between text-[10px] text-gray-500 font-bold uppercase tracking-wider mb-3">
                      <span>Matchup 2</span>
                      <span>Ready</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <div className="flex items-center gap-2">
                        <span className="text-lg">🦁</span>
                        <span className="text-xs font-bold">Boston Pride</span>
                      </div>
                      <span className="text-xs font-black">0.0</span>
                    </div>
                    <div className="flex justify-between items-center mt-2">
                      <div className="flex items-center gap-2">
                        <span className="text-lg">⚡</span>
                        <span className="text-xs font-bold">Ottawa Charge</span>
                      </div>
                      <span className="text-xs font-black">0.0</span>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* SUB-TAB 3: PLAYER MARKETPLACE (FREE AGENTS PROTOTYPE) */}
            {activeDashTab === 'market' && (
              <div className="space-y-4">
                <h3 className="text-sm font-black uppercase tracking-wider text-gray-400">🛒 Free Agent Market</h3>

                {/* Filter and Search */}
                <div className="space-y-3">
                  <input 
                    type="text" 
                    value={marketSearch}
                    onChange={e => setMarketSearch(e.target.value)}
                    placeholder="Search active athletes..."
                    className="w-full bg-black/40 border border-white/10 rounded-2xl px-4 py-3 text-xs text-white focus:outline-none focus:border-indigo-500"
                  />
                  <div className="flex gap-2 overflow-x-auto pb-1">
                    {['ALL', 'F', 'D', 'G'].map(pos => (
                      <button
                        key={pos}
                        onClick={() => setMarketFilter(pos)}
                        className={`text-[9px] uppercase font-black tracking-wider px-3.5 py-2 rounded-xl border transition-colors ${marketFilter === pos ? 'bg-indigo-600 border-indigo-500 text-white' : 'bg-white/5 border-white/5 text-gray-400 hover:text-white'}`}
                      >
                        {pos === 'ALL' ? 'All Roles' : pos === 'F' ? 'Forwards' : pos === 'D' ? 'Defense' : 'Goalies'}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Marketplace Athletes List */}
                <div className="space-y-3">
                  {freeAgents.length === 0 ? (
                    <div className="text-center py-10 text-xs text-gray-500 italic">No available free agents matching criteria.</div>
                  ) : (
                    freeAgents.map(athlete => (
                      <div key={athlete.id} className="bg-white/[0.02] border border-white/5 p-4 rounded-2xl flex justify-between items-center">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-[9px] font-black text-gray-400 bg-white/5 px-1.5 py-0.5 rounded border border-white/5">{athlete.pos}</span>
                            <span className="text-[10px] text-gray-400 font-bold">{athlete.team}</span>
                            <span className="text-xs font-black text-white">{athlete.name}</span>
                          </div>
                          <p className="text-[9px] text-gray-500 font-bold mt-1 uppercase tracking-wider">OVR Rating: {athlete.rating}</p>
                        </div>
                        
                        {/* Transaction Call Trigger */}
                        <button 
                          onClick={() => {
                            if (!myTeam) return alert("Roster required to perform transactions!");
                            setSelectedMarketPlayer(athlete);
                          }}
                          className="px-4 py-2 bg-gradient-to-r from-indigo-600 to-violet-500 rounded-xl text-[10px] font-black uppercase text-white tracking-wider"
                        >
                          Acquire
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}

            {/* SUB-TAB 4: SETTINGS & COMMISSIONER RULES */}
            {activeDashTab === 'settings' && (
              <div className="space-y-4">
                <h3 className="text-sm font-black uppercase tracking-wider text-gray-400">⚙️ Settings & Rules</h3>

                {/* Invite Card */}
                <div className="bg-gradient-to-b from-indigo-500/10 to-transparent border border-indigo-500/20 p-5 rounded-3xl relative overflow-hidden">
                  <span className="text-[8px] uppercase font-black tracking-widest text-indigo-400">Recruitment</span>
                  <h4 className="text-xs font-bold mt-1 text-gray-300">Invite Code to share with friends:</h4>
                  <div className="flex items-center justify-between mt-3 bg-black/40 border border-white/5 px-4 py-2.5 rounded-2xl">
                    <span className="text-base font-black tracking-widest text-white">{activeLeague.inviteCode}</span>
                    <button 
                      onClick={() => {
                        navigator.clipboard.writeText(activeLeague.inviteCode);
                        alert("Invite code copied!");
                      }}
                      className="text-[9px] uppercase font-black text-indigo-400 hover:text-indigo-300"
                    >
                      Copy
                    </button>
                  </div>
                </div>

                {/* Read-Only Rules Cards */}
                <div className="bg-white/[0.02] border border-white/5 p-5 rounded-3xl space-y-3.5">
                  <h4 className="text-xs font-black uppercase tracking-wider text-gray-400 border-b border-white/5 pb-2">Roster Limits</h4>
                  <div className="flex justify-between text-xs py-1">
                    <span className="text-gray-500">Active Roster Size</span>
                    <span className="font-bold">14 Athletes</span>
                  </div>
                  <div className="flex justify-between text-xs py-1">
                    <span className="text-gray-500">Bench Slots</span>
                    <span className="font-bold">4 Players</span>
                  </div>
                  <div className="flex justify-between text-xs py-1">
                    <span className="text-gray-500">Forwards Starters</span>
                    <span className="font-bold">6 Starters (Max 10)</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── ATOMIC TRANSACTION MODAL POPUP (ACQUIRE FREE AGENT) ── */}
      {selectedMarketPlayer && myTeam && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-6 z-50">
          <div className="w-full max-w-sm bg-[#16161c] border border-white/10 rounded-3xl p-6 shadow-2xl relative">
            <h3 className="text-sm font-black uppercase text-gray-400 tracking-wider">Confirm Transaction</h3>
            
            <div className="mt-4 p-4 rounded-2xl bg-white/[0.02] border border-white/5">
              <span className="text-[9px] uppercase font-extrabold tracking-widest text-indigo-400 bg-indigo-500/10 px-2 py-0.5 rounded border border-indigo-500/15">ACQUIRE</span>
              <p className="text-sm font-black text-white mt-2">{selectedMarketPlayer.name}</p>
              <p className="text-[10px] text-gray-500 mt-0.5">{selectedMarketPlayer.pos} • {selectedMarketPlayer.team}</p>
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
                  const pDetail = playersPool.find(p => p.id === pId) || { name: pId };
                  return <option key={pId} value={pId} className="text-black">Drop: {pDetail.name}</option>;
                })}
              </select>
              <p className="text-[9px] text-gray-600 mt-2">Note: Dropped athletes will be placed on waivers for 48 hours.</p>
            </div>

            <div className="flex gap-3 mt-6">
              <button 
                onClick={() => {
                  setSelectedMarketPlayer(null);
                  setSelectedDropPlayer('');
                }}
                disabled={transactionLoading}
                className="flex-1 py-3.5 bg-white/5 hover:bg-white/10 border border-white/5 rounded-2xl text-[10px] font-black uppercase text-gray-400 tracking-wider active:scale-95 transition-transform"
              >
                Cancel
              </button>
              <button 
                onClick={handleMarketTransaction}
                disabled={transactionLoading}
                className="flex-1 py-3.5 bg-gradient-to-r from-indigo-600 to-violet-500 rounded-2xl text-[10px] font-black uppercase text-white tracking-wider active:scale-95 transition-transform shadow-lg shadow-indigo-600/10"
              >
                {transactionLoading ? 'Executing...' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── FIXED MOBILE BOTTOM NAVIGATION BAR (LOCK UNDER SCREEN VIEWPORTS) ── */}
      {activeLeague && (
        <nav className="fixed bottom-0 left-0 right-0 h-16 bg-[#16161c]/95 border-t border-white/5 backdrop-blur-lg flex justify-around items-center px-2 z-40">
          <button 
            onClick={() => setActiveDashTab('standings')}
            className={`flex flex-col items-center justify-center w-16 h-12 rounded-xl transition-all ${activeDashTab === 'standings' ? 'text-indigo-400 scale-105 font-bold' : 'text-gray-500 hover:text-gray-300'}`}
          >
            <span className="text-sm">🏆</span>
            <span className="text-[9px] tracking-tight font-extrabold uppercase mt-0.5">Standings</span>
          </button>

          <button 
            onClick={() => setActiveDashTab('scoreboard')}
            className={`flex flex-col items-center justify-center w-16 h-12 rounded-xl transition-all ${activeDashTab === 'scoreboard' ? 'text-indigo-400 scale-105 font-bold' : 'text-gray-500 hover:text-gray-300'}`}
          >
            <span className="text-sm">📊</span>
            <span className="text-[9px] tracking-tight font-extrabold uppercase mt-0.5">Scores</span>
          </button>

          <button 
            onClick={() => setActiveDashTab('market')}
            className={`flex flex-col items-center justify-center w-16 h-12 rounded-xl transition-all ${activeDashTab === 'market' ? 'text-indigo-400 scale-105 font-bold' : 'text-gray-500 hover:text-gray-300'}`}
          >
            <span className="text-sm">🛒</span>
            <span className="text-[9px] tracking-tight font-extrabold uppercase mt-0.5">Market</span>
          </button>

          <button 
            onClick={() => setActiveDashTab('settings')}
            className={`flex flex-col items-center justify-center w-16 h-12 rounded-xl transition-all ${activeDashTab === 'settings' ? 'text-indigo-400 scale-105 font-bold' : 'text-gray-500 hover:text-gray-300'}`}
          >
            <span className="text-sm">⚙️</span>
            <span className="text-[9px] tracking-tight font-extrabold uppercase mt-0.5">Settings</span>
          </button>
        </nav>
      )}

    </div>
  );
}
