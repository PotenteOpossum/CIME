import { useEffect, useRef, useState } from 'react';

/**
 * PollSummaryModal - Shows a summary of poll results with consensus analysis
 * Used for both discussion groups and convergence rounds
 */
export default function PollSummaryModal({ poll, onClose, canDismiss = true }) {
  const [canProceed, setCanProceed] = useState(false);
  const scrollRef = useRef(null);

  const checkScroll = () => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    if (scrollTop + clientHeight >= scrollHeight - 15 || scrollHeight <= clientHeight + 10) {
      setCanProceed(true);
    }
  };

  useEffect(() => {
    setCanProceed(false);
    const timer = setTimeout(checkScroll, 100);
    return () => clearTimeout(timer);
  }, [poll]);

  if (!poll) return null;

  // Calculate vote statistics
  const totalVotes = poll.options?.reduce((sum, opt) => sum + (opt.votes || 0), 0) || 0;
  const totalMembers = poll.total_members || 1;
  const participationRate = totalMembers > 0 ? Math.round((totalVotes / totalMembers) * 100) : 0;

  // Sort options by votes
  const sortedOptions = [...(poll.options || [])].sort((a, b) => (b.votes || 0) - (a.votes || 0));

  // Determine which options to show based on thresholds
  const getOptionsToShow = () => {
    if (sortedOptions.length === 0) return [];
    
    const top2 = sortedOptions.slice(0, 2);
    const top3 = sortedOptions.slice(0, 3);
    
    // Calculate percentages
    const top2Percentage = top2.reduce((sum, opt) => {
      const pct = totalMembers > 0 ? (opt.votes || 0) / totalMembers : 0;
      return sum + pct;
    }, 0);
    
    // If top 2 options have less than 50% combined, show top 3
    if (top2Percentage < 0.5 && sortedOptions.length >= 3) {
      return top3;
    }
    
    // Always show at least top 2
    return top2;
  };

  const optionsToShow = getOptionsToShow();
  const topOption = sortedOptions[0];
  const topPercentage = totalMembers > 0 ? Math.round(((topOption?.votes || 0) / totalMembers) * 100) : 0;

  // Determine consensus level
  const getConsensusAnalysis = () => {
    if (!topOption || totalMembers === 0) {
      return {
        level: 'none',
        message: 'No clear consensus was reached.',
        color: 'text-slate-600 dark:text-slate-400'
      };
    }

    if (topPercentage >= 90) {
      return {
        level: 'strong',
        message: `Strong consensus: ${topPercentage}% of participants support "${topOption.option_text}".`,
        color: 'text-emerald-700 dark:text-emerald-400'
      };
    } else if (topPercentage >= 75) {
      return {
        level: 'clear',
        message: `Clear majority: ${topPercentage}% of participants prefer "${topOption.option_text}".`,
        color: 'text-green-700 dark:text-green-400'
      };
    } else if (topPercentage >= 60) {
      return {
        level: 'moderate',
        message: `Moderate consensus: ${topPercentage}% lean towards "${topOption.option_text}", though other options also have support.`,
        color: 'text-blue-700 dark:text-blue-400'
      };
    } else if (topPercentage >= 50) {
      return {
        level: 'weak',
        message: `Slight preference: ${topPercentage}% favor "${topOption.option_text}", but the group is somewhat divided.`,
        color: 'text-amber-700 dark:text-amber-400'
      };
    } else {
      return {
        level: 'divided',
        message: `The group is divided: The top option "${topOption.option_text}" received ${topPercentage}%, indicating no clear majority.`,
        color: 'text-orange-700 dark:text-orange-400'
      };
    }
  };

  const consensus = getConsensusAnalysis();

  // Check if top options are compatible
  const getCompatibilityAnalysis = () => {
    if (optionsToShow.length < 2) return null;

    const option1 = optionsToShow[0];
    const option2 = optionsToShow[1];
    const pct1 = totalMembers > 0 ? Math.round(((option1?.votes || 0) / totalMembers) * 100) : 0;
    const pct2 = totalMembers > 0 ? Math.round(((option2?.votes || 0) / totalMembers) * 100) : 0;

    // If both options have significant support (>30%), suggest they might be compatible
    if (pct1 >= 30 && pct2 >= 30) {
      return {
        compatible: true,
        message: `Both "${option1.option_text}" (${pct1}%) and "${option2.option_text}" (${pct2}%) have significant support. These options may be feasible to implement together if they are not mutually exclusive.`
      };
    }

    return null;
  };

  const compatibility = getCompatibilityAnalysis();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-fade-in">
      <div className="w-full max-w-2xl rounded-3xl bg-white p-8 shadow-xl dark:bg-[#1e1f20] border border-gray-200 dark:border-gray-800 flex flex-col max-h-[85vh] transition-colors duration-300">
        <div className="flex items-center gap-3 mb-6 border-b border-gray-200 dark:border-gray-800 pb-4 shrink-0">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-100 text-blue-600 dark:bg-blue-900/50 dark:text-blue-400">
            📊
          </span>
          <div>
            <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Poll Results</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Summary of voting on this topic
            </p>
          </div>
        </div>

        <div ref={scrollRef} onScroll={checkScroll} className="flex-1 overflow-y-auto pr-2 mb-6 space-y-4">
          {/* Question */}
          <div className="rounded-3xl border border-gray-200 bg-gray-50/50 p-5 dark:border-gray-700 dark:bg-[#282a2c]/50">
            <p className="text-sm font-semibold text-blue-600 dark:text-blue-400 uppercase tracking-wider mb-2">
              Question
            </p>
            <p className="text-base font-medium text-gray-800 dark:text-gray-200">
              {poll.question}
            </p>
          </div>

          {/* Consensus Analysis */}
          <div className="rounded-3xl border border-gray-200 bg-gray-50/50 p-5 dark:border-gray-700 dark:bg-[#282a2c]/50">
            <p className="text-sm font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wider mb-2">
              Consensus Analysis
            </p>
            <p className={`text-sm leading-relaxed ${consensus.color} font-medium`}>
              {consensus.message}
            </p>
            <div className="mt-3 flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
              <span>Participation: {participationRate}% ({totalVotes}/{totalMembers} members voted)</span>
            </div>
          </div>

          {/* Top Options */}
          <div className="rounded-3xl border border-gray-200 bg-gray-50/50 p-5 dark:border-gray-700 dark:bg-[#282a2c]/50">
            <p className="text-sm font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wider mb-3">
              {optionsToShow.length > 2 ? 'Top 3 Options' : 'Top Options'}
            </p>
            <div className="space-y-2">
              {optionsToShow.map((opt, idx) => {
                const pct = totalMembers > 0 ? Math.round(((opt.votes || 0) / totalMembers) * 100) : 0;
                const isWinner = idx === 0;
                const barColor = isWinner
                  ? 'bg-emerald-500'
                  : pct > 50
                    ? 'bg-indigo-500'
                    : 'bg-slate-400';
                
                return (
                  <div key={idx} className="flex items-center gap-2">
                    <span className={`w-6 text-sm ${isWinner ? 'text-emerald-600 dark:text-emerald-400 font-bold' : 'text-slate-500'}`}>
                      {isWinner ? '🏆' : `${idx + 1}.`}
                    </span>
                    <span className={`flex-1 truncate text-sm ${isWinner ? 'font-semibold text-slate-900 dark:text-slate-100' : 'text-slate-700 dark:text-slate-300'}`}>
                      {opt.option_text}
                    </span>
                    <span className={`w-16 text-right text-xs font-mono ${isWinner ? 'text-emerald-600 dark:text-emerald-400 font-bold' : 'text-slate-500'}`}>
                      {opt.votes || 0} votes
                    </span>
                    <span className="w-12 text-right text-xs text-slate-400">
                      {pct}%
                    </span>
                    <div className="h-2 flex-1 min-w-[60px] rounded-full bg-slate-200 dark:bg-slate-700">
                      <div
                        className={`h-2 rounded-full ${barColor} transition-all duration-500`}
                        style={{ width: `${Math.max(pct, 2)}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Compatibility Analysis */}
          {compatibility && (
            <div className="rounded-xl border border-emerald-100 bg-emerald-50/50 p-4 dark:border-emerald-900/30 dark:bg-emerald-950/20">
              <div className="flex items-start gap-2">
                <span className="text-lg">✅</span>
                <div>
                  <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-400 mb-1">
                    Potential for Combined Implementation
                  </p>
                  <p className="text-sm text-emerald-700 dark:text-emerald-400 leading-relaxed">
                    {compatibility.message}
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Additional Context */}
          <div className="rounded-3xl border border-gray-200 bg-gray-50/50 p-5 dark:border-gray-700 dark:bg-[#282a2c]/50">
            <p className="text-sm font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wider mb-2">
              Summary
            </p>
            <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
              {poll.poll_type === 'ranking' 
                ? 'Results based on ranked-choice voting using Borda count scoring.'
                : poll.poll_type === 'swipe'
                ? 'Results based on swipe voting (right swipes counted as approval).'
                : 'Results based on plurality voting.'}
              {' '}The group has {consensus.level === 'strong' || consensus.level === 'clear' ? 'reached a decision' : 'expressed their preferences'} on this topic.
            </p>
          </div>
        </div>

        <div className="flex justify-end pt-4 border-t border-gray-200 dark:border-gray-800 shrink-0">
          {canDismiss ? (
            <button
              onClick={onClose}
              disabled={!canProceed}
              className="rounded-full bg-blue-600 px-8 py-3 text-white font-medium shadow-sm hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-400 transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Continue
            </button>
          ) : (
            <button
              onClick={onClose}
              disabled={!canProceed}
              className="rounded-full bg-blue-600 px-8 py-3 text-white font-medium shadow-sm hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-400 transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Finish
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
