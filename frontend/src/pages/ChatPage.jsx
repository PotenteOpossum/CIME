import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { io } from 'socket.io-client';
import { apiRequest } from '../api/client.js';
import { useAuth } from '../contexts/AuthContext.jsx';
import MessageBubble from '../components/MessageBubble.jsx';
import cimeLogo from '../img/CIME_LOGO.png';
import SwipeVoteModal from '../components/SwipeVoteModal.jsx';
import PollSummaryModal from '../components/PollSummaryModal.jsx';
import RecapModal from '../components/RecapModal.jsx';

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:4000';

const MonitorIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>;
const DashboardIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>;

export default function ChatPage() {
  const { roomId } = useParams();
  const navigate = useNavigate();
  const numericRoomId = Number(roomId);
  const { token, user, logout } = useAuth();

  const [messages, setMessages] = useState([]);
  const [polls, setPolls] = useState([]);
  const [activeSwipePoll, setActiveSwipePoll] = useState(null);
  const [rankingState, setRankingState] = useState({});
  const [exitModalOpen, setExitModalOpen] = useState(false);
  const [tempSelections, setTempSelections] = useState({});
  const [tempCustomTexts, setTempCustomTexts] = useState({});
  const prevMyVotesRef = useRef({});
  const [highlightedPollId, setHighlightedPollId] = useState(null);
  const prevPollIdsRef = useRef(null);
  const [countdownVal, setCountdownVal] = useState(null);
  const isExcludedRef = useRef(false);
  const [roomStatus, setRoomStatus] = useState(null);
  const [convergenceStatus, setConvergenceStatus] = useState(null);
  const [locallyReopened, setLocallyReopened] = useState(() => new Set());
  const [locallyAgreed, setLocallyAgreed] = useState(false);
  const [text, setText] = useState('');
  const [editMessageId, setEditMessageId] = useState(null);
  const [editText, setEditText] = useState('');
  const [error, setError] = useState('');
  const [room, setRoom] = useState(() => {
    try {
      const saved = sessionStorage.getItem(`cime_room_cache_${roomId}`);
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });
  const [nowMs, setNowMs] = useState(Date.now());
  const [availableRooms, setAvailableRooms] = useState(() => {
    try {
      const saved = sessionStorage.getItem('cime_available_rooms_cache');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });
  const [pollSummaryData, setPollSummaryData] = useState(null);
  const [showRecapModal, setShowRecapModal] = useState(false);
  const [recapReport, setRecapReport] = useState('');
  const [inactivityWarning, setInactivityWarning] = useState(false);
  const [inactivitySeconds, setInactivitySeconds] = useState(60);
  const hasAutoOpenedRef = useRef(false);
  const summaryAutoOpenRef = useRef(false);
  const displayedRoomRef = useRef(null);
  const [showMobileRoomStatus, setShowMobileRoomStatus] = useState(false);
  const [showMobilePolls, setShowMobilePolls] = useState(false);
  const [showScrollButton, setShowScrollButton] = useState(false);

  // Mobile browsers (esp. iOS Safari) resize the *visual* viewport (not the layout viewport)
  // when the address bar collapses or the on-screen keyboard opens, and the CSS `dvh` unit does
  // not reliably recompute at those moments — this is what caused the page to show blank space
  // at the bottom on first load, and again whenever the keyboard opened while typing. Tracking
  // `visualViewport` directly in JS and sizing the shell in pixels sidesteps that engine bug.
  const [viewportHeight, setViewportHeight] = useState(() => (
    typeof window !== 'undefined' ? (window.visualViewport?.height || window.innerHeight) : 0
  ));

  useEffect(() => {
    const updateHeight = () => {
      setViewportHeight(window.visualViewport?.height || window.innerHeight);
    };
    updateHeight();
    const vv = window.visualViewport;
    if (vv) {
      vv.addEventListener('resize', updateHeight);
      vv.addEventListener('scroll', updateHeight);
    }
    window.addEventListener('resize', updateHeight);
    window.addEventListener('orientationchange', updateHeight);

    // Prevent the outer page from scrolling/bouncing behind the fixed-height chat shell —
    // all scrolling happens in the inner message list and poll panels instead.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      if (vv) {
        vv.removeEventListener('resize', updateHeight);
        vv.removeEventListener('scroll', updateHeight);
      }
      window.removeEventListener('resize', updateHeight);
      window.removeEventListener('orientationchange', updateHeight);
      document.body.style.overflow = prevOverflow;
    };
  }, []);

  const fetchRecapReport = async () => {
    try {
      const data = await apiRequest(`/rooms/${numericRoomId}/recap`, {}, token);
      if (data && data.report) {
        setRecapReport(data.report);
        return data.report;
      }
    } catch (err) {
      console.error('Failed to fetch recap report:', err);
    }
    return null;
  };

  const openRecapWhenReady = async (attempt = 0) => {
    const report = await fetchRecapReport();
    if (report) {
      setShowRecapModal(true);
      return true;
    }
    if (attempt < 6) {
      setTimeout(() => {
        openRecapWhenReady(attempt + 1);
      }, 1200);
    }
    return false;
  };

  const bottomRef = useRef(null);
  const messageListRef = useRef(null);

  // Scroll ONLY the inner message list to its bottom — never the page. Using
  // element.scrollIntoView() here caused mobile browsers to scroll the whole document / visual
  // viewport when the keyboard was open, which dragged the fixed chat shell (and its header) out
  // of view and left a blank strip. Setting scrollTop on the list container keeps the shell fixed.
  const scrollListToBottom = (smooth = true) => {
    const el = messageListRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  };
  const socketRef = useRef(null);
  const textareaRef = useRef(null);
  const MAX_INPUT_HEIGHT = 160; // px, roughly 6 lines before the textarea starts scrolling internally

  // Auto-grow the message box as the user types (like WhatsApp/this chat), capped at a max
  // height so a long paste doesn't take over the screen — it scrolls internally past that.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const needed = el.scrollHeight;
    el.style.height = `${Math.min(needed, MAX_INPUT_HEIGHT)}px`;
    // Only show the scrollbar once the content actually exceeds the max height; otherwise keep it
    // hidden so a single line of text never renders a scrollbar/track.
    el.style.overflowY = needed > MAX_INPUT_HEIGHT ? 'auto' : 'hidden';
  }, [text]);

  // When the active room changes (e.g. the user is redirected to the next room), dismiss the
  // mobile keyboard by blurring whatever input was focused.
  useEffect(() => {
    textareaRef.current?.blur();
    if (typeof document !== 'undefined' && document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
  }, [numericRoomId]);

  const isValidRoomId = useMemo(() => Number.isInteger(numericRoomId), [numericRoomId]);

  const loadMessages = async () => {
    const data = await apiRequest(`/rooms/${numericRoomId}/messages`, {}, token);
    setMessages(data.messages || []);
    if (data.room) {
      setRoom(data.room);
      try {
        sessionStorage.setItem(`cime_room_cache_${roomId}`, JSON.stringify(data.room));
      } catch {
        // Ignore storage quota / privacy mode failures.
      }
    }
  };

  const loadPolls = async () => {
    const data = await apiRequest(`/rooms/${numericRoomId}/polls`, {}, token);
    setPolls(data.polls || []);
  };

  useEffect(() => {
    setRankingState((prev) => {
      const next = { ...prev };
      polls.forEach((p) => {
        if (p.poll_type === 'ranking' && !next[p.id]) {
          if (p.my_ranked_options && p.my_ranked_options.length > 0) {
            next[p.id] = p.my_ranked_options;
          } else {
            next[p.id] = p.options.map((o) => o.id);
          }
        }
      });
      return next;
    });
  }, [polls]);

  useEffect(() => {
    setTempSelections((prev) => {
      const next = { ...prev };
      polls.forEach((p) => {
        if (p.poll_type === 'plurality' || p.poll_type === 'continuous' || p.poll_stage === 'continuous') {
          const key = p.id;
          const currentBackendVal = p.my_vote_option_ids || [];
          const prevBackendVal = prevMyVotesRef.current[key];
          
          if (
            next[key] === undefined || 
            prevBackendVal === undefined || 
            JSON.stringify(currentBackendVal) !== JSON.stringify(prevBackendVal)
          ) {
            next[key] = currentBackendVal;
          }
        }
      });
      return next;
    });

    setTempCustomTexts((prev) => {
      const next = { ...prev };
      polls.forEach((p) => {
        if (p.poll_type === 'plurality' || p.poll_type === 'continuous' || p.poll_stage === 'continuous') {
          const key = p.id;
          const currentBackendText = p.my_vote_custom_text || '';
          const prevBackendText = prevMyVotesRef.current[`${key}-text`];

          if (
            next[key] === undefined || 
            prevBackendText === undefined || 
            currentBackendText !== prevBackendText
          ) {
            next[key] = currentBackendText;
          }
        }
      });
      return next;
    });

    const nextRef = {};
    polls.forEach((p) => {
      if (p.poll_type === 'plurality' || p.poll_type === 'continuous' || p.poll_stage === 'continuous') {
        nextRef[p.id] = p.my_vote_option_ids || [];
        nextRef[`${p.id}-text`] = p.my_vote_custom_text || '';
      }
    });
    prevMyVotesRef.current = nextRef;
  }, [polls]);

  useEffect(() => {
    if (polls.length === 0) return;

    if (prevPollIdsRef.current === null) {
      prevPollIdsRef.current = new Set(polls.map((p) => p.id));
      // Check for swipe polls on initial load - look for ANY open swipe poll that the user has not voted on yet
      const swipePolls = polls.filter((p) => p.poll_type === 'swipe' && !pollIsClosed(p) && !p.has_voted);
      if (swipePolls.length > 0) {
        const swipePoll = swipePolls[0];
        setActiveSwipePoll(swipePoll);
        setHighlightedPollId(swipePoll.id);
      }
      return;
    }

    const newOpenPoll = polls.find((p) => !pollIsClosed(p) && !prevPollIdsRef.current.has(p.id));
    if (newOpenPoll) {
      setHighlightedPollId(newOpenPoll.id);
      // Auto-open swipe polls in a modal if user has not voted on it yet
      if (newOpenPoll.poll_type === 'swipe' && !newOpenPoll.has_voted) {
        setActiveSwipePoll(newOpenPoll);
      }
    }

    prevPollIdsRef.current = new Set(polls.map((p) => p.id));
  }, [polls]);

  useEffect(() => {
    if (!activeSwipePoll) return;
    const latestPoll = polls.find((poll) => poll.id === activeSwipePoll.id);
    if (!latestPoll || pollIsClosed(latestPoll)) {
      setActiveSwipePoll(null);
      return;
    }
    if (latestPoll !== activeSwipePoll) {
      setActiveSwipePoll(latestPoll);
    }
  }, [activeSwipePoll, polls, nowMs]);

  useEffect(() => {
    if (highlightedPollId) {
      const timer = setTimeout(() => {
        setHighlightedPollId(null);
      }, 1000);
      return () => clearTimeout(timer);
    }
  }, [highlightedPollId]);

  const loadAvailableRooms = async () => {
    try {
      const data = await apiRequest('/rooms', {}, token);
      const nextRooms = data.rooms || [];
      // Always replace the list after a successful response, including an empty
      // list. Keeping an old cache here can make the client believe that no new
      // group exists after the personal phase has completed.
      setAvailableRooms(nextRooms);
      try {
        sessionStorage.setItem('cime_available_rooms_cache', JSON.stringify(nextRooms));
      } catch {
        // Ignore storage quota / privacy mode failures.
      }
    } catch (err) {
      console.error('Failed to load available rooms:', err);
    }
  };

  const loadRoomStatus = async () => {
    try {
      const data = await apiRequest(`/rooms/${numericRoomId}/status`, {}, token);
      
      if (data.kicked) {
        alert("You have been removed from the discussion room due to inactivity.");
        navigate('/dashboard');
        return;
      }

      setRoomStatus(data.status || null);

      if (data.warning) {
        setInactivityWarning(true);
        setInactivitySeconds(data.remaining_seconds);
      } else {
        setInactivityWarning(false);
      }
    } catch (err) {
      console.error('Failed to load room status:', err);
    }
  };

  const loadRoomData = async () => {
    const results = await Promise.allSettled([
      loadMessages(),
      loadPolls(),
      loadAvailableRooms(),
      loadRoomStatus()
    ]);

    const primaryFailure = results.find((result) => result.status === 'rejected');
    if (primaryFailure && results.every((result) => result.status === 'rejected')) {
      throw primaryFailure.reason;
    }
  };

  const activeNextRoom = useMemo(() => {
    const candidates = availableRooms.filter((r) => r.is_active && r.id !== numericRoomId && r.room_type !== 'personal');
    // Prefer the convergence room so a stale group room never wins the redirect.
    return candidates.find((r) => r.room_type === 'convergence') || candidates[0];
  }, [availableRooms, numericRoomId]);

  const displayedRoom = useMemo(() => {
    const fallbackRoom = availableRooms.find((r) => r.id === numericRoomId) || null;
    if (!room) return fallbackRoom;
    if (!fallbackRoom) return room;
    return { ...fallbackRoom, ...room };
  }, [availableRooms, numericRoomId, room]);

  useEffect(() => {
    displayedRoomRef.current = displayedRoom;
  }, [displayedRoom]);

  // The user should be pulled into the next active room (e.g. the convergence room) whenever
  // this room is finished OR they are no longer a member of it (membership moved to the new
  // room). Relying only on collection_complete missed users whose group room was deactivated
  // and replaced by the convergence room before their local room state updated.
  const noLongerMemberOfCurrent = useMemo(
    () => availableRooms.length > 0 && !availableRooms.some((r) => r.id === numericRoomId),
    [availableRooms, numericRoomId]
  );

  useEffect(() => {
    if (user?.is_admin === 1) {
      setCountdownVal(null);
      return;
    }
    const shouldMove = activeNextRoom && (
      displayedRoom?.collection_complete ||
      displayedRoom?.is_active === false ||
      noLongerMemberOfCurrent
    );
    if (shouldMove) {
      setCountdownVal((prev) => (prev === null ? 5 : prev));
    } else {
      setCountdownVal(null);
    }
  }, [displayedRoom?.collection_complete, displayedRoom?.is_active, noLongerMemberOfCurrent, activeNextRoom?.id, user?.is_admin]);

  useEffect(() => {
    if (countdownVal === null) return;
    if (countdownVal === 0) {
      if (activeNextRoom) {
        navigate(`/chat/${activeNextRoom.id}`);
      }
      setCountdownVal(null);
      return;
    }
    const timer = setTimeout(() => {
      setCountdownVal((prev) => (prev !== null ? prev - 1 : null));
    }, 1000);
    return () => clearTimeout(timer);
  }, [countdownVal, activeNextRoom]);

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!isValidRoomId) {
      setError('Invalid room id');
      return;
    }

    setMessages([]);
    setPolls([]);
    try {
      const saved = sessionStorage.getItem(`cime_room_cache_${roomId}`);
      setRoom(saved ? JSON.parse(saved) : null);
    } catch {
      setRoom(null);
    }
    prevPollIdsRef.current = null;
    hasAutoOpenedRef.current = false;
    summaryAutoOpenRef.current = false;
    setShowRecapModal(false);

    loadRoomData().catch((err) => {
      if (err.message.includes('Access denied')) {
        navigate('/dashboard');
      } else {
        setError(err.message);
      }
    });
  }, [isValidRoomId, numericRoomId, token]);


  useEffect(() => {
    if (!isValidRoomId) return undefined;

    const socket = io(SOCKET_URL, {
      auth: { token },
      transports: ['websocket', 'polling']
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      socket.emit('join_room', { roomId: numericRoomId });
      loadPolls().catch(() => {});
    });

    socket.on('receive_message', (message) => {
      if (message.room_id === numericRoomId) {
        setMessages((prev) => [...prev, message]);
      }
    });

    socket.on('polls_updated', async (payload) => {
      if (payload?.roomId === numericRoomId) {
        await loadPolls().catch(() => {});
        // Note: discussion-group rooms no longer show a preliminary/draft summary to participants.
        // All results are presented together in the single Final Analysis Report at the end.
      }
    });

    socket.on('room_status_updated', (payload) => {
      if (payload?.roomId === numericRoomId) {
        loadRoomStatus().catch(() => {});
      }
    });

    socket.on('membership_revoked', (payload) => {
      if (payload?.roomId === numericRoomId) navigate('/dashboard');
    });
    socket.on('convergence_completed', (payload) => {
      navigate('/dashboard', { state: { showRecap: true, recapReport: payload.report } });
    });
    socket.on('process_ended_for_user', (payload) => {
      if (payload?.roomId === numericRoomId) {
        isExcludedRef.current = true;
        setExitModalOpen(true);
      }
    });
    socket.on('process_started', () => {
      if (!isExcludedRef.current) {
        navigate('/dashboard');
      }
    });

    socket.on('rooms_updated', () => {
      loadAvailableRooms().catch(() => {});
    });

    socket.on('room_updated', (payload) => {
      if (payload?.roomId === numericRoomId) {
        setRoom((prev) => ({
          ...(prev || {}),
          is_active: !!payload.is_active,
          ...(payload.collection_complete !== undefined
            ? { collection_complete: !!payload.collection_complete }
            : {})
        }));
        loadMessages().catch(() => {});
      }
      loadAvailableRooms().catch(() => {});
    });

    socket.on('error_message', (payload) => {
      setError(payload.error || 'Socket error');
      setTimeout(() => setError(''), 4000);
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [isValidRoomId, numericRoomId, token]);

  useEffect(() => {
    if (!isValidRoomId) return undefined;
    const intervalId = setInterval(() => {
      loadRoomStatus().catch(() => {});
    }, 5000);
    return () => clearInterval(intervalId);
  }, [isValidRoomId, numericRoomId, token]);

  // Socket events are the fast path, but a mobile browser can temporarily suspend a
  // connection and miss `polls_updated`. Reconcile the poll list periodically so a
  // mandatory poll can never remain invisible while the room is waiting for votes.
  useEffect(() => {
    if (!isValidRoomId) return undefined;
    const intervalId = setInterval(() => {
      loadPolls().catch(() => {});
      // Reconcile room membership as well as polls. This is the recovery path
      // when a mobile browser misses the one-shot rooms_updated event during
      // the personal-to-group transition.
      loadAvailableRooms().catch(() => {});
    }, 5000);
    return () => clearInterval(intervalId);
  }, [isValidRoomId, numericRoomId, token]);

  useEffect(() => {
    if (!inactivityWarning) return undefined;
    const intervalId = setInterval(() => {
      setInactivitySeconds((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => clearInterval(intervalId);
  }, [inactivityWarning]);

  useEffect(() => {
    scrollListToBottom(true);
  }, [messages]);

  const sendMessage = () => {
    const trimmed = text.trim();
    if (!trimmed || !socketRef.current || (displayedRoom?.is_active === false && !displayedRoom?.collection_complete)) return;

    socketRef.current.emit('send_message', { roomId: numericRoomId, text: trimmed });
    // Keep the on-screen keyboard open after sending, like WhatsApp — re-focus the textarea in
    // case anything (e.g. tapping the Send button) shifted focus away from it.
    requestAnimationFrame(() => textareaRef.current?.focus());
    setText('');
  };

  const handleReopenTopic = async (topicKey) => {
    // Silent action: give the clicking user subtle local feedback, but no alert and no
    // immediate vote. The reopen is applied when the review window closes.
    setLocallyReopened((prev) => {
      const next = new Set(prev);
      next.add(topicKey);
      return next;
    });
    try {
      await apiRequest(`/rooms/${numericRoomId}/reopen-topic`, {
        method: 'POST',
        body: JSON.stringify({ topicKey })
      }, token);
    } catch (e) {
      // Roll back the local flag if the server rejected it (e.g. the window already closed).
      setLocallyReopened((prev) => {
        const next = new Set(prev);
        next.delete(topicKey);
        return next;
      });
    }
  };

  const handleAgree = async () => {
    setLocallyAgreed(true);
    try {
      await apiRequest(`/rooms/${numericRoomId}/convergence-agree`, { method: 'POST', body: JSON.stringify({}) }, token);
    } catch (e) {
      setLocallyAgreed(false);
    }
  };

  const hasConvergenceSummary = useMemo(
    () => messages.some((m) => m.is_bot && typeof m.text === 'string' && m.text.startsWith('[ConvergenceSummary=')),
    [messages]
  );

  // While the convergence summary card is on screen, poll the shared review-window state
  // (countdown + which topics were reopened) so every participant sees a consistent view.
  useEffect(() => {
    if (!hasConvergenceSummary) {
      setConvergenceStatus(null);
      return undefined;
    }
    let cancelled = false;
    let intervalId = null;
    const fetchStatus = async () => {
      try {
        const data = await apiRequest(`/rooms/${numericRoomId}/convergence-status`, {}, token);
        if (cancelled || !data || !data.isConvergence) return;
        // Keep the receipt time so MessageBubble can smoothly decrement the server-provided
        // countdown without inventing a client-side duration.
        setConvergenceStatus({ ...data, receivedAt: Date.now() });
        if (data.finalized && intervalId) {
          clearInterval(intervalId);
          intervalId = null;
        }
      } catch (e) {
        // ignore transient errors
      }
    };
    fetchStatus();
    intervalId = setInterval(fetchStatus, 3000);
    return () => {
      cancelled = true;
      if (intervalId) clearInterval(intervalId);
    };
  }, [hasConvergenceSummary, numericRoomId, token]);


  const vote = async (pollId, optionId, rankedOptions = null, customOptionText = null, optionIds = null) => {
    try {
      const poll = polls.find(p => p.id === pollId);
      const option = optionId ? poll?.options?.find(o => o.id === optionId) : null;
      if (option && (option.option_text === 'No' || option.option_text.startsWith('1'))) {
        if (poll?.question?.includes('changing your mind')) {
          isExcludedRef.current = true;
          setExitModalOpen(true);
        }
      }

      setPolls((prev) =>
        prev.map((p) => {
          if (p.id === pollId) {
            return {
              ...p,
              my_vote_option_id: optionId || (optionIds && optionIds.length > 0 ? optionIds[0] : null),
              my_vote_option_ids: optionIds || (optionId ? [optionId] : []),
              my_ranked_options: rankedOptions || optionIds || []
            };
          }
          return p;
        })
      );
      const body = optionIds ? { optionIds, customOptionText } : (rankedOptions ? { rankedOptions } : { optionId, customOptionText });
      await apiRequest(`/rooms/polls/${pollId}/vote`, { method: 'POST', body: JSON.stringify(body) }, token);
      // Close the mobile poll modal after any submit (including live/continuous votes). The
      // floating "Live voting" banner stays visible so users can reopen to change their vote.
      setShowMobilePolls(false);
    } catch (e) {
      setError(e.message);
      loadPolls();
    }
  };

  const handleDragStart = (e, pollId, index) => {
    e.dataTransfer.setData('text/plain', JSON.stringify({ pollId, index }));
  };

  const handleDragOver = (e) => {
    e.preventDefault();
  };

  const handleDrop = (e, pollId, targetIndex) => {
    e.preventDefault();
    try {
      const data = JSON.parse(e.dataTransfer.getData('text/plain'));
      if (data.pollId !== pollId) return;
      const sourceIndex = data.index;
      if (sourceIndex === targetIndex) return;

      setRankingState((prev) => {
        const arr = [...(prev[pollId] || [])];
        const [moved] = arr.splice(sourceIndex, 1);
        arr.splice(targetIndex, 0, moved);
        return { ...prev, [pollId]: arr };
      });
    } catch (err) {}
  };

  const moveRank = (pollId, index, direction) => {
    setRankingState((prev) => {
      const arr = [...(prev[pollId] || [])];
      if (direction === 'up' && index > 0) {
        const temp = arr[index];
        arr[index] = arr[index - 1];
        arr[index - 1] = temp;
      } else if (direction === 'down' && index < arr.length - 1) {
        const temp = arr[index];
        arr[index] = arr[index + 1];
        arr[index + 1] = temp;
      }
      return { ...prev, [pollId]: arr };
    });
  };

  const pollIsClosed = (poll) => {
    if (poll.is_closed) return true;
    if (!poll.expires_at) return false;
    return new Date(poll.expires_at).getTime() <= nowMs;
  };

  const pollCountdown = (poll) => {
    if (!poll.expires_at) return null;
    const diff = new Date(poll.expires_at).getTime() - nowMs;
    if (diff <= 0) return '00:00';
    const m = Math.floor(diff / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };
  const lastClosedPoll = useMemo(() => {
    return polls.find((p) => pollIsClosed(p));
  }, [polls, nowMs]);

  // The mobile poll drawer only lists non-swipe polls; it should draw attention only while there
  // is an open, non-swipe poll the current user still needs to vote on.
  const hasPendingMobilePoll = useMemo(
    () => polls.some((p) => !pollIsClosed(p) && !p.has_voted && p.poll_type !== 'swipe'),
    [polls, nowMs]
  );
  // A live (continuous) vote is ongoing. Unlike a "pending" poll, this stays true even after the
  // user has voted (they can change their choice), so the banner keeps saying "Live voting" until
  // the phase ends.
  const activeLiveVoting = useMemo(
    () => polls.some((p) => !pollIsClosed(p) && (p.poll_type === 'continuous' || p.poll_stage === 'continuous')),
    [polls, nowMs]
  );
  // Changing the button's `key` (via this id) forces React to remount it so the pop-in
  // animation replays whenever a *new* pending poll shows up, not just the first time.
  const pendingMobilePollCount = useMemo(
    () => polls.filter((p) => !pollIsClosed(p) && !p.has_voted && p.poll_type !== 'swipe').length,
    [polls, nowMs]
  );

  const topOptions = useMemo(() => {
    if (!lastClosedPoll) return [];
    const sorted = [...lastClosedPoll.options].sort((a, b) => (b.votes || 0) - (a.votes || 0));
    if (lastClosedPoll.has_consensus) {
      return sorted.slice(0, 1);
    }
    return sorted.filter((opt) => (opt.votes || 0) >= 1);
  }, [lastClosedPoll]);

  const activeTimerExpiresAt = useMemo(() => {
    if (displayedRoom?.timer_expires_at) {
      const roomDiff = new Date(displayedRoom.timer_expires_at).getTime() - nowMs;
      if (roomDiff > 0) return displayedRoom.timer_expires_at;
    }
    const openPoll = polls.find((p) => !pollIsClosed(p) && p.expires_at);
    return openPoll ? openPoll.expires_at : null;
  }, [displayedRoom?.timer_expires_at, polls, nowMs]);

  const roomCountdown = (roomObj) => {
    if (!roomObj?.timer_expires_at) return null;
    const diff = new Date(roomObj.timer_expires_at).getTime() - nowMs;
    if (diff <= 0) return '00:00';
    const m = Math.floor(diff / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  const renderRoomStatus = () => {
    if (displayedRoom?.room_type !== 'group' && displayedRoom?.room_type !== 'convergence') return null;
    return (
      <>
        <h2 className="mb-2 text-sm font-semibold text-slate-800 dark:text-slate-200">Room Status</h2>
        {roomStatus ? (
          <div className="space-y-3 text-xs text-slate-700 dark:text-slate-300">
            {roomStatus.ongoing_topic && (
              <div>
                <span className="font-semibold text-amber-600 dark:text-amber-400">Ongoing topic of discussion:</span>
                <p className="mt-1 font-medium text-slate-900 dark:text-slate-100">
                  {roomStatus.ongoing_topic}
                  {roomStatus.tie_votes > 0 ? ` (${roomStatus.tie_votes} previous tie vote${roomStatus.tie_votes !== 1 ? 's' : ''})` : ''}
                </p>
              </div>
            )}
            {roomStatus.points_decided?.length > 0 && (
              <div>
                <span className="font-semibold text-emerald-600 dark:text-emerald-400">Points decided:</span>
                <ul className="mt-1 list-inside list-disc space-y-1">
                  {roomStatus.points_decided.map((pt, i) => <li key={i}>{pt}</li>)}
                </ul>
              </div>
            )}
            {!roomStatus.ongoing_topic && (!roomStatus.points_decided || roomStatus.points_decided.length === 0) && (
              <p className="text-slate-500">No active discussion or decisions yet.</p>
            )}
          </div>
        ) : (
          <p className="text-xs text-slate-500 dark:text-slate-400">No status available yet.</p>
        )}
      </>
    );
  };

  const renderPolls = () => (
          <div className={`flex-1 overflow-y-auto rounded-xl border border-slate-200 bg-white/50 p-4 shadow-lg shadow-black/5 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-slate-300 dark:border-slate-800/60 dark:bg-slate-900/50 dark:shadow-black/20 dark:scrollbar-track-slate-900 dark:scrollbar-thumb-slate-700 ${(highlightedPollId || countdownVal !== null) ? '' : 'backdrop-blur-md'}`}>
              <h2 className="mb-3 text-sm font-semibold text-slate-800 dark:text-slate-200">Room Polls</h2>
              <div className="space-y-3">
                {polls.filter((p) => !pollIsClosed(p) && p.poll_type !== 'swipe').map((poll) => {
                  const closed = pollIsClosed(poll);
                  const countdown = pollCountdown(poll);
                  const isHighlighted = highlightedPollId === poll.id;
                  const rankingOrder = rankingState[poll.id] || (poll.my_ranked_options?.length > 0 ? poll.my_ranked_options : poll.options.map((o) => o.id));
                  const rankingSubmitted = poll.my_ranked_options?.length > 0 && JSON.stringify(rankingOrder) === JSON.stringify(poll.my_ranked_options);
                  const isContinuousPoll = poll.poll_type === 'continuous' || poll.poll_stage === 'continuous';
                  const currentSelection = tempSelections[poll.id] || [];
                  const currentSelectionId = currentSelection[0] || null;
                  const currentSelectionOption = poll.options.find((option) => option.id === currentSelectionId);
                  const continuousOtherSelected = currentSelectionOption?.option_text?.trim().toLowerCase() === 'other';
                  // A participant's write-in is rendered as a synthetic option whose id is a string
                  // ("custom-<text>"). Voting for it is really an "Other" vote carrying that text, so
                  // it must be submitted as { optionId: <Other id>, customOptionText: <text> } — never
                  // the synthetic string id, which the vote endpoint rejects.
                  const continuousSelectionIsWriteIn = typeof currentSelectionId === 'string' && currentSelectionId.startsWith('custom-');
                  const continuousOtherOption = poll.options.find((option) => option.option_text?.trim().toLowerCase() === 'other');
                  const continuousAlreadySubmitted = continuousSelectionIsWriteIn
                    ? (!!continuousOtherOption && poll.my_vote_option_id === continuousOtherOption.id && (poll.my_vote_custom_text || '') === (currentSelectionOption?.option_text || ''))
                    : poll.my_vote_option_id === currentSelectionId;
                  return (
                    <div
                      key={poll.id}
                      className={`rounded border p-3 shadow-sm transition-all duration-300 ${
                        isHighlighted
                          ? 'relative z-50 ring-4 ring-indigo-500 border-indigo-500 bg-white dark:bg-slate-850 scale-[1.04] shadow-[0_0_25px_rgba(99,102,241,0.7)]'
                          : 'border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-900'
                      }`}
                    >
                      <p className="mb-2 text-sm font-medium text-slate-800 dark:text-slate-100">
                        {poll.question}
                        {poll.poll_type === 'ranking' && <span className="text-xs text-indigo-500 dark:text-indigo-400 font-normal ml-2">(Ranked Choice - Drag to sort)</span>}
                        {poll.max_choices > 1 && <span className="text-xs text-indigo-500 dark:text-indigo-400 font-normal ml-2">(Select up to {poll.max_choices} options)</span>}
                      </p>
                      <div className="space-y-2">
                        {isContinuousPoll ? (
                          <>
                            <div className="rounded-lg border border-indigo-200 bg-indigo-50/70 p-3 text-xs text-slate-700 dark:border-indigo-900/60 dark:bg-indigo-950/30 dark:text-slate-300">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <span>Live voting: choose one option. You can change it at any time.</span>
                              </div>
                              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
                                <span className="font-semibold">{poll.continuous?.current_votes || 0}/{poll.continuous?.eligible_members || 0} voted</span>
                                <span>Quorum: {poll.continuous?.current_votes || 0}/{poll.continuous?.quorum_required || 0}</span>
                                <span>Approval: {poll.continuous?.approval_threshold_percent || 0}% ({poll.continuous?.approval_required || 0} votes)</span>
                                {poll.continuous?.stability_remaining_seconds > 0 ? <span>Stable for {poll.continuous.stability_remaining_seconds}s</span> : null}
                              </div>
                            </div>
                            {poll.options.map((option) => {
                              const isSelected = currentSelectionId === option.id;
                              const isOther = option.option_text.trim().toLowerCase() === 'other';
                              if (isOther) {
                                return (
                                  <div
                                    key={option.id}
                                    onClick={(event) => {
                                      if (event.target.tagName === 'INPUT') return;
                                      setTempSelections((prev) => ({ ...prev, [poll.id]: [option.id] }));
                                    }}
                                    className={`w-full rounded-lg border-2 px-3 py-2.5 text-left text-sm transition-all ${
                                      isSelected
                                        ? 'border-indigo-600 bg-indigo-600 text-white shadow-md'
                                        : 'border-transparent bg-slate-200/50 hover:border-slate-300 dark:bg-slate-800/80 dark:hover:border-slate-700'
                                    } ${closed ? 'pointer-events-none opacity-70' : ''}`}
                                  >
                                    <div className="flex items-center justify-between gap-3">
                                      <div className="flex min-w-0 flex-1 items-center gap-2">
                                        <span className="font-medium">Other</span>
                                        <input
                                          type="text"
                                          maxLength={240}
                                          disabled={closed}
                                          value={tempCustomTexts[poll.id] || ''}
                                          placeholder="Describe your option"
                                          onClick={(event) => event.stopPropagation()}
                                          onFocus={() => setTempSelections((prev) => ({ ...prev, [poll.id]: [option.id] }))}
                                          onChange={(event) => {
                                            setTempCustomTexts((prev) => ({ ...prev, [poll.id]: event.target.value }));
                                            setTempSelections((prev) => ({ ...prev, [poll.id]: [option.id] }));
                                          }}
                                          className={`min-w-0 flex-1 bg-transparent outline-none ${isSelected ? 'text-white placeholder-indigo-200/70' : 'text-slate-900 placeholder-slate-400 dark:text-slate-100'}`}
                                        />
                                      </div>
                                      <span className={`text-xs ${isSelected ? 'text-indigo-100' : 'text-indigo-600 dark:text-indigo-200'}`}>{option.votes || 0} votes</span>
                                    </div>
                                  </div>
                                );
                              }
                              return (
                                <button
                                  key={option.id}
                                  disabled={closed}
                                  onClick={() => setTempSelections((prev) => ({ ...prev, [poll.id]: [option.id] }))}
                                  className={`w-full rounded-lg px-3 py-2.5 text-left text-sm transition-all duration-200 ${isSelected ? 'bg-indigo-600 text-white shadow-md' : 'bg-slate-200/50 hover:bg-slate-200 hover:shadow dark:bg-slate-800/80 dark:hover:bg-slate-700'} ${closed ? 'opacity-70 pointer-events-none' : ''}`}
                                >
                                  <div className="flex items-center justify-between gap-3">
                                    <span className="font-medium">{option.option_text}</span>
                                    <span className={`text-xs ${isSelected ? 'text-indigo-100' : 'text-indigo-600 dark:text-indigo-200'}`}>{option.votes || 0} votes</span>
                                  </div>
                                </button>
                              );
                            })}
                            {!closed && (
                              <button
                                onClick={() => {
                                  if (continuousSelectionIsWriteIn && continuousOtherOption) {
                                    // Join an existing write-in: submit as an Other vote with that text.
                                    vote(poll.id, continuousOtherOption.id, null, currentSelectionOption?.option_text || '');
                                  } else {
                                    vote(
                                      poll.id,
                                      currentSelectionId,
                                      null,
                                      continuousOtherSelected ? (tempCustomTexts[poll.id] || '').trim() : null
                                    );
                                  }
                                }}
                                disabled={!currentSelectionId || (continuousOtherSelected && !(tempCustomTexts[poll.id] || '').trim())}
                                className="mt-4 w-full rounded-lg bg-indigo-600 py-2.5 text-sm font-semibold text-white shadow-md transition-all hover:bg-indigo-500 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                {continuousAlreadySubmitted ? 'Submitted' : 'Submit Vote'}
                              </button>
                            )}
                          </>
                        ) : poll.poll_type === 'ranking' ? (
                          <>
                            {(rankingState[poll.id] || (poll.my_ranked_options?.length > 0 ? poll.my_ranked_options : poll.options.map((o) => o.id))).map((optId, idx, arr) => {
                              const option = poll.options.find((o) => o.id === optId);
                              if (!option) return null;
                              return (
                                <div
                                  key={option.id}
                                  draggable={!closed}
                                  onDragStart={(e) => handleDragStart(e, poll.id, idx)}
                                  onDragOver={handleDragOver}
                                  onDrop={(e) => handleDrop(e, poll.id, idx)}
                                  className={`flex items-center justify-between rounded-lg px-3 py-2.5 text-sm transition-all duration-200 ${closed ? 'bg-slate-200/50 opacity-70' : 'bg-white cursor-grab active:cursor-grabbing hover:shadow-md border border-slate-200'} dark:border-slate-700 dark:bg-slate-800`}
                                >
                                  <div className="flex items-center gap-3">
                                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-indigo-100 text-xs font-bold text-indigo-700 dark:bg-indigo-900/50 dark:text-indigo-300">
                                      {idx + 1}
                                    </span>
                                    <span className="font-medium text-slate-800 dark:text-slate-200">{option.option_text}</span>
                                  </div>
                                  <div className="flex items-center gap-3">
                                    {closed && option.votes !== null && (
                                      <span className="text-xs font-semibold text-indigo-600 dark:text-indigo-400">{option.votes} pts</span>
                                    )}
                                    {!closed && (
                                      <div className="flex flex-col">
                                        <button onClick={() => moveRank(poll.id, idx, 'up')} disabled={idx === 0} className="text-slate-400 hover:text-indigo-600 disabled:opacity-30 p-0.5 leading-none">▲</button>
                                        <button onClick={() => moveRank(poll.id, idx, 'down')} disabled={idx === arr.length - 1} className="text-slate-400 hover:text-indigo-600 disabled:opacity-30 p-0.5 leading-none">▼</button>
                                      </div>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                            {!closed && (
                              <button
                                onClick={() => vote(poll.id, null, rankingOrder)}
                                className={`mt-4 w-full rounded-lg py-2.5 text-sm font-semibold text-white shadow-md transition-all active:scale-[0.98] ${rankingSubmitted ? 'bg-green-600 hover:bg-green-500' : 'bg-indigo-600 hover:bg-indigo-500'}`}
                              >
                                {rankingSubmitted ? 'Submitted' : (poll.my_ranked_options?.length > 0 ? 'Update Ranking' : 'Submit Ranking')}
                              </button>
                            )}
                          </>
                        ) : (
                          <>
                            {poll.options.map((option) => {
                              const isSelected = (tempSelections[poll.id] || []).includes(option.id);

                              if (option.option_text.toLowerCase() === 'other') {
                                const currentCustomText = tempCustomTexts[poll.id] !== undefined
                                  ? tempCustomTexts[poll.id]
                                  : (poll.my_vote_custom_text || '');

                                return (
                                  <div
                                    key={option.id}
                                    onClick={(e) => {
                                      if (e.target.tagName === 'INPUT') return;
                                      e.preventDefault();
                                      const inputEl = e.currentTarget.querySelector('input');
                                      setTempSelections((prev) => {
                                        const selected = prev[poll.id] || [];
                                        const maxChoices = poll.max_choices || 1;
                                        let nextSelected;
                                        if (maxChoices > 1) {
                                          if (selected.includes(option.id)) {
                                            nextSelected = selected.filter((id) => id !== option.id);
                                            if (inputEl) inputEl.blur();
                                          } else {
                                            if (selected.length >= maxChoices) {
                                              nextSelected = [...selected.slice(1), option.id];
                                            } else {
                                              nextSelected = [...selected, option.id];
                                            }
                                            if (inputEl) inputEl.focus();
                                          }
                                        } else {
                                          nextSelected = [option.id];
                                          if (inputEl) inputEl.focus();
                                        }
                                        return { ...prev, [poll.id]: nextSelected };
                                      });
                                    }}
                                    className={`w-full rounded-lg px-3 py-2 text-left text-sm transition-all duration-200 border-2 ${
                                      isSelected
                                        ? 'bg-indigo-600 border-indigo-600 text-white shadow-md'
                                        : 'bg-slate-200/50 border-transparent hover:border-slate-300 dark:bg-slate-800/80 dark:hover:border-slate-700'
                                    } ${closed ? 'opacity-70 pointer-events-none' : ''}`}
                                  >
                                    <div className="flex items-center justify-between gap-2">
                                      <div className="flex-1 flex items-center gap-2">
                                        <span className="font-semibold select-none opacity-80">Other:</span>
                                        <input
                                          type="text"
                                          placeholder="new option"
                                          disabled={closed}
                                          value={currentCustomText}
                                          onClick={(e) => e.stopPropagation()}
                                          onFocus={() => {
                                            setTempSelections((prev) => {
                                              const selected = prev[poll.id] || [];
                                              if (!selected.includes(option.id)) {
                                                const maxChoices = poll.max_choices || 1;
                                                let nextSelected;
                                                if (maxChoices > 1) {
                                                  if (selected.length >= maxChoices) {
                                                    nextSelected = [...selected.slice(1), option.id];
                                                  } else {
                                                    nextSelected = [...selected, option.id];
                                                  }
                                                } else {
                                                  nextSelected = [option.id];
                                                }
                                                return { ...prev, [poll.id]: nextSelected };
                                              }
                                              return prev;
                                            });
                                          }}
                                          onChange={(e) => {
                                            const val = e.target.value;
                                            setTempCustomTexts((prev) => ({ ...prev, [poll.id]: val }));

                                            setTempSelections((prev) => {
                                              const selected = prev[poll.id] || [];
                                              const hasOption = selected.includes(option.id);
                                              const maxChoices = poll.max_choices || 1;
                                              if (val.trim()) {
                                                if (!hasOption) {
                                                  let nextSelected;
                                                  if (maxChoices > 1) {
                                                    if (selected.length >= maxChoices) {
                                                      nextSelected = [...selected.slice(1), option.id];
                                                    } else {
                                                      nextSelected = [...selected, option.id];
                                                    }
                                                  } else {
                                                    nextSelected = [option.id];
                                                  }
                                                  return { ...prev, [poll.id]: nextSelected };
                                                }
                                              } else {
                                                if (hasOption) {
                                                  return { ...prev, [poll.id]: selected.filter((id) => id !== option.id) };
                                                }
                                              }
                                              return prev;
                                            });
                                          }}
                                          onKeyDown={async (e) => {
                                            if (e.key === 'Enter' && !closed && currentCustomText.trim()) {
                                              e.preventDefault();
                                              await vote(poll.id, null, null, currentCustomText.trim(), [option.id]);
                                            }
                                          }}
                                          className={`w-full bg-transparent outline-none font-medium ${
                                            isSelected
                                              ? 'text-white placeholder-indigo-200/70'
                                              : 'text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500'
                                          }`}
                                        />
                                      </div>
                                      <div className="flex items-center gap-2">
                                        {option.votes !== null && (
                                          <span className={`text-xs ${isSelected ? 'text-indigo-200' : 'text-indigo-600 dark:text-indigo-200'}`}>
                                            {option.votes} votes
                                          </span>
                                        )}
                                      </div>
                                    </div>
                                  </div>
                                );
                              }

                              return (
                                <button
                                  key={option.id}
                                  onClick={() => {
                                    const maxChoices = poll.max_choices || 1;
                                    setTempSelections((prev) => {
                                      const selected = prev[poll.id] || [];
                                      let nextSelected;
                                      if (maxChoices > 1) {
                                        if (option.option_text.toLowerCase() === 'all topics') {
                                          nextSelected = [option.id];
                                        } else if (selected.includes(option.id)) {
                                          nextSelected = selected.filter((id) => id !== option.id);
                                        } else {
                                          let filteredSelected = selected.filter(id => {
                                            const opt = poll.options.find(o => o.id === id);
                                            return opt && opt.option_text.toLowerCase() !== 'all topics';
                                          });
                                          if (filteredSelected.length >= maxChoices) {
                                            nextSelected = [...filteredSelected.slice(1), option.id];
                                          } else {
                                            nextSelected = [...filteredSelected, option.id];
                                          }
                                        }
                                      } else {
                                        nextSelected = [option.id];
                                      }
                                      return { ...prev, [poll.id]: nextSelected };
                                    });
                                  }}
                                  disabled={closed}
                                  className={`w-full rounded-lg px-3 py-2.5 text-left text-sm transition-all duration-200 ${isSelected ? 'bg-indigo-600 text-white shadow-md' : 'bg-slate-200/50 hover:bg-slate-200 hover:shadow dark:bg-slate-800/80 dark:hover:bg-slate-700'} ${closed ? 'opacity-70 pointer-events-none' : ''}`}
                                >
                                  <div className="flex items-center justify-between">
                                    <span className="font-medium">{option.option_text}</span>
                                    {option.votes !== null && (
                                      <span className="text-xs text-indigo-600 dark:text-indigo-200">{option.votes} votes</span>
                                    )}
                                  </div>
                                </button>
                              );
                            })}
                            {!closed && (
                              <button
                                onClick={() => {
                                  const selections = tempSelections[poll.id] || [];
                                  vote(poll.id, null, null, tempCustomTexts[poll.id] || null, selections);
                                }}
                                disabled={!(tempSelections[poll.id]?.length > 0)}
                                className={`mt-4 w-full rounded-lg py-2.5 text-sm font-semibold text-white shadow-md transition-all active:scale-[0.98] ${
                                  poll.my_vote_option_ids?.length > 0 &&
                                  JSON.stringify(tempSelections[poll.id] || []) === JSON.stringify(poll.my_vote_option_ids)
                                    ? 'bg-green-600 hover:bg-green-500'
                                    : 'bg-indigo-600 hover:bg-indigo-500'
                                }`}
                              >
                                {poll.my_vote_option_ids?.length > 0 &&
                                JSON.stringify(tempSelections[poll.id] || []) === JSON.stringify(poll.my_vote_option_ids)
                                  ? 'Submitted'
                                  : (poll.max_choices > 1 ? 'Submit Choices' : 'Submit Vote')}
                              </button>
                            )}
                          </>
                        )}
                      </div>
                      <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                        {closed ? 'Closed' : 'Open'} · Results {poll.show_results ? 'visible' : 'hidden'}{poll.mandatory ? ' · Mandatory' : ''}{countdown ? ` · ${countdown}` : ''}
                      </p>
                    </div>
                  );
                })}
                {polls.filter((p) => !pollIsClosed(p) && p.poll_type !== 'swipe').length === 0 ? <p className="text-sm text-slate-500 dark:text-slate-400">No active polls in this room.</p> : null}
                {lastClosedPoll && displayedRoom?.room_type !== 'personal' && (
                  <div className="mt-6 border-t border-slate-200 pt-4 dark:border-slate-800">
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                      Last Poll Results
                    </h3>
                    <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-3.5 dark:border-slate-800/60 dark:bg-slate-900/40">
                      <p className="mb-3 text-xs font-semibold text-slate-700 dark:text-slate-350">
                        {lastClosedPoll.question}
                      </p>
                      <div className="space-y-1.5">
                        {topOptions.map((opt) => (
                          <div
                            key={opt.id}
                            className="flex items-center justify-between rounded-lg bg-white px-3 py-2 text-xs font-medium text-slate-800 border border-slate-100 shadow-sm dark:bg-slate-800 dark:text-slate-200 dark:border-slate-700/60"
                          >
                            <span>{opt.option_text}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
  );

  return (
    <div
      className="flex flex-col bg-white transition-colors duration-300 dark:bg-[#131314] text-gray-900 dark:text-gray-100 overscroll-none"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        // Pinning with `position: fixed` (rather than being a normal-flow block with just a
        // height) makes the shell immune to mobile browsers scrolling the *document* to reveal a
        // focused input — that scroll used to carry the whole chat (including the header) out of
        // view and leave blank body background showing beneath it.
        height: viewportHeight ? `${viewportHeight}px` : '100dvh'
      }}
    >
      {(highlightedPollId || countdownVal !== null) && (
        <div className="fixed inset-0 z-40 bg-slate-900/40 backdrop-blur-[2px] transition-all duration-300 pointer-events-none" />
      )}
      {exitModalOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="w-full max-w-md rounded-3xl bg-white p-8 shadow-xl dark:bg-[#1e1f20] border border-gray-200 dark:border-gray-800 transition-colors duration-300">
            <h2 className="mb-4 text-2xl font-bold text-slate-900 dark:text-slate-100">Thank you for joining</h2>
            <p className="mb-8 text-slate-700 dark:text-slate-300 leading-relaxed">
              Your participation has ended because you indicated you are not open to debate on this topic. Thank you for your time.
            </p>
            <div className="flex justify-end">
              <button
                onClick={() => {
                  logout();
                  navigate('/login');
                }}
                className="rounded-full bg-blue-600 px-6 py-3 text-white font-medium transition-all hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-400"
              >
                Exit
              </button>
            </div>
          </div>
        </div>
      )}

      {activeSwipePoll && (
        <SwipeVoteModal
          poll={activeSwipePoll}
          token={token}
          onSubmit={(pollId, updatedOptions) => {
            if (updatedOptions) {
              loadPolls();
            }
            setActiveSwipePoll(null);
            loadPolls();
          }}
          onClose={() => setActiveSwipePoll(null)}
        />
      )}

      {pollSummaryData && (
        <PollSummaryModal
          poll={pollSummaryData}
          onClose={() => setPollSummaryData(null)}
          canDismiss={true}
        />
      )}

      {showRecapModal && recapReport && (
        <RecapModal
          report={recapReport}
          onClose={() => setShowRecapModal(false)}
          buttonText="Close"
          title={displayedRoom?.room_type === 'group' ? 'Discussion Group Draft Report' : 'Final Analysis Report'}
          subtitle={displayedRoom?.room_type === 'group' ? 'Results and analysis for this discussion group' : 'Complete results and analysis of the whole decision process'}
        />
      )}

      {inactivityWarning && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in">
          <div className="max-w-md w-full mx-4 bg-white dark:bg-[#1e1f20] border border-red-500/30 rounded-3xl p-8 shadow-xl text-center">
            <div className="w-16 h-16 bg-red-500/10 rounded-full flex items-center justify-center mx-auto mb-4 border border-red-500/20">
              <svg className="w-8 h-8 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            <h3 className="text-lg font-bold text-white mb-2">Inactivity Warning</h3>
            <p className="text-slate-300 text-sm mb-6 leading-relaxed">
              You have been inactive. Please interact by sending a message or casting a vote within the next <strong className="text-red-400">{inactivitySeconds} seconds</strong>, or you will be removed from the room.
            </p>
            <button 
              onClick={() => {
                // Register real activity so the inactivity timer resets (there is no REST
                // endpoint for posting messages — activity is tracked via the socket).
                if (socketRef.current) {
                  socketRef.current.emit('send_message', { roomId: numericRoomId, text: "I'm still here." });
                }
                setInactivityWarning(false);
                loadRoomData().catch(() => {});
              }}
              className="w-full bg-red-600 hover:bg-red-700 text-white font-semibold py-3 px-4 rounded-full transition-all shadow-sm hover:shadow-md active:scale-[0.98] cursor-pointer"
            >
              I'm still here
            </button>
          </div>
        </div>
      )}

      {countdownVal !== null && activeNextRoom && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#131314]/80 backdrop-blur-md">
          <div className="mx-4 max-w-md rounded-3xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-[#1e1f20] p-8 text-center shadow-xl transition-colors duration-300">
            <div className="relative mb-6 flex h-24 w-24 items-center justify-center rounded-full bg-indigo-500/10 text-indigo-400 mx-auto border border-indigo-500/20">
              <span className="text-5xl font-black animate-ping absolute duration-1000">{countdownVal}</span>
              <span className="text-5xl font-black relative">{countdownVal}</span>
            </div>
            <h3 className="text-xl font-bold text-slate-100 mb-2">Moving to the Next Room</h3>
            <p className="text-sm text-slate-400 leading-relaxed">
              This phase is complete. You are being automatically redirected to your {activeNextRoom.room_type === 'convergence' ? 'Convergence Round' : 'Group Discussion'} room in {countdownVal} second{countdownVal !== 1 ? 's' : ''}...
            </p>
          </div>
        </div>
      )}

      {showMobileRoomStatus && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 md:hidden animate-fade-in" onClick={() => setShowMobileRoomStatus(false)}>
          <div className="w-full max-w-sm max-h-[80vh] overflow-y-auto rounded-3xl bg-white p-6 shadow-xl dark:bg-[#1e1f20] border border-gray-200 dark:border-gray-800" onClick={e => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-4 pb-2 border-b border-slate-200 dark:border-slate-800">
              <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100">Room Status</h2>
              <button onClick={() => setShowMobileRoomStatus(false)} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 bg-slate-100 dark:bg-slate-800 rounded-full w-8 h-8 flex items-center justify-center">✕</button>
            </div>
            {renderRoomStatus()}
          </div>
        </div>
      )}

      {showMobilePolls && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 md:hidden animate-fade-in" onClick={() => setShowMobilePolls(false)}>
          <div className="w-full max-w-sm max-h-[80vh] overflow-y-auto rounded-3xl bg-white p-6 shadow-xl dark:bg-[#1e1f20] border border-gray-200 dark:border-gray-800" onClick={e => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-4 pb-2 border-b border-slate-200 dark:border-slate-800">
              <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100">Room Polls</h2>
              <button onClick={() => setShowMobilePolls(false)} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 bg-slate-100 dark:bg-slate-800 rounded-full w-8 h-8 flex items-center justify-center">✕</button>
            </div>
            {renderPolls()}
          </div>
        </div>
      )}

      <div className="md:hidden fixed right-0 top-28 z-30 flex flex-col gap-3 items-end">
        {displayedRoom && (displayedRoom.room_type === 'group' || displayedRoom.room_type === 'convergence') && (
          <button 
            onClick={() => setShowMobileRoomStatus(true)}
            className="bg-indigo-600 text-white p-2.5 rounded-l-2xl shadow-lg border-y border-l border-indigo-500/50 flex items-center justify-center hover:bg-indigo-500 transition-colors"
            title="View Room Status"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>
          </button>
        )}
        <button
          key={hasPendingMobilePoll ? `pending-${pendingMobilePollCount}` : (activeLiveVoting ? 'live' : 'idle')}
          onClick={() => setShowMobilePolls(true)}
          className={`relative bg-emerald-600 text-white shadow-lg border-y border-l border-emerald-500/50 flex items-center hover:bg-emerald-500 transition-all ${(hasPendingMobilePoll || activeLiveVoting) ? `w-[46vw] gap-2 justify-center py-3.5 pl-4 pr-5 rounded-l-3xl shadow-[0_0_18px_rgba(16,185,129,0.65)] ${hasPendingMobilePoll ? 'animate-poll-alert' : ''}` : 'p-2.5 justify-center rounded-l-2xl'}`}
          title="View Polls"
        >
          {hasPendingMobilePoll && (
            <span className="absolute -top-1.5 -left-1.5 flex h-5 w-5 animate-pop-in items-center justify-center rounded-full bg-yellow-400 text-[11px] font-bold text-yellow-900 shadow-sm border border-yellow-200">
              !
            </span>
          )}
          {activeLiveVoting && !hasPendingMobilePoll && (
            <span className="absolute -top-1.5 -left-1.5 flex h-3 w-3">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-300 opacity-75"></span>
              <span className="relative inline-flex h-3 w-3 rounded-full bg-emerald-200"></span>
            </span>
          )}
          <svg xmlns="http://www.w3.org/2000/svg" width={(hasPendingMobilePoll || activeLiveVoting) ? 24 : 20} height={(hasPendingMobilePoll || activeLiveVoting) ? 24 : 20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><path d="M18 20V10"></path><path d="M12 20V4"></path><path d="M6 20v-6"></path></svg>
          {(hasPendingMobilePoll || activeLiveVoting) && <span className="text-base font-bold whitespace-nowrap">{activeLiveVoting ? 'Live voting' : 'New poll'}</span>}
        </button>
      </div>

      <header className="flex shrink-0 items-center border-b border-gray-200 bg-white px-4 md:px-6 py-3 transition-colors duration-300 dark:border-gray-800 dark:bg-[#131314]">
        <div className="mx-auto flex w-full max-w-7xl flex-row items-center justify-between gap-2">
          <div className="flex items-center gap-2 md:gap-3 flex-1 min-w-0">
            <img src={cimeLogo} alt="CIME Logo" className="h-8 md:h-10 w-auto object-contain shrink-0" />
            <div className="min-w-0 flex-1">
              <h1 className="text-base md:text-lg font-semibold text-gray-900 dark:text-gray-100 truncate">{displayedRoom?.name || `Room #${numericRoomId}`}</h1>
              <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
                Signed in as {user?.username} · {displayedRoom?.participant_count || 0} participant{displayedRoom?.participant_count === 1 ? '' : 's'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {activeTimerExpiresAt && (
              <span className={`rounded-full px-2 py-1 md:px-4 md:py-1.5 text-sm md:text-xl font-extrabold shadow-sm border transition-all duration-300 flex items-center gap-1.5 ${
                new Date(activeTimerExpiresAt).getTime() - nowMs <= 60000 
                  ? 'animate-pulse bg-red-100 text-red-700 border-red-200 dark:bg-red-950/60 dark:text-red-400 dark:border-red-900/50' 
                  : 'bg-indigo-100 text-indigo-700 border-indigo-200 dark:bg-indigo-950/60 dark:text-indigo-400 dark:border-indigo-900/50'
              }`}>
                ⏱ {(() => {
                  const diff = new Date(activeTimerExpiresAt).getTime() - nowMs;
                  if (diff <= 0) return '00:00';
                  const m = Math.floor(diff / 60000);
                  const s = Math.floor((diff % 60000) / 1000);
                  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
                })()}
              </span>
            )}
            <Link to="/agents" className="flex items-center justify-center gap-2 rounded-full border border-gray-200 bg-gray-50 p-2 md:px-4 md:py-2 text-sm font-medium text-gray-700 transition-all hover:bg-gray-100 dark:border-gray-800 dark:bg-[#1e1f20] dark:text-gray-200 dark:hover:bg-[#282a2c]" title="Agent Monitor">
              <MonitorIcon />
              <span className="hidden md:inline">Agent Monitor</span>
            </Link>
            <Link to="/dashboard" className="flex items-center justify-center gap-2 rounded-full border border-gray-200 bg-gray-50 p-2 md:px-4 md:py-2 text-sm font-medium text-gray-700 transition-all hover:bg-gray-100 dark:border-gray-800 dark:bg-[#1e1f20] dark:text-gray-200 dark:hover:bg-[#282a2c]" title="Back to Dashboard">
              <DashboardIcon />
              <span className="hidden md:inline">Back to Dashboard</span>
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto flex-1 min-h-0 w-full gap-4 px-4 py-4 flex flex-col md:grid max-w-7xl md:grid-cols-[2fr_1fr]">
        <section className="flex min-h-0 flex-1 flex-col">
          {error ? <p className="mb-3 rounded bg-red-900/50 p-2 text-sm text-red-200">{error}</p> : null}
          {displayedRoom?.collection_complete && displayedRoom?.room_type === 'personal' ? (
            <div className="mb-3 rounded border border-red-500/30 bg-red-900/50 p-3 text-sm text-red-100 flex flex-wrap items-center justify-between gap-2">
              <span>{displayedRoom?.collection_banner || 'Quality Agent has enough information and is waiting for the other participants.'}</span>
              <span className="text-xs text-red-200/80 italic animate-pulse">
                Waiting for other participants to finish...
              </span>
            </div>
          ) : null}
          {displayedRoom?.collection_complete && displayedRoom?.room_type === 'group' ? (
            <div className="mb-3 rounded bg-amber-900/50 p-3 text-sm text-amber-100 flex flex-wrap items-center justify-between gap-2">
              <span>{displayedRoom?.collection_banner || 'Quality Agent has enough info from this room. Please wait while other users finish.'}</span>
              <button
                onClick={() => { fetchRecapReport().then((rep) => { if (rep) setShowRecapModal(true); }); }}
                className="shrink-0 rounded-full bg-amber-500 px-4 py-1.5 text-xs font-semibold text-amber-950 hover:bg-amber-400 transition-colors"
              >
                View draft report
              </button>
              {!activeNextRoom && (
                <span className="text-xs text-amber-200/80 italic animate-pulse">
                  Waiting for other participants to finish...
                </span>
              )}
            </div>
          ) : null}
          <div className="relative mb-4 h-full min-h-0">
            <div
              ref={messageListRef}
              onScroll={(e) => setShowScrollButton(e.target.scrollHeight - e.target.scrollTop - e.target.clientHeight > 100)}
              className="h-full space-y-3 overflow-y-auto overscroll-contain rounded-3xl border border-gray-200 bg-white p-4 shadow-sm scrollbar-thin scrollbar-track-transparent scrollbar-thumb-gray-300 dark:border-gray-800 dark:bg-[#1e1f20] dark:scrollbar-track-[#131314] dark:scrollbar-thumb-gray-700 transition-colors duration-300"
            >
              {messages.map((msg) => (
                <MessageBubble
                  key={msg.id}
                  message={msg}
                  currentUserId={user?.id}
                  onViewSummary={msg.is_bot && msg.text.includes('[View Summary]') ? () => {
                    fetchRecapReport().then((rep) => {
                      if (rep) setShowRecapModal(true);
                    });
                  } : undefined}
                  onReopenTopic={handleReopenTopic}
                  onAgree={handleAgree}
                  convergenceStatus={convergenceStatus}
                  locallyReopened={locallyReopened}
                  locallyAgreed={locallyAgreed}
                />
              ))}
              <div ref={bottomRef} />
            </div>
            {showScrollButton && (
              <button
                onClick={() => scrollListToBottom(true)}
                className="absolute bottom-6 right-6 z-20 rounded-full bg-blue-600 p-3 text-white shadow-lg transition-all hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-400 animate-fade-in"
                title="Scroll to bottom"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><polyline points="19 12 12 19 5 12"></polyline></svg>
              </button>
            )}
          </div>
          <div className="flex gap-3 items-end">
            <textarea
              ref={textareaRef}
              rows={1}
              disabled={displayedRoom?.is_active === false && !displayedRoom?.collection_complete}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  sendMessage();
                }
              }}
              placeholder={displayedRoom?.room_type === 'personal' ? 'Type message.' : 'Type message. Mention @bot to trigger the assistant'}
              className="flex-1 resize-none rounded-3xl border border-gray-200 bg-gray-50 px-6 py-3 outline-none transition-all focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-800 dark:bg-[#282a2c] dark:text-gray-100 leading-relaxed scrollbar-thin scrollbar-track-transparent scrollbar-thumb-gray-300 dark:scrollbar-thumb-gray-700"
              style={{ maxHeight: `${MAX_INPUT_HEIGHT}px` }}
            />
            <button
              disabled={(displayedRoom?.is_active === false && !displayedRoom?.collection_complete) || !text.trim()}
              onClick={sendMessage}
              aria-label="Send message"
              title="Send"
              // Tapping a button normally steals focus from whatever was focused, which closes
              // the on-screen keyboard on mobile. Preventing the default on mousedown/touchstart
              // stops that focus shift before it happens, so the keyboard stays open — matching
              // how WhatsApp and other chat apps keep it open after you hit send.
              onMouseDown={(e) => e.preventDefault()}
              onTouchStart={(e) => e.preventDefault()}
              className="shrink-0 flex h-12 w-12 items-center justify-center rounded-full bg-blue-600 text-white shadow-sm transition-all duration-300 hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-400 active:scale-95 disabled:pointer-events-none disabled:opacity-40"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="19" x2="12" y2="5"></line>
                <polyline points="5 12 12 5 19 12"></polyline>
              </svg>
            </button>
          </div>
        </section>

        <aside className="hidden md:flex h-full min-h-0 flex-col gap-4 shrink">
          {(displayedRoom?.room_type === 'group' || displayedRoom?.room_type === 'convergence') && (
            <div className="flex-[0.4] overflow-y-auto rounded-3xl border border-gray-200 bg-white p-6 shadow-sm scrollbar-thin scrollbar-track-transparent scrollbar-thumb-gray-300 dark:border-gray-800 dark:bg-[#1e1f20] dark:scrollbar-track-[#131314] dark:scrollbar-thumb-gray-700 transition-colors duration-300">
              {renderRoomStatus()}
            </div>
          )}
          {renderPolls()}
        </aside>
      </main>
    </div>
  );
}
