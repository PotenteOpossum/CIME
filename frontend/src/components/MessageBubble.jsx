import { useState, useEffect } from 'react';

export default function MessageBubble({ message, currentUserId, onViewSummary, onReopenTopic, onAgree, convergenceStatus, locallyReopened, locallyAgreed, onAcceptLiveProposal, livePollIds = [] }) {
  const [acceptingProposal, setAcceptingProposal] = useState(false);
  const [proposalError, setProposalError] = useState('');
  let liveProposal = null;
  let visibleText = message.text;
  if (message.is_bot) {
    const marker = '[LiveVoteProposal=';
    const at = message.text.lastIndexOf(marker);
    if (at >= 0 && message.text.endsWith(']')) {
      try {
        const parsed = JSON.parse(message.text.slice(at + marker.length, -1));
        if (Number.isInteger(parsed.pollId) && typeof parsed.optionText === 'string') {
          liveProposal = parsed;
          visibleText = message.text.slice(0, at).trim();
        }
      } catch { /* Keep malformed historical messages visible. */ }
    }
  }
  const isMine = message.sender_id === currentUserId;
  const isBot = !!message.is_bot;

  const alignment = isMine ? 'items-end' : 'items-start';
  const isHighlighted = isBot && (message.text.includes('mandatory poll has been created') || message.text.includes('voting closes in') || message.text.includes('Voting closes in'));

  const bubbleClass = isHighlighted
    ? 'bg-amber-100 text-amber-900 shadow-sm dark:bg-amber-500/10 dark:text-amber-100'
    : isBot
      ? 'bg-transparent text-gray-900 dark:text-gray-100 border-none px-0'
      : isMine
        ? 'bg-gray-100 text-gray-900 dark:bg-[#333538] dark:text-gray-100 rounded-3xl rounded-tr-sm'
        : 'bg-white text-gray-900 border border-gray-200 shadow-sm dark:bg-[#2d2924] dark:text-gray-100 dark:border-none rounded-3xl rounded-tl-sm';

  const containsViewSummary = isBot && message.text.includes('[View Summary]');
  const isConvergenceSummary = isBot && message.text.startsWith('[ConvergenceSummary=');

  // Local 1-second ticker so the review countdown animates smoothly between server polls.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isConvergenceSummary) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isConvergenceSummary]);

  const renderText = (text) => {
    if (!text) return null;
    const cleanText = text.replace('[View Summary]', '').trim();
    return cleanText.split(/(\*\*.*?\*\*)/g).map((part, index) => {
      if (part.startsWith('**') && part.endsWith('**')) {
        return <strong key={index}>{part.slice(2, -2)}</strong>;
      }
      return <span key={index}>{part}</span>;
    });
  };

  const renderConvergenceSummary = (text) => {
    try {
      const jsonStr = text.substring('[ConvergenceSummary='.length, text.length - 1);
      const data = JSON.parse(jsonStr);
      if (!data.topics || !Array.isArray(data.topics)) return null;

      // The backend is the source of truth for the configured review duration. Do not derive a
      // fallback from the message timestamp: that used to hardcode a 60-second window and could
      // close a 3-minute review card in the browser while the server was still waiting.
      const hasServerStatus = convergenceStatus && Number.isFinite(Number(convergenceStatus.secondsRemaining));
      const serverRemaining = hasServerStatus ? Math.max(0, Number(convergenceStatus.secondsRemaining)) : null;
      const receivedAt = hasServerStatus && Number.isFinite(Number(convergenceStatus.receivedAt))
        ? Number(convergenceStatus.receivedAt)
        : now;
      const localElapsed = hasServerStatus ? Math.floor(Math.max(0, now - receivedAt) / 1000) : 0;
      const secondsRemaining = hasServerStatus ? Math.max(0, serverRemaining - localElapsed) : null;
      const finalized = hasServerStatus && (!!convergenceStatus.finalized || secondsRemaining === 0);
      const serverReopened = new Set(convergenceStatus?.reopenedKeys || []);
      const youReopened = locallyReopened || new Set();
      const interactive = hasServerStatus && !finalized;

      const mmss = secondsRemaining === null
        ? 'Loading...'
        : `${Math.floor(secondsRemaining / 60)}:${String(secondsRemaining % 60).padStart(2, '0')}`;

      return (
        <div className="w-full flex flex-col gap-4">
          <div className="mb-2">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <h3 className="text-lg font-bold text-gray-800 dark:text-gray-200">Convergence Summary</h3>
              {interactive ? (
                <span className="inline-flex items-center gap-2 rounded-full bg-amber-100 px-3 py-1 text-sm font-semibold text-amber-700 dark:bg-amber-500/15 dark:text-amber-300 tabular-nums">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                  {mmss} to review
                </span>
              ) : (
                <span className="inline-flex items-center gap-2 rounded-full bg-gray-100 px-3 py-1 text-sm font-medium text-gray-500 dark:bg-gray-700/40 dark:text-gray-400">
                  Review closed
                </span>
              )}
            </div>
            <p className="text-sm text-gray-600 dark:text-gray-400 mt-1 mb-4">
              {!hasServerStatus
                ? 'Loading the review timer...'
                : interactive
                  ? 'Read what the previous rooms decided. If you disagree with an agreed solution, click its "reopen!" button to reopen it for a new vote.'
                  : 'The review window has closed. Reopened points will be discussed and voted in this room.'}
            </p>

            {data.generalResults && data.generalResults.length > 0 && (
              <div className="mb-6 rounded-xl border-2 border-indigo-100 bg-indigo-50/50 p-4 dark:border-indigo-900/30 dark:bg-indigo-900/10">
                <h4 className="font-semibold text-indigo-900 dark:text-indigo-200 mb-3 flex items-center gap-2">
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg>
                  Final General Question Results
                </h4>
                <div className="flex flex-col gap-2">
                  {data.generalResults.map((result, idx) => (
                    <div key={idx} className="flex justify-between items-center rounded-lg border border-indigo-100 bg-white p-3 text-sm shadow-sm dark:border-indigo-800 dark:bg-[#1c1a17]">
                      <span className="font-semibold text-indigo-700 dark:text-indigo-300">{result.roomName}</span>
                      <span className="text-gray-700 dark:text-gray-300 font-medium">{result.decision}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <h4 className="font-semibold text-gray-800 dark:text-gray-200 mb-2">Topic Resolutions</h4>
          </div>
          {data.topics.map((topic, i) => {
            // During the window only the local user's own reopen is visible to them; other
            // participants' reopens are revealed after it closes (via serverReopened).
            const wasReopened = interactive ? youReopened.has(topic.key) : (serverReopened.has(topic.key) || youReopened.has(topic.key));
            return (
              <div key={i} className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-[#1c1a17] flex gap-3 items-start justify-between">
                <div>
                  <h4 className="font-semibold text-gray-800 dark:text-gray-200 mb-1">{topic.question}</h4>
                  {topic.status === 'agreed' ? (
                    <p className="text-sm text-emerald-600 dark:text-emerald-400 font-medium">
                      Solution: <span className="text-gray-700 dark:text-gray-300 font-normal">{topic.solution}</span>
                    </p>
                  ) : (
                    <div className="text-sm">
                      <span className="text-amber-600 dark:text-amber-400 font-medium">{topic.status === 'open' ? 'This topic still needs discussion and voting:' : `This topic is still open between ${topic.options?.length || 0} options:`}</span>
                      <ul className="mt-1 list-disc pl-5 text-gray-600 dark:text-gray-400">
                        {topic.options?.map((opt, j) => <li key={j}>{opt}</li>)}
                      </ul>
                    </div>
                  )}
                </div>
                {topic.status === 'agreed' && (
                  <div className="shrink-0">
                    {interactive ? (
                      onReopenTopic && (
                        <button
                          onClick={() => onReopenTopic(topic.key)}
                          className={`flex h-9 items-center justify-center rounded-full px-4 text-sm font-bold transition-colors ${
                            wasReopened
                              ? 'bg-amber-500 text-white shadow-sm'
                              : 'bg-amber-100 text-amber-600 hover:bg-amber-200 hover:text-amber-700 dark:bg-amber-500/20 dark:text-amber-400 dark:hover:bg-amber-500/30'
                          }`}
                          title={wasReopened ? "You flagged this to be reopened" : "I disagree — flag this to be reopened"}
                        >
                          {wasReopened ? 'reopened!' : 'reopen!'}
                        </button>
                      )
                    ) : wasReopened ? (
                      <span className="inline-flex items-center rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
                        reopened
                      </span>
                    ) : null}
                  </div>
                )}
              </div>
            );
          })}

          {/* Agreement / "I agree" control */}
          {(() => {
            const youAgreed = !!(convergenceStatus?.youAgreed || locallyAgreed);
            const agreedCount = convergenceStatus?.agreedCount ?? (youAgreed ? 1 : 0);
            const memberCount = convergenceStatus?.memberCount ?? 0;
            return (
              <div className="mt-2 flex flex-col items-center gap-2 border-t border-gray-100 pt-4 dark:border-gray-800">
                {interactive ? (
                  youAgreed ? (
                    <div className="inline-flex items-center gap-2 rounded-full bg-emerald-50 px-4 py-2 text-sm font-semibold text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                      You agreed — waiting for others
                    </div>
                  ) : (
                    onAgree && (
                      <button
                        onClick={onAgree}
                        className="inline-flex items-center gap-2 rounded-full bg-gradient-to-br from-emerald-400 to-green-500 px-6 py-2.5 text-sm font-bold text-white shadow-lg shadow-emerald-500/25 transition-all hover:brightness-110 active:scale-95"
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                        I agree
                      </button>
                    )
                  )
                ) : null}
                {memberCount > 0 && (
                  <p className="text-xs text-gray-400 dark:text-gray-500">{agreedCount} of {memberCount} participants agreed</p>
                )}
              </div>
            );
          })()}
        </div>
      );
    } catch (e) {
      console.error("Failed to parse convergence summary", e);
      return <span className="text-red-500">Failed to render convergence summary.</span>;
    }
  };

  return (
    <div className={`flex flex-col ${alignment}`}>
      <div className="mb-2 text-sm text-gray-500 dark:text-gray-400 flex items-center gap-2">
        {isBot ? <span className="text-blue-500 dark:text-blue-400">✨</span> : null}
        <span className="font-medium text-gray-800 dark:text-gray-200">{isMine ? 'You' : message.sender_name}</span>
        <span className="opacity-75 text-xs">· {new Date(message.timestamp).toLocaleTimeString()}</span>
      </div>
      <div className={`max-w-[85%] rounded-3xl px-5 py-3 text-base leading-relaxed whitespace-pre-wrap ${bubbleClass} ${isConvergenceSummary ? '!max-w-full' : ''}`}>
        {isConvergenceSummary ? renderConvergenceSummary(message.text) : renderText(visibleText)}
        {liveProposal && onAcceptLiveProposal && (
          <div className="mt-3">
            <button className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
              disabled={acceptingProposal || !livePollIds.includes(liveProposal.pollId)}
              onClick={async () => {
                setAcceptingProposal(true); setProposalError('');
                try { await onAcceptLiveProposal(liveProposal.pollId, message.id); }
                catch (error) { setProposalError(error.message || 'The option could not be added.'); }
                finally { setAcceptingProposal(false); }
              }}>
              {acceptingProposal ? 'Adding your vote…' : livePollIds.includes(liveProposal.pollId) ? 'Add and vote this option' : 'Voting is closed'}
            </button>
            {proposalError && <p role="alert" className="mt-2 text-sm text-red-600">{proposalError}</p>}
          </div>
        )}
        {containsViewSummary && onViewSummary && (
          <div className="mt-3">
            <button
              onClick={onViewSummary}
              className="flex items-center gap-2 rounded-full border border-gray-200 bg-gray-50 px-4 py-2 text-sm font-medium text-gray-700 transition-all hover:bg-gray-100 dark:border-gray-800 dark:bg-[#1c1a17] dark:text-gray-200 dark:hover:bg-[#2d2924]"
              title="View Room Summary"
            >
              <span>📊 View Summary</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
