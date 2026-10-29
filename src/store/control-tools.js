const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  LabelBuilder,
  StringSelectMenuBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  AttachmentBuilder,
} = require('discord.js');
const UI = require('../ui');
const { loadConfig, isId, rupiah, num, getProduct } = require('./config');
const { state, save, hasStock, stockOf, stockUnit, planStockOf, isProductOpen, kindOf } = require('./state');
const V = require('./views');

/**
 * Alat tambahan Store Control Center:
 *  📋 Antrean Pesanan     — pembayaran menunggu verifikasi (✅ Dana Masuk langsung dari panel), Premium App butuh bantuan
 *  ⏰ Jam Operasional      — buka / tutup otomatis + pengecualian "On 24 Jam" & "Libur" (jadwal fleksibel)
 *  ⚠️ Peringatan           — ping admin saat stock / saldo Waroengkuy menipis
 *  📢 Pengumuman Cepat     — template restock / flash sale / libur / info ke channel stock
 *  📊 Laporan Penjualan    — rekap omzet, order, untung Premium App + unduh CSV
 *  🛠️ Mode Maintenance     — tutup semua sekaligus, saat selesai dibuka kembali sesuai kondisi sebelumnya
 */

const EPH = MessageFlags.Ephemeral;
const V2F = MessageFlags.IsComponentsV2;
let h = null; // helper dari control.js

const text = (c) => new TextDisplayBuilder().setContent(String(c || '​').slice(0, 4000));
const line = () => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
const brand = (cfg) => parseInt(String(cfg?.colors?.brand || '#3498DB').replace('#', ''), 16);
const rowOf = (...b) => new ActionRowBuilder().addComponents(b.filter(Boolean).slice(0, 5));
const btn = (id, label, emoji, style = ButtonStyle.Secondary, disabled = false) =>
  new ButtonBuilder().setCustomId(id).setLabel(String(label).slice(0, 80)).setEmoji(emoji).setStyle(style).setDisabled(disabled);
const tsR = (ms, s = 'R') => `<t:${Math.floor(ms / 1000)}:${s}>`;
const clip = (s, n) => {
  const c = String(s ?? '');
  return c.length > n ? `${c.slice(0, n - 1)}…` : c;
};
const sellable = (cfg) => (cfg?.products || []).filter((p) => p.type !== 'soon');
const plansOf = (p) => (p.plans || []).filter((x) => x && x.id);

/** Kotak V2 (pesan pribadi admin). */
function card(cfg, header, blocks = [], rows = [], image = null) {
  const box = UI.accent(new ContainerBuilder(), brand(cfg));
  box.addTextDisplayComponents(text(header));
  if (image) box.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(image)));
  for (const b of blocks.filter(Boolean)) {
    box.addSeparatorComponents(line());
    box.addTextDisplayComponents(text(b));
  }
  for (const r of rows.filter(Boolean)) box.addActionRowComponents(r);
  return { components: [box], flags: V2F, allowedMentions: { parse: [] } };
}

// ───────────────────────── Waktu WIB ─────────────────────────
const WIB = 7 * 3600000;
const dayStartWib = (ms = Date.now()) => {
  const d = new Date(ms + WIB);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - WIB;
};
const parseHHMM = (s) => {
  const m = String(s || '').trim().replace('.', ':').match(/^(\d{1,2}):?(\d{2})$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  return hh < 24 && mm < 60 ? `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}` : null;
};
const atToday = (hhmm, base = Date.now()) => {
  const [hh, mm] = hhmm.split(':').map(Number);
  return dayStartWib(base) + (hh * 60 + mm) * 60000;
};
/** Kejadian terakhir (≤ sekarang) & berikutnya (> sekarang) untuk jam HH:MM. */
const prevAt = (hhmm, now = Date.now()) => {
  const t = atToday(hhmm, now);
  return t <= now ? t : t - 86400000;
};
const nextAt = (hhmm, now = Date.now()) => {
  const t = atToday(hhmm, now);
  return t > now ? t : t + 86400000;
};
const wibText = (ms) => new Date(ms).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

// ═════════════════════════════ 📋 ANTREAN PESANAN ═════════════════════════════
function queueData() {
  const open = Object.values(state.tickets || {}).filter((t) => t.status === 'open');
  const pending = open.filter((t) => t.payment?.status === 'pending').sort((a, b) => (a.payment.at || 0) - (b.payment.at || 0));
  const help = open.filter((t) => kindOf(t) === 'instant' && t.ins?.stage === 'need_help');
  const process = open.filter((t) => V.isPaid(t) && !(kindOf(t) === 'instant' && t.ins?.stage === 'need_help'));
  const unpaid = open.filter((t) => !V.isPaid(t) && t.payment?.status !== 'pending');
  return { pending, help, process, unpaid };
}
const buyerOf = (t) => (kindOf(t) === 'rekber' ? t.buyerId : t.userId);
const itemOf = (t) => {
  const k = kindOf(t);
  if (k === 'instant') return `${t.ins?.product || t.productLabel} — ${t.ins?.variant || ''} ×${num(t.qty || 1)}`;
  if (k === 'rekber') return `Rekber ${rupiah(t.nominal)}`;
  if (k === 'robux' || k === 'gamepass') return `${t.productLabel} ${num(t.amount)} Robux`;
  return `${t.productLabel}${t.plan ? ` ${t.plan.label}` : ''}`;
};

function queueView(guild, cfg, notice) {
  const q = queueData();
  const ln = (t, extra = '') => `▸ \`${t.id}\` • ${clip(itemOf(t), 50)} • <@${buyerOf(t)}> • \`${rupiah(V.payAmount(t))}\`${t.channelId ? ` • <#${t.channelId}>` : ''}${extra}`;
  const blocks = [
    notice || null,
    `### 💳 Menunggu Verifikasi Pembayaran (${q.pending.length})\n${q.pending.length ? q.pending.slice(0, 10).map((t) => ln(t, ` • bukti ${tsR(t.payment.at || t.createdAt)}`)).join('\n') : '_Tidak ada — semua pembayaran sudah dicek._ ✅'}`,
    q.help.length ? `### 🛠️ Premium App Butuh Bantuan (${q.help.length})\n${q.help.slice(0, 8).map((t) => ln(t, ` • \`${t.ins?.lastError?.code || t.ins?.order?.status || '-'}\``)).join('\n')}` : null,
    q.process.length ? `### 🔄 Sudah Dibayar — Sedang Diproses (${q.process.length})\n${q.process.slice(0, 10).map((t) => ln(t, ` • ${tsR(t.payment?.paidAt || t.createdAt)}`)).join('\n')}` : null,
    q.unpaid.length ? `### ⏳ Belum Bayar (${q.unpaid.length})\n${q.unpaid.slice(0, 8).map((t) => ln(t, ` • dibuat ${tsR(t.createdAt)}`)).join('\n')}` : null,
    '-# ✅ Dana Masuk = sama seperti tombol Dana Masuk di ticket (pembeli dapat notifikasi & DM). 🔁 = kirim ulang otomatis Premium App.',
  ];
  const rows = [];
  if (q.pending.length) rows.push(rowOf(...q.pending.slice(0, 5).map((t) => btn(`store:cptpaid:${t.id}`, `Dana Masuk ${t.id}`, '✅', ButtonStyle.Success))));
  if (q.help.length) rows.push(rowOf(...q.help.slice(0, 5).map((t) => btn(`store:insretry:${t.id}`, `Kirim Ulang ${t.id}`, '🔁', ButtonStyle.Primary))));
  rows.push(rowOf(btn('store:cptq', 'Muat Ulang', '🔄')));
  return card(cfg, `## 📋 Antrean Pesanan\n-# ${V.storeName(cfg, guild)} • ${q.pending.length + q.help.length} perlu tindakan`, blocks, rows);
}

async function onPaid(interaction, ticketId) {
  const t = state.tickets[ticketId];
  const cfg = loadConfig();
  if (!t || t.status !== 'open') return interaction.update(queueView(interaction.guild, cfg, `⚠️ \`${ticketId}\` sudah ditutup.`));
  await interaction.deferUpdate();
  const ch = t.channelId ? await interaction.guild.channels.fetch(t.channelId).catch(() => null) : null;
  if (!ch) return interaction.editReply(queueView(interaction.guild, cfg, `⚠️ Channel ticket \`${ticketId}\` tidak ditemukan.`));
  const err = await h.ctx.markPaid(interaction.guild, ch, t, { by: interaction.user.id });
  if (!err) h.logAction(`✅ <@${interaction.user.id}> dana masuk \`${t.id}\` (${rupiah(V.payAmount(t))})`);
  h.refresh();
  return interaction.editReply(queueView(interaction.guild, loadConfig(), err ? `⚠️ ${err}` : `✅ Dana masuk **${t.id}** dikonfirmasi — pembeli sudah diberi tahu.`));
}

// ═════════════════════════════ ⏰ JAM OPERASIONAL ═════════════════════════════
const sched = () => {
  state.schedule = { enabled: false, open: '08:00', close: '22:00', products: null, skipNextOpen: false, skipNextClose: false, lastOpenAt: 0, lastCloseAt: 0, ...(state.schedule || {}) };
  return state.schedule;
};
/** Produk yang ikut jadwal (default: semua produk kecuali Coming Soon). */
const schedProducts = (cfg) => {
  const s = sched();
  const all = sellable(cfg);
  return Array.isArray(s.products) && s.products.length ? all.filter((p) => s.products.includes(p.id)) : all;
};

function scheduleLine(cfg) {
  const s = sched();
  if (state.maintenance?.on) return '⏰ **Jam Operasional:** `dijeda selama maintenance`';
  if (!s.enabled) return '⏰ **Jam Operasional:** `⚪ Manual` (buka / tutup sendiri)';
  const no = nextAt(s.open);
  const nc = nextAt(s.close);
  const next = no < nc ? { at: no, open: true, skip: s.skipNextOpen } : { at: nc, open: false, skip: s.skipNextClose };
  return `⏰ **Jam Operasional:** \`${s.open}–${s.close} WIB\` • berikutnya ${next.open ? '🟢 buka' : '🔴 tutup'} ${tsR(next.at)}${next.skip ? ' **(dilewati)**' : ''}${s.skipNextClose ? ' • 🌙 **On 24 Jam**' : ''}${s.skipNextOpen ? ' • 🏖️ **Libur**' : ''}`;
}

function scheduleView(guild, cfg, notice) {
  const s = sched();
  const list = schedProducts(cfg);
  const no = nextAt(s.open);
  const nc = nextAt(s.close);
  const blocks = [
    notice || null,
    [
      `**Status:** ${s.enabled ? '`🟢 AKTIF — buka / tutup otomatis`' : '`⚪ NONAKTIF — buka / tutup manual`'}${state.maintenance?.on ? ' • ⏸️ dijeda (maintenance)' : ''}`,
      `🟢 **Buka otomatis:** \`${s.open} WIB\` • berikutnya ${tsR(no)}${s.skipNextOpen ? ' **→ dilewati (Libur)**' : ''}`,
      `🔴 **Tutup otomatis:** \`${s.close} WIB\` • berikutnya ${tsR(nc)}${s.skipNextClose ? ' **→ dilewati (On 24 Jam)**' : ''}`,
      `🛍️ **Produk:** ${list.map((p) => `${p.emoji || '🛒'} ${p.label}`).join(', ') || '-'}`,
    ].join('\n'),
    [
      '### 🔀 Jadwal Fleksibel',
      '🌙 **On 24 Jam** — lewati **tutup otomatis berikutnya** (toko tetap buka sampai jadwal tutup setelahnya / kamu tutup manual).',
      '🏖️ **Libur** — **tutup sekarang** & lewati **buka otomatis berikutnya**.',
      '↩️ **Normal** — batalkan On 24 Jam / Libur.',
      '-# Buka / tutup manual dari panel tetap bisa kapan saja. Setiap buka / tutup otomatis diumumkan ke channel stock.',
    ].join('\n'),
  ];
  const opts = sellable(cfg)
    .slice(0, 25)
    .map((p) => ({ label: p.label.slice(0, 100), value: p.id, emoji: p.emoji || '🛒', default: list.some((x) => x.id === p.id) }));
  const rows = [
    rowOf(
      btn('store:cptsch:toggle', s.enabled ? 'Matikan Jadwal' : 'Aktifkan Jadwal', s.enabled ? '⏹️' : '▶️', s.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
      btn('store:cptsch:time', 'Ubah Jam', '🕗', ButtonStyle.Primary),
    ),
    rowOf(
      btn('store:cptsch:24h', s.skipNextClose ? 'On 24 Jam ✓' : 'On 24 Jam', '🌙', s.skipNextClose ? ButtonStyle.Success : ButtonStyle.Secondary, !s.enabled),
      btn('store:cptsch:off', s.skipNextOpen ? 'Libur ✓' : 'Libur', '🏖️', s.skipNextOpen ? ButtonStyle.Success : ButtonStyle.Secondary, !s.enabled),
      btn('store:cptsch:normal', 'Normal', '↩️', ButtonStyle.Secondary, !s.skipNextOpen && !s.skipNextClose),
    ),
    opts.length
      ? rowOf(new StringSelectMenuBuilder().setCustomId('store:cptschp').setPlaceholder('🛍️ Produk yang ikut jadwal...').setMinValues(1).setMaxValues(opts.length).addOptions(opts))
      : null,
  ];
  return card(cfg, `## ⏰ Jam Operasional\n-# ${V.storeName(cfg, guild)} • Semua jam dalam WIB`, blocks, rows);
}

/** Dipanggil tiap 30 detik: jalankan buka / tutup otomatis sesuai jadwal. */
async function scheduleTick(guild) {
  const s = sched();
  if (!s.enabled || !guild) return;
  const now = Date.now();
  const cfg = loadConfig();
  const by = h.ctx.getClient()?.user?.id;
  for (const kind of ['open', 'close']) {
    const due = prevAt(s[kind], now);
    const key = kind === 'open' ? 'lastOpenAt' : 'lastCloseAt';
    if (due <= (s[key] || 0) || now - due > 6 * 3600000) continue;
    s[key] = due;
    save();
    if (state.maintenance?.on) continue;
    const skipKey = kind === 'open' ? 'skipNextOpen' : 'skipNextClose';
    if (s[skipKey]) {
      s[skipKey] = false;
      save();
      h.logAction(`⏰ ${kind === 'open' ? 'Buka' : 'Tutup'} otomatis **dilewati** (${kind === 'open' ? 'Libur' : 'On 24 Jam'})`);
      h.refresh();
      continue;
    }
    const res = await h.setOpen(guild, schedProducts(cfg), kind === 'open', kind === 'close' ? `⏰ Jam operasional selesai — buka kembali **${s.open} WIB**` : null, by);
    console.log(`[control] jadwal ${kind}: ${res.replace(/\n/g, ' | ')}`);
  }
}

// ═════════════════════════════ ⚠️ PERINGATAN STOCK & SALDO ═════════════════════════════
const alertsCfg = () => {
  state.stockAlerts = { thresholds: {}, saldo: 0, flags: {}, ...(state.stockAlerts || {}) };
  return state.stockAlerts;
};
const DEFAULT_LIMIT = { robux: 500, canva: 1, boost: 1 };
const limitOf = (p) => {
  const v = alertsCfg().thresholds[p.id];
  return v == null ? DEFAULT_LIMIT[p.type] ?? 1 : Number(v) || 0;
};
const stockWatch = (cfg) => sellable(cfg).filter(hasStock).slice(0, 4);
/** Daftar yang dipantau: { key, label, value, limit, unit } */
function watchList(cfg) {
  const a = alertsCfg();
  const out = [];
  for (const p of stockWatch(cfg)) {
    // Hanya produk yang sedang dijual (buka, atau tutup otomatis karena stock habis).
    const ps = state.products?.[p.id] || {};
    if (!ps.open && !ps.autoClosed) continue;
    if (p.type === 'boost') for (const x of plansOf(p)) out.push({ key: `${p.id}:${x.id}`, label: `${p.label} (${x.label})`, value: planStockOf(p, x.id), limit: limitOf(p), unit: stockUnit(p) });
    else out.push({ key: p.id, label: p.label, value: stockOf(p), limit: limitOf(p), unit: stockUnit(p) });
  }
  const w = h.getWrk();
  if (sellable(cfg).some((p) => p.type === 'instant') && w.ok && Number(a.saldo) > 0) out.push({ key: 'saldo', label: 'Saldo Waroengkuy', value: w.balance, limit: Number(a.saldo), unit: 'rupiah' });
  return out;
}
const fmtVal = (x) => (x.unit === 'rupiah' ? rupiah(x.value) : `${num(x.value)} ${x.unit}`);
const fmtLim = (x) => (x.unit === 'rupiah' ? rupiah(x.limit) : `${num(x.limit)} ${x.unit}`);

function alertsView(guild, cfg, notice) {
  const a = alertsCfg();
  const list = watchList(cfg);
  const lines = list.map((x) => `${x.limit > 0 && x.value <= x.limit ? '🔴' : '🟢'} **${x.label}:** \`${fmtVal(x)}\` • batas \`${x.limit > 0 ? fmtLim(x) : 'nonaktif'}\``);
  for (const p of stockWatch(cfg)) {
    const ps = state.products?.[p.id] || {};
    if (!ps.open && !ps.autoClosed) lines.push(`⚪ **${p.label}:** \`${num(stockOf(p))} ${stockUnit(p)}\` • batas \`${limitOf(p) > 0 ? `${num(limitOf(p))} ${stockUnit(p)}` : 'nonaktif'}\` • _tutup, tidak dipantau_`);
  }
  const instOn = sellable(cfg).some((p) => p.type === 'instant');
  if (instOn && !(Number(a.saldo) > 0)) lines.push('⚪ **Saldo Waroengkuy:** peringatan `nonaktif`');
  const ch = alertChannelId(cfg);
  return card(
    cfg,
    `## ⚠️ Peringatan Stock & Saldo\n-# ${V.storeName(cfg, guild)} • Admin di-ping saat stock / saldo menyentuh batas`,
    [
      notice || null,
      lines.join('\n') || '_Belum ada produk ber-stock._',
      `🔔 **Dikirim ke:** ${ch ? `<#${ch}>` : 'channel panel ini'}${isId(alertRoleOf(cfg)) ? ` • ping <@&${alertRoleOf(cfg)}>` : ''}\n-# Hanya produk yang sedang dijual (buka / tutup otomatis karena habis). Dicek tiap 2 menit. Peringatan dikirim **sekali** saat menyentuh batas, lalu aktif lagi setelah stock diisi di atas batas. Isi \`0\` untuk menonaktifkan.`,
    ],
    [rowOf(btn('store:cptalert:edit', 'Ubah Batas', '✏️', ButtonStyle.Primary), btn('store:cptalert:test', 'Kirim Tes', '🔔'), btn('store:cptalert:view', 'Muat Ulang', '🔄'))],
  );
}
function alertsModal(cfg) {
  const a = alertsCfg();
  const m = new ModalBuilder().setCustomId('store:cptalertm').setTitle('Batas Peringatan');
  const labels = stockWatch(cfg).map((p) =>
    new LabelBuilder()
      .setLabel(`${p.label} (${stockUnit(p)}${p.type === 'boost' ? ' / paket' : ''})`.slice(0, 45))
      .setDescription(`Peringatan kalau stock ≤ angka ini. 0 = nonaktif. Sekarang: ${num(stockOf(p))}`.slice(0, 100))
      .setTextInputComponent(new TextInputBuilder().setCustomId(`t_${p.id}`).setStyle(TextInputStyle.Short).setMaxLength(10).setRequired(true).setValue(String(limitOf(p)))),
  );
  if (sellable(cfg).some((p) => p.type === 'instant')) {
    labels.push(
      new LabelBuilder()
        .setLabel('Saldo Waroengkuy minimal (Rp)')
        .setDescription('Peringatan kalau saldo ≤ angka ini (mode manual butuh saldo). 0 = nonaktif.')
        .setTextInputComponent(new TextInputBuilder().setCustomId('t_saldo').setStyle(TextInputStyle.Short).setMaxLength(12).setRequired(true).setValue(String(Number(a.saldo) || 0))),
    );
  }
  m.addLabelComponents(...labels.slice(0, 5));
  return m;
}
const instantCfg = (cfg) => (cfg?.products || []).find((p) => p.type === 'instant') || {};
const alertChannelId = (cfg) => [instantCfg(cfg).alertChannelId, cfg?.channels?.instantAlert, cfg?.channels?.alert].find(isId) || null;
const alertRoleOf = (cfg) => instantCfg(cfg).alertRoleId || cfg?.alertRoleId || null;

async function sendAlert(guild, cfg, title, body) {
  const chId = alertChannelId(cfg) || state.controlPanel?.channelId;
  const ch = chId ? await guild.channels.fetch(chId).catch(() => null) : null;
  if (!ch?.isTextBased?.()) return false;
  const role = isId(alertRoleOf(cfg)) ? alertRoleOf(cfg) : null;
  const p = card(cfg, `## ⚠️ ${title}\n-# ${V.storeName(cfg, guild)} • Store Alert`, [body, `-# ${tsR(Date.now(), 'f')}`]);
  if (role) p.components.unshift(text(`<@&${role}>`));
  p.allowedMentions = { roles: role ? [role] : [] };
  await ch.send(p).catch((e) => console.warn('[control] alert:', e.message));
  return true;
}

/** Cek berkala: kirim peringatan saat stock / saldo menyentuh batas (sekali per kejadian). */
async function alertsTick(guild) {
  if (!guild) return;
  const cfg = loadConfig();
  const a = alertsCfg();
  for (const x of watchList(cfg)) {
    const low = x.limit > 0 && x.value <= x.limit;
    if (low && !a.flags[x.key]) {
      a.flags[x.key] = true;
      save();
      await sendAlert(
        guild,
        cfg,
        x.key === 'saldo' ? 'Saldo Waroengkuy Menipis' : `Stock ${x.label} Menipis`,
        `${x.value <= 0 ? '🔴 **HABIS!**' : '🟠 **Hampir habis!**'} **${x.label}** sekarang tinggal \`${fmtVal(x)}\` (batas \`${fmtLim(x)}\`).\n${x.key === 'saldo' ? 'Isi saldo di panel reseller Waroengkuy supaya pesanan tetap terkirim otomatis.' : 'Isi stock lewat **🎛️ Store Control Center → Kelola produk → Atur / Tambah Stock**.'}`,
      );
    } else if (!low && a.flags[x.key]) {
      a.flags[x.key] = false;
      save();
    }
  }
}

// ═════════════════════════════ 📢 PENGUMUMAN CEPAT ═════════════════════════════
const TEMPLATES = {
  restock: { label: 'Restock', emoji: '📦', title: '📦 RESTOCK! Stock Baru Sudah Masuk', body: 'Stock sudah **diisi ulang**! 🎉\nYuk langsung order sebelum kehabisan — **siapa cepat dia dapat!** 🔥' },
  flash: { label: 'Flash Sale / Promo', emoji: '🔥', title: '🔥 FLASH SALE — Harga Spesial!', body: 'Harga spesial untuk **[produk]** cuma **Rp [harga]**! 😱\n⏰ Berlaku sampai **[jam] WIB** atau selama stock masih ada.' },
  libur: { label: 'Info Libur', emoji: '🏖️', title: '🏖️ Info Libur Noname Store', body: 'Hari ini **Noname Store libur** dulu ya 🙏\nPesanan yang sudah masuk tetap diproses. Kami buka kembali **[hari / jam]**. Terima kasih! 💙' },
  info: { label: 'Info Umum', emoji: '📢', title: '📢 Info Noname Store', body: '' },
};
function announceView(guild, cfg, notice) {
  return card(
    cfg,
    `## 📢 Pengumuman Cepat\n-# ${V.storeName(cfg, guild)} • Dikirim ke channel stock${isId(cfg?.channels?.stock) ? ` (<#${cfg.channels.stock}>)` : ''}`,
    [notice || null, 'Pilih template di bawah → teks bisa diedit sebelum dikirim. Bisa pakai gambar (link) & mention @everyone.'],
    [
      rowOf(
        new StringSelectMenuBuilder()
          .setCustomId('store:cptannsel')
          .setPlaceholder('📢 Pilih template pengumuman...')
          .addOptions(Object.entries(TEMPLATES).map(([id, t]) => ({ label: t.label, value: id, emoji: t.emoji, description: clip(t.title, 100) }))),
      ),
    ],
  );
}
function announceModal(id) {
  const t = TEMPLATES[id] || TEMPLATES.info;
  const ti = (cid, style, max, value, required = true, placeholder) => {
    const x = new TextInputBuilder().setCustomId(cid).setStyle(style).setMaxLength(max).setRequired(required);
    if (value) x.setValue(value);
    if (placeholder) x.setPlaceholder(placeholder);
    return x;
  };
  return new ModalBuilder()
    .setCustomId(`store:cptannm:${id}`)
    .setTitle(`Pengumuman: ${t.label}`.slice(0, 45))
    .addLabelComponents(
      new LabelBuilder().setLabel('Judul').setTextInputComponent(ti('title', TextInputStyle.Short, 120, t.title)),
      new LabelBuilder().setLabel('Isi Pengumuman').setDescription('Ganti bagian [ ... ] sesuai info kamu. Mendukung **bold** & emoji.').setTextInputComponent(ti('body', TextInputStyle.Paragraph, 1800, t.body)),
      new LabelBuilder().setLabel('Gambar (opsional)').setDescription('Link gambar https (banner promo, dll).').setTextInputComponent(ti('image', TextInputStyle.Short, 400, '', false, 'https://...')),
      new LabelBuilder()
        .setLabel('Mention @everyone?')
        .setStringSelectMenuComponent(
          new StringSelectMenuBuilder()
            .setCustomId('ping')
            .setRequired(true)
            .addOptions({ label: 'Tidak', value: 'no', emoji: '🔕', default: true }, { label: 'Ya, mention @everyone', value: 'yes', emoji: '🔔' }),
        ),
    );
}
async function sendAnnouncement(interaction, id) {
  const cfg = loadConfig();
  const guild = interaction.guild;
  const get = (k) => {
    try {
      return interaction.fields.getTextInputValue(k).trim();
    } catch {
      return '';
    }
  };
  let ping = false;
  try {
    ping = interaction.fields.getStringSelectValues('ping')?.[0] === 'yes';
  } catch {}
  const title = get('title') || TEMPLATES[id]?.title || '📢 Info';
  const body = get('body');
  const image = /^https?:\/\/\S+$/i.test(get('image')) ? get('image') : null;
  if (!isId(cfg?.channels?.stock)) return interaction.editReply(announceView(guild, cfg, '❌ `channels.stock` belum diisi di store.json.'));
  const ch = await guild.channels.fetch(cfg.channels.stock).catch(() => null);
  if (!ch?.isTextBased?.()) return interaction.editReply(announceView(guild, cfg, '❌ Channel stock tidak ditemukan.'));
  const name = V.storeName(cfg, guild);
  const url = V.panelUrlFor(guild, 'main');
  const p = card(cfg, `# ${title}\n-# ${name} • Pengumuman`, [body || null, `-# ${name} • ${tsR(Date.now(), 'f')}`], [url ? rowOf(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(url).setLabel('Order Sekarang').setEmoji('🛒')) : null], image);
  if (ping) {
    p.components.unshift(text('@everyone'));
    p.allowedMentions = { parse: ['everyone'] };
  }
  const msg = await ch.send(p).catch((e) => ({ error: e.message }));
  if (msg?.error) return interaction.editReply(announceView(guild, cfg, `❌ Gagal mengirim: ${msg.error}`));
  h.logAction(`📢 <@${interaction.user.id}> mengirim pengumuman **${clip(title, 50)}**`);
  h.refresh();
  return interaction.editReply(announceView(guild, cfg, `✅ Pengumuman terkirim ke ${ch}${ping ? ' dengan @everyone' : ''} — [lihat pesan](${msg.url}).`));
}

// ═════════════════════════════ 📊 LAPORAN PENJUALAN ═════════════════════════════
const PERIODS = { today: 'Hari Ini', '7d': '7 Hari', '30d': '30 Hari', month: 'Bulan Ini' };
function periodRange(id) {
  const now = Date.now();
  if (id === '7d') return [dayStartWib(now) - 6 * 86400000, now];
  if (id === '30d') return [dayStartWib(now) - 29 * 86400000, now];
  if (id === 'month') {
    const d = new Date(now + WIB);
    return [Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - WIB, now];
  }
  return [dayStartWib(now), now];
}
function reportData(cfg, id) {
  const [from, to] = periodRange(id);
  const all = Object.values(state.tickets || {}).filter((t) => (t.closedAt || 0) >= from && (t.closedAt || 0) <= to);
  const done = all.filter((t) => t.status === 'completed');
  const sales = done.filter((t) => kindOf(t) !== 'rekber');
  const rekber = done.filter((t) => kindOf(t) === 'rekber');
  const per = new Map();
  for (const t of sales) {
    const p = getProduct(cfg, t.productId);
    const key = t.productId || kindOf(t);
    const x = per.get(key) || { label: p?.label || t.productLabel || key, emoji: p?.emoji || '🛒', orders: 0, revenue: 0, robux: 0 };
    x.orders += 1;
    x.revenue += Number(t.price) || 0;
    x.robux += Number(t.amount) || 0;
    per.set(key, x);
  }
  const inst = sales.filter((t) => kindOf(t) === 'instant' && t.ins);
  const instCost = inst.reduce((a, t) => a + (Number(t.ins.unitCost) || 0) * (Number(t.ins.qty) || 1), 0);
  const instRev = inst.reduce((a, t) => a + (Number(t.price) || 0), 0);
  const items = new Map();
  for (const t of inst) {
    const k = `${t.ins.product} — ${t.ins.variant}`;
    const x = items.get(k) || { n: 0, qty: 0, revenue: 0 };
    x.n += 1;
    x.qty += Number(t.ins.qty) || 1;
    x.revenue += Number(t.price) || 0;
    items.set(k, x);
  }
  const buyers = new Map();
  for (const t of sales) buyers.set(t.userId, (buyers.get(t.userId) || 0) + (Number(t.price) || 0));
  const revenue = sales.reduce((a, t) => a + (Number(t.price) || 0), 0);
  const rated = done.filter((t) => t.testimony?.rating);
  return {
    from,
    to,
    done,
    sales,
    revenue,
    per: [...per.values()].sort((a, b) => b.revenue - a.revenue),
    rekber: { n: rekber.length, volume: rekber.reduce((a, t) => a + (Number(t.nominal) || 0), 0), fee: rekber.reduce((a, t) => a + (Number(t.fee) || 0), 0) },
    inst: { n: inst.length, revenue: instRev, cost: instCost, profit: instRev - instCost, top: [...items.entries()].sort((a, b) => b[1].qty - a[1].qty).slice(0, 5) },
    cancelled: all.filter((t) => t.status === 'cancelled').length,
    refund: all.filter((t) => t.status === 'refund').length,
    topBuyers: [...buyers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3),
    rating: rated.length ? rated.reduce((a, t) => a + t.testimony.rating, 0) / rated.length : null,
    ratedN: rated.length,
  };
}
function reportView(guild, cfg, id = 'today') {
  const r = reportData(cfg, id);
  const medals = ['🥇', '🥈', '🥉'];
  const blocks = [
    [
      `## 💰 ${rupiah(r.revenue)}`,
      `🧾 **Order Selesai:** \`${num(r.sales.length)}\` • 📈 **Rata-rata / Order:** \`${rupiah(r.sales.length ? r.revenue / r.sales.length : 0)}\``,
      `❌ **Dibatalkan:** \`${num(r.cancelled)}\` • 💸 **Refund:** \`${num(r.refund)}\`${r.rating != null ? ` • ⭐ **Rating:** \`${r.rating.toFixed(1)} / 5\` (${num(r.ratedN)})` : ''}`,
    ].join('\n'),
    r.per.length ? `### 🛍️ Per Produk\n${r.per.map((x) => `${x.emoji} **${x.label}** — \`${num(x.orders)} order\` • \`${rupiah(x.revenue)}\`${x.robux ? ` • ${num(x.robux)} Robux` : ''}`).join('\n')}` : '### 🛍️ Per Produk\n_Belum ada penjualan di periode ini._',
    r.inst.n
      ? [
          '### 👑 Premium App',
          `**Omzet:** \`${rupiah(r.inst.revenue)}\` • **Modal:** \`${rupiah(r.inst.cost)}\` • **Untung:** \`${rupiah(r.inst.profit)}\` (${r.inst.revenue ? Math.round((r.inst.profit / r.inst.revenue) * 100) : 0}%)`,
          ...r.inst.top.map(([k, v], i) => `${['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'][i]} ${clip(k, 50)} — \`${num(v.qty)} akun\` • \`${rupiah(v.revenue)}\``),
        ].join('\n')
      : null,
    r.rekber.n ? `### 🤝 Rekber\n\`${num(r.rekber.n)} transaksi\` • dana \`${rupiah(r.rekber.volume)}\` • fee \`${rupiah(r.rekber.fee)}\`` : null,
    r.topBuyers.length ? `### 🏆 Pembeli Teratas\n${r.topBuyers.map(([u, v], i) => `${medals[i]} <@${u}> — \`${rupiah(v)}\``).join('\n')}` : null,
    `-# Periode: ${wibText(r.from)} – ${wibText(r.to)} WIB • dari order berstatus Completed`,
  ];
  const rows = [
    rowOf(...Object.entries(PERIODS).map(([k, label]) => btn(`store:cptrep:${k}`, label, k === id ? '📍' : '📅', k === id ? ButtonStyle.Primary : ButtonStyle.Secondary, k === id))),
    rowOf(btn(`store:cptcsv:${id}`, 'Unduh CSV', '⬇️')),
  ];
  return card(cfg, `## 📊 Laporan Penjualan — ${PERIODS[id]}\n-# ${V.storeName(cfg, guild)}`, blocks, rows);
}
function reportCsv(cfg, id) {
  const r = reportData(cfg, id);
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['ID', 'Selesai (WIB)', 'Produk', 'Item', 'Jumlah', 'Total (Rp)', 'Modal (Rp)', 'Untung (Rp)', 'Pembeli (ID Discord)', 'Rating'];
  const rows = r.done.map((t) => {
    const inst = kindOf(t) === 'instant' && t.ins;
    const cost = inst ? (Number(t.ins.unitCost) || 0) * (Number(t.ins.qty) || 1) : '';
    const total = kindOf(t) === 'rekber' ? Number(t.nominal) || 0 : Number(t.price) || 0;
    return [t.id, wibText(t.closedAt), getProduct(cfg, t.productId)?.label || t.productLabel || kindOf(t), itemOf(t), inst ? t.ins.qty : kindOf(t) === 'robux' || kindOf(t) === 'gamepass' ? t.amount : t.qty || 1, total, cost, inst ? total - cost : '', buyerOf(t), t.testimony?.rating || ''];
  });
  return `﻿${[head, ...rows].map((x) => x.map(esc).join(',')).join('\n')}\n`;
}

// ═════════════════════════════ 🛠️ MODE MAINTENANCE ═════════════════════════════
const maintenanceLine = () =>
  state.maintenance?.on ? `🛠️ **MODE MAINTENANCE AKTIF** sejak ${tsR(state.maintenance.since)} oleh <@${state.maintenance.by}>${state.maintenance.reason ? ` — ${clip(state.maintenance.reason, 80)}` : ''}` : null;

function maintenanceModal() {
  return new ModalBuilder()
    .setCustomId('store:cptmtm')
    .setTitle('Aktifkan Mode Maintenance')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('Keterangan (tampil di pengumuman)')
        .setDescription('Semua produk ditutup. Saat selesai, dibuka kembali sesuai kondisi sebelumnya.')
        .setTextInputComponent(new TextInputBuilder().setCustomId('reason').setStyle(TextInputStyle.Paragraph).setMaxLength(300).setRequired(false).setPlaceholder('contoh: Maintenance sistem, estimasi selesai 30 menit 🙏')),
    );
}
async function maintenanceOn(interaction) {
  const cfg = loadConfig();
  let reason = '';
  try {
    reason = interaction.fields.getTextInputValue('reason').trim();
  } catch {}
  const list = sellable(cfg);
  const prev = list.filter((p) => isProductOpen(p) || state.products?.[p.id]?.open).map((p) => p.id);
  state.maintenance = { on: true, since: Date.now(), by: interaction.user.id, prev, reason: reason || null };
  save();
  const res = await h.setOpen(interaction.guild, list, false, `🛠️ **Sedang maintenance**${reason ? ` — ${reason}` : ''}`, interaction.user.id);
  h.logAction(`🛠️ <@${interaction.user.id}> mengaktifkan **maintenance**`);
  h.refresh();
  return `🛠️ **Mode maintenance aktif.**\n${res}\n-# ${prev.length} produk akan dibuka kembali saat maintenance selesai.`;
}
async function maintenanceOff(interaction) {
  const cfg = loadConfig();
  const m = state.maintenance || {};
  const list = sellable(cfg).filter((p) => (m.prev || []).includes(p.id));
  state.maintenance = { on: false, endedAt: Date.now() };
  save();
  const res = list.length ? await h.setOpen(interaction.guild, list, true, null, interaction.user.id) : 'ℹ️ Tidak ada produk yang perlu dibuka kembali.';
  h.logAction(`✅ <@${interaction.user.id}> mengakhiri **maintenance**`);
  h.refresh();
  return `✅ **Maintenance selesai.**\n${res}`;
}

// ═════════════════════════════ Ringkasan untuk panel utama ═════════════════════════════
function panelLines(cfg) {
  const q = queueData();
  return [
    maintenanceLine(),
    scheduleLine(cfg),
    q.pending.length || q.help.length
      ? `📋 **Perlu tindakan:** ${q.pending.length ? `\`${q.pending.length} pembayaran menunggu verifikasi\`` : ''}${q.pending.length && q.help.length ? ' • ' : ''}${q.help.length ? `\`${q.help.length} Premium App butuh bantuan\`` : ''} → klik **📋 Antrean**`
      : '📋 **Antrean:** `tidak ada yang menunggu` ✅',
  ].filter(Boolean);
}
const queueCount = () => {
  const q = queueData();
  return q.pending.length + q.help.length;
};

// ═════════════════════════════ Router ═════════════════════════════
const ACTIONS = ['cptq', 'cptpaid', 'cptsch', 'cptschp', 'cptschm', 'cptalert', 'cptalertm', 'cptann', 'cptannsel', 'cptannm', 'cptrep', 'cptcsv', 'cptmt', 'cptmtm'];

async function handle(interaction, action, arg) {
  const cfg = loadConfig();
  const guild = interaction.guild;
  const by = interaction.user.id;
  const fromPanel = interaction.message && interaction.message.id === state.controlPanel?.messageId;
  /** Dari panel utama → balasan pribadi baru; dari pesan pribadi → perbarui pesan itu. */
  const show = (payload) => (fromPanel || !interaction.message ? interaction.reply({ ...payload, flags: V2F | EPH }) : interaction.update(payload));

  if (action === 'cptq') return show(queueView(guild, cfg));
  if (action === 'cptpaid') return onPaid(interaction, arg);

  if (action === 'cptsch') {
    const s = sched();
    if (!arg) return show(scheduleView(guild, cfg));
    if (arg === 'time') {
      return interaction.showModal(
        new ModalBuilder()
          .setCustomId('store:cptschm')
          .setTitle('Ubah Jam Operasional (WIB)')
          .addLabelComponents(
            new LabelBuilder().setLabel('Jam Buka').setDescription('Format 24 jam, contoh 08:00').setTextInputComponent(new TextInputBuilder().setCustomId('open').setStyle(TextInputStyle.Short).setMaxLength(5).setRequired(true).setValue(s.open)),
            new LabelBuilder().setLabel('Jam Tutup').setDescription('Contoh 22:00 (boleh lewat tengah malam, misal 02:00)').setTextInputComponent(new TextInputBuilder().setCustomId('close').setStyle(TextInputStyle.Short).setMaxLength(5).setRequired(true).setValue(s.close)),
          ),
      );
    }
    let notice = null;
    if (arg === 'toggle') {
      s.enabled = !s.enabled;
      // Mulai menghitung dari sekarang supaya jadwal yang sudah lewat hari ini tidak langsung dijalankan.
      if (s.enabled) s.lastOpenAt = s.lastCloseAt = Date.now();
      s.skipNextOpen = s.skipNextClose = false;
      notice = s.enabled ? `▶️ Jadwal **aktif** — buka \`${s.open}\` & tutup \`${s.close}\` WIB setiap hari.` : '⏹️ Jadwal **dimatikan** — buka / tutup kembali manual.';
      h.logAction(`⏰ <@${by}> ${s.enabled ? 'mengaktifkan' : 'mematikan'} jam operasional`);
    } else if (arg === '24h') {
      s.skipNextClose = !s.skipNextClose;
      if (s.skipNextClose) s.skipNextOpen = false;
      notice = s.skipNextClose ? `🌙 **On 24 Jam** — tutup otomatis ${tsR(nextAt(s.close))} dilewati.` : '↩️ On 24 Jam dibatalkan.';
      h.logAction(`🌙 <@${by}> ${s.skipNextClose ? 'mengaktifkan' : 'membatalkan'} **On 24 Jam**`);
    } else if (arg === 'off') {
      if (!s.skipNextOpen) {
        s.skipNextOpen = true;
        s.skipNextClose = false;
        await interaction.deferUpdate();
        save();
        const res = await h.setOpen(guild, schedProducts(cfg), false, '🏖️ **Hari ini libur dulu ya** — terima kasih atas pengertiannya 🙏', by);
        h.logAction(`🏖️ <@${by}> mengaktifkan **Libur**`);
        h.refresh();
        return interaction.editReply(scheduleView(guild, loadConfig(), `🏖️ **Libur aktif** — buka otomatis ${tsR(nextAt(s.open))} dilewati.\n${res}`));
      }
      s.skipNextOpen = false;
      notice = '↩️ Libur dibatalkan — buka otomatis berjalan normal.';
    } else if (arg === 'normal') {
      s.skipNextOpen = s.skipNextClose = false;
      notice = '↩️ Jadwal kembali **normal**.';
    }
    save();
    h.refresh();
    return interaction.update(scheduleView(guild, cfg, notice));
  }
  if (action === 'cptschp') {
    const s = sched();
    const all = sellable(cfg).map((p) => p.id);
    s.products = interaction.values.length >= all.length ? null : interaction.values;
    save();
    h.refresh();
    return interaction.update(scheduleView(guild, cfg, '🛍️ Produk jadwal diperbarui.'));
  }
  if (action === 'cptschm') {
    const s = sched();
    const o = parseHHMM(interaction.fields.getTextInputValue('open'));
    const c = parseHHMM(interaction.fields.getTextInputValue('close'));
    if (!o || !c || o === c) return interaction.isFromMessage?.() ? interaction.update(scheduleView(guild, cfg, '❌ Format jam salah / jam buka & tutup sama. Contoh: `08:00` dan `22:00`.')) : interaction.reply({ content: '❌ Format jam salah.', flags: EPH });
    s.open = o;
    s.close = c;
    s.lastOpenAt = s.lastCloseAt = Date.now();
    save();
    h.logAction(`🕗 <@${by}> jam operasional → \`${o}–${c} WIB\``);
    h.refresh();
    return interaction.update(scheduleView(guild, cfg, `🕗 Jam operasional sekarang **${o}–${c} WIB**.`));
  }

  if (action === 'cptalert') {
    if (!arg || arg === 'view') return arg ? interaction.update(alertsView(guild, cfg)) : show(alertsView(guild, cfg));
    if (arg === 'edit') return interaction.showModal(alertsModal(cfg));
    if (arg === 'test') {
      const ok = await sendAlert(guild, cfg, 'Tes Peringatan', '🔔 Ini **pesan tes** dari Store Control Center. Peringatan stock / saldo akan muncul seperti ini.');
      return interaction.update(alertsView(guild, cfg, ok ? '🔔 Pesan tes terkirim.' : '❌ Channel peringatan tidak ditemukan.'));
    }
  }
  if (action === 'cptalertm') {
    const a = alertsCfg();
    const bad = [];
    for (const p of stockWatch(cfg)) {
      const v = Number(String(interaction.fields.getTextInputValue(`t_${p.id}`) || '').replace(/[^\d]/g, ''));
      if (!Number.isFinite(v)) bad.push(p.label);
      else {
        a.thresholds[p.id] = v;
        for (const k of Object.keys(a.flags)) if (k === p.id || k.startsWith(`${p.id}:`)) a.flags[k] = false;
      }
    }
    if (sellable(cfg).some((p) => p.type === 'instant')) {
      try {
        a.saldo = Number(String(interaction.fields.getTextInputValue('t_saldo') || '').replace(/[^\d]/g, '')) || 0;
        a.flags.saldo = false;
      } catch {}
    }
    save();
    h.logAction(`⚠️ <@${by}> mengubah batas peringatan stock / saldo`);
    alertsTick(guild).catch(() => {});
    return interaction.update(alertsView(guild, cfg, bad.length ? `⚠️ Tidak valid: ${bad.join(', ')}` : '✅ Batas peringatan disimpan.'));
  }

  if (action === 'cptann') return show(announceView(guild, cfg));
  if (action === 'cptannsel') return interaction.showModal(announceModal(interaction.values[0]));
  if (action === 'cptannm') {
    await interaction.deferUpdate();
    return sendAnnouncement(interaction, arg);
  }

  if (action === 'cptrep') return show(reportView(guild, cfg, PERIODS[arg] ? arg : 'today'));
  if (action === 'cptcsv') {
    const id = PERIODS[arg] ? arg : 'today';
    const file = new AttachmentBuilder(Buffer.from(reportCsv(cfg, id), 'utf8'), { name: `laporan-${id}-${new Date(Date.now() + WIB).toISOString().slice(0, 10)}.csv` });
    return interaction.reply({ content: `⬇️ Laporan **${PERIODS[id]}** (bisa dibuka di Excel / Google Sheets).`, files: [file], flags: EPH });
  }

  if (action === 'cptmt') {
    if (!state.maintenance?.on) return interaction.showModal(maintenanceModal());
    await interaction.deferReply({ flags: EPH });
    return interaction.editReply({ content: await maintenanceOff(interaction) });
  }
  if (action === 'cptmtm') {
    await interaction.deferReply({ flags: EPH });
    return interaction.editReply({ content: await maintenanceOn(interaction) });
  }
  return null;
}

function init(helpers) {
  h = helpers;
}

module.exports = { init, handle, ACTIONS, panelLines, queueCount, scheduleTick, alertsTick, reportCsv, reportData };
