// In-app guide: renders README.md (cached by the service worker, so it works offline).
// A small Markdown subset is enough: headings, paragraphs, lists, tables, code, bold, italic, links, images.
// The developer section and anything after it is left out of the app.

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(s) {
  const code = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => `\u0000${code.push(c) - 1}\u0000`);
  s = esc(s)
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => `<img src="${src}" alt="${alt}" loading="lazy">`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, href) => `<a href="${href}"${/^https?:/.test(href) ? ' target="_blank" rel="noopener"' : ''}>${t}</a>`)
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,])/g, (_, pre, u) => `${pre}<a href="${u}" target="_blank" rel="noopener">${u}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(code[i])}</code>`);
}

const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

export function guideHtml(md) {
  const lines = md.replace(/\r/g, '').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (/^## For developers/.test(l)) break;
    if (!l.trim()) { i++; continue; }
    if (l.startsWith('```')) {
      const body = [];
      for (i++; i < lines.length && !lines[i].startsWith('```'); i++) body.push(lines[i]);
      out.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`); i++; continue;
    }
    const h = l.match(/^(#{1,4})\s+(.*)/);
    if (h && h[1].length === 1) { i++; continue; } // the app shows its own title
    if (h) { out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }
    if (l.trim().startsWith('|') && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
      const head = cells(l); const rows = [];
      for (i += 2; i < lines.length && lines[i].trim().startsWith('|'); i++) rows.push(cells(lines[i]));
      const imgs = rows.length === 1 && rows[0].every((c) => /^!\[/.test(c));
      out.push(`<div class="tablewrap"><table class="${imgs ? 'shots' : ''}"><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    const li = /^\s*(?:[-*]|\d+\.)\s+/;
    if (li.test(l)) {
      const ordered = /^\s*\d+\./.test(l); const items = [];
      for (; i < lines.length && li.test(lines[i]); i++) items.push(lines[i].replace(li, ''));
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</${tag}>`);
      continue;
    }
    const para = [];
    for (; i < lines.length && lines[i].trim() && !/^(#|```|\s*\||\s*(?:[-*]|\d+\.)\s)/.test(lines[i]); i++) para.push(lines[i].trim());
    if (!para.length) { para.push(l.trim()); i++; }
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }
  return out.join('\n');
}

let cached = null;
export async function loadGuide() {
  if (cached) return cached;
  const res = await fetch('README.md');
  if (!res.ok) throw new Error('README ' + res.status);
  cached = guideHtml(await res.text());
  return cached;
}
