/**
 * A player's PWHL team. A player with no PWHL team (cut, unsigned, or no longer in the
 * feed) shows "FA" as a dashed grey chip — deliberately unlike the league's fantasy
 * "Free Agent" / "FA" availability badge, which is a filled colour pill.
 */
export default function PwhlTeamLabel({ code, className = 'text-[10px] font-semibold text-slate-600', dark = false }) {
  if (!code || code === 'FA') {
    const tone = dark ? 'text-white/70 border-white/40' : 'text-slate-500 border-slate-300';
    return (
      <span title="No PWHL team" className={`inline-block text-[10px] font-semibold border border-dashed rounded px-1.5 py-0.5 ${tone}`}>
        FA
      </span>
    );
  }
  return <span className={className}>{code}</span>;
}
