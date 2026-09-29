import React from 'react';
import { renderMarkdown, downloadReportAsPdf } from '../utils/markdown.jsx';

export default function RecapModal({
  report,
  onClose,
  buttonText = 'Close',
  title = 'Process Completed',
  subtitle = 'Consensus Analysis & Compatibility Report'
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-fade-in transition-colors duration-300">
      <div className="w-full max-w-3xl rounded-3xl bg-white p-8 shadow-xl dark:bg-[#1e1f20] border border-gray-200 dark:border-gray-800 flex flex-col max-h-[85vh] text-gray-900 dark:text-gray-100 transition-colors duration-300">
        <div className="flex items-center gap-3 mb-6 border-b border-gray-200 dark:border-gray-800 pb-4 shrink-0">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-green-100 text-green-600 dark:bg-green-900/50 dark:text-green-400 font-bold text-lg">
            ✓
          </span>
          <div>
            <h2 className="text-2xl font-bold text-gray-900 dark:text-white">{title}</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">{subtitle}</p>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto pr-2 mb-6 space-y-4 scrollbar-thin scrollbar-thumb-gray-300 dark:scrollbar-thumb-gray-700 scrollbar-track-transparent">
          <div className="markdown-body">
            {renderMarkdown(report)}
          </div>
        </div>

        <div className="flex justify-between items-center pt-4 border-t border-gray-200 dark:border-gray-800 shrink-0">
          <button
            onClick={() => downloadReportAsPdf(title, report)}
            className="rounded-full border border-gray-200 bg-gray-50 px-5 py-3 text-gray-700 font-medium transition-all hover:bg-gray-100 dark:border-gray-800 dark:bg-[#282a2c] dark:text-gray-300 dark:hover:bg-gray-700 active:scale-95 flex items-center gap-2"
          >
            <span>📥</span> Save as PDF
          </button>
          <button
            onClick={onClose}
            className="rounded-full bg-blue-600 px-8 py-3 text-white font-medium transition-all hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-400 shadow-sm hover:shadow-md active:scale-95"
          >
            {buttonText}
          </button>
        </div>
      </div>
    </div>
  );
}
