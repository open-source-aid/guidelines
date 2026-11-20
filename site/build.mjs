import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { Marked } from 'marked';

const [src, template, out] = process.argv.slice(2);
const files = readdirSync(src).filter(f => f === 'README.md' || /^\d\d-.*\.md$/.test(f)).sort((a, b) =>
  a === 'README.md' ? -1 : b === 'README.md' ? 1 : a.localeCompare(b));

const slug = s => s.trim().toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\w\- ]/g, '').replace(/ /g, '-');
const fileId = f => f === 'README.md' ? 'overview' : f.replace(/\.md$/, '').replace(/^(\d\d)-/, 'ch$1-');

function rewriteHref(href) {
  const m = href.match(/^((?:\d\d-[\w-]+|README)\.md)(?:#([\w-]+))?$/);
  if (!m) return null;
  const id = fileId(m[1]);
  return '#' + (m[2] ? `${id}--${m[2]}` : id);
}

const nav = [];
let body = '';
for (const f of files) {
  const md = readFileSync(join(src, f), 'utf8');
  const id = fileId(f);
  let first = true;
  let title = '';
  const sub = [];
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      heading(text, depth, raw) {
        if (first) { first = false; title = raw; return `<h1 class="ch-title">${text}</h1>\n`; }
        const hid = `${id}--${slug(raw)}`;
        if (depth === 2) sub.push({ hid, raw });
        return `<h${depth} id="${hid}"><a class="anchor" href="#${hid}" aria-label="Link to this heading">#</a>${text}</h${depth}>\n`;
      },
      link(href, t, text) {
        const local = rewriteHref(href);
        if (local) return `<a href="${local}">${text}</a>`;
        return `<a href="${href}" target="_blank" rel="noopener">${text}</a>`;
      },
      table(header, rows) {
        return `<div class="table-wrap"><table><thead>${header}</thead><tbody>${rows}</tbody></table></div>\n`;
      },
      code(code, lang) {
        const esc = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return `<div class="code-wrap"><pre><code${lang ? ` data-lang="${lang}"` : ''}>${esc}</code></pre></div>\n`;
      },
      checkbox(checked) {
        return `<input type="checkbox" class="check"${checked ? ' checked' : ''}> `;
      },
    },
  });
  let html = marked.parse(md);
  // status pills
  html = html.replace(/<strong>(Proposal|Current)<\/strong>/g, (_, w) => `<span class="pill pill-${w.toLowerCase()}">${w}</span>`);
  html = html.replace(/<strong>(Proposal(?: for 1\.0)?)<\/strong>/g, (_, w) => `<span class="pill pill-proposal">${w}</span>`);
  // RFC 2119 keywords, outside tags and code
  let inCode = 0;
  html = html.split(/(<[^>]+>)/).map(part => {
    if (part.startsWith('<')) {
      if (/^<(code|pre)\b/.test(part)) inCode++;
      if (/^<\/(code|pre)>/.test(part)) inCode--;
      return part;
    }
    if (inCode) return part;
    return part.replace(/\b(MUST NOT|SHOULD NOT|MUST|SHOULD|MAY)\b/g, '<span class="kw">$1</span>');
  }).join('');
  const appendix = title.startsWith('Appendix');
  const num = f === 'README.md' ? '' : appendix ? 'A' : f.slice(0, 2);
  const label = f === 'README.md' ? '' : appendix ? 'Appendix' : `Chapter ${+f.slice(0, 2)}`;
  nav.push({ id, title, sub, num });
  body += `<section class="chapter" id="${id}" data-label="${label}">\n${html}</section>\n`;
}

const navHtml = nav.map(n => `<li><a href="#${n.id}" data-target="${n.id}">${n.num ? `<span class="nav-num">${n.num}</span>` : '<span class="nav-num">—</span>'}<span>${n.title.replace(/^\d+\.\s*/, '').replace(/^Appendix:\s*/, '').replace('OS-AID Unified Driver Guideline', 'Overview')}</span></a></li>`).join('\n');

const tpl = readFileSync(template, 'utf8');
// Date of the build (CI sets SOURCE_DATE from the commit, so the page shows when the text last changed).
const when = process.env.SOURCE_DATE ? new Date(process.env.SOURCE_DATE) : new Date();
const date = when.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, tpl.replace('<!--NAV-->', navHtml).replace('<!--BODY-->', body).replace('<!--DATE-->', date));
console.log('chapters', nav.length, 'bytes', Buffer.byteLength(readFileSync(out)));
