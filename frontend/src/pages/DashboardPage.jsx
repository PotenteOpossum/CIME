import { useEffect, useState, useRef } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { io } from 'socket.io-client';
import { apiRequest } from '../api/client.js';
import { useAuth } from '../contexts/AuthContext.jsx';
import cimeLogo from '../img/CIME_LOGO.png';
import RecapModal from '../components/RecapModal.jsx';

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:4000';

const SunIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>;
const MoonIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>;


function formatText(text) {
  if (!text) return '';
  return text
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*([^*]+)\*/g, '<strong>$1</strong>')
    .replace(/_([^_]+)_/g, '<em>$1</em>');
}

function ProcessModal({ data, onClose }) {
  const [page, setPage] = useState(1);
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
  }, [page, data]);

  const nextPage = () => {
    if (canProceed && page === 1) setPage(2);
  };

  const handleClose = () => {
    if (canProceed && page === 2) onClose();
  };

  const page1Content = (
    <>
      <h2 className="mb-4 text-3xl font-bold text-slate-900 dark:text-slate-100">Welcome to CIME</h2>
      <div className="prose dark:prose-invert text-slate-700 dark:text-slate-300 leading-relaxed text-lg">
        <p>
          CIME is a platform designed to facilitate
          structured decision-making processes through interactive chats.
        </p>
        <p className="mt-4">
          <strong>How it works:</strong>
        </p>
        <ul className="list-disc pl-5 mt-2 space-y-2">
          <li><strong>Personal Phase:</strong> You will first discuss the topic in a one-on-one chat with an AI facilitator to gather your initial preferences.</li>
          <li><strong>Group Phase:</strong> Based on your answers, you may be grouped with other participants to debate and find common ground.</li>
          <li><strong>Voting:</strong> At various stages, the AI will propose polls to see if the group has reached a consensus.</li>
        </ul>
        <p className="mt-4">
          Your input is crucial for the final decision. Please engage actively and express your opinions clearly. Scroll to the bottom to continue.
        </p>
      </div>
    </>
  );

  const page2Content = (
    <>
      <h2 className="mb-4 text-3xl font-bold text-slate-900 dark:text-slate-100">{data.globalQuestion}</h2>
      {data.generalDescription && (
        <p
          className="whitespace-pre-wrap text-slate-700 dark:text-slate-300 leading-relaxed text-lg"
          dangerouslySetInnerHTML={{ __html: formatText(data.generalDescription) }}
        />
      )}
    </>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="w-full max-w-2xl rounded-3xl bg-white p-8 shadow-xl dark:bg-[#1e1f20] border border-gray-200 dark:border-gray-800 flex flex-col max-h-[85vh] transition-colors duration-300">
        <div ref={scrollRef} onScroll={checkScroll} className="flex-1 overflow-y-auto pr-2 mb-6">
          {page === 1 ? page1Content : page2Content}
        </div>
        <div className="flex items-center justify-between pt-4 border-t border-slate-200 dark:border-slate-700 shrink-0">
          <div className="text-sm text-slate-500 font-medium">Page {page} of 2</div>
          <div>
            {page === 1 ? (
              <button onClick={nextPage} disabled={!canProceed} className="rounded-full bg-blue-600 px-6 py-3 text-white font-medium transition-all hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-400 disabled:opacity-50 disabled:cursor-not-allowed shadow-sm">
                Next
              </button>
            ) : (
              <button onClick={handleClose} disabled={!canProceed} className="rounded-full bg-blue-600 px-6 py-3 text-white font-medium transition-all hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-400 disabled:opacity-50 disabled:cursor-not-allowed shadow-sm">
                Start
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}


export default function DashboardPage() {
  const { token, user, logout } = useAuth();
  const [rooms, setRooms] = useState(() => {
    try {
      const saved = sessionStorage.getItem('cime_user_rooms_cache');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });
  const [error, setError] = useState('');
  const [modalData, setModalData] = useState(null);
  const [showLogoutModal, setShowLogoutModal] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const [recapReport, setRecapReport] = useState(location.state?.recapReport || null);

  const [isDark, setIsDark] = useState(() => {
    if (typeof document !== 'undefined') {
      return document.documentElement.classList.contains('dark');
    }
    return false;
  });

  const toggleTheme = () => {
    const next = !isDark;
    setIsDark(next);
  };

  useEffect(() => {
    if (isDark) {
      document.documentElement.classList.add('dark');
      localStorage.setItem('theme', 'dark');
    } else {
      document.documentElement.classList.remove('dark');
      localStorage.setItem('theme', 'light');
    }
  }, [isDark]);

  const loadRooms = () => {
    return apiRequest('/rooms', {}, token)
      .then((data) => {
        const nextRooms = data.rooms || [];
        if (nextRooms.length > 0) {
          setRooms(nextRooms);
          try {
            sessionStorage.setItem('cime_user_rooms_cache', JSON.stringify(nextRooms));
          } catch {
            // Ignore storage quota / privacy mode failures.
          }
        }
      })
      .catch((err) => {
        setError(err.message);
      });
  };

  useEffect(() => {
    let mounted = true;

    loadRooms().then(() => {
      if (!mounted) return;
      setError('');
    });

    return () => {
      mounted = false;
    };
  }, [token]);

  useEffect(() => {
    const socket = io(SOCKET_URL, {
      auth: { token },
      transports: ['websocket', 'polling']
    });
    socket.on('rooms_updated', () => loadRooms());
    socket.on('process_started', (data) => {
      localStorage.removeItem('seen_process_modal');
      const tokenToStore = data.globalQuestion + '_' + (data.process_started_at || Date.now());
      setModalData({ ...data, tokenToStore });
    });
    socket.on('convergence_completed', (payload) => {
      setRecapReport(payload.report);
    });
    return () => socket.disconnect();
  }, [token]);

  useEffect(() => {
    apiRequest('/decision', {}, token)
      .then((decision) => {
        if (decision) {
          if (decision.current_phase === 'idle') {
            localStorage.removeItem('seen_process_modal');
          } else {
            const seenToken = localStorage.getItem('seen_process_modal');
            const tokenToStore = decision.global_question + '_' + (decision.process_started_at || 'unknown');
            if (seenToken !== tokenToStore) {
              setModalData({
                globalQuestion: decision.global_question,
                generalDescription: decision.general_description,
                tokenToStore
              });
            }
          }
        }
      })
      .catch(() => { });
  }, [token]);

  const onLogout = () => {
    logout();
    navigate('/login');
  };

  const closeModal = () => {
    if (modalData?.tokenToStore) {
      localStorage.setItem('seen_process_modal', modalData.tokenToStore);
    } else if (modalData?.globalQuestion) {
      localStorage.setItem('seen_process_modal', modalData.globalQuestion);
    }
    setModalData(null);
  };

  const handleFinish = () => {
    navigate(location.pathname, { replace: true, state: {} });
    logout();
    navigate('/login');
  };

  return (
    <div className="min-h-screen bg-white p-6 text-gray-900 transition-colors duration-300 dark:bg-[#131314] dark:text-gray-100">
      {modalData && <ProcessModal data={modalData} onClose={closeModal} />}
      {recapReport && (
        <RecapModal
          report={recapReport}
          onClose={handleFinish}
          buttonText="Finish"
          title="Process Completed"
          subtitle="Recap of all decisions taken in Convergence Round"
        />
      )}
      <div className="mx-auto max-w-3xl">
        <div className="mb-6 flex items-start justify-between">
          <div className="flex items-start gap-3">
            <img src={cimeLogo} alt="CIME Logo" className="mt-1 h-10 md:h-12 w-auto object-contain shrink-0" />
            <div>
              <h1 className="text-xl md:text-2xl font-bold text-slate-900 dark:text-slate-100">Your Rooms</h1>
              <p className="text-sm md:text-base text-slate-500 dark:text-slate-400">Signed in as {user?.username}</p>
              
              {/* Mobile: Docs and Agent Monitor buttons under user info */}
              <div className="mt-3 flex gap-3 md:hidden">
                <Link to="/doc" className="flex items-center justify-center h-10 w-10 rounded-full border border-gray-200 bg-gray-50 text-gray-700 transition-all hover:bg-gray-100 dark:border-gray-800 dark:bg-[#1e1f20] dark:text-gray-200 dark:hover:bg-[#282a2c]" title="Docs">
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>
                </Link>
                <Link to="/agents" className="flex items-center justify-center h-10 w-10 rounded-full border border-blue-500/30 bg-blue-50/50 text-blue-700 transition-all hover:bg-blue-100 dark:bg-blue-500/10 dark:text-blue-200 dark:hover:bg-blue-500/20" title="Agent Monitor">
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>
                </Link>
              </div>
            </div>
          </div>
          
          <div className="flex gap-3 mt-1 md:mt-0">
            {/* Desktop: Docs and Agent Monitor buttons inline */}
            <div className="hidden md:flex gap-3">
              <Link to="/doc" className="flex items-center gap-2 rounded-full border border-gray-200 bg-gray-50 px-5 py-2.5 text-sm font-medium text-gray-700 transition-all hover:bg-gray-100 dark:border-gray-800 dark:bg-[#1e1f20] dark:text-gray-200 dark:hover:bg-[#282a2c]">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>
                <span>Docs</span>
              </Link>
              <Link to="/agents" className="flex items-center gap-2 rounded-full border border-blue-500/30 bg-blue-50/50 px-5 py-2.5 text-sm font-medium text-blue-700 transition-all hover:bg-blue-100 dark:bg-blue-500/10 dark:text-blue-200 dark:hover:bg-blue-500/20">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>
                <span>Agent Monitor</span>
              </Link>
            </div>
            {/* Both Mobile & Desktop: Logout button on the right */}
            <button
              onClick={() => setShowLogoutModal(true)}
              className="flex items-center justify-center h-10 w-10 md:h-auto md:w-auto md:gap-2 rounded-full border border-gray-200 bg-white md:px-5 md:py-2.5 text-sm font-medium text-gray-700 transition-all hover:bg-gray-50 dark:border-gray-800 dark:bg-[#1e1f20] dark:text-gray-200 dark:hover:bg-[#282a2c] cursor-pointer"
              title="Logout"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg>
              <span className="hidden md:inline">Logout</span>
            </button>
          </div>
        </div>

        {error ? <p className="mb-4 text-red-400">{error}</p> : null}

        <div className="grid gap-4">
          {rooms.map((room) => (
            <Link
              key={room.id}
              to={`/chat/${room.id}`}
              className="group rounded-3xl border border-gray-200 bg-white p-6 shadow-sm transition-all duration-300 hover:shadow-md hover:border-gray-300 dark:border-gray-800 dark:bg-[#1e1f20] dark:hover:bg-[#282a2c] dark:hover:border-gray-700"
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xl font-semibold text-gray-900 transition-colors group-hover:text-blue-600 dark:text-gray-100 dark:group-hover:text-blue-400">{room.name}</p>
                  <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                    Open room #{room.id} · {room.participant_count || 0} participant{room.participant_count === 1 ? '' : 's'}
                  </p>
                </div>
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gray-100 text-gray-500 transition-colors group-hover:bg-blue-600 group-hover:text-white dark:bg-[#282a2c] dark:text-gray-400">
                  →
                </div>
              </div>
            </Link>
          ))}

          {!rooms.length && !error ? (
            <div className="rounded-3xl border border-gray-200 bg-gray-50 p-8 text-center text-gray-500 shadow-sm dark:border-gray-800 dark:bg-[#1e1f20] dark:text-gray-400">
              No rooms assigned at the moment. Please wait for an admin to invite you.
            </div>
          ) : null}
        </div>
      </div>
      {showLogoutModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 animate-fade-in backdrop-blur-sm" onClick={() => setShowLogoutModal(false)}>
          <div className="w-full max-w-sm rounded-3xl bg-white p-6 shadow-xl dark:bg-[#1e1f20] border border-gray-200 dark:border-gray-800 text-center" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-xl font-bold text-gray-900 dark:text-gray-100 mb-2">Logout</h3>
            <p className="text-gray-600 dark:text-gray-400 mb-6">Are you sure you want to log out?</p>
            <div className="flex gap-3 justify-center">
              <button 
                onClick={() => setShowLogoutModal(false)}
                className="rounded-full px-6 py-2.5 text-sm font-medium border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-200 transition-all cursor-pointer"
              >
                Cancel
              </button>
              <button 
                onClick={() => {
                  setShowLogoutModal(false);
                  onLogout();
                }}
                className="rounded-full px-6 py-2.5 text-sm font-medium bg-red-600 hover:bg-red-700 text-white transition-all shadow-sm cursor-pointer"
              >
                Logout
              </button>
            </div>
          </div>
        </div>
      )}
      <button onClick={toggleTheme} title={isDark ? 'Switch to Light Theme' : 'Switch to Dark Theme'} className="fixed bottom-6 left-6 z-40 flex h-12 w-12 items-center justify-center rounded-full border border-gray-200 bg-white text-gray-700 shadow-lg transition-all hover:bg-gray-50 dark:border-gray-700 dark:bg-[#1e1f20] dark:text-gray-200 dark:hover:bg-[#282a2c]">
        {isDark ? <SunIcon /> : <MoonIcon />}
      </button>
    </div>
  );
}
