import { useEffect, useState } from 'react';
import { collection, query, where, orderBy, limit, getDocs, Timestamp } from 'firebase/firestore';
import { db } from '../firebase.js';
import { AlertCircle } from 'lucide-react';
import { pointsDelta, STAT_LABELS } from '../services/scoring';
import { normalizePosition } from '../services/pwhlService';

const DAYS = 14;

/**
 * League-wide feed of stat corrections (functions/liveStats.js writes them):
 * changes LeagueStat made to a player's stats after a game was final, for players
 * rostered in this league, with the fantasy-point effect under this league's scoring.
 * Also shows a notice when a week was settled on unconfirmed data.
 */
export default function StatCorrectionsFeed({ leagueId, leagueData, teams, playersMap }) {
  const [loaded, setLoaded] = useState({ leagueId: null, rows: [] });

  useEffect(() => {
    if (!leagueId) return undefined;
    let cancelled = false;
    const since = Timestamp.fromMillis(Date.now() - DAYS * 86400000);
    getDocs(query(collection(db, 'stat_corrections'), where('detectedAt', '>=', since), orderBy('detectedAt', 'desc'), limit(200)))
      .then(snap => { if (!cancelled) setLoaded({ leagueId, rows: snap.docs.map(d => ({ id: d.id, ...d.data() })) }); })
      .catch(err => { console.warn('Stat corrections unavailable:', err); if (!cancelled) setLoaded({ leagueId, rows: [] }); });
    return () => { cancelled = true; };
  }, [leagueId]);

  const rows = loaded.leagueId === leagueId ? loaded.rows : [];
  const ownerOf = {};
  for (const t of teams) for (const pid of t.players || []) ownerOf[String(pid)] = t.teamName;

  const items = rows.filter(r =>
    (r.type === 'stat' && ownerOf[String(r.playerId)]) ||
    (r.type === 'unconfirmed_settlement' && String(r.seasonId) === String(leagueData?.season_id))
  );

  return (
    <div className="bg-white border border-slate-200/80 rounded-2xl shadow-sm overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-200 bg-slate-50">
        <h3 className="text-xs font-black uppercase tracking-wider text-slate-900 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 text-amber-600" /> Stat Corrections
        </h3>
        <p className="text-[10px] text-slate-500 font-medium mt-0.5">
          Changes the league made to stats after a game ended, for players on teams in this league (last {DAYS} days).
        </p>
      </div>
      {items.length === 0 ? (
        <p className="p-5 text-xs text-slate-400 font-medium italic">No stat corrections.</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {items.map(r => {
            if (r.type === 'unconfirmed_settlement') {
              return <li key={r.id} className="px-5 py-3 text-xs text-amber-800 bg-amber-50/60 font-medium">{r.note}</li>;
            }
            const rawPos = playersMap?.[String(r.playerId)]?.pos;
            const pos = rawPos ? normalizePosition(rawPos) : undefined;
            const delta = pointsDelta(r.changes || [], r.kind, leagueData?.scoringSettings, pos);
            const date = r.date ? new Date(`${r.date}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
            return (
              <li key={r.id} className="px-5 py-3 flex items-start justify-between gap-3 text-xs">
                <div className="min-w-0">
                  <div className="font-black text-slate-900 truncate">
                    {r.playerName || playersMap?.[String(r.playerId)]?.name || `Player ${r.playerId}`}
                    <span className="font-semibold text-slate-500"> · {ownerOf[String(r.playerId)]}</span>
                  </div>
                  <div className="text-slate-600 font-medium mt-0.5">
                    {date && <span className="text-slate-400">{date} · </span>}
                    {(r.changes || []).map(c => `${STAT_LABELS[c.stat] || c.stat} ${c.from}→${c.to}`).join(', ')}
                  </div>
                </div>
                <span className={`font-black shrink-0 ${delta < 0 ? 'text-red-600' : delta > 0 ? 'text-emerald-700' : 'text-slate-400'}`}>
                  {delta > 0 ? '+' : ''}{delta.toFixed(2)} pts
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
