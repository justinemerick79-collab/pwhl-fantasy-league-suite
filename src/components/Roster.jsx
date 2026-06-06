import React, { useState, useEffect } from 'react';
import { db } from '../firebase.js';
import { doc, getDoc, collection, query, where, getDocs } from 'firebase/firestore';
import { useAuth } from '../contexts/AuthContext';
import { useTimeTravel } from '../contexts/TimeTravelContext';
import { normalizePosition, fetchPlayerGameHistory } from '../services/pwhlService';
import PlayerCardModal from './PlayerCardModal';

export default function Roster({ activeLeagueId }) {
  const { currentUser } = useAuth();
  const { activeSeasonId, getSimulatedDate } = useTimeTravel();
  const [loading, setLoading] = useState(true);
  const [loadingLeague, setLoadingLeague] = useState(true);
  const [myTeam, setMyTeam] = useState(null);
  const [leagueData, setLeagueData] = useState(null);
  const [playersMap, setPlayersMap] = useState({});
  const [lockedTeamsSet, setLockedTeamsSet] = useState(new Set());
  const [isUpdating, setIsUpdating] = useState(false);
  const [selectedCardPlayer, setSelectedCardPlayer] = useState(null);
  const [gameHistory, setGameHistory] = useState([]);

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

  // Load dynamic players map from Firestore
  useEffect(() => {
    if (!activeLeagueId || !leagueData) return;
    
    async function loadDynamicPlayers() {
      try {
        const seasonsSnap = await getDocs(collection(db, 'pwhl_seasons'));
        const seasons = seasonsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        
        const seasonId = activeSeasonId ? String(activeSeasonId) : '5';
        
        const qActive = query(collection(db, 'pwhl_players'), where('season_id', 'in', [seasonId, Number(seasonId)]));
        const snapActive = await getDocs(qActive);
        
        let resolvedSeasonId = seasonId;
        let rawPlayers = snapActive.docs.map(d => d.data());
        let isFallback = false;
        
        const currentSeasonDoc = seasons.find(s => String(s.season_id) === String(seasonId));

        if (rawPlayers.length === 0 && seasons.length > 0) {
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
            isFallback = true;
            
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
          teamsMap[String(t.id)] = { code: t.code || t.name || t.id, logo: t.team_logo_url || '' };
        });
        
        let statsData = { skaters: {}, goalies: {} };
        let pointsMap = {};

        if (!isFallback) {
          const { fetchWeeklyPlayerPoints } = await import('../services/statsEngine');
          const simDate = getSimulatedDate();
          
          let weekStartStr = "2024-01-01";
          let weekEndStr = "2024-01-07";
          const currentWeek = leagueData.currentWeek || 1;
          
          if (currentSeasonDoc && currentSeasonDoc.weeks && currentSeasonDoc.weeks.length > 0) {
            const wk = currentSeasonDoc.weeks.find(w => w.week === currentWeek);
            if (wk) {
              weekStartStr = wk.start;
              weekEndStr = wk.end;
            }
          } else {
            const baseTime = new Date("2024-01-01T03:00:00-08:00").getTime();
            const weekMs = 7 * 24 * 60 * 60 * 1000;
            const start = new Date(baseTime + (currentWeek - 1) * weekMs);
            const end = new Date(baseTime + currentWeek * weekMs - 1000);
            weekStartStr = start.toISOString();
            weekEndStr = end.toISOString();
          }

          const weekStart = new Date(weekStartStr);
          const weekEnd = new Date(weekEndStr);
          
          const result = await fetchWeeklyPlayerPoints(resolvedSeasonId, weekStart, weekEnd, simDate, leagueData?.scoringSettings);
          statsData = { skaters: result.skaters, goalies: result.goalies };
          pointsMap = result.pointsMap || {};
        }
        
        const map = {};
        rawPlayers.forEach(p => {
          const pId = p.player_id || p.id;
          if (!pId) return;
          
          const normPos = normalizePosition(p.position);
          const isGoalie = normPos === 'G';
          let gp = 0, g_w = 0, a_otl = 0, pm_ga = 0, sog_sv = 0, blk_so = 0, hits = 0;
          let statsStr = '';
          
          if (!isFallback) {
            if (isGoalie) {
              const g = statsData.goalies[pId] || {};
              gp = g.gamesPlayed || 0;
              g_w = g.wins || 0;
              a_otl = g.overtimeLosses || 0;
              pm_ga = g.goalsAgainst || 0;
              sog_sv = g.shotsSaved || 0;
              const gaa = gp > 0 ? (pm_ga / gp).toFixed(2) : '0.00';
              statsStr = `${g_w}W, ${sog_sv}SV, ${gaa}GAA`;
            } else {
              const s = statsData.skaters[pId] || {};
              gp = s.gamesPlayed || 0;
              g_w = s.goals || 0;
              a_otl = s.assists || 0;
              pm_ga = s.plusMinus || 0;
              statsStr = `${g_w}G, ${a_otl}A, ${pm_ga > 0 ? `+${pm_ga}` : pm_ga} +/-`;
            }
          } else {
            statsStr = isGoalie ? '0W, 0SV, 0.00GAA' : '0G, 0A, 0 +/-';
          }
          
          const rating = p.rating || (isGoalie ? 85 : (normPos === 'D' ? 82 : 84));
          const actualTeamId = String(p.current_team_id || p.team_id || '');
          
          map[String(pId)] = {
            ...p,
            id: String(pId),
            name: p.name || `${p.first_name || ''} ${p.last_name || ''}`.trim() || 'Unknown Player',
            pos: normPos,
            jersey_number: p.tp_jersey_number || p.jersey_number || '',
            teamId: actualTeamId,
            teamCode: teamsMap[actualTeamId]?.code || p.team_name || 'FA',
            teamLogo: teamsMap[actualTeamId]?.logo,
            team: teamsMap[actualTeamId]?.code || p.team_name || 'FA',
            rating,
            stats: statsStr,
            points: pointsMap[pId] || 0.0,
            raw: p
          };
        });
        
        setPlayersMap(map);

        // Fetch games to determine live locks
        const gListSnap = await getDocs(query(collection(db, 'pwhl_games'), where('season_id', 'in', [resolvedSeasonId, Number(resolvedSeasonId)])));
        const gList = gListSnap.docs.map(d => d.data());
        
        const simDate = getSimulatedDate();
        const lckTeams = new Set();
        gList.forEach(g => {
          const gDateStr = g.date_played || g.date;
          if (gDateStr) {
            const gStart = new Date(`${gDateStr}T${g.time || '19:00:00'}`);
            const nextDay1AM = new Date(gStart);
            nextDay1AM.setDate(nextDay1AM.getDate() + 1);
            nextDay1AM.setHours(1, 0, 0, 0);

            if (simDate >= gStart && simDate < nextDay1AM) {
              if (g.home_team) lckTeams.add(String(g.home_team));
              if (g.visiting_team) lckTeams.add(String(g.visiting_team));
            }
          }
        });
        setLockedTeamsSet(lckTeams);

      } catch (err) {
        console.error("Error loading dynamic players in Roster:", err);
      }
    }
    
    loadDynamicPlayers();
  }, [activeLeagueId, activeSeasonId, leagueData]);

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

  const rosterSettings = leagueData?.rosterSettings || { bench: 4, forwards: { starters: 6 }, defense: { starters: 4 }, goalies: { starters: 1 } };
  const fLimit = rosterSettings.forwards?.starters ?? 6;
  const dLimit = rosterSettings.defense?.starters ?? 4;
  const gLimit = rosterSettings.goalies?.starters ?? 1;

  // Legacy fallback if activePlayers is missing (e.g., from old drafts)
  let activeIds = myTeam.activePlayers;
  let benchIds = myTeam.benchPlayers;
  if (!activeIds) {
    activeIds = [];
    benchIds = [];
    let fc = 0, dc = 0, gc = 0;
    
    (myTeam.players || []).forEach(pId => {
      const p = playersMap[pId];
      if (!p) { benchIds.push(pId); return; }
      
      let toActive = false;
      if (p.pos === 'F' && fc < fLimit) { fc++; toActive = true; }
      else if (p.pos === 'D' && dc < dLimit) { dc++; toActive = true; }
      else if (p.pos === 'G' && gc < gLimit) { gc++; toActive = true; }

      if (toActive) activeIds.push(pId);
      else benchIds.push(pId);
    });
  } else {
    benchIds = benchIds || [];
  }

  const isPending = leagueData && (
    leagueData.status === 'pending' || 
    (leagueData.members && leagueData.members.length < leagueData.maxTeams) || 
    !leagueData.draftDate
  );

  let fCount = 0, dCount = 0, gCount = 0;
  
  // Resolve active players
  const activePlayersList = activeIds.map(id => playersMap[id]).filter(Boolean);
  activePlayersList.forEach(p => {
    if (p.pos === 'F') fCount++;
    if (p.pos === 'D') dCount++;
    if (p.pos === 'G') gCount++;
  });

  // Sort Active Roster: Forwards -> Defense -> Goalies
  activePlayersList.sort((a, b) => {
    const posOrder = { 'F': 1, 'D': 2, 'G': 3 };
    return (posOrder[a.pos] || 9) - (posOrder[b.pos] || 9);
  });

  const benchPlayersList = benchIds.map(id => playersMap[id]).filter(Boolean);

  const getTeamBranding = (teamCode) => {
    switch (teamCode) {
      case 'BOS':
        return { gradient: 'from-emerald-800 to-slate-900', borderColor: 'border-emerald-500/35', glowColor: 'shadow-emerald-500/10' };
      case 'MIN':
        return { gradient: 'from-purple-800 to-slate-900', borderColor: 'border-purple-500/35', glowColor: 'shadow-purple-500/10' };
      case 'MTL':
        return { gradient: 'from-rose-900 to-slate-900', borderColor: 'border-rose-500/35', glowColor: 'shadow-rose-500/10' };
      case 'NY':
        return { gradient: 'from-teal-800 to-slate-900', borderColor: 'border-teal-500/35', glowColor: 'shadow-teal-500/10' };
      case 'OTT':
        return { gradient: 'from-red-800 to-slate-900', borderColor: 'border-red-500/35', glowColor: 'shadow-red-500/10' };
      case 'TOR':
        return { gradient: 'from-blue-900 to-slate-900', borderColor: 'border-blue-500/35', glowColor: 'shadow-blue-500/10' };
      default:
        return { gradient: 'from-indigo-900 to-slate-900', borderColor: 'border-indigo-500/35', glowColor: 'shadow-indigo-500/10' };
    }
  };

  const handlePlayerClick = async (p) => {
    const owner = myTeam ? { label: myTeam.name, color: 'bg-indigo-50 text-indigo-600 border-indigo-200' } : null;
    let gp = 0, g_w = 0, a_otl = 0, pm_ga = 0, sog_sv = 0, blk_so = 0, hits = 0;
    if (p.raw) {
      gp = p.raw.gp || 0;
      g_w = p.raw.g_w || 0;
      a_otl = p.raw.a_otl || 0;
      pm_ga = p.raw.pm_ga || 0;
      sog_sv = p.raw.sog_sv || 0;
      blk_so = p.raw.blk_so || 0;
      hits = p.raw.hits || 0;
    }
    const tCode = p.teamCode || p.team || 'FA';
    const playerObj = {
      ...p,
      owner,
      gp, g_w, a_otl, pm_ga, sog_sv, blk_so, hits
    };
    setSelectedCardPlayer(playerObj);
    setGameHistory([]);
    const history = await fetchPlayerGameHistory(p.id, p.pos, tCode, activeSeasonId, getSimulatedDate(), leagueData?.scoringSettings);
    setGameHistory(history);
  };

  const handleMovePlayer = async (playerId, target) => {
    if (isPending || isUpdating) return;
    const p = playersMap[playerId];
    if (p && lockedTeamsSet.has(p.teamId)) {
      alert("This player's team currently has a live game. They are locked until 1:00 AM.");
      return;
    }
    if (target === 'active') {
      if (p.pos === 'F' && fCount >= fLimit) { alert("Maximum active Forwards reached."); return; }
      if (p.pos === 'D' && dCount >= dLimit) { alert("Maximum active Defensemen reached."); return; }
      if (p.pos === 'G' && gCount >= gLimit) { alert("Maximum active Goalies reached."); return; }
    }
    setIsUpdating(true);
    try {
      const { moveRosterPlayer } = await import('../services/leagueService');
      await moveRosterPlayer(activeLeagueId, myTeam.id, playerId, target, rosterSettings);
      setMyTeam(prev => {
        const next = { ...prev };
        let newActive = (next.activePlayers || next.players || []).filter(id => id !== playerId);
        let newBench = (next.benchPlayers || []).filter(id => id !== playerId);
        if (target === 'active') newActive.push(playerId);
        else newBench.push(playerId);
        next.activePlayers = newActive;
        next.benchPlayers = newBench;
        return next;
      });
    } catch (err) {
      console.error("Error moving player:", err);
      alert(err.message);
    } finally {
      setIsUpdating(false);
    }
  };

  const renderTable = (playersToRender, isBenchTable) => (
    <div className="overflow-x-auto rounded-xl border border-gray-200 shadow-sm bg-white mb-8">
      <table className="w-full text-left border-collapse min-w-[600px]">
        <thead>
          <tr className="bg-gray-50 border-b border-gray-200">
            <th className="px-4 py-3 text-[10px] font-black uppercase tracking-widest text-gray-400">Pos</th>
            <th className="px-4 py-3 text-[10px] font-black uppercase tracking-widest text-gray-400">Player</th>
            <th className="px-4 py-3 text-[10px] font-black uppercase tracking-widest text-gray-400">Team</th>
            <th className="px-4 py-3 text-[10px] font-black uppercase tracking-widest text-gray-400">Pts</th>
            <th className="px-4 py-3 text-[10px] font-black uppercase tracking-widest text-gray-400 text-right">Action</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {playersToRender.length === 0 && (
            <tr>
              <td colSpan="5" className="px-4 py-8 text-center text-xs font-bold text-gray-400 italic">
                {isBenchTable ? 'No players on the bench.' : 'No active players.'}
              </td>
            </tr>
          )}
          {playersToRender.map(p => {
            const isLocked = lockedTeamsSet.has(p.teamId);
            const posFull = isBenchTable ? (
              (p.pos === 'F' && fCount >= fLimit) ||
              (p.pos === 'D' && dCount >= dLimit) ||
              (p.pos === 'G' && gCount >= gLimit)
            ) : false;

            const disableMove = isPending || isUpdating || isLocked || posFull;
            let posColor = "bg-gray-100 text-gray-600";
            if (p.pos === 'F') posColor = "bg-indigo-50 text-indigo-600 border-indigo-100";
            if (p.pos === 'D') posColor = "bg-emerald-50 text-emerald-600 border-emerald-100";
            if (p.pos === 'G') posColor = "bg-purple-50 text-purple-600 border-purple-100";

            return (
              <tr key={p.id} className="hover:bg-gray-50/50 transition-colors">
                <td className="px-4 py-3 whitespace-nowrap w-16">
                  <span className={`text-[10px] font-black uppercase px-2 py-1 rounded border tracking-widest ${posColor}`}>
                    {p.pos}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2 cursor-pointer group" onClick={() => handlePlayerClick(p)}>
                    <span className="text-sm font-bold text-gray-900 group-hover:text-indigo-600 transition-colors">{p.name}</span>
                    {isLocked && <span title="Locked due to live game" className="text-xs">🔒</span>}
                  </div>
                  <div className="text-[10px] text-gray-500 font-semibold tracking-wide uppercase mt-0.5 truncate max-w-[250px]">
                    {p.stats}
                  </div>
                </td>
                <td className="px-4 py-3">
                  <span className="text-[10px] font-black text-gray-600 bg-gray-100 px-1.5 py-0.5 rounded border border-gray-200">
                    {p.team}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <span className="text-sm font-sports font-bold text-indigo-600">{p.points.toFixed(1)}</span>
                </td>
                <td className="px-4 py-3 text-right">
                  <button 
                    onClick={() => handleMovePlayer(p.id, isBenchTable ? 'active' : 'bench')}
                    disabled={disableMove}
                    className={`px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-wider transition-all border ${disableMove ? 'bg-gray-50 border-gray-200 text-gray-300 cursor-not-allowed' : 'bg-white border-gray-200 text-gray-600 hover:border-indigo-300 hover:text-indigo-600 shadow-sm hover:shadow active:scale-95'}`}
                  >
                    {isLocked ? 'Locked' : (isBenchTable ? (posFull ? 'Limit Reached' : 'Move to Active') : 'Move to Bench')}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="font-sans select-none antialiased">
      <header className="mb-6 flex justify-between items-end">
        <div>
          <span className="text-[10px] uppercase font-black tracking-widest text-indigo-600 bg-indigo-50 px-3 py-1.5 rounded-full border border-indigo-100 shadow-sm shadow-indigo-100/10">
            {myTeam.teamName}
          </span>
          <h1 className="font-sports text-3xl font-black mt-3 tracking-tight text-gray-900">
            My Roster
          </h1>
          <p className="text-xs text-gray-400 font-semibold tracking-wide mt-0.5">Manage your active starting lineup and bench slots.</p>
        </div>
        <div className="text-right">
           <div className="text-[10px] uppercase tracking-widest text-gray-400 font-black mb-1">Active Slots</div>
           <div className="flex gap-2">
             <span className={`text-xs font-bold px-2 py-1 rounded ${fCount >= fLimit ? 'bg-red-50 text-red-600 border border-red-100' : 'bg-indigo-50 text-indigo-600 border border-indigo-100'}`}>F: {fCount}/{fLimit}</span>
             <span className={`text-xs font-bold px-2 py-1 rounded ${dCount >= dLimit ? 'bg-red-50 text-red-600 border border-red-100' : 'bg-emerald-50 text-emerald-600 border border-emerald-100'}`}>D: {dCount}/{dLimit}</span>
             <span className={`text-xs font-bold px-2 py-1 rounded ${gCount >= gLimit ? 'bg-red-50 text-red-600 border border-red-100' : 'bg-purple-50 text-purple-600 border border-purple-100'}`}>G: {gCount}/{gLimit}</span>
           </div>
        </div>
      </header>

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

      <div className={`${isPending ? 'blur-[1.5px] opacity-45 pointer-events-none' : ''} transition-all duration-300`}>
        <h3 className="text-sm font-black uppercase tracking-wider text-gray-900 mb-3 ml-1 flex items-center gap-2">
          <span>⛸️</span> Active Roster
        </h3>
        {renderTable(activePlayersList, false)}
        <h3 className="text-sm font-black uppercase tracking-wider text-gray-900 mb-3 ml-1 flex items-center gap-2 mt-4">
          <span>🛋️</span> Bench
        </h3>
        {renderTable(benchPlayersList, true)}
      </div>

      <PlayerCardModal 
        player={selectedCardPlayer} 
        gameHistory={gameHistory} 
        teamBranding={selectedCardPlayer ? getTeamBranding(selectedCardPlayer.teamCode) : {}} 
        onClose={() => setSelectedCardPlayer(null)} 
      />
    </div>
  );
}
