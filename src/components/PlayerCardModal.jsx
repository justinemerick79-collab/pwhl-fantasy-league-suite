import { useState, useEffect } from 'react';
import { User, X, AlertCircle, Shield, ArrowRightLeft } from 'lucide-react';
import { db } from '../firebase';
import { doc, getDoc, collection, getDocs } from 'firebase/firestore';
import { useTimeTravel } from '../contexts/TimeTravelContext';
import { useAuth } from '../contexts/AuthContext';
import { fetchPlayerGameHistory, normalizePosition } from '../services/pwhlService';
import { fetchAggregatedStats } from '../services/statsEngine';

export default function PlayerCardModal({ player: initialPlayer, playerId, onClose, onProposeTrade }) {
  const pId = playerId || initialPlayer?.id || initialPlayer?.player_id;

  const { activeSeasonId, activeLeagueId, getSimulatedDate } = useTimeTravel();
  const { currentUser } = useAuth();

  const getTeamBranding = (teamCode) => {
    switch (teamCode) {
      case 'BOS':
        return { gradient: 'from-emerald-800 to-slate-900', borderColor: 'border-emerald-500/35', glowColor: 'shadow-emerald-500/10' };
      case 'MIN':
        return { gradient: 'from-purple-800 to-slate-900', borderColor: 'border-purple-500/35', glowColor: 'shadow-purple-500/10' };
      case 'MTL':
        return { gradient: 'from-rose-900 to-slate-900', borderColor: 'border-rose-500/35', glowColor: 'shadow-rose-500/10' };
      case 'NY':
        return { gradient: 'from-teal-800 to-slate-900', borderColor: 'border-teal-500/35', glowColor: 'shadow-teal-500/10' };
      case 'OTT':
        return { gradient: 'from-red-800 to-slate-900', borderColor: 'border-red-500/35', glowColor: 'shadow-red-500/10' };
      case 'TOR':
        return { gradient: 'from-blue-900 to-slate-900', borderColor: 'border-blue-500/35', glowColor: 'shadow-blue-500/10' };
      default:
        return { gradient: 'from-indigo-900 to-slate-900', borderColor: 'border-indigo-500/35', glowColor: 'shadow-indigo-500/10' };
    }
  };

  const [player, setPlayer] = useState(initialPlayer || null);
  const [gameHistory, setGameHistory] = useState([]);
  const [teamBranding, setTeamBranding] = useState(initialPlayer ? getTeamBranding(initialPlayer.teamCode || initialPlayer.team) : {});
  const [loading, setLoading] = useState(!initialPlayer);
  const [statsLoading, setStatsLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    // Nothing to load without a player id. The null render is handled
    // after the hooks, so this effect must still be registered.
    if (!pId) return;

    let active = true;

    // Reset or initialize state when playerId/initialPlayer changes
    if (initialPlayer) {
      setPlayer(initialPlayer);
      setTeamBranding(getTeamBranding(initialPlayer.teamCode || initialPlayer.team));
      setLoading(false);
    } else {
      setPlayer(null);
      setTeamBranding({});
      setLoading(true);
    }
    setGameHistory([]);
    setStatsLoading(true);
    setError(null);

    async function loadData() {
      try {
        const seasonId = initialPlayer?.season_id || activeSeasonId || '5';
        const simDate = getSimulatedDate();

        // 1. Fetch player demographics if not fully loaded
        let playerData = {};
        if (initialPlayer && initialPlayer.name && initialPlayer.shoots) {
          playerData = { ...initialPlayer };
        } else {
          const docRef = doc(db, 'pwhl_players', `${seasonId}_${pId}`);
          const snap = await getDoc(docRef);
          if (snap.exists()) {
            playerData = snap.data();
          } else {
            // Try fallback
            const snap2 = await getDoc(doc(db, 'pwhl_players', String(pId)));
            if (snap2.exists()) {
              playerData = snap2.data();
            } else {
              throw new Error("Athlete profile not found.");
            }
          }
        }

        const normPos = normalizePosition(playerData.position || playerData.pos);
        const name = playerData.name || `${playerData.first_name || ''} ${playerData.last_name || ''}`.trim() || 'Unknown Player';
        const jersey_number = playerData.tp_jersey_number || playerData.jersey_number || '';
        const teamId = String(playerData.current_team_id || playerData.team_id || playerData.teamId || '');

        // 2. Fetch team details
        let teamCode = playerData.teamCode || playerData.team || 'FA';
        let teamLogo = playerData.teamLogo || '';
        if (teamId && teamId !== 'FA') {
          const tDoc = await getDoc(doc(db, 'pwhl_teams', `${seasonId}_${teamId}`));
          if (tDoc.exists()) {
            const tData = tDoc.data();
            teamCode = tData.code || tData.name || teamId;
            teamLogo = tData.team_logo_url || '';
          }
        }

        // 3. Resolve owner in active league
        let owner = null;
        let scoringSettings = null;
        if (activeLeagueId) {
          const leagueSnap = await getDoc(doc(db, 'fantasy_leagues', activeLeagueId));
          if (leagueSnap.exists()) {
            const leagueData = leagueSnap.data();
            scoringSettings = leagueData.scoringSettings;
          }

          const teamsSnap = await getDocs(collection(db, `fantasy_leagues/${activeLeagueId}/teams`));
          const teamsList = teamsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
          const owningTeam = teamsList.find(t => (t.players || []).includes(String(pId)));
          if (owningTeam) {
            if (owningTeam.ownerId === currentUser?.uid) {
              owner = { label: "Your Team", color: "text-indigo-600 bg-indigo-50 border-indigo-100" };
            } else {
              owner = { label: owningTeam.teamName, color: "text-gray-500 bg-gray-50 border-gray-200" };
            }
          }
        }

        // 4. Fetch cumulative stats
        const aggStats = await fetchAggregatedStats(seasonId, simDate);
        let gp = 0, g_w = 0, a_otl = 0, pm_ga = 0, sog_sv = 0, blk_so = 0, hits = 0;
        let points = 0.0;

        const activeStats = (normPos === 'G' ? aggStats.goalies[pId] : aggStats.skaters[pId]) || {};
        if (normPos === 'G') {
          gp = activeStats.gamesPlayed || 0;
          g_w = activeStats.wins || 0;
          a_otl = activeStats.overtimeLosses || activeStats.otl || 0;
          pm_ga = activeStats.goalsAgainst || activeStats.ga || 0;
          sog_sv = activeStats.shotsSaved || activeStats.saves || 0;
          blk_so = activeStats.shutouts || 0;
          hits = '-';
        } else {
          gp = activeStats.gamesPlayed || 0;
          g_w = activeStats.goals || 0;
          a_otl = activeStats.assists || 0;
          pm_ga = activeStats.plusMinus || 0;
          sog_sv = activeStats.shotsOnGoal || activeStats.shots || 0;
          blk_so = activeStats.blockedShots || activeStats.blocks || 0;
          hits = activeStats.hits || 0;
        }

        // Calculate fantasy points based on scoring settings
        const defaultScoring = {
          skaters: { goals: 2, assists: 1, plusMinus: 0.5, ppp: 0.5, shp: 0.5, sog: 0.1, hits: 0.1, blocks: 0.5, defensePoints: 0.5 },
          goalies: { wins: 4, otl: 1, ga: -2, saves: 0.2, shutouts: 3 }
        };
        const scoring = scoringSettings || defaultScoring;
        if (normPos === 'G') {
          const matrix = scoring.goalies || defaultScoring.goalies;
          points += g_w * (matrix.wins || 0);
          points += a_otl * (matrix.otl || 0);
          points += pm_ga * (matrix.ga || 0);
          points += sog_sv * (matrix.saves || 0);
          points += blk_so * (matrix.shutouts || 0);
        } else {
          const matrix = scoring.skaters || defaultScoring.skaters;
          points += g_w * (matrix.goals || 0);
          points += a_otl * (matrix.assists || 0);
          points += pm_ga * (matrix.plusMinus || 0);
          const ppp = (activeStats.powerPlayGoals || 0) + (activeStats.powerPlayAssists || 0);
          const shp = (activeStats.shortHandedGoals || 0) + (activeStats.shortHandedAssists || 0);
          points += ppp * (matrix.ppp || 0);
          points += shp * (matrix.shp || 0);
          points += sog_sv * (matrix.sog || 0);
          points += hits * (matrix.hits || 0);
          points += blk_so * (matrix.blocks || 0);
          if (normPos === 'D') {
            points += (g_w + a_otl) * (matrix.defensePoints || 0);
          }
        }
        points = Math.round(points * 100) / 100;

        // 5. Fetch history
        const history = await fetchPlayerGameHistory(pId, normPos, teamCode, seasonId, simDate, scoringSettings);

        if (active) {
          setPlayer({
            ...playerData,
            id: String(pId),
            name,
            pos: normPos,
            jersey_number,
            teamCode,
            teamLogo,
            owner,
            gp, g_w, a_otl, pm_ga, sog_sv, blk_so, hits,
            points
          });
          setGameHistory(history);
          setTeamBranding(getTeamBranding(teamCode));
          setLoading(false);
          setStatsLoading(false);
        }
      } catch (err) {
        console.error("Error loading player modal details:", err);
        if (active) {
          setError(err.message || "Failed to load player details.");
          setLoading(false);
          setStatsLoading(false);
        }
      }
    }

    loadData();

    return () => {
      active = false;
    };
  // initialPlayer is safe to track: every call site passes a state value
  // (selectedCardPlayer), not an inline object, so its identity is stable
  // between renders.
  }, [pId, activeSeasonId, activeLeagueId, currentUser?.uid, getSimulatedDate, initialPlayer]);

  // Must stay below every hook: returning above them would change hook
  // order between renders (react-hooks/rules-of-hooks).
  if (!pId) return null;

  if (loading) {
    return (
      <div 
        className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 pt-24 pb-8 z-50 animate-fade-in"
        onClick={onClose}
      >
        <div 
          className="w-full max-w-xl bg-white border border-gray-200 rounded-[32px] overflow-hidden shadow-2xl p-8 flex flex-col justify-center items-center gap-4 animate-scale-up"
          onClick={e => e.stopPropagation()}
        >
          <div className="w-10 h-10 rounded-full border-4 border-indigo-600/30 border-t-indigo-600 animate-spin"></div>
          <span className="text-[10px] font-black uppercase tracking-wider text-gray-400">Loading Athlete Profile...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div 
        className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 pt-24 pb-8 z-50 animate-fade-in"
        onClick={onClose}
      >
        <div 
          className="w-full max-w-xl bg-white border border-gray-200 rounded-[32px] overflow-hidden shadow-2xl p-8 flex flex-col justify-center items-center gap-4 text-center animate-scale-up"
          onClick={e => e.stopPropagation()}
        >
          <AlertCircle className="w-10 h-10 text-rose-400 mb-2" />
          <h3 className="font-sports text-lg font-black text-gray-800 tracking-tight">Failed to Load Profile</h3>
          <p className="text-xs text-gray-500 font-semibold leading-relaxed">{error}</p>
          <button 
            onClick={onClose} 
            className="px-5 py-2.5 bg-indigo-600 text-white rounded-xl text-[10px] font-black uppercase tracking-wider transition-transform active:scale-95 shadow-md shadow-indigo-600/10 cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    );
  }

  return (
    <div 
      className="fixed inset-0 bg-slate-900/60 backdrop-blur-md flex items-center justify-center p-4 pt-24 pb-8 z-50 animate-fade-in"
      onClick={onClose}
    >
      <div 
        className="w-full max-w-xl max-h-[78vh] bg-white border border-slate-200/80 rounded-2xl overflow-hidden shadow-2xl relative flex flex-col animate-scale-up text-slate-800"
        onClick={e => e.stopPropagation()}
      >
        {/* Header / Profile section with team branding */}
        <div className={`relative p-6 text-white bg-gradient-to-br ${teamBranding?.gradient || 'from-slate-700 to-slate-900'} border-b ${teamBranding?.borderColor || 'border-slate-800'} overflow-hidden shrink-0`}>
          
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
            className="absolute right-4 top-4 text-white/70 hover:text-white bg-white/20 hover:bg-white/30 rounded-xl w-8 h-8 flex items-center justify-center transition-colors z-20 cursor-pointer"
          >
            <X className="w-5 h-5" />
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
                <User className="w-10 h-10 text-white/70" />
              </div>
            )}
            <div>
              <h3 className="font-sports text-2xl font-black tracking-tight">{player.name}</h3>
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                <span title={player.teamCode && player.teamCode !== 'FA' ? undefined : 'No PWHL team'} className={`text-[10px] font-black px-2 py-0.5 rounded uppercase tracking-wider ${player.teamCode && player.teamCode !== 'FA' ? 'bg-white/20 border border-white/10' : 'border border-dashed border-white/40 text-white/70'}`}>
                  {player.teamCode || 'FA'}
                </span>
                <span className="text-[10px] font-black bg-white/20 px-2 py-0.5 rounded border border-white/10 uppercase tracking-wider">
                  {player.pos || 'F'}
                </span>
                {player.isUndroppable && (
                  <span className="text-[9px] font-black text-amber-300 bg-amber-500/20 border border-amber-500/40 px-2 py-0.5 rounded flex items-center gap-1">
                    <Shield className="w-3 h-3 text-amber-400" /> CAN'T CUT
                  </span>
                )}
                {player.owner?.status === 'rostered' && onProposeTrade && (
                  <button
                    onClick={() => {
                      onClose();
                      onProposeTrade(player);
                    }}
                    className="text-[9px] font-black text-white bg-emerald-600 hover:bg-emerald-500 px-2.5 py-1 rounded-lg border border-emerald-400/40 flex items-center gap-1 cursor-pointer active:scale-95 transition-all shadow-md ml-auto"
                  >
                    <ArrowRightLeft className="w-3 h-3" /> Propose Trade
                  </button>
                )}
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
            <div className="p-5 border-b border-gray-100 text-left bg-slate-50">
              <h4 className="text-[9px] font-bold uppercase tracking-wider text-slate-700 mb-3 flex items-center gap-1.5">
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
            
            {statsLoading ? (
              <div className="grid grid-cols-3 sm:grid-cols-5 gap-3 animate-pulse">
                {[...Array(5)].map((_, i) => (
                  <div key={i} className="bg-gray-50/70 p-2.5 h-14 rounded-xl border border-gray-100"></div>
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-3 sm:grid-cols-5 gap-3 animate-fade-in">
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
                
                <div className="bg-slate-100 p-2.5 rounded-xl border border-slate-200 text-center col-span-2 sm:col-span-2 flex flex-col justify-center">
                  <span className="block text-[7.5px] uppercase font-bold text-slate-500 tracking-wider">Fantasy Points</span>
                  <span className="text-sm font-bold text-slate-800 leading-none mt-1">
                    {(player.points || 0).toFixed(1)} <span className="text-[7.5px] font-semibold uppercase text-slate-500">fpts</span>
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Recent game history */}
          <div className="p-5 text-left">
            <h4 className="text-[9px] font-black uppercase tracking-wider text-gray-400 mb-3">Recent Game History (Last 5 Games)</h4>
            
            {statsLoading ? (
              <div className="h-32 bg-gray-50 border border-dashed border-gray-200 rounded-xl animate-pulse"></div>
            ) : (!gameHistory || gameHistory.length === 0) ? (
              <div className="text-center py-6 text-[10px] text-gray-400 font-bold italic border border-dashed border-gray-200 rounded-xl bg-gray-50/30">
                No recent games played.
              </div>
            ) : (
              <div className="overflow-hidden rounded-xl border border-gray-100 animate-fade-in">
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
                        <td className="px-3.5 py-2 font-bold text-slate-800 text-center bg-slate-50">
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
        <div className="bg-slate-50 px-6 py-4 flex justify-end gap-3 border-t border-slate-100 shrink-0">
          <button 
            onClick={onClose}
            className="px-5 py-2 bg-white hover:bg-slate-50 border border-slate-200 rounded-lg text-xs font-semibold text-slate-600 transition-colors cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
