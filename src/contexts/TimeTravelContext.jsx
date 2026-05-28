import React, { createContext, useContext, useState, useEffect } from 'react';
import { db } from '../firebase';
import { doc, onSnapshot, setDoc } from 'firebase/firestore';

const TimeTravelContext = createContext();

export function useTimeTravel() {
  return useContext(TimeTravelContext);
}

export function TimeTravelProvider({ children }) {
  const [timeTravelState, setTimeTravelState] = useState({
    enabled: false,
    date: '2024-09-01' // Default starting point
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Listen to global app_settings/time_travel document
    const docRef = doc(db, 'app_settings', 'time_travel');
    const unsubscribe = onSnapshot(docRef, (snap) => {
      if (snap.exists()) {
        setTimeTravelState(snap.data());
      } else {
        setDoc(docRef, { enabled: false, date: '2024-09-01' }, { merge: true }).catch(console.error);
      }
      setLoading(false);
    }, (error) => {
      console.error("TimeTravelContext onSnapshot error:", error);
      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  const getSimulatedDate = () => {
    if (timeTravelState.enabled && timeTravelState.date) {
      return new Date(`${timeTravelState.date}T08:00:00-08:00`);
    }
    return new Date();
  };

  const value = {
    timeTravelState,
    getSimulatedDate
  };

  return (
    <TimeTravelContext.Provider value={value}>
      {children}
    </TimeTravelContext.Provider>
  );
}
