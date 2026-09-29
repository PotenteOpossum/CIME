import { useState, useEffect, useRef, useCallback } from 'react';
import { apiRequest } from '../api/client.js';

const CheckIcon = ({ className = 'w-8 h-8' }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

const XIcon = ({ className = 'w-8 h-8' }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

// Deterministic soft gradient per card so the stack looks lively (Tinder-ish) without images.
const CARD_GRADIENTS = [
  'from-indigo-500 via-purple-500 to-fuchsia-500',
  'from-sky-500 via-blue-500 to-indigo-500',
  'from-emerald-500 via-teal-500 to-cyan-500',
  'from-amber-500 via-orange-500 to-rose-500',
  'from-rose-500 via-pink-500 to-purple-500',
  'from-violet-500 via-indigo-500 to-blue-500',
];

export default function SwipeVoteModal({ poll, onSubmit, onClose, token }) {
  const options = (poll?.options || []).filter(o => o.option_text.toLowerCase() !== 'other' && o.option_text.toLowerCase() !== 'keep discussing');
  const [currentIndex, setCurrentIndex] = useState(0);
  const [swipeX, setSwipeX] = useState(0);
  const [swipeY, setSwipeY] = useState(0);
  const [swipeDirection, setSwipeDirection] = useState(null); // 'right' or 'left'
  const [isDragging, setIsDragging] = useState(false);
  const [showAddOption, setShowAddOption] = useState(options.length === 0);
  const [newOptionText, setNewOptionText] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [swipeVotes, setSwipeVotes] = useState([]);
  const [countdown, setCountdown] = useState(null);

  useEffect(() => {
    if (!poll.expires_at) return;
    const update = () => {
      const diff = new Date(poll.expires_at).getTime() - Date.now();
      if (diff <= 0) { setCountdown('0:00'); return; }
      const m = Math.floor(diff / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      setCountdown(m + ':' + String(s).padStart(2, '0'));
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [poll.expires_at]);

  const startXRef = useRef(0);
  const startYRef = useRef(0);
  const isDraggingRef = useRef(false);

  const currentOption = options[currentIndex];
  const nextOption = options[currentIndex + 1];
  const progress = options.length > 0 ? ((currentIndex + 1) / options.length) * 100 : 0;

  // Commit the vote for the current card and fling it away, then advance.
  const processSwipe = useCallback((direction) => {
    if (!currentOption || swipeDirection) return;
    setIsDragging(false);
    isDraggingRef.current = false;
    setSwipeDirection(direction);
    setSwipeX(direction === 'right' ? 700 : -700);
    setSwipeY(-40);
    setSwipeVotes((prev) => [...prev, { optionId: currentOption.id, direction }]);

    setTimeout(() => {
      if (currentIndex < options.length - 1) {
        setCurrentIndex((prev) => prev + 1);
      } else {
        setShowAddOption(true);
      }
      setSwipeX(0);
      setSwipeY(0);
      setSwipeDirection(null);
    }, 320);
  }, [currentOption, currentIndex, options.length, swipeDirection]);

  const handlePointerDown = useCallback((e) => {
    if (swipeDirection) return;
    startXRef.current = e.clientX ?? e.touches?.[0]?.clientX ?? 0;
    startYRef.current = e.clientY ?? e.touches?.[0]?.clientY ?? 0;
    isDraggingRef.current = true;
    setIsDragging(true);
    if (e.currentTarget.setPointerCapture && e.pointerId != null) {
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* noop */ }
    }
  }, [swipeDirection]);

  const handlePointerMove = useCallback((e) => {
    if (!isDraggingRef.current) return;
    const clientX = e.clientX ?? e.touches?.[0]?.clientX ?? 0;
    const clientY = e.clientY ?? e.touches?.[0]?.clientY ?? 0;
    setSwipeX(clientX - startXRef.current);
    setSwipeY((clientY - startYRef.current) * 0.35);
  }, []);

  const handlePointerUp = useCallback(() => {
    if (!isDraggingRef.current) return;
    isDraggingRef.current = false;
    setIsDragging(false);
    const threshold = 90;
    if (swipeX > threshold) {
      processSwipe('right');
    } else if (swipeX < -threshold) {
      processSwipe('left');
    } else {
      setSwipeX(0);
      setSwipeY(0);
    }
  }, [swipeX, processSwipe]);

  // Keyboard support
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (submitted || showAddOption) return;
      if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D' || e.key === 'Enter') {
        processSwipe('right');
      } else if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') {
        processSwipe('left');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [submitted, showAddOption, processSwipe]);

  const getCompletedVotes = () => {
    const votedMap = new Map();
    swipeVotes.forEach(v => votedMap.set(v.optionId, v.direction));
    if (currentOption && swipeDirection) {
      votedMap.set(currentOption.id, swipeDirection);
    }
    return options.map(opt => ({ optionId: opt.id, direction: votedMap.get(opt.id) || 'left' }));
  };

  const postVotes = async (extra = {}) => {
    return apiRequest(`/rooms/polls/${poll.id}/vote`, {
      method: 'POST',
      body: JSON.stringify({ swipeVotes: getCompletedVotes(), ...extra }),
    }, token);
  };

  const finishVote = async (extra = {}) => {
    setSubmitError('');
    try {
      await postVotes(extra);
      setSubmitted(true);
      onSubmit?.(poll.id);
    } catch (e) {
      // Keep the poll visible when the request failed, so a transient mobile/API
      // error cannot silently turn into a zero-vote poll.
      setSubmitError(e?.message || 'Your vote could not be submitted. Please try again.');
    }
  };

  const handleSubmit = async () => finishVote();
  const handleSkip = async () => finishVote();
  const handleAddOption = async () => {
    if (!newOptionText.trim()) return;
    await finishVote({ customOptionText: newOptionText.trim() });
  };

  if (submitted) return null;

  const likeOpacity = Math.min(Math.max(swipeX / 100, 0), 1);
  const nopeOpacity = Math.min(Math.max(-swipeX / 100, 0), 1);
  const rotation = swipeX * 0.045;
  const gradient = CARD_GRADIENTS[currentIndex % CARD_GRADIENTS.length];
  const nextGradient = CARD_GRADIENTS[(currentIndex + 1) % CARD_GRADIENTS.length];

  const cardStyle = {
    transform: `translate(${swipeX}px, ${swipeY}px) rotate(${rotation}deg)`,
    transition: isDragging ? 'none' : 'transform 0.32s cubic-bezier(0.22, 1, 0.36, 1)',
  };

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
    >
      <div
        className="w-full max-w-md rounded-[2rem] bg-white p-6 shadow-2xl dark:bg-[#1c1d1f] border border-gray-100 dark:border-gray-800 relative overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="mb-4 flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">Quick vote</span>
          {countdown != null && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-50 px-3 py-1 text-sm font-bold text-blue-600 dark:bg-blue-500/10 dark:text-blue-400 tabular-nums">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              {countdown}
            </span>
          )}
        </div>

        <h2 className="mb-5 text-center text-2xl font-extrabold leading-tight text-gray-900 dark:text-gray-100">
          {poll.question}
        </h2>

        {!showAddOption && currentOption ? (
          <>
            {/* Card stack area */}
            <div className="relative mx-auto mb-6 h-72 w-full select-none">
              {/* Peeking next card */}
              {nextOption && (
                <div className={`absolute inset-0 top-3 mx-2 rounded-3xl bg-gradient-to-br ${nextGradient} opacity-40 scale-[0.94] shadow-lg`} />
              )}

              {/* Active draggable card */}
              <div
                className={`absolute inset-0 flex touch-none cursor-grab active:cursor-grabbing flex-col items-center justify-center rounded-3xl bg-gradient-to-br ${gradient} p-8 text-center shadow-xl`}
                style={cardStyle}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerUp}
                onDragStart={(e) => e.preventDefault()}
                role="button"
                tabIndex={0}
              >
                {/* LIKE / NOPE stamps */}
                <div
                  className="pointer-events-none absolute left-5 top-5 -rotate-[18deg] rounded-lg border-4 border-emerald-300 px-3 py-1 text-2xl font-black uppercase tracking-widest text-emerald-200"
                  style={{ opacity: likeOpacity }}
                >
                  Yes
                </div>
                <div
                  className="pointer-events-none absolute right-5 top-5 rotate-[18deg] rounded-lg border-4 border-rose-300 px-3 py-1 text-2xl font-black uppercase tracking-widest text-rose-200"
                  style={{ opacity: nopeOpacity }}
                >
                  No
                </div>

                <span className="px-2 text-2xl font-bold leading-snug text-white drop-shadow-sm">
                  {currentOption.option_text}
                </span>
              </div>
            </div>

            {/* Progress dots */}
            <div className="mb-4 flex items-center justify-center gap-1.5">
              {options.map((_, idx) => (
                <span
                  key={idx}
                  className={`h-1.5 rounded-full transition-all duration-300 ${
                    idx === currentIndex ? 'w-6 bg-blue-500' : idx < currentIndex ? 'w-1.5 bg-blue-300 dark:bg-blue-700' : 'w-1.5 bg-gray-200 dark:bg-gray-700'
                  }`}
                />
              ))}
            </div>
            <p className="mb-5 text-center text-xs text-gray-400">
              Option {currentIndex + 1} of {options.length} · swipe or use ← →
            </p>

            {/* Big round action buttons */}
            <div className="flex items-center justify-center gap-6">
              <button
                onClick={() => processSwipe('left')}
                className="flex h-16 w-16 items-center justify-center rounded-full border border-rose-100 bg-white text-rose-500 shadow-lg transition-all hover:scale-110 hover:border-rose-200 active:scale-95 dark:border-gray-700 dark:bg-[#282a2c]"
                aria-label="No"
              >
                <XIcon className="w-7 h-7" />
              </button>
              <button
                onClick={() => processSwipe('right')}
                className="flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-br from-emerald-400 to-green-500 text-white shadow-xl shadow-emerald-500/30 transition-all hover:scale-110 active:scale-95"
                aria-label="Yes"
              >
                <CheckIcon className="w-9 h-9" />
              </button>
            </div>

            <div className="mt-5 text-center">
              <button
                onClick={handleSkip}
                className="text-xs font-semibold text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
              >
                Skip &amp; close
              </button>
            </div>
            {submitError && (
              <p className="mt-3 text-center text-sm font-medium text-rose-600 dark:text-rose-400" role="alert">
                {submitError}
              </p>
            )}
          </>
        ) : showAddOption ? (
          <div className="text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-blue-50 text-blue-500 dark:bg-blue-500/10">
              <svg className="w-7 h-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            </div>
            <p className="mb-1 text-lg font-bold text-gray-800 dark:text-gray-200">Did we miss an option?</p>
            <p className="mb-5 text-sm text-gray-500 dark:text-gray-400">
              Add a new option that will appear in the next round.
            </p>
            <input
              type="text"
              value={newOptionText}
              onChange={(e) => setNewOptionText(e.target.value)}
              placeholder="Type your option here..."
              className="mb-5 w-full rounded-2xl border border-gray-200 bg-gray-50 px-5 py-3 text-sm dark:border-gray-700 dark:bg-[#282a2c] dark:text-gray-100 outline-none focus:ring-2 focus:ring-blue-500/50"
              onKeyDown={(e) => e.key === 'Enter' && handleAddOption()}
            />
            <div className="flex gap-3">
              <button
                onClick={handleSubmit}
                className="flex-1 rounded-full bg-gray-100 py-3 text-sm font-semibold text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
              >
                Skip — done
              </button>
              <button
                onClick={handleAddOption}
                disabled={!newOptionText.trim()}
                className="flex-1 rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 py-3 text-sm font-semibold text-white shadow-lg shadow-blue-500/25 hover:brightness-110 disabled:opacity-40 disabled:shadow-none"
              >
                Add &amp; continue
              </button>
            </div>
            {submitError && (
              <p className="mt-3 text-sm font-medium text-rose-600 dark:text-rose-400" role="alert">
                {submitError}
              </p>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
