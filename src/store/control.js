const fs = require('fs');
const path = require('path');
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
  SectionBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  MessageFlags,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
} = require('discord.js');
const UI = require('../ui');
const { loadConfig, isId, rupiah, num, getProduct } = require('./config');
const { state, save, productState, hasStock, stockOf, setStock, stockUnit, planStockOf, setPlanStock, isProductOpen } = require('./state');
const V = require('./views');
const W = require('./waroengkuy');
const T = require('./control-tools');

/**
 * 🎛️ Store Control Center — panel admin (tanpa command) untuk mengatur seluruh Noname Store:
 * buka / tutup produk sekali klik (otomatis diumumkan ke channel stock), atur stock, harga / rate,
 * harga paket (Canva Pro, Server Boost). Premium App hanya buka / tutup (harga & stock dari Waroeng).
 * Channel: store.json → channels.controlPanel. Panel dikirim otomatis saat bot menyala & ter-update otomatis.
 */

const STORE_FILE = path.join(__dirname, '..', '..', 'store.json');
const DEFAULT_CHANNEL = '1565263344250912868';
const EPH = MessageFlags.Ephemeral;
const V2F = MessageFlags.IsComponentsV2;
let ctx = null; // fungsi dari flow.js

const isAdmin = (m) => m?.permissions?.has(PermissionFlagsBits.Administrator);
const text = (c) => new TextDisplayBuilder().setContent(String(c || '​').slice(0, 4000));
const line = () => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
const brand = (cfg) => parseInt(String(cfg?.colors?.brand || '#3498DB').replace('#', ''), 16);
const rowOf = (...b) => new ActionRowBuilder().addComponents(b.filter(Boolean).slice(0, 5));
const btn = (id, label, emoji, style = ButtonStyle.Secondary, disabled = false) =>
  new ButtonBuilder().setCustomId(id).setLabel(label.slice(0, 80)).setEmoji(emoji).setStyle(style).setDisabled(disabled);
const channelOfCfg = (cfg) => [cfg?.channels?.controlPanel, DEFAULT_CHANNEL].find(isId);
const sellable = (cfg) => (cfg?.products || []).filter((p) => p.type !== 'soon');
const plansOf = (p) => (p.plans || []).filter((x) => x && x.id);
const parseNum = (raw) => {
  const n = Number(String(raw ?? '').replace(/[^\d-]/g, ''));
  return Number.isFinite(n) ? n : NaN;
};
const wib = () => {
  const d = new Date(Date.now() + 7 * 3600000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - 7 * 3600000;
};

// ───────────────────────── Ringkasan per produk ─────────────────────────
function priceText(cfg, p) {
  if (p.type === 'robux' || p.type === 'gamepass') return `\`${rupiah(V.rateOf(cfg, p))} / Robux\``;
  if (p.type === 'canva' || p.type === 'boost') return plansOf(p).map((x) => `${x.label} \`${rupiah(x.price)}\``).join(' • ') || '`-`';
  if (p.type === 'rekber') {
    const fees = (p.feeTiers || []).map((x) => (x.percent != null ? null : Number(x.fee))).filter((x) => x != null);
    return `Fee mulai \`${fees.length ? rupiah(Math.min(...fees)) : '-'}\``;
  }
  if (p.type === 'instant') {
    const s = require('./instant').summaryOf(p);
    return s.min ? `Mulai \`${rupiah(s.min)}\` • diatur Waroeng` : '`Diatur Waroeng`';
  }
  return '`-`';
}
function stockText(p) {
  if (p.type === 'boost') return plansOf(p).map((x) => `${x.label} \`${num(planStockOf(p, x.id))}\``).join(' • ');
  if (hasStock(p)) return `\`${num(stockOf(p))} ${stockUnit(p)}\``;
  if (p.type === 'instant') {
    const s = require('./instant').summaryOf(p);
    return `\`${num(s.products)} produk • ${num(s.variants)} varian\``;
  }
  return null;
}
const statusDot = (p) => {
  const ps = productState(p.id);
  if (isProductOpen(p)) return '🟢';
  if (ps.open && hasStock(p) && stockOf(p) <= 0) return '🟠'; // buka tapi stock habis
  return '🔴';
};
const statusWord = (p) => {
  const ps = productState(p.id);
  if (isProductOpen(p)) return '`🟢 BUKA`';
  if (ps.open && hasStock(p) && stockOf(p) <= 0) return '`🟠 STOCK HABIS`';
  return ps.autoClosed ? '`🔴 TUTUP (stock habis)`' : '`🔴 TUTUP`';
};

// Saldo & status API Waroeng (panel ini private admin) — cache 2 menit.
let wrk = { at: 0, ok: null, balance: null, code: null };
async function refreshWrk() {
  if (!W.hasKey()) return (wrk = { at: Date.now(), ok: false, balance: null, code: 'no_api_key' });
  if (Date.now() - wrk.at < 2 * 60 * 1000) return wrk;
  try {
    const r = await W.getBalance();
    wrk = { at: Date.now(), ok: true, balance: Number(r?.reseller?.balance) || 0, code: null };
  } catch (e) {
    wrk = { at: Date.now(), ok: false, balance: null, code: e.code || 'error' };
  }
  return wrk;
}

function logAction(text_) {
  state.controlLog = [{ at: Date.now(), text: text_ }, ...(state.controlLog || [])].slice(0, 6);
  save();
}

// ───────────────────────── Panel utama ─────────────────────────
function buildPanel(guild, cfg) {
  const name = V.storeName(cfg, guild);
  const list = sellable(cfg);
  const open = list.filter((p) => isProductOpen(p)).length;
  const tickets = Object.values(state.tickets || {});
  const from = wib();
  const today = tickets.filter((t) => t.status === 'completed' && t.closedAt >= from);
  const header = `# 🎛️ Store Control Center\n-# ${name} • Panel Admin — atur toko tanpa command`;
  const icon = guild.iconURL({ extension: 'png', size: 256 });

  const overall = open === list.length ? '🟢 **Semua produk BUKA**' : open === 0 ? '🔴 **Semua produk TUTUP**' : `🟡 **${open} dari ${list.length} produk buka**`;
  const productLines = list.map((p) => {
    const st = stockText(p);
    return `${statusDot(p)} ${p.emoji || '🛒'} **${p.label}**\n┗ ${priceText(cfg, p)}${st ? ` • 📦 ${st}` : ''}`;
  });
  const inst = list.find((p) => p.type === 'instant');
  const pendingPay = tickets.filter((t) => t.status === 'open' && t.payment?.status === 'pending').length;
  const summary = [
    '### 📊 Ringkasan Hari Ini',
    `🧾 **Order Selesai:** \`${num(today.length)}\` • 💰 **Omzet:** \`${rupiah(today.reduce((a, t) => a + (Number(t.price) || 0), 0))}\``,
    `🎫 **Ticket Berjalan:** \`${num(tickets.filter((t) => t.status === 'open').length)}\` • 💳 **Menunggu Verifikasi:** \`${num(pendingPay)}\``,
    inst
      ? wrk.ok
        ? `👑 **Waroeng:** \`🟢 Terhubung\` • 💰 **Saldo:** \`${rupiah(wrk.balance)}\` • 🛠️ **Butuh Bantuan:** \`${num(tickets.filter((t) => t.kind === 'instant' && t.status === 'open' && t.ins?.stage === 'need_help').length)}\``
        : `👑 **Waroeng:** \`🔴 ${{ no_api_key: 'API key belum diisi', unauthorized: 'API key ditolak', ip_not_allowed: 'IP VPS belum di-whitelist' }[wrk.code] || 'Tidak bisa dihubungi'}\``
      : null,
  ]
    .filter(Boolean)
    .join('\n');
  const activity = state.controlLog?.length ? `### 📜 Aktivitas Terakhir\n${state.controlLog.slice(0, 4).map((x) => `<t:${Math.floor(x.at / 1000)}:R> ┃ ${x.text}`).join('\n')}` : null;
  const mt = Boolean(state.maintenance?.on);
  const qn = T.queueCount();

  // ── Bagian informasi
  const info = [[`## ${overall}`, ...T.panelLines(cfg)].join('\n'), `### 🛍️ Status Produk\n${productLines.join('\n')}`, summary, activity];
  // Gabungan (hemat komponen, batas Discord 40 per pesan) — dipakai kalau versi lengkap tidak muat.
  const compact = [`${info[0]}\n\n${info[1]}`, summary, activity];

  // ── Bagian tombol (tiap kelompok punya judul kecil supaya rapi)
  // Tiap produk punya 2 tombol: 🟢 Buka & 🔴 Tutup. Tombol yang sesuai status sekarang berwarna.
  // Klik Buka saat produk sudah buka (atau Tutup saat sudah tutup) = kirim ulang pengumumannya.
  const pair = (p) => {
    const on = isProductOpen(p);
    return [
      btn(`store:cpopen:${p.id}`, `Buka ${p.label}`, '🟢', on ? ButtonStyle.Success : ButtonStyle.Secondary),
      btn(`store:cpclose:${p.id}`, `Tutup ${p.label}`, '🔴', on ? ButtonStyle.Secondary : ButtonStyle.Danger),
    ];
  };
  const toggleRows = [];
  const shown = list.slice(0, 10);
  const perRow = shown.length <= 6 ? 1 : 2; // 1 produk per baris (rapi); banyak produk → 2 per baris supaya muat
  for (let i = 0; i < shown.length; i += perRow) toggleRows.push(rowOf(...shown.slice(i, i + perRow).flatMap(pair)));
  const select = rowOf(
    new StringSelectMenuBuilder()
      .setCustomId('store:cpsel')
      .setPlaceholder('⚙️ Pilih produk untuk atur stock, harga & status...')
      .addOptions(
        list.slice(0, 25).map((p) => ({
          label: p.label.slice(0, 100),
          value: p.id,
          emoji: p.emoji || '🛒',
          description: `${isProductOpen(p) ? '🟢 Buka' : '🔴 Tutup'}${hasStock(p) ? ` • Stock ${num(stockOf(p))} ${stockUnit(p)}` : ''}${p.type === 'instant' ? ' • hanya buka / tutup' : ''}`.slice(0, 100),
        })),
      ),
  );
  // Semua alat admin dalam 1 baris (dropdown).
  const toolOptions = [
    { value: 'q', emoji: '📋', label: qn ? `Antrean Pesanan (${qn} menunggu)` : 'Antrean Pesanan', description: 'Verifikasi pembayaran & pesanan bermasalah' },
    { value: 'sch', emoji: '⏰', label: 'Jam Operasional', description: 'Jadwal buka / tutup otomatis, On 24 Jam, Libur' },
    { value: 'ann', emoji: '📢', label: 'Pengumuman', description: 'Restock, flash sale, info libur, info umum' },
    { value: 'rep', emoji: '📊', label: 'Laporan Penjualan', description: 'Omzet, order, untung Premium App + CSV' },
    { value: 'alert', emoji: '⚠️', label: 'Peringatan Stock & Saldo', description: 'Batas stock / saldo menipis' },
    mt || open === list.length ? null : { value: 'openall', emoji: '🟢', label: 'Buka Semua Produk', description: 'Langsung dibuka & diumumkan' },
    open === 0 ? null : { value: 'closeall', emoji: '🔴', label: 'Tutup Semua Produk', description: 'Langsung ditutup & diumumkan' },
    { value: 'reason', emoji: '📝', label: 'Tutup Semua + Alasan', description: 'Alasan ikut tampil di pengumuman' },
    { value: 'mt', emoji: '🛠️', label: mt ? 'Akhiri Maintenance' : 'Mode Maintenance', description: mt ? 'Buka kembali produk seperti sebelum maintenance' : 'Tutup semua sementara, nanti dibuka kembali otomatis' },
    { value: 'refresh', emoji: '🔄', label: 'Refresh Panel', description: 'Perbarui data panel sekarang' },
  ].filter(Boolean);
  const toolsRow = rowOf(new StringSelectMenuBuilder().setCustomId('store:cptool').setPlaceholder(qn ? `🧰 Pilih alat admin... • 📋 ${qn} pesanan menunggu` : '🧰 Pilih alat admin...').addOptions(toolOptions));
  const footer = `-# ${name} • Diperbarui <t:${Math.floor(Date.now() / 1000)}:R>`;

  /** Susun isi kotak. Discord membatasi 40 komponen per pesan → aktivitas disembunyikan kalau tidak muat. */
  const build = (withActivity, small = false) => {
    const b = UI.accent(new ContainerBuilder(), brand(cfg));
    if (icon) b.addSectionComponents(new SectionBuilder().addTextDisplayComponents(text(header)).setThumbnailAccessory(new ThumbnailBuilder().setURL(icon)));
    else b.addTextDisplayComponents(text(header));
    const blocks = small ? compact.filter((v, i) => v && (withActivity || i !== 2)) : info.filter((v, i) => v && (withActivity || i !== 3));
    for (const x of blocks) {
      b.addSeparatorComponents(line());
      b.addTextDisplayComponents(text(x));
    }
    b.addSeparatorComponents(line());
    b.addTextDisplayComponents(text('### 🔘 Buka / Tutup Cepat\n-# Tombol berwarna = status sekarang. Klik 🟢 Buka / 🔴 Tutup → langsung diumumkan ke channel stock (klik lagi = kirim ulang pengumuman).'));
    for (const r of toggleRows) b.addActionRowComponents(r);
    b.addTextDisplayComponents(text('### ⚙️ Kelola Produk'));
    b.addActionRowComponents(select);
    b.addTextDisplayComponents(text('### 🧰 Alat Admin'));
    b.addActionRowComponents(toolsRow);
    b.addSeparatorComponents(line());
    b.addTextDisplayComponents(text(footer));
    return b;
  };
  const count = (b) => {
    let n = 0;
    const walk = (c) => {
      n += 1;
      if (c.accessory) n += 1;
      (c.components || []).forEach(walk);
    };
    walk(b.toJSON());
    return n;
  };
  let built = build(true);
  if (count(built) > 40) built = build(true, true);
  if (count(built) > 40) built = build(false, true);
  return { components: [built], flags: V2F, allowedMentions: { parse: [] } };
}

// ───────────────────────── Detail satu produk (pesan pribadi admin) ─────────────────────────
function productView(guild, cfg, p, notice) {
  const ps = productState(p.id);
  const box = UI.accent(new ContainerBuilder(), brand(cfg));
  box.addTextDisplayComponents(text(`## ${p.emoji || '🛒'} ${p.label}\n-# Kelola produk • ${V.storeName(cfg, guild)}`));
  const info = [`🏪 **Status:** ${statusWord(p)}`, `💱 **Harga:** ${priceText(cfg, p)}`];
  const st = stockText(p);
  if (st) info.push(`📦 **Stock:** ${st}`);
  if (p.type === 'instant') info.push('ℹ️ Harga & stock **Premium App** diatur otomatis dari Waroeng — di sini hanya **buka / tutup**.');
  if (p.type === 'rekber') info.push('ℹ️ Fee rekber diatur di `store.json` → `feeTiers`.');
  for (const b of [notice || null, info.join('\n')].filter(Boolean)) {
    box.addSeparatorComponents(line());
    box.addTextDisplayComponents(text(b));
  }
  const open = ps.open;
  const rows = [
    rowOf(
      btn(`store:cpopen:${p.id}`, open ? 'Umumkan Buka Lagi' : 'Buka Produk', '🟢', open ? ButtonStyle.Success : ButtonStyle.Secondary),
      btn(`store:cpclose:${p.id}`, open ? 'Tutup Produk' : 'Umumkan Tutup Lagi', '🔴', open ? ButtonStyle.Secondary : ButtonStyle.Danger),
      btn(`store:cpreason:${p.id}`, open ? 'Tutup + Alasan' : 'Buka + Catatan', '📝'),
    ),
  ];
  const edit = [];
  if (hasStock(p)) edit.push(btn(`store:cpstock:${p.id}`, p.type === 'boost' ? 'Atur Stock per Paket' : 'Atur Stock', '📦', ButtonStyle.Primary));
  if (hasStock(p) && p.type !== 'boost') edit.push(btn(`store:cpadd:${p.id}`, 'Tambah Stock', '➕', ButtonStyle.Primary));
  if (p.type === 'robux' || p.type === 'gamepass') edit.push(btn(`store:cprate:${p.id}`, 'Ubah Rate', '💱', ButtonStyle.Primary));
  if (p.type === 'canva' || p.type === 'boost') edit.push(btn(`store:cpprice:${p.id}`, 'Ubah Harga Paket', '💱', ButtonStyle.Primary));
  if (edit.length) rows.push(rowOf(...edit));
  for (const r of rows) box.addActionRowComponents(r);
  return { components: [box], flags: V2F, allowedMentions: { parse: [] } };
}

// ───────────────────────── Kirim / perbarui panel ─────────────────────────
let busy = false;
let queued = false;
async function refresh() {
  if (!ctx?.getClient()) return;
  if (busy) {
    queued = true;
    return;
  }
  busy = true;
  try {
    const cfg = loadConfig();
    const chId = channelOfCfg(cfg);
    if (!cfg || !chId) return;
    const client = ctx.getClient();
    const channel = await client.channels.fetch(chId).catch(() => null);
    if (!channel?.isTextBased?.()) return;
    if (sellable(cfg).some((p) => p.type === 'instant')) await refreshWrk();
    const payload = buildPanel(channel.guild, cfg);
    const loc = state.controlPanel;
    if (loc?.messageId && loc.channelId === channel.id) {
      try {
        await channel.messages.edit(loc.messageId, payload);
        return;
      } catch (err) {
        if (err.code !== RESTJSONErrorCodes.UnknownMessage) throw err;
      }
    }
    // Belum ada / pesan dihapus → kirim panel baru otomatis.
    const msg = await channel.send(payload);
    state.controlPanel = { channelId: channel.id, messageId: msg.id };
    save();
  } catch (e) {
    console.warn('[control] panel:', e.message);
  } finally {
    busy = false;
    if (queued) {
      queued = false;
      setTimeout(refresh, 1500);
    }
  }
}

// ───────────────────────── Aksi ─────────────────────────
/** Buka / tutup produk (otomatis diumumkan ke channel stock). Return teks hasil. */
async function setOpen(guild, products, open, reason, by, force = false) {
  const notes = [];
  const again = new Set(); // produk yang statusnya sudah sama → pengumuman dikirim ulang (force)
  const changed = products.filter((p) => {
    if (open && hasStock(p) && stockOf(p) <= 0) {
      notes.push(`⚠️ **${p.label}** tidak bisa dibuka — stock masih **0**. Atur stock dulu.`);
      return false;
    }
    if (productState(p.id).open === open) {
      if (!force) return false;
      again.add(p.id);
    }
    return true;
  });
  if (changed.length) {
    await ctx.setProductsOpen(guild, changed, open, { reason: reason ? `📌 ${reason}` : undefined });
    logAction(`${open ? '🟢' : '🔴'} <@${by}> ${changed.every((p) => again.has(p.id)) ? `mengumumkan ulang ${open ? 'BUKA' : 'TUTUP'}` : open ? 'membuka' : 'menutup'} ${changed.map((p) => `**${p.label}**`).join(', ')}`);
  }
  refresh();
  const done = changed.map((p) => (again.has(p.id) ? `📢 **${p.label}** memang sudah ${open ? 'buka' : 'tutup'} — pengumuman **${open ? 'BUKA' : 'TUTUP'}** dikirim ulang` : `${open ? '🟢' : '🔴'} **${p.label}** ${open ? 'DIBUKA' : 'DITUTUP'} & diumumkan`));
  return [...done, ...notes].join('\n') || `ℹ️ Tidak ada perubahan (produk sudah ${open ? 'buka' : 'tutup'}).`;
}

/** Ubah stock (set / tambah) + pengumuman, tutup / buka otomatis seperti /store stok-set. */
async function changeStock(guild, p, planId, value, mode, by) {
  const plan = planId ? plansOf(p).find((x) => x.id === planId) : null;
  const before = plan ? planStockOf(p, plan.id) : stockOf(p);
  const after = plan ? setPlanStock(p, plan.id, mode === 'set' ? value : before + value) : setStock(p, mode === 'set' ? value : before + value);
  if (before === after) return null;
  if (p.type === 'robux') state.stockBase = after;
  save();
  const label = plan ? `${p.label} (${plan.label})` : p.label;
  ctx.refreshPanel();
  await ctx.announce(guild, 'stock', { product: p, text: `Stock **${label}** diperbarui: **${num(before)} → ${num(after)} ${stockUnit(p)}**.` });
  await ctx.closeIfSoldOut(guild, `📦 **Stock ${p.label} sudah HABIS!** ${p.label} otomatis ditutup.`, p);
  await ctx.reopenIfAutoClosed(guild, p);
  logAction(`📦 <@${by}> stock **${label}**: ${num(before)} → ${num(after)}`);
  return `📦 **${label}**: ${num(before)} → **${num(after)} ${stockUnit(p)}**`;
}

/** Umumkan perubahan harga ke channel stock (store.json → pingEveryone.price untuk @everyone). */
async function announcePrice(guild, cfg, p, changes) {
  if (!changes.length || !isId(cfg?.channels?.stock)) return false;
  await ctx.announce(guild, 'price', { product: p, changes }, Boolean(cfg.pingEveryone?.price));
  return true;
}

/** Simpan harga paket ke store.json (format file tetap rapi). */
function savePlanPrices(productId, prices) {
  const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  const prod = (raw.products || []).find((x) => x.id === productId);
  if (!prod) throw new Error('Produk tidak ditemukan di store.json');
  for (const pl of prod.plans || []) if (prices[pl.id] != null) pl.price = prices[pl.id];
  fs.writeFileSync(`${STORE_FILE}.tmp`, `${JSON.stringify(raw, null, 2)}\n`);
  fs.renameSync(`${STORE_FILE}.tmp`, STORE_FILE);
}

// ───────────────────────── Form (modal) ─────────────────────────
const input = (id, label, { value, placeholder, required = true, style = TextInputStyle.Short, max = 12, desc } = {}) => {
  const ti = new TextInputBuilder().setCustomId(id).setStyle(style).setRequired(required).setMaxLength(max);
  if (value != null && String(value) !== '') ti.setValue(String(value));
  if (placeholder) ti.setPlaceholder(placeholder);
  const l = new LabelBuilder().setLabel(label.slice(0, 45)).setTextInputComponent(ti);
  if (desc) l.setDescription(desc.slice(0, 100));
  return l;
};

function stockModal(p, mode) {
  const m = new ModalBuilder().setCustomId(`store:${mode === 'add' ? 'cpmadd' : 'cpmstock'}:${p.id}`).setTitle(`${mode === 'add' ? 'Tambah' : 'Atur'} Stock ${p.label}`.slice(0, 45));
  if (p.type === 'boost') {
    m.addLabelComponents(...plansOf(p).slice(0, 5).map((x) => input(`plan_${x.id}`, `Stock ${x.label}`, { value: planStockOf(p, x.id), desc: `Sekarang ${num(planStockOf(p, x.id))} ${stockUnit(p)}` })));
  } else if (mode === 'add') {
    m.addLabelComponents(input('value', `Tambah berapa ${stockUnit(p)}?`, { placeholder: 'contoh: 1000', desc: `Stock sekarang ${num(stockOf(p))} ${stockUnit(p)}. Isi minus untuk mengurangi.` }));
  } else {
    m.addLabelComponents(input('value', `Stock baru (${stockUnit(p)})`, { value: stockOf(p), desc: `Stock sekarang ${num(stockOf(p))} ${stockUnit(p)}` }));
  }
  return m;
}
function rateModal(cfg, p) {
  return new ModalBuilder()
    .setCustomId(`store:cpmrate:${p.id}`)
    .setTitle(`Ubah Rate ${p.label}`.slice(0, 45))
    .addLabelComponents(input('value', 'Rate baru (Rp per 1 Robux)', { value: V.rateOf(cfg, p), desc: `Sekarang ${rupiah(V.rateOf(cfg, p))} / Robux. Ticket berjalan tetap pakai rate lama.` }));
}
function priceModal(p) {
  return new ModalBuilder()
    .setCustomId(`store:cpmprice:${p.id}`)
    .setTitle(`Harga Paket ${p.label}`.slice(0, 45))
    .addLabelComponents(...plansOf(p).slice(0, 5).map((x) => input(`plan_${x.id}`, `Harga ${x.label} (Rp)`, { value: x.price, desc: `Sekarang ${rupiah(x.price)}${p.type === 'boost' ? ' per boost' : ''}` })));
}
function reasonModal(id, open) {
  return new ModalBuilder()
    .setCustomId(`store:cpmreason:${id}`)
    .setTitle(open ? 'Tutup + Alasan' : 'Buka + Catatan')
    .addLabelComponents(
      input('reason', open ? 'Alasan tutup (tampil di pengumuman)' : 'Catatan (tampil di pengumuman)', {
        placeholder: open ? 'contoh: Admin sedang istirahat, buka lagi jam 19.00' : 'contoh: Restock besar-besaran! 🔥',
        style: TextInputStyle.Paragraph,
        max: 300,
      }),
    );
}

// ───────────────────────── Router ─────────────────────────
/** Menu "Alat Admin" (1 dropdown) → aksi yang sama seperti tombol sebelumnya. */
const TOOL_MENU = {
  q: ['cptq'],
  sch: ['cptsch'],
  ann: ['cptann'],
  rep: ['cptrep'],
  alert: ['cptalert'],
  openall: ['cpall', 'open'],
  closeall: ['cpall', 'close'],
  reason: ['cpall', 'reason'],
  mt: ['cptmt'],
  refresh: ['cprefresh'],
};

async function handle(interaction, action, arg) {
  if (action === 'cptool') {
    if (!isAdmin(interaction.member)) {
      await interaction.reply({ content: '⛔ Panel ini khusus **Administrator**.', flags: EPH }).catch(() => {});
      return true;
    }
    const [a, b] = TOOL_MENU[interaction.values?.[0]] || [];
    if (!a) return true;
    await handle(interaction, a, b);
    // Kosongkan pilihan menu supaya menu yang sama bisa dipilih lagi.
    if (a !== 'cprefresh') interaction.message?.edit(buildPanel(interaction.guild, loadConfig())).catch(() => {});
    return true;
  }
  const tool = T.ACTIONS.includes(action);
  if (!tool && !['cpsel', 'cptog', 'cpopen', 'cpclose', 'cpall', 'cprefresh', 'cpstock', 'cpadd', 'cprate', 'cpprice', 'cpreason', 'cpmstock', 'cpmadd', 'cpmrate', 'cpmprice', 'cpmreason'].includes(action)) return false;
  if (!isAdmin(interaction.member)) {
    await interaction.reply({ content: '⛔ Panel ini khusus **Administrator**.', flags: EPH }).catch(() => {});
    return true;
  }
  if (tool) {
    await T.handle(interaction, action, arg);
    return true;
  }
  const cfg = loadConfig();
  const guild = interaction.guild;
  const by = interaction.user.id;
  const p = arg ? getProduct(cfg, arg) : null;
  const reply = (content) => interaction.reply({ content, flags: EPH });
  const inPanel = interaction.message && interaction.message.id === state.controlPanel?.messageId;
  /** Setelah aksi: kalau dari pesan pribadi detail produk → perbarui pesan itu, kalau dari panel → balasan pribadi. */
  const answer = async (content) => {
    const fresh = loadConfig();
    if (!inPanel && p && interaction.message) return interaction.editReply ? interaction.editReply(productView(guild, fresh, getProduct(fresh, p.id), content)) : null;
    return interaction.editReply({ content });
  };

  if (action === 'cprefresh') {
    await interaction.deferUpdate();
    wrk.at = 0;
    await refresh();
    return true;
  }
  if (action === 'cpsel') {
    const prod = getProduct(cfg, interaction.values[0]);
    await interaction.reply({ ...productView(guild, cfg, prod), flags: V2F | EPH });
    interaction.message?.edit(buildPanel(guild, cfg)).catch(() => {}); // reset pilihan menu
    return true;
  }
  if (action === 'cpall') {
    const list = sellable(cfg);
    if (arg === 'reason') {
      await interaction.showModal(reasonModal('all', true));
      return true;
    }
    await interaction.deferReply({ flags: EPH });
    const res = await setOpen(guild, list, arg === 'open', null, by);
    await interaction.editReply({ content: res });
    return true;
  }
  if (!p && !(action === 'cpmreason' && arg === 'all')) {
    await reply('❌ Produk tidak ditemukan di store.json.');
    return true;
  }
  if (action === 'cptog') {
    if (inPanel) await interaction.deferReply({ flags: EPH });
    else await interaction.deferUpdate();
    const res = await setOpen(guild, [p], !productState(p.id).open, null, by);
    await answer(res);
    return true;
  }
  if (action === 'cpopen' || action === 'cpclose') {
    if (inPanel) await interaction.deferReply({ flags: EPH });
    else await interaction.deferUpdate();
    const res = await setOpen(guild, [p], action === 'cpopen', null, by, true);
    await answer(res);
    return true;
  }
  if (action === 'cpreason') {
    await interaction.showModal(reasonModal(p.id, productState(p.id).open));
    return true;
  }
  if (action === 'cpstock' || action === 'cpadd') {
    if (!hasStock(p)) {
      await reply('ℹ️ Produk ini tidak memakai stock.');
      return true;
    }
    await interaction.showModal(stockModal(p, action === 'cpadd' ? 'add' : 'set'));
    return true;
  }
  if (action === 'cprate') {
    await interaction.showModal(rateModal(cfg, p));
    return true;
  }
  if (action === 'cpprice') {
    if (!plansOf(p).length) return void (await reply('ℹ️ Produk ini tidak punya paket.')) || true;
    await interaction.showModal(priceModal(p));
    return true;
  }

  // ── Form dikirim
  const fromMsg = interaction.isFromMessage?.() && interaction.message;
  if (fromMsg && !inPanel) await interaction.deferUpdate();
  else await interaction.deferReply({ flags: EPH });
  const field = (id) => {
    try {
      return interaction.fields.getTextInputValue(id);
    } catch {
      return '';
    }
  };

  if (action === 'cpmreason') {
    const reason = field('reason').trim();
    if (arg === 'all') {
      const res = await setOpen(guild, sellable(cfg), false, reason, by);
      await interaction.editReply({ content: res });
      return true;
    }
    const res = await setOpen(guild, [p], !productState(p.id).open, reason, by);
    await answer(res);
    return true;
  }
  if (action === 'cpmstock' || action === 'cpmadd') {
    const out = [];
    if (p.type === 'boost') {
      for (const x of plansOf(p).slice(0, 5)) {
        const v = parseNum(field(`plan_${x.id}`));
        if (!Number.isFinite(v) || v < 0) {
          out.push(`❌ Stock **${x.label}** tidak valid.`);
          continue;
        }
        const r = await changeStock(guild, p, x.id, v, 'set', by);
        if (r) out.push(r);
      }
    } else {
      const v = parseNum(field('value'));
      if (!Number.isFinite(v) || (action === 'cpmstock' && v < 0)) return void (await answer('❌ Angka stock tidak valid.')) || true;
      const r = await changeStock(guild, p, null, v, action === 'cpmadd' ? 'add' : 'set', by);
      if (r) out.push(r);
    }
    await answer(out.length ? `${out.join('\n')}\n-# Perubahan stock sudah diumumkan di channel stock.` : 'ℹ️ Tidak ada perubahan stock.');
    refresh();
    return true;
  }
  if (action === 'cpmrate') {
    const v = parseNum(field('value'));
    if (!Number.isFinite(v) || v <= 0) return void (await answer('❌ Rate tidak valid.')) || true;
    const before = V.rateOf(cfg, p);
    state.rates[p.id] = v;
    save();
    ctx.refreshPanel();
    logAction(`💱 <@${by}> rate **${p.label}**: ${rupiah(before)} → ${rupiah(v)}`);
    const announced = before !== v ? await announcePrice(guild, cfg, p, [{ label: 'Rate', before, after: v, suffix: ' / Robux' }]) : false;
    await answer(`💱 Rate **${p.label}**: ${rupiah(before)} → **${rupiah(v)} / Robux**.${announced ? '\n📢 Perubahan harga sudah **diumumkan** di channel stock.' : ''}\n-# Ticket yang sudah berjalan tetap memakai rate lama.`);
    refresh();
    return true;
  }
  if (action === 'cpmprice') {
    const prices = {};
    const out = [];
    for (const x of plansOf(p).slice(0, 5)) {
      const v = parseNum(field(`plan_${x.id}`));
      if (!Number.isFinite(v) || v <= 0) {
        out.push(`❌ Harga **${x.label}** tidak valid.`);
        continue;
      }
      if (v !== Number(x.price)) {
        prices[x.id] = v;
        out.push(`💱 **${x.label}**: ${rupiah(x.price)} → **${rupiah(v)}**`);
      }
    }
    if (Object.keys(prices).length) {
      try {
        savePlanPrices(p.id, prices);
      } catch (e) {
        return void (await answer(`❌ Gagal menyimpan store.json: ${e.message}`)) || true;
      }
      logAction(`💱 <@${by}> harga paket **${p.label}** diubah`);
      ctx.refreshPanel();
      const changes = plansOf(p)
        .filter((x) => prices[x.id] != null)
        .map((x) => ({ label: x.label, before: Number(x.price), after: prices[x.id], suffix: p.type === 'boost' ? ' / boost' : '' }));
      if (await announcePrice(guild, loadConfig(), getProduct(loadConfig(), p.id), changes)) out.push('📢 Perubahan harga sudah **diumumkan** di channel stock.');
    }
    await answer(out.join('\n') || 'ℹ️ Tidak ada perubahan harga.');
    refresh();
    return true;
  }
  return true;
}

function init(c) {
  ctx = c;
  T.init({ ctx: c, setOpen, refresh, logAction, getWrk: () => wrk });
}
/** Guild tempat panel admin berada (untuk jadwal & peringatan). */
async function panelGuild() {
  const client = ctx?.getClient();
  if (!client) return null;
  const ch = await client.channels.fetch(channelOfCfg(loadConfig())).catch(() => null);
  return ch?.guild || client.guilds.cache.first() || null;
}
/** Dipanggil saat bot siap: kirim / perbarui panel, lalu perbarui berkala (saldo, statistik harian). */
function start() {
  setTimeout(refresh, 6000);
  setInterval(refresh, 5 * 60 * 1000);
  // ⏰ Jam operasional (tiap 30 detik) & ⚠️ peringatan stock / saldo (tiap 2 menit).
  setInterval(async () => T.scheduleTick(await panelGuild()).catch((e) => console.warn('[control] jadwal:', e.message)), 30 * 1000);
  setInterval(async () => {
    if (loadConfig()?.products?.some((p) => p.type === 'instant')) await refreshWrk();
    await T.alertsTick(await panelGuild()).catch((e) => console.warn('[control] peringatan:', e.message));
  }, 2 * 60 * 1000);
}

module.exports = { init, start, handle, refresh, buildPanel };
