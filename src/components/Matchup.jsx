import React, { useState, useEffect, useRef, useMemo } from 'react';
import { db } from '../firebase.js';
import { doc, getDoc, collection, getDocs, query, where, updateDoc } from 'firebase/firestore';
import { useAuth } from '../contexts/AuthContext';
import { useTimeTravel } from '../contexts/TimeTravelContext';
import PlayerCardModal from './PlayerCardModal';

export default function Matchup({ activeLeagueId, setCurrentTab }) {
  const { currentUser } = useAuth();
  const { activeSeasonId, getSimulatedDate, simulationState } = useTimeTravel();

  const getLocalDateStr = (date) => {
    if (!date) return '';
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };
  // Safe parser: avoids UTC midnight shift when parsing "YYYY-MM-DD" strings
  const parseDateStr = (dateStr) => {
    if (!dateStr) return new Date();
    // If it's already an ISO string with time info, parse normally
    if (dateStr.includes('T') || dateStr.includes(' ')) return new Date(dateStr);
    // Bare YYYY-MM-DD: parse as local noon to avoid timezone day shift
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(y, m - 1, d, 12, 0, 0);
  };
  const [activeTab, setActiveTab] = useState('scoreboard'); // 'scoreboard' | 'rosters' (Used for mobile aspect stack)
  const [leagueData, setLeagueData] = useState(null);
  const [teams, setTeams] = useState([]);
  const [loading, setLoading] = useState(true);
  const [timeLeft, setTimeLeft] = useState({ days: 0, hours: 0, minutes: 0, seconds: 0, totalMs: 0 });
  const [isDraftDetailsOpen, setIsDraftDetailsOpen] = useState(false);
  const [selectedCardPlayer, setSelectedCardPlayer] = useState(null);

  const [weeklyMatchups, setWeeklyMatchups] = useState([]);
  const [matchupsLoading, setMatchupsLoading] = useState(true);
  const [playerStats, setPlayerStats] = useState({});
  const [dailyPlayerStats, setDailyPlayerStats] = useState({});
  const [selectedMatchupDate, setSelectedMatchupDate] = useState(null);
  const lastSimDateStrRef = useRef('');
  const lastLeagueIdRef = useRef('');
  const lastWeekRef = useRef(null);
  const [pwhlGames, setPwhlGames] = useState([]);

  const [playersMap, setPlayersMap] = useState({});
  const [seasonWeeks, setSeasonWeeks] = useState([]);
  const [isOffWeek, setIsOffWeek] = useState(false);
  const [weekDateRange, setWeekDateRange] = useState('');
  const [resolvedCurrentWeek, setResolvedCurrentWeek] = useState(1);

  const matchupWeekBounds = useMemo(() => {
    let weekStartStr = "2024-01-01";
    let weekEndStr = "2024-01-07";
    
    if (seasonWeeks && seasonWeeks.length > 0) {
      const wk = seasonWeeks.find(w => w.week === resolvedCurrentWeek);
      if (wk) {
        weekStartStr = wk.start;
        weekEndStr = wk.end;
      }
    } else {
      const baseTime = new Date("2024-01-01T03:00:00-08:00").getTime();
      const weekMs = 7 * 24 * 60 * 60 * 1000;
      const start = new Date(baseTime + (resolvedCurrentWeek - 1) * weekMs);
      const end = new Date(baseTime + resolvedCurrentWeek * weekMs - 1000);
      weekStartStr = start.toISOString();
      weekEndStr = end.toISOString();
    }

    return {
      start: new Date(weekStartStr),
      end: new Date(weekEndStr)
    };
  }, [seasonWeeks, resolvedCurrentWeek]);

  // Compute full season bounds (first week start to last week end)
  const seasonBounds = useMemo(() => {
    if (!seasonWeeks || seasonWeeks.length === 0) return { start: null, end: null };
    const sorted = [...seasonWeeks].sort((a, b) => a.week - b.week);
    return {
      start: new Date(sorted[0].start),
      end: new Date(sorted[sorted.length - 1].end)
    };
  }, [seasonWeeks]);

  // Sync selectedMatchupDate to simulation date (clamped to week bounds) when simulation/league changes
  useEffect(() => {
    if (!seasonWeeks || seasonWeeks.length === 0) return;
    if (!matchupWeekBounds.start || !matchupWeekBounds.end) return;
    const simDate = getSimulatedDate();
    const simDateStr = getLocalDateStr(simDate);

    const hasSimDateChanged = simDateStr !== lastSimDateStrRef.current;
    const hasLeagueChanged = activeLeagueId !== lastLeagueIdRef.current;

    if (hasSimDateChanged || hasLeagueChanged || !selectedMatchupDate) {
      lastSimDateStrRef.current = simDateStr;
      lastLeagueIdRef.current = activeLeagueId;
      lastWeekRef.current = resolvedCurrentWeek;

      let targetDate = simDate;
      if (targetDate < matchupWeekBounds.start) targetDate = matchupWeekBounds.start;
      if (targetDate > matchupWeekBounds.end) targetDate = matchupWeekBounds.end;

      setSelectedMatchupDate(targetDate);
    } else {
      lastWeekRef.current = resolvedCurrentWeek;
    }
  }, [activeLeagueId, matchupWeekBounds, getSimulatedDate, seasonWeeks]);

  // Daily lineups scoring state
  const [homeLineupsState, setHomeLineupsState] = useState({});
  const [awayLineupsState, setAwayLineupsState] = useState({});
  // Daily lineups scoring state
  const [homeScoreCalc, setHomeScoreCalc] = useState(0.0);
  const [awayScoreCalc, setAwayScoreCalc] = useState(0.0);

  // Extract factual team details from Firestore loaded lists
  const myTeam = teams.find(t => t.ownerId === currentUser?.uid) || { teamName: "My Team", avatar: "🏒" };
  const oppTeam = teams.find(t => t.ownerId !== currentUser?.uid) || { teamName: "Waiting for Opponent", avatar: "🥅" };

  const myTeamMatchup = myTeam ? weeklyMatchups.find(m => m.homeTeamId === myTeam.id || m.awayTeamId === myTeam.id) : null;
  const isHome = myTeam && myTeamMatchup && myTeam.id === myTeamMatchup.homeTeamId;
  const myScore = myTeamMatchup ? (isHome ? myTeamMatchup.homeScore : myTeamMatchup.awayScore) : 0.0;
  const oppScore = myTeamMatchup ? (isHome ? myTeamMatchup.awayScore : myTeamMatchup.homeScore) : 0.0;

  const oppTeamId = myTeamMatchup ? (isHome ? myTeamMatchup.awayTeamId : myTeamMatchup.homeTeamId) : null;
  const resolvedOppTeam = teams.find(t => t.id === oppTeamId) || oppTeam;

  const myScoreCalc = isHome ? homeScoreCalc : awayScoreCalc;
  const oppScoreCalc = isHome ? awayScoreCalc : homeScoreCalc;

  useEffect(() => {
    if (!leagueData) return;
    const targetDate = selectedMatchupDate || getSimulatedDate();
    let cw = leagueData.currentWeek || 1;
    if (seasonWeeks && seasonWeeks.length > 0) {
      const matchedWeek = seasonWeeks.find(w => {
        const s = new Date(w.start);
        const e = new Date(w.end);
        return targetDate >= s && targetDate <= e;
      });
      if (matchedWeek) {
        cw = matchedWeek.week;
      }
    }
    setResolvedCurrentWeek(cw);
  }, [leagueData, seasonWeeks, selectedMatchupDate, getSimulatedDate]);

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

  // Load dynamic players and season weeks list from Firestore
  useEffect(() => {
    if (!activeLeagueId) return;
    
    async function loadSeasonAndPlayers() {
      try {
        const seasonsSnap = await getDocs(collection(db, 'pwhl_seasons'));
        const seasons = seasonsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        
        const seasonId = activeSeasonId ? String(activeSeasonId) : '5';
        
        // Find season doc to get weeks array
        const currentSeasonDoc = seasons.find(s => String(s.season_id) === String(seasonId));
        if (currentSeasonDoc && currentSeasonDoc.weeks) {
          setSeasonWeeks(currentSeasonDoc.weeks);
        } else {
          setSeasonWeeks([]);
        }
        
        const qActive = query(collection(db, 'pwhl_players'), where('season_id', 'in', [seasonId, Number(seasonId)]));
        const snapActive = await getDocs(qActive);
        
        let resolvedSeasonId = seasonId;
        let rawPlayers = snapActive.docs.map(d => d.data());
        
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
        
        const map = {};
        rawPlayers.forEach(p => {
          const pId = p.player_id || p.id;
          if (!pId) return;
          const cleanId = String(pId);
          const actualTeamId = p.current_team_id || p.team_id;
          
          let normPos = p.position || 'F';
          if (normPos === 'C' || normPos === 'LW' || normPos === 'RW') normPos = 'F';
          else if (normPos === 'LD' || normPos === 'RD') normPos = 'D';
          
          const rating = p.rating || (normPos === 'G' ? 85 : (normPos === 'D' ? 82 : 84));

          map[cleanId] = {
            ...p,
            id: cleanId,
            name: p.name || `${p.first_name || ''} ${p.last_name || ''}`.trim() || 'Unknown Player',
            pos: normPos,
            jersey_number: p.tp_jersey_number || p.jersey_number || '',
            teamCode: teamsMap[actualTeamId]?.code || p.team_name || 'FA',
            teamLogo: teamsMap[actualTeamId]?.logo,
            team: teamsMap[actualTeamId]?.code || p.team_name || 'FA',
            team_id: actualTeamId,
            rating
          };
        });
        
        setPlayersMap(map);
        
        // Fetch schedule to determine daily game statuses
        const gamesQuery = query(collection(db, 'pwhl_games'), where('season_id', 'in', [resolvedSeasonId, Number(resolvedSeasonId)]));
        const gamesSnap = await getDocs(gamesQuery);
        setPwhlGames(gamesSnap.docs.map(d => ({ id: d.id, ...d.data() })));

      } catch (err) {
        console.error("Error loading season/players in Matchup:", err);
      }
    }
    
    loadSeasonAndPlayers();
  }, [activeLeagueId, activeSeasonId, leagueData]);

  // Fetch matchups and player stats when leagueData updates
  useEffect(() => {
    if (!activeLeagueId || !leagueData) return;
    const matchupsRef = collection(db, `fantasy_leagues/${activeLeagueId}/matchups`);
    setMatchupsLoading(true);
    
    getDocs(matchupsRef).then((snap) => {
      const allMatchups = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      const filtered = allMatchups.filter(m => m.week === resolvedCurrentWeek);
      setWeeklyMatchups(filtered);
      setMatchupsLoading(false);
    }).catch(err => {
      console.error("Error loading matchups:", err);
      setMatchupsLoading(false);
    });

    // Fetch player fantasy points for the current matchup week
    const loadPoints = async () => {
      if (!myTeam?.id || !oppTeamId || !selectedMatchupDate) return;
      try {
        const { fetchDailyPlayerPointsFromSnapshot } = await import('../services/statsEngine');
        const simDate = getSimulatedDate();
        const resolvedSeasonId = activeSeasonId ? String(activeSeasonId) : '5';

        const weekStart = matchupWeekBounds.start || new Date("2024-01-01");
        const weekEnd = matchupWeekBounds.end || new Date("2024-01-07");

        // 1. Fetch daily player points for the entire week (reads from daily_game_stats with fallback)
        const dailyPointsForWeek = await fetchDailyPlayerPointsFromSnapshot(resolvedSeasonId, weekStart, weekEnd, simDate, leagueData?.scoringSettings, activeLeagueId);
        
        // Also fetch daily points for the selected matchup day for the rosters table display
        const dayDateStr = getLocalDateStr(selectedMatchupDate);
        setDailyPlayerStats(dailyPointsForWeek[dayDateStr] || {});

        // 2. Fetch daily lineups for home and away teams
        const homeLineupsSnap = await getDocs(collection(db, `fantasy_leagues/${activeLeagueId}/teams/${myTeam.id}/daily_lineups`));
        const homeLineups = {};
        homeLineupsSnap.forEach(d => {
          homeLineups[d.id] = d.data();
        });
        setHomeLineupsState(homeLineups);

        const awayLineupsSnap = await getDocs(collection(db, `fantasy_leagues/${activeLeagueId}/teams/${oppTeamId}/daily_lineups`));
        const awayLineups = {};
        awayLineupsSnap.forEach(d => {
          awayLineups[d.id] = d.data();
        });
        setAwayLineupsState(awayLineups);

        // 3. Calculate dynamic scores by summing active points day-by-day
        const dates = [];
        const current = new Date(weekStart);
        while (current <= weekEnd) {
          dates.push(getLocalDateStr(current));
          current.setDate(current.getDate() + 1);
        }

        const rosterSettings = leagueData?.rosterSettings || { bench: 4, forwards: { starters: 6 }, defense: { starters: 4 }, goalies: { starters: 1 } };
        const fLimit = rosterSettings.forwards?.starters ?? 6;
        const dLimit = rosterSettings.defense?.starters ?? 4;
        const gLimit = rosterSettings.goalies?.starters ?? 1;

        const calcTeamScore = (teamLineups, teamDoc) => {
          let score = 0.0;
          dates.forEach(dStr => {
            let activeLineup = {};
            const daily = teamLineups[dStr];
            if (daily && daily.activeLineup) {
              activeLineup = daily.activeLineup;
            } else {
              // Fallback default position mapping
              const activeIds = (teamDoc.activePlayers || []).map(String);
              let fc = 0, dc = 0, gc = 0;
              activeIds.forEach(pId => {
                const info = playersMap[pId] || {};
                const pos = info.pos || 'F';
                if (pos === 'F' && fc < fLimit) { fc++; activeLineup[`F${fc}`] = pId; }
                else if (pos === 'D' && dc < dLimit) { dc++; activeLineup[`D${dc}`] = pId; }
                else if (pos === 'G' && gc < gLimit) { gc++; activeLineup[`G${gc}`] = pId; }
              });
            }

            Object.values(activeLineup).forEach(pId => {
              if (pId) {
                const pts = dailyPointsForWeek[dStr]?.[pId] || 0.0;
                score += pts;
              }
            });
          });
          return score;
        };

        const homeCalc = calcTeamScore(homeLineups, myTeam);
        const awayCalc = calcTeamScore(awayLineups, resolvedOppTeam);
        setHomeScoreCalc(homeCalc);
        setAwayScoreCalc(awayCalc);

      } catch (err) {
        console.error("Error loading player points:", err);
      }
    };
    
    loadPoints();
  }, [activeLeagueId, leagueData, activeSeasonId, getSimulatedDate, selectedMatchupDate, resolvedCurrentWeek, myTeam?.id, oppTeamId, playersMap, matchupWeekBounds]);

  useEffect(() => {
    if (!leagueData || !leagueData.draftDate) return;

    const calculateTimeLeft = () => {
      const difference = new Date(leagueData.draftDate) - getSimulatedDate();
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

  // Resolve week date range and off-week status when seasonWeeks/resolvedCurrentWeek updates
  useEffect(() => {
    if (!leagueData) return;
    
    if (seasonWeeks && seasonWeeks.length > 0) {
      const wk = seasonWeeks.find(w => w.week === resolvedCurrentWeek);
      if (wk) {
        setIsOffWeek(!!wk.isOffWeek);
        const start = new Date(wk.start);
        const end = new Date(wk.end);
        const options = { month: 'short', day: 'numeric' };
        setWeekDateRange(`${start.toLocaleDateString('en-US', options)} - ${end.toLocaleDateString('en-US', options)}`);
        return;
      }
    }
    
    setIsOffWeek(false);
    // Fallback date calculation
    const baseTime = new Date("2024-01-01T03:00:00-08:00").getTime();
    const weekMs = 7 * 24 * 60 * 60 * 1000;
    const start = new Date(baseTime + (resolvedCurrentWeek - 1) * weekMs);
    const end = new Date(baseTime + resolvedCurrentWeek * weekMs - 1000);
    const options = { month: 'short', day: 'numeric' };
    setWeekDateRange(`${start.toLocaleDateString('en-US', options)} - ${end.toLocaleDateString('en-US', options)}`);
  }, [leagueData, seasonWeeks, resolvedCurrentWeek]);

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
  const isDrafting = leagueData?.status === 'drafting';
  const isCommissioner = leagueData && currentUser && currentUser.uid === leagueData.ownerId;
  const hasDraftDate = leagueData && !!leagueData.draftDate;
  
  // Imminent threshold: less than 1 hour away (or date has passed but status is still pending)
  const isDraftImminent = hasDraftDate && (timeLeft.totalMs <= 60 * 60 * 1000);
  
  // Factual check if the league is full or waiting for teams
  const isFull = leagueData && leagueData.members && (leagueData.members.length >= leagueData.maxTeams);

  const currentWeek = leagueData?.currentWeek || 1;

  let winProb = 50;
  if (myTeamMatchup && (myScoreCalc > 0 || oppScoreCalc > 0)) {
    winProb = Math.round((myScoreCalc / (myScoreCalc + oppScoreCalc)) * 100);
    if (winProb < 5) winProb = 5;
    if (winProb > 95) winProb = 95;
  }

  const buildStartingLineups = () => {
    if (!myTeam || !resolvedOppTeam || !selectedMatchupDate) return [];
    
    const dateStr = getLocalDateStr(selectedMatchupDate);
    const rosterSettings = leagueData?.rosterSettings || { bench: 4, forwards: { starters: 6 }, defense: { starters: 4 }, goalies: { starters: 1 } };
    const fLimit = rosterSettings.forwards?.starters ?? 6;
    const dLimit = rosterSettings.defense?.starters ?? 4;
    const gLimit = rosterSettings.goalies?.starters ?? 1;
    
    // Resolve home team lineup
    let homeActive = {};
    let homeBench = [];
    const homeDoc = homeLineupsState[dateStr];
    if (homeDoc) {
      homeActive = homeDoc.activeLineup || {};
      homeBench = homeDoc.bench || [];
    } else {
      // Fallback
      const activeIds = (myTeam.activePlayers || []).map(String);
      let fc = 0, dc = 0, gc = 0;
      activeIds.forEach(pId => {
        const info = playersMap[pId] || {};
        const pos = info.pos || 'F';
        if (pos === 'F' && fc < fLimit) { fc++; homeActive[`F${fc}`] = pId; }
        else if (pos === 'D' && dc < dLimit) { dc++; homeActive[`D${dc}`] = pId; }
        else if (pos === 'G' && gc < gLimit) { gc++; homeActive[`G${gc}`] = pId; }
        else { homeBench.push(pId); }
      });
      (myTeam.benchPlayers || []).forEach(pId => homeBench.push(String(pId)));
    }

    // Resolve away team lineup
    let awayActive = {};
    let awayBench = [];
    const awayDoc = awayLineupsState[dateStr];
    if (awayDoc) {
      awayActive = awayDoc.activeLineup || {};
      awayBench = awayDoc.bench || [];
    } else {
      // Fallback
      const activeIds = (resolvedOppTeam.activePlayers || []).map(String);
      let fc = 0, dc = 0, gc = 0;
      activeIds.forEach(pId => {
        const info = playersMap[pId] || {};
        const pos = info.pos || 'F';
        if (pos === 'F' && fc < fLimit) { fc++; awayActive[`F${fc}`] = pId; }
        else if (pos === 'D' && dc < dLimit) { dc++; awayActive[`D${dc}`] = pId; }
        else if (pos === 'G' && gc < gLimit) { gc++; awayActive[`G${gc}`] = pId; }
        else { awayBench.push(pId); }
      });
      (resolvedOppTeam.benchPlayers || []).forEach(pId => awayBench.push(String(pId)));
    }

    // Align starting positions
    const slots = [];
    for (let i = 1; i <= fLimit; i++) slots.push({ label: "F", key: `F${i}`, pos: "F" });
    for (let i = 1; i <= dLimit; i++) slots.push({ label: "D", key: `D${i}`, pos: "D" });
    for (let i = 1; i <= gLimit; i++) slots.push({ label: "G", key: `G${i}`, pos: "G" });

    const baseLineups = slots.map(slot => {
      const myP = homeActive[slot.key];
      const oppP = awayActive[slot.key];
      return {
        slotLabel: slot.label,
        slotPos: slot.key,
        myPlayer: myP ? { id: myP, ...playersMap[myP] } : null,
        oppPlayer: oppP ? { id: oppP, ...playersMap[oppP] } : null
      };
    });

    // Align bench rows
    const benchLineups = [];
    const maxBenchLen = Math.max(homeBench.length, awayBench.length);
    for (let i = 0; i < maxBenchLen; i++) {
      const myP = homeBench[i];
      const oppP = awayBench[i];
      benchLineups.push({
        slotLabel: "BN",
        slotPos: "BN",
        myPlayer: myP ? { id: myP, ...playersMap[myP] } : null,
        oppPlayer: oppP ? { id: oppP, ...playersMap[oppP] } : null
      });
    }

    return [...baseLineups, ...benchLineups];
  };

  const comparisonLineups = buildStartingLineups();

  return (
    <div className="relative font-sans select-none antialiased">
      
      {/* ── HEADER ── */}
      <div className="flex justify-between items-center mb-6">
        <div>
          <span className="text-[10px] uppercase font-black tracking-widest text-indigo-600 bg-indigo-50 px-3 py-1.5 rounded-full border border-indigo-100">
            Week {currentWeek}
          </span>
          <h1 className="font-sports text-3xl font-black mt-3 tracking-tight text-gray-900">
            Active Matchup
          </h1>
          <p className="text-xs text-gray-400 font-semibold tracking-wide mt-0.5">{weekDateRange}</p>
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
      {(isPending || isDrafting) && (
        <div className="mb-8 animate-scale-up">
          
          {/* STATE 1: WAITING FOR LEAGUE TO FILL */}
          {!isFull && !isDrafting && (
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
          {isFull && !hasDraftDate && !isDrafting && (
            <div className="w-full bg-white border border-amber-200 rounded-[28px] p-6 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div className="flex items-center gap-4 text-left">
                <div className="w-14 h-14 rounded-2xl bg-amber-50 border border-amber-100 flex items-center justify-center text-2xl text-amber-500 animate-bounce">
                  📅
                </div>
                <div>
                  <h2 className="font-sports text-xl font-black text-gray-900 leading-tight">Draft Not Scheduled</h2>
                  <p className="text-xs text-gray-505 font-semibold mt-1">
                    League is full and locked! The League Manager must schedule the draft in the LM Toolset.
                  </p>
                </div>
              </div>

              {isCommissioner ? (
                <div className="flex gap-2">
                  {simulationState?.testModeActive && (
                    <button
                      onClick={() => setIsDraftDetailsOpen(true)}
                      className="px-5 py-4 bg-indigo-600 hover:bg-indigo-500 text-white rounded-2xl text-xs font-black uppercase tracking-wider active:scale-95 transition-all shadow-md shadow-indigo-600/10"
                    >
                      📋 Draft Lobby
                    </button>
                  )}
                  <button
                    onClick={() => setCurrentTab('manager')}
                    className="px-6 py-4 bg-white border border-gray-200 text-gray-700 hover:bg-gray-50 rounded-2xl text-xs font-black uppercase tracking-wider shadow-sm active:scale-95 transition-transform"
                  >
                    ⚙️ Edit Draft Settings
                  </button>
                </div>
              ) : (
                <div className="py-3 px-5 bg-gray-50 border border-gray-200 rounded-2xl text-xs font-black uppercase text-gray-400 tracking-wider">
                  Waiting for Commissioner
                </div>
              )}
            </div>
          )}

          {/* STATE 3: DRAFT SCHEDULED */}
          {isFull && hasDraftDate && !isDraftImminent && !isDrafting && (
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

              <div className="flex items-center gap-2">
                <button
                  onClick={() => setIsDraftDetailsOpen(true)}
                  className="px-5 py-4 bg-indigo-600 hover:bg-indigo-500 text-white rounded-2xl text-xs font-black uppercase tracking-wider active:scale-95 transition-all shadow-md shadow-indigo-600/10"
                >
                  📋 Draft Lobby
                </button>
                {isCommissioner && (
                  <button
                    onClick={() => setCurrentTab('manager')}
                    className="px-5 py-4 bg-white border border-gray-200 text-gray-700 hover:bg-gray-50 rounded-2xl text-xs font-black uppercase tracking-wider active:scale-95 transition-all shadow-sm"
                  >
                    ⚙️ LM Settings
                  </button>
                )}
              </div>
            </div>
          )}

          {/* STATE 4: DRAFT IMMINENT */}
          {isFull && hasDraftDate && isDraftImminent && !isDrafting && (
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
                onClick={() => setIsDraftDetailsOpen(true)}
                className="px-8 py-4.5 bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-white rounded-2xl text-xs font-black uppercase tracking-wider shadow-xl shadow-indigo-600/20 active:scale-95 transition-transform animate-pulse"
              >
                ENTER DRAFT
              </button>
            </div>
          )}

          {/* STATE 5: ACTIVE DRAFT */}
          {isDrafting && (
            <div className="w-full bg-white border-2 border-emerald-500 rounded-[28px] p-6 shadow-md flex flex-col md:flex-row md:items-center justify-between gap-4 animate-scale-up">
              <div className="flex items-center gap-4 text-left">
                <div className="w-14 h-14 rounded-2xl bg-emerald-50 border border-emerald-100 flex items-center justify-center text-2xl text-emerald-500 animate-pulse">
                  ⚡
                </div>
                <div>
                  <h2 className="font-sports text-xl font-black text-gray-900 leading-tight text-emerald-600">Draft is LIVE!</h2>
                  <p className="text-xs text-gray-450 font-semibold mt-1">
                    The league draft is actively in progress. Re-enter now to make your picks!
                  </p>
                </div>
              </div>

              <button
                onClick={() => setCurrentTab('draft_room')}
                className="px-8 py-4.5 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white rounded-2xl text-xs font-black uppercase tracking-wider shadow-xl shadow-emerald-600/20 active:scale-95 transition-transform animate-pulse"
              >
                ENTER DRAFT ROOM
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── DRAFT DETAILS & LOBBY MODAL ── */}
      {isDraftDetailsOpen && leagueData && (
        <div className="fixed inset-0 bg-slate-950/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white border border-gray-200 w-full max-w-lg rounded-[36px] overflow-hidden shadow-2xl flex flex-col max-h-[85vh] animate-scale-up">
            
            {/* Modal Header */}
            <div className="p-6 border-b border-gray-100 flex items-center justify-between">
              <div>
                <span className="text-[9px] uppercase font-black text-indigo-600 bg-indigo-50 px-2.5 py-1 rounded-full border border-indigo-100">
                  {leagueData.status === 'drafting' ? '⚡ Drafting Live' : leagueData.status === 'active' ? '🏆 Recap' : '📅 Scheduled'}
                </span>
                <h3 className="font-sports text-xl font-black text-gray-900 mt-2">
                  Draft Arena Details
                </h3>
              </div>
              <button 
                onClick={() => setIsDraftDetailsOpen(false)}
                className="w-10 h-10 rounded-full bg-gray-50 border border-gray-200 flex items-center justify-center hover:bg-gray-100 active:scale-95 transition-all text-gray-500 font-bold"
              >
                ✕
              </button>
            </div>

            {/* Modal Content */}
            <div className="p-6 overflow-y-auto space-y-5 text-left">
              <div>
                <label className="text-[10px] font-black text-gray-400 uppercase tracking-widest block mb-1">Scheduled Start Time</label>
                <span className="text-sm font-black text-gray-800">
                  {leagueData.draftDate ? new Date(leagueData.draftDate).toLocaleString() : 'Not Scheduled (Simulation Mode)'}
                </span>
              </div>

              {/* Countdown Ticker */}
              {leagueData.status !== 'drafting' && leagueData.status !== 'active' && (
                <div>
                  <label className="text-[10px] font-black text-gray-400 uppercase tracking-widest block mb-2">Countdown</label>
                  <div className="flex gap-2">
                    <span className="text-xs font-black text-indigo-600 bg-indigo-50 px-2.5 py-1.5 rounded-xl border border-indigo-100">{timeLeft.days}d</span>
                    <span className="text-xs font-black text-indigo-600 bg-indigo-50 px-2.5 py-1.5 rounded-xl border border-indigo-100">{timeLeft.hours}h</span>
                    <span className="text-xs font-black text-indigo-600 bg-indigo-50 px-2.5 py-1.5 rounded-xl border border-indigo-100">{timeLeft.minutes}m</span>
                    <span className="text-xs font-black text-indigo-600 bg-indigo-50 px-2.5 py-1.5 rounded-xl border border-indigo-100 animate-pulse">{timeLeft.seconds}s</span>
                  </div>
                </div>
              )}

              {/* Draft Order List */}
              <div>
                <label className="text-[10px] font-black text-gray-400 uppercase tracking-widest block mb-2">Locked Snake Draft Order</label>
                <div className="space-y-2 border border-gray-100 rounded-2xl p-4 bg-gray-50/50">
                  {(leagueData.draftOrder || leagueData.members || []).map((uid, idx) => {
                    const team = teams.find(t => t.ownerId === uid);
                    return (
                      <div key={uid} className="flex items-center justify-between bg-white border border-gray-150 p-2.5 rounded-xl shadow-sm">
                        <div className="flex items-center gap-3">
                          <span className="w-5 h-5 rounded-md bg-indigo-50 border border-indigo-100 flex items-center justify-center text-[9px] font-black text-indigo-600">
                            {idx + 1}
                          </span>
                          <span className="text-xs font-black text-gray-800">
                            {team ? team.teamName : `Owner (${uid.slice(0, 6)})`}
                          </span>
                        </div>
                        <span className="text-[9px] font-bold text-gray-400 uppercase tracking-wider">
                          {uid === leagueData.ownerId ? '👑 LM' : 'Member'}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Modal Footer / CTA */}
            <div className="p-6 border-t border-gray-100 bg-gray-50/50 flex flex-col gap-3">
              {(() => {
                const isDraftActive = leagueData.status === 'drafting';
                const isDraftCompleted = leagueData.status === 'active';
                const isLobbyOpen = hasDraftDate && (timeLeft.totalMs <= 60 * 60 * 1000); // 1 hour
                const isTestAdmin = simulationState?.testModeActive && isCommissioner;
                const canEnter = isLobbyOpen || isDraftActive || isDraftCompleted || isTestAdmin;

                let buttonText = "Enter Draft Room";
                if (isDraftCompleted) buttonText = "View Draft Recap";
                else if (isDraftActive) buttonText = "Enter Live Draft ⚡";
                else if (isTestAdmin && !hasDraftDate) buttonText = "Start & Enter Draft Room ⚡";

                return (
                  <>
                    <button
                      onClick={async () => {
                        if (isTestAdmin && leagueData.status !== 'drafting' && leagueData.status !== 'active') {
                          // Update draftDate to 1 minute in the future
                          const simulatedNow = getSimulatedDate();
                          const newDraftDate = new Date(simulatedNow.getTime() + 60000).toISOString();
                          try {
                            const leagueRef = doc(db, 'fantasy_leagues', activeLeagueId);
                            await updateDoc(leagueRef, { draftDate: newDraftDate });
                          } catch (err) {
                            console.error("Failed to fast-start draft in simulation mode:", err);
                          }
                        }
                        setIsDraftDetailsOpen(false);
                        setCurrentTab('draft_room');
                      }}
                      disabled={!canEnter}
                      className={`w-full py-4 rounded-2xl text-xs font-black uppercase tracking-wider transition-all active:scale-95 shadow-md flex items-center justify-center gap-2 ${canEnter ? 'bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-white shadow-indigo-600/10' : 'bg-gray-100 border border-gray-200 text-gray-400 cursor-not-allowed shadow-none'}`}
                    >
                      {buttonText}
                    </button>
                    {!canEnter && (
                      <span className="text-[10px] text-gray-400 font-semibold text-center mt-1">
                        🔒 Draft Lobby opens 1 hour prior to scheduled date
                      </span>
                    )}
                  </>
                );
              })()}
            </div>
          </div>
        </div>
      )}

      {/* ── 2. PRE-DRAFT MATCHUP SHADOW SHEET (PREMIUM RESPONSIVE DESKTOP GRID) ── */}
      {isOffWeek ? (
        <div className="w-full bg-white border border-gray-200 rounded-[32px] p-8 shadow-sm flex flex-col items-center justify-center text-center gap-4 animate-scale-up min-h-[40vh]">
          <div className="w-16 h-16 rounded-2xl bg-indigo-50 border border-indigo-100 flex items-center justify-center text-3xl shadow-inner">
            💤
          </div>
          <div>
            <h2 className="font-sports text-2xl font-black text-gray-900 leading-tight">Off Week</h2>
            <p className="text-xs text-gray-400 font-semibold mt-2 max-w-sm mx-auto">
              No PWHL games are scheduled for this week. No matchups will occur, so sit back, relax, and rest your roster!
            </p>
          </div>
        </div>
      ) : (
        <div className={`${(isPending || isDrafting) ? 'blur-[1.5px] opacity-45 pointer-events-none' : ''} transition-all duration-300`}>
        
        {/* RESPONSIVE STACKED LAYOUT */}
        <div className="flex flex-col gap-6">
          
          {/* HEAD-TO-HEAD DUEL CARD (FULL WIDTH) */}
          <div className="bg-white border border-gray-200 rounded-[32px] p-8 shadow-sm relative overflow-hidden">
            <div className="flex justify-between items-center max-w-4xl mx-auto">
              {/* Team A */}
              <div className="text-center w-[40%] flex flex-col items-center">
                <div className="w-20 h-20 rounded-3xl bg-indigo-50 border border-indigo-100 flex items-center justify-center text-4xl shadow-sm">
                  {myTeam.avatar || '🏒'}
                </div>
                <h3 className="text-sm font-black text-gray-800 mt-4 truncate w-full">{myTeam.teamName}</h3>
                <p className="text-[10px] text-indigo-600 font-bold mt-0.5 uppercase tracking-widest">You</p>
                
                <p className="text-4xl font-black text-gray-900 mt-4 tracking-tight">{myScoreCalc.toFixed(1)}</p>
                <p className="text-[10px] text-gray-400 font-black uppercase tracking-wider mt-1">
                  Proj Weekly: {myTeamMatchup ? (myScoreCalc * 1.15).toFixed(1) : '0.0'}
                </p>
              </div>

              {/* VS Score Counter */}
              <div className="flex flex-col items-center justify-center w-[20%]">
                <div className="text-[12px] font-black text-gray-400 tracking-widest uppercase mb-2">VS</div>
                <div className="w-16 h-8 rounded-full bg-gray-50 border border-gray-200 flex items-center justify-center text-xs font-black text-gray-500 shadow-inner">
                  {myTeam ? `${myTeam.wins || 0}-${myTeam.losses || 0}-${myTeam.ties || 0}` : "0-0"}
                </div>
              </div>

              {/* Team B */}
              <div className="text-center w-[40%] flex flex-col items-center">
                <div className="w-20 h-20 rounded-3xl bg-gray-50 border border-gray-200 flex items-center justify-center text-4xl shadow-sm">
                  {resolvedOppTeam.avatar || '🥅'}
                </div>
                <h3 className="text-sm font-black text-gray-800 mt-4 truncate w-full">{resolvedOppTeam.teamName}</h3>
                <p className="text-[10px] text-gray-400 font-bold mt-0.5 uppercase tracking-widest">Opponent</p>
                
                <p className="text-4xl font-black text-gray-900 mt-4 tracking-tight">{oppScoreCalc.toFixed(1)}</p>
                <p className="text-[10px] text-gray-400 font-black uppercase tracking-wider mt-1">
                  Proj Weekly: {myTeamMatchup ? (oppScoreCalc * 1.15).toFixed(1) : '0.0'}
                </p>
              </div>
            </div>

            {/* Win Probability Bar */}
            <div className="mt-8 pt-6 border-t border-gray-100 max-w-4xl mx-auto">
              <div className="flex justify-between text-xs text-gray-400 font-black uppercase tracking-wider mb-3">
                <span>Win Probability</span>
                <span className="text-indigo-600">{winProb}% {myTeam.teamName.split(' ').pop()}</span>
              </div>
              <div className="h-2.5 rounded-full bg-gray-100 overflow-hidden flex">
                <div className="h-full bg-gradient-to-r from-indigo-600 to-indigo-500" style={{ width: `${winProb}%` }}></div>
                <div className="h-full bg-gray-200" style={{ width: `${100 - winProb}%` }}></div>
              </div>
            </div>
          </div>

          {/* DAILY SELECTOR BAR */}
          <div className="bg-white border border-gray-200 rounded-[24px] p-3 shadow-sm flex items-center justify-between">
            <button
              onClick={() => {
                const newD = new Date(selectedMatchupDate);
                newD.setDate(newD.getDate() - 1);
                setSelectedMatchupDate(newD);
              }}
              disabled={!selectedMatchupDate || !seasonBounds.start || selectedMatchupDate <= seasonBounds.start}
              className="px-5 py-3.5 bg-gray-50 border border-gray-200 rounded-2xl hover:bg-gray-100 disabled:opacity-40 transition-all text-[10px] font-black uppercase tracking-widest text-gray-500 shadow-inner active:scale-95"
            >
              &larr; Prev Day
            </button>
            <div className="text-center">
              <span className="text-[10px] font-black uppercase text-gray-400 tracking-widest block mb-1">Matchup Day</span>
              <h3 className="text-sm font-black text-indigo-600">
                {selectedMatchupDate ? new Date(selectedMatchupDate).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }) : 'Loading...'}
              </h3>
            </div>
            <button
              onClick={() => {
                const newD = new Date(selectedMatchupDate);
                newD.setDate(newD.getDate() + 1);
                setSelectedMatchupDate(newD);
              }}
              disabled={!selectedMatchupDate || !seasonBounds.end || selectedMatchupDate >= seasonBounds.end}
              className="px-5 py-3.5 bg-gray-50 border border-gray-200 rounded-2xl hover:bg-gray-100 disabled:opacity-40 transition-all text-[10px] font-black uppercase tracking-widest text-gray-500 shadow-inner active:scale-95"
            >
              Next Day &rarr;
            </button>
          </div>

          {/* ROSTER COMPARISON TABLE */}
          <div className="bg-white border border-gray-200 rounded-[32px] p-6 shadow-sm overflow-hidden">
            <h3 className="text-xs font-black uppercase tracking-wider text-gray-400 mb-5 flex items-center gap-1.5 px-2">⛸️ Daily Fantasy Roster Compare</h3>
            <div className="space-y-3">
              <div className="bg-gray-50 border border-gray-200 rounded-2xl p-3 flex justify-between text-[10px] font-black uppercase text-gray-400 tracking-widest px-6 shadow-inner">
                <span className="w-[45%] text-left">{myTeam.teamName.split(' ').pop()} Athletes</span>
                <span className="w-[10%] text-center">POS</span>
                <span className="w-[45%] text-right">{resolvedOppTeam.teamName.split(' ').pop()} Athletes</span>
              </div>

              {comparisonLineups.length > 0 ? (
                comparisonLineups.map((row, idx) => {
                  const myP = row.myPlayer;
                  const oppP = row.oppPlayer;
                  const myPts = myP ? (dailyPlayerStats[myP.id] || 0.0) : 0.0;
                  const oppPts = oppP ? (dailyPlayerStats[oppP.id] || 0.0) : 0.0;
                  
                  // Helper to get daily game text
                  const getDailyGameText = (player) => {
                    if (!player || !selectedMatchupDate) return null;
                    const dateStr = getLocalDateStr(selectedMatchupDate);
                    const game = pwhlGames.find(g => {
                      if (!g.date_played && !g.date) return false;
                      const gDateStr = getLocalDateStr(parseDateStr(g.date_played || g.date));
                      if (gDateStr !== dateStr) return false;
                      return (String(g.home_team) === String(player.team_id) || String(g.visiting_team) === String(player.team_id));
                    });
                    if (game) {
                      const isHome = String(game.home_team) === String(player.team_id);
                      const oppCode = isHome ? (game.visiting_team_code || game.visiting_team) : (game.home_team_code || game.home_team);
                      const timeStr = new Date(game.date_played || game.date).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
                      return isHome ? `vs ${oppCode} ${timeStr}` : `@ ${oppCode} ${timeStr}`;
                    }
                    return "No Game Today";
                  };

                  return (
                    <div key={idx} className="bg-white border border-gray-150 rounded-2xl p-4 flex justify-between items-center text-xs shadow-sm hover:border-indigo-100 transition-all">
                      {/* My Player */}
                      <div className="w-[45%] flex gap-3 min-w-0 pr-2">
                        {myP ? (
                          <>
                            <div className="w-10 h-10 rounded-full bg-gray-100 overflow-hidden shrink-0 hidden sm:block">
                              <img src={myP.player_image} alt={myP.name} className="w-full h-full object-cover" onError={(e) => e.target.style.display='none'} />
                            </div>
                            <div className="truncate flex-1">
                              <span className="font-black text-gray-800 cursor-pointer hover:text-indigo-600 transition-colors" onClick={() => setSelectedCardPlayer(myP)}>{myP.name}</span>
                              <span className="text-[10px] text-gray-400 font-semibold block mt-0.5 truncate">{getDailyGameText(myP)}</span>
                              <span className="text-xs text-indigo-600 font-black block mt-1">{myPts.toFixed(1)} pts</span>
                            </div>
                          </>
                        ) : (
                          <span className="text-gray-300 italic flex items-center h-10">Empty Slot</span>
                        )}
                      </div>

                      {/* Position */}
                      <div className="w-[10%] text-center shrink-0">
                        <span className={`text-[10px] font-black uppercase px-2.5 py-1 rounded-md border ${row.slotPos === 'BN' ? 'bg-gray-50 border-gray-200 text-gray-400' : 'border-indigo-100 bg-indigo-50 text-indigo-600'}`}>
                          {row.slotPos}
                        </span>
                      </div>

                      {/* Opponent Player */}
                      <div className="w-[45%] flex gap-3 min-w-0 pl-2 justify-end text-right">
                        {oppP ? (
                          <>
                            <div className="truncate flex-1">
                              <span className="font-black text-gray-800 cursor-pointer hover:text-indigo-600 transition-colors" onClick={() => setSelectedCardPlayer(oppP)}>{oppP.name}</span>
                              <span className="text-[10px] text-gray-400 font-semibold block mt-0.5 truncate">{getDailyGameText(oppP)}</span>
                              <span className="text-xs text-gray-500 font-black block mt-1">{oppPts.toFixed(1)} pts</span>
                            </div>
                            <div className="w-10 h-10 rounded-full bg-gray-100 overflow-hidden shrink-0 hidden sm:block">
                              <img src={oppP.player_image} alt={oppP.name} className="w-full h-full object-cover" onError={(e) => e.target.style.display='none'} />
                            </div>
                          </>
                        ) : (
                          <span className="text-gray-300 italic flex items-center h-10 justify-end">Empty Slot</span>
                        )}
                      </div>
                    </div>
                  );
                })
              ) : (
                <div className="text-center py-16 px-4 text-xs font-bold text-gray-300 italic border border-dashed border-gray-200 rounded-[24px] bg-white/50 shadow-sm flex flex-col items-center justify-center gap-2">
                  <span className="text-2xl">🥅</span>
                  <span>No active rosters. Comparisons will sync post-draft.</span>
                </div>
              )}
            </div>
          </div>

          {/* DAILY PWHL GAMES CARDS */}
          <div className="bg-white border border-gray-200 rounded-[32px] p-6 shadow-sm overflow-hidden mb-12">
            <h3 className="text-xs font-black uppercase tracking-wider text-gray-400 mb-5 flex items-center gap-1.5 px-2">📅 PWHL Games Today</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {(() => {
                if (!selectedMatchupDate || pwhlGames.length === 0) return null;
                const dateStr = getLocalDateStr(selectedMatchupDate);
                const dailyGames = pwhlGames.filter(g => {
                  if (!g.date_played && !g.date) return false;
                  return getLocalDateStr(parseDateStr(g.date_played || g.date)) === dateStr;
                });
                
                if (dailyGames.length === 0) {
                  return <div className="col-span-full text-center py-8 text-xs font-bold text-gray-400 italic">No PWHL games scheduled for this day.</div>;
                }

                return dailyGames.map(game => {
                  const isLive = game.status === '2';
                  const timeStr = new Date(game.date_played || game.date).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
                  
                  return (
                    <div key={game.id} className="bg-gray-50 border border-gray-200 rounded-2xl p-5 flex flex-col gap-3 shadow-inner">
                      <div className="flex justify-between items-center">
                        <span className="text-[9px] font-black uppercase tracking-widest text-gray-400">
                          {game.venue || 'TBA Location'}
                        </span>
                        {isLive ? (
                          <div className="flex items-center gap-1.5 px-2 py-0.5 bg-emerald-50 rounded text-[9px] font-black text-emerald-600 border border-emerald-100">
                            <span className="relative flex h-1.5 w-1.5">
                              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-500"></span>
                            </span>
                            LIVE (P{game.period || '1'})
                          </div>
                        ) : (game.status === '3' || game.status === '4') ? (
                          <span className="text-[9px] font-black uppercase tracking-widest text-gray-500 bg-gray-100 px-2 py-0.5 rounded border border-gray-200">
                            FINAL
                          </span>
                        ) : (
                          <span className="text-[9px] font-black uppercase tracking-widest text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded border border-indigo-100">
                            {timeStr}
                          </span>
                        )}
                      </div>
                      
                      <div className="flex justify-between items-center mt-2">
                        <div className="flex items-center gap-3 w-[40%]">
                          <div className="text-sm font-black text-gray-800">{game.home_team_name || game.home_team || 'Home'}</div>
                        </div>
                        <div className="flex justify-center items-center gap-3 w-[20%]">
                          <span className="text-xl font-black text-gray-900">{game.home_goal_count ?? game.home_score ?? 0}</span>
                          <span className="text-gray-300 font-black">-</span>
                          <span className="text-xl font-black text-gray-900">{game.visiting_goal_count ?? game.visiting_score ?? 0}</span>
                        </div>
                        <div className="flex items-center gap-3 w-[40%] justify-end text-right">
                          <div className="text-sm font-black text-gray-800">{game.visiting_team_name || game.visiting_team || 'Away'}</div>
                        </div>
                      </div>
                    </div>
                  );
                });
              })()}
            </div>
          </div>
          
        </div>
      </div>
      )}

      {selectedCardPlayer && (
        <PlayerCardModal player={selectedCardPlayer} onClose={() => setSelectedCardPlayer(null)} />
      )}
    </div>
  );
}
