import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { db } from '../firebase';
import { doc, onSnapshot, setDoc } from 'firebase/firestore';

const TimeTravelContext = createContext();

export function useTimeTravel() {
  return useContext(TimeTravelContext);
}

export function TimeTravelProvider({ children }) {
  // Global simulation state (backward compatibility)
  const [simulationState, setSimulationState] = useState({
    testModeActive: false,
    current_simulated_date: null,
    active_test_league_id: ''
  });

  // Per-league simulation state (new architecture)
  const [leagueSimState, setLeagueSimState] = useState({
    isSimulation: false,
    simulatedDate: null,
    leagueId: null
  });

  const [activeSeasonId, setActiveSeasonId] = useState('5');
  const [activeSeasonName, setActiveSeasonName] = useState('2024-25 Regular Season');
  const [activeLeagueId, setActiveLeagueId] = useState(localStorage.getItem('pwhl_active_league') || null);

  useEffect(() => {
    // Listen to global app_settings/active_season document
    const docRef = doc(db, 'app_settings', 'active_season');
    const unsubscribe = onSnapshot(docRef, (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        setActiveSeasonId(data.active_season_id ? String(data.active_season_id) : '5');
        setActiveSeasonName(data.active_season_name || '2024-25 Regular Season');
      } else {
        setDoc(docRef, { active_season_id: '5', active_season_name: '2024-25 Regular Season' }, { merge: true }).catch(console.error);
      }
    }, (error) => {
      console.error("TimeTravelContext active_season onSnapshot error:", error);
    });

    return () => unsubscribe();
  }, []);

  useEffect(() => {
    // Listen to global admin_settings/simulation_state document (backward compatibility)
    const docRef = doc(db, 'admin_settings', 'simulation_state');
    const unsubscribe = onSnapshot(docRef, (snap) => {
      if (snap.exists()) {
        setSimulationState(snap.data());
      }
    }, (error) => {
      console.warn("TimeTravelContext simulation_state onSnapshot error:", error);
    });

    return () => unsubscribe();
  }, []);

  // Per-league simulation listener: watches the active league doc for simulation fields
  useEffect(() => {
    if (!activeLeagueId) {
      setLeagueSimState({ isSimulation: false, simulatedDate: null, leagueId: null });
      return;
    }

    const leagueRef = doc(db, 'fantasy_leagues', activeLeagueId);
    const unsubscribe = onSnapshot(leagueRef, (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        if (data.isSimulation) {
          setLeagueSimState({
            isSimulation: true,
            simulatedDate: data.simulatedDate || null,
            leagueId: activeLeagueId
          });
        } else {
          setLeagueSimState({ isSimulation: false, simulatedDate: null, leagueId: activeLeagueId });
        }
      }
    }, (error) => {
      console.warn("TimeTravelContext league sim onSnapshot error:", error);
    });

    return () => unsubscribe();
  }, [activeLeagueId]);

  /**
   * Returns the current simulated date as a Date object.
   * Priority:
   *   1. Per-league simulation date (if active league is a simulation)
   *   2. Global simulation state (backward compatibility)
   *   3. Real Date.now()
   */
  const getSimulatedDate = useCallback(() => {
    // 1. Per-league simulation
    if (leagueSimState.isSimulation && leagueSimState.simulatedDate) {
      return leagueSimState.simulatedDate.includes('T')
        ? new Date(leagueSimState.simulatedDate)
        : new Date(`${leagueSimState.simulatedDate}T08:00:00-08:00`);
    }

    // 2. Global simulation (backward compat)
    if (simulationState.testModeActive) {
      if (simulationState.current_simulated_date) {
        return simulationState.current_simulated_date.includes('T')
          ? new Date(simulationState.current_simulated_date)
          : new Date(`${simulationState.current_simulated_date}T08:00:00-08:00`);
      }
    }

    // 3. Real time
    return new Date();
  }, [
    leagueSimState.isSimulation,
    leagueSimState.simulatedDate,
    simulationState.testModeActive,
    simulationState.current_simulated_date
  ]);

  /**
   * Returns true if the current context is in any simulation mode
   * (either per-league or global).
   */
  const isSimulationActive = useCallback(() => {
    return leagueSimState.isSimulation || simulationState.testModeActive;
  }, [leagueSimState.isSimulation, simulationState.testModeActive]);

  const value = {
    simulationState,
    leagueSimState,
    getSimulatedDate,
    isSimulationActive,
    activeSeasonId,
    activeSeasonName,
    activeLeagueId,
    setActiveLeagueId
  };

  return (
    <TimeTravelContext.Provider value={value}>
      {children}
    </TimeTravelContext.Provider>
  );
}
