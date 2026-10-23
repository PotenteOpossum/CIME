import React, { useState, useEffect } from 'react';

export default function GlobalAlert() {
  const [messages, setMessages] = useState([]);
  const [confirmState, setConfirmState] = useState(null);

  useEffect(() => {
    const originalAlert = window.alert;
    
    window.alert = (msg) => {
      setMessages((prev) => [...prev, String(msg)]);
    };

    window.confirmAsync = (msg) => {
      return new Promise((resolve) => {
        setConfirmState({ message: String(msg), resolve });
      });
    };

    return () => {
      window.alert = originalAlert;
      delete window.confirmAsync;
    };
  }, []);

  const handleCloseAlert = () => {
    setMessages((prev) => prev.slice(1));
  };

  const handleConfirm = () => {
    if (confirmState) {
      confirmState.resolve(true);
      setConfirmState(null);
    }
  };

  const handleCancel = () => {
    if (confirmState) {
      confirmState.resolve(false);
      setConfirmState(null);
    }
  };

  if (messages.length === 0 && !confirmState) return null;

  const isConfirm = !!confirmState;
  const currentMessage = isConfirm ? confirmState.message : messages[0];

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm transition-all duration-300">
      <div className="w-full max-w-sm rounded-2xl border border-gray-200 bg-white p-6 shadow-2xl dark:border-gray-700 dark:bg-[#1c1a17] transform scale-100 animate-in fade-in zoom-in duration-200">
        <div className="mb-4 flex items-center gap-3">
          <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${isConfirm ? 'bg-amber-100 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400' : 'bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400'}`}>
            {isConfirm ? (
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            )}
          </div>
          <h3 className="text-lg font-bold text-gray-900 dark:text-gray-100">
            {isConfirm ? 'Confirm Action' : 'Notice'}
          </h3>
        </div>
        
        <p className="mb-6 text-sm text-gray-600 dark:text-gray-400 whitespace-pre-wrap">{currentMessage}</p>
        
        <div className="flex justify-end gap-3">
          {isConfirm && (
            <button
              onClick={handleCancel}
              className="rounded-full bg-gray-100 px-5 py-2.5 text-sm font-semibold text-gray-700 transition hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700 focus:outline-none"
            >
              Cancel
            </button>
          )}
          <button
            onClick={isConfirm ? handleConfirm : handleCloseAlert}
            className={`rounded-full px-6 py-2.5 text-sm font-semibold text-white shadow-sm transition focus:outline-none focus:ring-2 focus:ring-offset-2 dark:focus:ring-offset-[#1c1a17] ${isConfirm ? 'bg-amber-600 hover:bg-amber-700 focus:ring-amber-500' : 'bg-blue-600 hover:bg-blue-700 focus:ring-blue-500'}`}
          >
            {isConfirm ? 'Confirm' : 'OK'}
          </button>
        </div>
      </div>
    </div>
  );
}
