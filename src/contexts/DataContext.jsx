import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { db } from '../firebase';
import { collection, getDocs, query, where } from 'firebase/firestore';

const DataContext = createContext();

export function useData() {
  return useContext(DataContext);
}

function normalizePosition(pos) {
  if (!pos) return 'F';
  const up = String(pos).toUpperCase().trim();
  if (
    ['F', 'FORWARD', 'FORWARDS', 'C', 'CENTER', 'CENTRE', 'LW', 'LEFT WING', 'LEFTWING', 'RW', 'RIGHT WING', 'RIGHTWING'].includes(up) ||
    up.includes('WING') ||
    up.includes('FORWARD') ||
    up.includes('CENTER') ||
    up.includes('CENTRE')
  ) {
    return 'F';
  }
  if (
    ['D', 'RD', 'LD', 'DEFENSE', 'DEFENCE', 'DEFENDER', 'DEFENDERS', 'DEFENSEMAN', 'DEFENSEMEN', 'DEFENSMAN', 'RIGHT DEFENSE', 'RIGHT DEFENCE', 'LEFT DEFENSE', 'LEFT DEFENCE'].includes(up) ||
    up.includes('DEFENSE') ||
    up.includes('DEFENCE') ||
    up.includes('DEFENDER') ||
    up.includes('DEFENSEMAN') ||
    up.includes('DEFENSEMEN')
  ) {
    return 'D';
  }
  if (
    ['G', 'GOALIE', 'GOALIES', 'GOALTENDER', 'GOALTENDERS'].includes(up) ||
    up.includes('GOAL')
  ) {
    return 'G';
  }
  return 'F';
}


export function DataProvider({ children }) {
  const [seasons, setSeasons] = useState([]);
  const [seasonsLoading, setSeasonsLoading] = useState(true);
  
  // React state for triggering component re-renders
  const [seasonCache, setSeasonCache] = useState({});
  const [loadingStates, setLoadingStates] = useState({});

  // Refs for synchronous checks to prevent stale state closures and infinite loop triggers
  const cacheRef = useRef({});
  const loadingStatesRef = useRef({});

  // Fetch seasons list once on mount
  useEffect(() => {
    async function loadSeasons() {
      try {
        const snap = await getDocs(collection(db, 'pwhl_seasons'));
        const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        setSeasons(list);
      } catch (err) {
        console.error("Error loading seasons in DataContext:", err);
      } finally {
        setSeasonsLoading(false);
      }
    }
    loadSeasons();
  }, []);

  const loadSeasonData = useCallback(async (seasonId) => {
    if (!seasonId) return;
    const sId = String(seasonId);
    
    // Synchronous ref check prevents concurrent duplicate calls
    if (cacheRef.current[sId] || loadingStatesRef.current[sId]) return;

    // Mark as loading in ref instantly
    loadingStatesRef.current[sId] = true;
    setLoadingStates(prev => ({ ...prev, [sId]: true }));

    try {
      // 1. Fetch target players first to check if they are empty
      const playersQuery = query(collection(db, 'pwhl_players'), where('season_id', 'in', [sId, Number(sId)]));
      const playersSnap = await getDocs(playersQuery);
      
      let resolvedSeasonId = sId;
      let rawPlayers = playersSnap.docs.map(d => d.data());
      let fallbackActive = false;

      // Fallback resolution if upcoming season has no players yet
      if (rawPlayers.length === 0 && seasons.length > 0) {
        const currentSeasonDoc = seasons.find(s => String(s.season_id) === String(sId));
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
          fallbackActive = true;
          
          console.log(`[DataContext Universe Resolver] Season ${sId} has no players. Falling back to Season ${resolvedSeasonId}`);
          
          const prevPlayersQuery = query(collection(db, 'pwhl_players'), where('season_id', 'in', [resolvedSeasonId, Number(resolvedSeasonId)]));
          const prevPlayersSnap = await getDocs(prevPlayersQuery);
          rawPlayers = prevPlayersSnap.docs.map(d => d.data());
        }
      }

      // Fetch remaining season details (teams, projections, games) in parallel
      const [teamsSnap, projectionsSnap, gamesSnap] = await Promise.all([
        getDocs(query(collection(db, 'pwhl_teams'), where('season_id', 'in', [resolvedSeasonId, Number(resolvedSeasonId)]))),
        getDocs(collection(db, `pwhl_projections/${sId}/player_projections`)).catch(err => {
          console.warn(`No projections found for season ${sId}:`, err);
          return { docs: [] };
        }),
        getDocs(query(collection(db, 'pwhl_games'), where('season_id', 'in', [resolvedSeasonId, Number(resolvedSeasonId)])))
      ]);

      // Map teams
      const teamsMap = {};
      teamsSnap.docs.forEach(d => {
        const t = d.data();
        teamsMap[String(t.id)] = {
          code: t.code || t.name || t.id,
          logo: t.team_logo_url || ''
        };
      });

      // Map and deduplicate players
      const seenIds = new Set();
      const players = [];
      rawPlayers.forEach(p => {
        const rawId = p.player_id || p.id;
        if (!rawId) return;
        const idStr = String(rawId);
        if (seenIds.has(idStr)) return;
        seenIds.add(idStr);

        players.push({
          id: idStr,
          first_name: p.first_name || '',
          last_name: p.last_name || '',
          name: p.name || `${p.first_name || ''} ${p.last_name || ''}`.trim() || 'Unknown Player',
          pos: normalizePosition(p.position),
          team_id: p.current_team_id || p.team_id || '',
          jersey_number: p.tp_jersey_number || p.jersey_number || '',
          player_image: p.player_image || '',
          shoots: p.shoots || '',
          hometown: p.hometown || p.homeplace || '',
          height: p.height || p.h || '',
          weight: p.weight || p.w || '',
          birthdate: p.birthdate || p.rawbirthdate || '',
          ...p
        });
      });

      const projections = projectionsSnap.docs.map(d => d.data());
      const games = gamesSnap.docs.map(d => ({ id: d.id, ...d.data() }));

      const seasonData = {
        playersList: players,
        pwhlTeams: teamsMap,
        projectionsList: projections,
        gamesList: games,
        resolvedSeasonId,
        isFallbackUniverse: fallbackActive
      };

      // Update ref and React state
      cacheRef.current[sId] = seasonData;
      setSeasonCache(prev => ({ ...prev, [sId]: seasonData }));
    } catch (err) {
      console.error(`Error loading details for seasonId ${sId}:`, err);
    } finally {
      // Mark as finished loading
      loadingStatesRef.current[sId] = false;
      setLoadingStates(prev => ({ ...prev, [sId]: false }));
    }
  }, [seasons]);

  const value = {
    seasons,
    seasonsLoading,
    seasonCache,
    loadingStates,
    loadSeasonData
  };

  return (
    <DataContext.Provider value={value}>
      {children}
    </DataContext.Provider>
  );
}
