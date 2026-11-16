import { useState, useEffect, useRef, useMemo } from 'react';
import { 
  Trophy, Users, Calendar, Zap, Shield, Copy, ChevronLeft, ChevronRight, Moon
} from 'lucide-react';
import { db } from '../firebase.js';
import { doc, collection, getDocs, query, where, updateDoc, onSnapshot } from 'firebase/firestore';
import { useAuth } from '../contexts/AuthContext';
import { useTimeTravel } from '../contexts/TimeTravelContext';
import { useData } from '../contexts/DataContext';
import PlayerCardModal from './PlayerCardModal';
import MatchupResultModal from './MatchupResultModal';

const getActiveStatsText = (player, stats) => {
  if (!stats) return '';
  const isGoalie = player.position === 'G' || player.pos === 'G';
  
  if (isGoalie) {
    const parts = [];
    if (stats.timeOnIce !== undefined) {
      const m = Math.floor(stats.timeOnIce / 60);
      const s = stats.timeOnIce % 60;
      parts.push(`${m}:${String(s).padStart(2, '0')} TOI`);
    }
    if (stats.wins > 0) parts.push('W');
    else if (stats.losses > 0) parts.push('L');
    else if (stats.overtimeLosses > 0) parts.push('OTL');
    
    if (stats.saves !== undefined) parts.push(`${stats.saves} Sv`);
    if (stats.goalsAgainst !== undefined) parts.push(`${stats.goalsAgainst} GA`);
    if (stats.shutouts > 0) parts.push('SO');
    return parts.join(' | ');
  } else {
    const parts = [];
    if (stats.goals > 0) parts.push(`${stats.goals} G`);
    if (stats.assists > 0) parts.push(`${stats.assists} A`);
    if (stats.shotsOnGoal > 0) parts.push(`${stats.shotsOnGoal} SOG`);
    if (stats.hits > 0) parts.push(`${stats.hits} Hit`);
    if (stats.blockedShots > 0) parts.push(`${stats.blockedShots} Blk`);
    return parts.join(' | ');
  }
};

export default function Matchup({ activeLeagueId, setCurrentTab }) {
  const { currentUser } = useAuth();
  const { activeSeasonId, getSimulatedDate, simulationState } = useTimeTravel();
  const { seasons, seasonsLoading, seasonCache, loadingStates, loadSeasonData } = useData();

  const getLocalDateStr = (date) => {
    if (!date) return '';
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };
  const getPSTDateStr = (date) => {
    if (!date) return '';
    const d = typeof date === 'string' ? new Date(date) : date;
    try {
      return new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'America/Los_Angeles',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }).format(d);
    } catch (e) {
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    }
  };
  const getGameDatePSTStr = (dateStr) => {
    if (!dateStr) return '';
    const s = String(dateStr);
    if (s.length >= 10 && s.charAt(4) === '-' && s.charAt(7) === '-') {
      return s.slice(0, 10);
    }
    return getPSTDateStr(new Date(s));
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

  const [leagueData, setLeagueData] = useState(null);

  // Season data from DataContext — must be after leagueData declaration
  const seasonId = leagueData?.season_id 
    ? String(leagueData.season_id) 
    : (activeSeasonId ? String(activeSeasonId) : '5');

  useEffect(() => {
    if (seasonId && !seasonsLoading) {
      loadSeasonData(seasonId);
    }
  }, [seasonId, seasonsLoading, loadSeasonData]);

  const activeSeasonData = seasonCache[seasonId] || {
    playersList: [],
    pwhlTeams: {},
    projectionsList: [],
    gamesList: [],
    resolvedSeasonId: seasonId,
    isFallbackUniverse: false
  };

  const {
    playersList,
    pwhlTeams,
    gamesList
    } = activeSeasonData;

  const seasonDataLoading = loadingStates[seasonId] === true;
  const [teams, setTeams] = useState([]);
  const [loading, setLoading] = useState(true);
  // Stamp of the matchup slice currently held in state. Compared against
  // matchupDataKey below to derive "refreshing" during render, rather than
  // flipping a flag inside the effect (see CLAUDE.md: prefer deriving over
  // mirroring). `loading` above gates the whole screen on first load; this only
  // signals a refresh in place, so moving between weeks and dates never blanks
  // out the scoreboard.
  const [loadedMatchupKey, setLoadedMatchupKey] = useState(null);
  const [timeLeft, setTimeLeft] = useState({ days: 0, hours: 0, minutes: 0, seconds: 0, totalMs: 0 });
  const [isDraftDetailsOpen, setIsDraftDetailsOpen] = useState(false);
  const [selectedCardPlayer, setSelectedCardPlayer] = useState(null);

  const [weeklyMatchups, setWeeklyMatchups] = useState([]);
  const [dailyPlayerStats, setDailyPlayerStats] = useState({});
  const [dailyPlayerStatsBreakdown, setDailyPlayerStatsBreakdown] = useState({});
  const [selectedMatchupDate, setSelectedMatchupDate] = useState(null);
  const lastSimDateStrRef = useRef('');
  const lastLeagueIdRef = useRef('');
  const lastSeasonIdRef = useRef('');
  const lastWeekRef = useRef(null);

  const pwhlGames = gamesList;

  const playersMap = useMemo(() => {
    const map = {};
    playersList.forEach(p => {
      const cleanId = String(p.id);
      const rating = p.rating || (p.pos === 'G' ? 85 : (p.pos === 'D' ? 82 : 84));
      map[cleanId] = {
        ...p,
        teamCode: pwhlTeams[p.team_id]?.code || p.team_name || 'FA',
        teamLogo: pwhlTeams[p.team_id]?.logo,
        team: pwhlTeams[p.team_id]?.code || p.team_name || 'FA',
        rating
      };
    });
    return map;
  }, [playersList, pwhlTeams]);

  // Derived straight from the season doc rather than mirrored into state by an
  // effect. Mirroring left seasonWeeks one render behind `seasons`, which is the
  // class of race this screen has been bitten by before. Reuses the `seasonId`
  // computed above, which already prefers leagueData.season_id.
  const seasonWeeks = useMemo(() => {
    if (!activeLeagueId || !leagueData || seasonsLoading || seasonDataLoading) return [];
    const currentSeasonDoc = seasons.find(s => String(s.season_id) === String(seasonId));
    return currentSeasonDoc?.weeks || [];
  }, [activeLeagueId, leagueData, seasons, seasonId, seasonsLoading, seasonDataLoading]);

  // Matchup Result Modal states
  const [showResultModal, setShowResultModal] = useState(false);
  const [completedMatchup, setCompletedMatchup] = useState(null);
  const [isCompletedWeekBye, setIsCompletedWeekBye] = useState(false);


  const resolvedCurrentWeek = useMemo(() => {
    if (!leagueData) return 1;
    const targetDate = selectedMatchupDate || getSimulatedDate();
    const targetDateStr = getLocalDateStr(targetDate);
    const targetLocal = parseDateStr(targetDateStr);
    targetLocal.setHours(12, 0, 0, 0);

    let cw = leagueData.currentWeek || 1;
    if (seasonWeeks && seasonWeeks.length > 0) {
      const matchedWeek = seasonWeeks.find(w => {
        const s = parseDateStr(getPSTDateStr(w.start));
        s.setHours(0, 0, 0, 0);
        const e = parseDateStr(getPSTDateStr(w.end));
        e.setHours(23, 59, 59, 999);
        return targetLocal >= s && targetLocal <= e;
      });
      if (matchedWeek) {
        cw = matchedWeek.week;
      }
    }
    return cw;
  }, [leagueData, seasonWeeks, selectedMatchupDate, getSimulatedDate]);

  const matchupWeekBounds = useMemo(() => {
    let weekStartStr = "2024-01-01";
    let weekEndStr = "2024-01-07";
    
    if (seasonWeeks && seasonWeeks.length > 0) {
      const wk = seasonWeeks.find(w => w.week === resolvedCurrentWeek);
      if (wk) {
        weekStartStr = getPSTDateStr(wk.start);
        weekEndStr = getPSTDateStr(wk.end);
      }
    } else {
      const baseTime = parseDateStr("2024-01-01").getTime();
      const weekMs = 7 * 24 * 60 * 60 * 1000;
      const start = new Date(baseTime + (resolvedCurrentWeek - 1) * weekMs);
      const end = new Date(baseTime + resolvedCurrentWeek * weekMs - 1000);
      weekStartStr = getLocalDateStr(start);
      weekEndStr = getLocalDateStr(end);
    }

    const s = parseDateStr(weekStartStr);
    s.setHours(0, 0, 0, 0);
    const e = parseDateStr(weekEndStr);
    e.setHours(23, 59, 59, 999);
    return {
      start: s,
      end: e
    };
  }, [seasonWeeks, resolvedCurrentWeek]);

  const { isOffWeek, weekDateRange } = useMemo(() => {
    if (!leagueData) return { isOffWeek: false, weekDateRange: '' };
    
    if (seasonWeeks && seasonWeeks.length > 0) {
      const wk = seasonWeeks.find(w => w.week === resolvedCurrentWeek);
      if (wk) {
        const start = new Date(wk.start);
        const end = new Date(wk.end);
        const options = { month: 'short', day: 'numeric' };
        return {
          isOffWeek: !!wk.isOffWeek,
          weekDateRange: `${start.toLocaleDateString('en-US', options)} - ${end.toLocaleDateString('en-US', options)}`
        };
      }
    }
    
    const baseTime = new Date("2024-01-01T03:00:00-08:00").getTime();
    const weekMs = 7 * 24 * 60 * 60 * 1000;
    const start = new Date(baseTime + (resolvedCurrentWeek - 1) * weekMs);
    const end = new Date(baseTime + resolvedCurrentWeek * weekMs - 1000);
    const options = { month: 'short', day: 'numeric' };
    return {
      isOffWeek: false,
      weekDateRange: `${start.toLocaleDateString('en-US', options)} - ${end.toLocaleDateString('en-US', options)}`
    };
  }, [leagueData, seasonWeeks, resolvedCurrentWeek]);

  // Compute full season bounds (first week start to last week end)
  const seasonBounds = useMemo(() => {
    if (!seasonWeeks || seasonWeeks.length === 0) return { start: null, end: null };
    const sorted = [...seasonWeeks].sort((a, b) => a.week - b.week);
    const s = parseDateStr(sorted[0].start);
    s.setHours(0, 0, 0, 0);
    const e = parseDateStr(sorted[sorted.length - 1].end);
    e.setHours(23, 59, 59, 999);
    return {
      start: s,
      end: e
    };
  }, [seasonWeeks]);

  // Sync selectedMatchupDate to simulation date (clamped to season bounds) when simulation/league changes
  useEffect(() => {
    if (!seasonWeeks || seasonWeeks.length === 0) return;
    const simDate = getSimulatedDate();
    const simDateStr = getLocalDateStr(simDate);

    const seasonId = leagueData?.season_id ? String(leagueData.season_id) : '';
    const hasSimDateChanged = simDateStr !== lastSimDateStrRef.current;
    const hasLeagueChanged = activeLeagueId !== lastLeagueIdRef.current;
    const hasSeasonChanged = seasonId !== lastSeasonIdRef.current;

    if (hasSimDateChanged || hasLeagueChanged || hasSeasonChanged || !selectedMatchupDate) {
      lastSimDateStrRef.current = simDateStr;
      lastLeagueIdRef.current = activeLeagueId;
      lastSeasonIdRef.current = seasonId;
      lastWeekRef.current = resolvedCurrentWeek;

      let targetDate = simDate;
      if (seasonBounds.start && targetDate < seasonBounds.start) targetDate = seasonBounds.start;
      if (seasonBounds.end && targetDate > seasonBounds.end) targetDate = seasonBounds.end;

      setSelectedMatchupDate(targetDate);
    } else {
      lastWeekRef.current = resolvedCurrentWeek;
    }
  }, [activeLeagueId, leagueData, getSimulatedDate, seasonWeeks, seasonBounds,
      selectedMatchupDate, resolvedCurrentWeek]);

  // Daily lineups scoring state
  const [homeLineupsState, setHomeLineupsState] = useState({});
  const [awayLineupsState, setAwayLineupsState] = useState({});
  // Daily lineups scoring state
  const [homeScoreCalc, setHomeScoreCalc] = useState(0.0);
  const [awayScoreCalc, setAwayScoreCalc] = useState(0.0);

  // Extract factual team details from Firestore loaded lists (memoized for reference stability)
  const myTeam = useMemo(() => {
    return teams.find(t => t.ownerId === currentUser?.uid) || { teamName: "My Team", avatar: "🏒" };
  }, [teams, currentUser?.uid]);

  const oppTeam = useMemo(() => {
    return teams.find(t => t.ownerId !== currentUser?.uid) || { teamName: "Waiting for Opponent", avatar: "🥅" };
  }, [teams, currentUser?.uid]);

  const myTeamMatchup = useMemo(() => {
    if (!myTeam) return null;
    return weeklyMatchups.find(m => m.homeTeamId === myTeam.id || m.awayTeamId === myTeam.id) || null;
  }, [weeklyMatchups, myTeam]);

  const isHome = myTeam && myTeamMatchup && myTeam.id === myTeamMatchup.homeTeamId;

  const oppTeamId = myTeamMatchup ? (isHome ? myTeamMatchup.awayTeamId : myTeamMatchup.homeTeamId) : null;
  const resolvedOppTeam = useMemo(() => {
    return teams.find(t => t.id === oppTeamId) || oppTeam;
  }, [teams, oppTeamId, oppTeam]);

  const myScoreCalc = isHome ? homeScoreCalc : awayScoreCalc;
  const oppScoreCalc = isHome ? awayScoreCalc : homeScoreCalc;



  useEffect(() => {
    if (!activeLeagueId) return;
    setLoading(true);
    
    // 1. Listen to league document details in real-time
    const docRef = doc(db, 'fantasy_leagues', activeLeagueId);
    const unsubscribe = onSnapshot(docRef, (snap) => {
      if (snap.exists()) {
        setLeagueData(snap.data());
      }
    }, err => {
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

    return () => unsubscribe();
  }, [activeLeagueId]);

  // Identifies which matchup slice the screen is showing. The fetch below stamps
  // this once its writes land, so a mismatch means the displayed data is stale.
  const matchupDataKey = `${activeLeagueId || ''}|${selectedMatchupDate ? getLocalDateStr(selectedMatchupDate) : ''}|${resolvedCurrentWeek}`;
  const matchupsRefreshing = Boolean(leagueData) && loadedMatchupKey !== matchupDataKey;

  // Fetch matchups and player stats when leagueData updates
  useEffect(() => {
    if (!activeLeagueId || !leagueData || seasonsLoading || seasonDataLoading) return;
    
    const loadMatchupData = async () => {
      try {
        const matchupsRef = collection(db, `fantasy_leagues/${activeLeagueId}/matchups`);
        
        // Parallel queries to fetch matchups and daily lineups
        const fetchMatchups = getDocs(matchupsRef);
        const fetchHomeLineups = myTeam?.id 
          ? getDocs(collection(db, `fantasy_leagues/${activeLeagueId}/teams/${myTeam.id}/daily_lineups`))
          : Promise.resolve({ docs: [] });
        const fetchAwayLineups = oppTeamId 
          ? getDocs(collection(db, `fantasy_leagues/${activeLeagueId}/teams/${oppTeamId}/daily_lineups`))
          : Promise.resolve({ docs: [] });

        const [matchupsSnap, homeLineupsSnap, awayLineupsSnap] = await Promise.all([
          fetchMatchups,
          fetchHomeLineups,
          fetchAwayLineups
        ]);

        const allMatchups = matchupsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        const filtered = allMatchups.filter(m => m.week === resolvedCurrentWeek);
        setWeeklyMatchups(filtered);

        // Process lineups
        const homeLineups = {};
        if (homeLineupsSnap && homeLineupsSnap.docs) {
          homeLineupsSnap.docs.forEach(d => {
            homeLineups[d.id] = d.data();
          });
        }
        setHomeLineupsState(homeLineups);

        const awayLineups = {};
        if (awayLineupsSnap && awayLineupsSnap.docs) {
          awayLineupsSnap.docs.forEach(d => {
            awayLineups[d.id] = d.data();
          });
        }
        setAwayLineupsState(awayLineups);

        // Fetch points and calculate
        if (!myTeam?.id || !oppTeamId || !selectedMatchupDate) return;
        const { fetchDailyPlayerPointsFromSnapshot } = await import('../services/statsEngine');
        const simDate = getSimulatedDate();
        const resolvedSeasonId = leagueData?.season_id 
          ? String(leagueData.season_id) 
          : (activeSeasonId ? String(activeSeasonId) : '5');

        const weekStart = matchupWeekBounds.start || parseDateStr("2024-01-01");
        const weekEnd = matchupWeekBounds.end || parseDateStr("2024-01-07");

        const { pointsMap, statsMap } = await fetchDailyPlayerPointsFromSnapshot(resolvedSeasonId, weekStart, weekEnd, simDate, leagueData?.scoringSettings, activeLeagueId);
        
        const dayDateStr = getLocalDateStr(selectedMatchupDate);
        setDailyPlayerStats(pointsMap[dayDateStr] || {});
        setDailyPlayerStatsBreakdown(statsMap[dayDateStr] || {});

        const dates = [];
        const current = new Date(weekStart.getTime());
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
          if (!teamDoc) return score;
          dates.forEach(dStr => {
            let activeLineup = {};
            const daily = teamLineups[dStr];
            if (daily && daily.activeLineup) {
              Object.entries(daily.activeLineup).forEach(([slot, pId]) => {
                if (!pId) return;
                const info = playersMap[pId];
                if (!info) {
                  activeLineup[slot] = pId;
                  return;
                }
                const pos = info.pos || 'F';
                const isEligible = (slot.startsWith('F') && pos === 'F') ||
                                   (slot.startsWith('D') && pos === 'D') ||
                                   (slot.startsWith('G') && pos === 'G');
                if (isEligible) {
                  activeLineup[slot] = pId;
                }
              });
            } else {
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
                const pts = pointsMap[dStr]?.[pId] || 0.0;
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
        console.error("Error loading matchup data / points:", err);
      } finally {
        // Runs after the awaits above, so this is not a synchronous setState in
        // the effect body. In `finally` so a failed load still clears the
        // indicator instead of spinning forever.
        setLoadedMatchupKey(matchupDataKey);
      }
    };

    loadMatchupData();
  // myTeam (not myTeam?.id): the effect passes the whole object to
  // calcTeamScore. It is a useMemo, not state, and nothing here writes it,
  // so tracking its identity cannot loop.
  }, [activeLeagueId, leagueData, activeSeasonId, getSimulatedDate, selectedMatchupDate, resolvedCurrentWeek, myTeam, oppTeamId, playersMap, matchupWeekBounds, resolvedOppTeam, seasonsLoading, seasonDataLoading, matchupDataKey]);

  // Matchup Result Popup trigger (Listens in real-time to the completed week's matchup)
  useEffect(() => {
    if (!currentUser || !activeLeagueId || !teams.length || !seasonWeeks.length || !resolvedCurrentWeek) return;

    if (resolvedCurrentWeek > 1) {
      const completedWeek = resolvedCurrentWeek - 1;
      const storageKey = `pwhl_matchup_popup_shown_week_${activeLeagueId}_${currentUser.uid}`;
      const lastShownWeek = localStorage.getItem(storageKey);

      if (lastShownWeek !== String(completedWeek)) {
        const completedWkInfo = seasonWeeks.find(w => w.week === completedWeek);
        const isCompletedWeekOffWeek = completedWkInfo ? !!completedWkInfo.isOffWeek : false;

        if (isCompletedWeekOffWeek) {
          // Completed week was a bye week: show modal directly without querying matchups
          setCompletedMatchup(null);
          setIsCompletedWeekBye(true);
          setShowResultModal(true);
          localStorage.setItem(storageKey, String(completedWeek));
        } else {
          // Standard matchup week: query and listen for matchup completion
          const matchupsRef = collection(db, `fantasy_leagues/${activeLeagueId}/matchups`);
          const q = query(matchupsRef, where('week', '==', completedWeek));
          
          const unsubscribeMatchup = onSnapshot(q, (snap) => {
            const matchups = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            const myTeamObj = teams.find(t => t.ownerId === currentUser.uid);
            if (myTeamObj) {
              const myMatchup = matchups.find(m => m.homeTeamId === myTeamObj.id || m.awayTeamId === myTeamObj.id);
              if (myMatchup && myMatchup.status === 'completed') {
                setCompletedMatchup(myMatchup);
                setIsCompletedWeekBye(false);
                setShowResultModal(true);
                localStorage.setItem(storageKey, String(completedWeek));
                // Unsubscribe once we successfully show it
                unsubscribeMatchup();
              }
            }
          }, err => {
            console.error("Error listening to completed week matchup for popup:", err);
          });

          return () => unsubscribeMatchup();
        }
      }
    }
  }, [currentUser, activeLeagueId, teams, seasonWeeks, resolvedCurrentWeek]);


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
  }, [leagueData, getSimulatedDate]);



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
      const rawActive = homeDoc.activeLineup || {};
      const rawBench = homeDoc.bench || [];
      homeBench = [...rawBench];
      Object.entries(rawActive).forEach(([slot, pId]) => {
        if (!pId) return;
        const info = playersMap[pId];
        const pos = info?.pos || 'F';
        const isEligible = (slot.startsWith('F') && pos === 'F') ||
                           (slot.startsWith('D') && pos === 'D') ||
                           (slot.startsWith('G') && pos === 'G');
        if (isEligible) {
          homeActive[slot] = pId;
        } else {
          if (!homeBench.includes(pId)) {
            homeBench.push(pId);
          }
        }
      });
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
      const rawActive = awayDoc.activeLineup || {};
      const rawBench = awayDoc.bench || [];
      awayBench = [...rawBench];
      Object.entries(rawActive).forEach(([slot, pId]) => {
        if (!pId) return;
        const info = playersMap[pId];
        const pos = info?.pos || 'F';
        const isEligible = (slot.startsWith('F') && pos === 'F') ||
                           (slot.startsWith('D') && pos === 'D') ||
                           (slot.startsWith('G') && pos === 'G');
        if (isEligible) {
          awayActive[slot] = pId;
        } else {
          if (!awayBench.includes(pId)) {
            awayBench.push(pId);
          }
        }
      });
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
    <div className="relative font-sans select-none antialiased text-slate-800">
      
      {/* ── HEADER ── */}
      <div className="flex justify-between items-end mb-6 border-b pb-4" style={{ borderColor: '#E5E5E3' }}>
        <div>
          <h1 className="font-sports text-2xl font-bold tracking-tight text-slate-800">
            Week {currentWeek} Matchup
          </h1>
          <p className="text-xs text-slate-500 font-medium mt-0.5">{weekDateRange}</p>
        </div>
        {matchupsRefreshing && (
          <div className="flex items-center gap-2 text-slate-400 animate-fade-in">
            <div className="w-3 h-3 rounded-full border-2 border-slate-300 border-t-slate-500 animate-spin"></div>
            <span className="text-[10px] font-black uppercase tracking-wider">Updating</span>
          </div>
        )}
      </div>

      {/* ── 1. DRAFT STATUS BANNER/CARD AT THE TOP (Pre-Draft State) ── */}
      {(isPending || isDrafting) && (
        <div className="mb-8 animate-scale-up">
          
          {/* STATE 1: WAITING FOR LEAGUE TO FILL */}
          {!isFull && !isDrafting && (
            <div className="w-full bg-white border border-slate-200/80 rounded-2xl p-6 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div className="flex items-center gap-4 text-left">
                <div className="w-14 h-14 rounded-2xl bg-indigo-50 border border-indigo-200 flex items-center justify-center text-indigo-700">
                  <Users className="w-7 h-7" />
                </div>
                <div>
                  <h2 className="font-sports text-xl font-black text-slate-900 leading-tight">Waiting for League to Fill</h2>
                  <p className="text-xs text-slate-500 font-medium mt-1">
                    Franchise Recruitment: {leagueData.members.length} of {leagueData.maxTeams} teams joined
                  </p>
                </div>
              </div>

              {/* Invite Code Panel */}
              <div className="flex items-center gap-3 bg-slate-50 border border-slate-200 px-4 py-2.5 rounded-xl shadow-xs">
                <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest px-1">Invite Code:</span>
                <span className="text-sm font-black tracking-widest text-indigo-700">{leagueData.inviteCode}</span>
                <button 
                  onClick={() => {
                    navigator.clipboard.writeText(leagueData.inviteCode);
                    alert("Invite Code copied successfully!");
                  }}
                  className="text-[10px] font-black uppercase text-indigo-700 bg-indigo-50 border border-indigo-200 px-3 py-1.5 rounded-lg hover:bg-indigo-100 active:scale-95 transition-all cursor-pointer"
                >
                  <Copy className="w-3 h-3 inline mr-1" /> Copy
                </button>
              </div>

              {isCommissioner ? (
                <button
                  onClick={() => setCurrentTab('manager')}
                  className="px-6 py-4 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-black uppercase tracking-wider shadow-sm active:scale-95 transition-transform cursor-pointer"
                >
                  <Shield className="w-3.5 h-3.5 inline mr-1.5" /> LM Toolset
                </button>
              ) : (
                <div className="py-3 px-5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-black uppercase text-slate-400 tracking-wider">
                  Waiting for members
                </div>
              )}
            </div>
          )}

          {/* STATE 2: LEAGUE FULL, DRAFT NOT SCHEDULED */}
          {isFull && !hasDraftDate && !isDrafting && (
            <div className="w-full bg-white border border-amber-200 rounded-2xl p-6 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div className="flex items-center gap-4 text-left">
                <div className="w-14 h-14 rounded-2xl bg-amber-50 border border-amber-200 flex items-center justify-center text-amber-600">
                  <Calendar className="w-7 h-7 animate-pulse" />
                </div>
                <div>
                  <h2 className="font-sports text-xl font-black text-slate-900 leading-tight">Draft Not Scheduled</h2>
                  <p className="text-xs text-slate-500 font-medium mt-1">
                    League is full and locked! The League Manager must schedule the draft in the LM Toolset.
                  </p>
                </div>
              </div>

              {isCommissioner ? (
                <div className="flex gap-2">
                  {simulationState?.testModeActive && (
                    <button
                      onClick={() => setIsDraftDetailsOpen(true)}
                      className="px-5 py-4 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-black uppercase tracking-wider active:scale-95 transition-all shadow-sm cursor-pointer"
                    >
                      Draft Lobby
                    </button>
                  )}
                  <button
                    onClick={() => setCurrentTab('manager')}
                    className="px-6 py-4 bg-slate-50 border border-slate-200 text-slate-700 hover:bg-slate-100 rounded-xl text-xs font-black uppercase tracking-wider active:scale-95 transition-transform cursor-pointer"
                  >
                    Edit Draft Settings
                  </button>
                </div>
              ) : (
                <div className="py-3 px-5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-black uppercase text-slate-400 tracking-wider">
                  Waiting for Commissioner
                </div>
              )}
            </div>
          )}

          {/* STATE 3: DRAFT SCHEDULED */}
          {isFull && hasDraftDate && !isDraftImminent && !isDrafting && (
            <div className="w-full bg-white border border-slate-200/80 rounded-2xl p-6 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div className="flex items-center gap-4 text-left">
                <div className="w-14 h-14 rounded-2xl bg-indigo-50 border border-indigo-200 flex items-center justify-center text-indigo-700">
                  <Trophy className="w-7 h-7" />
                </div>
                <div>
                  <h2 className="font-sports text-xl font-black text-slate-900 leading-tight">Draft Scheduled</h2>
                  <p className="text-xs text-slate-400 font-medium mt-1">
                    Lobby opens: {new Date(leagueData.draftDate).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
                  </p>
                </div>
              </div>

              {/* Countdown Panel */}
              <div className="flex items-center gap-2 bg-slate-900 border border-slate-800 p-3 rounded-2xl shadow-inner">
                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest px-1 mr-1">Countdown:</span>
                <span className="text-sm font-black text-indigo-400 bg-indigo-500/10 px-2.5 py-1.5 rounded-xl border border-indigo-500/30">{timeLeft.days}d</span>
                <span className="text-sm font-black text-indigo-400 bg-indigo-500/10 px-2.5 py-1.5 rounded-xl border border-indigo-500/30">{timeLeft.hours}h</span>
                <span className="text-sm font-black text-indigo-400 bg-indigo-500/10 px-2.5 py-1.5 rounded-xl border border-indigo-500/30">{timeLeft.minutes}m</span>
                <span className="text-sm font-black text-indigo-400 bg-indigo-500/10 px-2.5 py-1.5 rounded-xl border border-indigo-500/30 animate-pulse">{timeLeft.seconds}s</span>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => setIsDraftDetailsOpen(true)}
                  className="px-5 py-4 bg-indigo-600 hover:bg-indigo-500 text-white rounded-2xl text-xs font-black uppercase tracking-wider active:scale-95 transition-all shadow-lg shadow-indigo-600/20 cursor-pointer"
                >
                  Draft Lobby
                </button>
                {isCommissioner && (
                  <button
                    onClick={() => setCurrentTab('manager')}
                    className="px-5 py-4 bg-slate-800 border border-slate-700 text-slate-200 hover:bg-slate-700 rounded-2xl text-xs font-black uppercase tracking-wider active:scale-95 transition-all cursor-pointer"
                  >
                    LM Settings
                  </button>
                )}
              </div>
            </div>
          )}

          {/* STATE 4: DRAFT IMMINENT */}
          {isFull && hasDraftDate && isDraftImminent && !isDrafting && (
            <div className="w-full bg-[#0F172A] border-2 border-indigo-500/80 rounded-[28px] p-6 shadow-xl flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div className="flex items-center gap-4 text-left">
                <div className="w-14 h-14 rounded-2xl bg-indigo-500/20 border border-indigo-400/40 flex items-center justify-center text-indigo-300 animate-pulse">
                  <Zap className="w-7 h-7" />
                </div>
                <div>
                  <h2 className="font-sports text-xl font-black text-white leading-tight">Draft is Imminent!</h2>
                  <p className="text-xs text-slate-400 font-medium mt-1">
                    {timeLeft.totalMs > 0 ? `Lobby opens in: ${timeLeft.minutes}m ${timeLeft.seconds}s` : 'Draft lobby is now OPEN!'}
                  </p>
                </div>
              </div>

              <button
                onClick={() => setIsDraftDetailsOpen(true)}
                className="px-8 py-4.5 bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-white rounded-2xl text-xs font-black uppercase tracking-wider shadow-xl shadow-indigo-600/30 active:scale-95 transition-transform animate-pulse cursor-pointer"
              >
                ENTER DRAFT
              </button>
            </div>
          )}

          {/* STATE 5: ACTIVE DRAFT */}
          {isDrafting && (
            <div className="w-full bg-[#0F172A] border-2 border-emerald-500/80 rounded-[28px] p-6 shadow-xl flex flex-col md:flex-row md:items-center justify-between gap-4 animate-scale-up">
              <div className="flex items-center gap-4 text-left">
                <div className="w-14 h-14 rounded-2xl bg-emerald-500/20 border border-emerald-400/40 flex items-center justify-center text-emerald-300 animate-pulse">
                  <Zap className="w-7 h-7" />
                </div>
                <div>
                  <h2 className="font-sports text-xl font-black text-emerald-400 leading-tight">Draft is LIVE!</h2>
                  <p className="text-xs text-slate-400 font-medium mt-1">
                    The league draft is actively in progress. Re-enter now to make your picks!
                  </p>
                </div>
              </div>

              <button
                onClick={() => setCurrentTab('draft_room')}
                className="px-8 py-4.5 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white rounded-2xl text-xs font-black uppercase tracking-wider shadow-xl shadow-emerald-600/30 active:scale-95 transition-transform animate-pulse cursor-pointer"
              >
                ENTER DRAFT ROOM
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── DRAFT DETAILS & LOBBY MODAL ── */}
      {isDraftDetailsOpen && leagueData && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-md z-50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200/80 w-full max-w-lg rounded-2xl overflow-hidden shadow-xl flex flex-col max-h-[85vh] animate-scale-up text-slate-800">
            
            {/* Modal Header */}
            <div className="p-6 border-b border-slate-200 flex items-center justify-between">
              <div>
                <span className="text-[9px] font-black uppercase tracking-widest text-indigo-700 bg-indigo-50 px-2.5 py-1 rounded-lg border border-indigo-200">
                  Pre-Draft Lobby
                </span>
                <h3 className="font-sports text-2xl font-black text-slate-900 mt-1">Draft Chamber</h3>
              </div>
              <button 
                onClick={() => setIsDraftDetailsOpen(false)}
                className="w-8 h-8 rounded-xl bg-slate-100 text-slate-500 hover:text-slate-900 flex items-center justify-center text-sm font-bold transition-colors cursor-pointer"
              >
                &times;
              </button>
            </div>

            {/* Modal Content Body */}
            <div className="p-6 overflow-y-auto space-y-6">
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-slate-50 border border-slate-200 p-3.5 rounded-xl">
                  <span className="text-[9px] font-black text-slate-500 uppercase tracking-widest block">Draft Type</span>
                  <span className="text-xs font-black text-slate-900 mt-0.5 block uppercase">Live Snake Draft</span>
                </div>
                <div className="bg-slate-50 border border-slate-200 p-3.5 rounded-xl">
                  <span className="text-[9px] font-black text-slate-500 uppercase tracking-widest block">Time Per Pick</span>
                  <span className="text-xs font-black text-slate-900 mt-0.5 block uppercase">{leagueData.pickTimeSeconds || 60} Seconds</span>
                </div>
              </div>

              {hasDraftDate && (
                <div className="bg-slate-50 border border-slate-200 p-4 rounded-xl flex items-center justify-between">
                  <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Time Remaining</span>
                  <div className="flex gap-2">
                    <span className="text-xs font-black text-indigo-700 bg-indigo-50 px-2.5 py-1.5 rounded-lg border border-indigo-200">{timeLeft.days}d</span>
                    <span className="text-xs font-black text-indigo-700 bg-indigo-50 px-2.5 py-1.5 rounded-lg border border-indigo-200">{timeLeft.hours}h</span>
                    <span className="text-xs font-black text-indigo-700 bg-indigo-50 px-2.5 py-1.5 rounded-lg border border-indigo-200">{timeLeft.minutes}m</span>
                    <span className="text-xs font-black text-indigo-700 bg-indigo-50 px-2.5 py-1.5 rounded-lg border border-indigo-200 animate-pulse">{timeLeft.seconds}s</span>
                  </div>
                </div>
              )}

              <div>
                <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-2">Locked Snake Draft Order</label>
                <div className="space-y-2 border border-slate-200 rounded-xl p-4 bg-slate-50/50">
                  {(leagueData.draftOrder || leagueData.members || []).map((uid, idx) => {
                    const team = teams.find(t => t.ownerId === uid);
                    return (
                      <div key={uid} className="flex items-center justify-between bg-white border border-slate-200 p-2.5 rounded-xl shadow-xs">
                        <div className="flex items-center gap-3">
                          <span className="w-5 h-5 rounded-md bg-indigo-50 border border-indigo-200 flex items-center justify-center text-[9px] font-black text-indigo-700">
                            {idx + 1}
                          </span>
                          <span className="text-xs font-black text-slate-800">
                            {team ? team.teamName : `Owner (${uid.slice(0, 6)})`}
                          </span>
                        </div>
                        <span className="text-[9px] font-bold text-slate-500 uppercase tracking-wider">
                          {uid === leagueData.ownerId ? 'LM' : 'Member'}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="p-6 border-t border-slate-200 bg-slate-50 flex flex-col gap-3">
              {(() => {
                const isDraftActive = leagueData.status === 'drafting';
                const isDraftCompleted = leagueData.status === 'active';
                const isLobbyOpen = hasDraftDate && (timeLeft.totalMs <= 60 * 60 * 1000);
                const isTestAdmin = simulationState?.testModeActive && isCommissioner;
                const canEnter = isLobbyOpen || isDraftActive || isDraftCompleted || isTestAdmin;

                let buttonText = "Enter Draft Room";
                if (isDraftCompleted) buttonText = "View Draft Recap";
                else if (isDraftActive) buttonText = "Enter Live Draft";
                else if (isTestAdmin && !hasDraftDate) buttonText = "Start & Enter Draft Room";

                return (
                  <>
                    <button
                      onClick={async () => {
                        if (isTestAdmin && leagueData.status !== 'drafting' && leagueData.status !== 'active') {
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
                      className={`w-full py-3.5 rounded-xl text-xs font-black uppercase tracking-wider transition-all active:scale-95 shadow-sm flex items-center justify-center gap-2 cursor-pointer ${canEnter ? 'bg-indigo-600 hover:bg-indigo-500 text-white' : 'bg-slate-100 border border-slate-200 text-slate-400 cursor-not-allowed'}`}
                    >
                      {buttonText}
                    </button>
                    {!canEnter && (
                      <span className="text-[10px] text-slate-500 font-semibold text-center mt-1">
                        Draft Lobby opens 1 hour prior to scheduled date
                      </span>
                    )}
                  </>
                );
              })()}
            </div>
          </div>
        </div>
      )}

      {/* ── 2. PRE-DRAFT MATCHUP SHADOW SHEET ── */}
      {isOffWeek ? (
        <div className="w-full bg-[#0F172A] border border-slate-800 rounded-[32px] p-8 shadow-lg flex flex-col items-center justify-center text-center gap-4 animate-scale-up min-h-[40vh]">
          <div className="w-16 h-16 rounded-2xl bg-indigo-500/10 border border-indigo-500/30 flex items-center justify-center text-indigo-400 shadow-inner">
            <Moon className="w-8 h-8 animate-pulse" />
          </div>
          <div>
            <h2 className="font-sports text-2xl font-black text-white leading-tight">Off Week</h2>
            <p className="text-xs text-slate-400 font-medium mt-2 max-w-sm mx-auto">
              No PWHL games are scheduled for this week. No matchups will occur, so sit back, relax, and rest your roster!
            </p>
          </div>
        </div>
      ) : (
        <div className={`${(isPending || isDrafting) ? 'blur-[1.5px] opacity-45 pointer-events-none' : ''} transition-all duration-300`}>
        
        <div className="flex flex-col gap-6">
          
          <div className="bg-white border border-slate-200/80 rounded-2xl p-8 shadow-sm relative overflow-hidden">
            <div className="flex justify-between items-center max-w-4xl mx-auto">
              {/* Team A */}
              <div className="text-center w-[40%] flex flex-col items-center">
                <div className="w-20 h-20 rounded-2xl bg-indigo-50 border border-indigo-200 flex items-center justify-center text-2xl font-black text-indigo-700 shadow-xs">
                  {myTeam.teamName ? myTeam.teamName.slice(0, 2).toUpperCase() : 'MY'}
                </div>
                <h3 className="text-sm font-black text-slate-900 mt-4 truncate w-full">{myTeam.teamName}</h3>
                <p className="text-[10px] text-indigo-600 font-bold mt-0.5 uppercase tracking-widest">You</p>
                
                <p className="text-4xl font-black text-slate-900 mt-4 tracking-tight">{myScoreCalc.toFixed(1)}</p>
                <p className="text-[10px] text-slate-500 font-black uppercase tracking-wider mt-1">
                  Proj Weekly: {myTeamMatchup ? (myScoreCalc * 1.15).toFixed(1) : '0.0'}
                </p>
              </div>

              {/* VS Score Counter */}
              <div className="flex flex-col items-center justify-center w-[20%]">
                <div className="text-[12px] font-black text-slate-400 tracking-widest uppercase mb-2">VS</div>
                <div className="px-3 py-1.5 rounded-xl bg-slate-100 border border-slate-200 text-xs font-black text-slate-800 shadow-xs">
                  {myTeam ? `${myTeam.wins || 0}-${myTeam.losses || 0}-${myTeam.ties || 0}` : "0-0"}
                </div>
              </div>

              {/* Team B */}
              <div className="text-center w-[40%] flex flex-col items-center">
                <div className="w-20 h-20 rounded-2xl bg-slate-100 border border-slate-200 flex items-center justify-center text-2xl font-black text-slate-700 shadow-xs">
                  {resolvedOppTeam.teamName ? resolvedOppTeam.teamName.slice(0, 2).toUpperCase() : 'OP'}
                </div>
                <h3 className="text-sm font-black text-slate-900 mt-4 truncate w-full">{resolvedOppTeam.teamName}</h3>
                <p className="text-[10px] text-slate-500 font-bold mt-0.5 uppercase tracking-widest">Opponent</p>
                
                <p className="text-4xl font-black text-slate-900 mt-4 tracking-tight">{oppScoreCalc.toFixed(1)}</p>
                <p className="text-[10px] text-slate-500 font-black uppercase tracking-wider mt-1">
                  Proj Weekly: {myTeamMatchup ? (oppScoreCalc * 1.15).toFixed(1) : '0.0'}
                </p>
              </div>
            </div>

            <div className="mt-8 pt-6 border-t border-slate-100 max-w-4xl mx-auto">
              <div className="flex justify-between text-xs text-slate-500 font-semibold tracking-wider mb-2">
                <span>Win Probability</span>
                <span className="text-slate-700 font-bold">{winProb}% {myTeam.teamName.split(' ').pop()}</span>
              </div>
              <div className="h-2 rounded-lg bg-slate-100 overflow-hidden flex border" style={{ borderColor: '#E5E5E3' }}>
                <div className="h-full bg-slate-600" style={{ width: `${winProb}%` }}></div>
                <div className="h-full bg-slate-200" style={{ width: `${100 - winProb}%` }}></div>
              </div>
            </div>
          </div>

          <div className="bg-white border border-slate-200/80 rounded-2xl p-3 shadow-sm flex items-center justify-between">
            <button
              onClick={() => {
                const newD = new Date(selectedMatchupDate);
                newD.setDate(newD.getDate() - 1);
                setSelectedMatchupDate(newD);
              }}
              disabled={!selectedMatchupDate || !seasonBounds.start || selectedMatchupDate <= seasonBounds.start}
              className="px-5 py-3.5 bg-slate-50 border border-slate-200 rounded-xl hover:bg-slate-100 disabled:opacity-40 transition-all text-[10px] font-black uppercase tracking-widest text-slate-700 flex items-center gap-1.5 cursor-pointer disabled:cursor-not-allowed"
            >
              <ChevronLeft className="w-4 h-4 text-indigo-600" /> Prev Day
            </button>
            <div className="text-center">
              <span className="text-[10px] font-black uppercase text-slate-400 tracking-widest block mb-1">Matchup Day</span>
              <h3 className="text-sm font-black text-slate-900">
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
              className="px-5 py-3.5 bg-slate-50 border border-slate-200 rounded-xl hover:bg-slate-100 disabled:opacity-40 transition-all text-[10px] font-black uppercase tracking-widest text-slate-700 flex items-center gap-1.5 cursor-pointer disabled:cursor-not-allowed"
            >
              Next Day <ChevronRight className="w-4 h-4 text-indigo-600" />
            </button>
          </div>

          <div className="bg-white border border-slate-200/80 rounded-2xl p-6 shadow-sm overflow-hidden">
            <div className="space-y-3">
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 flex justify-between text-[10px] font-black uppercase text-slate-500 tracking-widest px-6">
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
                  
                  const getDailyGameText = (player) => {
                    if (!player || !selectedMatchupDate) return null;
                    const dateStr = getLocalDateStr(selectedMatchupDate);
                    const game = pwhlGames.find(g => {
                      if (!g.date_played && !g.date) return false;
                      const gDateStr = (g.date_played || g.date || '').split('T')[0].split(' ')[0];
                      if (gDateStr !== dateStr) return false;
                      return (String(g.home_team) === String(player.team_id) || String(g.visiting_team) === String(player.team_id));
                    });
                    if (game) {
                      const isHome = String(game.home_team) === String(player.team_id);
                      const oppCode = isHome ? (game.visiting_team_code || game.visiting_team) : (game.home_team_code || game.home_team);
                      const timeStr = parseDateStr(game.GameDateISO8601 || game.date_time_played || game.date_played || game.date).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
                      return isHome ? `vs ${oppCode} ${timeStr}` : `@ ${oppCode} ${timeStr}`;
                    }
                    return "No Game Today";
                  };

                  return (
                    <div key={idx} className="bg-slate-50 border border-slate-200 rounded-xl p-4 flex justify-between items-center text-xs shadow-xs hover:border-slate-300 transition-all">
                      <div className="w-[45%] flex gap-3 min-w-0 pr-2">
                        {myP ? (
                          <>
                            <div className="w-10 h-10 rounded-xl bg-slate-100 border border-slate-200 overflow-hidden shrink-0 hidden sm:block">
                              <img src={myP.player_image} alt={myP.name} className="w-full h-full object-cover" onError={(e) => e.target.style.display='none'} />
                            </div>
                            <div className="truncate flex-1">
                              <span className="font-black text-slate-900 cursor-pointer hover:text-indigo-600 transition-colors" onClick={() => setSelectedCardPlayer(myP)}>{myP.name}</span>
                              <span className="text-[10px] text-slate-500 font-medium block mt-0.5 truncate">{getDailyGameText(myP)}</span>
                              {myP && dailyPlayerStatsBreakdown[myP.id] && getActiveStatsText(myP, dailyPlayerStatsBreakdown[myP.id]) ? (
                                <span className="text-[10px] text-emerald-700 font-bold block mt-0.5 truncate" title={getActiveStatsText(myP, dailyPlayerStatsBreakdown[myP.id])}>
                                  {getActiveStatsText(myP, dailyPlayerStatsBreakdown[myP.id])}
                                </span>
                              ) : null}
                              <span className="text-xs text-indigo-600 font-black block mt-1">{myPts.toFixed(1)} pts</span>
                            </div>
                          </>
                        ) : (
                          <span className="text-slate-400 italic flex items-center h-10">Empty Slot</span>
                        )}
                      </div>

                      <div className="w-[10%] text-center shrink-0">
                        <span className="text-[10px] font-semibold text-slate-500">
                          {row.slotPos}
                        </span>
                      </div>

                      <div className="w-[45%] flex gap-3 min-w-0 pl-2 justify-end text-right">
                        {oppP ? (
                          <>
                            <div className="truncate flex-1">
                              <span className="font-black text-slate-900 cursor-pointer hover:text-indigo-600 transition-colors" onClick={() => setSelectedCardPlayer(oppP)}>{oppP.name}</span>
                              <span className="text-[10px] text-slate-500 font-medium block mt-0.5 truncate">{getDailyGameText(oppP)}</span>
                              {oppP && dailyPlayerStatsBreakdown[oppP.id] && getActiveStatsText(oppP, dailyPlayerStatsBreakdown[oppP.id]) ? (
                                <span className="text-[10px] text-emerald-700 font-bold block mt-0.5 truncate" title={getActiveStatsText(oppP, dailyPlayerStatsBreakdown[oppP.id])}>
                                  {getActiveStatsText(oppP, dailyPlayerStatsBreakdown[oppP.id])}
                                </span>
                              ) : null}
                              <span className="text-xs text-slate-700 font-black block mt-1">{oppPts.toFixed(1)} pts</span>
                            </div>
                            <div className="w-10 h-10 rounded-xl bg-slate-100 border border-slate-200 overflow-hidden shrink-0 hidden sm:block">
                              <img src={oppP.player_image} alt={oppP.name} className="w-full h-full object-cover" onError={(e) => e.target.style.display='none'} />
                            </div>
                          </>
                        ) : (
                          <span className="text-slate-400 italic flex items-center h-10 justify-end">Empty Slot</span>
                        )}
                      </div>
                    </div>
                  );
                })
              ) : (
                <div className="text-center py-16 px-4 text-xs font-bold text-slate-400 italic border border-dashed border-slate-200 rounded-2xl bg-slate-50 shadow-xs flex flex-col items-center justify-center gap-2">
                  <Users className="w-8 h-8 text-slate-400 mb-2" />
                  <span>No active rosters. Comparisons will sync post-draft.</span>
                </div>
              )}
            </div>
          </div>

          <div className="bg-white border border-slate-200/80 rounded-2xl p-6 shadow-sm overflow-hidden mb-12">
            <h3 className="text-xs font-black uppercase tracking-wider text-slate-500 mb-5 flex items-center gap-2 px-2">
              <Calendar className="w-4 h-4 text-indigo-600" /> PWHL Games Today
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {(() => {
                if (!selectedMatchupDate || pwhlGames.length === 0) return null;
                const dateStr = getLocalDateStr(selectedMatchupDate);
                const dailyGames = pwhlGames.filter(g => {
                  if (!g.date_played && !g.date) return false;
                  const gDateStr = (g.date_played || g.date || '').split('T')[0].split(' ')[0];
                  return gDateStr === dateStr;
                });
                
                if (dailyGames.length === 0) {
                  return <div className="col-span-full text-center py-8 text-xs font-bold text-slate-400 italic">No PWHL games scheduled for this day.</div>;
                }

                const simDate = getSimulatedDate();

                return dailyGames.map(game => {
                  const gameDate = parseDateStr(game.GameDateISO8601 || game.date_time_played || game.date_played || game.date);
                  const timeStr = gameDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
                  const gamePST = getGameDatePSTStr(game.GameDateISO8601 || game.date_time_played || game.date_played || game.date);
                  const simPST = getPSTDateStr(simDate);
                  const isFutureOfSim = gamePST > simPST;
                  const realStatus = game.status;
                  const isLive = !isFutureOfSim && realStatus === '2';
                  const isFinal = !isFutureOfSim && (realStatus === '3' || realStatus === '4' || gamePST <= simPST);
                  
                  return (
                    <div key={game.id} className="bg-white border rounded-xl p-4 flex flex-col gap-3" style={{ borderColor: '#E5E5E3' }}>
                      <div className="flex justify-between items-center">
                        <span className="text-[10px] font-medium text-slate-400">
                          {game.venue || 'TBA Location'}
                        </span>
                        {isLive ? (
                          <div className="flex items-center gap-1.5 text-[10px] font-bold text-emerald-700">
                            <span className="relative flex h-1.5 w-1.5">
                              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-600"></span>
                            </span>
                            LIVE (P{game.period || '1'})
                          </div>
                        ) : isFinal ? (
                          <span className="text-[10px] font-medium text-slate-400">
                            FINAL
                          </span>
                        ) : (
                          <span className="text-[10px] font-medium text-slate-500">
                            {timeStr}
                          </span>
                        )}
                      </div>
                      
                      <div className="flex justify-between items-center">
                        <div className="flex items-center gap-2 w-[40%]">
                          <div className="text-xs font-semibold text-slate-800">{game.home_team_name || game.home_team || 'Home'}</div>
                        </div>
                        <div className="flex justify-center items-center gap-2 w-[20%]">
                          {isFutureOfSim ? (
                            <span className="text-xs font-medium text-slate-400">vs</span>
                          ) : (
                            <>
                              <span className="text-sm font-bold text-slate-800">{game.home_goal_count ?? game.home_score ?? 0}</span>
                              <span className="text-slate-400 text-xs">-</span>
                              <span className="text-sm font-bold text-slate-800">{game.visiting_goal_count ?? game.visiting_score ?? 0}</span>
                            </>
                          )}
                        </div>
                        <div className="flex items-center gap-2 w-[40%] justify-end text-right">
                          <div className="text-xs font-semibold text-slate-800">{game.visiting_team_name || game.visiting_team || 'Away'}</div>
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

      <MatchupResultModal 
        isOpen={showResultModal} 
        onClose={() => setShowResultModal(false)} 
        matchup={completedMatchup} 
        myTeam={myTeam} 
        oppTeam={resolvedOppTeam} 
        weekNum={resolvedCurrentWeek - 1} 
        isByeWeek={isCompletedWeekBye}
      />
    </div>
  );
}
