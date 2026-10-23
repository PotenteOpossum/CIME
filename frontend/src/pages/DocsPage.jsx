import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { wikiDocs } from '../docs/wikiContent.js';
import cimeLogo from '../img/CIME_LOGO.png';
import { renderMarkdown } from '../utils/markdown.jsx';

export default function DocsPage() {
  const [activeSlug, setActiveSlug] = useState(wikiDocs[0]?.slug || '');
  const [searchQuery, setSearchQuery] = useState('');

  const filteredDocs = useMemo(() => {
    const query = searchQuery.toLowerCase().trim();
    if (!query) return wikiDocs;
    return wikiDocs.filter(
      (doc) =>
        doc.title.toLowerCase().includes(query) ||
        doc.file.toLowerCase().includes(query) ||
        (doc.markdown || '').toLowerCase().includes(query)
    );
  }, [searchQuery]);

  const activeDoc = wikiDocs.find((doc) => doc.slug === activeSlug) || filteredDocs[0] || wikiDocs[0];

  const handleDocLink = useCallback((target) => {
    const normalized = String(target || '').replace(/^\.?\//, '').toLowerCase();
    const targetSlug = normalized.replace(/\.md$/, '');
    const targetDoc = wikiDocs.find((doc) => doc.slug === targetSlug || doc.file.toLowerCase() === normalized);
    if (targetDoc) {
      setActiveSlug(targetDoc.slug);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, []);

  const rendered = useMemo(() => renderMarkdown(activeDoc?.markdown || '', handleDocLink), [activeDoc]);

  return (
    // The docs page is always dark-styled; the `dark` class makes the shared
    // theme-aware markdown renderer use its dark palette here.
    <div className="dark min-h-screen bg-[#141413] text-slate-100">
      <header className="border-b border-cyan-900/40 bg-[#1c1a17]/95 px-5 py-4 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <img src={cimeLogo} alt="CIME Logo" className="h-12 w-auto object-contain" />
            <div>
              <p className="text-xs uppercase tracking-[0.35em] text-cyan-300">CIME Wiki</p>
              <h1 className="text-2xl font-black text-white">Documentation</h1>
            </div>
          </div>
          <div className="flex gap-2">
            <Link to="/dashboard" className="rounded-lg border border-slate-600 px-4 py-2 text-sm hover:bg-slate-800">Dashboard</Link>
          </div>
        </div>
      </header>

      <main id="top" className="mx-auto grid max-w-7xl gap-6 px-5 py-6 lg:grid-cols-[320px_1fr]">
        <aside className="h-fit rounded-2xl border border-cyan-900/40 bg-slate-950/60 p-4 lg:sticky lg:top-5">
          <h2 className="mb-3 text-sm font-bold uppercase tracking-widest text-cyan-300">Pages</h2>
          <div className="mb-3">
            <input
              type="text"
              placeholder="Search docs..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full rounded border border-cyan-800/40 bg-slate-900 px-3 py-1.5 text-sm text-slate-100 placeholder-slate-400 outline-none focus:border-cyan-500"
            />
          </div>
          <nav className="max-h-[70vh] space-y-1 overflow-y-auto pr-1">
            {filteredDocs.map((doc) => (
              <button
                key={doc.slug}
                onClick={() => setActiveSlug(doc.slug)}
                className={`w-full rounded-lg px-3 py-2 text-left text-sm transition ${doc.slug === activeDoc.slug ? 'bg-cyan-500 text-slate-950' : 'text-slate-300 hover:bg-slate-800 hover:text-white'}`}
              >
                <span className="block font-semibold">{doc.title}</span>
                <span className="text-xs opacity-70">{doc.file}</span>
              </button>
            ))}
            {filteredDocs.length === 0 ? (
              <p className="p-2 text-xs text-slate-500">No matching pages.</p>
            ) : null}
          </nav>
        </aside>

        <article className="rounded-3xl border border-cyan-900/40 bg-slate-950/70 p-5 shadow-2xl shadow-cyan-950/30 md:p-8">
          {rendered}
        </article>
      </main>
    </div>
  );
}
