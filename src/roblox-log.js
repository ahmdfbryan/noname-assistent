/**
 * 🛍️ Log Pembelian Roblox — menerima laporan dari map Roblox (cashback) lewat HTTP, lalu kirim notifikasi
 * Components V2 ke Discord + simpan statistik untuk /roblox-stats.
 *
 * .env:
 *   ROBLOX_PORT=3080                  port server HTTP (default 3080)
 *   ROBLOX_API_KEY=...                WAJIB — sama dengan yang dipakai script di map Roblox (header x-api-key)
 *   ROBLOX_LOG_CHANNEL_ID=...         channel notifikasi pembelian
 *   ROBLOX_ADMIN_CHANNEL_ID=...       (opsional) channel PRIVAT: rincian lengkap + komisi + total hari ini
 *   ROBLOX_LOG_HIDE_CASHBACK=1        (opsional) sembunyikan baris cashback di channel notifikasi
 *   ROBLOX_TRUST_PROXY=1              (opsional) pakai header X-Forwarded-For untuk rate limit (kalau di belakang nginx)
 *
 * Tanpa dependency baru: memakai modul `http` bawaan Node.
 */
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const {
  ContainerBuilder,
  TextDisplayBuilder,
  SectionBuilder,
  ThumbnailBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  Events,
} = require('discord.js');

const MAX_BODY = 10 * 1024; // 10kb
const RATE_LIMIT = 60; // request / menit / IP
const SEEN_TTL = 60 * 60 * 1000; // eventId diingat 1 jam
const KEEP_DAYS = 400;
const DATA_FILE = path.join(__dirname, '..', 'data', 'roblox-sales.json');
const DOMAIN = process.env.ROBLOX_DOMAIN || 'roblox.com';

const idOf = (v) => String(v || '').trim();
const rb = (n) => `R$ ${Number(n || 0).toLocaleString('id-ID')}`;
const wibKeys = (unix) => {
  const iso = new Date(unix * 1000 + 7 * 3600 * 1000).toISOString();
  return { day: iso.slice(0, 10), month: iso.slice(0, 7) };
};
const esc = (s) => String(s).replace(/([\\*_`~|>[\]()#-])/g, '\\$1').replace(/@/g, '@\u200b');

// ─────────────────────────── Statistik (data/roblox-sales.json) ───────────────────────────
let sales = { sales: [], plus: [] }; // sales: [t, harga, komisi, itemId, namaItem] • plus: [t]
try {
  const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (Array.isArray(d.sales)) sales = { sales: d.sales, plus: Array.isArray(d.plus) ? d.plus : [] };
} catch {
  /* belum ada data */
}
let saveTimer = null;
function saveSales() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const cut = Math.floor(Date.now() / 1000) - KEEP_DAYS * 86400;
      sales.sales = sales.sales.filter((r) => r[0] >= cut);
      sales.plus = sales.plus.filter((t) => t >= cut);
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      fs.writeFileSync(`${DATA_FILE}.tmp`, JSON.stringify(sales)); // tulis ke file sementara → rename (aman)
      fs.renameSync(`${DATA_FILE}.tmp`, DATA_FILE);
    } catch (e) {
      console.warn('[roblox-log] gagal simpan statistik:', e.message);
    }
  }, 1500);
}
function summarize(keyFn, key) {
  const rows = sales.sales.filter((r) => keyFn(wibKeys(r[0])) === key);
  const items = new Map();
  for (const r of rows) {
    const it = items.get(r[3]) || { name: r[4], count: 0, robux: 0 };
    it.count += 1;
    it.robux += r[1];
    items.set(r[3], it);
  }
  return {
    count: rows.length,
    robux: rows.reduce((a, r) => a + r[1], 0),
    commission: rows.reduce((a, r) => a + r[2], 0),
    plus: sales.plus.filter((t) => keyFn(wibKeys(t)) === key).length,
    top: [...items.values()].sort((a, b) => b.count - a.count || b.robux - a.robux).slice(0, 3),
  };
}
const statsNow = () => {
  const k = wibKeys(Math.floor(Date.now() / 1000));
  return { today: summarize((x) => x.day, k.day), month: summarize((x) => x.month, k.month) };
};

// ─────────────────────────── Validasi ───────────────────────────
const isStr = (v, max, min = 1) => typeof v === 'string' && v.length >= min && v.length <= max;
const isInt = (v, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && v >= 0 && v <= max;
const isNum = (v, max = 1e12) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max;
const safeUrl = (u) => {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' && /(^|\.)roblox\.com$/i.test(x.hostname) ? x.href : null;
  } catch {
    return null;
  }
};

/** Return { ok, event } atau { ok:false, error }. */
function validate(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { ok: false, error: 'body harus objek JSON' };
  if (b.type !== 'purchase' && b.type !== 'plus') return { ok: false, error: 'type tidak dikenal' };
  if (!isStr(b.eventId, 100)) return { ok: false, error: 'eventId tidak valid' };
  if (b.studio !== undefined && typeof b.studio !== 'boolean') return { ok: false, error: 'studio harus boolean' };
  // studio = true → placeId boleh 0 (tes di Roblox Studio) • studio = false → placeId wajib > 0
  if (!isInt(b.placeId) || (b.studio !== true && b.placeId <= 0)) return { ok: false, error: 'placeId tidak valid' };
  if (!isStr(b.serverId, 100, 0)) return { ok: false, error: 'serverId tidak valid' }; // studio: boleh "studio"
  const nowS = Math.floor(Date.now() / 1000);
  // time di luar akal sehat (kosong / jauh di masa depan / sangat lama) → pakai waktu sekarang
  const time = isInt(b.time, 4e9) && b.time > 1e9 && b.time <= nowS + 86400 ? b.time : nowS;
  const p = b.player;
  if (!p || typeof p !== 'object' || !isInt(p.userId, 1e13) || !isStr(p.username, 50) || !isStr(p.displayName, 50, 0)) {
    return { ok: false, error: 'player tidak valid' };
  }
  const ev = {
    type: b.type,
    eventId: b.eventId,
    placeId: b.placeId,
    serverId: b.serverId,
    time,
    studio: b.studio === true,
    universeId: isInt(b.universeId) ? b.universeId : null, // opsional; kalau tidak ada / tidak valid → diabaikan, event tidak ditolak
    player: { userId: p.userId, username: p.username, displayName: p.displayName || p.username },
  };
  if (b.type === 'purchase') {
    const it = b.item;
    if (!it || typeof it !== 'object' || !isInt(it.id) || !isStr(it.name, 120) || !isNum(it.price, 1e9) || (it.url !== undefined && !isStr(it.url, 300))) {
      return { ok: false, error: 'item tidak valid' };
    }
    if (!isNum(b.commission, 1e9)) return { ok: false, error: 'commission tidak valid' };
    ev.item = { id: it.id, name: it.name, price: Math.round(it.price), url: it.url ? safeUrl(it.url) : null };
    ev.commission = Math.round(b.commission);
  }
  return { ok: true, event: ev };
}

// ─────────────────────────── Tampilan (Components V2) ───────────────────────────
const text = (c) => new TextDisplayBuilder().setContent(c);
const sep = () => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
const V2 = MessageFlags.IsComponentsV2;
const profileUrl = (p) => `https://www.roblox.com/users/${p.userId}/profile`;
const buyerLine = (p) => `[${esc(p.displayName)} (@${esc(p.username)})](${profileUrl(p)})`;
const pct = (price, com) => (price > 0 ? Math.round((com / price) * 100) : 0);

async function itemThumb(id) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(`https://thumbnails.${DOMAIN}/v1/assets?assetIds=${id}&size=420x420&format=Png`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const j = await res.json();
    const url = j?.data?.[0]?.imageUrl;
    return typeof url === 'string' && url.startsWith('https://') ? url : null;
  } catch {
    return null;
  }
}

function buildLog(ev, thumb) {
  const box = new ContainerBuilder();
  const footer = [`<t:${ev.time}:f>`, ev.studio ? '🧪 Tes dari Roblox Studio' : null].filter(Boolean).join(' • ');
  if (ev.type === 'plus') {
    box.addTextDisplayComponents(text(`## ⭐ Langganan Roblox Plus\n-# <t:${ev.time}:R>`));
    box.addSeparatorComponents(sep());
    box.addTextDisplayComponents(text(`👤 **Pelanggan**\n${buyerLine(ev.player)}`));
  } else {
    const head = text(`## 🛍️ Pembelian Baru\n-# <t:${ev.time}:R>`);
    if (thumb) box.addSectionComponents(new SectionBuilder().addTextDisplayComponents(head).setThumbnailAccessory(new ThumbnailBuilder().setURL(thumb)));
    else box.addTextDisplayComponents(head);
    box.addSeparatorComponents(sep());
    const item = ev.item.url ? `[${esc(ev.item.name)}](${ev.item.url})` : `**${esc(ev.item.name)}**`;
    const lines = [`👤 **Pembeli**\n${buyerLine(ev.player)}`, `🎁 **Item**\n${item}`, `💰 **Harga**\n${rb(ev.item.price)}`];
    if (process.env.ROBLOX_LOG_HIDE_CASHBACK !== '1') lines.push(`🎯 **Cashback**\n${rb(ev.commission)}${ev.item.price > 0 ? ` (${pct(ev.item.price, ev.commission)}%)` : ''}`);
    box.addTextDisplayComponents(text(lines.join('\n\n')));
  }
  box.addSeparatorComponents(sep());
  box.addTextDisplayComponents(text(`-# ${footer}`));
  return { components: [box], flags: V2, allowedMentions: { parse: [] } };
}

function buildAdmin(ev) {
  const s = statsNow().today;
  const box = new ContainerBuilder();
  const lines =
    ev.type === 'plus'
      ? [`## 🔒 Roblox Plus — Rincian`, `-# <t:${ev.time}:f>`]
      : [`## 🔒 Rincian Pembelian`, `-# <t:${ev.time}:f>`];
  box.addTextDisplayComponents(text(lines.join('\n')));
  box.addSeparatorComponents(sep());
  const rows = [`👤 ${buyerLine(ev.player)} • ID \`${ev.player.userId}\``];
  if (ev.type === 'purchase') {
    rows.push(
      `🎁 ${esc(ev.item.name)} • ID \`${ev.item.id}\``,
      `💰 Harga **${rb(ev.item.price)}**`,
      `💵 Komisi **${rb(ev.commission)}**${ev.item.price > 0 ? ` (${pct(ev.item.price, ev.commission)}%)` : ''}`,
    );
  }
  rows.push(`🗺️ Place \`${ev.placeId}\` • Server \`${String(ev.serverId).slice(0, 36) || '-'}\``, `🧾 Event \`${ev.eventId.slice(0, 60)}\``);
  box.addTextDisplayComponents(text(rows.join('\n')));
  box.addSeparatorComponents(sep());
  box.addTextDisplayComponents(
    text(ev.studio ? '-# 🧪 Tes dari Roblox Studio — tidak dihitung di statistik' : `-# Hari ini: **${s.count}** pembelian • ${rb(s.robux)} • komisi ${rb(s.commission)}`),
  );
  return { components: [box], flags: V2, allowedMentions: { parse: [] } };
}

function buildStats() {
  const { today, month } = statsNow();
  const block = (title, s) => {
    const top = s.top.length ? `\n🏆 **Terlaris**\n${s.top.map((t, i) => `${i + 1}. ${esc(t.name)} — ${t.count}x (${rb(t.robux)})`).join('\n')}` : '';
    return `### ${title}\n🛍️ Pembelian: **${s.count.toLocaleString('id-ID')}**\n💰 Total Robux: **${rb(s.robux)}**\n💵 Perkiraan komisi: **${rb(s.commission)}**\n⭐ Roblox Plus: **${s.plus.toLocaleString('id-ID')}**${top}`;
  };
  const box = new ContainerBuilder();
  box.addTextDisplayComponents(text('## 📊 Statistik Pembelian Roblox\n-# Waktu mengikuti WIB • tes dari Studio tidak dihitung'));
  box.addSeparatorComponents(sep());
  box.addTextDisplayComponents(text(block('📅 Hari Ini', today)));
  box.addSeparatorComponents(sep());
  box.addTextDisplayComponents(text(block('🗓️ Bulan Ini', month)));
  return { components: [box], flags: V2 | MessageFlags.Ephemeral };
}

const robloxStatsCommand = {
  data: new SlashCommandBuilder()
    .setName('roblox-stats')
    .setDescription('Statistik pembelian map Roblox (khusus Administrator)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),
  async execute(interaction) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: '⛔ Hanya **Administrator**.', flags: MessageFlags.Ephemeral });
    }
    return interaction.reply(buildStats());
  },
};

// ─────────────────────────── Server HTTP ───────────────────────────
const seen = new Map(); // eventId → waktu
const hits = new Map(); // ip → { n, reset }

function clientIp(req) {
  if (process.env.ROBLOX_TRUST_PROXY === '1') {
    const f = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (f) return f;
  }
  return req.socket.remoteAddress || 'unknown';
}
function limited(ip) {
  const now = Date.now();
  let h = hits.get(ip);
  if (!h || now >= h.reset) {
    h = { n: 0, reset: now + 60000 };
    hits.set(ip, h);
  }
  h.n += 1;
  return h.n > RATE_LIMIT;
}
function keyOk(req) {
  const want = idOf(process.env.ROBLOX_API_KEY);
  const got = req.headers['x-api-key'];
  if (!want || typeof got !== 'string') return false;
  // Hash dulu agar panjang sama (timingSafeEqual wajib panjang sama).
  const a = crypto.createHash('sha256').update(got).digest();
  const b = crypto.createHash('sha256').update(want).digest();
  return crypto.timingSafeEqual(a, b);
}
function reply(res, code, obj) {
  if (res.headersSent) return;
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Connection: 'close' });
  res.end(body);
}

async function deliver(client, ev) {
  const send = async (id, payload, label) => {
    if (!id) return;
    try {
      const ch = await client.channels.fetch(id);
      if (ch?.isTextBased()) await ch.send(payload);
    } catch (e) {
      console.warn(`[roblox-log] gagal kirim ke channel ${label}:`, e.message);
    }
  };
  const thumb = ev.type === 'purchase' ? await itemThumb(ev.item.id) : null;
  await send(idOf(process.env.ROBLOX_LOG_CHANNEL_ID), buildLog(ev, thumb), 'log');
  await send(idOf(process.env.ROBLOX_ADMIN_CHANNEL_ID), buildAdmin(ev), 'admin');
}

function record(ev) {
  if (ev.studio) return; // tes dari Studio tidak masuk statistik
  if (ev.type === 'purchase') sales.sales.push([ev.time, ev.item.price, ev.commission, ev.item.id, ev.item.name.slice(0, 60)]);
  else sales.plus.push(ev.time);
  saveSales();
}

function handle(client, req, res) {
  if (req.method !== 'POST' || req.url.split('?')[0] !== '/roblox/event') return reply(res, 404, { error: 'not found' });
  if (limited(clientIp(req))) return reply(res, 429, { error: 'too many requests' });
  if (!keyOk(req)) return reply(res, 401, { error: 'unauthorized' });
  if (Number(req.headers['content-length'] || 0) > MAX_BODY) return reply(res, 413, { error: 'payload too large' });

  let size = 0;
  const chunks = [];
  let dead = false;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY) {
      dead = true;
      reply(res, 413, { error: 'payload too large' });
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('error', () => {});
  req.on('end', () => {
    if (dead) return;
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return reply(res, 400, { error: 'JSON tidak valid' });
    }
    const v = validate(body);
    if (!v.ok) return reply(res, 400, { error: v.error });
    const ev = v.event;
    if (seen.has(ev.eventId)) return reply(res, 200, { ok: true, duplicate: true }); // sudah diproses → jangan kirim ulang
    seen.set(ev.eventId, Date.now());
    reply(res, 200, { ok: true }); // balas secepatnya, kirim ke Discord sesudahnya
    record(ev);
    deliver(client, ev).catch((e) => console.warn('[roblox-log]', e.message));
  });
}

function registerRobloxLog(client) {
  client.once(Events.ClientReady, () => {
    if (!idOf(process.env.ROBLOX_API_KEY)) {
      console.warn('[roblox-log] ROBLOX_API_KEY belum diisi di .env → server HTTP Log Pembelian Roblox TIDAK dijalankan.');
      return;
    }
    const port = Number(process.env.ROBLOX_PORT) || 3080;
    const server = http.createServer((req, res) => {
      try {
        handle(client, req, res);
      } catch (e) {
        console.warn('[roblox-log]', e.message);
        reply(res, 500, { error: 'server error' });
      }
    });
    server.headersTimeout = 10000;
    server.requestTimeout = 15000;
    server.on('error', (e) => console.warn(`[roblox-log] server HTTP gagal jalan di port ${port}: ${e.message}`));
    server.listen(port, () => console.log(`[roblox-log] menerima event di POST :${port}/roblox/event`));
    // Bersihkan eventId > 1 jam & catatan rate limit yang sudah lewat.
    setInterval(() => {
      const now = Date.now();
      for (const [k, t] of seen) if (now - t > SEEN_TTL) seen.delete(k);
      for (const [k, h] of hits) if (now >= h.reset) hits.delete(k);
    }, 5 * 60 * 1000).unref();
  });
}

module.exports = { registerRobloxLog, robloxStatsCommand, __t: { validate, buildLog, buildAdmin, buildStats, handle } };
