/**
 * Status of today's fantasy points: LIVE · updated 8:42 PM / Final (unofficial) / Final.
 * `liveDay` is the value of useLiveDay(); nothing renders without it.
 */
export default function LiveBadge({ liveDay }) {
  if (!liveDay?.status) return null;
  if (liveDay.status === 'live') {
    const time = liveDay.updatedAt ? liveDay.updatedAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : null;
    return (
      <span className="inline-flex items-center gap-1.5 text-[10px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5" title="Points update every 5 minutes during games. Stats are provisional until LeagueStat confirms them.">
        <span className="relative flex h-1.5 w-1.5">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
          <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-600"></span>
        </span>
        LIVE{time ? ` · updated ${time}` : ''}
      </span>
    );
  }
  if (liveDay.status === 'final') {
    return <span className="text-[10px] font-bold text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5" title="Games are over. LeagueStat has not confirmed the final stats yet.">Final (unofficial)</span>;
  }
  if (liveDay.status === 'official') {
    return <span className="text-[10px] font-bold text-slate-600 bg-slate-50 border border-slate-200 rounded-full px-2 py-0.5" title="Stats confirmed by LeagueStat.">Final</span>;
  }
  return null;
}
