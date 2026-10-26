const fs = require('fs');
const path = require('path');
const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  MessageFlags,
  Events,
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  LabelBuilder,
  TextInputBuilder,
  TextInputStyle,
  AttachmentBuilder,
} = require('discord.js');
const UI = require('./ui');

/**
 * Canva Manager — daftar pelanggan Canva Pro (dari WhatsApp / luar Discord + order ticket Discord)
 * dengan dashboard V2 sticky & pengingat otomatis (H-3, H-1, hari H, lalu harian kalau belum ditindaklanjuti).
 * - Data manual: data/canva-manager.json
 * - Order Discord: dibaca langsung dari ticket Canva Pro di Noname Store (status Completed) — tidak perlu input ulang.
 */
const FILE = path.join(__dirname, '..', 'canva-manager.json');
const DATA = path.join(__dirname, '..', 'data', 'canva-manager.json');
const V2 = MessageFlags.IsComponentsV2;
const EPH = MessageFlags.Ephemeral;
const DAY = 86400000;
const PER_PAGE = 8;
const isId = (v) => /^\d{17,20}$/.test(String(v || ''));
const num = (n) => Math.round(Number(n) || 0).toLocaleString('id-ID');
const rupiah = (n) => `Rp ${num(n)}`;
const ts = (ms, s = 'D') => `<t:${Math.floor(ms / 1000)}:${s}>`;
const text = (c) => new TextDisplayBuilder().setContent(String(c).slice(0, 4000));
const line = () => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
const wibDate = (ms) => new Date(ms).toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: 'short', year: 'numeric' });
const wibHour = () => Number(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta', hour: 'numeric', hour12: false })) % 24;

const PLANS = [
  { id: '1', label: '1 Bulan', days: 30 },
  { id: '2', label: '2 Bulan', days: 60 },
  { id: '3', label: '3 Bulan', days: 90 },
  { id: '6', label: '6 Bulan', days: 180 },
  { id: '12', label: '1 Tahun', days: 365 },
];
const SOURCES = ['WhatsApp', 'Discord', 'Instagram', 'TikTok', 'Shopee', 'Lainnya'];

const DEFAULT = {
  channelId: '1563232116202807366',
  pingUserId: '',
  remindDays: [3, 1],
  overdueEveryHours: 24,
  quietHours: { start: 22, end: 8 },
  includeDiscordOrders: true,
};
function loadConfig() {
  try {
    return { ...DEFAULT, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
  } catch {
    return DEFAULT;
  }
}

// ───────────────────────── Data ─────────────────────────
function loadData() {
  try {
    return { seq: 0, entries: {}, overrides: {}, dashboard: null, ...JSON.parse(fs.readFileSync(DATA, 'utf8')) };
  } catch {
    return { seq: 0, entries: {}, overrides: {}, dashboard: null };
  }
}
const data = loadData();
function save() {
  fs.mkdirSync(path.dirname(DATA), { recursive: true });
  fs.writeFileSync(`${DATA}.tmp`, JSON.stringify(data, null, 2));
  fs.renameSync(`${DATA}.tmp`, DATA);
}

/** Ticket Canva Pro dari Noname Store (Completed, punya masa aktif). */
function discordOrders() {
  try {
    const { state } = require('./store/state');
    return Object.values(state.tickets || {}).filter((t) => (t.kind || 'robux') === 'canva' && t.status === 'completed' && t.expiresAt);
  } catch {
    return [];
  }
}

/** Semua pelanggan dalam format yang sama. key: m_<id> (manual) / t_<ticketId> (Discord). */
function allItems(cfg = loadConfig()) {
  const items = Object.values(data.entries).map((e) => ({ ...e, key: `m_${e.id}`, origin: 'manual' }));
  if (cfg.includeDiscordOrders !== false) {
    for (const t of discordOrders()) {
      const o = data.overrides[t.id] || {};
      if (o.deleted) continue;
      items.push({
        key: `t_${t.id}`,
        id: t.id,
        origin: 'discord',
        email: t.email || '-',
        buyer: o.buyer || null,
        buyerId: t.userId,
        contact: o.contact || null,
        source: 'Discord',
        plan: o.plan || t.plan?.label || '-',
        startAt: t.closedAt || t.createdAt,
        expiresAt: o.expiresAt || t.expiresAt,
        price: (Number(t.price) || 0) + (Number(o.extraPrice) || 0),
        payments: [{ at: t.closedAt || t.createdAt, amount: Number(t.price) || 0 }, ...(o.payments || [])],
        note: o.note || null,
        done: Boolean(o.done),
        doneAt: o.doneAt || null,
        doneBy: o.doneBy || null,
        snoozeUntil: o.snoozeUntil || 0,
        reminded: o.reminded || {},
        history: o.history || [],
        createdBy: t.closedBy || null,
      });
    }
  }
  return items;
}
function getItem(key) {
  return allItems().find((x) => x.key === key) || null;
}
/** Objek yang disimpan (manual = entry, Discord = override). */
function recordOf(key) {
  if (key.startsWith('m_')) return data.entries[key.slice(2)] || null;
  if (key.startsWith('t_')) return (data.overrides[key.slice(2)] ||= {});
  return null;
}
function addHistory(rec, text) {
  rec.history = rec.history || [];
  rec.history.push({ at: Date.now(), text });
  if (rec.history.length > 30) rec.history.splice(0, rec.history.length - 30);
}

const daysLeft = (it) => Math.ceil((it.expiresAt - Date.now()) / DAY);
function statusOf(it) {
  if (it.done) return { key: 'done', emoji: '✅', label: 'Selesai' };
  const d = daysLeft(it);
  if (it.expiresAt <= Date.now()) return { key: 'expired', emoji: '🔴', label: 'Habis' };
  if (d <= 7) return { key: 'soon', emoji: '🟡', label: `Sisa ${d} hari` };
  return { key: 'active', emoji: '🟢', label: `Sisa ${d} hari` };
}
const buyerText = (it) => (it.buyerId ? `<@${it.buyerId}>` : `**${it.buyer || '-'}**`);
function waLink(contact) {
  let d = String(contact || '').replace(/[^\d+]/g, '');
  if (!d || d.replace('+', '').length < 9) return null;
  d = d.replace(/^\+/, '');
  if (d.startsWith('0')) d = `62${d.slice(1)}`;
  if (d.startsWith('8')) d = `62${d}`;
  return `https://wa.me/${d}`;
}
function parseDate(s) {
  const m = String(s || '').trim().match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (!m) return null;
  const y = Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3]);
  const t = Date.UTC(y, Number(m[2]) - 1, Number(m[1]), 5, 0); // 12:00 WIB
  return Number.isNaN(t) ? null : t;
}
const parsePrice = (s) => Number(String(s || '').replace(/[^\d]/g, '')) || 0;
const isAdmin = (m) => m?.permissions?.has(PermissionFlagsBits.ManageGuild) || m?.permissions?.has(PermissionFlagsBits.Administrator);

// ───────────────────────── Dashboard ─────────────────────────
const FILTERS = {
  open: { label: 'Belum Selesai', emoji: '📋', desc: 'Aktif + mau habis + sudah habis' },
  soon: { label: 'Mau Habis (≤ 7 hari)', emoji: '🟡', desc: 'Perlu diperhatikan' },
  expired: { label: 'Sudah Habis', emoji: '🔴', desc: 'Belum dikeluarkan / diperpanjang' },
  active: { label: 'Aktif (> 7 hari)', emoji: '🟢', desc: 'Masih lama' },
  done: { label: 'Selesai', emoji: '✅', desc: 'Sudah dikeluarkan dari team' },
  all: { label: 'Semua', emoji: '🗂️', desc: 'Semua data' },
};
const view = { filter: 'open', page: 0 };

function filtered(items, filter) {
  const list = items.filter((it) => {
    const s = statusOf(it).key;
    if (filter === 'all') return true;
    if (filter === 'open') return s !== 'done';
    return s === filter;
  });
  return list.sort((a, b) => (a.done - b.done) || a.expiresAt - b.expiresAt);
}
function itemRow(it) {
  const st = statusOf(it);
  return [
    `${st.emoji} \`${it.id}\` **${it.email}**${it.origin === 'discord' ? ' • 💬' : ''}`,
    `┗ 👤 ${buyerText(it)}${it.contact ? ` • 📱 \`${it.contact}\`` : ''} • ${it.plan}`,
    `┗ 📅 Habis ${ts(it.expiresAt)} (${ts(it.expiresAt, 'R')})${it.price ? ` • ${rupiah(it.price)}` : ''}`,
  ].join('\n');
}

function buildDashboard(guild) {
  const items = allItems();
  const count = { active: 0, soon: 0, expired: 0, done: 0 };
  for (const it of items) count[statusOf(it).key] += 1;
  const monthStart = (() => {
    const d = new Date(Date.now() + 7 * 3600000);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - 7 * 3600000;
  })();
  // Pendapatan = semua pembayaran (order baru + perpanjangan) di bulan ini.
  const revenue = items.reduce((a, it) => a + (it.payments || (it.price ? [{ at: it.startAt, amount: it.price }] : [])).filter((p) => p.at >= monthStart).reduce((x, p) => x + (Number(p.amount) || 0), 0), 0);
  const list = filtered(items, view.filter);
  const pages = Math.max(1, Math.ceil(list.length / PER_PAGE));
  view.page = Math.min(Math.max(0, view.page), pages - 1);
  const slice = list.slice(view.page * PER_PAGE, view.page * PER_PAGE + PER_PAGE);

  const box = UI.accent(new ContainerBuilder(), 0x3498db);
  const header = `# 🎨 Canva Manager\n-# Noname Store • Pelanggan Canva Pro\nSemua pelanggan Canva Pro — dari **WhatsApp / luar Discord** & **order Discord** — di satu tempat.`;
  const icon = guild?.iconURL?.({ extension: 'png', size: 256 });
  if (icon) box.addSectionComponents(new SectionBuilder().addTextDisplayComponents(text(header)).setThumbnailAccessory(new ThumbnailBuilder().setURL(icon)));
  else box.addTextDisplayComponents(text(header));

  box.addSeparatorComponents(line());
  box.addTextDisplayComponents(
    text(
      [
        `**🟢 Aktif:** \`${num(count.active)}\` • **🟡 Mau Habis:** \`${num(count.soon)}\` • **🔴 Habis:** \`${num(count.expired)}\` • **✅ Selesai:** \`${num(count.done)}\``,
        `**💰 Pendapatan Bulan Ini:** \`${rupiah(revenue)}\` • **📱 Luar Discord:** \`${num(items.filter((x) => x.origin === 'manual').length)}\` • **💬 Discord:** \`${num(items.filter((x) => x.origin === 'discord').length)}\``,
      ].join('\n'),
    ),
  );
  box.addSeparatorComponents(line());
  const f = FILTERS[view.filter];
  box.addTextDisplayComponents(
    text(
      slice.length
        ? `### ${f.emoji} ${f.label} • Halaman ${view.page + 1}/${pages} (${num(list.length)} data)\n${slice.map(itemRow).join('\n\n')}`
        : `### ${f.emoji} ${f.label}\n_Tidak ada data. Tambah pelanggan dengan tombol **➕ Tambah** atau \`/canva tambah\`._`,
    ),
  );
  box.addSeparatorComponents(line());
  box.addTextDisplayComponents(text(`-# 💬 = order dari Discord • Pengingat otomatis H-3, H-1 & hari H • Diperbarui ${ts(Date.now(), 'R')}`));

  box.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('cv:prev').setEmoji('◀️').setStyle(ButtonStyle.Secondary).setDisabled(view.page === 0),
      new ButtonBuilder().setCustomId('cv:page').setLabel(`${view.page + 1} / ${pages}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
      new ButtonBuilder().setCustomId('cv:next').setEmoji('▶️').setStyle(ButtonStyle.Secondary).setDisabled(view.page >= pages - 1),
      new ButtonBuilder().setCustomId('cv:add').setLabel('Tambah').setEmoji('➕').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('cv:search').setLabel('Cari').setEmoji('🔎').setStyle(ButtonStyle.Primary),
    ),
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('cv:filter')
        .setPlaceholder('🔽 Filter status...')
        .addOptions(Object.entries(FILTERS).map(([v, x]) => ({ label: x.label, value: v, emoji: x.emoji, description: x.desc, default: v === view.filter }))),
    ),
  );
  if (slice.length) {
    box.addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('cv:manage')
          .setPlaceholder('⚙️ Kelola pelanggan (perpanjang / selesai / edit)...')
          .addOptions(
            slice.map((it) => ({
              label: `${it.id} • ${it.email}`.slice(0, 100),
              value: it.key,
              emoji: statusOf(it).emoji,
              description: `${it.buyer || (it.buyerId ? 'Discord' : '-')} • habis ${wibDate(it.expiresAt)}`.slice(0, 100),
            })),
          ),
      ),
    );
  }
  return { components: [box], flags: V2, allowedMentions: { parse: [] } };
}

// Kartu detail (hanya terlihat admin) + tombol kelola.
function manageCard(it, note) {
  const st = statusOf(it);
  const accent = st.key === 'done' ? 0x95a5a6 : st.key === 'expired' ? 0xe74c3c : st.key === 'soon' ? 0xf1c40f : 0x3498db;
  const box = UI.accent(new ContainerBuilder(), accent);
  box.addTextDisplayComponents(
    text(
      [
        note ? `-# ${note}` : null,
        `## ${st.emoji} ${it.id} • ${st.label}`,
        '```',
        it.email,
        '```',
        `**👤 Pembeli:** ${buyerText(it)}${it.contact ? ` • 📱 \`${it.contact}\`` : ''}`,
        `**🛒 Sumber:** \`${it.source || '-'}\` • **📦 Paket:** \`${it.plan}\`${it.price ? ` • **💰** \`${rupiah(it.price)}\`` : ''}`,
        `**🗓️ Mulai:** ${ts(it.startAt)} • **⌛ Habis:** ${ts(it.expiresAt)} (${ts(it.expiresAt, 'R')})`,
        it.done ? `**✅ Selesai:** ${ts(it.doneAt || Date.now(), 'f')}${it.doneBy ? ` oleh <@${it.doneBy}>` : ''}` : null,
        it.snoozeUntil > Date.now() ? `**⏰ Pengingat ditunda sampai:** ${ts(it.snoozeUntil, 'f')}` : null,
        it.note ? `**📝 Catatan:** ${it.note}` : null,
      ]
        .filter((x) => x !== null)
        .join('\n'),
    ),
  );
  if (it.history?.length) {
    box.addSeparatorComponents(line());
    box.addTextDisplayComponents(text(`### 📜 Riwayat\n${it.history.slice(-5).map((h) => `\`${wibDate(h.at)}\` ${h.text}`).join('\n')}`));
  }
  box.addActionRowComponents(...actionRows(it));
  return { components: [box], flags: V2 | EPH, allowedMentions: { parse: [] } };
}
function actionRows(it, { compact = false } = {}) {
  const row1 = [new ButtonBuilder().setCustomId(`cv:x:ext:${it.key}`).setLabel('Perpanjang').setEmoji('🔁').setStyle(ButtonStyle.Success)];
  if (it.done) row1.push(new ButtonBuilder().setCustomId(`cv:x:undo:${it.key}`).setLabel('Aktifkan Lagi').setEmoji('↩️').setStyle(ButtonStyle.Secondary));
  else row1.push(new ButtonBuilder().setCustomId(`cv:x:done:${it.key}`).setLabel('Sudah Dikeluarkan').setEmoji('✅').setStyle(ButtonStyle.Primary));
  if (!it.done) row1.push(new ButtonBuilder().setCustomId(`cv:x:snooze:${it.key}`).setLabel('Tunda 1 Hari').setEmoji('⏰').setStyle(ButtonStyle.Secondary));
  row1.push(new ButtonBuilder().setCustomId(`cv:x:mail:${it.key}`).setLabel('Salin Email').setEmoji('📋').setStyle(ButtonStyle.Secondary));
  const wa = waLink(it.contact);
  if (wa) row1.push(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Chat WA').setEmoji('💬').setURL(wa));
  const rows = [new ActionRowBuilder().addComponents(row1.slice(0, 5))];
  if (!compact) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`cv:x:edit:${it.key}`).setLabel('Edit').setEmoji('✏️').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`cv:x:del:${it.key}`).setLabel('Hapus').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
      ),
    );
  }
  return rows;
}

// ───────────────────────── Pengingat ─────────────────────────
function reminderCard(it, stage, cfg) {
  const st = statusOf(it);
  const title =
    stage === 'overdue'
      ? '🚨 Canva Pro Sudah Habis — Belum Ditindaklanjuti'
      : stage === 'h0'
        ? '🔴 Canva Pro Habis Hari Ini!'
        : `🟡 Canva Pro Habis dalam ${Math.max(1, daysLeft(it))} Hari`;
  const ping = isId(cfg.pingUserId) ? cfg.pingUserId : it.createdBy || null;
  const box = UI.accent(new ContainerBuilder(), stage === 'soon' ? 0xf1c40f : 0xe74c3c);
  box.addTextDisplayComponents(
    text(
      [
        `## ${title}`,
        '```',
        it.email,
        '```',
        `**👤 Pembeli:** ${buyerText(it)}${it.contact ? ` • 📱 \`${it.contact}\`` : ''}`,
        `**📦 Paket:** \`${it.plan}\` • **🛒 Sumber:** \`${it.source || '-'}\` • **🆔** \`${it.id}\``,
        `**⌛ Habis:** ${ts(it.expiresAt, 'f')} (${ts(it.expiresAt, 'R')}) • \`${st.label}\``,
        it.note ? `**📝 Catatan:** ${it.note}` : null,
        `-# 💡 Tawarkan perpanjangan ke pembeli, atau keluarkan email dari team Canva lalu klik **✅ Sudah Dikeluarkan**.`,
      ]
        .filter(Boolean)
        .join('\n'),
    ),
  );
  box.addActionRowComponents(...actionRows(it, { compact: true }));
  return {
    components: ping ? [text(`<@${ping}>`), box] : [box],
    flags: V2,
    allowedMentions: { users: ping ? [ping] : [] },
  };
}

let client = null;
let checking = false;
async function checkReminders({ force = false } = {}) {
  if (!client || checking) return 0;
  checking = true;
  let sent = 0;
  try {
    const cfg = loadConfig();
    const h = wibHour();
    const q = cfg.quietHours || {};
    const quiet = q.start != null && q.end != null && (q.start > q.end ? h >= q.start || h < q.end : h >= q.start && h < q.end);
    if (quiet && !force) return 0; // jam tenang (malam) → pengingat dikirim pagi
    if (!isId(cfg.channelId)) return 0;
    const ch = await client.channels.fetch(cfg.channelId).catch(() => null);
    if (!ch?.isTextBased()) return 0;
    const remindDays = [...(cfg.remindDays || [3, 1])].map(Number).filter((n) => n > 0).sort((a, b) => b - a);
    for (const it of allItems(cfg)) {
      if (it.done || (it.snoozeUntil || 0) > Date.now()) continue;
      const rec = recordOf(it.key);
      if (!rec) continue;
      rec.reminded ||= {};
      const left = daysLeft(it);
      let stage = null;
      if (it.expiresAt <= Date.now()) {
        if (!rec.reminded.h0) stage = 'h0';
        else if (Date.now() - (rec.reminded.last || 0) >= (Number(cfg.overdueEveryHours) || 24) * 3600000) stage = 'overdue';
      } else {
        const d = remindDays.find((n) => left <= n && !rec.reminded[`h${n}`] && left > (remindDays[remindDays.indexOf(n) + 1] ?? 0));
        if (d) stage = `h${d}`;
        // Lewati tahap yang sudah lewat (misal data baru ditambahkan H-1 → tidak kirim H-3 lagi).
        for (const n of remindDays) if (left <= n && n !== d) rec.reminded[`h${n}`] ||= Date.now();
      }
      if (!stage) continue;
      const msg = await ch.send(reminderCard(it, stage === 'h0' || stage === 'overdue' ? stage : 'soon', cfg)).catch((e) => {
        console.warn('[canva] gagal kirim pengingat:', e.message);
        return null;
      });
      if (!msg) continue;
      rec.reminded[stage === 'overdue' ? 'overdue' : stage] = Date.now();
      rec.reminded.last = Date.now();
      sent += 1;
    }
    save();
    if (sent) await refreshDashboard(true);
  } catch (e) {
    console.warn('[canva] cek pengingat:', e.message);
  } finally {
    checking = false;
  }
  return sent;
}

// ───────────────────────── Dashboard sticky ─────────────────────────
let dashTimer = null;
async function refreshDashboard(toBottom = false) {
  if (!client || !data.dashboard) return;
  const ch = await client.channels.fetch(data.dashboard.channelId).catch(() => null);
  if (!ch?.isTextBased()) return;
  const payload = buildDashboard(ch.guild);
  if (toBottom && ch.lastMessageId !== data.dashboard.messageId) {
    const old = data.dashboard.messageId;
    const sent = await ch.send(payload).catch(() => null);
    if (!sent) return;
    data.dashboard = { channelId: ch.id, messageId: sent.id };
    save();
    await ch.messages.delete(old).catch(() => {});
    return;
  }
  await ch.messages.edit(data.dashboard.messageId, payload).catch(async (e) => {
    if (e.code === 10008) {
      data.dashboard = null; // dihapus manual → berhenti
      save();
    }
  });
}
const scheduleDashboard = (toBottom = false) => {
  clearTimeout(dashTimer);
  dashTimer = setTimeout(() => refreshDashboard(toBottom).catch(() => {}), 1500);
};

// ───────────────────────── Form ─────────────────────────
const planSelect = (id = 'plan') =>
  new StringSelectMenuBuilder()
    .setCustomId(id)
    .setPlaceholder('Pilih paket...')
    .setRequired(true)
    .addOptions(PLANS.map((p) => ({ label: p.label, value: p.id, description: `${p.days} hari` })));

function addModal() {
  return new ModalBuilder()
    .setCustomId('cv:m:add')
    .setTitle('➕ Tambah Pelanggan Canva')
    .addLabelComponents(
      new LabelBuilder().setLabel('Email Canva').setTextInputComponent(new TextInputBuilder().setCustomId('email').setStyle(TextInputStyle.Short).setPlaceholder('pembeli@gmail.com').setMaxLength(120).setRequired(true)),
      new LabelBuilder().setLabel('Nama Pembeli').setTextInputComponent(new TextInputBuilder().setCustomId('buyer').setStyle(TextInputStyle.Short).setPlaceholder('contoh: Budi').setMaxLength(60).setRequired(true)),
      new LabelBuilder()
        .setLabel('Kontak (No. WA / username)')
        .setDescription('Nomor WA → tombol Chat WA otomatis muncul.')
        .setTextInputComponent(new TextInputBuilder().setCustomId('contact').setStyle(TextInputStyle.Short).setPlaceholder('0812xxxxxxx').setMaxLength(60).setRequired(false)),
      new LabelBuilder().setLabel('Paket').setStringSelectMenuComponent(planSelect()),
      new LabelBuilder()
        .setLabel('Harga & Tanggal Mulai (opsional)')
        .setDescription('Format: harga | tanggal mulai. Contoh: 25000 | 20-10-2026. Kosong = hari ini.')
        .setTextInputComponent(new TextInputBuilder().setCustomId('extra').setStyle(TextInputStyle.Short).setPlaceholder('25000 | 20-10-2026').setMaxLength(40).setRequired(false)),
    );
}
function extendModal(it) {
  return new ModalBuilder()
    .setCustomId(`cv:m:ext:${it.key}`)
    .setTitle(`🔁 Perpanjang ${it.id}`.slice(0, 45))
    .addLabelComponents(
      new LabelBuilder().setLabel('Paket Perpanjangan').setStringSelectMenuComponent(planSelect()),
      new LabelBuilder()
        .setLabel('Harga (opsional)')
        .setTextInputComponent(new TextInputBuilder().setCustomId('price').setStyle(TextInputStyle.Short).setPlaceholder('25000').setMaxLength(15).setRequired(false)),
    );
}
function editModal(it) {
  const input = (id, label, value, style = TextInputStyle.Short, max = 100, required = false) =>
    new LabelBuilder().setLabel(label).setTextInputComponent(new TextInputBuilder().setCustomId(id).setStyle(style).setValue(String(value || '').slice(0, max)).setMaxLength(max).setRequired(required));
  const m = new ModalBuilder().setCustomId(`cv:m:edit:${it.key}`).setTitle(`✏️ Edit ${it.id}`.slice(0, 45));
  const fields = [];
  if (it.origin === 'manual') fields.push(input('email', 'Email Canva', it.email, TextInputStyle.Short, 120, true), input('buyer', 'Nama Pembeli', it.buyer, TextInputStyle.Short, 60, true));
  else fields.push(input('buyer', 'Nama Pembeli (opsional)', it.buyer, TextInputStyle.Short, 60));
  fields.push(
    input('contact', 'Kontak (No. WA / username)', it.contact, TextInputStyle.Short, 60),
    input('expires', 'Tanggal Habis (DD-MM-YYYY)', dmy(it.expiresAt), TextInputStyle.Short, 10, true),
    input('note', 'Catatan', it.note, TextInputStyle.Paragraph, 300),
  );
  return m.addLabelComponents(...fields.slice(0, 5));
}
function dmy(ms) {
  const d = new Date(ms + 7 * 3600000);
  return `${String(d.getUTCDate()).padStart(2, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${d.getUTCFullYear()}`;
}
function searchModal() {
  return new ModalBuilder()
    .setCustomId('cv:m:search')
    .setTitle('🔎 Cari Pelanggan Canva')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('Email / Nama / Kontak / ID')
        .setTextInputComponent(new TextInputBuilder().setCustomId('q').setStyle(TextInputStyle.Short).setMinLength(2).setMaxLength(80).setRequired(true)),
    );
}

// ───────────────────────── Aksi ─────────────────────────
function createEntry({ email, buyer, contact, planId, days, price, startAt, source, note, by }) {
  const plan = PLANS.find((p) => p.id === String(planId)) || PLANS[0];
  const d = Number(days) || plan.days;
  data.seq += 1;
  const id = `CP-${String(data.seq).padStart(4, '0')}`;
  const start = startAt || Date.now();
  const contactTxt = (contact || '').trim() || null;
  const e = {
    id,
    email: String(email).trim().toLowerCase(),
    buyer: String(buyer).trim(),
    contact: contactTxt,
    source: source || (waLink(contactTxt) ? 'WhatsApp' : 'Lainnya'),
    plan: days ? `${d} hari` : plan.label,
    days: d,
    startAt: start,
    expiresAt: start + d * DAY,
    price: Number(price) || 0,
    note: note || null,
    payments: Number(price) ? [{ at: start, amount: Number(price) }] : [],
    done: false,
    createdBy: by,
    createdAt: Date.now(),
    reminded: {},
    history: [],
  };
  addHistory(e, `🆕 Ditambahkan oleh <@${by}> • ${e.plan}`);
  data.entries[id] = e;
  save();
  scheduleDashboard();
  return e;
}

function extend(key, planId, price, by) {
  const rec = recordOf(key);
  const it = getItem(key);
  if (!rec || !it) return null;
  const plan = PLANS.find((p) => p.id === String(planId)) || PLANS[0];
  const base = Math.max(Date.now(), it.expiresAt);
  rec.expiresAt = base + plan.days * DAY;
  rec.done = false;
  rec.doneAt = null;
  rec.reminded = {};
  rec.snoozeUntil = 0;
  rec.plan = plan.label;
  if (price) {
    if (key.startsWith('m_')) rec.price = (Number(rec.price) || 0) + Number(price);
    else rec.extraPrice = (Number(rec.extraPrice) || 0) + Number(price);
    rec.payments = [...(rec.payments || []), { at: Date.now(), amount: Number(price) }];
  }
  addHistory(rec, `🔁 Diperpanjang ${plan.label}${price ? ` (${rupiah(price)})` : ''} oleh <@${by}> → habis ${wibDate(rec.expiresAt)}`);
  save();
  return getItem(key);
}
function setDone(key, done, by) {
  const rec = recordOf(key);
  if (!rec) return null;
  rec.done = done;
  rec.doneAt = done ? Date.now() : null;
  rec.doneBy = done ? by : null;
  if (!done) rec.reminded = {};
  addHistory(rec, done ? `✅ Ditandai sudah dikeluarkan dari team oleh <@${by}>` : `↩️ Diaktifkan lagi oleh <@${by}>`);
  save();
  return getItem(key);
}

/** Tandai kartu pengingat sudah ditindaklanjuti (tombol dihapus, ada keterangan). */
async function resolveReminderMsg(i, note) {
  if (!i.message || i.message.flags?.has?.(EPH) || i.message.id === data.dashboard?.messageId) return;
  if (!i.message.author || i.message.author.id !== i.client.user.id) return;
  const comps = i.message.components.map((c) => c.toJSON());
  const box = comps.find((c) => c.type === 17);
  if (!box) return;
  box.components = box.components.filter((c) => c.type !== 1);
  if (UI.showAccent()) box.accent_color = 0x2ecc71;
  else delete box.accent_color;
  box.components.push({ type: 14, divider: true, spacing: 1 }, { type: 10, content: `✅ ${note}` });
  await i.message.edit({ components: comps.filter((c) => c.type === 17), flags: V2, allowedMentions: { parse: [] } }).catch(() => {});
}

async function handleInteraction(i) {
  const id = i.customId;
  if (typeof id !== 'string' || !id.startsWith('cv:')) return false;
  try {
    if (!isAdmin(i.member)) {
      await i.reply({ content: '⛔ Hanya admin (Manage Server) yang bisa mengelola Canva Manager.', flags: EPH });
      return true;
    }
    const by = i.user.id;

    // Dashboard
    if (id === 'cv:prev' || id === 'cv:next') {
      view.page += id === 'cv:next' ? 1 : -1;
      await i.update(buildDashboard(i.guild));
      return true;
    }
    if (id === 'cv:filter') {
      view.filter = i.values[0];
      view.page = 0;
      await i.update(buildDashboard(i.guild));
      return true;
    }
    if (id === 'cv:add') return void (await i.showModal(addModal())) || true;
    if (id === 'cv:search') return void (await i.showModal(searchModal())) || true;
    if (id === 'cv:manage') {
      const it = getItem(i.values[0]);
      await i.update(buildDashboard(i.guild)); // reset pilihan dropdown
      await i.followUp(it ? manageCard(it) : { content: '❌ Data tidak ditemukan.', flags: EPH });
      return true;
    }
    if (id === 'cv:pick') {
      const it = getItem(i.values[0]);
      await i.reply(it ? manageCard(it) : { content: '❌ Data tidak ditemukan.', flags: EPH });
      return true;
    }

    // Tombol kelola: cv:x:<aksi>:<key>
    if (id.startsWith('cv:x:')) {
      const [, , action, key] = id.split(':');
      const it = getItem(key);
      if (!it) {
        await i.reply({ content: '❌ Data pelanggan tidak ditemukan (mungkin sudah dihapus).', flags: EPH });
        return true;
      }
      if (action === 'ext') return void (await i.showModal(extendModal(it))) || true;
      if (action === 'edit') return void (await i.showModal(editModal(it))) || true;
      if (action === 'mail') {
        await i.reply({ content: it.email, flags: EPH });
        return true;
      }
      if (action === 'done' || action === 'undo') {
        const now = setDone(key, action === 'done', by);
        await resolveReminderMsg(i, action === 'done' ? `Sudah dikeluarkan dari team oleh <@${by}>` : `Diaktifkan lagi oleh <@${by}>`);
        await (i.message?.flags?.has?.(EPH) ? i.update(manageCard(now, action === 'done' ? '✅ Ditandai selesai' : '↩️ Diaktifkan lagi')) : i.reply(manageCard(now, action === 'done' ? '✅ Ditandai selesai' : '↩️ Diaktifkan lagi')));
        scheduleDashboard();
        return true;
      }
      if (action === 'snooze') {
        const rec = recordOf(key);
        rec.snoozeUntil = Date.now() + DAY;
        addHistory(rec, `⏰ Pengingat ditunda 1 hari oleh <@${by}>`);
        save();
        await resolveReminderMsg(i, `Pengingat ditunda 1 hari oleh <@${by}>`);
        const now = getItem(key);
        await (i.message?.flags?.has?.(EPH) ? i.update(manageCard(now, '⏰ Pengingat ditunda 1 hari')) : i.reply(manageCard(now, '⏰ Pengingat ditunda 1 hari')));
        return true;
      }
      if (action === 'del') {
        await i.reply({
          content: `⚠️ Hapus data **${it.id}** (\`${it.email}\`)? ${it.origin === 'discord' ? 'Order Discord ini hanya disembunyikan dari Canva Manager.' : 'Tindakan ini tidak bisa dibatalkan.'}`,
          components: [
            new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId(`cv:x:delok:${key}`).setLabel('Ya, Hapus').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
            ),
          ],
          flags: EPH,
        });
        return true;
      }
      if (action === 'delok') {
        if (key.startsWith('m_')) delete data.entries[key.slice(2)];
        else (data.overrides[key.slice(2)] ||= {}).deleted = true;
        save();
        scheduleDashboard();
        await i.update({ content: `🗑️ Data **${it.id}** dihapus.`, components: [] });
        return true;
      }
    }

    // Form
    if (i.isModalSubmit()) {
      if (id === 'cv:m:add') {
        const email = i.fields.getTextInputValue('email').trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return void (await i.reply({ content: '❌ Format email tidak valid.', flags: EPH })) || true;
        const [priceTxt, dateTxt] = (i.fields.getTextInputValue('extra') || '').split('|').map((s) => s.trim());
        const startAt = dateTxt ? parseDate(dateTxt) : null;
        if (dateTxt && !startAt) return void (await i.reply({ content: '❌ Format tanggal salah. Contoh: `20-10-2026`.', flags: EPH })) || true;
        const e = createEntry({
          email,
          buyer: i.fields.getTextInputValue('buyer'),
          contact: i.fields.getTextInputValue('contact'),
          planId: i.fields.getStringSelectValues('plan')[0],
          price: parsePrice(priceTxt),
          startAt,
          by,
        });
        await i.reply(manageCard(getItem(`m_${e.id}`), '🆕 Pelanggan berhasil ditambahkan'));
        return true;
      }
      if (id === 'cv:m:search') {
        await i.reply(searchResult(i.fields.getTextInputValue('q')));
        return true;
      }
      if (id.startsWith('cv:m:ext:')) {
        const key = id.split(':')[3];
        const now = extend(key, i.fields.getStringSelectValues('plan')[0], parsePrice(i.fields.getTextInputValue('price')), by);
        if (!now) return void (await i.reply({ content: '❌ Data tidak ditemukan.', flags: EPH })) || true;
        await resolveReminderMsg(i, `Diperpanjang ${PLANS.find((p) => p.id === i.fields.getStringSelectValues('plan')[0])?.label} oleh <@${by}> → habis ${wibDate(now.expiresAt)}`);
        await i.reply(manageCard(now, `🔁 Diperpanjang → habis ${wibDate(now.expiresAt)}`));
        scheduleDashboard();
        return true;
      }
      if (id.startsWith('cv:m:edit:')) {
        const key = id.split(':')[3];
        const rec = recordOf(key);
        if (!rec) return void (await i.reply({ content: '❌ Data tidak ditemukan.', flags: EPH })) || true;
        const get = (k) => {
          try {
            return i.fields.getTextInputValue(k);
          } catch {
            return undefined;
          }
        };
        const exp = parseDate(get('expires'));
        if (!exp) return void (await i.reply({ content: '❌ Format tanggal habis salah. Contoh: `20-12-2026`.', flags: EPH })) || true;
        if (get('email') !== undefined) {
          const email = get('email').trim();
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return void (await i.reply({ content: '❌ Format email tidak valid.', flags: EPH })) || true;
          rec.email = email.toLowerCase();
        }
        if (get('buyer') !== undefined) rec.buyer = get('buyer').trim() || null;
        rec.contact = (get('contact') || '').trim() || null;
        rec.note = (get('note') || '').trim() || null;
        if (Math.abs(exp - getItem(key).expiresAt) > DAY / 2) {
          rec.expiresAt = exp;
          rec.reminded = {};
        }
        addHistory(rec, `✏️ Diedit oleh <@${by}>`);
        save();
        scheduleDashboard();
        await i.reply(manageCard(getItem(key), '✏️ Data diperbarui'));
        return true;
      }
    }
  } catch (err) {
    console.error('[canva] error:', err);
    const msg = { content: '❌ Terjadi kesalahan, coba lagi.', flags: EPH };
    if (i.deferred || i.replied) await i.followUp(msg).catch(() => {});
    else await i.reply(msg).catch(() => {});
  }
  return true;
}

function searchResult(q) {
  const s = String(q || '').trim().toLowerCase();
  const hits = allItems()
    .filter((it) => [it.id, it.email, it.buyer, it.contact, it.buyerId].some((v) => String(v || '').toLowerCase().includes(s)))
    .sort((a, b) => a.done - b.done || a.expiresAt - b.expiresAt)
    .slice(0, 25);
  const box = UI.accent(new ContainerBuilder(), 0x3498db);
  box.addTextDisplayComponents(
    text(hits.length ? `## 🔎 Hasil Cari: \`${s.slice(0, 40)}\` (${hits.length})\n${hits.slice(0, 8).map(itemRow).join('\n\n')}${hits.length > 8 ? `\n-# +${hits.length - 8} lainnya — pilih di dropdown` : ''}` : `## 🔎 Tidak Ditemukan\nTidak ada pelanggan yang cocok dengan \`${s.slice(0, 40)}\`.`),
  );
  if (hits.length) {
    box.addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('cv:pick')
          .setPlaceholder('⚙️ Pilih pelanggan untuk dikelola...')
          .addOptions(hits.map((it) => ({ label: `${it.id} • ${it.email}`.slice(0, 100), value: it.key, emoji: statusOf(it).emoji, description: `${it.buyer || '-'} • habis ${wibDate(it.expiresAt)}`.slice(0, 100) }))),
      ),
    );
  }
  return { components: [box], flags: V2 | EPH, allowedMentions: { parse: [] } };
}

function toCsv() {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['ID', 'Email', 'Pembeli', 'Discord ID', 'Kontak', 'Sumber', 'Paket', 'Mulai', 'Habis', 'Harga', 'Status', 'Catatan']];
  for (const it of allItems().sort((a, b) => a.expiresAt - b.expiresAt)) {
    rows.push([it.id, it.email, it.buyer || '', it.buyerId || '', it.contact || '', it.source || '', it.plan, dmy(it.startAt), dmy(it.expiresAt), it.price || 0, statusOf(it).label, it.note || '']);
  }
  return `﻿${rows.map((r) => r.map(esc).join(',')).join('\n')}`;
}

/** Laporan HTML (dibuka di browser): ringkasan, cari, filter status, urutkan kolom, salin email, chat WA. */
function toHtml(guildName = 'Noname Store') {
  const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const items = allItems().sort((a, b) => a.done - b.done || a.expiresAt - b.expiresAt);
  const count = { active: 0, soon: 0, expired: 0, done: 0 };
  for (const it of items) count[statusOf(it).key] += 1;
  const d = new Date(Date.now() + 7 * 3600000);
  const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - 7 * 3600000;
  const pays = (it) => it.payments || (it.price ? [{ at: it.startAt, amount: it.price }] : []);
  const revMonth = items.reduce((a, it) => a + pays(it).filter((p) => p.at >= monthStart).reduce((x, p) => x + (Number(p.amount) || 0), 0), 0);
  const revAll = items.reduce((a, it) => a + pays(it).reduce((x, p) => x + (Number(p.amount) || 0), 0), 0);
  const generated = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'full', timeStyle: 'short' });
  const rows = items
    .map((it) => {
      const st = statusOf(it);
      const left = it.done ? '' : it.expiresAt <= Date.now() ? `lewat ${Math.abs(daysLeft(it)) || 0} hari` : `${daysLeft(it)} hari lagi`;
      const wa = waLink(it.contact);
      return `<tr data-status="${st.key}" data-search="${esc([it.id, it.email, it.buyer, it.contact, it.source, it.note].join(' ').toLowerCase())}">
<td><span class="badge ${st.key}">${st.emoji} ${esc(st.key === 'done' ? 'Selesai' : st.key === 'expired' ? 'Habis' : st.key === 'soon' ? 'Mau Habis' : 'Aktif')}</span></td>
<td class="mono">${esc(it.id)}${it.origin === 'discord' ? ' <span class="tag">Discord</span>' : ''}</td>
<td><div class="email"><span class="mono">${esc(it.email)}</span><button class="copy" data-copy="${esc(it.email)}" title="Salin email">⧉</button></div></td>
<td>${esc(it.buyer || (it.buyerId ? `Discord ${it.buyerId}` : '-'))}</td>
<td>${it.contact ? (wa ? `<a href="${esc(wa)}" target="_blank" rel="noopener">${esc(it.contact)}</a>` : esc(it.contact)) : '<span class="muted">-</span>'}</td>
<td>${esc(it.source || '-')}</td>
<td class="plan">${esc(it.plan)}</td>
<td data-sort="${it.startAt}">${esc(dmy(it.startAt))}</td>
<td data-sort="${it.expiresAt}"><b>${esc(dmy(it.expiresAt))}</b><div class="muted small">${esc(left)}</div></td>
<td data-sort="${Number(it.price) || 0}" class="num">${it.price ? esc(rupiah(it.price)) : '<span class="muted">-</span>'}</td>
<td class="note">${esc(it.note || '')}</td>
</tr>`;
    })
    .join('\n');
  return `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Canva Manager — ${esc(guildName)}</title>
<style>
:root{--bg:#f4f6fa;--card:#fff;--text:#1d2433;--muted:#6b7385;--line:#e4e8f0;--brand:#3498db;--ok:#2ecc71;--warn:#f1c40f;--bad:#e74c3c;--done:#95a5a6}
@media(prefers-color-scheme:dark){:root{--bg:#15171c;--card:#1e2128;--text:#e6e9ef;--muted:#9aa2b1;--line:#2c313b}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:14px}
.wrap{max-width:1280px;margin:0 auto;padding:24px 16px 48px}
.hero{background:linear-gradient(135deg,#1f6fb2,#3498db 60%,#5dade2);color:#fff;border-radius:18px;padding:24px 26px;display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap}
.hero h1{margin:0 0 4px;font-size:26px}.hero p{margin:0;opacity:.9}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:16px 0}
.stat{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px;cursor:pointer;transition:.15s}
.stat:hover,.stat.on{border-color:var(--brand);box-shadow:0 0 0 2px color-mix(in srgb,var(--brand) 25%,transparent)}
.stat .k{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.06em}.stat .v{font-size:24px;font-weight:700;margin-top:4px}
.bar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:8px 0 12px}
.bar input{flex:1;min-width:220px;padding:11px 14px;border-radius:12px;border:1px solid var(--line);background:var(--card);color:var(--text);font-size:14px}
.count{color:var(--muted)}
.table{background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:auto}
table{border-collapse:collapse;width:100%;min-width:1050px}
th,td{padding:11px 12px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{position:sticky;top:0;background:var(--card);font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);cursor:pointer;user-select:none;white-space:nowrap}
th:hover{color:var(--brand)}tr:hover td{background:color-mix(in srgb,var(--brand) 6%,transparent)}
.badge{display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:600;white-space:nowrap}
.badge.active{background:color-mix(in srgb,var(--ok) 18%,transparent);color:var(--ok)}
.badge.soon{background:color-mix(in srgb,var(--warn) 22%,transparent);color:#b7950b}
.badge.expired{background:color-mix(in srgb,var(--bad) 18%,transparent);color:var(--bad)}
.badge.done{background:color-mix(in srgb,var(--done) 22%,transparent);color:var(--muted)}
.tag{font-size:10px;background:#5865f2;color:#fff;border-radius:4px;padding:1px 5px;margin-left:4px;font-family:inherit}
.mono{font-family:Consolas,"SFMono-Regular",monospace;font-size:13px}.muted{color:var(--muted)}.small{font-size:12px}.num{text-align:right;white-space:nowrap}
.email{display:flex;gap:6px;align-items:center}.copy{border:1px solid var(--line);background:transparent;color:var(--muted);border-radius:6px;cursor:pointer;padding:1px 6px}
.copy:hover{color:var(--brand);border-color:var(--brand)}.note{max-width:220px;color:var(--muted)}
td[data-sort],td.plan{white-space:nowrap}
a{color:var(--brand);text-decoration:none}a:hover{text-decoration:underline}
.foot{margin-top:18px;color:var(--muted);text-align:center;font-size:12px}
.toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#1d2433;color:#fff;padding:9px 16px;border-radius:10px;opacity:0;transition:.2s}.toast.show{opacity:1}
</style></head><body><div class="wrap">
<div class="hero"><div><h1>🎨 Canva Manager</h1><p>${esc(guildName)} • Laporan Pelanggan Canva Pro</p></div><div class="small">Dibuat ${esc(generated)} WIB</div></div>
<div class="grid">
<div class="stat on" data-f="all"><div class="k">🗂️ Semua</div><div class="v">${num(items.length)}</div></div>
<div class="stat" data-f="active"><div class="k">🟢 Aktif</div><div class="v">${num(count.active)}</div></div>
<div class="stat" data-f="soon"><div class="k">🟡 Mau Habis</div><div class="v">${num(count.soon)}</div></div>
<div class="stat" data-f="expired"><div class="k">🔴 Habis</div><div class="v">${num(count.expired)}</div></div>
<div class="stat" data-f="done"><div class="k">✅ Selesai</div><div class="v">${num(count.done)}</div></div>
<div class="stat" data-f="none"><div class="k">💰 Bulan Ini</div><div class="v" style="font-size:18px">${esc(rupiah(revMonth))}</div><div class="muted small">Total ${esc(rupiah(revAll))}</div></div>
</div>
<div class="bar"><input id="q" placeholder="🔎 Cari email, nama, kontak, ID, catatan..." autocomplete="off"><span class="count" id="count"></span></div>
<div class="table"><table id="t"><thead><tr>
<th>Status</th><th>ID</th><th>Email</th><th>Pembeli</th><th>Kontak</th><th>Sumber</th><th>Paket</th><th data-type="n">Mulai</th><th data-type="n">Habis ▲</th><th data-type="n">Harga</th><th>Catatan</th>
</tr></thead><tbody>
${rows || '<tr><td colspan="11" class="muted" style="text-align:center;padding:30px">Belum ada data.</td></tr>'}
</tbody></table></div>
<div class="foot">Noname Store • Canva Manager • Klik kartu ringkasan untuk filter, klik judul kolom untuk mengurutkan</div>
</div><div class="toast" id="toast">Email disalin ✓</div>
<script>
const rows=[...document.querySelectorAll('#t tbody tr[data-status]')];let f='all';
function apply(){const q=document.getElementById('q').value.toLowerCase().trim();let n=0;for(const r of rows){const ok=(f==='all'||r.dataset.status===f)&&(!q||r.dataset.search.includes(q));r.style.display=ok?'':'none';if(ok)n++}document.getElementById('count').textContent=n+' data'}
document.getElementById('q').addEventListener('input',apply);
document.querySelectorAll('.stat[data-f]').forEach(s=>s.addEventListener('click',()=>{if(s.dataset.f==='none')return;f=s.dataset.f;document.querySelectorAll('.stat').forEach(x=>x.classList.toggle('on',x===s));apply()}));
document.querySelectorAll('th').forEach((th,i)=>{let asc=true;th.addEventListener('click',()=>{const tb=th.closest('table').tBodies[0];const num=th.dataset.type==='n';
const val=r=>{const c=r.children[i];return num?Number(c.dataset.sort||0):c.textContent.trim().toLowerCase()};
rows.sort((a,b)=>(val(a)>val(b)?1:val(a)<val(b)?-1:0)*(asc?1:-1));rows.forEach(r=>tb.appendChild(r));
document.querySelectorAll('th').forEach(x=>x.textContent=x.textContent.replace(/ [▲▼]$/,''));th.textContent+=asc?' ▲':' ▼';asc=!asc})});
document.querySelectorAll('.copy').forEach(b=>b.addEventListener('click',()=>{navigator.clipboard?.writeText(b.dataset.copy);const t=document.getElementById('toast');t.classList.add('show');setTimeout(()=>t.classList.remove('show'),1200)}));
apply();
</script></body></html>`;
}

// ───────────────────────── Register & command ─────────────────────────
function registerCanvaManager(c) {
  client = c;
  c.on(Events.InteractionCreate, (i) => {
    if (typeof i.customId === 'string' && i.customId.startsWith('cv:')) handleInteraction(i);
  });
  c.once(Events.ClientReady, () => {
    refreshDashboard().catch(() => {});
    setTimeout(() => checkReminders(), 20000);
    setInterval(() => checkReminders(), 10 * 60000); // cek pengingat tiap 10 menit
    setInterval(() => refreshDashboard().catch(() => {}), 30 * 60000); // perbarui dashboard (order Discord baru, status)
  });
}

const canvaCommand = {
  data: new SlashCommandBuilder()
    .setName('canva')
    .setDescription('Canva Manager — pelanggan Canva Pro & pengingat masa aktif (khusus admin)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addSubcommand((s) =>
      s
        .setName('tambah')
        .setDescription('Tambah pelanggan Canva Pro (dari WhatsApp / luar Discord)')
        .addStringOption((o) => o.setName('email').setDescription('Email Canva pembeli').setRequired(true).setMaxLength(120))
        .addStringOption((o) => o.setName('pembeli').setDescription('Nama pembeli').setRequired(true).setMaxLength(60))
        .addStringOption((o) =>
          o.setName('paket').setDescription('Paket').setRequired(true).addChoices(...PLANS.map((p) => ({ name: `${p.label} (${p.days} hari)`, value: p.id }))),
        )
        .addStringOption((o) => o.setName('kontak').setDescription('No. WA / username').setMaxLength(60))
        .addIntegerOption((o) => o.setName('harga').setDescription('Harga jual (Rp)').setMinValue(0))
        .addStringOption((o) => o.setName('mulai').setDescription('Tanggal mulai DD-MM-YYYY (default: hari ini)').setMaxLength(10))
        .addIntegerOption((o) => o.setName('hari').setDescription('Durasi custom (hari) — menggantikan paket').setMinValue(1).setMaxValue(1000))
        .addStringOption((o) => o.setName('sumber').setDescription('Sumber pembelian').addChoices(...SOURCES.map((s) => ({ name: s, value: s }))))
        .addStringOption((o) => o.setName('catatan').setDescription('Catatan').setMaxLength(300)),
    )
    .addSubcommand((s) =>
      s
        .setName('panel')
        .setDescription('Kirim / pindahkan dashboard Canva Manager')
        .addChannelOption((o) => o.setName('channel').setDescription('Default: channelId di canva-manager.json').addChannelTypes(ChannelType.GuildText)),
    )
    .addSubcommand((s) =>
      s
        .setName('cari')
        .setDescription('Cari pelanggan (email / nama / kontak / ID)')
        .addStringOption((o) => o.setName('kata').setDescription('Kata kunci').setRequired(true).setMinLength(2).setMaxLength(80)),
    )
    .addSubcommand((s) =>
      s
        .setName('export')
        .setDescription('Download semua data pelanggan (laporan HTML untuk browser / CSV untuk Excel)')
        .addStringOption((o) =>
          o
            .setName('format')
            .setDescription('Default: HTML + CSV')
            .addChoices({ name: '🌐 HTML (buka di browser)', value: 'html' }, { name: '📊 CSV (Excel / Google Sheets)', value: 'csv' }, { name: '📦 Keduanya', value: 'both' }),
        ),
    )
    .addSubcommand((s) => s.setName('cek-pengingat').setDescription('Cek & kirim pengingat sekarang')),
  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const cfg = loadConfig();
    if (sub === 'tambah') {
      const email = interaction.options.getString('email').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return interaction.reply({ content: '❌ Format email tidak valid.', flags: EPH });
      const mulai = interaction.options.getString('mulai');
      const startAt = mulai ? parseDate(mulai) : null;
      if (mulai && !startAt) return interaction.reply({ content: '❌ Format tanggal salah. Contoh: `20-10-2026`.', flags: EPH });
      const e = createEntry({
        email,
        buyer: interaction.options.getString('pembeli'),
        contact: interaction.options.getString('kontak'),
        planId: interaction.options.getString('paket'),
        days: interaction.options.getInteger('hari'),
        price: interaction.options.getInteger('harga'),
        startAt,
        source: interaction.options.getString('sumber'),
        note: interaction.options.getString('catatan'),
        by: interaction.user.id,
      });
      return interaction.reply(manageCard(getItem(`m_${e.id}`), '🆕 Pelanggan berhasil ditambahkan'));
    }
    if (sub === 'panel') {
      await interaction.deferReply({ flags: EPH });
      const channel =
        interaction.options.getChannel('channel') || (isId(cfg.channelId) ? await interaction.guild.channels.fetch(cfg.channelId).catch(() => null) : null) || interaction.channel;
      if (!channel?.isTextBased()) return interaction.editReply('❌ Channel tidak ditemukan.');
      const old = data.dashboard;
      const sent = await channel.send(buildDashboard(interaction.guild));
      data.dashboard = { channelId: channel.id, messageId: sent.id };
      save();
      if (old && old.messageId !== sent.id) {
        const oldCh = await interaction.guild.channels.fetch(old.channelId).catch(() => null);
        await oldCh?.messages.delete(old.messageId).catch(() => {});
      }
      return interaction.editReply(`✅ Dashboard **Canva Manager** dikirim ke ${channel}. Pengingat juga dikirim ke ${isId(cfg.channelId) ? `<#${cfg.channelId}>` : 'channel di canva-manager.json'}.`);
    }
    if (sub === 'cari') return interaction.reply(searchResult(interaction.options.getString('kata')));
    if (sub === 'export') {
      const format = interaction.options.getString('format') || 'both';
      const name = `canva-pelanggan-${dmy(Date.now())}`;
      const files = [];
      if (format !== 'csv') files.push(new AttachmentBuilder(Buffer.from(toHtml(interaction.guild?.name), 'utf8'), { name: `${name}.html` }));
      if (format !== 'html') files.push(new AttachmentBuilder(Buffer.from(toCsv(), 'utf8'), { name: `${name}.csv` }));
      return interaction.reply({
        content:
          `📦 Data **${num(allItems().length)} pelanggan** Canva Pro.` +
          (format !== 'csv' ? '\n🌐 **.html** → download lalu buka di browser (bisa cari, filter status, urutkan kolom, salin email).' : '') +
          (format !== 'html' ? '\n📊 **.csv** → buka di Excel / Google Sheets.' : ''),
        files,
        flags: EPH,
      });
    }
    if (sub === 'cek-pengingat') {
      await interaction.deferReply({ flags: EPH });
      const n = await checkReminders({ force: true });
      return interaction.editReply(n ? `✅ **${n} pengingat** dikirim ke <#${cfg.channelId}>.` : '✅ Tidak ada pengingat yang perlu dikirim saat ini.');
    }
  },
};

module.exports = { registerCanvaManager, canvaCommand, buildDashboard, handleInteraction, checkReminders, allItems, createEntry };
