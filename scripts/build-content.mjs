// Fills the editable parts of index.html and en/index.html from the files in content/,
// which the admin page (/admin/) edits. Run with --check to only verify the pages are up to date.
//
// Text fields: each line becomes a paragraph; **bold** and *italic* are allowed
// (in the hero title, *text* is the highlighted part). In the texts and poems, paragraphs are
// separated by an empty line and each line of a paragraph is a line of verse.
//
// inicio, biografia and obras have a "pt" and an "en" part; the other files keep both languages
// in one place, as fields ending in _pt and _en (so a photo or video is added once for both).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
// Work with \n line endings; the pages are written back with the line endings they had
const read = (f) => readFileSync(root + f, 'utf8').replace(/\r\n/g, '\n');
const crlf = (f) => readFileSync(root + f, 'utf8').includes('\r\n');
const content = Object.fromEntries(['inicio', 'biografia', 'obras'].map((n) => [n, JSON.parse(read(`content/${n}.json`))]));
const shared = Object.fromEntries(['textos', 'galeria', 'videos', 'imprensa', 'entrevistas'].map((n) => [n, JSON.parse(read(`content/${n}.json`))]));

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

// [width, height] of a JPEG, PNG or WebP image in the repository, or null if it can't be read,
// so a new cover uploaded in the editor gets its real proportions on the page
function imageSize(path) {
  let b;
  try { b = readFileSync(root + String(path).trim().replace(/^\/+/, '')); } catch { return null; }
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return [b.readUInt32BE(16), b.readUInt32BE(20)];
  if (b.length > 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const kind = b.toString('ascii', 12, 16);
    if (kind === 'VP8X') return [1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3)];
    if (kind === 'VP8 ') return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
    if (kind === 'VP8L') { const n = b.readUInt32LE(21); return [(n & 0x3fff) + 1, ((n >> 14) & 0x3fff) + 1]; }
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return null;
}
// the size attributes of a cover: its real size, or the one written in the content file
function coverSize(o) {
  const [width, height] = imageSize(o.capa) ?? [o.capa_largura, o.capa_altura].map(Number);
  return width > 0 && height > 0 ? { width, height } : null;
}

// the _pt or _en version of a field
const tr = (o, field, l) => o?.[`${field}_${l}`];
const has = (v) => String(v ?? '').trim() !== '';
// an image path from the editor ("/assets/...") or written by hand ("assets/..."), for the page at base
const src = (path, base) => escape(base + String(path).trim().replace(/^\/+/, ''));
const delay = (i) => (i ? ` style="transition-delay: ${(i / 10).toFixed(1)}s;"` : '');

// texts and poems: paragraphs separated by empty lines, each line of a paragraph on its own line;
// stanzas of verse that follow one another stay in one paragraph, separated by an empty line
function verse(value, what, pad) {
  const chunks = String(value ?? '').replace(/\r/g, '').split(/\n\s*\n/)
    .map((ch) => ch.split('\n').map((s) => s.trim()).filter(Boolean)).filter((ch) => ch.length);
  if (!chunks.length) throw new Error(`Missing ${what}`);
  const groups = [];
  for (const ch of chunks) {
    const last = groups.at(-1);
    if (ch.length > 1 && last && last.at(-1).length > 1) last.push(ch);
    else groups.push([ch]);
  }
  return groups.map((g) => `${pad}<p>${g.map((ch) => ch.map(inline).join(`<br>\n${pad}`)).join(`<br><br>\n${pad}`)}</p>`).join('\n');
}

// the centred heading most sections start with
const intro = (o, l, what) => [
  `        <div style="text-align: center; max-width: 800px; margin: 0 auto;">`,
  `            <span class="section-tag" style="justify-content: center;">${inline(need(tr(o, 'etiqueta', l), `${l} ${what} label`))}</span>`,
  `            <h2 class="bio-title">${inline(need(tr(o, 'titulo', l), `${l} ${what} title`))}</h2>`,
  `            <p style="color: var(--text-muted);">${inline(need(tr(o, 'subtitulo', l), `${l} ${what} subtitle`))}</p>`,
  `        </div>`,
].join('\n');

// a YouTube video id from a link (youtube.com/watch?v=, youtu.be/, /embed/, /shorts/) or the id itself
function youtubeId(value, what) {
  const v = need(value, what).trim();
  const id = /^[\w-]{11}$/.test(v) ? v : v.match(/(?:[?&]v=|youtu\.be\/|\/embed\/|\/shorts\/|\/live\/)([\w-]{11})/)?.[1];
  if (!id) throw new Error(`Not a YouTube link: ${what} (${v})`);
  return id;
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
  destaque: (c, l, base) => {
    const path = need(c.inicio.capa_completa, `${l} hero cover`);
    const size = imageSize(path);
    if (!size) throw new Error(`Cannot read the size of the hero cover (${path})`);
    return `                <img src="${src(path, base)}" alt="${escape(need(c.inicio.capa_completa_alt, `${l} hero cover text`))}" class="hero-cover-full hover-target" width="${size[0]}" height="${size[1]}">`;
  },
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
      const size = coverSize(b);
      if (!size) throw new Error(`Missing cover size of ${title}`);
      const { width, height } = size;
      const lines = [`            <div class="masonry-item reveal">`, `                <picture class="picture-wrapper">`];
      if (String(b.estado ?? '').trim()) lines.push(`                    <span class="status-badge">${inline(b.estado)}</span>`);
      lines.push(
        `                    <img src="${src(need(b.capa, `cover of ${title}`), base)}" alt="${escape(need(b.capa_alt, `cover text of ${title}`))}" class="book-cover-img" loading="lazy" width="${width}" height="${height}">`,
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

  // excerpts of the books ("Textos, Reflexões e Versos Livres")
  textos: (c, l, base) => {
    const s = shared.textos;
    const books = s.livros ?? [];
    if (!books.length) throw new Error('Missing books with texts');
    return [intro(s, l, 'texts section'), ...books.map((b) => {
      const name = need(b.livro, 'book of the texts');
      const dims = coverSize(b);
      const size = dims ? ` width="${dims.width}" height="${dims.height}"` : '';
      const texts = b.textos ?? [];
      if (!texts.length) throw new Error(`Missing texts of ${name}`);
      return [
        '',
        `        <div class="poetry-book">`,
        `            <figure class="poetry-book-cover reveal">`,
        `                <img src="${src(need(b.capa, `cover of ${name}`), base)}" alt="${escape(need(tr(b, 'capa_alt', l), `${l} cover text of ${name}`))}" loading="lazy"${size}>`,
        `                <figcaption>${inline(name)}</figcaption>`,
        `            </figure>`,
        '',
        `            <div class="poetry-grid">`,
        texts.map((t, i) => {
          const title = need(tr(t, 'titulo', l), `${l} title of a text of ${name}`);
          return [
            `                <div class="poetry-card reveal"${delay(i)}>`,
            `                    <h3>${inline(title)}</h3>`,
            `                    <div class="text-scroll-container">`,
            verse(tr(t, 'texto', l), `${l} text of "${title}"`, '                        '),
            `                    </div>`,
            `                </div>`,
          ].join('\n');
        }).join('\n\n'),
        `            </div>`,
        `        </div>`,
      ].join('\n');
    })].join('\n');
  },

  // photo galleries, each a carousel
  galeria: (c, l, base) => {
    const s = shared.galeria;
    const galleries = s.galerias ?? [];
    if (!galleries.length) throw new Error('Missing galleries');
    return [intro(s, l, 'gallery section'), '', `        <div class="gallery-carousels">`, galleries.map((g, gi) => {
      const title = need(tr(g, 'titulo', l), `${l} gallery title`);
      const id = `galeria-${gi + 1}`;
      const photos = g.fotos ?? [];
      if (!photos.length) throw new Error(`Missing photos in the gallery "${title}"`);
      return [
        `            <div class="gallery-carousel reveal">`,
        `                <div class="carousel-header">`,
        `                    <h3 class="carousel-title" id="${id}">${inline(title)}</h3>`,
        `                    <div class="carousel-controls">`,
        `                        <button type="button" class="carousel-btn hover-target" data-dir="-1" aria-label="${l === 'en' ? 'Previous photos' : 'Fotografias anteriores'}">&#8592;</button>`,
        `                        <button type="button" class="carousel-btn hover-target" data-dir="1" aria-label="${l === 'en' ? 'Next photos' : 'Fotografias seguintes'}">&#8594;</button>`,
        `                    </div>`,
        `                </div>`,
        `                <div class="carousel-track" tabindex="0" aria-labelledby="${id}">`,
        ...photos.map((p) => {
          const caption = need(tr(p, 'legenda', l), `${l} caption of a photo in "${title}"`);
          const position = has(p.enquadramento) ? ` style="object-position: ${escape(p.enquadramento.trim())};"` : '';
          return [
            `                    <figure class="gallery-photo-card${p.larga ? ' gallery-photo-wide' : ''}">`,
            `                        <img src="${src(need(p.imagem, `photo "${caption}"`), base)}" alt="${escape(need(tr(p, 'descricao', l), `${l} description of the photo "${caption}"`))}" class="gallery-photo-img"${position} loading="lazy">`,
            `                        <figcaption class="gallery-caption">${inline(caption)}</figcaption>`,
            `                    </figure>`,
          ].join('\n');
        }),
        `                </div>`,
        `            </div>`,
      ].join('\n');
    }).join('\n\n'), `        </div>`].join('\n');
  },

  // YouTube videos
  videos: (c, l) => {
    const s = shared.videos;
    const videos = s.videos ?? [];
    if (!videos.length) throw new Error('Missing videos');
    return [intro(s, l, 'videos section'), '', `        <div class="video-showcase">`, `            <div class="video-grid">`, ...videos.map((v, i) => {
      const title = need(tr(v, 'titulo', l), `${l} video title`);
      return [
        `                <figure class="video-item reveal"${delay(i)}>`,
        `                    <div class="video-frame"><iframe src="https://www.youtube-nocookie.com/embed/${youtubeId(v.youtube, `video "${title}"`)}" title="${escape(title)}" loading="lazy" allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe></div>`,
        `                    <figcaption>${inline(title)}</figcaption>`,
        `                </figure>`,
      ].join('\n');
    }), `            </div>`, `        </div>`].join('\n');
  },

  // Media Kit (press)
  imprensa: (c, l, base) => {
    const s = shared.imprensa;
    const f = (field, what) => need(tr(s, field, l), `${l} Media Kit ${what}`);
    const ps = (field, what, pad) => needParagraphs(tr(s, field, l), `${l} Media Kit ${what}`).map((p) => `${pad}<p>${inline(p)}</p>`);
    const list = (field, what, pad) => needParagraphs(tr(s, field, l), `${l} Media Kit ${what}`).map((p) => `${pad}<li>${inline(p)}</li>`);
    const links = (s.links ?? []).map((k) => {
      const url = need(k.url, 'Media Kit link address').trim();
      return `                    <a href="${escape(url)}" target="_blank" rel="noopener noreferrer" class="hover-target">${inline(need(tr(k, 'texto', l), `${l} Media Kit link text`))}</a>`;
    });
    const p20 = '                    ';
    return [
      `        <div class="press-container">`,
      `            <div class="press-content reveal-left">`,
      `                <div class="press-header">`,
      `                    <span class="section-tag" style="color: var(--accent-light);">${inline(f('etiqueta', 'label'))}</span>`,
      `                    <h2 class="press-title">${inline(f('titulo', 'title'))}</h2>`,
      `                    <p class="press-subtitle">${inline(f('subtitulo', 'subtitle'))}</p>`,
      `                </div>`,
      '',
      `                <div class="press-block">`,
      `                    <h4>${inline(f('missao_titulo', 'mission title'))}</h4>`,
      ...ps('missao', 'mission text', p20),
      `                </div>`,
      '',
      `                <div class="press-block">`,
      `                    <h4>${inline(f('bio_longa_titulo', 'long biography title'))}</h4>`,
      ...ps('bio_longa', 'long biography', p20),
      `                </div>`,
      '',
      `                <div class="press-block">`,
      `                    <h4>${inline(f('obras_titulo', 'works title'))}</h4>`,
      `                    <ul class="press-list">`,
      ...list('obras', 'works', '                        '),
      `                    </ul>`,
      ...(has(tr(s, 'obras_nota', l)) ? [`                    <p style="margin-top: 10px; font-style: italic; font-size: 0.8rem; color: var(--text-press-muted);">${inline(tr(s, 'obras_nota', l))}</p>`] : []),
      `                </div>`,
      `            </div>`,
      '',
      `            <div class="press-sidebar reveal-right">`,
      `                <img src="${src(need(s.foto, 'Media Kit photo'), base)}" alt="${escape(f('foto_alt', 'photo description'))}" class="press-photo">`,
      '',
      `                <div class="press-block">`,
      `                    <h4>${inline(f('bio_curta_titulo', 'short biography title'))}</h4>`,
      ...ps('bio_curta', 'short biography', p20),
      `                </div>`,
      '',
      `                <div class="press-block">`,
      `                    <h4>${inline(f('destaques_titulo', 'highlights title'))}</h4>`,
      `                    <ul class="press-list">`,
      ...list('destaques', 'highlights', '                        '),
      `                    </ul>`,
      `                </div>`,
      '',
      `                <div class="press-block press-contact">`,
      `                    <h4>${inline(f('contactos_titulo', 'contacts title'))}</h4>`,
      ...(has(s.email) ? [`                    <a href="mailto:${escape(s.email.trim())}" class="hover-target">${escape(s.email.trim())}</a>`] : []),
      ...links,
      `                </div>`,
      `            </div>`,
      `        </div>`,
    ].join('\n');
  },

  // interviews; one without a link is shown as "coming soon"
  entrevistas: (c, l) => {
    const s = shared.entrevistas;
    const items = s.entrevistas ?? [];
    if (!items.length) throw new Error('Missing interviews');
    return [intro(s, l, 'interviews section'), '', `        <div class="interview-grid">`, ...items.map((e, i) => {
      const title = need(tr(e, 'titulo', l), `${l} interview title`);
      const link = String(e.link ?? '').trim();
      const lines = [
        `            <article class="interview-card${link ? '' : ' interview-card--soon'} reveal"${delay(i)}>`,
        `                <span class="interview-type">${inline(need(tr(e, 'tipo', l), `${l} type of "${title}"`))}</span>`,
        `                <h3>${inline(title)}</h3>`,
      ];
      if (has(tr(e, 'fonte', l))) lines.push(`                <p class="interview-source">${inline(tr(e, 'fonte', l))}</p>`);
      lines.push(...needParagraphs(tr(e, 'resumo', l), `${l} summary of "${title}"`).map((p) => `                <p>${inline(p)}</p>`));
      if (link) lines.push(`                <a href="${escape(link)}" target="_blank" rel="noopener noreferrer" class="btn-secondary hover-target">${inline(need(tr(e, 'botao', l), `${l} button text of "${title}"`))}</a>`);
      lines.push(`            </article>`);
      return lines.join('\n');
    }), `        </div>`].join('\n');
  },
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
