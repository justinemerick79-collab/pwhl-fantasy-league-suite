import React, { createContext, useContext, useState, useEffect } from 'react';
import { db } from '../firebase';
import { doc, onSnapshot, setDoc } from 'firebase/firestore';

const TimeTravelContext = createContext();

export function useTimeTravel() {
  return useContext(TimeTravelContext);
}

export function TimeTravelProvider({ children }) {
  const [simulationState, setSimulationState] = useState({
    testModeActive: false,
    current_simulated_date: null,
    active_test_league_id: ''
  });
  const [activeSeasonId, setActiveSeasonId] = useState('5');
  const [activeSeasonName, setActiveSeasonName] = useState('2024-25 Regular Season');

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
    // Listen to global admin_settings/simulation_state document
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

  const getSimulatedDate = () => {
    if (simulationState.testModeActive) {
      if (simulationState.current_simulated_date) {
        return new Date(`${simulationState.current_simulated_date}T08:00:00-08:00`);
      }
    }
    return new Date();
  };

  const value = {
    simulationState,
    getSimulatedDate,
    activeSeasonId,
    activeSeasonName
  };

  return (
    <TimeTravelContext.Provider value={value}>
      {children}
    </TimeTravelContext.Provider>
  );
}
