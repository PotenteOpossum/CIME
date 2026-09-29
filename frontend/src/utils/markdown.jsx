import React from 'react';

export function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

export function inlineMarkdown(text, onDocLink) {
  const parts = [];
  let remaining = text;
  let index = 0;
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[([^\]]+)\]\(([^)]+)\))/;
  while (remaining.length) {
    const match = remaining.match(pattern);
    if (!match) {
      parts.push(remaining);
      break;
    }
    if (match.index > 0) parts.push(remaining.slice(0, match.index));
    const token = match[0];
    if (token.startsWith('`')) {
      parts.push(<code key={`code-${index}`} className="rounded bg-slate-200 px-1 py-0.5 text-cyan-700 dark:bg-slate-800 dark:text-cyan-200">{token.slice(1, -1)}</code>);
    } else if (token.startsWith('**')) {
      parts.push(<strong key={`strong-${index}`}>{token.slice(2, -2)}</strong>);
    } else {
      const href = match[3];
      const wikiFileMatch = href.match(/(?:^\.\/|^\/)?([^/#?]+\.md)(?:[#?].*)?$/);
      if (wikiFileMatch && typeof onDocLink === 'function') {
        parts.push(
          <button
            key={`link-${index}`}
            type="button"
            onClick={() => onDocLink(wikiFileMatch[1])}
            className="text-cyan-700 underline decoration-cyan-500/60 hover:text-cyan-900 dark:text-cyan-300 dark:hover:text-cyan-100"
          >
            {match[2]}
          </button>
        );
      } else {
        parts.push(<a key={`link-${index}`} href={href} className="text-cyan-700 underline decoration-cyan-500/60 hover:text-cyan-900 dark:text-cyan-300 dark:hover:text-cyan-100">{match[2]}</a>);
      }
    }
    remaining = remaining.slice((match.index || 0) + token.length);
    index += 1;
  }
  return parts;
}

export function renderMarkdown(markdown, onDocLink) {
  const blocks = [];
  const lines = String(markdown || '').split('\n');
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }

    if (line.startsWith('```')) {
      const language = line.slice(3).trim();
      const code = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith('```')) {
        code.push(lines[i]);
        i += 1;
      }
      i += 1;
      blocks.push(
        <pre key={`pre-${key++}`} className="my-4 overflow-x-auto rounded-xl border border-slate-300 bg-slate-100 p-4 text-sm text-slate-800 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100">
          {language ? <div className="mb-2 text-xs uppercase tracking-wide text-slate-500">{language}</div> : null}
          <code>{code.join('\n')}</code>
        </pre>
      );
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2];
      const id = slugify(text);
      const className = level === 1
        ? 'mb-5 mt-1 text-4xl font-black tracking-tight text-slate-900 dark:text-white'
        : level === 2
          ? 'mb-3 mt-8 border-t border-slate-300 pt-6 text-2xl font-bold text-slate-900 dark:border-slate-800 dark:text-white'
          : level === 3
            ? 'mb-2 mt-6 text-xl font-semibold text-cyan-800 dark:text-cyan-100'
            : 'mb-2 mt-4 text-lg font-semibold text-slate-800 dark:text-slate-100';
      const Tag = `h${Math.min(level, 4)}`;
      blocks.push(<Tag key={`h-${key++}`} id={id} className={className}>{text}</Tag>);
      i += 1;
      continue;
    }

    if (line.startsWith('- ')) {
      const items = [];
      while (i < lines.length && lines[i].startsWith('- ')) {
        items.push(lines[i].slice(2));
        i += 1;
      }
      blocks.push(
        <ul key={`ul-${key++}`} className="my-4 list-disc space-y-2 pl-6 text-slate-700 dark:text-slate-300">
          {items.map((item, itemIndex) => <li key={itemIndex}>{inlineMarkdown(item, onDocLink)}</li>)}
        </ul>
      );
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s+/, ''));
        i += 1;
      }
      blocks.push(
        <ol key={`ol-${key++}`} className="my-4 list-decimal space-y-2 pl-6 text-slate-700 dark:text-slate-300">
          {items.map((item, itemIndex) => <li key={itemIndex}>{inlineMarkdown(item, onDocLink)}</li>)}
        </ol>
      );
      continue;
    }

    const paragraph = [line];
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].startsWith('#') &&
      !lines[i].startsWith('- ') &&
      !/^\d+\.\s+/.test(lines[i]) &&
      !lines[i].startsWith('```')
    ) {
      paragraph.push(lines[i]);
      i += 1;
    }
    blocks.push(<p key={`p-${key++}`} className="my-3 leading-7 text-slate-700 dark:text-slate-300">{inlineMarkdown(paragraph.join(' '), onDocLink)}</p>);
  }

  return blocks;
}

export function convertMarkdownToHtml(markdown) {
  const lines = String(markdown || '').split('\n');
  let i = 0;
  let html = '';

  const inline = (text) => {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  };

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }

    if (line.startsWith('```')) {
      const code = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith('```')) {
        code.push(lines[i]);
        i += 1;
      }
      i += 1;
      html += `<pre><code>${code.join('\n')}</code></pre>\n`;
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2];
      html += `<h${level}>${inline(text)}</h${level}>\n`;
      i += 1;
      continue;
    }

    if (line.startsWith('- ')) {
      html += '<ul>\n';
      while (i < lines.length && lines[i].startsWith('- ')) {
        html += `  <li>${inline(lines[i].slice(2))}</li>\n`;
        i += 1;
      }
      html += '</ul>\n';
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      html += '<ol>\n';
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        html += `  <li>${inline(lines[i].replace(/^\d+\.\s+/, ''))}</li>\n`;
        i += 1;
      }
      html += '</ol>\n';
      continue;
    }

    if (line.trim() === '---') {
      html += '<hr />\n';
      i += 1;
      continue;
    }

    const paragraph = [line];
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].startsWith('#') &&
      !lines[i].startsWith('- ') &&
      !/^\d+\.\s+/.test(lines[i]) &&
      !lines[i].startsWith('```') &&
      lines[i].trim() !== '---'
    ) {
      paragraph.push(lines[i]);
      i += 1;
    }
    html += `<p>${inline(paragraph.join(' '))}</p>\n`;
  }
  return html;
}

export function downloadReportAsPdf(title, markdownText) {
  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    alert('Please allow popups to download the PDF.');
    return;
  }

  const htmlContent = convertMarkdownToHtml(markdownText);

  printWindow.document.write(`
    <html>
      <head>
        <title>${title}</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            line-height: 1.6;
            color: #1e293b;
            max-width: 800px;
            margin: 40px auto;
            padding: 0 20px;
          }
          h1 {
            font-size: 28px;
            font-weight: 800;
            color: #0f172a;
            border-bottom: 2px solid #e2e8f0;
            padding-bottom: 12px;
            margin-top: 0;
          }
          h2 {
            font-size: 20px;
            font-weight: 700;
            color: #1e293b;
            margin-top: 32px;
            border-bottom: 1px solid #f1f5f9;
            padding-bottom: 6px;
          }
          h3 {
            font-size: 16px;
            font-weight: 600;
            color: #475569;
            margin-top: 24px;
          }
          p {
            margin: 12px 0;
          }
          ul, ol {
            padding-left: 24px;
            margin: 12px 0;
          }
          li {
            margin-bottom: 6px;
          }
          code {
            background-color: #f1f5f9;
            color: #0f172a;
            padding: 2px 6px;
            border-radius: 4px;
            font-family: monospace;
            font-size: 14px;
          }
          pre {
            background-color: #f8fafc;
            border: 1px solid #e2e8f0;
            padding: 16px;
            border-radius: 8px;
            overflow-x: auto;
            font-family: monospace;
            font-size: 14px;
          }
          hr {
            border: 0;
            border-top: 1px solid #e2e8f0;
            margin: 24px 0;
          }
          @media print {
            body {
              margin: 20px;
              font-size: 12pt;
            }
          }
        </style>
      </head>
      <body>
        ${htmlContent}
        <script>
          window.onload = function() {
            window.print();
            setTimeout(function() { window.close(); }, 500);
          };
        </script>
      </body>
    </html>
  `);
  printWindow.document.close();
}
