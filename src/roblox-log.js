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
  ActionRowBuilder,
  AttachmentBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  ButtonBuilder,
  ButtonStyle,
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
const { ROBUX } = require('./emojis');
const card = require('./roblox-card');
const MIN_CASHBACK = Number(process.env.ROBLOX_MIN_CASHBACK ?? 30); // item di bawah ini (Robux) tidak mendapat cashback
const rb = (n) => `${ROBUX} ${Math.round(Number(n || 0)).toLocaleString('id-ID')}`; // ikon Robux + format Indonesia
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
    // Komisi sesuai yang dikirim map (beda tiap jenis item), dibulatkan. Item di bawah MIN_CASHBACK Robux → tanpa cashback.
    ev.commission = ev.item.price < MIN_CASHBACK ? 0 : Math.round(b.commission);
    ev.noCashback = ev.item.price < MIN_CASHBACK;
  }
  return { ok: true, event: ev };
}

// ─────────────────────────── Tampilan (Components V2) ───────────────────────────
const text = (c) => new TextDisplayBuilder().setContent(c);
const sep = () => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
const V2 = MessageFlags.IsComponentsV2;
const profileUrl = (p) => `https://www.roblox.com/users/${p.userId}/profile`;
const buyerLine = (p) => `[${esc(p.displayName)} (@${esc(p.username)})](${profileUrl(p)})`;

/** Ambil URL gambar dari API thumbnails Roblox (timeout 5 detik; gagal → null). */
async function fetchThumb(apiPath) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(`https://thumbnails.${DOMAIN}/v1/${apiPath}`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const url = (await res.json())?.data?.[0]?.imageUrl;
    return typeof url === 'string' && url.startsWith('https://') ? url : null;
  } catch {
    return null;
  }
}
const itemThumb = (id) => fetchThumb(`assets?assetIds=${id}&size=420x420&format=Png`);
const userHead = (id) => fetchThumb(`users/avatar-headshot?userIds=${id}&size=150x150&format=Png&isCircular=false`);

/** Unduh gambar (hanya https & domain Roblox, maks. 3 MB, timeout 8 detik) → Buffer atau null. */
async function fetchBuf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !/(^|\.)(rbxcdn\.com|roblox\.com|roproxy\.com)$/i.test(u.hostname)) return null;
    const res = await fetch(u, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length <= 3 * 1024 * 1024 ? buf : null;
  } catch {
    return null;
  }
}

const linkBtn = (label, emoji, url) => new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(label).setEmoji(emoji).setURL(url);
const itemUrl = (it) => it.url || `https://www.roblox.com/catalog/${it.id}`;
/** Teks + gambar kecil di kanan (kalau gambarnya ada). */
function withThumb(box, content, url) {
  if (url) box.addSectionComponents(new SectionBuilder().addTextDisplayComponents(text(content)).setThumbnailAccessory(new ThumbnailBuilder().setURL(url)));
  else box.addTextDisplayComponents(text(content));
}
const stamp = (ev) => ['Noname Studios Creative', `<t:${ev.time}:f>`, ev.studio ? '🧪 Tes dari Roblox Studio' : null].filter(Boolean).join(' • ');

function buildLogText(ev, img = {}) {
  const box = new ContainerBuilder();
  const p = ev.player;
  if (ev.type === 'plus') {
    withThumb(box, `## ⭐ Roblox Plus Subscription\n-# Member baru berlangganan • <t:${ev.time}:R>\n\n👤 **${esc(p.displayName)}**\n-# @${esc(p.username)}`, img.user);
    box.addSeparatorComponents(sep());
    box.addActionRowComponents(new ActionRowBuilder().addComponents(linkBtn('Profil Pembeli', '👤', profileUrl(p))));
  } else {
    const it = ev.item;
    // Kepala: item (gambar di kanan) — judul + nama item sebagai link
    withThumb(box, `## 🛍️ New Purchase\n-# <t:${ev.time}:R>\n\nA bulk cart checkout has been completed in the Noname Hub marketplace.\n\n🎁 [**${esc(it.name)}**](${itemUrl(it)})\n-# ID item \`${it.id}\``, img.item);
    box.addSeparatorComponents(sep());
    // Pembeli (avatar di kanan)
    withThumb(box, `-# 👤 PEMBELI\n**${esc(p.displayName)}**\n-# @${esc(p.username)} • ID \`${p.userId}\``, img.user);
    box.addSeparatorComponents(sep());
    // Angka utama
    const nums = [`-# 💰 HARGA\n## ${rb(it.price)}`];
    if (process.env.ROBLOX_LOG_HIDE_CASHBACK !== '1') nums.push(ev.noCashback ? `-# 💵 KOMISI\n## Tanpa cashback\n-# Item di bawah ${rb(MIN_CASHBACK)} tidak mendapat cashback` : `-# 💵 KOMISI\n## ${rb(ev.commission)}`);
    box.addTextDisplayComponents(text(nums.join('\n')));
    box.addSeparatorComponents(sep());
    box.addActionRowComponents(new ActionRowBuilder().addComponents(linkBtn('Lihat Item', '🎁', itemUrl(it)), linkBtn('Profil Pembeli', '👤', profileUrl(p))));
  }
  box.addTextDisplayComponents(text(`-# ${stamp(ev)}`));
  return { components: [box], flags: V2, allowedMentions: { parse: [] } };
}

function buildAdminText(ev, img = {}) {
  const s = statsNow().today;
  const p = ev.player;
  const box = new ContainerBuilder();
  box.addTextDisplayComponents(text(`## 🔒 ${ev.type === 'plus' ? 'Roblox Plus' : 'Rincian Pembelian'}\n-# Khusus admin • <t:${ev.time}:f>`));
  box.addSeparatorComponents(sep());
  withThumb(box, `-# 👤 PEMBELI\n**${esc(p.displayName)}** • @${esc(p.username)}\n-# User ID \`${p.userId}\``, img.user);
  if (ev.type === 'purchase') {
    const it = ev.item;
    box.addSeparatorComponents(sep());
    box.addTextDisplayComponents(
      text(
        `-# 🎁 ITEM\n[**${esc(it.name)}**](${itemUrl(it)})\n-# Asset ID \`${it.id}\`\n\n` +
          `-# 💰 HARGA  →  💵 KOMISI\n## ${rb(it.price)}  →  ${ev.noCashback ? 'Tanpa cashback' : rb(ev.commission)}`,
      ),
    );
  }
  box.addSeparatorComponents(sep());
  box.addTextDisplayComponents(
    text(
      `-# 🧾 TEKNIS\nPlace \`${ev.placeId}\`${ev.universeId ? ` • Universe \`${ev.universeId}\`` : ''}\nServer \`${String(ev.serverId).slice(0, 36) || '-'}\`\nEvent \`${ev.eventId.slice(0, 60)}\``,
    ),
  );
  box.addSeparatorComponents(sep());
  box.addTextDisplayComponents(
    text(ev.studio ? '-# 🧪 Tes dari Roblox Studio — tidak dihitung di statistik' : `-# 📈 Hari ini: **${s.count}** pembelian • ${rb(s.robux)} • komisi ${rb(s.commission)}`),
  );
  return { components: [box], flags: V2, allowedMentions: { parse: [] } };
}

/** Kartu gambar premium → payload V2 (gambar + deskripsi + tombol). png = Buffer dari roblox-card. */
const CARD_NAME = 'noname-purchase.png';
const cardGallery = (ev) =>
  new MediaGalleryBuilder().addItems(
    new MediaGalleryItemBuilder().setURL(`attachment://${CARD_NAME}`).setDescription(ev.type === 'plus' ? `Langganan Roblox Plus — ${ev.player.displayName}` : `Pembelian ${ev.item.name} oleh ${ev.player.displayName}`),
  );
function buildLogCard(ev, png) {
  const box = new ContainerBuilder();
  const p = ev.player;
  if (ev.type === 'plus') {
    box.addTextDisplayComponents(text(`# ⭐ Roblox Plus Subscription\n-# <t:${ev.time}:R> • A member just subscribed to Roblox Plus.`));
  } else {
    box.addTextDisplayComponents(text(`# 🛍️ New Purchase\n-# <t:${ev.time}:R> • A bulk cart checkout has been completed in the Noname Hub marketplace.`));
  }
  box.addMediaGalleryComponents(cardGallery(ev));
  const btns = ev.type === 'plus' ? [linkBtn('Profil Pembeli', '👤', profileUrl(p))] : [linkBtn('Lihat Item', '🎁', itemUrl(ev.item)), linkBtn('Profil Pembeli', '👤', profileUrl(p))];
  box.addActionRowComponents(new ActionRowBuilder().addComponents(...btns));
  box.addTextDisplayComponents(text(`-# ${stamp(ev)}`));
  return { components: [box], files: [new AttachmentBuilder(png, { name: CARD_NAME })], flags: V2, allowedMentions: { parse: [] } };
}
function buildAdminCard(ev, png) {
  const s = statsNow().today;
  const box = new ContainerBuilder();
  box.addTextDisplayComponents(text(`🔒 **${ev.type === 'plus' ? 'Roblox Plus' : 'Rincian Pembelian'}** • khusus admin • <t:${ev.time}:R>`));
  box.addMediaGalleryComponents(cardGallery(ev));
  const rows = [`-# 👤 User ID \`${ev.player.userId}\``];
  if (ev.type === 'purchase') rows.push(`-# 🎁 Asset ID \`${ev.item.id}\` • ${ev.noCashback ? 'tanpa cashback' : `komisi ${rb(ev.commission)}`}`);
  rows.push(`-# 🗺️ Place \`${ev.placeId}\`${ev.universeId ? ` • Universe \`${ev.universeId}\`` : ''} • Server \`${String(ev.serverId).slice(0, 36) || '-'}\``, `-# 🧾 Event \`${ev.eventId.slice(0, 60)}\``);
  box.addTextDisplayComponents(text(rows.join('\n')));
  box.addSeparatorComponents(sep());
  box.addTextDisplayComponents(text(ev.studio ? '-# 🧪 Tes dari Roblox Studio — tidak dihitung di statistik' : `-# 📈 Hari ini: **${s.count}** pembelian • ${rb(s.robux)} • komisi ${rb(s.commission)}`));
  return { components: [box], files: [new AttachmentBuilder(png, { name: CARD_NAME })], flags: V2, allowedMentions: { parse: [] } };
}

// ─────────────────────────── Antrian cashback (data/roblox-cashback.json) ───────────────────────────
// Tiap pembelian yang berhak cashback masuk daftar pesanan di channel antrian dengan tombol "Cashback Terkirim".
// Setelah admin menekan tombol → pesan diperbarui + log "cashback terkirim" dikirim ke channel log cashback.
const CB_FILE = path.join(__dirname, '..', 'data', 'roblox-cashback.json');
const QUEUE_CH = () => idOf(process.env.ROBLOX_CASHBACK_CHANNEL_ID) || '1570292563729191023'; // daftar pesanan cashback + tombol
const SENT_CH = () => idOf(process.env.ROBLOX_CASHBACK_SENT_CHANNEL_ID) || '1571066602785476653'; // log cashback terkirim
const CB_PREFIX = 'rbcb:';
let cb = { orders: {} };
try {
  const d = JSON.parse(fs.readFileSync(CB_FILE, 'utf8'));
  if (d && typeof d.orders === 'object') cb = { orders: d.orders };
} catch {
  /* belum ada data */
}
function saveCb() {
  try {
    const cut = Math.floor(Date.now() / 1000) - 120 * 86400; // pesanan yang sudah terkirim > 120 hari dibuang
    for (const [k, o] of Object.entries(cb.orders)) if (o.sent && o.time < cut) delete cb.orders[k];
    fs.mkdirSync(path.dirname(CB_FILE), { recursive: true });
    fs.writeFileSync(`${CB_FILE}.tmp`, JSON.stringify(cb));
    fs.renameSync(`${CB_FILE}.tmp`, CB_FILE);
  } catch (e) {
    console.warn('[roblox-log] gagal simpan antrian cashback:', e.message);
  }
}
const cbKey = (eventId) => crypto.createHash('sha1').update(String(eventId)).digest('hex').slice(0, 24); // customId pendek & aman
const owesCashback = (ev) => ev.type === 'purchase' && (!ev.studio || process.env.ROBLOX_CASHBACK_TEST === '1') && !ev.noCashback && Number(ev.commission) > 0; // ROBLOX_CASHBACK_TEST=1 → tes dari Studio ikut masuk daftar (untuk uji coba)

/** Tambah tombol konfirmasi ke kartu admin (payload V2 dengan 1 container). */
function withConfirmButton(payload, ev) {
  const box = payload.components[0];
  box.addSeparatorComponents(sep());
  box.addActionRowComponents(
    new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`${CB_PREFIX}${cbKey(ev.eventId)}`).setLabel('Cashback Terkirim').setEmoji('✅').setStyle(ButtonStyle.Secondary)),
  );
  box.addTextDisplayComponents(text(`-# ⏳ Menunggu cashback ${rb(ev.commission)} dikirim ke **${esc(ev.player.displayName)}**`));
  return payload;
}

function buildSentLog(o, by, img = {}) {
  const box = new ContainerBuilder();
  box.addTextDisplayComponents(text(`# ✅ Cashback Sent\n-# <t:${o.sentAt}:R> • Cashback has been delivered to the buyer.`));
  box.addSeparatorComponents(sep());
  withThumb(box, `-# 👤 PEMBELI\n**${esc(o.displayName)}** • @${esc(o.username)}\n-# User ID \`${o.userId}\``, img.user);
  box.addSeparatorComponents(sep());
  box.addTextDisplayComponents(text(`-# 🎁 ITEM\n[**${esc(o.itemName)}**](https://www.roblox.com/catalog/${o.itemId})\n\n-# 💰 HARGA  →  💵 CASHBACK DIKIRIM\n## ${rb(o.price)}  →  ${rb(o.commission)}`));
  box.addSeparatorComponents(sep());
  box.addTextDisplayComponents(text(`-# 🛡️ Dikonfirmasi oleh <@${by}> • Pesanan <t:${o.time}:f>\n-# Noname Studios Creative`));
  return { components: [box], flags: V2, allowedMentions: { parse: [] } };
}

const cbBusy = new Set();
async function onCashbackButton(interaction) {
  const key = interaction.customId.slice(CB_PREFIX.length);
  const isAdminUser = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) || interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
  if (!isAdminUser) return interaction.reply({ content: '⛔ Tombol ini khusus **Administrator**.', flags: MessageFlags.Ephemeral });
  const o = cb.orders[key];
  if (!o) return interaction.reply({ content: '❌ Data pesanan ini tidak ditemukan (mungkin dibuat sebelum fitur ini aktif).', flags: MessageFlags.Ephemeral });
  if (o.sent || cbBusy.has(key)) return interaction.reply({ content: `ℹ️ Cashback ini sudah dikonfirmasi${o.sentBy ? ` oleh <@${o.sentBy}>` : ''}.`, flags: MessageFlags.Ephemeral });
  cbBusy.add(key);
  try {
    await interaction.deferUpdate();
    o.sent = true;
    o.sentBy = interaction.user.id;
    o.sentAt = Math.floor(Date.now() / 1000);
    saveCb();
    // 1) Perbarui pesan pesanan: tombol diganti keterangan terkirim.
    try {
      const raw = interaction.message.components.map((c) => c.toJSON());
      const box = raw[0];
      box.components = box.components.filter((c) => c.type !== 1); // buang baris tombol
      const last = box.components[box.components.length - 1];
      const done = `-# ✅ **Cashback ${rb(o.commission)} terkirim** • oleh <@${o.sentBy}> • <t:${o.sentAt}:R>`;
      if (last?.type === 10 && String(last.content).startsWith('-# ⏳')) last.content = done;
      else box.components.push({ type: 10, content: done });
      await interaction.editReply({ components: raw, allowedMentions: { parse: [] } });
    } catch (e) {
      console.warn('[roblox-log] gagal memperbarui pesan pesanan:', e.message);
    }
    // 2) Log cashback terkirim → channel log cashback.
    try {
      const ch = await interaction.client.channels.fetch(SENT_CH());
      if (!ch?.isTextBased()) throw new Error('channel log cashback tidak bisa diakses');
      const user = await userHead(o.userId).catch(() => null);
      await ch.send(buildSentLog(o, o.sentBy, { user }));
    } catch (e) {
      console.warn('[roblox-log] gagal kirim log cashback terkirim:', e.message);
      await interaction.followUp({ content: `⚠️ Cashback sudah ditandai terkirim, tapi **log gagal dikirim** ke <#${SENT_CH()}>: \`${String(e.message).slice(0, 150)}\``, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  } finally {
    cbBusy.delete(key);
  }
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
  const [item, user] = await Promise.all([ev.type === 'purchase' ? itemThumb(ev.item.id) : null, userHead(ev.player.userId)]);
  const img = { item, user };
  // Kartu gambar premium (roblox-card.js). Kalau gagal dibuat → tampilan teks biasa.
  let logMsg;
  let adminMsg;
  try {
    const [itemBuf, userBuf] = await Promise.all([item ? fetchBuf(item) : null, user ? fetchBuf(user) : null]);
    const data = { itemImg: itemBuf, avatarImg: userBuf, displayName: ev.player.displayName, username: ev.player.username, studio: ev.studio };
    if (ev.type === 'purchase') Object.assign(data, { itemName: ev.item.name, price: ev.item.price, commission: ev.commission, noCashback: ev.noCashback, minCashback: MIN_CASHBACK });
    const render = (extra) => (ev.type === 'plus' ? card.renderPlus({ ...data, ...extra }) : card.renderPurchase({ ...data, ...extra }));
    const hide = process.env.ROBLOX_LOG_HIDE_CASHBACK === '1';
    const logPng = await render({ hideCommission: hide });
    const adminPng = hide ? await render({}) : logPng;
    if (logPng) logMsg = buildLogCard(ev, logPng);
    if (adminPng) adminMsg = buildAdminCard(ev, adminPng);
  } catch (e) {
    console.warn('[roblox-log] kartu gambar gagal dibuat, pakai tampilan teks:', e.message);
  }
  await send(idOf(process.env.ROBLOX_LOG_CHANNEL_ID), logMsg || buildLogText(ev, img), 'log');
  // Pembelian yang berhak cashback → daftar pesanan di channel antrian + tombol "Cashback Terkirim".
  let queued = false;
  if (owesCashback(ev)) {
    try {
      const ch = await client.channels.fetch(QUEUE_CH());
      if (ch?.isTextBased()) {
        const m = await ch.send(withConfirmButton(adminMsg || buildAdminText(ev, img), ev));
        cb.orders[cbKey(ev.eventId)] = {
          channelId: ch.id, messageId: m.id, userId: ev.player.userId, username: ev.player.username, displayName: ev.player.displayName,
          itemId: ev.item.id, itemName: ev.item.name, price: ev.item.price, commission: ev.commission, time: ev.time, sent: false,
        };
        saveCb();
        queued = true;
      }
    } catch (e) {
      console.warn('[roblox-log] gagal kirim ke antrian cashback:', e.message);
    }
  }
  // Rincian admin biasa (tanpa tombol): dilewati kalau channel-nya sama dengan antrian & pesannya sudah terkirim.
  const adminId = idOf(process.env.ROBLOX_ADMIN_CHANNEL_ID);
  if (!(queued && adminId === QUEUE_CH())) await send(adminId, adminMsg || buildAdminText(ev, img), 'admin');
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
  client.on(Events.InteractionCreate, (i) => {
    if (i.isButton() && i.customId.startsWith(CB_PREFIX)) onCashbackButton(i).catch((e) => console.warn('[roblox-log] tombol cashback:', e.message));
  });
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

module.exports = { registerRobloxLog, robloxStatsCommand, __t: { validate, buildLogText, buildAdminText, buildLogCard, buildAdminCard, buildStats, handle, deliver } };
