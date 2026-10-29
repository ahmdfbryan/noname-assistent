const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  EmbedBuilder,
  MessageFlags,
  ForumLayoutType,
  SortOrderType,
  ThreadAutoArchiveDuration,
  RESTJSONErrorCodes,
} = require('discord.js');
const UI = require('../ui');
const W = require('./waroengkuy');
const I = require('./instant');
const { loadConfig, isId, rupiah, num, fill } = require('./config');
const { state, save, isProductOpen, productStatsOf } = require('./state');
const V = require('./views');

/**
 * 👑 Katalog Premium App di FORUM channel.
 * - 1 post per produk (gambar besar, deskripsi, semua varian + harga + stok, tombol Beli Sekarang).
 * - Tag forum = kategori + status (🟢 Ready Stock / 🔴 Stok Habis) → member bisa filter & cari.
 * - 1 post panduan yang di-pin di paling atas.
 * - Sinkron otomatis tiap 10 menit: post diedit kalau harga / stok berubah, produk baru dibuatkan post,
 *   produk yang tidak dijual lagi dihapus postnya.
 * Pengaturan: store.json → products[produk-instan].forum
 */

const SYNC_MS = 10 * 60 * 1000;
const V2F = MessageFlags.IsComponentsV2;
let client = null;
let syncing = false;

const text = (c) => new TextDisplayBuilder().setContent(String(c || '​').slice(0, 4000));
const line = () => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
const clip = (s, n) => {
  const c = String(s ?? '');
  return c.length > n ? `${c.slice(0, n - 1)}…` : c;
};
const brand = (cfg) => parseInt(String(cfg?.colors?.brand || '#3498DB').replace('#', ''), 16);
const settings = (p) => ({ lockPosts: true, enabled: true, ...(p?.forum || {}) });
const forumId = (cfg, p) => [settings(p).channelId, cfg?.channels?.premiumForum].find(isId) || null;
const panelUrl = (guildId) => (state.instantPanel ? `https://discord.com/channels/${guildId}/${state.instantPanel.channelId}/${state.instantPanel.messageId}` : null);
const helpUrl = (guildId) => {
  const ch = I.helpChannelId();
  return ch ? `https://discord.com/channels/${guildId}/${ch}` : null;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────── Emoji kategori (tebakan dari nama, bisa diatur di forum.categoryEmojis) ─────────────────────────
const GUESS = [
  [/netflix|disney|prime|vidio|viu|wetv|iqiyi|hbo|stream|film|movie|youtube|tv/i, '🎬'],
  [/spotify|music|musik|apple music|joox|deezer|tidal/i, '🎵'],
  [/chatgpt|gpt|ai\b|gemini|claude|copilot|perplexity|midjourney/i, '🤖'],
  [/canva|desain|design|figma|adobe|picsart|photo|foto|meitu|lightroom/i, '🎨'],
  [/capcut|video|edit|alight|vn\b|kinemaster/i, '🎞️'],
  [/vpn|nord|express|surfshark|security|antivirus/i, '🛡️'],
  [/game|gaming|xbox|playstation|steam|discord|nitro/i, '🎮'],
  [/office|microsoft|word|excel|zoom|notion|productivity|produktiv/i, '💼'],
  [/belajar|edu|course|duolingo|quizlet|scribd|grammarly|kursus/i, '📚'],
  [/akun premium|premium/i, '💎'],
];
function catEmoji(p, cat) {
  const set = settings(p).categoryEmojis || {};
  if (set[cat]) return set[cat];
  return (GUESS.find(([re]) => re.test(cat)) || [null, '📦'])[1];
}

// ───────────────────────── Data produk untuk post ─────────────────────────
function productsFor(p, items) {
  const out = [];
  for (const [cat, prods] of I.groupCatalog(p, items)) {
    for (const prod of prods.values()) out.push({ ...prod, category: cat, sum: I.productSummary(p, prod) });
  }
  return out.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

/** Tag yang dikelola bot: status + kategori (maks 20 tag per forum → kategori maks 18). */
function wantedTags(p, products) {
  const counts = new Map();
  for (const x of products) counts.set(x.category, (counts.get(x.category) || 0) + 1);
  const cats = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 18).map(([c]) => c);
  return [
    { key: 'ready', name: 'Ready Stock', emoji: '🟢' },
    { key: 'empty', name: 'Stok Habis', emoji: '🔴' },
    ...cats.map((c) => ({ key: `cat:${c}`, name: clip(c, 20), emoji: catEmoji(p, c), cat: c })),
  ];
}

async function ensureTags(forum, p, products) {
  const want = wantedTags(p, products);
  const have = forum.availableTags || [];
  const same = want.length === have.length && want.every((w) => have.some((h) => h.name === w.name));
  let tags = have;
  if (!same) {
    const next = want.map((w) => {
      const old = have.find((h) => h.name === w.name);
      return { ...(old?.id ? { id: old.id } : {}), name: w.name, moderated: true, emoji: { id: null, name: w.emoji } };
    });
    const updated = await forum.setAvailableTags(next, 'Katalog Premium App: tag kategori & status').catch((e) => {
      console.warn('[forum] gagal mengatur tag (butuh izin Manage Channels):', e.message);
      return null;
    });
    tags = updated?.availableTags || have;
  }
  const idOf = (name) => tags.find((t) => t.name === name)?.id || null;
  return (prod) => [idOf(prod.sum.available ? 'Ready Stock' : 'Stok Habis'), idOf(clip(prod.category, 20))].filter(Boolean);
}

// ───────────────────────── Tampilan post produk ─────────────────────────
function variantLine(p, v) {
  const stock = v.stock == null ? '`∞ Selalu ada`' : I.inStock(v) ? `\`Stok ${num(v.stock)}\`` : '`Habis`';
  const war = v.no_warranty ? '⚠️ Tanpa garansi' : Number(v.warranty_days) > 0 ? `🛡️ ${num(v.warranty_days)} hari` : '🛡️ S&K';
  return `${I.inStock(v) ? '🟢' : '🔴'} **${clip(v.variant, 45)}** ┃ **${rupiah(I.sellPrice(p, v))}** ┃ ${stock} ┃ ${war}`;
}

function buildPost(guild, cfg, p, prod) {
  const open = isProductOpen(p);
  const name = V.storeName(cfg, guild);
  const vars = prod.variants;
  const groups = [...new Set(vars.map((v) => v.variant_group).filter(Boolean))];
  const list =
    groups.length > 1
      ? groups.map((g) => `**${g}**\n${vars.filter((v) => v.variant_group === g).map((v) => variantLine(p, v)).join('\n')}`).join('\n\n')
      : vars.map((v) => variantLine(p, v)).join('\n');
  const totalStock = prod.sum.stock;
  const ready = prod.sum.available && open;
  const box = UI.accent(new ContainerBuilder(), brand(cfg));
  const header = `# ${clip(prod.name, 80)}\n-# ${catEmoji(p, prod.category)} ${clip(prod.category, 40)} • 👑 Premium App • ${name}`;
  box.addTextDisplayComponents(text(header));
  if (prod.image) box.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(prod.image)));
  const blocks = [
    [
      `🏪 **Status:** ${!open ? '`🔴 TOKO TUTUP`' : prod.sum.available ? '`🟢 READY STOCK`' : '`🔴 STOK HABIS`'}`,
      `💱 **Harga:** \`Mulai ${rupiah(prod.sum.min)}\``,
      `📦 **Stok:** \`${totalStock == null ? 'Selalu tersedia' : `${num(totalStock)} akun`}\``,
      `⚡ **Pengiriman:** \`Otomatis ke ticket & DM\``,
      `💳 **Pembayaran:** \`${I.PAY_LABEL[I.payMode(p)]}\``,
    ].join('\n'),
    prod.description ? `### 📝 Deskripsi\n${I.cleanDesc(prod.description, 1100)}` : null,
    `### 🏷️ Pilihan Varian\n${clip(list, 1700)}`,
    vars.some((v) => v.variant_description)
      ? `### ℹ️ Detail Varian\n${I.cleanDesc(vars.filter((v) => v.variant_description).map((v) => `**${v.variant}:** ${v.variant_description}`).join('\n'), 600)}`
      : null,
    vars.some((v) => v.no_warranty) ? '⚠️ Varian **Tanpa Garansi** bisa bermasalah kapan saja **tanpa penggantian / refund**.' : null,
    `### 🛒 Cara Beli\n\`1\` Klik **🛒 Beli Sekarang** di bawah\n\`2\` Pilih **varian** & **jumlah**\n\`3\` Bayar **QRIS** di ticket pribadimu\n\`4\` Akun **terkirim otomatis** dalam hitungan detik ✨`,
  ];
  for (const b of blocks.filter(Boolean)) {
    box.addSeparatorComponents(line());
    box.addTextDisplayComponents(text(b));
  }
  box.addSeparatorComponents(line());
  box.addTextDisplayComponents(text(`-# ${name} • Harga & stok diperbarui otomatis • <t:${Math.floor(Date.now() / 1000)}:R>`));
  const help = helpUrl(guild.id);
  box.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      [
        new ButtonBuilder()
          .setCustomId(`store:insbuy:${prod.id}`)
          .setLabel(!open ? 'Toko Tutup' : ready ? 'Beli Sekarang' : 'Stok Habis')
          .setEmoji('🛒')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(!ready),
        p.howTo ? new ButtonBuilder().setCustomId(`store:howtobtn:${p.id}`).setLabel('Cara Order').setEmoji('📖').setStyle(ButtonStyle.Secondary) : null,
        help ? new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(help).setLabel('Bantuan').setEmoji('🛟') : null,
      ].filter(Boolean),
    ),
  );
  return { components: [box], flags: V2F, allowedMentions: { parse: [] } };
}

/** Versi embed (cadangan kalau forum menolak Components V2). */
function buildPostEmbed(guild, cfg, p, prod) {
  const open = isProductOpen(p);
  const ready = prod.sum.available && open;
  const e = new EmbedBuilder()
    .setTitle(clip(prod.name, 250))
    .setDescription(clip(`${prod.description ? `${I.cleanDesc(prod.description, 900)}\n\n` : ''}**🏷️ Pilihan Varian**\n${prod.variants.map((v) => variantLine(p, v)).join('\n')}`, 4000))
    .addFields(
      { name: '🏪 Status', value: !open ? '`🔴 TOKO TUTUP`' : prod.sum.available ? '`🟢 READY`' : '`🔴 HABIS`', inline: true },
      { name: '💱 Harga', value: `\`Mulai ${rupiah(prod.sum.min)}\``, inline: true },
      { name: '⚡ Pengiriman', value: '`Otomatis`', inline: true },
    )
    .setFooter({ text: `${V.storeName(cfg, guild)} • Harga & stok diperbarui otomatis` })
    .setTimestamp(new Date());
  if (prod.image) e.setImage(prod.image);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`store:insbuy:${prod.id}`).setLabel(ready ? 'Beli Sekarang' : 'Stok Habis').setEmoji('🛒').setStyle(ButtonStyle.Secondary).setDisabled(!ready),
  );
  return { embeds: [e], components: [row], allowedMentions: { parse: [] } };
}

/** Sidik jari isi post (tanpa jam) → post hanya diedit kalau ada yang berubah. */
const hashOf = (p, prod, tags) =>
  JSON.stringify([
    prod.name,
    prod.image,
    prod.description,
    prod.category,
    isProductOpen(p),
    I.payMode(p),
    Boolean(p.howTo),
    tags,
    prod.variants.map((v) => [v.variant_id, v.variant, I.sellPrice(p, v), v.stock, v.warranty_days, v.no_warranty, v.variant_description, v.variant_group]),
  ]);

// ───────────────────────── Post panduan (di-pin) ─────────────────────────
function buildGuide(guild, cfg, p, products) {
  const name = { name: V.storeName(cfg, guild) };
  const fc = settings(p);
  const open = isProductOpen(p);
  const cats = new Map();
  for (const x of products) {
    const c = cats.get(x.category) || { n: 0, ready: 0, min: Infinity };
    c.n += 1;
    if (x.sum.available) {
      c.ready += 1;
      c.min = Math.min(c.min, x.sum.min);
    }
    cats.set(x.category, c);
  }
  const catLines = [...cats.entries()]
    .sort((a, b) => b[1].ready - a[1].ready || a[0].localeCompare(b[0]))
    .slice(0, 20)
    .map(([c, v]) => `${catEmoji(p, c)} **${clip(c, 40)}** — \`${num(v.ready)}/${num(v.n)} ready\`${v.ready ? ` • mulai \`${rupiah(v.min)}\`` : ''}`);
  const ready = products.filter((x) => x.sum.available).length;
  const st = state.stats;
  const avg = st.ratingCount ? (st.ratingSum / st.ratingCount).toFixed(1) : '-';
  const box = UI.accent(new ContainerBuilder(), brand(cfg));
  const icon = guild.iconURL({ extension: 'png', size: 256 });
  const header = `# ${fill(fc.title || '👑 Katalog Premium App', name)}\n-# ${fill(fc.subtitle || '{server} • Auto Delivery 24 Jam', name)}`;
  if (icon) box.addSectionComponents(new SectionBuilder().addTextDisplayComponents(text(header)).setThumbnailAccessory(new ThumbnailBuilder().setURL(icon)));
  else box.addTextDisplayComponents(text(header));
  if (fc.bannerImage) box.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(fc.bannerImage)));
  const blocks = [
    fill(
      fc.description ||
        'Selamat datang di **katalog akun premium** {server}! 💎\nSetiap post di forum ini adalah **1 produk** lengkap dengan **varian, harga & stok real-time**. Klik **🛒 Beli Sekarang** di post produk — akun dikirim **otomatis** setelah pembayaran QRIS terverifikasi. ⚡',
      name,
    ),
    [
      '### 🔎 Cara Pakai Katalog',
      '🏷️ **Filter tag** di atas forum untuk melihat kategori tertentu',
      '🟢 Pilih tag **Ready Stock** untuk produk yang bisa langsung dibeli',
      '🔍 **Cari nama produk** lewat kolom pencarian forum (misal: *Netflix*)',
      '🛒 Buka post produk → klik **Beli Sekarang**',
    ].join('\n'),
    catLines.length ? `### 📂 Kategori\n${catLines.join('\n')}` : null,
    [
      `🏪 **Status:** ${open ? '`🟢 BUKA 24 JAM`' : '`🔴 TUTUP`'}`,
      `🛍️ **Produk:** \`${num(ready)} ready / ${num(products.length)} produk\``,
      `💳 **Pembayaran:** \`${I.PAY_LABEL[I.payMode(p)]}\`${I.minTotal(p) ? ` • min. \`${rupiah(I.minTotal(p))}\`` : ''}`,
      `✅ **Order Selesai:** \`${num(productStatsOf(p.id).orders)} order\` • ⭐ **Rating Toko:** \`${avg} / 5\``,
    ].join('\n'),
    '### 🛡️ Garansi & Bantuan\nLama garansi tertera di tiap varian. Ada kendala akun? Buat **ticket bantuan** (pilih **👑 Bantuan Premium App**) & sertakan ID pesananmu.',
  ];
  for (const b of blocks.filter(Boolean)) {
    box.addSeparatorComponents(line());
    box.addTextDisplayComponents(text(b));
  }
  box.addSeparatorComponents(line());
  box.addTextDisplayComponents(text(`-# ${name.name} • Katalog diperbarui otomatis • <t:${Math.floor(Date.now() / 1000)}:R>`));
  const buttons = [];
  const pu = panelUrl(guild.id);
  if (pu) buttons.push(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(pu).setLabel('Panel Premium App').setEmoji('👑'));
  if (p.howTo) buttons.push(new ButtonBuilder().setCustomId(`store:howtobtn:${p.id}`).setLabel('Cara Order').setEmoji('📖').setStyle(ButtonStyle.Secondary));
  buttons.push(new ButtonBuilder().setCustomId(`store:insmine:${p.id}`).setLabel('Pesanan Saya').setEmoji('🎫').setStyle(ButtonStyle.Secondary));
  const hu = helpUrl(guild.id);
  if (hu) buttons.push(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(hu).setLabel('Bantuan').setEmoji('🛟'));
  box.addActionRowComponents(new ActionRowBuilder().addComponents(buttons.slice(0, 5)));
  return { components: [box], flags: V2F, allowedMentions: { parse: [] } };
}
const guideHash = (p, products) => JSON.stringify([isProductOpen(p), I.payMode(p), settings(p), products.map((x) => [x.category, x.sum.available, x.sum.min]), productStatsOf(p.id).orders, state.stats.ratingCount]);

// ───────────────────────── Membuat / mengedit post ─────────────────────────
async function createPost(forum, name, payload, fallback, tags, lock) {
  const opts = { name: clip(name, 100), autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek, appliedTags: tags };
  let thread;
  try {
    thread = await forum.threads.create({ ...opts, message: payload });
  } catch (err) {
    if (!fallback) throw err;
    console.warn('[forum] Components V2 ditolak di forum, pakai embed:', err.message);
    thread = await forum.threads.create({ ...opts, message: fallback });
  }
  if (lock) await thread.setLocked(true, 'Katalog: hanya bot yang menulis').catch(() => {});
  return thread;
}

/** Edit post. Return false kalau post sudah tidak ada (dihapus manual). */
async function editPost(threadId, payload, fallback, tags) {
  const thread = await client.channels.fetch(threadId).catch(() => null);
  if (!thread) return false;
  if (thread.archived) await thread.setArchived(false, 'Update katalog').catch(() => {});
  try {
    await thread.messages.edit(thread.id, payload);
  } catch (err) {
    if (err.code === RESTJSONErrorCodes.UnknownMessage) return false;
    if (!fallback) throw err;
    await thread.messages.edit(thread.id, fallback);
  }
  if (tags && JSON.stringify([...(thread.appliedTags || [])].sort()) !== JSON.stringify([...tags].sort())) {
    await thread.setAppliedTags(tags).catch((e) => console.warn('[forum] tag post:', e.message));
  }
  return true;
}

// ───────────────────────── Sinkronisasi ─────────────────────────
/**
 * Sinkron katalog forum. force = edit semua post walau tidak berubah.
 * Return ringkasan { created, updated, removed, total } atau { error }.
 */
async function sync({ force = false } = {}) {
  if (syncing) return { error: 'Sinkronisasi sedang berjalan, coba lagi sebentar.' };
  const cfg = loadConfig();
  const p = I.instantProduct(cfg);
  const chId = forumId(cfg, p);
  if (!client || !p || !chId || settings(p).enabled === false) return { error: 'Forum katalog belum diatur (store.json → produk-instan → forum.channelId).' };
  syncing = true;
  const res = { created: 0, updated: 0, removed: 0, total: 0 };
  try {
    const forum = await client.channels.fetch(chId).catch(() => null);
    if (!forum || forum.type !== ChannelType.GuildForum) return { error: `Channel <#${chId}> bukan **Forum Channel** atau tidak bisa diakses bot.` };
    const guild = forum.guild;
    let items;
    try {
      items = await W.getProducts({ force: true });
    } catch (err) {
      return { error: `Gagal mengambil produk dari Waroengkuy: ${err.message}` };
    }
    const products = productsFor(p, items);
    res.total = products.length;
    // Data kosong (API bermasalah) → jangan hapus semua post.
    if (!products.length && Object.keys(state.premiumForum?.posts || {}).length) return { error: 'Daftar produk kosong — sinkronisasi dilewati supaya post tidak terhapus.' };

    const fs = state.premiumForum && state.premiumForum.channelId === chId ? state.premiumForum : { channelId: chId, posts: {}, guide: null, setup: false };
    state.premiumForum = fs;

    // Pengaturan forum: tampilan galeri & urutan berdasarkan tanggal dibuat (sekali).
    if (!fs.setup) {
      await forum.setDefaultForumLayout(ForumLayoutType.GalleryView).catch(() => {});
      await forum.setDefaultSortOrder(SortOrderType.CreationDate).catch(() => {});
      if (!forum.topic) await forum.setTopic('👑 Katalog Premium App — klik post produk lalu tekan 🛒 Beli Sekarang. Akun dikirim otomatis!').catch(() => {});
      fs.setup = true;
      save();
    }
    const tagsFor = await ensureTags(forum, p, products);
    const lock = settings(p).lockPosts !== false;

    // Produk baru dibuat dari urutan terbalik → post terbaru (A–Z) tampil paling atas.
    const ids = new Set(products.map((x) => x.id));
    for (const prod of [...products].reverse()) {
      const tags = tagsFor(prod);
      const hash = hashOf(p, prod, tags);
      const cur = fs.posts[prod.id];
      try {
        if (cur) {
          if (!force && cur.hash === hash) continue;
          const ok = await editPost(cur.threadId, buildPost(guild, cfg, p, prod), buildPostEmbed(guild, cfg, p, prod), tags);
          if (ok) {
            cur.hash = hash;
            res.updated += 1;
            save();
            await sleep(400);
            continue;
          }
          delete fs.posts[prod.id]; // post dihapus manual → buat ulang
        }
        const thread = await createPost(forum, prod.name, buildPost(guild, cfg, p, prod), buildPostEmbed(guild, cfg, p, prod), tags, lock);
        fs.posts[prod.id] = { threadId: thread.id, hash };
        res.created += 1;
        save();
        await sleep(1200);
      } catch (err) {
        console.warn(`[forum] post ${prod.name}:`, err.message);
      }
    }
    // Produk yang tidak dijual lagi → hapus postnya.
    for (const [pid, post] of Object.entries(fs.posts)) {
      if (ids.has(pid)) continue;
      const th = await client.channels.fetch(post.threadId).catch(() => null);
      await th?.delete('Produk tidak dijual lagi').catch(() => {});
      delete fs.posts[pid];
      res.removed += 1;
      save();
    }

    // Post panduan (dibuat terakhir supaya paling atas, lalu di-pin).
    const gHash = guideHash(p, products);
    if (!fs.guide || force || fs.guide.hash !== gHash) {
      const payload = buildGuide(guild, cfg, p, products);
      const ok = fs.guide ? await editPost(fs.guide.threadId, payload, null, null).catch(() => false) : false;
      if (ok) fs.guide.hash = gHash;
      else {
        const thread = await createPost(forum, settings(p).guideTitle || '📌 Mulai di Sini — Cara Belanja Premium App', payload, null, [], lock).catch((e) => {
          console.warn('[forum] post panduan:', e.message);
          return null;
        });
        if (thread) {
          await thread.pin('Panduan katalog').catch(() => {});
          fs.guide = { threadId: thread.id, hash: gHash };
        }
      }
      save();
    }
    return res;
  } finally {
    syncing = false;
  }
}

function register(c) {
  client = c;
}
function start() {
  const cfg = loadConfig();
  const p = I.instantProduct(cfg);
  if (!p || !forumId(cfg, p)) return;
  // Sinkron pertama setelah katalog termuat, lalu tiap 10 menit.
  setTimeout(() => sync().catch((e) => console.warn('[forum] sync:', e.message)), 45 * 1000);
  setInterval(() => sync().catch((e) => console.warn('[forum] sync:', e.message)), SYNC_MS);
}

module.exports = { register, start, sync, buildPost, buildGuide, productsFor };
