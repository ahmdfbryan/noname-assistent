const fs = require('fs');
const path = require('path');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  LabelBuilder,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
  FileUploadBuilder,
  MessageFlags,
  PermissionFlagsBits,
  ChannelType,
  RESTJSONErrorCodes,
  Events,
} = require('discord.js');
const { loadConfig, isId, rupiah, num, getProduct, GROUPS, productsOf } = require('./config');
const { CANVA, BOOST } = require('../emojis');
const { archiveStoreTicket } = require('../ticket-archive');
const { openTicketThread, ensureOpen } = require('../ticket-thread');
const REP = require('./reputation');
const { state, save, productState, productStatsOf, hasStock, stockOf, setStock, stockUnit, isProductOpen, kindOf, activeTicketOf, nextTicketId, planStockOf, setPlanStock } = require('./state');
const { lookupRobloxUser, lookupGamepass, parseGamepassId } = require('./roblox');
const V = require('./views');
const SP = require('./spender');
const H = require('./howto');
const C = require('./catalog');
const I = require('./instant');
const { editPanelMessage } = require('./banner');
const F = require('./forum');
const CP = require('./control');

const { robuxSentProof } = require('./proof-card');
const { blurPaymentProof } = require('./pay-blur');
const PROOF_DIR = path.join(__dirname, '..', '..', 'data', 'proofs');
const SESSION_MS = 10 * 60 * 1000;
const sessions = new Map(); // userId → { productId, roblox, expires }
let client = null;

const EPH = MessageFlags.Ephemeral;
const isAdmin = (member) => member?.permissions?.has(PermissionFlagsBits.Administrator);
const channelUrl = (guildId, channelId) => `https://discord.com/channels/${guildId}/${channelId}`;

function getSession(userId) {
  const s = sessions.get(userId);
  if (!s || s.expires < Date.now()) {
    sessions.delete(userId);
    return null;
  }
  return s;
}


// ══════════════════════ Components V2 di dalam ticket ══════════════════════
const isV2Msg = (m) => Boolean(m?.flags?.has?.(MessageFlags.IsComponentsV2));
/** Pesan detail ticket: V2 untuk ticket baru, tampilan lama (embed) untuk ticket lama yang masih berjalan. */
function ticketPayloadFor(msg, guild, cfg, t) {
  const p = V.buildTicketMessage(guild, cfg, t);
  return !msg || isV2Msg(msg) ? V.toV2(p) : p;
}
async function editTicketMsg(channel, guild, cfg, t) {
  if (!channel || !t.messageId) return;
  const msg = await channel.messages.fetch(t.messageId).catch(() => null);
  if (msg) await msg.edit(ticketPayloadFor(msg, guild, cfg, t)).catch((e) => console.warn(`[store] edit ticket ${t.id}:`, e.message));
}
/** Hilangkan tombol dari pesan (V2: tombol di dalam kotak ikut dihapus, gambar tetap). */
async function stripRows(msg) {
  if (!msg) return;
  if (!isV2Msg(msg)) return msg.edit({ components: [] }).catch(() => {});
  const files = new Map([...msg.attachments.values()].map((a) => [String(a.url).split('?')[0], a.name]));
  const clean = (arr) =>
    arr
      .filter((c) => c.type !== 1)
      .map((c) => {
        if (c.type === 12) return { ...c, items: c.items.map((it) => ({ ...it, media: { url: files.has(String(it.media.url).split('?')[0]) ? `attachment://${files.get(String(it.media.url).split('?')[0])}` : it.media.url } })) };
        return c.components ? { ...c, components: clean(c.components) } : c;
      });
  return msg.edit({ components: clean(msg.components.map((c) => c.toJSON())) }).catch((e) => console.warn('[store] strip tombol:', e.message));
}
const v2 = (p) => V.toV2(p);

// ══════════════════════ Refresh panel & leaderboard (otomatis) ══════════════════════
const refreshTimers = {};
function debounce(key, fn, ms = 1500) {
  clearTimeout(refreshTimers[key]);
  refreshTimers[key] = setTimeout(() => fn().catch((e) => console.error(`[store] refresh ${key}:`, e.message)), ms);
}

async function editTracked(key, build) {
  const loc = state[key];
  if (!client || !loc) return;
  const channel = await client.channels.fetch(loc.channelId).catch(() => null);
  if (!channel) return;
  const cfg = loadConfig();
  if (!cfg) return;
  const payload = build(channel.guild, cfg);
  try {
    // Panel dengan lampiran (banner Premium App) → pakai ulang lampiran yang sudah ada, tidak upload ulang.
    if (payload.files?.length) await editPanelMessage(await channel.messages.fetch(loc.messageId), payload);
    else await channel.messages.edit(loc.messageId, payload);
  } catch (err) {
    if (err.code === RESTJSONErrorCodes.UnknownMessage) {
      state[key] = null; // pesan dihapus manual → berhenti di-update
      save();
    } else if (payload.flags) {
      // Pesan lama format embed tidak bisa diubah ke Components V2 → kirim baru & hapus yang lama.
      const sent = await channel.send(payload);
      await channel.messages.delete(loc.messageId).catch(() => {});
      state[key] = { channelId: channel.id, messageId: sent.id };
      save();
    } else throw err;
  }
}

// Panel How to Order ikut di-update (status buka/tutup, rate, stock).
const refreshPanel = () => {
  debounce('panel', () => editTracked('panel', (g, c) => V.buildPanel(g, c, 'main')));
  debounce('digitalPanel', () => editTracked('digitalPanel', (g, c) => V.buildPanel(g, c, 'digital')), 2000);
  debounce('instantPanel', () => editTracked('instantPanel', I.buildPanel), 3000);
  debounce('controlPanel', () => CP.refresh(), 2500); // 🎛️ Store Control Center (panel admin)
  debounce('howto', () => editTracked('howto', H.buildHowToPanel), 2500);
  // Panel "Cara Order" per produk (status buka/tutup, rate, stock ikut ter-update)
  for (const p of loadConfig()?.products || []) {
    if (state[`howto_${p.id}`]) debounce(`howto_${p.id}`, () => editTracked(`howto_${p.id}`, (g, c) => H.buildHowToGuide(g, c, p.id)), 2800);
  }
  debounce('catalog', () => refreshCatalog('main'), 3500);
  debounce('digitalCatalog', () => refreshCatalog('digital'), 4500);
};

/** Kirim katalog lengkap (header + kotak tiap produk) berurutan, lalu hapus katalog lama. group = main | digital. */
async function postCatalog(channel, cfg, group = 'main') {
  const key = GROUPS[group].catalogKey;
  const guild = channel.guild;
  const old = state[key];
  const header = await channel.send(C.buildCatalogHeader(guild, cfg, group));
  const cards = {};
  for (const p of C.catalogProducts(cfg, group)) cards[p.id] = (await channel.send(C.buildCatalogCard(guild, cfg, p))).id;
  state[key] = { channelId: channel.id, headerId: header.id, cards };
  save();
  if (old) {
    const oldCh = await guild.channels.fetch(old.channelId).catch(() => null);
    for (const id of [old.headerId, ...Object.values(old.cards || {})]) if (id) await oldCh?.messages.delete(id).catch(() => {});
  }
  return cards;
}

/** Update semua kotak di channel catalog (header + kotak tiap produk). */
async function refreshCatalog(group = 'main') {
  const loc = state[GROUPS[group].catalogKey];
  if (!client || !loc) return;
  const channel = await client.channels.fetch(loc.channelId).catch(() => null);
  const cfg = loadConfig();
  if (!channel || !cfg) return;
  const products = C.catalogProducts(cfg, group);
  // Daftar produk berubah (misal Canva Pro pindah ke katalog Produk Digital) → kirim ulang katalog supaya rapi.
  const want = products.map((p) => p.id).join(',');
  const have = Object.keys(loc.cards || {}).join(',');
  if (want !== have) {
    console.log(`[store] daftar produk katalog ${group} berubah → katalog dikirim ulang.`);
    await postCatalog(channel, cfg, group);
    return;
  }
  const jobs = [[loc.headerId, () => C.buildCatalogHeader(channel.guild, cfg, group)]];
  for (const p of products) jobs.push([loc.cards[p.id], () => C.buildCatalogCard(channel.guild, cfg, p)]);
  for (const [messageId, build] of jobs) {
    if (!messageId) continue;
    try {
      const payload = build();
      // Gambar produk sudah ada di pesan → tidak perlu upload ulang setiap update.
      if (payload.files?.length) {
        const msg = await channel.messages.fetch(messageId).catch(() => null);
        const names = new Set(msg ? [...msg.attachments.values()].map((a) => a.name) : []);
        if (msg && payload.files.every((f) => names.has(f.name))) delete payload.files;
      }
      await channel.messages.edit(messageId, payload);
    } catch (err) {
      if (err.code === RESTJSONErrorCodes.UnknownMessage) continue;
      // Katalog lama format embed tidak bisa diubah ke Components V2 → kirim ulang semuanya (urutan tetap).
      console.log('[store] katalog lama (embed) diganti ke tampilan Components V2:', err.message);
      await postCatalog(channel, cfg, group);
      return;
    }
  }
}
const refreshLeaderboard = () => {
  debounce('leaderboard', () => editTracked('leaderboard', V.buildLeaderboard));
  refreshReputation();
};
// Panel Store Reputation (rating, statistik, feedback terbaru).
const refreshReputation = () => debounce('reputation', () => editTracked('reputation', REP.buildReputation), 2500);

// ══════════════════════ Pengumuman di channel stock ══════════════════════
/** Kirim pengumuman ke channel stock. Return { ok, url } atau { ok: false, error } (dipakai Control Center untuk konfirmasi). */
async function announce(guild, kind, extra = {}, ping = false) {
  const cfg = loadConfig();
  if (!isId(cfg?.channels?.stock)) return { ok: false, error: 'channels.stock di store.json belum diisi' };
  const channel = await guild.channels.fetch(cfg.channels.stock).catch(() => null);
  if (!channel?.isTextBased()) return { ok: false, error: `channel stock (${cfg.channels.stock}) tidak ditemukan / bot tidak bisa melihatnya` };
  // Components V2 (premium). Kalau gagal dibuat, pakai tampilan embed lama.
  let payload = extra.payload || null; // pengumuman yang sudah disusun (misal Status Toko dari Control Center)
  try {
    if (!payload) payload = V.buildStoreAnnouncementV2(guild, cfg, kind, extra, ping);
  } catch (e) {
    console.warn('[store] pengumuman V2 gagal dibuat, pakai embed:', e.message);
  }
  if (!payload) {
    payload = {
      content: ping ? '@everyone' : undefined,
      embeds: [V.buildStoreAnnouncement(guild, cfg, kind, extra)],
      allowedMentions: { parse: ping ? ['everyone'] : [] },
    };
  }
  try {
    const sent = await channel.send(payload);
    return { ok: true, url: sent.url, channelId: channel.id };
  } catch (e) {
    console.error('[store] gagal kirim pengumuman:', e.message);
    return { ok: false, error: e.message, channelId: channel.id };
  }
}

/**
 * Buka / tutup satu atau beberapa produk sekaligus (1 pengumuman gabungan).
 * auto = true → ditutup otomatis karena stock habis. Produk yang tutup otomatis akan BUKA LAGI
 * otomatis saat stock kembali (cancel / refund / stock ditambah). Produk yang ditutup manual
 * lewat /store tutup tetap tutup sampai admin membukanya.
 */
async function setProductsOpen(guild, products, open, { reason, auto = false, statusGif = false } = {}) {
  const cfg = loadConfig();
  for (const p of products) {
    const ps = productState(p.id);
    ps.open = open;
    ps.autoClosed = !open && auto;
  }
  save();
  refreshPanel();
  if (products.length) {
    return announce(guild, open ? 'open' : 'close', { reason, products, statusGif }, Boolean(cfg?.pingEveryone?.[open ? 'open' : 'close']));
  }
  return null;
}

const robuxProduct = (cfg) => (cfg?.products || []).find((p) => p.type === 'robux') || null;

/**
 * Stock kembali tersedia & produk sebelumnya tutup karena stock habis → buka lagi otomatis.
 * product kosong → cek semua produk ber-stock (Robux & Canva).
 */
async function reopenIfAutoClosed(guild, product) {
  const list = product ? [product] : (loadConfig()?.products || []).filter(hasStock);
  const reopen = list.filter((p) => {
    const ps = productState(p.id);
    return !ps.open && ps.autoClosed && stockOf(p) > 0;
  });
  if (reopen.length) await setProductsOpen(guild, reopen, true);
  return reopen.length > 0;
}

/** Stock habis & produk masih buka → tutup otomatis (default: Robux Visend). */
async function closeIfSoldOut(guild, reason, product = robuxProduct(loadConfig())) {
  if (product && stockOf(product) <= 0 && productState(product.id).open) {
    await setProductsOpen(guild, [product], false, { reason, auto: true });
    return true;
  }
  return false;
}

// ══════════════════════ Log order (1 pesan per ticket, di-edit otomatis) ══════════════════════
const logQueues = new Map();

/**
 * Catat kejadian ke riwayat ticket & perbarui pesan log di channel log.
 * Antrian per ticket supaya pesan log tidak terkirim dobel saat kejadian beruntun.
 */
function logOrder(guild, t, text) {
  if (text) {
    t.log = t.log || [];
    t.log.push({ at: Date.now(), text });
    save();
  }
  const prev = logQueues.get(t.id) || Promise.resolve();
  const next = prev
    .then(async () => {
      const cfg = loadConfig();
      if (!isId(cfg?.channels?.log) || !guild) return;
      const channel = await guild.channels.fetch(cfg.channels.log).catch(() => null);
      if (!channel?.isTextBased()) return;
      // Foto profil pembeli untuk kartu history (diambil sekali, disimpan di data ticket).
      if (!t.buyerAvatar) {
        const u = await guild.client.users.fetch(buyerOf(t)).catch(() => null);
        if (u) {
          t.buyerAvatar = u.displayAvatarURL({ extension: 'png', size: 256 });
          save();
        }
      }
      const payload = V.buildOrderLog(guild, cfg, t);
      // Gambar bukti pengiriman (bagian Progress). File sudah tidak ada tapi lampiran lama masih di pesan → biarkan.
      const imgFiles = t.logImageFile && fs.existsSync(t.logImageFile) ? [{ attachment: t.logImageFile, name: t.logImageName }] : [];

      if (t.logMessageId) {
        try {
          await channel.messages.edit(t.logMessageId, imgFiles.length ? { ...payload, files: imgFiles, attachments: [] } : t.logImageName ? payload : { ...payload, attachments: [] });
          return;
        } catch (err) {
          // Pesan log lama (format embed) tidak bisa diubah ke Components V2 → kirim baru & hapus yang lama.
          if (err.code !== RESTJSONErrorCodes.UnknownMessage) {
            await channel.messages.delete(t.logMessageId).catch(() => {});
          }
        }
      }
      const msg = await channel.send(imgFiles.length ? { ...payload, files: imgFiles } : payload);
      t.logMessageId = msg.id;
      save();
    })
    .catch((e) => console.error(`[store] log order ${t.id}:`, e.message));
  logQueues.set(t.id, next);
  return next;
}

// ══════════════════════ Kategori ticket (maks 50 channel / kategori) ══════════════════════
async function getTicketCategory(guild, cfg, base = cfg.ticket?.categoryName || '🎫 TICKET ORDER') {
  const max = Math.min(Number(cfg.ticket?.maxPerCategory) || 50, 50);
  await guild.channels.fetch();
  const categories = guild.channels.cache
    .filter((c) => c.type === ChannelType.GuildCategory && c.name.startsWith(base))
    .sort((a, b) => a.position - b.position);

  for (const cat of categories.values()) {
    const children = guild.channels.cache.filter((c) => c.parentId === cat.id).size;
    if (children < max) return cat;
  }
  const name = categories.size ? `${base} ${categories.size + 1}` : base;
  return guild.channels.create({
    name,
    type: ChannelType.GuildCategory,
    permissionOverwrites: [{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }],
  });
}

/**
 * Buat tempat ticket: PRIVATE THREAD di channel tempat tombol ditekan (channel panel produk),
 * atau cara lama (channel baru di kategori ticket) kalau thread tidak bisa dibuat / dimatikan (store.json → ticket.useThreads: false).
 * opts: { name, topic, overwrites, userIds, categoryName }
 */
async function createTicketChannel(guild, interaction, cfg, opts) {
  if (cfg.ticket?.useThreads !== false) {
    const thread = await openTicketThread(guild, interaction, {
      name: opts.name,
      userIds: opts.userIds,
      reason: opts.topic,
      fallbackIds: [cfg.channels?.panel, cfg.channels?.instantPanel],
    });
    if (thread) return thread;
  }
  const category = await getTicketCategory(guild, cfg, opts.categoryName);
  return guild.channels.create({
    name: opts.name,
    type: ChannelType.GuildText,
    parent: category.id,
    topic: opts.topic,
    permissionOverwrites: opts.overwrites,
  });
}

// ══════════════════════ Langkah 1: klik produk di panel → info produk ══════════════════════
async function onProductInfo(interaction, productId) {
  const cfg = loadConfig();
  const product = getProduct(cfg, productId);
  const eph = (p) => ({ ...p, flags: (p.flags || 0) | EPH });
  if (product?.type === 'rekber') return interaction.reply(eph(V.buildRekberInfo(interaction.guild, cfg, product)));
  if (product?.type === 'gamepass') return interaction.reply(eph(V.buildGamepassInfo(interaction.guild, cfg, product)));
  if (product?.type === 'gift') return interaction.reply(eph(V.buildGiftInfo(interaction.guild, cfg, product)));
  if (product?.type === 'canva') return interaction.reply(eph(V.buildCanvaInfo(interaction.guild, cfg, product)));
  if (product?.type === 'boost') return interaction.reply(eph(V.buildBoostInfo(interaction.guild, cfg, product)));
  if (product?.type === 'instant') return I.onInfo(interaction, product);
  if (!product || product.type !== 'robux') {
    return interaction.reply({ content: '🔒 Produk ini **Coming Soon** — nantikan ya!', flags: EPH });
  }
  return interaction.reply(eph(V.buildProductInfo(interaction.guild, cfg, product)));
}

/** Tombol "Syarat Pembelian" di info produk. */
async function onTerms(interaction, productId) {
  const cfg = loadConfig();
  const product = getProduct(cfg, productId);
  if (!product?.terms?.description) return interaction.reply({ content: 'Tidak ada syarat khusus untuk produk ini.', flags: EPH });
  const p = V.buildProductTerms(interaction.guild, cfg, product);
  return interaction.reply({ ...p, flags: (p.flags || 0) | EPH });
}

// ══════════════════════ Langkah 1b: klik "Beli Sekarang" → form username ══════════════════════
async function onBuy(interaction, productId) {
  const cfg = loadConfig();
  const product = getProduct(cfg, productId);
  if (product?.type === 'rekber') return onRekberStart(interaction, product);
  if (product?.type === 'gamepass') return onGamepassStart(interaction, product);
  if (product?.type === 'gift') return onGiftStart(interaction, product);
  if (product?.type === 'canva') return onCanvaStart(interaction, product);
  if (product?.type === 'boost') return onBoostStart(interaction, product);
  if (product?.type === 'instant') return I.onInfo(interaction, product);
  if (!product || product.type !== 'robux') {
    return interaction.reply({ content: '🔒 Produk ini **Coming Soon** — nantikan ya!', flags: EPH });
  }
  if (!isProductOpen(product)) {
    refreshPanel();
    return interaction.reply({ content: `🔴 **${product.label}** sedang **TUTUP**. Pantau channel stock untuk info buka berikutnya.`, flags: EPH });
  }
  const active = activeTicketOf({ userId: interaction.user.id });
  if (active) {
    return interaction.reply({
      content: `⚠️ Kamu masih punya ticket yang sedang berjalan: <#${active.channelId}> (\`${active.id}\`).\nTunggu ticket itu ditutup admin sebelum membuat pesanan baru.`,
      flags: EPH,
    });
  }

  const modal = new ModalBuilder()
    .setCustomId(`store:rbxmodal:${product.id}`)
    .setTitle(`${product.label} — Akun Roblox`)
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('Username Roblox')
        .setDescription('Masukkan username (bukan display name) akun Roblox penerima.')
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId('username')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('contoh: Builderman')
            .setMinLength(3)
            .setMaxLength(20)
            .setRequired(true),
        ),
    );
  return interaction.showModal(modal);
}

// ══════════════════════ Langkah 2: cek username Roblox ══════════════════════
async function onRobloxModal(interaction, productId) {
  await interaction.deferReply({ flags: EPH });
  const cfg = loadConfig();
  const username = interaction.fields.getTextInputValue('username');

  let roblox;
  try {
    roblox = await lookupRobloxUser(username);
  } catch (err) {
    console.error('[store] cek Roblox gagal:', err.message);
    return interaction.editReply('⚠️ Gagal menghubungi server Roblox. Coba lagi beberapa saat lagi.');
  }
  if (!roblox) {
    return interaction.editReply(`❌ Username Roblox \`${username}\` tidak ditemukan. Pastikan ejaannya benar (pakai **username**, bukan display name).`);
  }

  const active = activeTicketOf({ robloxId: roblox.id });
  if (active) {
    return interaction.editReply(
      `⚠️ Akun Roblox \`@${roblox.name}\` masih punya ticket yang sedang berjalan (\`${active.id}\`).\nTunggu ticket itu ditutup sebelum membuat pesanan baru.`,
    );
  }

  sessions.set(interaction.user.id, { productId, roblox, expires: Date.now() + SESSION_MS });
  return interaction.editReply(V.buildConfirmAccount(cfg, roblox));
}

// ══════════════════════ Langkah 3: konfirmasi akun ══════════════════════
async function onConfirm(interaction, yes) {
  if (!yes) {
    sessions.delete(interaction.user.id);
    return interaction.update({ content: '✖️ Pesanan dibatalkan.', embeds: [], components: [] });
  }
  const session = getSession(interaction.user.id);
  if (!session) {
    return interaction.update({ content: '⌛ Sesi sudah berakhir. Silakan klik tombol produk lagi.', embeds: [], components: [] });
  }
  const cfg = loadConfig();
  const product = getProduct(cfg, session.productId);
  if (!isProductOpen(product)) {
    return interaction.update({ content: `🔴 Maaf, **${product?.label || 'produk ini'}** baru saja **TUTUP**.`, embeds: [], components: [] });
  }
  return interaction.update({ content: null, ...V.buildAmountPicker(cfg, product, session.roblox) });
}

// ══════════════════════ Langkah 4: pilih jumlah ══════════════════════
async function onAmountSelect(interaction, productId) {
  const value = interaction.values[0];
  if (value === 'custom') {
    const product = getProduct(loadConfig(), productId);
    const max = Number(product?.maxAmount) || 5000;
    const modal = new ModalBuilder()
      .setCustomId(`store:amountmodal:${productId}`)
      .setTitle('Jumlah Robux')
      .addLabelComponents(
        new LabelBuilder()
          .setLabel('Jumlah Robux')
          .setDescription(`Minimal ${num(product ? V.minAmountOf(product) : 1)}, maksimal ${num(max)} Robux${product && V.stepOf(product) > 1 ? `, kelipatan ${num(V.stepOf(product))}` : ''}. Sisa stock: ${num(state.stock)}.`)
          .setTextInputComponent(
            new TextInputBuilder()
              .setCustomId('amount')
              .setStyle(TextInputStyle.Short)
              .setPlaceholder(`contoh: 1500`)
              .setMinLength(1)
              .setMaxLength(6)
              .setRequired(true),
          ),
      );
    return interaction.showModal(modal);
  }
  return createOrder(interaction, productId, Number(value));
}

async function onAmountModal(interaction, productId) {
  const raw = interaction.fields.getTextInputValue('amount').replace(/[.,\s]/g, '');
  return createOrder(interaction, productId, Number(raw));
}

// ══════════════════════ Langkah 5: buat ticket ══════════════════════
async function createOrder(interaction, productId, amount) {
  const cfg = loadConfig();
  const product = getProduct(cfg, productId);
  const session = getSession(interaction.user.id);
  const guild = interaction.guild;

  const fail = (content, keepPicker = false) =>
    interaction.update(
      keepPicker && session ? { content, ...V.buildAmountPicker(cfg, product, session.roblox) } : { content, embeds: [], components: [] },
    );

  if (!session || !product) return fail('⌛ Sesi sudah berakhir. Silakan klik tombol produk lagi.');
  const min = V.minAmountOf(product);
  const step = V.stepOf(product);
  const max = Number(product.maxAmount) || 5000;
  if (!Number.isInteger(amount) || amount < min || amount > max) {
    return fail(`❌ Jumlah tidak valid. Masukkan angka **${num(min)} – ${num(max)}** Robux${step > 1 ? ` (kelipatan ${num(step)})` : ''}.`, true);
  }
  if (amount % step !== 0) {
    return fail(`❌ Jumlah harus **kelipatan ${num(step)}** Robux (contoh: ${num(min)}, ${num(min + step)}, ${num(min + step * 2)}).`, true);
  }
  if (!isProductOpen(product)) return fail(`🔴 Maaf, **${product.label}** sedang **TUTUP** atau stock sudah habis.`);
  if (amount > state.stock) {
    return fail(
      `⚠️ **Stock tidak mencukupi.** Sisa stock saat ini hanya **${num(state.stock)} Robux**.\nSilakan pilih jumlah **maksimal ${num(state.stock)} Robux**.`,
      true,
    );
  }
  if (activeTicketOf({ userId: interaction.user.id }) || activeTicketOf({ robloxId: session.roblox.id })) {
    return fail('⚠️ Kamu / akun Roblox ini masih punya ticket yang sedang berjalan. Tunggu ticket itu ditutup dulu.');
  }

  // Kunci stock SEKARANG (sebelum proses async) supaya tidak bisa terjual dobel.
  const rate = V.rateOf(cfg, product);
  const id = nextTicketId(cfg.ticket?.idPrefix);
  state.stock -= amount;
  const ticket = {
    id,
    guildId: guild.id,
    userId: interaction.user.id,
    channelId: null,
    messageId: null,
    roblox: session.roblox,
    productId: product.id,
    productLabel: product.label,
    amount,
    rate,
    price: amount * rate,
    status: 'open',
    createdAt: Date.now(),
  };
  state.tickets[id] = ticket;
  save();
  sessions.delete(interaction.user.id);

  await interaction.update({ content: '⏳ Sedang membuat ticket kamu...', embeds: [], components: [] });

  try {
    const overwrites = [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      {
        id: interaction.user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks,
        ],
      },
      {
        id: guild.members.me.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.ManageChannels,
        ],
      },
    ];
    if (isId(cfg.ticket?.staffRoleId)) {
      overwrites.push({
        id: cfg.ticket.staffRoleId,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
      });
    }
    const slug = session.roblox.name.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20);
    const channel = await createTicketChannel(guild, interaction, cfg, {
      name: `🎫・${id.toLowerCase()}-${slug}`,
      topic: `${id} • ${product.label} ${num(amount)} Robux • ${interaction.user.tag} • Roblox @${session.roblox.name}`,
      overwrites,
      userIds: [interaction.user.id],
    });
    ticket.channelId = channel.id;

    const msg = await channel.send(
      v2({
        content: `<@${interaction.user.id}>${isId(cfg.ticket?.staffRoleId) ? ` <@&${cfg.ticket.staffRoleId}>` : ''}`,
        ...V.buildTicketMessage(guild, cfg, ticket),
        allowedMentions: { users: [interaction.user.id], roles: isId(cfg.ticket?.staffRoleId) ? [cfg.ticket.staffRoleId] : [] },
      }),
    );
    await msg.pin().catch(() => {});
    ticket.messageId = msg.id;
    save();
    logOrder(guild, ticket, '🆕 Order received — awaiting payment');

    const url = channelUrl(guild.id, channel.id);
    const dmOk = await interaction.user
      .send(V.dm(V.buildDmCreated(guild, cfg, ticket, url)))
      .then(() => true)
      .catch(() => false);
    if (!dmOk) {
      channel.send('ℹ️ Bot tidak bisa mengirim DM ke kamu (DM tertutup). Semua info pesanan ada di ticket ini.').catch(() => {});
    }

    await interaction.editReply({
      content: `✅ **Ticket berhasil dibuat!** Lanjutkan pembayaran di ${channel}.`,
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Buka Ticket').setEmoji('🎫').setURL(url),
        ),
      ],
    });
  } catch (err) {
    // Gagal membuat ticket → kembalikan stock & hapus data ticket.
    console.error('[store] gagal membuat ticket:', err);
    state.stock += amount;
    delete state.tickets[id];
    save();
    await interaction
      .editReply('❌ Gagal membuat ticket. Pastikan bot punya izin **Manage Channels** & **Manage Roles**, lalu coba lagi.')
      .catch(() => {});
    refreshPanel();
    return;
  }

  refreshPanel();
  const closed = await closeIfSoldOut(guild, `📦 **Stock Robux hari ini sudah HABIS!** ${product.label} otomatis ditutup.`);
  // Info sisa stock di channel stock (kalau habis → sudah diumumkan lewat pengumuman tutup).
  if (!closed) announceSold(guild, product, amount);
}

/**
 * Pengumuman "Robux terjual, sisa stock X" di channel stock.
 * Order beruntun dalam 15 detik digabung jadi 1 pengumuman (tidak spam).
 * Matikan dengan "announceSold": false di store.json.
 */
const soldBuffer = new Map(); // productId → { amount, count, timer }
function announceSold(guild, product, amount) {
  if (loadConfig()?.announceSold === false) return;
  const b = soldBuffer.get(product.id) || { amount: 0, count: 0, timer: null };
  b.amount += amount;
  b.count += 1;
  clearTimeout(b.timer);
  b.timer = setTimeout(() => {
    soldBuffer.delete(product.id);
    if (stockOf(product) <= 0) return; // sudah habis → pengumuman tutup sudah terkirim
    announce(guild, 'sold', { product, amount: b.amount, count: b.count }).catch(() => {});
  }, 15000);
  soldBuffer.set(product.id, b);
}

// ══════════════════════ REKBER (rekening bersama) ══════════════════════
const rekberSessions = new Map(); // userId → { draft, expires }

/** Klik "Buat Ticket Rekber" → form isian rekber. */
async function onRekberStart(interaction, product) {
  if (!isProductOpen(product)) {
    refreshPanel();
    return interaction.reply({ content: `🔴 Layanan **${product.label}** sedang **TUTUP**.`, flags: EPH });
  }
  const active = activeTicketOf({ userId: interaction.user.id, kind: 'rekber' });
  if (active) {
    return interaction.reply({
      content: `⚠️ Kamu masih punya transaksi rekber yang sedang berjalan: <#${active.channelId}> (\`${active.id}\`).\nSelesaikan transaksi itu dulu sebelum membuat rekber baru.`,
      flags: EPH,
    });
  }

  const modal = new ModalBuilder()
    .setCustomId(`store:rbmodal:${product.id}`)
    .setTitle('Buat Transaksi Rekber')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('Pihak Lawan Transaksi')
        .setDescription('Ketik username Discord pihak yang bertransaksi denganmu.')
        .setUserSelectMenuComponent(
          new UserSelectMenuBuilder().setCustomId('partner').setPlaceholder('🔍 Cari username Discord...').setMinValues(1).setMaxValues(1).setRequired(true),
        ),
      new LabelBuilder()
        .setLabel('Peran Kamu')
        .setStringSelectMenuComponent(
          new StringSelectMenuBuilder()
            .setCustomId('role')
            .setPlaceholder('Pilih peranmu dalam transaksi...')
            .setRequired(true)
            .addOptions(
              { label: 'Saya Pembeli', description: 'Saya yang membayar & menerima barang / jasa', value: 'buyer', emoji: '🛒' },
              { label: 'Saya Penjual', description: 'Saya yang mengirim barang / jasa & menerima dana', value: 'seller', emoji: '🏷️' },
            ),
        ),
      new LabelBuilder()
        .setLabel('Transaksi Untuk Apa?')
        .setDescription('Barang / jasa yang diperjualbelikan.')
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId('item')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('contoh: Akun Roblox / Jasa joki / Item game')
            .setMinLength(3)
            .setMaxLength(100)
            .setRequired(true),
        ),
      new LabelBuilder()
        .setLabel('Nominal Transaksi (Rp)')
        .setDescription(`Minimal ${rupiah(product.minNominal || 0)} • maksimal ${rupiah(product.maxNominal || 0)}`)
        .setTextInputComponent(
          new TextInputBuilder().setCustomId('nominal').setStyle(TextInputStyle.Short).setPlaceholder('contoh: 150000').setMaxLength(12).setRequired(true),
        ),
      new LabelBuilder()
        .setLabel('Detail Kesepakatan (opsional)')
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId('detail')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('contoh: Akun level 50, include 3 gamepass, garansi 1x24 jam')
            .setMaxLength(500)
            .setRequired(false),
        ),
    );
  return interaction.showModal(modal);
}

/** Form rekber dikirim → validasi → tampilkan ringkasan untuk dikonfirmasi. */
async function onRekberModal(interaction, productId) {
  await interaction.deferReply({ flags: EPH });
  const cfg = loadConfig();
  const product = getProduct(cfg, productId);
  if (!product || product.type !== 'rekber') return interaction.editReply('❌ Layanan rekber tidak ditemukan.');
  if (!isProductOpen(product)) return interaction.editReply(`🔴 Layanan **${product.label}** sedang **TUTUP**.`);

  const partner = interaction.fields.getSelectedUsers('partner')?.first?.();
  const role = interaction.fields.getStringSelectValues('role')?.[0];
  const item = interaction.fields.getTextInputValue('item').trim();
  const detail = (interaction.fields.getTextInputValue('detail') || '').trim();
  const nominal = Number(interaction.fields.getTextInputValue('nominal').replace(/[^\d]/g, ''));

  if (!partner) return interaction.editReply('❌ Pilih pihak lawan transaksi.');
  if (partner.id === interaction.user.id) return interaction.editReply('❌ Pihak lawan transaksi tidak boleh dirimu sendiri.');
  if (partner.bot) return interaction.editReply('❌ Pihak lawan transaksi tidak boleh bot.');
  const partnerMember = await interaction.guild.members.fetch(partner.id).catch(() => null);
  if (!partnerMember) return interaction.editReply(`❌ ${partner} tidak ada di server ini.`);
  const min = Number(product.minNominal) || 0;
  const max = Number(product.maxNominal) || Infinity;
  if (!Number.isFinite(nominal) || nominal < min || nominal > max) {
    return interaction.editReply(`❌ Nominal tidak valid. Masukkan angka **${rupiah(min)} – ${rupiah(max)}**.`);
  }
  for (const uid of [interaction.user.id, partner.id]) {
    const active = activeTicketOf({ userId: uid, kind: 'rekber' });
    if (active) {
      return interaction.editReply(
        `⚠️ <@${uid}> masih punya transaksi rekber yang sedang berjalan (\`${active.id}\`). Selesaikan dulu sebelum membuat rekber baru.`,
      );
    }
  }

  const { fee, buyerPays, sellerGets, byBuyer } = V.rekberFee(product, nominal);
  if (sellerGets <= 0) return interaction.editReply('❌ Nominal terlalu kecil dibanding fee rekber.');
  const draft = {
    productId: product.id,
    partnerId: partner.id,
    buyerId: role === 'seller' ? partner.id : interaction.user.id,
    sellerId: role === 'seller' ? interaction.user.id : partner.id,
    item,
    detail: detail || null,
    nominal,
    fee,
    buyerPays,
    sellerGets,
    feeByBuyer: byBuyer,
  };
  rekberSessions.set(interaction.user.id, { draft, expires: Date.now() + SESSION_MS });
  return interaction.editReply(V.buildRekberConfirm(interaction.guild, cfg, draft));
}

/** Konfirmasi ringkasan → buat ticket rekber untuk kedua pihak. */
async function onRekberConfirm(interaction, yes) {
  const sess = rekberSessions.get(interaction.user.id);
  rekberSessions.delete(interaction.user.id);
  if (!yes) return interaction.update({ content: '✖️ Transaksi rekber dibatalkan.', embeds: [], components: [] });
  if (!sess || sess.expires < Date.now()) {
    return interaction.update({ content: '⌛ Sesi sudah berakhir. Silakan klik tombol Rekber lagi.', embeds: [], components: [] });
  }
  const cfg = loadConfig();
  const guild = interaction.guild;
  const d = sess.draft;
  const product = getProduct(cfg, d.productId);
  if (!isProductOpen(product)) return interaction.update({ content: '🔴 Layanan rekber baru saja **TUTUP**.', embeds: [], components: [] });
  for (const uid of [interaction.user.id, d.partnerId]) {
    if (activeTicketOf({ userId: uid, kind: 'rekber' })) {
      return interaction.update({ content: `⚠️ <@${uid}> masih punya transaksi rekber yang sedang berjalan.`, embeds: [], components: [] });
    }
  }

  const rc = cfg.rekberTicket || {};
  const id = nextTicketId(rc.idPrefix || 'RB', 'rekberSeq');
  const ticket = {
    id,
    kind: 'rekber',
    guildId: guild.id,
    userId: interaction.user.id,
    ...d,
    productLabel: product.label,
    stage: { agreed: false, funded: false, received: false },
    channelId: null,
    messageId: null,
    status: 'open',
    createdAt: Date.now(),
  };
  state.tickets[id] = ticket;
  save();
  await interaction.update({ content: '⏳ Sedang membuat ticket rekber...', embeds: [], components: [] });

  try {
    const member = [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.AttachFiles,
      PermissionFlagsBits.EmbedLinks,
    ];
    const overwrites = [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: ticket.buyerId, allow: member },
      { id: ticket.sellerId, allow: member },
      { id: guild.members.me.id, allow: [...member, PermissionFlagsBits.ManageChannels] },
    ];
    if (isId(cfg.ticket?.staffRoleId)) {
      overwrites.push({ id: cfg.ticket.staffRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
    }
    const slug = interaction.user.username.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20);
    const channel = await createTicketChannel(guild, interaction, cfg, {
      name: `🤝・${id.toLowerCase()}-${slug}`,
      topic: `Rekber ${id} • ${d.item} • ${rupiah(d.nominal)}`,
      overwrites,
      userIds: [ticket.buyerId, ticket.sellerId],
      categoryName: rc.categoryName || '🤝 TICKET REKBER',
    });
    ticket.channelId = channel.id;

    const pings = [ticket.buyerId, ticket.sellerId];
    const msg = await channel.send(
      v2({
        content: pings.map((u) => `<@${u}>`).join(' ') + (isId(cfg.ticket?.staffRoleId) ? ` <@&${cfg.ticket.staffRoleId}>` : ''),
        ...V.buildTicketMessage(guild, cfg, ticket),
        allowedMentions: { users: pings, roles: isId(cfg.ticket?.staffRoleId) ? [cfg.ticket.staffRoleId] : [] },
      }),
    );
    await msg.pin().catch(() => {});
    ticket.messageId = msg.id;
    save();
    logOrder(guild, ticket, '🆕 Escrow transaction started');

    await channel.send(v2(V.buildRekberStep(guild, cfg, ticket, 'invite'))).catch(() => {});

    const url = channelUrl(guild.id, channel.id);
    for (const uid of pings) {
      const user = await client.users.fetch(uid).catch(() => null);
      await user?.send(V.dm(V.buildRekberDmCreated(guild, cfg, ticket, url, uid))).catch(() => {});
    }
    await interaction.editReply({
      content: `✅ **Ticket rekber berhasil dibuat!** Lanjutkan transaksi di ${channel}.`,
      components: [
        new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Buka Ticket Rekber').setEmoji('🤝').setURL(url)),
      ],
    });
  } catch (err) {
    console.error('[store] gagal membuat ticket rekber:', err);
    delete state.tickets[id];
    save();
    await interaction
      .editReply('❌ Gagal membuat ticket rekber. Pastikan bot punya izin **Manage Channels** & **Manage Roles**, lalu coba lagi.')
      .catch(() => {});
  }
}

/** Update tampilan ticket rekber + kirim log langkah di channel. */
// Teks riwayat untuk log publik (tanpa nama admin / detail sensitif).
const STEP_LOG = {
  agreed: () => '🤝 Both parties agreed to the transaction',
  funded: () => '💰 Buyer’s funds secured by admin',
  received: () => '📦 Buyer received the item / service',
};
const CLOSE_LOG = {
  robux: { completed: '✅ Robux delivered successfully', cancelled: '❌ Order cancelled', refund: '💸 Funds returned to the buyer' },
  canva: { completed: '✅ Canva Pro activated', cancelled: '❌ Order cancelled', refund: '💸 Funds returned to the buyer' },
  instant: { completed: '✅ Account delivered', cancelled: '❌ Order cancelled', refund: '💸 Funds returned to the buyer' },
  boost: { completed: '✅ Server Boost activated', cancelled: '❌ Order cancelled', refund: '💸 Funds returned to the buyer' },
  gift: { completed: '✅ Item gifted in-game successfully', cancelled: '❌ Order cancelled', refund: '💸 Funds returned to the buyer' },
  gamepass: { completed: '✅ Gamepass purchased — Robux arrive after the pending period', cancelled: '❌ Order cancelled', refund: '💸 Funds returned to the buyer' },
  rekber: { completed: '✅ Funds released to the seller', cancelled: '❌ Transaction cancelled', refund: '💸 Funds returned to the buyer' },
};

async function advanceRekber(interaction, t, step) {
  const cfg = loadConfig();
  save();
  logOrder(interaction.guild, t, STEP_LOG[step](t));
  await interaction.update(ticketPayloadFor(interaction.message, interaction.guild, cfg, t));
  await interaction.channel.send(v2(V.buildRekberStep(interaction.guild, cfg, t, step))).catch(() => {});
}

function rekberTicketFor(interaction, ticketId) {
  const t = state.tickets[ticketId];
  if (!t || kindOf(t) !== 'rekber' || t.status !== 'open') {
    interaction.reply({ content: 'Transaksi rekber ini sudah ditutup.', flags: EPH }).catch(() => {});
    return null;
  }
  return t;
}

/** Langkah 1: pihak lawan menyetujui transaksi. */
async function onRekberAgree(interaction, ticketId) {
  const t = rekberTicketFor(interaction, ticketId);
  if (!t) return;
  if (interaction.user.id !== t.partnerId) {
    return interaction.reply({ content: `⛔ Hanya <@${t.partnerId}> (pihak lawan transaksi) yang bisa menyetujui.`, flags: EPH });
  }
  t.stage.agreed = true;
  return advanceRekber(interaction, t, 'agreed');
}

/** Langkah 2: admin mengonfirmasi dana pembeli sudah masuk. */
async function onRekberFund(interaction, ticketId) {
  const t = rekberTicketFor(interaction, ticketId);
  if (!t) return;
  if (!isAdmin(interaction.member)) return interaction.reply({ content: '⛔ Hanya **Administrator** yang bisa mengonfirmasi dana.', flags: EPH });
  if (!t.stage.agreed) return interaction.reply({ content: 'Tunggu pihak lawan menyetujui transaksi dulu.', flags: EPH });
  t.stage.funded = true;
  t.stage.fundedBy = interaction.user.id;
  t.payment = { ...(t.payment || {}), status: 'paid', paidAt: Date.now(), paidBy: interaction.user.id, amount: t.buyerPays };
  return advanceRekber(interaction, t, 'funded');
}

/** Langkah 3: pembeli mengonfirmasi barang / jasa sudah diterima. */
async function onRekberReceived(interaction, ticketId) {
  const t = rekberTicketFor(interaction, ticketId);
  if (!t) return;
  if (interaction.user.id !== t.buyerId) {
    return interaction.reply({ content: `⛔ Hanya <@${t.buyerId}> (pembeli) yang bisa mengonfirmasi barang diterima.`, flags: EPH });
  }
  if (!t.stage.funded) return interaction.reply({ content: 'Tunggu admin mengonfirmasi dana terlebih dahulu.', flags: EPH });
  t.stage.received = true;
  return advanceRekber(interaction, t, 'received');
}

// ══════════════════════ ROBUX GAMEPASS ══════════════════════
const gpSessions = new Map(); // userId → { draft, expires }

const textInput = (id, { placeholder, min, max = 20, required = true, style = TextInputStyle.Short, value } = {}) => {
  const ti = new TextInputBuilder().setCustomId(id).setStyle(style).setMaxLength(max).setRequired(required);
  if (placeholder) ti.setPlaceholder(placeholder);
  if (min) ti.setMinLength(min);
  if (value) ti.setValue(value);
  return ti;
};
const parseAmount = (raw) => Number(String(raw || '').replace(/[.,\s]/g, '').replace(/robux|rbx/gi, ''));

/** Tombol "Cek Harga" / "Tax Calculator" → form jumlah Robux. */
async function onGamepassCalcButton(interaction, productId, mode) {
  const product = getProduct(loadConfig(), productId);
  if (!product || product.type !== 'gamepass') return interaction.reply({ content: 'Produk tidak ditemukan.', flags: EPH });
  const tax = mode === 'tax';
  const modal = new ModalBuilder()
    .setCustomId(`store:${tax ? 'gpcalctax' : 'gpcalcprice'}:${product.id}`)
    .setTitle(tax ? 'Tax Calculator Roblox' : `Cek Harga ${product.label}`.slice(0, 45))
    .addLabelComponents(
      new LabelBuilder()
        .setLabel(tax ? 'Robux yang ingin diterima' : 'Jumlah Robux (Before Tax)')
        .setDescription(
          tax
            ? 'Jumlah Robux bersih yang ingin kamu terima (After Tax). Bot akan menghitung harga gamepass.'
            : 'Harga gamepass kamu (Before Tax). Bot akan menghitung total harga dalam Rupiah.',
        )
        .setTextInputComponent(textInput('amount', { placeholder: tax ? 'contoh: 1000' : 'contoh: 1429', min: 1, max: 9 })),
    );
  return interaction.showModal(modal);
}

async function onGamepassCalcModal(interaction, productId, mode) {
  const cfg = loadConfig();
  const product = getProduct(cfg, productId);
  if (!product) return interaction.reply({ content: 'Produk tidak ditemukan.', flags: EPH });
  const n = parseAmount(interaction.fields.getTextInputValue('amount'));
  if (!Number.isInteger(n) || n < 1 || n > 10_000_000) {
    return interaction.reply({ content: '❌ Masukkan jumlah Robux berupa angka, contoh **1000**.', flags: EPH });
  }
  return interaction.reply({ ...V.buildGamepassCalc(interaction.guild, cfg, product, mode, n), flags: EPH });
}

async function onGamepassTutorial(interaction, productId) {
  const cfg = loadConfig();
  const product = getProduct(cfg, productId);
  if (!product) return interaction.reply({ content: 'Produk tidak ditemukan.', flags: EPH });
  return interaction.reply({ ...V.buildGamepassTutorial(interaction.guild, cfg, product), flags: EPH });
}

/** "Order Sekarang" → form order gamepass. */
async function onGamepassStart(interaction, product) {
  if (!isProductOpen(product)) {
    refreshPanel();
    return interaction.reply({ content: `🔴 **${product.label}** sedang **TUTUP**. Pantau channel stock untuk info buka berikutnya.`, flags: EPH });
  }
  const active = activeTicketOf({ userId: interaction.user.id, kind: 'gamepass' });
  if (active) {
    return interaction.reply({
      content: `⚠️ Kamu masih punya ticket ${product.label} yang sedang berjalan: <#${active.channelId}> (\`${active.id}\`).\nTunggu ticket itu ditutup admin sebelum membuat pesanan baru.`,
      flags: EPH,
    });
  }
  const min = Number(product.minAmount) || 1;
  const modal = new ModalBuilder()
    .setCustomId(`store:gpmodal:${product.id}`)
    .setTitle(`Order ${product.label}`.slice(0, 45))
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('Username Roblox')
        .setDescription('Username (bukan display name) akun pemilik gamepass.')
        .setTextInputComponent(textInput('username', { placeholder: 'contoh: Builderman', min: 3, max: 20 })),
      new LabelBuilder()
        .setLabel('Link Gamepass')
        .setDescription('Salin link gamepass dari Roblox / Creator Hub (atau ID gamepass saja).')
        .setTextInputComponent(textInput('link', { placeholder: 'https://www.roblox.com/game-pass/123456789/...', min: 3, max: 300 })),
      new LabelBuilder()
        .setLabel('Harga Gamepass (Before Tax)')
        .setDescription(`Harga yang kamu pasang di gamepass. Minimal ${num(V.gpBeforeTax(product, min))} Robux. Cek pakai Tax Calculator.`)
        .setTextInputComponent(textInput('price', { placeholder: 'contoh: 1429', min: 1, max: 9 })),
    );
  return interaction.showModal(modal);
}

/** Cek gamepass ke Roblox: kembalikan { live, problems, warnings, verified }. */
async function verifyGamepass(product, gamepassId, before, roblox) {
  const problems = [];
  const warnings = [];
  let live = null;
  let verified = false;
  try {
    live = await lookupGamepass(gamepassId);
    if (!live) problems.push(`Gamepass dengan ID \`${gamepassId}\` **tidak ditemukan**. Periksa kembali link gamepass kamu.`);
  } catch (err) {
    console.warn('[store] cek gamepass gagal:', err.message);
    warnings.push('Gamepass belum bisa dicek otomatis (server Roblox sibuk) — admin akan mengeceknya secara manual.');
  }
  if (live) {
    verified = true;
    if (!live.forSale) problems.push('Gamepass masih **Off Sale**. Aktifkan **Item for Sale** di pengaturan gamepass terlebih dahulu.');
    else if (live.price !== before) {
      problems.push(
        `Harga gamepass di Roblox **${num(live.price)} Robux**, sedangkan yang kamu isi **${num(before)} Robux**. Samakan harganya terlebih dahulu.`,
      );
    }
    const isUser = live.creatorType === 'User' || live.creatorType === 1;
    if (roblox && isUser && live.creatorId && ![live.creatorId, live.creatorAltId].includes(String(roblox.id))) {
      problems.push(`Gamepass ini milik **@${live.creatorName || live.creatorId}**, bukan milik **@${roblox.name}**.`);
    } else if (roblox && live.creatorType && !isUser) {
      warnings.push(`Gamepass dibuat oleh grup **${live.creatorName || '-'}** — Robux akan masuk ke dana grup tersebut.`);
    }
  }
  return { live, problems, warnings, verified };
}

/** Form order dikirim → cek akun Roblox & gamepass → tampilkan ringkasan. */
async function onGamepassModal(interaction, productId) {
  await interaction.deferReply({ flags: EPH });
  const cfg = loadConfig();
  const product = getProduct(cfg, productId);
  if (!product || product.type !== 'gamepass') return interaction.editReply('❌ Produk tidak ditemukan.');
  if (!isProductOpen(product)) return interaction.editReply(`🔴 **${product.label}** sedang **TUTUP**.`);

  const username = interaction.fields.getTextInputValue('username').trim();
  const link = interaction.fields.getTextInputValue('link').trim();
  const before = parseAmount(interaction.fields.getTextInputValue('price'));
  const gamepassId = parseGamepassId(link);
  const min = Number(product.minAmount) || 1;
  const max = Number(product.maxAmount) || 10000;

  if (!gamepassId) {
    return interaction.editReply('❌ Link gamepass tidak valid. Contoh: `https://www.roblox.com/game-pass/123456789/Nama-Gamepass`');
  }
  if (!Number.isInteger(before) || before < 1) return interaction.editReply('❌ Harga gamepass harus berupa angka, contoh **1429**.');
  const q = V.gpQuote(cfg, product, before);
  if (q.after < min || q.after > max) {
    return interaction.editReply(
      `❌ Gamepass seharga **${num(before)} Robux** hanya menghasilkan **${num(q.after)} Robux** (After Tax).\n` +
        `Order ${product.label} hanya untuk **${num(min)} – ${num(max)} Robux diterima** → harga gamepass ` +
        `**${num(V.gpBeforeTax(product, min))} – ${num(V.gpBeforeTax(product, max))} Robux**.`,
    );
  }
  if (activeTicketOf({ userId: interaction.user.id, kind: 'gamepass' })) {
    return interaction.editReply('⚠️ Kamu masih punya ticket gamepass yang sedang berjalan. Tunggu ticket itu ditutup dulu.');
  }

  let roblox;
  try {
    roblox = await lookupRobloxUser(username);
  } catch (err) {
    console.error('[store] cek Roblox gagal:', err.message);
    return interaction.editReply('⚠️ Gagal menghubungi server Roblox. Coba lagi beberapa saat lagi.');
  }
  if (!roblox) {
    return interaction.editReply(`❌ Username Roblox \`${username}\` tidak ditemukan. Pastikan ejaannya benar (pakai **username**, bukan display name).`);
  }
  const busy = activeTicketOf({ robloxId: roblox.id, gamepassId, kind: 'gamepass' });
  if (busy) {
    return interaction.editReply(`⚠️ Akun Roblox / gamepass ini masih dipakai di ticket yang sedang berjalan (\`${busy.id}\`).`);
  }

  const check = await verifyGamepass(product, gamepassId, before, roblox);
  if (check.problems.length) {
    return interaction.editReply({
      embeds: [
        V.buildGamepassCheck(cfg, { gamepass: { id: gamepassId, name: check.live?.name || `Gamepass ${gamepassId}` }, before }, check.live, check.problems)
          .embeds[0].setTitle('⚠️ Gamepass Belum Sesuai')
          .setFooter({ text: 'Perbaiki gamepass kamu, lalu klik Order Sekarang lagi.' }),
      ],
    });
  }

  const draft = {
    productId: product.id,
    roblox,
    gamepass: {
      id: gamepassId,
      name: check.live?.name || `Gamepass ${gamepassId}`,
      icon: check.live?.icon || null,
      creatorName: check.live?.creatorName || null,
      verified: check.verified,
    },
    ...q,
    warnings: check.warnings,
  };
  gpSessions.set(interaction.user.id, { draft, expires: Date.now() + SESSION_MS });
  return interaction.editReply(V.buildGamepassConfirm(interaction.guild, cfg, product, draft));
}

/** Konfirmasi ringkasan → buat ticket order gamepass. */
async function onGamepassConfirm(interaction, yes) {
  const sess = gpSessions.get(interaction.user.id);
  gpSessions.delete(interaction.user.id);
  if (!yes) return interaction.update({ content: '✖️ Pesanan dibatalkan.', embeds: [], components: [] });
  if (!sess || sess.expires < Date.now()) {
    return interaction.update({ content: '⌛ Sesi sudah berakhir. Silakan klik Order Sekarang lagi.', embeds: [], components: [] });
  }
  const cfg = loadConfig();
  const guild = interaction.guild;
  const d = sess.draft;
  const product = getProduct(cfg, d.productId);
  if (!isProductOpen(product)) return interaction.update({ content: `🔴 Maaf, **${product?.label || 'produk ini'}** baru saja **TUTUP**.`, embeds: [], components: [] });
  if (
    activeTicketOf({ userId: interaction.user.id, kind: 'gamepass' }) ||
    activeTicketOf({ robloxId: d.roblox.id, gamepassId: d.gamepass.id, kind: 'gamepass' })
  ) {
    return interaction.update({ content: '⚠️ Kamu / akun Roblox / gamepass ini masih punya ticket yang sedang berjalan.', embeds: [], components: [] });
  }

  const tc = product.ticket || {};
  const id = nextTicketId(tc.idPrefix || 'GP', 'gamepassSeq');
  const ticket = {
    id,
    kind: 'gamepass',
    guildId: guild.id,
    userId: interaction.user.id,
    channelId: null,
    messageId: null,
    roblox: d.roblox,
    gamepass: d.gamepass,
    productId: product.id,
    productLabel: product.label,
    amount: d.after, // Robux yang diterima pembeli
    before: d.before, // harga gamepass
    rate: d.rate,
    price: d.price,
    pendingDays: Number(product.pendingDays) || 5,
    status: 'open',
    createdAt: Date.now(),
  };
  state.tickets[id] = ticket;
  save();
  await interaction.update({ content: '⏳ Sedang membuat ticket kamu...', embeds: [], components: [] });

  try {
    const member = [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.AttachFiles,
      PermissionFlagsBits.EmbedLinks,
    ];
    const overwrites = [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: interaction.user.id, allow: member },
      { id: guild.members.me.id, allow: [...member, PermissionFlagsBits.ManageChannels] },
    ];
    const staff = isId(cfg.ticket?.staffRoleId) ? cfg.ticket.staffRoleId : null;
    if (staff) overwrites.push({ id: staff, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
    const slug = d.roblox.name.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20);
    const channel = await createTicketChannel(guild, interaction, cfg, {
      name: `🎟️・${id.toLowerCase()}-${slug}`,
      topic: `${id} • ${product.label} ${num(d.after)} Robux (gamepass ${num(d.before)}) • ${interaction.user.tag} • Roblox @${d.roblox.name}`,
      overwrites,
      userIds: [interaction.user.id],
      categoryName: tc.categoryName || '🎟️ TICKET GAMEPASS',
    });
    ticket.channelId = channel.id;

    const msg = await channel.send(
      v2({
        content: `<@${interaction.user.id}>${staff ? ` <@&${staff}>` : ''}`,
        ...V.buildTicketMessage(guild, cfg, ticket),
        allowedMentions: { users: [interaction.user.id], roles: staff ? [staff] : [] },
      }),
    );
    await msg.pin().catch(() => {});
    ticket.messageId = msg.id;
    save();
    logOrder(guild, ticket, '🆕 Order received — awaiting payment');

    const url = channelUrl(guild.id, channel.id);
    const dmOk = await interaction.user
      .send(V.dm(V.buildDmCreated(guild, cfg, ticket, url)))
      .then(() => true)
      .catch(() => false);
    if (!dmOk) channel.send('ℹ️ Bot tidak bisa mengirim DM ke kamu (DM tertutup). Semua info pesanan ada di ticket ini.').catch(() => {});

    await interaction.editReply({
      content: `✅ **Ticket berhasil dibuat!** Lanjutkan pembayaran di ${channel}.`,
      components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Buka Ticket').setEmoji('🎫').setURL(url))],
    });
  } catch (err) {
    console.error('[store] gagal membuat ticket gamepass:', err);
    delete state.tickets[id];
    save();
    await interaction
      .editReply('❌ Gagal membuat ticket. Pastikan bot punya izin **Manage Channels** & **Manage Roles**, lalu coba lagi.')
      .catch(() => {});
  }
}

// ══════════════════════ GIFT IN-GAME ══════════════════════
const gfSessions = new Map(); // userId → { draft, expires }
const giftMax = (product) => Number(product?.maxAmount) || 100000; // batas total Robux per order
const giftMin = (product) => Math.max(1, Number(product?.minAmount) || 1);

/** Tombol "Kalkulator Biaya" → form harga item & jumlah. */
async function onGiftCalcButton(interaction, productId) {
  const product = getProduct(loadConfig(), productId);
  if (!product || product.type !== 'gift') return interaction.reply({ content: 'Produk tidak ditemukan.', flags: EPH });
  const modal = new ModalBuilder()
    .setCustomId(`store:gfcalcm:${product.id}`)
    .setTitle(`Kalkulator ${product.label}`.slice(0, 45))
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('Harga Item (Robux)')
        .setDescription('Harga 1 item di game, dalam Robux.')
        .setTextInputComponent(textInput('each', { placeholder: 'contoh: 399', min: 1, max: 9 })),
      new LabelBuilder()
        .setLabel('Jumlah Item')
        .setDescription('Kosongkan = 1.')
        .setTextInputComponent(textInput('qty', { placeholder: 'contoh: 3', max: 4, required: false })),
    );
  return interaction.showModal(modal);
}

async function onGiftCalcModal(interaction, productId) {
  const cfg = loadConfig();
  const product = getProduct(cfg, productId);
  if (!product || product.type !== 'gift') return interaction.reply({ content: 'Produk tidak ditemukan.', flags: EPH });
  const each = parseAmount(interaction.fields.getTextInputValue('each'));
  const qty = interaction.fields.getTextInputValue('qty')?.trim() ? parseAmount(interaction.fields.getTextInputValue('qty')) : 1;
  if (!Number.isInteger(each) || each < 1 || !Number.isInteger(qty) || qty < 1 || each * qty > 10_000_000) {
    return interaction.reply({ content: '❌ Isi harga item & jumlah dengan angka, contoh **399** dan **3**.', flags: EPH });
  }
  return interaction.reply({ ...V.buildGiftCalc(interaction.guild, cfg, product, each, qty), flags: EPH });
}

/** "Order Sekarang" → form order Gift In-Game (detail kebutuhan di awal: item, jumlah, server). */
async function onGiftStart(interaction, product) {
  if (!isProductOpen(product)) {
    refreshPanel();
    return interaction.reply({ content: `🔴 **${product.label}** sedang **TUTUP**. Pantau channel stock untuk info buka berikutnya.`, flags: EPH });
  }
  const active = activeTicketOf({ userId: interaction.user.id, kind: 'gift' });
  if (active) {
    return interaction.reply({
      content: `⚠️ Kamu masih punya ticket ${product.label} yang sedang berjalan: <#${active.channelId}> (\`${active.id}\`).\nTunggu ticket itu ditutup admin sebelum membuat pesanan baru.`,
      flags: EPH,
    });
  }
  const modal = new ModalBuilder()
    .setCustomId(`store:gfmodal:${product.id}`)
    .setTitle(`Order ${product.label}`.slice(0, 45))
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('Username Roblox')
        .setDescription('Username (bukan display name) akun penerima gift.')
        .setTextInputComponent(textInput('username', { placeholder: 'contoh: Builderman', min: 3, max: 20 })),
      new LabelBuilder()
        .setLabel('Nama Item')
        .setDescription('Contoh: Gamepass VIP, Skin Dragon, Crate Legendary, Server Boost.')
        .setTextInputComponent(textInput('item', { placeholder: 'nama item yang ingin dibeli', min: 2, max: 80 })),
      new LabelBuilder()
        .setLabel('Harga Item (Robux)')
        .setDescription('Harga 1 item di game, dalam Robux.')
        .setTextInputComponent(textInput('each', { placeholder: 'contoh: 399', min: 1, max: 9 })),
      new LabelBuilder()
        .setLabel('Jumlah Item')
        .setDescription('Kosongkan = 1.')
        .setTextInputComponent(textInput('qty', { placeholder: 'contoh: 1', max: 4, required: false })),
      new LabelBuilder()
        .setLabel('Server / Game')
        .setDescription('Nama game atau link private server / server tempat item dikirim.')
        .setTextInputComponent(textInput('server', { placeholder: 'contoh: Blox Fruits — server publik / link private server', min: 2, max: 150 })),
    );
  return interaction.showModal(modal);
}

async function onGiftModal(interaction, productId) {
  await interaction.deferReply({ flags: EPH });
  const cfg = loadConfig();
  const product = getProduct(cfg, productId);
  if (!product || product.type !== 'gift') return interaction.editReply('❌ Produk tidak ditemukan.');
  if (!isProductOpen(product)) return interaction.editReply(`🔴 **${product.label}** sedang **TUTUP**.`);

  const username = interaction.fields.getTextInputValue('username').trim();
  const item = interaction.fields.getTextInputValue('item').trim().replace(/[`\n]/g, ' ');
  const server = interaction.fields.getTextInputValue('server').trim().replace(/[`\n]/g, ' ');
  const each = parseAmount(interaction.fields.getTextInputValue('each'));
  const rawQty = interaction.fields.getTextInputValue('qty')?.trim();
  const qty = rawQty ? parseAmount(rawQty) : 1;
  if (!Number.isInteger(each) || each < 1) return interaction.editReply('❌ Harga item harus berupa angka (Robux), contoh **399**.');
  if (!Number.isInteger(qty) || qty < 1) return interaction.editReply('❌ Jumlah item harus berupa angka, contoh **1**.');
  const q = V.giftQuote(cfg, product, each, qty);
  const min = giftMin(product);
  const max = giftMax(product);
  if (q.robux < min || q.robux > max) {
    return interaction.editReply(`❌ Total order **${num(q.robux)} Robux** di luar batas. Order ${product.label} hanya untuk **${num(min)} – ${num(max)} Robux** per ticket.`);
  }
  if (!q.rate) return interaction.editReply('⚠️ Rate produk ini belum diatur. Hubungi admin.');
  if (activeTicketOf({ userId: interaction.user.id, kind: 'gift' })) {
    return interaction.editReply('⚠️ Kamu masih punya ticket Gift In-Game yang sedang berjalan. Tunggu ticket itu ditutup dulu.');
  }

  let roblox;
  try {
    roblox = await lookupRobloxUser(username);
  } catch (err) {
    console.error('[store] cek Roblox gagal:', err.message);
    return interaction.editReply('⚠️ Gagal menghubungi server Roblox. Coba lagi beberapa saat lagi.');
  }
  if (!roblox) {
    return interaction.editReply(`❌ Username Roblox \`${username}\` tidak ditemukan. Pastikan ejaannya benar (pakai **username**, bukan display name).`);
  }
  const draft = { productId: product.id, roblox, item, server, each, qty, amount: q.robux, rate: q.rate, price: q.price };
  gfSessions.set(interaction.user.id, { draft, expires: Date.now() + SESSION_MS });
  return interaction.editReply(V.buildGiftConfirm(interaction.guild, cfg, product, draft));
}

async function onGiftConfirm(interaction, yes) {
  const sess = gfSessions.get(interaction.user.id);
  gfSessions.delete(interaction.user.id);
  if (!yes) return interaction.update({ content: '✖️ Pesanan dibatalkan.', embeds: [], components: [] });
  if (!sess || sess.expires < Date.now()) {
    return interaction.update({ content: '⌛ Sesi sudah berakhir. Silakan klik Order Sekarang lagi.', embeds: [], components: [] });
  }
  const cfg = loadConfig();
  const guild = interaction.guild;
  const d = sess.draft;
  const product = getProduct(cfg, d.productId);
  if (!product || !isProductOpen(product)) return interaction.update({ content: `🔴 Maaf, **${product?.label || 'produk ini'}** baru saja **TUTUP**.`, embeds: [], components: [] });
  if (activeTicketOf({ userId: interaction.user.id, kind: 'gift' })) {
    return interaction.update({ content: '⚠️ Kamu masih punya ticket Gift In-Game yang sedang berjalan.', embeds: [], components: [] });
  }

  const tc = product.ticket || {};
  const id = nextTicketId(tc.idPrefix || 'GF', 'giftSeq');
  const ticket = {
    id,
    kind: 'gift',
    guildId: guild.id,
    userId: interaction.user.id,
    channelId: null,
    messageId: null,
    roblox: d.roblox,
    productId: product.id,
    productLabel: product.label,
    item: d.item,
    server: d.server,
    each: d.each,
    qty: d.qty,
    amount: d.amount, // total Robux item
    rate: d.rate,
    price: d.price,
    status: 'open',
    createdAt: Date.now(),
  };
  state.tickets[id] = ticket;
  save();
  await interaction.update({ content: '⏳ Sedang membuat ticket kamu...', embeds: [], components: [] });

  try {
    const member = [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.AttachFiles,
      PermissionFlagsBits.EmbedLinks,
    ];
    const overwrites = [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: interaction.user.id, allow: member },
      { id: guild.members.me.id, allow: [...member, PermissionFlagsBits.ManageChannels] },
    ];
    const staff = isId(cfg.ticket?.staffRoleId) ? cfg.ticket.staffRoleId : null;
    if (staff) overwrites.push({ id: staff, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
    const slug = d.roblox.name.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20);
    const channel = await createTicketChannel(guild, interaction, cfg, {
      name: `🎁・${id.toLowerCase()}-${slug}`,
      topic: `${id} • ${product.label} ${d.item} ×${d.qty} (${num(d.amount)} Robux) • ${interaction.user.tag} • Roblox @${d.roblox.name}`,
      overwrites,
      userIds: [interaction.user.id],
      categoryName: tc.categoryName || '🎁 TICKET GIFT',
    });
    ticket.channelId = channel.id;
    const msg = await channel.send(
      v2({
        content: `<@${interaction.user.id}>${staff ? ` <@&${staff}>` : ''}`,
        ...V.buildTicketMessage(guild, cfg, ticket),
        allowedMentions: { users: [interaction.user.id], roles: staff ? [staff] : [] },
      }),
    );
    await msg.pin().catch(() => {});
    ticket.messageId = msg.id;
    save();
    logOrder(guild, ticket, '🆕 Order received — awaiting payment');

    const url = channelUrl(guild.id, channel.id);
    const dmOk = await interaction.user
      .send(V.dm(V.buildDmCreated(guild, cfg, ticket, url)))
      .then(() => true)
      .catch(() => false);
    if (!dmOk) channel.send('ℹ️ Bot tidak bisa mengirim DM ke kamu (DM tertutup). Semua info pesanan ada di ticket ini.').catch(() => {});
    await interaction.editReply({
      content: `✅ **Ticket berhasil dibuat!** Lanjutkan pembayaran di ${channel}.`,
      components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Buka Ticket').setEmoji('🎫').setURL(url))],
    });
  } catch (err) {
    console.error('[store] gagal membuat ticket gift:', err);
    delete state.tickets[id];
    save();
    await interaction.editReply('❌ Gagal membuat ticket. Pastikan bot punya izin **Manage Channels** & **Manage Roles**, lalu coba lagi.').catch(() => {});
  }
}

/** Tombol "Cek Gamepass" di ticket (admin) → cek ulang harga & status sebelum membeli. */
async function onGamepassCheck(interaction, ticketId) {
  if (!isAdmin(interaction.member)) return interaction.reply({ content: '⛔ Hanya **Administrator** yang bisa mengecek gamepass.', flags: EPH });
  const t = state.tickets[ticketId];
  if (!t || kindOf(t) !== 'gamepass') return interaction.reply({ content: 'Ticket tidak ditemukan.', flags: EPH });
  await interaction.deferReply({ flags: EPH });
  const cfg = loadConfig();
  const check = await verifyGamepass(getProduct(cfg, t.productId), t.gamepass.id, t.before, t.roblox);
  if (!check.live && !check.problems.length) {
    return interaction.editReply('⚠️ Server Roblox tidak bisa dihubungi. Cek gamepass secara manual lewat tombol **Buka Gamepass**.');
  }
  return interaction.editReply(V.buildGamepassCheck(cfg, t, check.live, [...check.problems, ...check.warnings]));
}

// ══════════════════════ CANVA PRO ══════════════════════
const cvSessions = new Map(); // userId → { draft, expires }
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[a-z]{2,}$/i;

function returnSlot(cfg, t) {
  const product = getProduct(cfg, t.productId);
  if (!product) return;
  // Server Boost: stock dikembalikan ke paket yang dipesan.
  if (kindOf(t) === 'boost') setPlanStock(product, t.plan?.id, planStockOf(product, t.plan?.id) + (Number(t.qty) || 1));
  else setStock(product, stockOf(product) + 1);
}

/** "Order Sekarang" → form pilih paket + email. */
async function onCanvaStart(interaction, product) {
  if (!isProductOpen(product)) {
    refreshPanel();
    const why = stockOf(product) <= 0 ? 'slot sedang **HABIS**' : 'sedang **TUTUP**';
    return interaction.reply({ content: `🔴 **${product.label}** ${why}. Pantau channel stock untuk info berikutnya.`, flags: EPH });
  }
  const active = activeTicketOf({ userId: interaction.user.id, kind: 'canva' });
  if (active) {
    return interaction.reply({
      content: `⚠️ Kamu masih punya ticket ${product.label} yang sedang berjalan: <#${active.channelId}> (\`${active.id}\`).`,
      flags: EPH,
    });
  }
  const plans = V.canvaPlans(product).slice(0, 25);
  const modal = new ModalBuilder()
    .setCustomId(`store:cvmodal:${product.id}`)
    .setTitle(`Order ${product.label}`.slice(0, 45))
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('Pilih Paket')
        .setStringSelectMenuComponent(
          new StringSelectMenuBuilder()
            .setCustomId('plan')
            .setPlaceholder('Pilih paket Canva Pro...')
            .setRequired(true)
            .addOptions(
              plans.map((x) => {
                const save = V.planSaving(product, x);
                return {
                  label: `${x.label} — ${rupiah(x.price)}`.slice(0, 100),
                  description: `Aktif ${num(x.days)} hari${save ? ` • Hemat ${save}%` : ''}`.slice(0, 100),
                  value: x.id,
                  emoji: x.emoji || '🗓️',
                };
              }),
            ),
        ),
      new LabelBuilder()
        .setLabel('Alamat Email Canva')
        .setDescription('Email yang akan diundang ke team Canva Pro (boleh email baru / akun Canva yang sudah ada).')
        .setTextInputComponent(textInput('email', { placeholder: 'contoh: namakamu@gmail.com', min: 6, max: 100 })),
      new LabelBuilder()
        .setLabel('Ulangi Alamat Email')
        .setDescription('Ketik ulang email untuk memastikan tidak ada salah ketik.')
        .setTextInputComponent(textInput('email2', { placeholder: 'contoh: namakamu@gmail.com', min: 6, max: 100 })),
    );
  return interaction.showModal(modal);
}

async function onCanvaModal(interaction, productId) {
  await interaction.deferReply({ flags: EPH });
  const cfg = loadConfig();
  const product = getProduct(cfg, productId);
  if (!product || product.type !== 'canva') return interaction.editReply('❌ Produk tidak ditemukan.');
  if (!isProductOpen(product)) return interaction.editReply(`🔴 **${product.label}** sedang **TUTUP** atau slot habis.`);

  const planId = interaction.fields.getStringSelectValues('plan')?.[0];
  const plan = V.canvaPlans(product).find((x) => x.id === planId);
  const email = interaction.fields.getTextInputValue('email').trim().toLowerCase();
  const email2 = interaction.fields.getTextInputValue('email2').trim().toLowerCase();
  if (!plan) return interaction.editReply('❌ Pilih paket terlebih dahulu.');
  if (!EMAIL_RE.test(email)) return interaction.editReply('❌ Alamat email tidak valid. Contoh: `namakamu@gmail.com`');
  if (email !== email2) return interaction.editReply('❌ Kedua alamat email **tidak sama**. Periksa lagi lalu klik Order Sekarang.');
  const busy = activeTicketOf({ userId: interaction.user.id, email, kind: 'canva' });
  if (busy) return interaction.editReply(`⚠️ Kamu / email ini masih punya ticket yang sedang berjalan (\`${busy.id}\`).`);

  const draft = { productId: product.id, plan: { id: plan.id, label: plan.label, days: Number(plan.days) || 30 }, price: Number(plan.price), email };
  cvSessions.set(interaction.user.id, { draft, expires: Date.now() + SESSION_MS });
  return interaction.editReply(V.buildCanvaConfirm(interaction.guild, cfg, product, draft));
}

async function onCanvaConfirm(interaction, yes) {
  const sess = cvSessions.get(interaction.user.id);
  cvSessions.delete(interaction.user.id);
  if (!yes) return interaction.update({ content: '✖️ Pesanan dibatalkan.', embeds: [], components: [] });
  if (!sess || sess.expires < Date.now()) {
    return interaction.update({ content: '⌛ Sesi sudah berakhir. Silakan klik Order Sekarang lagi.', embeds: [], components: [] });
  }
  const cfg = loadConfig();
  const guild = interaction.guild;
  const d = sess.draft;
  const product = getProduct(cfg, d.productId);
  if (!isProductOpen(product)) {
    return interaction.update({ content: `🔴 Maaf, **${product?.label || 'produk ini'}** baru saja **TUTUP** / slot habis.`, embeds: [], components: [] });
  }
  if (activeTicketOf({ userId: interaction.user.id, email: d.email, kind: 'canva' })) {
    return interaction.update({ content: '⚠️ Kamu / email ini masih punya ticket yang sedang berjalan.', embeds: [], components: [] });
  }

  // Kunci 1 slot SEKARANG supaya tidak terjual melebihi stock.
  setStock(product, stockOf(product) - 1);
  const tc = product.ticket || {};
  const id = nextTicketId(tc.idPrefix || 'CV', 'canvaSeq');
  const ticket = {
    id,
    kind: 'canva',
    guildId: guild.id,
    userId: interaction.user.id,
    channelId: null,
    messageId: null,
    productId: product.id,
    productLabel: product.label,
    plan: d.plan,
    email: d.email,
    amount: 0,
    price: d.price,
    stage: { invited: false, joined: false },
    status: 'open',
    createdAt: Date.now(),
  };
  state.tickets[id] = ticket;
  save();
  await interaction.update({ content: '⏳ Sedang membuat ticket kamu...', embeds: [], components: [] });

  try {
    const member = [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.AttachFiles,
      PermissionFlagsBits.EmbedLinks,
    ];
    const overwrites = [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: interaction.user.id, allow: member },
      { id: guild.members.me.id, allow: [...member, PermissionFlagsBits.ManageChannels] },
    ];
    const staff = isId(cfg.ticket?.staffRoleId) ? cfg.ticket.staffRoleId : null;
    if (staff) overwrites.push({ id: staff, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
    const slug = interaction.user.username.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20);
    const channel = await createTicketChannel(guild, interaction, cfg, {
      name: `🎨・${id.toLowerCase()}-${slug}`,
      topic: `${id} • ${product.label} ${d.plan.label} • ${interaction.user.tag}`,
      overwrites,
      userIds: [interaction.user.id],
      categoryName: tc.categoryName || '🎨 TICKET CANVA',
    });
    ticket.channelId = channel.id;

    const msg = await channel.send(
      v2({
        content: `<@${interaction.user.id}>${staff ? ` <@&${staff}>` : ''}`,
        ...V.buildTicketMessage(guild, cfg, ticket),
        allowedMentions: { users: [interaction.user.id], roles: staff ? [staff] : [] },
      }),
    );
    await msg.pin().catch(() => {});
    ticket.messageId = msg.id;
    save();
    logOrder(guild, ticket, '🆕 Order received — awaiting payment');

    const url = channelUrl(guild.id, channel.id);
    const dmOk = await interaction.user
      .send(V.dm(V.buildDmCreated(guild, cfg, ticket, url)))
      .then(() => true)
      .catch(() => false);
    if (!dmOk) channel.send('ℹ️ Bot tidak bisa mengirim DM ke kamu (DM tertutup). Semua info pesanan ada di ticket ini.').catch(() => {});

    await interaction.editReply({
      content: `✅ **Ticket berhasil dibuat!** Lanjutkan pembayaran di ${channel}.`,
      components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Buka Ticket').setEmoji('🎫').setURL(url))],
    });
  } catch (err) {
    console.error('[store] gagal membuat ticket canva:', err);
    setStock(product, stockOf(product) + 1);
    delete state.tickets[id];
    save();
    await interaction
      .editReply('❌ Gagal membuat ticket. Pastikan bot punya izin **Manage Channels** & **Manage Roles**, lalu coba lagi.')
      .catch(() => {});
    refreshPanel();
    return;
  }
  refreshPanel();
  await closeIfSoldOut(guild, `${product.emoji || CANVA} **Slot ${product.label} sudah HABIS!** ${product.label} otomatis ditutup.`, product);
}

function canvaTicketFor(interaction, ticketId) {
  const t = state.tickets[ticketId];
  if (!t || kindOf(t) !== 'canva' || t.status !== 'open') {
    interaction.reply({ content: 'Ticket ini sudah ditutup.', flags: EPH }).catch(() => {});
    return null;
  }
  t.stage = t.stage || {};
  return t;
}

async function advanceCanva(interaction, t, step, logText) {
  const cfg = loadConfig();
  save();
  logOrder(interaction.guild, t, logText);
  await interaction.update(ticketPayloadFor(interaction.message, interaction.guild, cfg, t));
  await interaction.channel.send(v2(V.buildCanvaStep(interaction.guild, cfg, t, step))).catch(() => {});
}

/** Admin: undangan team sudah dikirim ke email pembeli. */
async function onCanvaInvite(interaction, ticketId) {
  if (!isAdmin(interaction.member)) return interaction.reply({ content: '⛔ Hanya **Administrator** yang bisa menandai undangan terkirim.', flags: EPH });
  const t = canvaTicketFor(interaction, ticketId);
  if (!t) return;
  t.stage.invited = true;
  t.stage.invitedAt = Date.now();
  return advanceCanva(interaction, t, 'invited', '📨 Team invitation sent to the buyer’s email');
}

/** Pembeli: sudah menerima undangan & bergabung ke team. */
async function onCanvaJoined(interaction, ticketId) {
  const t = canvaTicketFor(interaction, ticketId);
  if (!t) return;
  if (interaction.user.id !== t.userId) return interaction.reply({ content: `⛔ Hanya <@${t.userId}> (pembeli) yang bisa mengonfirmasi.`, flags: EPH });
  if (!t.stage.invited) return interaction.reply({ content: 'Tunggu admin mengirim undangan terlebih dahulu.', flags: EPH });
  t.stage.joined = true;
  t.stage.joinedAt = Date.now();
  return advanceCanva(interaction, t, 'joined', '🎉 Buyer joined the Canva Pro team');
}

// ══════════════════════ SERVER BOOST ══════════════════════
const bsSessions = new Map(); // userId → { draft, expires }
const INVITE_RE = /(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite)\/([a-z0-9-]{2,32})/i;

/** Baca info server dari link undangan (nama, member, jumlah boost, ikon). */
async function inviteInfo(code) {
  const inv = await client.fetchInvite(code, { withCounts: true }).catch(() => null);
  if (!inv?.guild) return null;
  return {
    id: inv.guild.id,
    name: inv.guild.name,
    members: inv.memberCount || inv.guild.memberCount || null,
    boosts: inv.guild.premiumSubscriptionCount ?? null,
    icon: inv.guild.iconURL?.({ extension: 'png', size: 256 }) || null,
    expiresAt: inv.expiresTimestamp || null,
  };
}

/** "Order Sekarang" → form paket, jumlah boost, link server. */
async function onBoostStart(interaction, product) {
  if (!isProductOpen(product)) {
    refreshPanel();
    const why = stockOf(product) <= 0 ? 'stock sedang **HABIS**' : 'sedang **TUTUP**';
    return interaction.reply({ content: `🔴 **${product.label}** ${why}. Pantau channel stock untuk info berikutnya.`, flags: EPH });
  }
  const active = activeTicketOf({ userId: interaction.user.id, kind: 'boost' });
  if (active) {
    return interaction.reply({ content: `⚠️ Kamu masih punya ticket ${product.label} yang sedang berjalan: <#${active.channelId}> (\`${active.id}\`).`, flags: EPH });
  }
  // Hanya paket yang masih ada stock-nya.
  const plans = V.canvaPlans(product).filter((x) => planStockOf(product, x.id) > 0).slice(0, 25);
  if (!plans.length) return interaction.reply({ content: `🔴 Stock **${product.label}** sedang **HABIS**.`, flags: EPH });
  const max = Math.min(Number(product.maxBoost) || 30, Math.max(...plans.map((x) => planStockOf(product, x.id))));
  const modal = new ModalBuilder()
    .setCustomId(`store:bsmodal:${product.id}`)
    .setTitle(`Order ${product.label}`.slice(0, 45))
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('Pilih Paket')
        .setStringSelectMenuComponent(
          new StringSelectMenuBuilder()
            .setCustomId('plan')
            .setPlaceholder('Pilih paket Server Boost...')
            .setRequired(true)
            .addOptions(
              plans.map((x) => ({
                label: `${x.label} — ${rupiah(x.price)} / boost`.slice(0, 100),
                description: `Masa aktif ${x.duration || `${num(x.days)} hari`} • stock ${num(planStockOf(product, x.id))} boost`.slice(0, 100),
                value: x.id,
                emoji: x.emoji || '🗓️',
              })),
            ),
        ),
      new LabelBuilder()
        .setLabel('Jumlah Boost')
        .setDescription(`Minimal ${num(boostMin(product))} boost${boostStep(product) > 1 ? `, kelipatan ${num(boostStep(product))}` : ''} (maks. ${num(max)}).`.slice(0, 100))
        .setTextInputComponent(textInput('qty', { placeholder: boostStep(product) > 1 ? `contoh: ${[1, 2, 3, 4, 5].map((n) => n * boostStep(product)).join(', ')}` : 'contoh: 2, 4, 6, 8, 14', min: 1, max: 3 })),
      new LabelBuilder()
        .setLabel('Link Server Discord')
        .setDescription('Link undangan server kamu (atur Never Expire supaya tidak kedaluwarsa).')
        .setTextInputComponent(textInput('invite', { placeholder: 'contoh: https://discord.gg/namaserver', min: 8, max: 120 })),
    );
  return interaction.showModal(modal);
}

/** Minimal & kelipatan jumlah boost (store.json → minBoost, boostStep). Minimal selalu kelipatan. */
const boostStep = (product) => Math.max(1, Math.floor(Number(product?.boostStep) || 1));
const boostMin = (product) => {
  const step = boostStep(product);
  return Math.max(step, Math.ceil((Number(product?.minBoost) || 1) / step) * step);
};

async function onBoostModal(interaction, productId) {
  await interaction.deferReply({ flags: EPH });
  const cfg = loadConfig();
  const product = getProduct(cfg, productId);
  if (!product || product.type !== 'boost') return interaction.editReply('❌ Produk tidak ditemukan.');
  if (!isProductOpen(product)) return interaction.editReply(`🔴 **${product.label}** sedang **TUTUP** atau stock habis.`);
  const plan = V.canvaPlans(product).find((x) => x.id === interaction.fields.getStringSelectValues('plan')?.[0]);
  if (!plan) return interaction.editReply('❌ Pilih paket terlebih dahulu.');
  const qty = Number(String(interaction.fields.getTextInputValue('qty')).replace(/[^\d]/g, ''));
  const min = boostMin(product);
  const step = boostStep(product);
  const left = planStockOf(product, plan.id);
  const max = Math.min(Number(product.maxBoost) || 30, left);
  if (!left) return interaction.editReply(`🔴 Stock paket **${plan.label}** sedang **HABIS**. Pilih paket lain ya.`);
  if (left < min) return interaction.editReply(`🔴 Stock paket **${plan.label}** tinggal **${num(left)} boost** — kurang dari minimal order (**${num(min)} boost**). Pilih paket lain ya.`);
  if (!qty || qty < min) return interaction.editReply(`❌ Jumlah boost minimal **${num(min)}**${step > 1 ? ` dan harus **kelipatan ${num(step)}** (${[1, 2, 3, 4, 5].map((n) => n * step).join(', ')}, dst)` : ''}.`);
  if (qty % step !== 0) return interaction.editReply(`❌ Jumlah boost harus **kelipatan ${num(step)}** (contoh: ${[1, 2, 3, 4, 5].map((n) => n * step).join(', ')}). Kamu mengisi **${num(qty)}**.`);
  if (qty > max) return interaction.editReply(`❌ Jumlah boost maksimal **${num(Math.floor(max / step) * step)}** untuk paket **${plan.label}** (sisa stock **${num(left)} boost**).`);
  const raw = interaction.fields.getTextInputValue('invite').trim();
  const m = raw.match(INVITE_RE) || raw.match(/^([a-z0-9-]{2,32})$/i); // link lengkap atau kode undangan saja
  if (!m) return interaction.editReply('❌ Link server tidak valid. Contoh: `https://discord.gg/namaserver`');
  const invite = `https://discord.gg/${m[1]}`;
  const server = await inviteInfo(m[1]);
  if (!server) return interaction.editReply('❌ Link server **tidak bisa dibuka** (kedaluwarsa / salah). Buat link undangan baru dengan **Never Expire**, lalu coba lagi.');
  const draft = {
    productId: product.id,
    plan: { id: plan.id, label: plan.label, days: Number(plan.days) || 30, duration: plan.duration || null, price: Number(plan.price) },
    qty,
    price: V.boostPrice(plan, qty),
    invite,
    server,
  };
  bsSessions.set(interaction.user.id, { draft, expires: Date.now() + SESSION_MS });
  return interaction.editReply(V.buildBoostConfirm(interaction.guild, cfg, product, draft));
}

async function onBoostConfirm(interaction, yes) {
  const sess = bsSessions.get(interaction.user.id);
  bsSessions.delete(interaction.user.id);
  if (!yes) return interaction.update({ content: '✖️ Pesanan dibatalkan.', embeds: [], components: [] });
  if (!sess || sess.expires < Date.now()) {
    return interaction.update({ content: '⌛ Sesi sudah berakhir. Silakan klik Order Sekarang lagi.', embeds: [], components: [] });
  }
  const cfg = loadConfig();
  const guild = interaction.guild;
  const d = sess.draft;
  const product = getProduct(cfg, d.productId);
  if (!isProductOpen(product) || planStockOf(product, d.plan.id) < d.qty) {
    return interaction.update({ content: `🔴 Maaf, stock **${product?.label || 'produk ini'}** tidak cukup / baru saja **TUTUP**.`, embeds: [], components: [] });
  }
  if (activeTicketOf({ userId: interaction.user.id, kind: 'boost' })) {
    return interaction.update({ content: '⚠️ Kamu masih punya ticket Server Boost yang sedang berjalan.', embeds: [], components: [] });
  }

  // Kunci stock paket SEKARANG supaya tidak terjual melebihi stock.
  setPlanStock(product, d.plan.id, planStockOf(product, d.plan.id) - d.qty);
  const tc = product.ticket || {};
  const id = nextTicketId(tc.idPrefix || 'SB', 'boostSeq');
  const ticket = {
    id,
    kind: 'boost',
    guildId: guild.id,
    userId: interaction.user.id,
    channelId: null,
    messageId: null,
    productId: product.id,
    productLabel: product.label,
    plan: d.plan,
    qty: d.qty,
    invite: d.invite,
    server: d.server,
    estimate: product.estimate || '1x24 jam',
    amount: 0,
    price: d.price,
    stage: { sent: false, received: false },
    status: 'open',
    createdAt: Date.now(),
  };
  state.tickets[id] = ticket;
  save();
  await interaction.update({ content: '⏳ Sedang membuat ticket kamu...', embeds: [], components: [] });

  try {
    const member = [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.AttachFiles,
      PermissionFlagsBits.EmbedLinks,
    ];
    const overwrites = [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: interaction.user.id, allow: member },
      { id: guild.members.me.id, allow: [...member, PermissionFlagsBits.ManageChannels] },
    ];
    const staff = isId(cfg.ticket?.staffRoleId) ? cfg.ticket.staffRoleId : null;
    if (staff) overwrites.push({ id: staff, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
    const slug = interaction.user.username.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20);
    const channel = await createTicketChannel(guild, interaction, cfg, {
      name: `🚀・${id.toLowerCase()}-${slug}`,
      topic: `${id} • ${product.label} ${d.qty}x ${d.plan.label} • ${interaction.user.tag}`,
      overwrites,
      userIds: [interaction.user.id],
      categoryName: tc.categoryName || '🚀 TICKET BOOST',
    });
    ticket.channelId = channel.id;
    const msg = await channel.send(
      v2({
        content: `<@${interaction.user.id}>${staff ? ` <@&${staff}>` : ''}`,
        ...V.buildTicketMessage(guild, cfg, ticket),
        allowedMentions: { users: [interaction.user.id], roles: staff ? [staff] : [] },
      }),
    );
    await msg.pin().catch(() => {});
    ticket.messageId = msg.id;
    save();
    logOrder(guild, ticket, '🆕 Order received — awaiting payment');

    const url = channelUrl(guild.id, channel.id);
    const dmOk = await interaction.user
      .send(V.dm(V.buildDmCreated(guild, cfg, ticket, url)))
      .then(() => true)
      .catch(() => false);
    if (!dmOk) channel.send('ℹ️ Bot tidak bisa mengirim DM ke kamu (DM tertutup). Semua info pesanan ada di ticket ini.').catch(() => {});
    await interaction.editReply({
      content: `✅ **Ticket berhasil dibuat!** Lanjutkan pembayaran di ${channel}.`,
      components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Buka Ticket').setEmoji('🎫').setURL(url))],
    });
  } catch (err) {
    console.error('[store] gagal membuat ticket boost:', err);
    setPlanStock(product, d.plan.id, planStockOf(product, d.plan.id) + d.qty);
    delete state.tickets[id];
    save();
    await interaction.editReply('❌ Gagal membuat ticket. Pastikan bot punya izin **Manage Channels** & **Manage Roles**, lalu coba lagi.').catch(() => {});
    refreshPanel();
    return;
  }
  refreshPanel();
  await closeIfSoldOut(guild, `${BOOST} **Stock ${product.label} sudah HABIS!** ${product.label} otomatis ditutup.`, product);
}

function boostTicketFor(interaction, ticketId) {
  const t = state.tickets[ticketId];
  if (!t || kindOf(t) !== 'boost' || t.status !== 'open') {
    interaction.reply({ content: 'Ticket ini sudah ditutup.', flags: EPH }).catch(() => {});
    return null;
  }
  t.stage = t.stage || {};
  return t;
}
async function advanceBoost(interaction, t, step, logText) {
  const cfg = loadConfig();
  save();
  logOrder(interaction.guild, t, logText);
  await interaction.update(ticketPayloadFor(interaction.message, interaction.guild, cfg, t));
  await interaction.channel.send(v2(V.buildBoostStep(interaction.guild, cfg, t, step))).catch(() => {});
}
/** Admin: server pembeli sudah di-boost. */
async function onBoostSent(interaction, ticketId) {
  if (!isAdmin(interaction.member)) return interaction.reply({ content: '⛔ Hanya **Administrator** yang bisa menandai boost terkirim.', flags: EPH });
  const t = boostTicketFor(interaction, ticketId);
  if (!t) return;
  if (!V.isPaid(t)) return interaction.reply({ content: '⚠️ Pembayaran ticket ini **belum diverifikasi**. Konfirmasi dana masuk dulu ya.', flags: EPH });
  t.stage.sent = true;
  t.stage.sentAt = Date.now();
  return advanceBoost(interaction, t, 'sent', `${BOOST} ${num(t.qty)} boost sent to server ${t.server?.name || ''}`.trim());
}
/** Pembeli: boost sudah masuk ke server. */
async function onBoostReceived(interaction, ticketId) {
  const t = boostTicketFor(interaction, ticketId);
  if (!t) return;
  if (interaction.user.id !== t.userId) return interaction.reply({ content: `⛔ Hanya <@${t.userId}> (pembeli) yang bisa mengonfirmasi.`, flags: EPH });
  if (!t.stage.sent) return interaction.reply({ content: 'Tunggu admin mem-boost server kamu terlebih dahulu.', flags: EPH });
  t.stage.received = true;
  t.stage.receivedAt = Date.now();
  return advanceBoost(interaction, t, 'received', '✅ Buyer confirmed the boosts arrived');
}

// ══════════════════════ PEMBAYARAN (semua produk) ══════════════════════
const buyerOf = (t) => (kindOf(t) === 'rekber' ? t.buyerId : t.userId);

/** Perbarui pesan detail ticket (status, tombol, info pembayaran). */
async function refreshTicketMessage(guild, t) {
  if (!t.channelId || !t.messageId) return;
  const ch = await ensureOpen(await guild.channels.fetch(t.channelId).catch(() => null));
  await editTicketMsg(ch, guild, loadConfig(), t);
}

function openTicketFor(interaction, ticketId) {
  const t = state.tickets[ticketId];
  if (!t || t.status !== 'open') {
    interaction.reply({ content: 'Ticket ini sudah ditutup.', flags: EPH }).catch(() => {});
    return null;
  }
  return t;
}

/** Tombol "Konfirmasi Pembayaran" → form bukti transfer. */
async function onPayButton(interaction, ticketId) {
  const t = openTicketFor(interaction, ticketId);
  if (!t) return;
  if (interaction.user.id !== buyerOf(t)) {
    return interaction.reply({ content: `⛔ Hanya <@${buyerOf(t)}> (pembeli) yang bisa mengirim bukti pembayaran.`, flags: EPH });
  }
  if (V.isPaid(t)) return interaction.reply({ content: '✅ Pembayaran ticket ini sudah **lunas**.', flags: EPH });
  if (kindOf(t) === 'rekber' && !t.stage?.agreed) {
    return interaction.reply({ content: 'Tunggu pihak lawan **menyetujui transaksi** sebelum melakukan pembayaran.', flags: EPH });
  }
  const cfg = loadConfig();
  const methods = V.payMethods(cfg).slice(0, 24);
  const modal = new ModalBuilder().setCustomId(`store:paymodal:${t.id}`).setTitle('Konfirmasi Pembayaran');
  const labels = [];
  const options = methods.map((m) => ({
    label: m.bank.slice(0, 100),
    description: `${V.isWallet(m) ? 'E-Wallet' : 'Transfer Bank'} • ${m.number}`.slice(0, 100),
    value: m.bank.slice(0, 100),
    emoji: m.emoji || (V.isWallet(m) ? '📱' : '🏦'),
  }));
  if (V.qrisOf(cfg)) options.push({ label: 'QRIS', description: 'Scan QRIS (m-banking / e-wallet)', value: 'QRIS', emoji: V.qrisEmoji(cfg) });
  if (options.length) {
    labels.push(
      new LabelBuilder()
        .setLabel('Metode Pembayaran')
        .setStringSelectMenuComponent(new StringSelectMenuBuilder().setCustomId('bank').setPlaceholder('Pilih metode yang kamu pakai...').setRequired(true).addOptions(options)),
    );
  }
  labels.push(
    new LabelBuilder()
      .setLabel('Nama Pengirim')
      .setDescription('Nama pemilik rekening / akun e-wallet yang tertera di bukti bayar.')
      .setTextInputComponent(new TextInputBuilder().setCustomId('sender').setStyle(TextInputStyle.Short).setPlaceholder('contoh: Ahmad Febryan').setMinLength(2).setMaxLength(60).setRequired(true)),
    new LabelBuilder()
      .setLabel('Bukti Pembayaran')
      .setDescription(`Screenshot bukti bayar sebesar ${rupiah(V.payAmount(t))}.`)
      .setFileUploadComponent(new FileUploadBuilder().setCustomId('proof').setMinValues(1).setMaxValues(1).setRequired(true)),
    new LabelBuilder()
      .setLabel('Catatan (opsional)')
      .setTextInputComponent(new TextInputBuilder().setCustomId('note').setStyle(TextInputStyle.Paragraph).setMaxLength(300).setRequired(false)),
  );
  modal.addLabelComponents(...labels);
  return interaction.showModal(modal);
}

async function onPayModal(interaction, ticketId) {
  const t = state.tickets[ticketId];
  if (!t || t.status !== 'open') return interaction.reply({ content: 'Ticket ini sudah ditutup.', flags: EPH });
  await interaction.deferReply({ flags: EPH });
  const cfg = loadConfig();
  const guild = interaction.guild;
  const upload = interaction.fields.getUploadedFiles('proof')?.first?.() || null;
  if (!upload) return interaction.editReply('📸 Wajib upload **screenshot bukti transfer**.');
  if (upload.contentType && !upload.contentType.startsWith('image/')) return interaction.editReply('❌ Bukti transfer harus berupa **gambar** (PNG / JPG).');
  const methods = V.payMethods(cfg);
  let bank = '-';
  if (methods.length || V.qrisOf(cfg)) {
    try {
      bank = interaction.fields.getStringSelectValues('bank')?.[0] || '-';
    } catch {}
  }
  const sender = interaction.fields.getTextInputValue('sender').trim();
  const note = (interaction.fields.getTextInputValue('note') || '').trim();

  t.payment = { status: 'pending', bank, sender, note: note || null, at: Date.now(), userId: interaction.user.id };
  // Simpan bukti bayar pembeli — nanti dipakai sebagai gambar di channel testimoni (link Discord bisa kedaluwarsa).
  try {
    t.payProofFile = kindOf(t) === 'instant' ? null : (await saveProof(upload, `pay-${t.id}`)) || null;
  } catch (e) {
    t.payProofFile = null;
    console.warn(`[store] simpan bukti bayar ${t.id}:`, e.message);
  }
  t.payProofRemoteUrl = kindOf(t) === 'instant' ? null : upload.url;
  save();
  startPayBlur(t, cfg); // OCR + blur nama/no. rekening di latar belakang (dipakai untuk gambar testimoni)

  const staff = isId(cfg.ticket?.staffRoleId) ? cfg.ticket.staffRoleId : null;
  const ext = (path.extname((upload.name || '').split('?')[0]) || '.png').toLowerCase();
  const fileName = `bukti-bayar-${t.id}${ext}`;
  const base = V.buildPaymentProof(guild, cfg, t, t.payment, `attachment://${fileName}`);
  const extra = { content: staff ? `<@&${staff}>` : undefined, allowedMentions: { roles: staff ? [staff] : [] } };
  // Gambar diunggah ulang supaya tidak kedaluwarsa; kalau gagal (DNS VPS), pakai link aslinya.
  await interaction.channel.send(v2({ ...base, ...extra, files: [{ attachment: upload.url, name: fileName }] })).catch(async () => {
    await interaction.channel.send(v2({ ...V.buildPaymentProof(guild, cfg, t, t.payment, upload.url), ...extra })).catch(() => {});
  });
  logOrder(guild, t, '💳 Buyer sent proof of payment');
  await refreshTicketMessage(guild, t);
  return interaction.editReply('✅ Bukti pembayaran terkirim! Admin akan segera memverifikasi pembayaranmu. ⏳');
}

async function onShowQris(interaction, ticketId) {
  const t = state.tickets[ticketId];
  if (!t) return interaction.reply({ content: 'Ticket tidak ditemukan.', flags: EPH });
  return interaction.reply(V.buildQris(interaction.guild, loadConfig(), t));
}

async function onCopyAccounts(interaction, ticketId) {
  const t = state.tickets[ticketId];
  if (!t) return interaction.reply({ content: 'Ticket tidak ditemukan.', flags: EPH });
  const p = v2(V.buildCopyAccounts(loadConfig(), t));
  return interaction.reply({ ...p, flags: (p.flags || 0) | EPH });
}

/**
 * Tandai dana masuk (dipakai tombol "Dana Masuk" & /danamasuk).
 * Return teks error kalau tidak bisa, atau null kalau berhasil.
 */
async function markPaid(guild, channel, t, { by, amount, note }) {
  const cfg = loadConfig();
  if (t.status !== 'open') return 'Ticket ini sudah ditutup.';
  if (V.isPaid(t)) return '✅ Pembayaran ticket ini sudah ditandai **lunas** sebelumnya.';
  const nominal = Number(amount) || V.payAmount(t);
  if (kindOf(t) === 'rekber') {
    if (!t.stage?.agreed) return 'Pihak lawan belum **menyetujui transaksi**.';
    t.stage.funded = true;
    t.stage.fundedBy = by;
  }
  t.payment = { ...(t.payment || {}), status: 'paid', paidAt: Date.now(), paidBy: by, amount: nominal, adminNote: note || null };
  save();
  await refreshTicketMessage(guild, t);
  if (kindOf(t) === 'rekber') {
    logOrder(guild, t, STEP_LOG.funded(t));
    await channel.send(v2(V.buildRekberStep(guild, cfg, t, 'funded'))).catch(() => {});
    if (note || nominal !== V.payAmount(t)) await channel.send(v2(V.buildDanaMasuk(guild, cfg, t, { amount: nominal, note, by }))).catch(() => {});
  } else {
    logOrder(guild, t, '💰 Payment received — order is being processed');
    await channel.send(v2(V.buildDanaMasuk(guild, cfg, t, { amount: nominal, note, by }))).catch(() => {});
  }
  // Premium App: dana masuk (mode manual) → akun dikirim otomatis pakai saldo Waroengkuy.
  if (kindOf(t) === 'instant') {
    I.onPaid(t).catch((e) => console.error(`[instan] onPaid ${t.id}:`, e.message));
    return null;
  }
  // DM pembeli
  const buyer = await client.users.fetch(buyerOf(t)).catch(() => null);
  const dm = V.buildDanaMasuk(guild, cfg, t, { amount: nominal, note, by });
  await buyer
    ?.send(
      V.dm({
        embeds: dm.embeds,
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Buka Ticket').setEmoji('🎫').setURL(channelUrl(guild.id, t.channelId)),
          ),
        ],
      }),
    )
    .catch(() => {});
  return null;
}

/** Tombol "Dana Masuk (Admin)" di bukti pembayaran. */
async function onPaidButton(interaction, ticketId) {
  if (!isAdmin(interaction.member)) return interaction.reply({ content: '⛔ Hanya **Administrator** yang bisa memverifikasi pembayaran.', flags: EPH });
  const t = state.tickets[ticketId];
  if (!t) return interaction.reply({ content: 'Ticket tidak ditemukan.', flags: EPH });
  await interaction.deferUpdate();
  const err = await markPaid(interaction.guild, interaction.channel, t, { by: interaction.user.id });
  if (err) return interaction.followUp({ content: err, flags: EPH });
  await stripRows(interaction.message);
}

/** Tombol "Tolak (Admin)" → form alasan. */
async function onPayRejectButton(interaction, ticketId) {
  if (!isAdmin(interaction.member)) return interaction.reply({ content: '⛔ Hanya **Administrator** yang bisa menolak pembayaran.', flags: EPH });
  const t = openTicketFor(interaction, ticketId);
  if (!t) return;
  const modal = new ModalBuilder()
    .setCustomId(`store:payrejmodal:${t.id}`)
    .setTitle('Tolak Bukti Pembayaran')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('Alasan Penolakan')
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId('reason')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('contoh: Nominal kurang Rp 1.000 / dana belum masuk ke rekening')
            .setMaxLength(300)
            .setRequired(true),
        ),
    );
  return interaction.showModal(modal);
}

async function onPayRejectModal(interaction, ticketId) {
  if (!isAdmin(interaction.member)) return interaction.reply({ content: '⛔ Hanya **Administrator**.', flags: EPH });
  const t = state.tickets[ticketId];
  if (!t || t.status !== 'open') return interaction.reply({ content: 'Ticket ini sudah ditutup.', flags: EPH });
  await interaction.deferUpdate();
  const reason = interaction.fields.getTextInputValue('reason').trim();
  t.payment = { ...(t.payment || {}), status: 'rejected', rejectedAt: Date.now(), rejectReason: reason };
  save();
  await stripRows(interaction.message);
  await interaction.channel.send(v2(V.buildPayRejected(interaction.guild, loadConfig(), t, reason, interaction.user.id))).catch(() => {});
  await refreshTicketMessage(interaction.guild, t);
}

/** /danamasuk [nominal] [catatan] — dijalankan di channel ticket. */
async function onDanaMasukCommand(interaction) {
  await interaction.deferReply({ flags: EPH });
  const t = Object.values(state.tickets).find((x) => x.channelId === interaction.channelId && x.status === 'open');
  if (!t) return interaction.editReply('❌ Jalankan `/danamasuk` di dalam **channel ticket** yang masih berjalan.');
  const err = await markPaid(interaction.guild, interaction.channel, t, {
    by: interaction.user.id,
    amount: interaction.options.getInteger('nominal'),
    note: interaction.options.getString('catatan'),
  });
  if (err) return interaction.editReply(err);
  return interaction.editReply(`✅ Dana masuk untuk **${t.id}** sudah diumumkan di ticket & pembeli mendapat DM.`);
}

// ══════════════════════ Tutup ticket (khusus Administrator) ══════════════════════
async function onCloseButton(interaction, ticketId) {
  if (!isAdmin(interaction.member)) {
    return interaction.reply({ content: '⛔ Hanya **Administrator** yang bisa menutup ticket.', flags: EPH });
  }
  const t = state.tickets[ticketId];
  if (!t || t.status !== 'open') return interaction.reply({ content: 'Ticket ini sudah ditutup.', flags: EPH });
  const rekber = kindOf(t) === 'rekber';

  const modal = new ModalBuilder()
    .setCustomId(`store:closemodal:${ticketId}`)
    .setTitle(`Tutup Ticket ${ticketId}`)
    .addLabelComponents(
      new LabelBuilder()
        .setLabel(rekber ? 'Bukti Pencairan Dana' : 'Gambar Bukti / Testimoni')
        .setDescription(
          rekber
            ? 'Upload bukti transfer dana ke penjual (atau ke pembeli untuk refund). Wajib untuk Completed.'
            : 'Upload screenshot bukti pengiriman. Wajib untuk status Completed.',
        )
        .setFileUploadComponent(new FileUploadBuilder().setCustomId('proof').setMinValues(0).setMaxValues(1).setRequired(false)),
      new LabelBuilder()
        .setLabel('Status Pesanan')
        .setStringSelectMenuComponent(
          new StringSelectMenuBuilder()
            .setCustomId('status')
            .setPlaceholder('Pilih status pesanan...')
            .setRequired(true)
            .addOptions(
              {
                label: 'Completed',
                description: rekber ? 'Dana dicairkan ke penjual' : 'Produk berhasil dikirim',
                value: 'completed',
                emoji: '✅',
              },
              { label: 'Cancelled', description: 'Dibatalkan', value: 'cancelled', emoji: '❌' },
              {
                label: 'Refund',
                description: rekber ? 'Dana dikembalikan ke pembeli' : 'Dana dikembalikan',
                value: 'refund',
                emoji: '💸',
              },
            ),
        ),
      new LabelBuilder()
        .setLabel('Catatan (opsional)')
        .setTextInputComponent(
          new TextInputBuilder().setCustomId('note').setStyle(TextInputStyle.Paragraph).setMaxLength(300).setRequired(false),
        ),
    );
  return interaction.showModal(modal);
}

async function saveProof(attachment, ticketId) {
  if (!attachment) return null;
  if (attachment.contentType && !attachment.contentType.startsWith('image/')) return null;
  const ext = (path.extname((attachment.name || '').split('?')[0]) || '.png').toLowerCase();
  let lastErr;
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch(attachment.url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      fs.mkdirSync(PROOF_DIR, { recursive: true });
      const file = path.join(PROOF_DIR, `${ticketId}${ext}`);
      fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      return file;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1))); // jaga-jaga DNS VPS sedang bermasalah
    }
  }
  throw new Error(`download bukti gagal: ${lastErr?.cause?.code || lastErr?.message}`);
}

/**
 * Gambar bukti pengiriman untuk kartu history (bagian Progress).
 *  • Robux Visend (Completed): digambar bot — foto profil, "Sent Robux to" + username di-blur, jumlah Robux, latar putih.
 *  • Produk lain: gambar bukti yang di-upload admin saat menutup ticket.
 * File disalin ke data/proofs/log-<id>.* (tetap ada walau file bukti ticket dihapus).
 */
async function prepareLogImage(t, status) {
  if (kindOf(t) === 'instant') return; // Premium App: history tanpa gambar
  try {
    let buf = null;
    let ext = '.png';
    if (kindOf(t) === 'robux' && status === 'completed') {
      buf = await robuxSentProof({ avatarUrl: t.roblox?.avatar, username: t.roblox?.name, amount: t.amount });
    }
    if (!buf && t.proofFile && fs.existsSync(t.proofFile)) {
      buf = fs.readFileSync(t.proofFile);
      ext = path.extname(t.proofFile) || '.png';
    }
    if (buf) {
      fs.mkdirSync(PROOF_DIR, { recursive: true });
      t.logImageFile = path.join(PROOF_DIR, `log-${t.id}${ext}`);
      t.logImageName = `progress-${t.id}${ext}`;
      fs.writeFileSync(t.logImageFile, buf);
    } else if (t.proofRemoteUrl) {
      t.logImageUrl = t.proofRemoteUrl;
    }
    save();
  } catch (e) {
    console.warn(`[store] gambar log ${t.id}:`, e.message);
  }
}

// ══════════════════════ Blur otomatis bukti pembayaran + cek admin sebelum testimoni terkirim ══════════════════════
const blurJobs = new Map(); // ticketId → Promise
/** Jalankan OCR + blur di latar belakang. Hasil: data/proofs/pay-<id>-blur.png (t.payProofBlurFile). */
function startPayBlur(t, cfg) {
  if (kindOf(t) === 'instant' || !t.payProofFile || cfg?.ticket?.blurPaymentProof === false) return;
  const out = path.join(PROOF_DIR, `pay-${t.id}-blur.png`);
  const names = [t.payment?.sender, cfg?.payment?.accountName].filter(Boolean);
  const numbers = (cfg?.payment?.methods || []).map((m) => m.number).filter(Boolean);
  const job = blurPaymentProof(t.payProofFile, out, { names, numbers })
    .then((r) => {
      t.payProofBlurFile = r.ok ? out : null;
      t.payBlurBoxes = r.ok ? r.boxes : 0;
      t.payBlurError = r.ok ? null : r.error || 'gagal';
      if (!r.ok) console.warn(`[store] blur bukti ${t.id}: ${r.error}`);
      save();
    })
    .catch((e) => console.warn(`[store] blur bukti ${t.id}:`, e.message))
    .finally(() => blurJobs.delete(t.id));
  blurJobs.set(t.id, job);
}

/** Lampiran hasil blur (kalau ada). */
function payBlurAttachment(t) {
  if (!t.payProofBlurFile || !fs.existsSync(t.payProofBlurFile)) return { files: [], url: null };
  const name = `bukti-bayar-${t.id}.png`;
  return { files: [{ attachment: t.payProofBlurFile, name }], url: `attachment://${name}` };
}

/** Gambar untuk testimoni sesuai pilihan admin: blur (default) | raw | custom | none. */
function testimonyImage(t) {
  if (kindOf(t) === 'instant' || t.testiImageMode === 'none') return { files: [], url: null };
  if (t.testiImageMode === 'custom' && t.testiImageFile && fs.existsSync(t.testiImageFile)) {
    const name = `bukti-bayar-${t.id}${path.extname(t.testiImageFile)}`;
    return { files: [{ attachment: t.testiImageFile, name }], url: `attachment://${name}` };
  }
  if (t.testiImageMode === 'raw') return payProofAttachment(t).url ? payProofAttachment(t) : proofAttachment(t);
  const b = payBlurAttachment(t);
  if (b.url) return b;
  return payProofAttachment(t).url ? payProofAttachment(t) : proofAttachment(t); // OCR gagal → asli (hanya lewat review / tanpa review)
}

/** Channel admin untuk cek testimoni: channels.testiReview, kalau kosong pakai Command Center. */
const reviewChannelId = (cfg) => (isId(cfg?.channels?.testiReview) ? cfg.channels.testiReview : isId(cfg?.channels?.controlPanel) ? cfg.channels.controlPanel : null);

function buildTestiReview(guild, cfg, t) {
  const blur = payBlurAttachment(t);
  const raw = payProofAttachment(t);
  const rawName = `asli-${t.id}${path.extname(t.payProofFile || '.png')}`;
  const files = [];
  const embeds = [];
  const status = blur.url
    ? `✅ Blur otomatis selesai — **${t.payBlurBoxes || 0}** area disamarkan.`
    : `⚠️ Blur otomatis **gagal / tidak ada hasil**${t.payBlurError ? ` (\`${String(t.payBlurError).slice(0, 80)}\`)` : ''} — pilih **Pakai Asli**, **Ganti Gambar**, atau **Tanpa Gambar**.`;
  const stars = t.testimony ? `${'⭐'.repeat(t.testimony.rating)} **${t.testimony.rating}/5**${t.testimony.auto ? ' _(otomatis)_' : ''}` : '-';
  const head = new EmbedBuilder()
    .setTitle('🔎 Cek Gambar Testimoni')
    .setDescription(
      `Testimoni untuk ticket **${t.id}** menunggu persetujuanmu sebelum dikirim ke <#${cfg.channels?.testimoni}>.\n\n` +
        `👤 <@${t.userId}> • 📦 ${t.productLabel || '-'} • ${stars}\n${t.testimony?.comment ? `>>> ${String(t.testimony.comment).slice(0, 400)}\n\n` : '\n'}${status}`,
    );
  if (blur.url) {
    head.setImage(blur.url);
    files.push(...blur.files);
  }
  embeds.push(head);
  if (raw.files.length) {
    files.push({ attachment: raw.files[0].attachment, name: rawName });
    embeds.push(new EmbedBuilder().setTitle('🖼️ Gambar Asli (pembanding)').setDescription('-# Hanya terlihat admin. Yang dikirim ke testimoni adalah hasil blur di atas.').setImage(`attachment://${rawName}`));
  }
  const b = (id, label, emoji, style = ButtonStyle.Secondary, disabled = false) =>
    new ButtonBuilder().setCustomId(`store:${id}:${t.id}`).setLabel(label).setEmoji(emoji).setStyle(style).setDisabled(disabled);
  const rows = [
    new ActionRowBuilder().addComponents(b('trvok', 'Kirim Testimoni', '✅', ButtonStyle.Success, !blur.url), b('trvraw', 'Pakai Asli', '🖼️'), b('trvrep', 'Ganti Gambar', '📎'), b('trvnone', 'Tanpa Gambar', '🚫')),
  ];
  return { embeds, components: rows, files };
}

/** Kirim pesan cek ke admin. true = pesan review terkirim (testimoni ditahan). */
async function sendTestiReview(guild, t) {
  const cfg = loadConfig();
  const chId = reviewChannelId(cfg);
  if (!chId) return false;
  const channel = await guild.channels.fetch(chId).catch(() => null);
  if (!channel?.isTextBased()) return false;
  // Tunggu OCR selesai (maks 90 detik) supaya hasil blur sudah ada.
  const job = blurJobs.get(t.id);
  if (job) await Promise.race([job, new Promise((r) => setTimeout(r, 90000))]);
  const msg = await channel.send(v2(buildTestiReview(guild, cfg, t))).catch((e) => {
    console.warn(`[store] kirim review testimoni ${t.id}:`, e.message);
    return null;
  });
  if (!msg) return false;
  t.testiReview = { channelId: channel.id, messageId: msg.id, at: Date.now() };
  save();
  return true;
}

/** Tombol admin pada pesan review. */
async function onTestiReviewButton(interaction, action, ticketId) {
  if (!isAdmin(interaction.member)) return interaction.reply({ content: '⛔ Hanya **Administrator** yang bisa meninjau testimoni.', flags: EPH });
  const t = state.tickets[ticketId];
  if (!t || t.testimonyPosted) {
    await stripRows(interaction.message);
    return interaction.reply({ content: 'ℹ️ Testimoni ini sudah dikirim / tidak ditemukan.', flags: EPH });
  }
  if (action === 'trvrep') {
    return interaction.showModal(
      new ModalBuilder()
        .setCustomId(`store:trvrepm:${t.id}`)
        .setTitle('Ganti gambar testimoni')
        .addLabelComponents(
          new LabelBuilder()
            .setLabel('Gambar bukti yang sudah kamu sensor')
            .setDescription('Upload gambar pengganti (PNG / JPG / WEBP). Ini yang akan dikirim ke channel testimoni.')
            .setFileUploadComponent(new FileUploadBuilder().setCustomId('img').setMinValues(1).setMaxValues(1).setRequired(true)),
        ),
    );
  }
  await interaction.deferUpdate();
  t.testiImageMode = action === 'trvraw' ? 'raw' : action === 'trvnone' ? 'none' : 'blur';
  await finishTestimonyReview(interaction, t);
}

async function onTestiReviewModal(interaction, ticketId) {
  if (!isAdmin(interaction.member)) return interaction.reply({ content: '⛔ Hanya **Administrator**.', flags: EPH });
  const t = state.tickets[ticketId];
  if (!t || t.testimonyPosted) return interaction.reply({ content: 'ℹ️ Testimoni ini sudah dikirim / tidak ditemukan.', flags: EPH });
  const upload = interaction.fields.getUploadedFiles('img')?.first?.() || null;
  if (!upload || (upload.contentType && !upload.contentType.startsWith('image/'))) return interaction.reply({ content: '❌ Upload sebuah **gambar**.', flags: EPH });
  await interaction.deferUpdate();
  try {
    t.testiImageFile = await saveProof(upload, `testi-${t.id}`);
    t.testiImageMode = 'custom';
  } catch (e) {
    return interaction.followUp({ content: `❌ Gagal menyimpan gambar: ${e.message}`, flags: EPH });
  }
  await finishTestimonyReview(interaction, t);
}

async function finishTestimonyReview(interaction, t) {
  const guild = interaction.guild;
  await postTestimony(guild, t, { approved: true });
  const modeLabel = { blur: 'hasil blur', raw: 'gambar asli', custom: 'gambar pengganti', none: 'tanpa gambar' }[t.testiImageMode] || 'hasil blur';
  const done = new EmbedBuilder().setTitle('✅ Testimoni Dikirim').setDescription(`Ticket **${t.id}** — testimoni dikirim ke <#${loadConfig()?.channels?.testimoni}> dengan **${modeLabel}**.\n-# Disetujui oleh <@${interaction.user.id}>`);
  await interaction.message.edit(v2({ embeds: [done], components: [], files: [] })).catch(() => {});
  if (t.deleted) cleanupProofFiles(t);
}

/** Hapus file bukti (asli + blur + pengganti) dari disk. */
function cleanupProofFiles(t) {
  if (t.testiReview && !t.testimonyPosted) return; // masih menunggu cek admin → file dibutuhkan
  for (const f of [t.adminProofFile, t.proofFile, t.payProofFile, t.payProofBlurFile, t.testiImageFile]) if (f) fs.rm(f, { force: true }, () => {});
}

/** Bukti pembayaran yang diunggah pembeli (dari disk, fallback link Discord). */
function payProofAttachment(t) {
  if (!t.payProofFile || !fs.existsSync(t.payProofFile)) return { files: [], url: t.payProofRemoteUrl || null };
  const name = `bukti-bayar-${t.id}${path.extname(t.payProofFile)}`;
  return { files: [{ attachment: t.payProofFile, name }], url: `attachment://${name}` };
}

/** Lampiran bukti (dari disk) untuk dikirim bersama embed. */
function proofAttachment(t) {
  // Fallback: file gagal di-download ke VPS → pakai link gambar asli dari Discord.
  if (!t.proofFile || !fs.existsSync(t.proofFile)) return { files: [], url: t.proofRemoteUrl || null };
  const name = `bukti-${t.id}${path.extname(t.proofFile)}`;
  return { files: [{ attachment: t.proofFile, name }], url: `attachment://${name}` };
}

async function onCloseModal(interaction, ticketId) {
  if (!isAdmin(interaction.member)) {
    return interaction.reply({ content: '⛔ Hanya **Administrator** yang bisa menutup ticket.', flags: EPH });
  }
  await interaction.deferReply({ flags: EPH });
  const cfg = loadConfig();
  const guild = interaction.guild;
  const t = state.tickets[ticketId];
  if (!t || t.status !== 'open') return interaction.editReply('Ticket ini sudah ditutup.');

  const status = interaction.fields.getStringSelectValues('status')?.[0];
  const upload = interaction.fields.getUploadedFiles('proof')?.first?.() || null;
  const note = (interaction.fields.getTextInputValue('note') || '').trim();
  if (!['completed', 'cancelled', 'refund'].includes(status)) return interaction.editReply('❌ Pilih status pesanan.');
  if (status === 'completed' && !upload) {
    return interaction.editReply('📸 Untuk status **Completed**, wajib upload **gambar bukti / testimoni**. Klik Tutup Ticket lagi.');
  }

  if (upload && upload.contentType && !upload.contentType.startsWith('image/')) {
    return interaction.editReply('❌ File bukti harus berupa **gambar** (PNG / JPG / WEBP).');
  }
  try {
    t.proofFile = await saveProof(upload, t.id);
  } catch (err) {
    // Tidak menggagalkan penutupan ticket: gambar tetap ditampilkan lewat link aslinya.
    console.warn(`[store] ${err.message} → pakai link gambar asli.`);
    t.proofFile = null;
    t.proofRemoteUrl = upload?.url || null;
  }

  // Robux Visend (Completed): pembeli menerima bukti "Sent Robux" buatan bot TANPA blur;
  // channel history memakai versi yang usernamenya di-blur (lihat prepareLogImage).
  if (kindOf(t) === 'robux' && status === 'completed') {
    try {
      const buf = await robuxSentProof({ avatarUrl: t.roblox?.avatar, username: t.roblox?.name, amount: t.amount, reveal: true });
      if (buf) {
        fs.mkdirSync(PROOF_DIR, { recursive: true });
        t.adminProofFile = t.proofFile || null; // upload admin disimpan sebagai cadangan
        t.proofFile = path.join(PROOF_DIR, `buyer-${t.id}.png`);
        fs.writeFileSync(t.proofFile, buf);
        t.proofRemoteUrl = null;
      }
    } catch (e) {
      console.warn(`[store] bukti pembeli ${t.id}:`, e.message);
    }
  }

  let spenderBefore = null; // diisi saat order Completed (untuk role spender)
  t.status = status;
  t.closedAt = Date.now();
  t.closedBy = interaction.user.id;
  t.note = note || null;

  const channel = interaction.channel;
  const proof = proofAttachment(t);
  t.proofUrl = proof.url;
  await prepareLogImage(t, status);
  const rekber = kindOf(t) === 'rekber';

  if (rekber) {
    if (status === 'completed') {
      state.stats.rekber += 1;
      state.stats.rekberVolume += t.nominal;
      t.testimonyDeadline = Date.now() + testimonyTimeoutMs(cfg);
    } else {
      t.deleteAt = Date.now() + (Number(cfg.ticket?.deleteAfterSeconds) || 15) * 1000;
    }
  } else if (status === 'completed') {
    state.stats.transactions += 1;
    state.stats.robux += t.amount;
    state.stats.revenue += t.price;
    const sp = state.spenders[t.userId] || { robux: 0, revenue: 0, orders: 0 };
    spenderBefore = { tier: SP.tierFor(sp.revenue, cfg), firstOrder: sp.orders === 0 };
    sp.robux += t.amount;
    sp.revenue += t.price;
    sp.orders += 1;
    state.spenders[t.userId] = sp;
    const ps = productStatsOf(t.productId);
    ps.orders += 1;
    ps.robux += t.amount;
    ps.revenue += t.price;
    if (kindOf(t) === 'canva' || kindOf(t) === 'boost') t.expiresAt = t.closedAt + (Number(t.plan?.days) || 30) * 86400000;
    t.testimonyDeadline = Date.now() + testimonyTimeoutMs(cfg);
  } else {
    if (kindOf(t) === 'robux') state.stock += t.amount; // stock Robux dikembalikan (gamepass tidak memakai stock)
    if (kindOf(t) === 'canva' || kindOf(t) === 'boost') returnSlot(cfg, t); // slot Canva / stock boost dikembalikan
    t.deleteAt = Date.now() + (Number(cfg.ticket?.deleteAfterSeconds) || 15) * 1000;
  }
  save();

  // Role spender: Buyer (order pertama) + tier sesuai total belanja.
  if (spenderBefore) {
    const res = await SP.applySpenderRoles(guild, t.userId, cfg).catch((e) => console.warn('[spender]', e.message));
    const tierNow = SP.tierFor(state.spenders[t.userId]?.revenue || 0, cfg);
    const levelUp = tierNow && tierNow !== spenderBefore.tier && tierNow.min !== spenderBefore.tier?.min;
    if (res && (levelUp || spenderBefore.firstOrder) && cfg.spenderRoles?.announce !== false) {
      const card = SP.buildTierUp(guild, cfg, t.userId, { prevTier: spenderBefore.tier, tier: levelUp ? tierNow : null, firstOrder: spenderBefore.firstOrder });
      await channel.send(v2(card)).catch(() => {});
      const u = await client.users.fetch(t.userId).catch(() => null);
      await u?.send(V.dm(card)).catch(() => {});
    }
  }

  // Refresh pesan detail ticket (status berubah, tombol hilang).
  if (t.messageId) editTicketMsg(channel, guild, cfg, t).catch(() => {});

  if (status === 'completed') {
    const prompt = V.buildTestimonyPrompt(guild, cfg, t);
    await channel.send(v2({ ...prompt, files: [...(prompt.files || []), ...(proof.files || [])] }));
  } else {
    const secs = Number(cfg.ticket?.deleteAfterSeconds) || 15;
    const closedEmbed = V.buildDmClosed(guild, cfg, t).embeds[0].setDescription(
      `Ticket ini ditutup dengan status **${V.statusLabel(t)}**.${note ? `\n\n📝 Catatan: ${note}` : ''}\n\nChannel ini akan dihapus dalam **${secs} detik**.`,
    );
    if (proof.url) closedEmbed.setImage(proof.url);
    const mentionIds = rekber ? [t.buyerId, t.sellerId] : [t.userId];
    await channel.send(
      v2({
        content: mentionIds.map((id) => `<@${id}>`).join(' '),
        embeds: [closedEmbed],
        files: proof.files,
        allowedMentions: { users: mentionIds },
      }),
    );
    if (['robux', 'canva', 'boost'].includes(kindOf(t))) {
      await announce(guild, 'returned', { ticket: t });
      await reopenIfAutoClosed(guild);
    }
  }

  // DM pembeli (rekber: kedua pihak) soal hasil transaksinya.
  for (const uid of rekber ? [t.buyerId, t.sellerId] : [t.userId]) {
    const user = await client.users.fetch(uid).catch(() => null);
    if (!user) continue;
    const dm = V.buildDmClosed(guild, cfg, t);
    const dmProof = proofAttachment(t);
    if (status === 'completed' && dmProof.url) dm.embeds[0].setImage(dmProof.url);
    else dm.embeds[0].setImage(null);
    await user.send(V.dm({ ...dm, files: status === 'completed' ? dmProof.files : [] })).catch(() => {});
  }

  logOrder(guild, t, CLOSE_LOG[kindOf(t)][status]);
  refreshPanel();
  refreshLeaderboard();
  return interaction.editReply(`✅ Ticket **${t.id}** ditutup sebagai **${V.statusLabel(t)}**.`);
}

// ══════════════════════ Testimoni pembeli ══════════════════════
async function onTestimonyButton(interaction, ticketId) {
  const t = state.tickets[ticketId];
  if (!t || t.status !== 'completed') return interaction.reply({ content: 'Ticket tidak ditemukan.', flags: EPH });
  if (interaction.user.id !== V.testimonyUserId(t)) {
    return interaction.reply({ content: '⛔ Hanya pembeli di ticket ini yang bisa memberi testimoni.', flags: EPH });
  }
  if (t.testimony || t.testimonyPosted) return interaction.reply({ content: '✅ Kamu sudah memberi testimoni. Terima kasih!', flags: EPH });

  const modal = new ModalBuilder()
    .setCustomId(`store:testimodal:${ticketId}`)
    .setTitle('Beri Testimoni')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('Rating')
        .setStringSelectMenuComponent(
          new StringSelectMenuBuilder()
            .setCustomId('rating')
            .setPlaceholder('Pilih bintang...')
            .setRequired(true)
            .addOptions(
              { label: '⭐⭐⭐⭐⭐  Sangat Puas', value: '5' },
              { label: '⭐⭐⭐⭐  Puas', value: '4' },
              { label: '⭐⭐⭐  Cukup', value: '3' },
              { label: '⭐⭐  Kurang', value: '2' },
              { label: '⭐  Kecewa', value: '1' },
            ),
        ),
      new LabelBuilder()
        .setLabel('Komentar')
        .setDescription('Ceritakan pengalaman belanjamu.')
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId('comment')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('contoh: Prosesnya cepat banget, admin ramah! 🔥')
            .setMinLength(3)
            .setMaxLength(500)
            .setRequired(true),
        ),
    );
  return interaction.showModal(modal);
}

async function postTestimony(guild, t, opts = {}) {
  const cfg = loadConfig();
  if (!isId(cfg?.channels?.testimoni)) return;
  const channel = await guild.channels.fetch(cfg.channels.testimoni).catch(() => null);
  if (!channel?.isTextBased()) return;
  // Gambar testimoni berasal dari bukti bayar pembeli → admin cek dulu (hasil blur otomatis) sebelum terkirim.
  const hasImage = kindOf(t) !== 'instant' && (t.payProofFile || t.payProofRemoteUrl || t.proofFile || t.proofRemoteUrl);
  if (!opts.approved && hasImage && cfg?.ticket?.reviewTestimonyImage !== false && !t.testiReview) {
    if (await sendTestiReview(guild, t)) return;
  }
  state.stats.testimonies += 1;
  t.testimonyNo = state.stats.testimonies; // disimpan supaya bisa dibuat ulang dengan nomor yang sama
  t.testimonyAt = Date.now();
  const buyer = await guild.members.fetch(V.testimonyUserId(t)).catch(() => null);
  // Gambar testimoni = bukti pembayaran yang diunggah pembeli (fallback: bukti dari admin).
  // Premium App (instant): testimoni tanpa gambar.
  const proof = testimonyImage(t);
  t.proofUrl = proof.url;
  const msg = await channel.send({ ...V.buildTestimony(guild, cfg, t, buyer), files: proof.files });
  t.testimonyMessageId = msg?.id || null;
  t.testimonyPosted = true;
  save();
  refreshReputation();
}

async function onTestimonyModal(interaction, ticketId) {
  const t = state.tickets[ticketId];
  if (!t || interaction.user.id !== V.testimonyUserId(t) || t.testimony || t.testimonyPosted) {
    return interaction.reply({ content: 'Testimoni tidak bisa dikirim.', flags: EPH });
  }
  await interaction.deferUpdate();
  const cfg = loadConfig();
  const rating = Math.min(5, Math.max(1, Number(interaction.fields.getStringSelectValues('rating')?.[0]) || 5));
  const comment = interaction.fields.getTextInputValue('comment').trim();

  t.testimony = { rating, comment, at: Date.now() };
  state.stats.ratingSum += rating;
  state.stats.ratingCount += 1;
  t.deleteAt = Date.now() + (Number(cfg.ticket?.deleteAfterSeconds) || 15) * 1000;
  save();

  await postTestimony(interaction.guild, t);
  logOrder(interaction.guild, t, `⭐ Buyer rated ${rating}/5`);
  await stripRows(interaction.message);
  await interaction.channel
    .send(V.toV2(V.buildTestimonyThanks(interaction.guild, cfg, t, rating, Number(cfg.ticket?.deleteAfterSeconds) || 15)))
    .catch(() => {});
  refreshPanel();
}

/** Batas waktu ulasan: store.json → ticket.testimonyTimeoutMinutes (default 10 menit). */
const testimonyTimeoutMs = (cfg) => Math.max(1, Number(cfg?.ticket?.testimonyTimeoutMinutes) || 10) * 60 * 1000;

// ══════════════════════ Tugas berkala: batas testimoni & hapus channel ══════════════════════
/** Hapus sesi order yang ditinggalkan (tidak dikonfirmasi) supaya memori tidak menumpuk. */
function sweepSessions() {
  const now = Date.now();
  for (const map of [sessions, rekberSessions, gpSessions, cvSessions, bsSessions]) {
    for (const [k, v] of map) if (!v?.expires || v.expires < now) map.delete(k);
  }
}

async function housekeeping() {
  if (!client) return;
  sweepSessions();
  const cfg = loadConfig();
  const now = Date.now();
  for (const t of Object.values(state.tickets)) {
    try {
      // Pembeli tidak memberi testimoni sampai batas waktu.
      // → otomatis diberi rating ⭐ 5 dengan keterangan "tidak ada ulasan", testimoni diposting, lalu ticket ditutup.
      if (t.status === 'completed' && !t.testimony && !t.testimonyPosted && !t.deleted && t.testimonyDeadline < now) {
        const guild = client.guilds.cache.get(t.guildId) || client.guilds.cache.first();
        const auto = cfg?.ticket?.autoTestimony || {};
        const rating = Math.min(5, Math.max(1, Number(auto.rating) || 5));
        t.testimony = { rating, comment: auto.comment || 'Tidak ada ulasan dari pembeli.', at: now, auto: true };
        state.stats.ratingSum += rating;
        state.stats.ratingCount += 1;
        t.testimonyPosted = true;
        t.deleteAt = now;
        save();
        if (cfg?.ticket?.postWithoutReview !== false && guild) await postTestimony(guild, t).catch((e) => console.warn(`[store] testimoni otomatis ${t.id}:`, e.message));
        logOrder(guild, t, `⏰ No review — automatically rated ${rating}/5`);
        refreshPanel();
        refreshLeaderboard();
      }
      // Canva Pro: ingatkan pembeli H-3 & beri tahu admin saat masa aktif habis.
      if ((kindOf(t) === 'canva' || kindOf(t) === 'boost') && t.status === 'completed' && t.expiresAt) {
        const expiry = kindOf(t) === 'boost' ? V.buildBoostExpiry : V.buildCanvaExpiry;
        const guild = client.guilds.cache.get(t.guildId) || client.guilds.cache.first();
        const remindMs = (Number(getProduct(cfg, t.productId)?.remindDays ?? 3) || 0) * 86400000;
        if (!t.remindedBuyer && remindMs && t.expiresAt - remindMs <= now && t.expiresAt > now && guild) {
          t.remindedBuyer = true;
          save();
          const u = await client.users.fetch(t.userId).catch(() => null);
          await u?.send(V.dm(expiry(guild, cfg, t, 'buyer'))).catch(() => {});
        }
        if (!t.remindedAdmin && t.expiresAt <= now && guild) {
          t.remindedAdmin = true;
          save();
          const admin = t.closedBy ? await client.users.fetch(t.closedBy).catch(() => null) : null;
          await admin?.send(V.dm(expiry(guild, cfg, t, 'admin'))).catch(() => {});
        }
      }
      // Hapus channel ticket yang sudah selesai.
      if (t.deleteAt && !t.deleted && t.deleteAt <= now) {
        t.deleted = true;
        save();
        const ch = await ensureOpen(await client.channels.fetch(t.channelId).catch(() => null));
        const guild = client.guilds.cache.get(t.guildId) || ch?.guild;
        // Arsip ticket (info lengkap + transkrip chat) ke channel arsip private sebelum channel dihapus.
        if (guild && !t.archived) {
          await archiveStoreTicket(guild, t, ch).catch((e) => console.error(`[store] arsip ${t.id}:`, e.message));
          save();
        }
        if (ch) await ch.delete(`Ticket ${t.id} selesai`).catch(() => {});
        // Tunggu log selesai (gambar bukti sudah ter-upload) sebelum file bukti dihapus.
        if (guild) await (logQueues.get(t.id) || Promise.resolve());
        cleanupProofFiles(t); // (file ditahan kalau testimoni masih menunggu cek admin)
      }
    } catch (err) {
      console.error(`[store] housekeeping ${t.id}:`, err.message);
    }
  }
}

/** Channel ticket dihapus manual saat masih berjalan → anggap batal & kembalikan stock. */
async function onChannelDelete(channel) {
  const t = Object.values(state.tickets).find((x) => x.channelId === channel.id && !x.deleted);
  if (!t) return;
  t.deleted = true;
  if (t.status === 'open') {
    t.status = 'cancelled';
    t.closedAt = Date.now();
    t.closedBy = client.user.id;
    t.note = 'Channel ticket dihapus manual';
    logOrder(channel.guild, t, kindOf(t) === 'rekber' ? '❌ Transaction cancelled' : '❌ Order cancelled');
    if (!['robux', 'canva', 'boost'].includes(kindOf(t))) {
      save();
    } else {
      if (kindOf(t) === 'canva' || kindOf(t) === 'boost') returnSlot(loadConfig(), t);
      else state.stock += t.amount;
      save();
      await announce(channel.guild, 'returned', { ticket: t });
      await reopenIfAutoClosed(channel.guild);
    }
    refreshPanel();
  } else save();
  // Channel sudah terhapus → arsip tetap dibuat (tanpa transkrip chat).
  if (!t.archived) {
    await archiveStoreTicket(channel.guild, t, null).catch((e) => console.error(`[store] arsip ${t.id}:`, e.message));
    save();
  }
}

// ══════════════════════ How to Order ══════════════════════
async function onHowTo(interaction) {
  const cfg = loadConfig();
  if (!cfg) return interaction.reply({ content: '❌ store.json tidak bisa dibaca.', flags: EPH });
  const guide = H.buildHowToGuide(interaction.guild, cfg, interaction.values[0]);
  await interaction.reply({ ...guide, flags: (guide.flags || 0) | EPH });
  // Reset pilihan dropdown supaya produk yang sama bisa dipilih lagi.
  if (interaction.message) editPanelMessage(interaction.message, H.buildHowToPanel(interaction.guild, cfg)).catch(() => {});
}

// ══════════════════════ Perbarui tampilan lama → Components V2 ══════════════════════
async function fetchAll(channel, max = 2000) {
  const out = [];
  let before;
  while (out.length < max) {
    const batch = await channel.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!batch?.size) break;
    out.push(...batch.values());
    before = batch.last().id;
    if (batch.size < 100) break;
  }
  return out;
}
const isV2 = (m) => Boolean(m.flags?.has?.(MessageFlags.IsComponentsV2));

/**
 * Buat ulang history order & testimoni lama (format embed) ke Components V2.
 * Dikirim sesuai urutan aslinya, lalu pesan lama dihapus. Return ringkasan.
 */
async function migrateToV2(guild) {
  const cfg = loadConfig();
  const res = { logs: 0, testi: 0, testiSkipped: 0, logSkipped: 0 };

  // 1) History order
  const logCh = isId(cfg?.channels?.log) ? await guild.channels.fetch(cfg.channels.log).catch(() => null) : null;
  if (logCh?.isTextBased()) {
    const known = new Set();
    const tickets = Object.values(state.tickets)
      .filter((t) => t.logMessageId)
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const t of tickets) {
      known.add(t.logMessageId);
      const old = await logCh.messages.fetch(t.logMessageId).catch(() => null);
      if (old && isV2(old)) continue; // sudah format baru
      await (logQueues.get(t.id) || Promise.resolve());
      const sent = await logCh.send(V.buildOrderLog(guild, cfg, t)).catch(() => null);
      if (!sent) continue;
      if (old) await old.delete().catch(() => {});
      t.logMessageId = sent.id;
      res.logs += 1;
    }
    save();
    // Log lama tanpa data ticket (misal pesanan percobaan yang sudah di-reset) → dihitung saja.
    const msgs = await fetchAll(logCh);
    res.logSkipped = msgs.filter((m) => m.author?.id === client.user.id && !isV2(m) && !known.has(m.id) && m.embeds?.length).length;
  }

  // 2) Testimoni
  const tCh = isId(cfg?.channels?.testimoni) ? await guild.channels.fetch(cfg.channels.testimoni).catch(() => null) : null;
  if (tCh?.isTextBased()) {
    const msgs = (await fetchAll(tCh)).filter((m) => m.author?.id === client.user.id && !isV2(m) && m.embeds?.length);
    const items = [];
    for (const m of msgs) {
      const e = m.embeds[0];
      const no = Number((e.title || '').match(/#(\d+)/)?.[1]);
      const field = (e.fields || []).find((f) => /Ticket/i.test(f.name));
      const id = field?.value?.replace(/[`\s]/g, '');
      const t = id && state.tickets[id];
      if (!no || !t) {
        res.testiSkipped += 1;
        continue;
      }
      items.push({ m, no, t, image: e.image?.url || null });
    }
    items.sort((a, b) => a.no - b.no);
    for (const { m, no, t, image } of items) {
      const buyer = await guild.members.fetch(V.testimonyUserId(t)).catch(() => null);
      const name = `bukti-${t.id}.png`;
      t.proofUrl = image ? `attachment://${name}` : null;
      const payload = V.buildTestimony(guild, cfg, t, buyer, { number: no, at: m.createdTimestamp });
      let sent = await tCh.send({ ...payload, files: image ? [{ attachment: image, name }] : [] }).catch(() => null);
      if (!sent && image) {
        // Gambar gagal diunggah ulang → pakai link aslinya.
        t.proofUrl = image;
        sent = await tCh.send(V.buildTestimony(guild, cfg, t, buyer, { number: no, at: m.createdTimestamp })).catch(() => null);
      }
      if (!sent) continue;
      await m.delete().catch(() => {});
      t.testimonyNo = no;
      t.testimonyAt = m.createdTimestamp;
      t.testimonyMessageId = sent.id;
      res.testi += 1;
    }
    save();
  }
  return res;
}

// ══════════════════════ Router interaksi ══════════════════════
async function handleInteraction(interaction) {
  const id = interaction.customId;
  if (typeof id !== 'string' || !id.startsWith('store:')) return false;
  const [, action, arg] = id.split(':');

  try {
    // 🎛️ Store Control Center (panel admin): customId "store:cp..."
    if (action?.startsWith('cp') && (await CP.handle(interaction, action, arg))) return true;
    // 👑 Premium App (Waroengkuy): semua customId "store:ins..."
    if (action?.startsWith('ins') && (await I.handle(interaction, action, arg))) return true;
    if (interaction.isButton()) {
      if (action === 'buy') await onProductInfo(interaction, arg);
      else if (action === 'order') await onBuy(interaction, arg);
      else if (action === 'terms') await onTerms(interaction, arg);
      else if (action === 'confirm') await onConfirm(interaction, arg === 'yes');
      else if (action === 'close') await onCloseButton(interaction, arg);
      else if (action === 'testi') await onTestimonyButton(interaction, arg);
      else if (['trvok', 'trvraw', 'trvrep', 'trvnone'].includes(action)) await onTestiReviewButton(interaction, action, arg);
      else if (action === 'rbconfirm') await onRekberConfirm(interaction, arg === 'yes');
      else if (action === 'rbagree') await onRekberAgree(interaction, arg);
      else if (action === 'rbfund') await onRekberFund(interaction, arg);
      else if (action === 'rbrecv') await onRekberReceived(interaction, arg);
      else if (action === 'gpprice' || action === 'gptax') await onGamepassCalcButton(interaction, arg, action === 'gptax' ? 'tax' : 'price');
      else if (action === 'gptutor') await onGamepassTutorial(interaction, arg);
      else if (action === 'gpconfirm') await onGamepassConfirm(interaction, arg === 'yes');
      else if (action === 'gpcheck') await onGamepassCheck(interaction, arg);
      else if (action === 'gfcalc') await onGiftCalcButton(interaction, arg);
      else if (action === 'gfconfirm') await onGiftConfirm(interaction, arg === 'yes');
      else if (action === 'paybtn') await onPayButton(interaction, arg);
      else if (action === 'copyacc') await onCopyAccounts(interaction, arg);
      else if (action === 'qris') await onShowQris(interaction, arg);
      else if (action === 'paid') await onPaidButton(interaction, arg);
      else if (action === 'payreject') await onPayRejectButton(interaction, arg);
      else if (action === 'cvconfirm') await onCanvaConfirm(interaction, arg === 'yes');
      else if (action === 'cvinvite') await onCanvaInvite(interaction, arg);
      else if (action === 'cvjoined') await onCanvaJoined(interaction, arg);
      else if (action === 'bsconfirm') await onBoostConfirm(interaction, arg === 'yes');
      else if (action === 'bssent') await onBoostSent(interaction, arg);
      else if (action === 'bsdone') await onBoostReceived(interaction, arg);
      else if (action === 'howtobtn') {
        const cfg = loadConfig();
        const guide = H.buildHowToGuide(interaction.guild, cfg, arg);
        await interaction.reply({ ...guide, flags: (guide.flags || 0) | EPH });
      }
    } else if (interaction.isStringSelectMenu()) {
      if (action === 'amount') await onAmountSelect(interaction, arg);
      else if (action === 'howto') await onHowTo(interaction);
    } else if (interaction.isModalSubmit()) {
      if (action === 'rbxmodal') await onRobloxModal(interaction, arg);
      else if (action === 'amountmodal') await onAmountModal(interaction, arg);
      else if (action === 'closemodal') await onCloseModal(interaction, arg);
      else if (action === 'testimodal') await onTestimonyModal(interaction, arg);
      else if (action === 'trvrepm') await onTestiReviewModal(interaction, arg);
      else if (action === 'rbmodal') await onRekberModal(interaction, arg);
      else if (action === 'gpmodal') await onGamepassModal(interaction, arg);
      else if (action === 'gfmodal') await onGiftModal(interaction, arg);
      else if (action === 'gfcalcm') await onGiftCalcModal(interaction, arg);
      else if (action === 'cvmodal') await onCanvaModal(interaction, arg);
      else if (action === 'bsmodal') await onBoostModal(interaction, arg);
      else if (action === 'paymodal') await onPayModal(interaction, arg);
      else if (action === 'payrejmodal') await onPayRejectModal(interaction, arg);
      else if (action === 'gpcalcprice' || action === 'gpcalctax') await onGamepassCalcModal(interaction, arg, action === 'gpcalctax' ? 'tax' : 'price');
    }
  } catch (err) {
    console.error(`[store] error (${id}):`, err);
    const msg = { content: '❌ Terjadi kesalahan, coba lagi.', flags: EPH };
    if (interaction.deferred || interaction.replied) await interaction.followUp(msg).catch(() => {});
    else await interaction.reply(msg).catch(() => {});
  }
  return true;
}

function registerStore(c) {
  client = c;
  F.register(c);
  c.on('channelDelete', (ch) => onChannelDelete(ch).catch((e) => console.error('[store] channelDelete:', e.message)));
  c.on('threadDelete', (th) => onChannelDelete(th).catch((e) => console.error('[store] threadDelete:', e.message)));
  c.once(Events.ClientReady, () => {
    housekeeping();
    setInterval(housekeeping, 30 * 1000);
    I.start();
    F.start(); // 👑 katalog Premium App di forum
    CP.start(); // 🎛️ panel admin dikirim / diperbarui otomatis
    refreshPanel();
    refreshLeaderboard();
  });
}

// Premium App memakai fungsi bersama dari file ini.
I.init({ getClient: () => client, logOrder, refreshPanel, refreshLeaderboard, getTicketCategory, createTicketChannel, editTicketMsg, testimonyTimeoutMs });
CP.init({ getClient: () => client, setProductsOpen, announce, closeIfSoldOut, reopenIfAutoClosed, refreshPanel, markPaid });

module.exports = {
  handleInteraction,
  registerStore,
  setProductsOpen,
  reopenIfAutoClosed,
  closeIfSoldOut,
  announce,
  refreshPanel,
  refreshLeaderboard,
  refreshCatalog,
  postCatalog,
  onDanaMasukCommand,
  migrateToV2,
};
