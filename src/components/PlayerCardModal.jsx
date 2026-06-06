import React from 'react';

export default function PlayerCardModal({ player, gameHistory, teamBranding, onClose }) {
  if (!player) return null;

  return (
    <div 
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 pt-24 pb-8 z-50 animate-fade-in"
      onClick={onClose}
    >
      <div 
        className="w-full max-w-xl max-h-[78vh] bg-white border border-gray-200 rounded-[32px] overflow-hidden shadow-2xl relative flex flex-col animate-scale-up"
        onClick={e => e.stopPropagation()}
      >
        {/* Header / Profile section with team branding */}
        <div className={`relative p-6 text-white bg-gradient-to-br ${teamBranding?.gradient || 'from-gray-600 to-gray-800'} border-b ${teamBranding?.borderColor || 'border-gray-900'} overflow-hidden shrink-0`}>
          
          {/* Semi-transparent team watermark */}
          {player.teamLogo && (
            <img 
              src={player.teamLogo} 
              alt={`${player.teamCode || ''} Logo`} 
              className="absolute right-2 top-2 w-28 h-28 opacity-15 pointer-events-none select-none object-contain"
            />
          )}

          {/* Close Button */}
          <button 
            onClick={onClose}
            className="absolute right-4 top-4 text-white/70 hover:text-white text-xl font-bold bg-white/10 hover:bg-white/20 rounded-full w-8 h-8 flex items-center justify-center transition-colors z-20"
          >
            &times;
          </button>

          {/* Jersey Number Watermark */}
          {player.jersey_number && (
            <span className="absolute left-4 top-4 text-5xl font-black text-white/10 leading-none">
              #{player.jersey_number}
            </span>
          )}

          {/* Profile Details Layout */}
          <div className="flex items-center gap-5 mt-4 relative z-10">
            {player.player_image ? (
              <img 
                src={player.player_image} 
                alt={player.name} 
                className={`w-20 h-20 rounded-3xl border-2 border-white/50 object-cover shadow-lg ${teamBranding?.glowColor || ''}`} 
              />
            ) : (
              <div className="w-20 h-20 rounded-3xl bg-white/10 border-2 border-white/30 flex items-center justify-center text-4xl shadow-lg">
                🏒
              </div>
            )}
            <div>
              <h3 className="font-sports text-2xl font-black tracking-tight">{player.name}</h3>
              <div className="flex items-center gap-2 mt-1">
                <span className="text-[10px] font-black bg-white/20 px-2 py-0.5 rounded border border-white/10 uppercase tracking-wider">
                  {player.teamCode || 'FA'}
                </span>
                <span className="text-[10px] font-black bg-white/20 px-2 py-0.5 rounded border border-white/10 uppercase tracking-wider">
                  {player.pos || 'F'}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Scrollable Content Container */}
        <div className="overflow-y-auto flex-1 text-left">
          {/* Demographics details */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 p-5 bg-gray-50/50 border-b border-gray-100 text-left">
            <div>
              <span className="block text-[8px] uppercase font-black text-gray-400 tracking-wider">Jersey</span>
              <span className="text-xs font-black text-gray-700">#{player.jersey_number || 'N/A'}</span>
            </div>
            <div>
              <span className="block text-[8px] uppercase font-black text-gray-400 tracking-wider">Position</span>
              <span className="text-xs font-black text-gray-700">{player.pos === 'G' ? 'Goalie' : (player.pos === 'D' ? 'Defense' : 'Forward')}</span>
            </div>
            <div>
              <span className="block text-[8px] uppercase font-black text-gray-400 tracking-wider">Shoots</span>
              <span className="text-xs font-black text-gray-700">{player.shoots || 'N/A'}</span>
            </div>
            <div>
              <span className="block text-[8px] uppercase font-black text-gray-400 tracking-wider">Hometown</span>
              <span className="text-xs font-black text-gray-700 truncate block" title={player.hometown || player.homeplace || 'N/A'}>
                {player.hometown || player.homeplace || 'N/A'}
              </span>
            </div>
            <div>
              <span className="block text-[8px] uppercase font-black text-gray-400 tracking-wider">Height</span>
              <span className="text-xs font-black text-gray-700">{player.height || player.h || 'N/A'}</span>
            </div>
            <div>
              <span className="block text-[8px] uppercase font-black text-gray-400 tracking-wider">Birthdate</span>
              <span className="text-xs font-black text-gray-700">{player.birthdate || player.rawbirthdate || 'N/A'}</span>
            </div>
            <div>
              <span className="block text-[8px] uppercase font-black text-gray-400 tracking-wider">Status</span>
              {player.owner ? (
                <span className={`text-[9px] font-black uppercase px-2 py-0.5 rounded-lg border inline-block tracking-wider ${player.owner.color || 'bg-gray-100 text-gray-600'}`}>
                  {player.owner.label}
                </span>
              ) : (
                <span className="text-[9px] font-black uppercase px-2 py-0.5 rounded-lg border inline-block tracking-wider bg-emerald-50 text-emerald-600 border-emerald-200">
                  Free Agent
                </span>
              )}
            </div>
          </div>

          {/* Draft Info Section */}
          {player.draftInfo && (
            <div className="p-5 border-b border-gray-100 text-left bg-indigo-50/20">
              <h4 className="text-[9px] font-black uppercase tracking-wider text-indigo-600 mb-3 flex items-center gap-1.5">
                🎓 PWHL Draft Information
              </h4>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <div>
                  <span className="block text-[8px] uppercase font-black text-gray-400 tracking-wider">Draft Year</span>
                  <span className="text-xs font-black text-gray-700">{player.draftInfo.year || 'N/A'}</span>
                </div>
                <div>
                  <span className="block text-[8px] uppercase font-black text-gray-400 tracking-wider">Selection</span>
                  <span className="text-xs font-black text-gray-700">
                    Round {player.draftInfo.round || 'N/A'}, Pick {player.draftInfo.pick || 'N/A'}
                  </span>
                </div>
                <div>
                  <span className="block text-[8px] uppercase font-black text-gray-400 tracking-wider">Drafted By</span>
                  <span className="text-xs font-black text-gray-700">{player.draftInfo.draftedBy || 'N/A'}</span>
                </div>
                <div>
                  <span className="block text-[8px] uppercase font-black text-gray-400 tracking-wider">Former Team</span>
                  <span className="text-xs font-black text-gray-700 truncate block" title={player.draftInfo.formerTeam || 'N/A'}>
                    {player.draftInfo.formerTeam || 'N/A'}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Season Stats Dashboard */}
          <div className="p-5 border-b border-gray-100 text-left">
            <h4 className="text-[9px] font-black uppercase tracking-wider text-gray-400 mb-3">Season Summary</h4>
            <div className="grid grid-cols-3 sm:grid-cols-5 gap-3">
              {player.pos === 'G' ? (
                <>
                  <div className="bg-gray-50/70 p-2.5 rounded-xl border border-gray-100 text-center">
                    <span className="block text-[8px] uppercase font-black text-gray-400">GP</span>
                    <span className="text-xs font-black text-gray-700">{player.gp || 0}</span>
                  </div>
                  <div className="bg-gray-50/70 p-2.5 rounded-xl border border-gray-100 text-center">
                    <span className="block text-[8px] uppercase font-black text-gray-400">Wins</span>
                    <span className="text-xs font-black text-gray-700">{player.g_w || 0}</span>
                  </div>
                  <div className="bg-gray-50/70 p-2.5 rounded-xl border border-gray-100 text-center">
                    <span className="block text-[8px] uppercase font-black text-gray-400">OTL</span>
                    <span className="text-xs font-black text-gray-700">{player.a_otl || 0}</span>
                  </div>
                  <div className="bg-gray-50/70 p-2.5 rounded-xl border border-gray-100 text-center">
                    <span className="block text-[8px] uppercase font-black text-gray-400">GA</span>
                    <span className="text-xs font-black text-gray-700">{player.pm_ga || 0}</span>
                  </div>
                  <div className="bg-gray-50/70 p-2.5 rounded-xl border border-gray-100 text-center">
                    <span className="block text-[8px] uppercase font-black text-gray-400">Saves</span>
                    <span className="text-xs font-black text-gray-700">{player.sog_sv || 0}</span>
                  </div>
                  <div className="bg-gray-50/70 p-2.5 rounded-xl border border-gray-100 text-center">
                    <span className="block text-[8px] uppercase font-black text-gray-400">Shutouts</span>
                    <span className="text-xs font-black text-gray-700">{player.blk_so || 0}</span>
                  </div>
                </>
              ) : (
                <>
                  <div className="bg-gray-50/70 p-2.5 rounded-xl border border-gray-100 text-center">
                    <span className="block text-[8px] uppercase font-black text-gray-400">GP</span>
                    <span className="text-xs font-black text-gray-700">{player.gp || 0}</span>
                  </div>
                  <div className="bg-gray-50/70 p-2.5 rounded-xl border border-gray-100 text-center">
                    <span className="block text-[8px] uppercase font-black text-gray-400">Goals</span>
                    <span className="text-xs font-black text-gray-700">{player.g_w || 0}</span>
                  </div>
                  <div className="bg-gray-50/70 p-2.5 rounded-xl border border-gray-100 text-center">
                    <span className="block text-[8px] uppercase font-black text-gray-400">Assists</span>
                    <span className="text-xs font-black text-gray-700">{player.a_otl || 0}</span>
                  </div>
                  <div className="bg-gray-50/70 p-2.5 rounded-xl border border-gray-100 text-center">
                    <span className="block text-[8px] uppercase font-black text-gray-400">+/-</span>
                    <span className="text-xs font-black text-gray-700">{(player.pm_ga || 0) > 0 ? `+${player.pm_ga}` : (player.pm_ga || 0)}</span>
                  </div>
                  <div className="bg-gray-50/70 p-2.5 rounded-xl border border-gray-100 text-center">
                    <span className="block text-[8px] uppercase font-black text-gray-400">SOG</span>
                    <span className="text-xs font-black text-gray-700">{player.sog_sv || 0}</span>
                  </div>
                  <div className="bg-gray-50/70 p-2.5 rounded-xl border border-gray-100 text-center">
                    <span className="block text-[8px] uppercase font-black text-gray-400">Blocks</span>
                    <span className="text-xs font-black text-gray-700">{player.blk_so || 0}</span>
                  </div>
                  <div className="bg-gray-50/70 p-2.5 rounded-xl border border-gray-100 text-center">
                    <span className="block text-[8px] uppercase font-black text-gray-400">Hits</span>
                    <span className="text-xs font-black text-gray-700">{player.hits || 0}</span>
                  </div>
                </>
              )}
              
              <div className="bg-indigo-50/70 p-2.5 rounded-xl border border-indigo-100/50 text-center col-span-2 sm:col-span-2 flex flex-col justify-center">
                <span className="block text-[7.5px] uppercase font-black text-indigo-500 tracking-wider">Fantasy Points</span>
                <span className="text-sm font-sports font-black text-indigo-600 leading-none mt-1">
                  {(player.points || 0).toFixed(1)} <span className="text-[7.5px] font-black uppercase text-indigo-400">fpts</span>
                </span>
              </div>
            </div>
          </div>

          {/* Recent game history */}
          <div className="p-5 text-left">
            <h4 className="text-[9px] font-black uppercase tracking-wider text-gray-400 mb-3">Recent Game History (Last 5 Games)</h4>
            {(!gameHistory || gameHistory.length === 0) ? (
              <div className="text-center py-6 text-[10px] text-gray-400 font-bold italic border border-dashed border-gray-200 rounded-xl bg-gray-50/30">
                No recent games played.
              </div>
            ) : (
              <div className="overflow-hidden rounded-xl border border-gray-100">
                <table className="w-full text-left border-collapse text-[10.5px]">
                  <thead>
                    <tr className="bg-gray-50 border-b border-gray-100">
                      <th className="px-3.5 py-2 text-[8px] font-black uppercase text-gray-400">Date</th>
                      <th className="px-3.5 py-2 text-[8px] font-black uppercase text-gray-400">Matchup</th>
                      <th className="px-3.5 py-2 text-[8px] font-black uppercase text-gray-400">Result</th>
                      <th className="px-3.5 py-2 text-[8px] font-black uppercase text-gray-400">Game Stats</th>
                      <th className="px-3.5 py-2 text-[8px] font-black uppercase text-gray-400 text-center">FPTS</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {gameHistory.map((game, idx) => (
                      <tr key={idx} className="hover:bg-gray-50/50 transition-colors">
                        <td className="px-3.5 py-2 font-bold text-gray-400">{game.date}</td>
                        <td className="px-3.5 py-2 font-bold text-gray-700">{game.matchupLabel}</td>
                        <td className="px-3.5 py-2">
                          <span className={`font-black uppercase text-[9px] ${game.result.startsWith('W') ? 'text-emerald-600' : 'text-gray-500'}`}>
                            {game.result}
                          </span>
                        </td>
                        <td className="px-3.5 py-2 text-gray-500 font-medium">
                          {player.pos === 'G' ? (
                            `Wins: ${game.stats.wins}, OTL: ${game.stats.otl}, Saves: ${game.stats.saves}, GA: ${game.stats.ga}`
                          ) : (
                            `${game.stats.goals}G, ${game.stats.assists}A, ${game.stats.plusminus > 0 ? `+${game.stats.plusminus}` : game.stats.plusminus} +/-, ${game.stats.shots}S, ${game.stats.blocks}B, ${game.stats.hits}H`
                          )}
                        </td>
                        <td className="px-3.5 py-2 font-black text-indigo-600 text-center bg-indigo-50/10">
                          {game.points.toFixed(1)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* Modal Bottom Actions */}
        <div className="bg-gray-50 px-6 py-4.5 flex justify-end gap-3 border-t border-gray-100 shrink-0">
          <button 
            onClick={onClose}
            className="px-5 py-2.5 bg-white hover:bg-gray-50 border border-gray-200 rounded-xl text-[9px] font-black uppercase text-gray-500 tracking-wider transition-colors active:scale-95"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
