import { useEffect, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase.js';

/**
 * Live status of one day's fantasy points (daily_game_stats/{dateStr}), kept current
 * by functions/liveStats.js. Returns { status: 'live'|'final'|'official', version,
 * updatedAt } or null when the day has no points document.
 *
 * Screens add `version` to their data-loading effect, so every server update
 * triggers one reload of the data they already load.
 * State is stamped with the date it belongs to and derived, so a stale day is
 * never shown after the date changes (CLAUDE.md "Mirroring Firestore data").
 */
export function useLiveDay(dateStr) {
  const [snap, setSnap] = useState({ date: null, data: null });
  useEffect(() => {
    if (!dateStr) return undefined;
    return onSnapshot(
      doc(db, 'daily_game_stats', dateStr),
      (s) => {
        const d = s.exists() ? s.data() : null;
        setSnap({ date: dateStr, data: d ? { status: d.status || null, version: d.version || 0, updatedAt: d.updatedAt?.toDate?.() || null } : null });
      },
      () => setSnap({ date: dateStr, data: null })
    );
  }, [dateStr]);
  return snap.date === dateStr ? snap.data : null;
}

/**
 * Today's PWHL games with live status, score, period and clock
 * (live_state/current, written by the live poller). Returns { date, byId } or null.
 */
export function useLiveGames() {
  const [state, setState] = useState(null);
  useEffect(() => onSnapshot(
    doc(db, 'live_state', 'current'),
    (s) => {
      if (!s.exists()) { setState(null); return; }
      const d = s.data();
      setState({ date: d.date, byId: Object.fromEntries((d.games || []).map(g => [String(g.gameId), g])) });
    },
    () => setState(null)
  ), []);
  return state;
}
