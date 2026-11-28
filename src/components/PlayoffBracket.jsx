import { Shield, Trophy } from 'lucide-react';

/**
 * Playoff bracket for the Standings tab. Pure display: the bracket itself is
 * built on the server (functions/playoffs.js) and stored as matchup documents
 * with `isPlayoff: true`, plus `league.playoffs` for seeds, byes and champion.
 */
const roundLabel = (round, totalRounds) => {
  const fromEnd = totalRounds - round;
  if (fromEnd === 0) return 'Championship Final';
  if (fromEnd === 1) return 'Semifinals';
  if (fromEnd === 2) return 'Quarterfinals';
  return `Round ${round}`;
};

function Side({ seed, name, score, won, done }) {
  return (
    <div className={`flex justify-between text-xs ${done && !won ? 'text-slate-400' : 'text-slate-900'} ${won ? 'font-black' : 'font-bold'}`}>
      <span className="truncate pr-2">#{seed} {name}</span>
      <span className="font-semibold shrink-0">{done ? Number(score).toFixed(1) : '-'}</span>
    </div>
  );
}

export default function PlayoffBracket({ leagueData, teams, rankedTeams, playoffMatchups }) {
  const playoffs = leagueData?.playoffs;
  const playoffWeeks = leagueData?.schedule?.playoffWeeks || [];
  const nameOf = (id) => teams.find(t => t.id === id)?.teamName || 'Team';
  const playoffTeams = Math.min(Number(leagueData?.scheduleSettings?.playoffTeams) || 0, teams.length);

  let body;
  if (playoffs?.status === 'none') {
    body = <p className="text-xs text-slate-500 font-medium">No playoffs this season ({playoffs.reason}).</p>;
  } else if (!playoffs) {
    body = playoffWeeks.length === 0 ? (
      <p className="text-xs text-slate-500 font-medium">The playoff schedule is set when the draft completes.</p>
    ) : (
      <div className="space-y-3">
        <p className="text-xs text-slate-600 font-medium">
          Top {playoffTeams} teams qualify. Playoffs begin in <strong>week {playoffWeeks[0]}</strong>.
        </p>
        <div>
          <span className="text-[9px] uppercase font-black text-indigo-600 tracking-wider">Current playoff position</span>
          <ol className="mt-1 space-y-1">
            {rankedTeams.slice(0, playoffTeams).map((t, i) => (
              <li key={t.id} className="text-xs font-bold text-slate-900 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">#{i + 1} {t.teamName}</li>
            ))}
          </ol>
        </div>
      </div>
    );
  } else {
    const seedOf = Object.fromEntries((playoffs.seeds || []).map((id, i) => [id, i + 1]));
    const firstRoundByes = (playoffs.seeds || []).slice(0, Math.max(0, 2 ** (playoffs.totalRounds || 0) - (playoffs.seeds || []).length));
    const rounds = Array.from({ length: playoffs.totalRounds || 0 }, (_, i) => i + 1);
    body = (
      <div className="space-y-5">
        {playoffs.championTeamId && (
          <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 text-center">
            <Trophy className="w-6 h-6 text-amber-600 mx-auto" />
            <div className="text-[9px] uppercase font-black text-amber-700 tracking-wider mt-1">League Champion</div>
            <div className="text-sm font-black text-slate-900 mt-0.5">{nameOf(playoffs.championTeamId)}</div>
          </div>
        )}
        {rounds.map(r => {
          const games = playoffMatchups.filter(m => m.round === r).sort((a, b) => (a.homeSeed || 0) - (b.homeSeed || 0));
          const isFinal = r === playoffs.totalRounds;
          return (
            <div key={r}>
              <span className={`text-[9px] uppercase font-black tracking-wider ${isFinal ? 'text-amber-700' : 'text-indigo-600'}`}>
                {roundLabel(r, playoffs.totalRounds)}{games[0] ? ` · Week ${games[0].week}` : ''}
              </span>
              <div className="space-y-2 mt-1">
                {games.length === 0 && <p className="text-xs text-slate-400 font-medium italic">Set when the previous round ends.</p>}
                {games.map(m => {
                  const done = m.status === 'completed';
                  return (
                    <div key={m.id} className={`${isFinal ? 'bg-amber-50 border-amber-200' : 'bg-slate-50 border-slate-200'} border p-3 rounded-xl space-y-1.5`}>
                      <Side seed={m.homeSeed} name={nameOf(m.homeTeamId)} score={m.homeScore} done={done} won={done && m.winnerId === m.homeTeamId} />
                      <Side seed={m.awaySeed} name={nameOf(m.awayTeamId)} score={m.awayScore} done={done} won={done && m.winnerId === m.awayTeamId} />
                    </div>
                  );
                })}
                {r === 1 && firstRoundByes.map(id => (
                  <div key={id} className="text-xs font-bold text-slate-600 bg-white border border-dashed border-slate-300 rounded-xl px-3 py-2">
                    #{seedOf[id]} {nameOf(id)} — bye
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="lg:col-span-5 bg-white border border-slate-200/80 p-6 rounded-2xl shadow-sm">
      <h3 className="text-xs font-black uppercase tracking-wider text-slate-900 border-b border-slate-200 pb-4 mb-5 flex items-center gap-2">
        <Shield className="w-4 h-4 text-indigo-600" /> Playoff Bracket
      </h3>
      {body}
    </div>
  );
}
