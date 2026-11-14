import React from 'react';
import { Trophy, Award, Shield, Moon, Zap, X } from 'lucide-react';

export default function MatchupResultModal({ isOpen, onClose, matchup, myTeam, oppTeam, weekNum, isByeWeek }) {
  if (!isOpen || !myTeam) return null;
  if (!isByeWeek && !matchup) return null;

  const isHome = !isByeWeek && matchup ? myTeam.id === matchup.homeTeamId : false;
  const myScore = !isByeWeek && matchup ? (isHome ? matchup.homeScore : matchup.awayScore) : 0.0;
  const oppScore = !isByeWeek && matchup ? (isHome ? matchup.awayScore : matchup.homeScore) : 0.0;

  // Determine outcome
  let outcome = 'tie'; // 'win' | 'loss' | 'tie' | 'bye'
  if (isByeWeek) outcome = 'bye';
  else if (myScore > oppScore) outcome = 'win';
  else if (myScore < oppScore) outcome = 'loss';

  // Configurations and text based on outcome
  const configs = {
    win: {
      cardBg: 'bg-white text-slate-800 border-slate-200',
      badge: 'bg-emerald-50 text-emerald-700 border-emerald-200',
      title: 'Matchup Won',
      icon: Trophy,
      iconColor: 'text-amber-500',
      message: 'Great coaching! Your active lineup dominated the stats sheets and secured the victory this week.',
      scoreHighlight: 'text-emerald-700 font-bold',
      actionBtn: 'bg-slate-700 hover:bg-slate-600 text-white font-semibold'
    },
    loss: {
      cardBg: 'bg-white text-slate-800 border-slate-200',
      badge: 'bg-red-50 text-red-700 border-red-200',
      title: 'Matchup Loss',
      icon: Shield,
      iconColor: 'text-red-500',
      message: 'A hard-fought battle! It wasn\'t our week, but the season is long. Adjust your roster and bounce back next week!',
      scoreHighlight: 'text-red-600 font-bold',
      actionBtn: 'bg-slate-700 hover:bg-slate-600 text-white font-semibold'
    },
    tie: {
      cardBg: 'bg-white text-slate-800 border-slate-200',
      badge: 'bg-slate-100 text-slate-700 border-slate-200',
      title: 'It\'s a Tie',
      icon: Award,
      iconColor: 'text-slate-500',
      message: 'A deadlock! Neither side yielded an inch. An intense matchup where every point mattered.',
      scoreHighlight: 'text-slate-700 font-bold',
      actionBtn: 'bg-slate-700 hover:bg-slate-600 text-white font-semibold'
    },
    bye: {
      cardBg: 'bg-white text-slate-800 border-slate-200',
      badge: 'bg-slate-100 text-slate-700 border-slate-200',
      title: 'Bye Week',
      icon: Moon,
      iconColor: 'text-slate-500',
      message: 'A quiet week in the arena! No games were scheduled, allowing your roster to rest and recover.',
      scoreHighlight: 'text-slate-700 font-bold',
      actionBtn: 'bg-slate-700 hover:bg-slate-600 text-white font-semibold'
    }
  }[outcome];

  const HeaderIcon = configs.icon;

  return (
    <div 
      className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center p-4 z-50 animate-fade-in"
      onClick={onClose}
    >
      <div 
        className={`w-full max-w-md ${configs.cardBg} border p-6 rounded-2xl shadow-xl relative select-none animate-scale-up overflow-hidden`}
        onClick={e => e.stopPropagation()}
      >
        {/* Close Button */}
        <button 
          className="absolute top-4 right-4 text-slate-400 hover:text-slate-700 transition-colors cursor-pointer"
          onClick={onClose}
        >
          <X className="w-5 h-5" />
        </button>

        {/* Badge Header */}
        <div className="flex justify-center mb-3">
          <span className={`px-3 py-1 rounded-lg text-xs font-semibold border ${configs.badge}`}>
            Week {weekNum} Result
          </span>
        </div>

        {/* Icon & Title */}
        <div className="flex flex-col items-center mb-5">
          <HeaderIcon className={`w-10 h-10 ${configs.iconColor} mb-2`} />
          <h2 className="font-sports text-2xl font-bold text-center text-slate-800">
            {configs.title}
          </h2>
        </div>

        {/* Versus Box Score / Bye Week Graphic */}
        {!isByeWeek ? (
          <div className="bg-slate-50 border border-slate-200 rounded-xl p-5 mb-5 flex items-center justify-between">
            {/* User's Team */}
            <div className="flex-1 flex flex-col items-center text-center">
              <div className="w-12 h-12 rounded-xl bg-white border border-slate-200 flex items-center justify-center text-sm font-bold text-slate-700 mb-1.5">
                {myTeam.teamName ? myTeam.teamName.slice(0, 2).toUpperCase() : 'MY'}
              </div>
              <span className="text-xs font-semibold text-slate-700 max-w-[100px] truncate">{myTeam.teamName}</span>
              <span className={`text-xl mt-1 ${outcome === 'win' ? configs.scoreHighlight : 'text-slate-800 font-semibold'}`}>
                {myScore.toFixed(2)}
              </span>
            </div>

            {/* VS Divider */}
            <div className="flex flex-col items-center px-4 border-x border-slate-200">
              <span className="text-[10px] font-semibold text-slate-400 uppercase">VS</span>
            </div>

            {/* Opponent's Team */}
            <div className="flex-1 flex flex-col items-center text-center">
              <div className="w-12 h-12 rounded-xl bg-white border border-slate-200 flex items-center justify-center text-sm font-bold text-slate-700 mb-1.5">
                {oppTeam?.teamName ? oppTeam.teamName.slice(0, 2).toUpperCase() : 'OP'}
              </div>
              <span className="text-xs font-semibold text-slate-700 max-w-[100px] truncate">{oppTeam?.teamName || 'Opponent'}</span>
              <span className={`text-xl mt-1 ${outcome === 'loss' ? configs.scoreHighlight : 'text-slate-800 font-semibold'}`}>
                {oppScore.toFixed(2)}
              </span>
            </div>
          </div>
        ) : (
          <div className="bg-slate-50 border border-slate-200 rounded-xl p-6 mb-5 flex flex-col items-center justify-center text-center">
            <Moon className="w-8 h-8 text-slate-400 mb-2" />
            <span className="text-xs font-semibold text-slate-500">Roster Rest Active</span>
            <span className="text-sm font-bold text-slate-700 mt-1">No Matchups Scheduled</span>
          </div>
        )}

        {/* Outcome Message Description */}
        <p className="text-xs leading-relaxed text-slate-500 font-medium text-center mb-6 px-2">
          {configs.message}
        </p>

        {/* CTA Button */}
        <button 
          onClick={onClose}
          className={`w-full py-3 rounded-lg text-xs font-semibold transition-all cursor-pointer ${configs.actionBtn}`}
        >
          Confirm & Continue
        </button>
      </div>
    </div>
  );
}
