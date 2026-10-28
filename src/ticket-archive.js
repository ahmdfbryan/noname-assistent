const fs = require('fs');
const path = require('path');
const {
  MessageFlags,
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  FileBuilder,
} = require('discord.js');

/**
 * Ticket Archive (channel private, khusus owner).
 * Setiap ticket yang selesai diarsipkan: 1 kartu Components V2 berisi seluruh info
 * (pelanggan, pesanan, pembayaran, penanganan, timeline) + galeri bukti gambar + file transkrip chat HTML.
 * - Ticket order (Noname Store) → orderChannelId
 * - Ticket NCS Ticket Center   → ncsChannelId
 */
const FILE = path.join(__dirname, '..', 'archive.json');
const DEFAULT = {
  orderChannelId: '1561261218168184862',
  ncsChannelId: '1561261090443104366',
  galleryImages: 6,
  maxUploadMB: 9,
  inlineImages: true,
  maxMessages: 1000,
  colors: { completed: '#2ECC71', cancelled: '#E74C3C', refund: '#E67E22', closed: '#3498DB', brand: '#3498DB' },
};
function loadConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { ...DEFAULT, ...c, colors: { ...DEFAULT.colors, ...(c.colors || {}) } };
  } catch {
    return DEFAULT;
  }
}

const isId = (v) => /^\d{17,20}$/.test(String(v || ''));
const ts = (ms, s = 'f') => (ms ? `<t:${Math.floor(ms / 1000)}:${s}>` : '`-`');
const num = (n) => Math.round(Number(n) || 0).toLocaleString('id-ID');
const rupiah = (n) => `Rp ${num(n)}`;
const hex = (v, fb) => {
  const n = parseInt(String(v || '').replace('#', ''), 16);
  return Number.isNaN(n) ? fb : n;
};
const wib = (ms) =>
  new Date(ms).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' WIB';
function duration(ms) {
  if (!ms || ms < 0) return '-';
  const m = Math.max(1, Math.round(ms / 60000));
  if (m < 60) return `${m} menit`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} jam ${m % 60} menit` : `${Math.floor(h / 24)} hari ${h % 24} jam`;
}
const userLine = (id, users) => {
  if (!id) return '`-`';
  const u = users?.get?.(id);
  return u ? `<@${id}> • \`@${u.username}\` • \`${id}\`` : `<@${id}> • \`${id}\``;
};

// ═════════════════════════════ Ambil isi channel ═════════════════════════════
async function collectMessages(channel, max) {
  const out = [];
  let before;
  while (out.length < max) {
    const batch = await channel.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!batch?.size) break;
    out.push(...batch.values());
    before = batch.last().id;
    if (batch.size < 100) break;
  }
  return out.reverse();
}

const isImage = (a) => (a.contentType || '').startsWith('image/') || /\.(png|jpe?g|gif|webp)(\?|$)/i.test(a.name || a.url || '');

async function download(url, limitBytes) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const len = Number(res.headers.get('content-length') || 0);
      if (len && len > limitBytes) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      return buf.length > limitBytes ? null : { buf, type: res.headers.get('content-type') || 'image/png' };
    } catch {
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
  return null;
}

// ═════════════════════════════ Transkrip HTML ═════════════════════════════
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Markdown Discord sederhana → HTML (aman: semua teks di-escape dulu). */
function md(text, ctx) {
  let s = esc(text || '');
  const blocks = [];
  s = s.replace(/```(?:[a-z0-9]*\n)?([\s\S]*?)```/gi, (_, code) => {
    blocks.push(`<pre>${code.replace(/\n$/, '')}</pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  s = s.replace(/`([^`\n]+)`/g, (_, c) => {
    blocks.push(`<code>${c}</code>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  s = s
    .replace(/&lt;@!?(\d+)&gt;/g, (_, id) => `<span class="mention">@${esc(ctx.userName(id))}</span>`)
    .replace(/&lt;@&amp;(\d+)&gt;/g, (_, id) => `<span class="mention role">@${esc(ctx.roleName(id))}</span>`)
    .replace(/&lt;#(\d+)&gt;/g, (_, id) => `<span class="mention">#${esc(ctx.channelName(id))}</span>`)
    .replace(/&lt;t:(\d+)(?::[a-zA-Z])?&gt;/g, (_, sec) => `<span class="time">${esc(wib(Number(sec) * 1000))}</span>`)
    .replace(/&lt;a?:(\w+):\d+&gt;/g, ':$1:')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank">$2</a>')
    .replace(/\*\*([\s\S]+?)\*\*/g, '<b>$1</b>')
    .replace(/__([\s\S]+?)__/g, '<u>$1</u>')
    .replace(/~~([\s\S]+?)~~/g, '<s>$1</s>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>')
    .replace(/\|\|([\s\S]+?)\|\|/g, '<span class="spoiler">$1</span>');
  s = s
    .split('\n')
    .map((line) => {
      if (/^### /.test(line)) return `<div class="h3">${line.slice(4)}</div>`;
      if (/^## /.test(line)) return `<div class="h2">${line.slice(3)}</div>`;
      if (/^# /.test(line)) return `<div class="h1">${line.slice(2)}</div>`;
      if (/^-# /.test(line)) return `<div class="sub">${line.slice(3)}</div>`;
      if (/^&gt; /.test(line)) return `<div class="quote">${line.slice(5)}</div>`;
      return `${line}<br>`;
    })
    .join('');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[i]);
}

/** Semua teks di pesan Components V2 (container → text display / section). */
function v2Parts(components = []) {
  const out = [];
  const walk = (list, accent) => {
    for (const c of list || []) {
      const j = c.toJSON ? c.toJSON() : c;
      if (j.type === 17) {
        const box = { accent: j.accent_color ?? null, texts: [], images: [] };
        const inner = (l) => {
          for (const x of l || []) {
            const k = x.toJSON ? x.toJSON() : x;
            if (k.type === 10 && k.content) box.texts.push(k.content);
            if (k.type === 12) for (const it of k.items || []) if (it.media?.url) box.images.push(it.media.url);
            if (k.type === 9) {
              inner(k.components);
              if (k.accessory?.media?.url) box.thumb = k.accessory.media.url;
            }
            if (k.type === 1) for (const b of k.components || []) if (b.label) box.texts.push(`🔘 ${b.label}`);
          }
        };
        inner(j.components);
        out.push(box);
      } else if (j.type === 10 && j.content) out.push({ accent, texts: [j.content], images: [] });
      else if (j.components) walk(j.components, accent);
    }
  };
  walk(components, null);
  return out;
}

const CSS = `
*{box-sizing:border-box}body{margin:0;background:#1e1f22;color:#dbdee1;font-family:"gg sans","Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.45}
a{color:#00a8fc;text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:980px;margin:0 auto;padding:28px 18px 60px}
.hero{background:linear-gradient(135deg,#1b3a5c 0%,#2b2d31 60%);border:1px solid #3a3d44;border-radius:18px;padding:26px;display:flex;gap:20px;align-items:center;position:relative;overflow:hidden}
.hero:before{content:"";position:absolute;left:0;top:0;bottom:0;width:6px;background:var(--accent)}
.hero img{width:84px;height:84px;border-radius:22px;flex:none;box-shadow:0 6px 20px rgba(0,0,0,.35)}
.hero .kicker{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#9fb4c9;font-weight:700}
.hero h1{margin:4px 0 6px;font-size:26px;color:#fff}
.badge{display:inline-block;padding:4px 12px;border-radius:999px;font-size:13px;font-weight:700;background:var(--accent);color:#fff}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px;margin-top:18px}
.card{background:#2b2d31;border:1px solid #3a3d44;border-radius:14px;padding:16px 18px}
.card h2{margin:0 0 10px;font-size:13px;letter-spacing:.1em;text-transform:uppercase;color:#9fb4c9}
.row{display:flex;justify-content:space-between;gap:12px;padding:5px 0;border-bottom:1px dashed #3a3d44}.row:last-child{border:0}
.row span:first-child{color:#949ba4}.row span:last-child{text-align:right;color:#f2f3f5;word-break:break-word}
.tl{list-style:none;margin:0;padding:0}.tl li{padding:6px 0 6px 16px;border-left:2px solid #3498db;margin-left:4px;position:relative}
.tl li:before{content:"";position:absolute;left:-6px;top:12px;width:10px;height:10px;border-radius:50%;background:#3498db}
.tl small{color:#949ba4;display:block;font-size:12px}
.chips{display:flex;flex-wrap:wrap;gap:8px}.chip{display:flex;align-items:center;gap:8px;background:#1e1f22;border:1px solid #3a3d44;border-radius:999px;padding:4px 12px 4px 4px;font-size:13px}
.chip img{width:24px;height:24px;border-radius:50%}
.section{margin:30px 0 10px;font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#9fb4c9;font-weight:700;display:flex;align-items:center;gap:10px}
.section:after{content:"";flex:1;height:1px;background:#3a3d44}
.chat{background:#313338;border:1px solid #3a3d44;border-radius:14px;padding:8px 0}
.msg{display:flex;gap:14px;padding:8px 18px}.msg:hover{background:#2e3035}
.msg .av{width:40px;height:40px;border-radius:50%;flex:none;margin-top:2px}
.msg .body{min-width:0;flex:1}.msg .name{font-weight:600;color:#f2f3f5}.msg .bot{background:#5865f2;color:#fff;font-size:10px;font-weight:700;padding:1px 5px;border-radius:4px;margin-left:6px;vertical-align:middle}
.msg .when{color:#949ba4;font-size:12px;margin-left:8px}
.msg .text{word-wrap:break-word;white-space:normal}
.daydiv{display:flex;align-items:center;gap:10px;color:#949ba4;font-size:12px;font-weight:600;margin:10px 18px}.daydiv:before,.daydiv:after{content:"";flex:1;height:1px;background:#3f4147}
pre{background:#1e1f22;border:1px solid #3a3d44;border-radius:8px;padding:10px;white-space:pre-wrap;font-family:Consolas,monospace;font-size:13px;margin:6px 0}
code{background:#1e1f22;border-radius:4px;padding:1px 5px;font-family:Consolas,monospace;font-size:13px}
.mention{background:rgba(88,101,242,.3);color:#c9cdfb;border-radius:4px;padding:0 3px;font-weight:500}.time{background:#3f4147;border-radius:4px;padding:0 4px}
.spoiler{background:#1e1f22;color:#1e1f22;border-radius:4px}.spoiler:hover{color:inherit}
.h1{font-size:22px;font-weight:700;color:#fff;margin:4px 0}.h2{font-size:19px;font-weight:700;color:#fff;margin:4px 0}.h3{font-size:16px;font-weight:700;color:#fff;margin:6px 0 2px}
.sub{font-size:12px;color:#949ba4}.quote{border-left:4px solid #4e5058;padding-left:10px;margin:2px 0}
.embed{margin-top:6px;background:#2b2d31;border-left:4px solid var(--c,#4e5058);border-radius:6px;padding:10px 14px;max-width:560px;position:relative}
.embed .et{font-weight:700;color:#fff;margin-bottom:4px}.embed .ef{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;margin-top:8px}
.embed .ef div b{display:block;color:#fff;font-size:13px}.embed .eft{font-size:12px;color:#949ba4;margin-top:8px}
.embed .thumb{float:right;width:72px;height:72px;border-radius:8px;margin-left:10px;object-fit:cover}
.att img,.embed img.big{max-width:420px;max-height:340px;border-radius:8px;margin-top:6px;display:block;cursor:zoom-in}
.file{display:inline-flex;gap:8px;align-items:center;background:#2b2d31;border:1px solid #3a3d44;border-radius:8px;padding:8px 12px;margin-top:6px}
.foot{margin-top:28px;text-align:center;color:#6d7178;font-size:12px}
@media(max-width:600px){.hero{flex-direction:column;text-align:center}.att img{max-width:100%}}
`;

/**
 * Bangun transkrip HTML premium + kumpulkan gambar untuk galeri arsip.
 * meta = { title, kicker, status, accent, icon, cards: [{ title, rows: [[k, v]] }], timeline: [{ at, text }] }
 */
async function buildTranscript(channel, guild, meta, cfg) {
  const messages = await collectMessages(channel, Number(cfg.maxMessages) || 1000);
  const budget = Math.max(1, Number(cfg.maxUploadMB) || 9) * 1024 * 1024;
  const galleryMax = Math.min(10, Math.max(0, Number(cfg.galleryImages) || 0));

  // Gambar yang dikirim member (bukti transfer, screenshot, dll) → galeri arsip (permanen).
  const gallery = [];
  const imageCache = new Map(); // url → { buf, type }
  let used = 0;
  const humanImages = [];
  for (const m of messages) for (const a of m.attachments.values()) if (isImage(a)) humanImages.push({ a, bot: m.author?.bot });
  humanImages.sort((x, y) => Number(x.bot) - Number(y.bot)); // gambar dari member diutamakan
  for (const { a } of humanImages.slice(0, galleryMax)) {
    const d = await download(a.url, Math.min(8 * 1024 * 1024, budget * 0.45 - used));
    if (!d) continue;
    imageCache.set(a.url, d);
    used += d.buf.length;
    const ext = (path.extname((a.name || '').split('?')[0]) || '.png').toLowerCase();
    gallery.push({ name: `bukti-${gallery.length + 1}${ext}`, buf: d.buf, desc: a.name || 'Lampiran' });
  }

  // Konteks nama (mention → nama).
  const users = new Map();
  for (const m of messages) {
    if (m.author) users.set(m.author.id, m.author);
    for (const u of m.mentions?.users?.values?.() || []) users.set(u.id, u);
  }
  const ctx = {
    userName: (id) => {
      const mem = guild.members.cache.get(id);
      const u = users.get(id) || mem?.user;
      return mem?.displayName || u?.globalName || u?.username || id;
    },
    roleName: (id) => guild.roles.cache.get(id)?.name || id,
    channelName: (id) => guild.channels.cache.get(id)?.name || id,
  };

  // Inline gambar ke HTML (base64) supaya tetap bisa dilihat walau link Discord sudah kedaluwarsa.
  let inlineLeft = Math.max(0, budget - used - 600 * 1024);
  async function imgSrc(url) {
    if (!cfg.inlineImages || !url) return esc(url);
    let d = imageCache.get(url);
    if (!d && inlineLeft > 50 * 1024) {
      d = await download(url, Math.min(4 * 1024 * 1024, inlineLeft / 1.37));
      if (d) imageCache.set(url, d);
    }
    if (!d) return esc(url);
    const size = Math.ceil(d.buf.length * 1.37);
    if (size > inlineLeft) return esc(url);
    inlineLeft -= size;
    return `data:${esc(d.type.split(';')[0])};base64,${d.buf.toString('base64')}`;
  }

  const stats = new Map(); // userId → jumlah pesan
  let attachmentsCount = 0;
  const parts = [];
  let lastDay = '';
  for (const m of messages) {
    const day = new Date(m.createdTimestamp).toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    if (day !== lastDay) {
      parts.push(`<div class="daydiv">${esc(day)}</div>`);
      lastDay = day;
    }
    const a = m.author || { username: 'unknown' };
    stats.set(a.id, (stats.get(a.id) || 0) + 1);
    const name = m.member?.displayName || a.globalName || a.username;
    const avatar = a.displayAvatarURL ? a.displayAvatarURL({ extension: 'png', size: 64 }) : '';
    let body = m.content ? `<div class="text">${md(m.content, ctx)}</div>` : '';
    for (const e of m.embeds || []) {
      const c = e.color != null ? `#${e.color.toString(16).padStart(6, '0')}` : '#4e5058';
      body += `<div class="embed" style="--c:${c}">${e.thumbnail?.url ? `<img class="thumb" src="${esc(e.thumbnail.url)}">` : ''}${e.author?.name ? `<div class="sub">${esc(e.author.name)}</div>` : ''}${
        e.title ? `<div class="et">${md(e.title, ctx)}</div>` : ''
      }${e.description ? `<div>${md(e.description, ctx)}</div>` : ''}${
        e.fields?.length ? `<div class="ef">${e.fields.map((f) => `<div><b>${md(f.name, ctx)}</b>${md(f.value, ctx)}</div>`).join('')}</div>` : ''
      }${e.image?.url ? `<img class="big" src="${await imgSrc(e.image.url)}">` : ''}${e.footer?.text ? `<div class="eft">${esc(e.footer.text)}</div>` : ''}</div>`;
    }
    for (const box of v2Parts(m.components)) {
      const c = box.accent != null ? `#${Number(box.accent).toString(16).padStart(6, '0')}` : '#3498db';
      let imgs = '';
      for (const u of box.images.slice(0, 4)) if (!u.startsWith('attachment://')) imgs += `<img class="big" src="${await imgSrc(u)}">`;
      body += `<div class="embed" style="--c:${c}">${box.thumb && !box.thumb.startsWith('attachment://') ? `<img class="thumb" src="${esc(box.thumb)}">` : ''}${box.texts
        .map((t) => `<div>${md(t, ctx)}</div>`)
        .join('<hr style="border:0;border-top:1px solid #3f4147;margin:8px 0">')}${imgs}</div>`;
    }
    for (const att of m.attachments.values()) {
      attachmentsCount += 1;
      if (isImage(att)) body += `<div class="att"><a href="${esc(att.url)}" target="_blank"><img src="${await imgSrc(att.url)}" alt="${esc(att.name)}"></a></div>`;
      else body += `<div class="file">📎 <a href="${esc(att.url)}" target="_blank">${esc(att.name)}</a> <span class="sub">${num((att.size || 0) / 1024)} KB</span></div>`;
    }
    if (m.stickers?.size) body += `<div class="sub">🏷️ Stiker: ${esc([...m.stickers.values()].map((s) => s.name).join(', '))}</div>`;
    if (!body) body = '<div class="sub">(pesan kosong / sistem)</div>';
    parts.push(
      `<div class="msg"><img class="av" src="${esc(avatar)}"><div class="body"><div><span class="name">${esc(name)}</span>${a.bot ? '<span class="bot">BOT</span>' : ''}<span class="when">${esc(
        wib(m.createdTimestamp),
      )}${m.editedTimestamp ? ' (diedit)' : ''}</span></div>${body}</div></div>`,
    );
  }

  const participants = [...stats.entries()]
    .sort((x, y) => y[1] - x[1])
    .map(([id, n]) => {
      const u = users.get(id);
      return { id, n, bot: Boolean(u?.bot), name: ctx.userName(id), avatar: u?.displayAvatarURL?.({ extension: 'png', size: 64 }) || '' };
    });

  const cards = (meta.cards || [])
    .filter((c) => c.rows?.length)
    .map((c) => `<div class="card"><h2>${esc(c.title)}</h2>${c.rows.map(([k, v]) => `<div class="row"><span>${esc(k)}</span><span>${md(String(v ?? '-'), ctx)}</span></div>`).join('')}</div>`)
    .join('');
  const timeline = (meta.timeline || []).length
    ? `<div class="section">📜 Timeline</div><div class="card"><ul class="tl">${meta.timeline.map((x) => `<li>${md(x.text, ctx)}<small>${esc(wib(x.at))}</small></li>`).join('')}</ul></div>`
    : '';
  const accent = `#${Number(meta.accent || 0x3498db).toString(16).padStart(6, '0')}`;
  const html = `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(meta.title)}</title><style>${CSS}</style></head>
<body style="--accent:${accent}"><div class="wrap">
<div class="hero">${meta.icon ? `<img src="${esc(meta.icon)}">` : ''}<div><div class="kicker">${esc(meta.kicker || 'Ticket Archive')}</div><h1>${esc(meta.title)}</h1><span class="badge">${esc(meta.status || '')}</span></div></div>
<div class="grid">${cards}</div>
${timeline}
<div class="section">👥 Peserta Percakapan</div>
<div class="chips">${participants.map((p) => `<div class="chip"><img src="${esc(p.avatar)}">${esc(p.name)}${p.bot ? ' <span class="bot" style="background:#5865f2;color:#fff;font-size:10px;padding:1px 5px;border-radius:4px">BOT</span>' : ''} <span class="sub">• ${num(p.n)} pesan</span></div>`).join('')}</div>
<div class="section">💬 Transkrip Chat • ${num(messages.length)} pesan</div>
<div class="chat">${parts.join('\n') || '<div class="msg"><div class="sub">Tidak ada pesan.</div></div>'}</div>
<div class="foot">${esc(meta.footer || '')} • Diarsipkan ${esc(wib(Date.now()))}</div>
</div></body></html>`;

  return { html: Buffer.from(html, 'utf8'), messages: messages.length, participants, attachments: attachmentsCount, gallery };
}

// ═════════════════════════════ Kartu arsip (Components V2) ═════════════════════════════
function buildArchiveCard({ accent, thumb, header, blocks, gallery, fileName, footer }) {
  const text = (c) => new TextDisplayBuilder().setContent(String(c));
  const line = () => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
  const box = new ContainerBuilder().setAccentColor(accent);
  // Batas 4000 karakter teks per pesan → blok dipotong rapi kalau terlalu panjang.
  let left = 3800 - header.length - footer.length;
  const fit = [];
  for (const b of blocks.filter(Boolean)) {
    if (left <= 80) break;
    const s = b.length > left ? `${b.slice(0, left - 20)}\n-# …dipotong` : b;
    fit.push(s);
    left -= s.length;
  }
  if (thumb) box.addSectionComponents(new SectionBuilder().addTextDisplayComponents(text(header)).setThumbnailAccessory(new ThumbnailBuilder().setURL(thumb)));
  else box.addTextDisplayComponents(text(header));
  for (const b of fit) {
    box.addSeparatorComponents(line());
    box.addTextDisplayComponents(text(b));
  }
  if (gallery?.length) {
    box.addSeparatorComponents(line());
    box.addTextDisplayComponents(text(`### 🖼️ Lampiran Gambar (${gallery.length})`));
    box.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(gallery.map((g) => new MediaGalleryItemBuilder().setURL(`attachment://${g.name}`).setDescription(String(g.desc).slice(0, 200)))),
    );
  }
  if (fileName) {
    box.addSeparatorComponents(line());
    box.addTextDisplayComponents(text('### 📄 Transkrip Chat\n-# Download & buka file di browser untuk melihat seluruh percakapan lengkap dengan gambar.'));
    box.addFileComponents(new FileBuilder().setURL(`attachment://${fileName}`));
  }
  box.addSeparatorComponents(line());
  box.addTextDisplayComponents(text(`-# ${footer}`));
  return box;
}

/** Kirim arsip ke channel; kalau file terlalu besar → coba tanpa galeri, lalu tanpa file. */
async function sendArchive(target, build) {
  const attempts = [
    { gallery: true, file: true },
    { gallery: false, file: true },
    { gallery: false, file: false },
  ];
  let lastErr;
  for (const a of attempts) {
    try {
      const { box, files } = build(a);
      return await target.send({ components: [box], files, flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } });
    } catch (err) {
      lastErr = err;
      if (![40005, 50035].includes(err.code) && err.status !== 413) break;
    }
  }
  throw lastErr;
}

/**
 * Inti pengarsipan. opts = { guild, channelId (tujuan), source (channel ticket, boleh null),
 *   id, accent, thumb, header, blocks, meta (untuk HTML), footer, extraFiles: [{ name, path }] }
 */
async function archive(opts) {
  const cfg = loadConfig();
  if (!isId(opts.channelId)) return null;
  const target = await opts.guild.channels.fetch(opts.channelId).catch(() => null);
  if (!target?.isTextBased()) {
    console.warn(`[archive] channel arsip ${opts.channelId} tidak ditemukan / bot tidak punya akses.`);
    return null;
  }
  let tr = null;
  if (opts.source) {
    tr = await buildTranscript(opts.source, opts.guild, { ...opts.meta, footer: opts.meta?.footer || String(opts.footer).replace(/ • <t:\d+:\w>/g, '') }, cfg).catch((e) => {
      console.error(`[archive] transkrip ${opts.id}:`, e.message);
      return null;
    });
  }
  const gallery = [...(tr?.gallery || [])];
  for (const f of opts.extraFiles || []) {
    if (gallery.length >= 10) break;
    try {
      if (f.path && fs.existsSync(f.path)) gallery.unshift({ name: f.name, buf: fs.readFileSync(f.path), desc: f.desc || f.name });
    } catch {}
  }
  const fileName = `transkrip-${String(opts.id).toLowerCase()}.html`;
  const transcriptBlock = tr
    ? [
        '### 💬 Ringkasan Percakapan',
        `**🗨️ Total Pesan:** \`${num(tr.messages)}\` • **📎 Lampiran:** \`${num(tr.attachments)}\``,
        `**👥 Peserta:** ${tr.participants
          .slice(0, 8)
          .map((p) => `<@${p.id}> \`${num(p.n)}\``)
          .join(' • ')}`,
      ].join('\n')
    : '### 💬 Transkrip\n-# ⚠️ Transkrip tidak tersedia — channel ticket sudah dihapus sebelum diarsipkan.';

  const msg = await sendArchive(target, ({ gallery: withGallery, file }) => {
    const g = withGallery ? gallery.slice(0, 10) : [];
    const files = g.map((x) => ({ attachment: x.buf, name: x.name }));
    if (file && tr) files.push({ attachment: tr.html, name: fileName });
    const box = buildArchiveCard({
      accent: opts.accent,
      thumb: opts.thumb,
      header: opts.header,
      blocks: [...opts.blocks, transcriptBlock],
      gallery: g,
      fileName: file && tr ? fileName : null,
      footer: opts.footer,
    });
    return { box, files };
  }).catch((e) => {
    console.error(`[archive] gagal kirim arsip ${opts.id}:`, e.message);
    return null;
  });
  return msg ? { channelId: target.id, messageId: msg.id, at: Date.now() } : null;
}

// ═════════════════════════════ Ticket ORDER (Noname Store) ═════════════════════════════
const ORDER_STATUS = {
  open: { label: '⏳ Masih Berjalan', key: 'brand' },
  completed: { label: '✅ Completed', key: 'completed' },
  cancelled: { label: '❌ Cancelled', key: 'cancelled' },
  refund: { label: '💸 Refund', key: 'refund' },
};
const PAY_STATUS = { paid: '✅ Lunas / Dana Masuk', pending: '⏳ Menunggu Konfirmasi', rejected: '⛔ Ditolak' };
const KIND_LABEL = { robux: 'Robux Visend', gamepass: 'Robux Gamepass', canva: 'Canva Pro', boost: 'Server Boost', rekber: 'Rekber', instant: 'Produk Instan' };

async function archiveStoreTicket(guild, t, source) {
  if (!guild || !t || t.archived) return null;
  const cfg = loadConfig();
  const storeCfg = (() => {
    try {
      return require('./store/config').loadConfig() || {};
    } catch {
      return {};
    }
  })();
  const kind = t.kind || 'robux';
  const st = ORDER_STATUS[t.status] || ORDER_STATUS.open;
  const accent = hex(cfg.colors[st.key], 0x3498db);
  const storeName = storeCfg.storeName || guild.name;
  const users = new Map();
  for (const id of [t.userId, t.buyerId, t.sellerId, t.closedBy, t.payment?.paidBy].filter(Boolean)) {
    const u = await guild.client.users.fetch(id).catch(() => null);
    if (u) users.set(id, u);
  }
  const buyer = users.get(t.buyerId || t.userId);
  const product = t.productLabel || KIND_LABEL[kind] || 'Produk';

  // ── Pelanggan
  const cust = ['### 👤 Pelanggan'];
  if (kind === 'rekber') {
    cust.push(`**🛍️ Pembeli:** ${userLine(t.buyerId, users)}`, `**🏷️ Penjual:** ${userLine(t.sellerId, users)}`, `**✍️ Pembuat Ticket:** <@${t.userId}>`);
  } else {
    cust.push(`**💬 Discord:** ${userLine(t.userId, users)}`);
    if (t.roblox) cust.push(`**🎮 Roblox:** \`${t.roblox.displayName || t.roblox.name}\` (@${t.roblox.name}) • [Profil](https://www.roblox.com/users/${t.roblox.id}/profile) • \`${t.roblox.id}\``);
  }

  // ── Detail pesanan
  const det = ['### 🛒 Detail Pesanan', `**📦 Produk:** \`${product}\``];
  if (kind === 'robux') det.push(`**💎 Jumlah:** \`${num(t.amount)} Robux\``, t.rate ? `**💱 Rate:** \`${rupiah(t.rate)} / Robux\`` : null);
  if (kind === 'gamepass') {
    det.push(
      `**🎟️ Gamepass:** [${t.gamepass?.name || t.gamepass?.id}](https://www.roblox.com/game-pass/${t.gamepass?.id}) • \`${t.gamepass?.id}\``,
      `**💎 Harga Gamepass:** \`${num(t.before)} Robux\` • **Diterima:** \`${num(t.amount)} Robux\``,
      t.rate ? `**💱 Rate:** \`${rupiah(t.rate)} / Robux\`` : null,
    );
  }
  if (kind === 'canva') det.push(`**📅 Paket:** \`${t.plan?.label || '-'}\``, `**📧 Email:** \`${t.email || '-'}\``, t.expiresAt ? `**⌛ Aktif Sampai:** ${ts(t.expiresAt, 'D')}` : null);
  if (kind === 'boost') {
    det.push(
      `**📅 Paket:** \`${t.plan?.label || '-'}\` • **🚀 Jumlah:** \`${num(t.qty)} boost\``,
      t.server ? `**🌐 Server:** \`${t.server.name}\` • \`${t.server.id}\`` : null,
      t.invite ? `**🔗 Invite:** ${t.invite}` : null,
      t.expiresAt ? `**⌛ Aktif Sampai:** ${ts(t.expiresAt, 'D')}` : null,
    );
  }
  if (kind === 'instant' && t.ins) {
    det.push(
      `**🏷️ Varian:** \`${t.ins.variant || '-'}\` • **🔢 Jumlah:** \`${num(t.ins.qty)} akun\``,
      `**💱 Harga Jual:** \`${rupiah(t.ins.unitPrice)}\` • **🏭 Modal:** \`${rupiah(t.ins.unitCost)}\` / akun`,
      `**⚡ Waroengkuy:** ref_id \`${t.ins.refId}\`${t.ins.order?.ref ? ` • No. \`${t.ins.order.ref}\`` : ''} • mode \`${t.ins.mode}\``,
      t.ins.deliveredAt ? `**📬 Akun Terkirim:** ${ts(t.ins.deliveredAt, 'f')}${t.ins.dmSent === false ? ' (DM gagal)' : ''}` : null,
    );
  }
  if (kind === 'rekber') {
    det.push(
      `**📦 Objek Transaksi:** ${t.item || '-'}`,
      t.detail ? `**📝 Detail:** ${t.detail}` : null,
      `**💵 Nominal:** \`${rupiah(t.nominal)}\` • **🧾 Fee:** \`${rupiah(t.fee)}\` (${t.feeByBuyer === false ? 'penjual' : 'pembeli'})`,
      `**💳 Dibayar Pembeli:** \`${rupiah(t.buyerPays)}\` • **🏷️ Diterima Penjual:** \`${rupiah(t.sellerGets)}\``,
    );
  }

  // ── Pembayaran
  const p = t.payment || {};
  const total = kind === 'rekber' ? t.buyerPays : t.price;
  const pay = [
    '### 💳 Pembayaran',
    `**💰 Total Tagihan:** \`${rupiah(total)}\``,
    `**📌 Status:** \`${PAY_STATUS[p.status] || '⌛ Belum Ada Pembayaran'}\``,
    p.bank ? `**🏦 Metode:** \`${p.bank}\`${p.sender ? ` • **👤 Pengirim:** \`${p.sender}\`` : ''}` : null,
    p.at ? `**📤 Bukti Dikirim:** ${ts(p.at)}` : null,
    p.note ? `**💬 Catatan Pembeli:** ${p.note}` : null,
    p.status === 'paid' ? `**✅ Dana Masuk:** \`${rupiah(p.amount ?? total)}\` • ${ts(p.paidAt)} • oleh <@${p.paidBy}>` : null,
    p.adminNote ? `**📝 Catatan Admin:** ${p.adminNote}` : null,
    p.status === 'rejected' ? `**⛔ Ditolak:** ${ts(p.rejectedAt)}${p.rejectReason ? ` • ${p.rejectReason}` : ''}` : null,
  ];

  // ── Penanganan
  const handle = [
    '### 🧾 Penanganan',
    `**📌 Hasil:** \`${st.label}\``,
    `**🕒 Dibuat:** ${ts(t.createdAt)} • **🔒 Ditutup:** ${ts(t.closedAt)}`,
    `**⏱️ Durasi:** \`${duration((t.closedAt || Date.now()) - t.createdAt)}\`${t.closedBy ? ` • **🛡️ Ditutup Oleh:** <@${t.closedBy}>` : ''}`,
    t.note ? `**📝 Catatan:** ${t.note}` : null,
    t.testimony ? `**⭐ Testimoni:** ${'⭐'.repeat(t.testimony.rating)} — ${t.testimony.comment}` : null,
  ];

  const timeline = (t.log || []).slice(-12);
  const tl = timeline.length ? ['### 📜 Timeline', ...timeline.map((x) => `\`${wib(x.at)}\` ${x.text}`)].join('\n') : null;

  const header = `-# ${storeName} • Ticket Archive\n# 🗂️ ${t.id} • ${product}\n**${st.label}** • ${kind === 'rekber' ? 'Rekening Bersama' : 'Order'} oleh <@${t.buyerId || t.userId}>`;
  const thumb = t.roblox?.avatar || buyer?.displayAvatarURL({ extension: 'png', size: 256 }) || guild.iconURL({ extension: 'png', size: 256 });

  const res = await archive({
    guild,
    channelId: cfg.orderChannelId,
    source,
    id: t.id,
    accent,
    thumb,
    header,
    blocks: [cust.filter(Boolean).join('\n'), det.filter(Boolean).join('\n'), pay.filter(Boolean).join('\n'), handle.filter(Boolean).join('\n'), tl],
    footer: `${storeName} • Ticket Archive • ${t.id} • ${ts(Date.now())}`,
    extraFiles: t.proofFile ? [{ name: `bukti-akhir-${t.id.toLowerCase()}${path.extname(t.proofFile)}`, path: t.proofFile, desc: 'Bukti penyelesaian / testimoni' }] : [],
    meta: {
      title: `${t.id} • ${product}`,
      kicker: `${storeName} • Ticket Archive`,
      status: st.label,
      accent,
      icon: guild.iconURL({ extension: 'png', size: 256 }),
      timeline: t.log || [],
      cards: [
        {
          title: '👤 Pelanggan',
          rows:
            kind === 'rekber'
              ? [
                  ['Pembeli', `@${users.get(t.buyerId)?.username || t.buyerId}`],
                  ['Penjual', `@${users.get(t.sellerId)?.username || t.sellerId}`],
                ]
              : [
                  ['Discord', `@${buyer?.username || t.userId} (${t.userId})`],
                  ...(t.roblox ? [['Roblox', `${t.roblox.displayName || t.roblox.name} (@${t.roblox.name})`], ['Roblox ID', t.roblox.id]] : []),
                ],
        },
        {
          title: '🛒 Pesanan',
          rows: [
            ['Produk', product],
            ...(kind === 'robux' ? [['Jumlah', `${num(t.amount)} Robux`]] : []),
            ...(kind === 'gamepass' ? [['Gamepass', `${t.gamepass?.name || ''} (${t.gamepass?.id})`], ['Harga Gamepass', `${num(t.before)} Robux`], ['Diterima', `${num(t.amount)} Robux`]] : []),
            ...(t.rate ? [['Rate', `${rupiah(t.rate)} / Robux`]] : []),
            ...(t.plan ? [['Paket', t.plan.label]] : []),
            ...(kind === 'canva' ? [['Email', t.email || '-']] : []),
            ...(kind === 'boost' ? [['Jumlah Boost', `${num(t.qty)} boost`], ['Server', t.server?.name || '-'], ['Invite', t.invite || '-']] : []),
            ...(kind === 'instant' && t.ins ? [['Varian', t.ins.variant || '-'], ['Jumlah', `${num(t.ins.qty)} akun`], ['Modal', rupiah((t.ins.unitCost || 0) * (t.ins.qty || 1))], ['Waroengkuy', t.ins.order?.ref || t.ins.refId]] : []),
            ...(kind === 'rekber'
              ? [['Objek', t.item || '-'], ['Nominal', rupiah(t.nominal)], ['Fee', rupiah(t.fee)], ['Diterima Penjual', rupiah(t.sellerGets)]]
              : []),
          ],
        },
        {
          title: '💳 Pembayaran',
          rows: [
            ['Total', rupiah(total)],
            ['Status', PAY_STATUS[p.status] || 'Belum ada pembayaran'],
            ...(p.bank ? [['Metode', p.bank]] : []),
            ...(p.sender ? [['Pengirim', p.sender]] : []),
            ...(p.paidAt ? [['Dana Masuk', `${rupiah(p.amount ?? total)} • ${wib(p.paidAt)}`]] : []),
            ...(p.adminNote ? [['Catatan Admin', p.adminNote]] : []),
          ],
        },
        {
          title: '🧾 Penanganan',
          rows: [
            ['Status', st.label],
            ['Dibuat', wib(t.createdAt)],
            ['Ditutup', t.closedAt ? wib(t.closedAt) : '-'],
            ['Durasi', duration((t.closedAt || Date.now()) - t.createdAt)],
            ...(t.note ? [['Catatan', t.note]] : []),
            ...(t.testimony ? [['Testimoni', `${'⭐'.repeat(t.testimony.rating)} — ${t.testimony.comment}`]] : []),
          ],
        },
      ],
    },
  });
  if (res) t.archived = res;
  return res;
}

// ═════════════════════════════ Ticket NCS (Ticket Center) ═════════════════════════════
async function archiveNcsTicket(guild, ticketCfg, t, source) {
  if (!guild || !t || t.archived) return null;
  const cfg = loadConfig();
  const type = (ticketCfg?.types || []).find((x) => x.id === t.type) || { label: t.type, emoji: '🎫' };
  const accent = hex(cfg.colors.closed, 0x3498db);
  const users = new Map();
  for (const id of [t.userId, t.claimedBy, t.closedBy, t.deliveredBy].filter(Boolean)) {
    const u = await guild.client.users.fetch(id).catch(() => null);
    if (u) users.set(id, u);
  }
  const opener = users.get(t.userId);
  const claim = t.type === 'claim-giveaway';
  const short = [];
  const long = [];
  for (const [k, v] of t.answers || []) {
    const val = String(v || '-');
    if (val.includes('\n') || val.length > 120) long.push(`**${k}:**\n${val}`);
    else short.push(`**${k}:** ${val}`);
  }
  const info = [
    '### 👤 Pembuka Ticket',
    `**💬 Discord:** ${userLine(t.userId, users)}`,
    `**📂 Jenis:** ${type.emoji || '🎫'} \`${type.label}\``,
  ].join('\n');
  const detail = short.length || long.length ? [claim ? '### 🎁 Detail Klaim Hadiah' : '### 📋 Detail Ticket', ...short, ...long].join('\n') : null;
  const verify =
    claim && t.verified != null
      ? t.verified
        ? '✅ **Terverifikasi** sebagai pemenang giveaway.'
        : '⚠️ **Tidak terverifikasi** di data pemenang giveaway.'
      : null;
  const handle = [
    '### 🧾 Penanganan',
    `**🕒 Dibuka:** ${ts(t.createdAt)} • **🔒 Ditutup:** ${ts(t.closedAt)}`,
    `**⏱️ Durasi:** \`${duration((t.closedAt || Date.now()) - t.createdAt)}\``,
    t.claimedBy ? `**🙋 Ditangani:** <@${t.claimedBy}> • ${ts(t.claimedAt, 'R')}` : '**🙋 Ditangani:** `-`',
    claim ? `**🎁 Hadiah:** ${t.delivered ? `\`✅ Terkirim\` • ${ts(t.deliveredAt)} oleh <@${t.deliveredBy}>` : '`⏳ Belum ditandai terkirim`'}` : null,
    t.closedBy ? `**🛡️ Ditutup Oleh:** <@${t.closedBy}>` : null,
    t.closeReason ? `**📝 Alasan:** ${t.closeReason}` : null,
    verify,
  ]
    .filter(Boolean)
    .join('\n');
  const timeline = (t.history || []).slice(-12);
  const tl = timeline.length ? ['### 📜 Timeline', ...timeline.map((x) => `\`${wib(x.at)}\` ${x.text}`)].join('\n') : null;
  const header = `-# ${guild.name} • NCS Ticket Archive\n# 🗂️ ${t.id} • ${type.label}\n**🔒 Ditutup** • Dibuka oleh <@${t.userId}>`;
  const plain = (s) => String(s).replace(/```/g, '').replace(/\*\*/g, '');

  const res = await archive({
    guild,
    channelId: cfg.ncsChannelId,
    source,
    id: t.id,
    accent,
    thumb: opener?.displayAvatarURL({ extension: 'png', size: 256 }) || t.avatar || guild.iconURL({ extension: 'png', size: 256 }),
    header,
    blocks: [info, detail, handle, tl],
    footer: `NCS Ticket Center • Ticket Archive • ${t.id} • ${ts(Date.now())}`,
    meta: {
      title: `${t.id} • ${type.label}`,
      kicker: `${guild.name} • NCS Ticket Archive`,
      status: '🔒 Ditutup',
      accent,
      icon: guild.iconURL({ extension: 'png', size: 256 }),
      timeline: t.history || [],
      cards: [
        { title: '👤 Pembuka', rows: [['Discord', `@${opener?.username || t.userId} (${t.userId})`], ['Jenis', `${type.emoji || ''} ${type.label}`]] },
        { title: claim ? '🎁 Detail Klaim' : '📋 Detail Ticket', rows: (t.answers || []).map(([k, v]) => [plain(k), plain(v)]) },
        {
          title: '🧾 Penanganan',
          rows: [
            ['Dibuka', wib(t.createdAt)],
            ['Ditutup', t.closedAt ? wib(t.closedAt) : '-'],
            ['Durasi', duration((t.closedAt || Date.now()) - t.createdAt)],
            ['Ditangani', t.claimedBy ? `@${users.get(t.claimedBy)?.username || t.claimedBy}` : '-'],
            ...(claim ? [['Hadiah', t.delivered ? `Terkirim • ${wib(t.deliveredAt)}` : 'Belum ditandai terkirim']] : []),
            ...(t.closeReason ? [['Alasan', t.closeReason]] : []),
          ],
        },
      ],
    },
  });
  if (res) t.archived = res;
  return res;
}

module.exports = { archiveStoreTicket, archiveNcsTicket, loadArchiveConfig: loadConfig };
