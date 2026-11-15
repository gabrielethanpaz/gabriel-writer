// Fills the editable parts of index.html and en/index.html from the files in content/,
// which the admin page (/admin/) edits. Run with --check to only verify the pages are up to date.
//
// Text fields: each line becomes a paragraph; **bold** and *italic* are allowed
// (in the hero title, *text* is the highlighted part).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
// Work with \n line endings; the pages are written back with the line endings they had
const read = (f) => readFileSync(root + f, 'utf8').replace(/\r\n/g, '\n');
const crlf = (f) => readFileSync(root + f, 'utf8').includes('\r\n');
const content = Object.fromEntries(['inicio', 'biografia', 'obras'].map((n) => [n, JSON.parse(read(`content/${n}.json`))]));

const pages = [
  { lang: 'pt', file: 'index.html', base: '' },
  { lang: 'en', file: 'en/index.html', base: '../' },
];

const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const inline = (s, italic = 'em') =>
  escape(s.trim())
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, `<${italic}>$1</${italic}>`);
const paragraphs = (s) => String(s ?? '').split(/\n/).map((p) => p.trim()).filter(Boolean);

function need(value, what) {
  if (value === undefined || value === null || String(value).trim() === '') throw new Error(`Missing ${what}`);
  return String(value);
}
function needParagraphs(value, what) {
  const ps = paragraphs(value);
  if (!ps.length) throw new Error(`Missing ${what}`);
  return ps;
}

// Single elements, found by their opening tag: [opening tag, closing tag, render(lang data)]
const elements = [
  ['<h1 class="hero-title">', '</h1>', (c, l) => inline(need(c.inicio.titulo, `${l} hero title`), 'span')],
  ['<p class="hero-description">', '</p>', (c, l) => inline(need(c.inicio.descricao, `${l} hero description`))],
  ['<div class="badge-literary">', '</div>', (c, l) => inline(need(c.inicio.selo, `${l} hero badge`))],
  ['<p class="hero-launch"><span>', '</span></p>', (c, l) => inline(need(c.inicio.lancamento, `${l} launch line`))],
];

// Blocks between <!-- cms:name --> and <!-- /cms:name --> lines
const blocks = {
  numeros: (c, l) => {
    const items = c.inicio.numeros ?? [];
    if (!items.length) throw new Error(`Missing ${l} stats`);
    return items.map((s, i) => [
      `            <div class="stat-card reveal"${i ? ` style="transition-delay: ${(i / 10).toFixed(1)}s;"` : ''}>`,
      `                <div class="stat-number">${inline(need(s.numero, `${l} stat number`))}</div>`,
      `                <div class="stat-label">${inline(need(s.legenda, `${l} stat label`))}</div>`,
      `            </div>`,
    ].join('\n')).join('\n');
  },
  biografia: (c, l) => {
    const body = needParagraphs(c.biografia.texto, `${l} biography text`);
    return [
      `                <p class="bio-text-lead">${inline(need(c.biografia.introducao, `${l} biography introduction`))}</p>`,
      '                ',
      body.map((p) => `                <p class="bio-text-body">${inline(p)}</p>`).join('\n\n'),
    ].join('\n');
  },
  livros: (c, l, base) => {
    const books = c.obras.livros ?? [];
    if (!books.length) throw new Error(`Missing ${l} books`);
    return books.map((b) => {
      const title = need(b.titulo, `${l} book title`);
      const [width, height] = [b.capa_largura, b.capa_altura].map(Number);
      if (!(width > 0 && height > 0)) throw new Error(`Missing cover size of ${title}`);
      const lines = [`            <div class="masonry-item reveal">`, `                <picture class="picture-wrapper">`];
      if (String(b.estado ?? '').trim()) lines.push(`                    <span class="status-badge">${inline(b.estado)}</span>`);
      lines.push(
        `                    <img src="${escape(base + need(b.capa, `cover of ${title}`))}" alt="${escape(need(b.capa_alt, `cover text of ${title}`))}" class="book-cover-img" loading="lazy" width="${width}" height="${height}">`,
        `                </picture>`,
        `                <span class="book-category">${inline(need(b.categoria, `${l} category of ${title}`))}</span>`,
        `                <h3>${inline(title)}</h3>`,
        ...needParagraphs(b.sinopse, `${l} synopsis of ${title}`).map((p) => `                <p>${inline(p)}</p>`),
        `            </div>`,
      );
      return lines.join('\n');
    }).join('\n\n');
  },
  antologias: (c, l) => (c.obras.antologias ?? []).map((a) => {
    const lines = [
      `                <li>`,
      `                    <strong>${inline(need(a.nome, `${l} anthology name`))}</strong>`,
      `                    ${inline(need(a.descricao, `${l} description of ${a.nome}`))}`,
    ];
    if (String(a.nota ?? '').trim()) lines.push(`                    <small>${inline(a.nota)}</small>`);
    lines.push(`                </li>`);
    return lines.join('\n');
  }).join('\n'),
};

function build({ lang, file, base }) {
  const c = Object.fromEntries(Object.entries(content).map(([n, v]) => {
    if (!v[lang]) throw new Error(`content/${n}.json has no "${lang}" section`);
    return [n, v[lang]];
  }));
  let html = read(file);
  for (const [open, close, render] of elements) {
    const parts = html.split(open);
    if (parts.length !== 2) throw new Error(`${file}: expected one ${open}`);
    const end = parts[1].indexOf(close);
    if (end < 0) throw new Error(`${file}: ${open} is not closed`);
    html = parts[0] + open + render(c, lang) + parts[1].slice(end);
  }
  for (const [name, render] of Object.entries(blocks)) {
    const re = new RegExp(`(<!-- cms:${name} -->\\n)[\\s\\S]*?(\\n[ ]*<!-- /cms:${name} -->)`);
    if (!re.test(html)) throw new Error(`${file}: markers for "${name}" not found`);
    const out = render(c, lang, base);
    html = html.replace(re, (_, a, b) => a + out + b);
  }
  return html;
}

const check = process.argv.includes('--check');
let stale = false;
// build both pages before writing either, so an error leaves both untouched
for (const [page, html] of pages.map((p) => [p, build(p)])) {
  if (html === read(page.file)) continue;
  stale = true;
  if (check) console.log(`${page.file} is out of date`);
  else {
    writeFileSync(root + page.file, crlf(page.file) ? html.replace(/\n/g, '\r\n') : html);
    console.log(`updated ${page.file}`);
  }
}
if (check && stale) process.exit(1);
if (!stale) console.log('pages already up to date');
