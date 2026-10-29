const fs = require('fs');
const path = require('path');
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  LabelBuilder,
  TextInputBuilder,
  TextInputStyle,
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
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
} = require('discord.js');
const UI = require('./ui');
const giveaway = require('./giveaway');
const { archiveNcsTicket } = require('./ticket-archive');

/**
 * NCS Ticket Center — ticket layanan (Support, Claim Giveaway, ...), terpisah dari ticket jualan.
 * Panel dropdown → form → channel ticket otomatis → staff menangani → tutup + transcript.
 * Pengaturan di tickets.json.
 */
const FILE = path.join(__dirname, '..', 'tickets.json');
const DATA = path.join(__dirname, '..', 'data', 'support-tickets.json');
const EPH = MessageFlags.Ephemeral;
const isId = (v) => /^\d{17,20}$/.test(String(v || ''));
const ts = (ms, s = 'f') => `<t:${Math.floor(ms / 1000)}:${s}>`;
let client = null;

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (err) {
    console.error('[ticket] tickets.json tidak bisa dibaca:', err.message);
    return { types: [] };
  }
}
function loadData() {
  try {
    return { seq: {}, tickets: {}, panel: null, ...JSON.parse(fs.readFileSync(DATA, 'utf8')) };
  } catch {
    return { seq: {}, tickets: {}, panel: null };
  }
}
const data = loadData();
function save() {
  fs.mkdirSync(path.dirname(DATA), { recursive: true });
  fs.writeFileSync(`${DATA}.tmp`, JSON.stringify(data, null, 2));
  fs.renameSync(`${DATA}.tmp`, DATA);
}
const brand = (cfg) => {
  const n = parseInt(String(cfg.color || '').replace('#', ''), 16);
  return Number.isNaN(n) ? 0x3498db : n;
};
const footer = (guild, text) => ({ text: text || guild.name, iconURL: guild.iconURL({ extension: 'png', size: 128 }) || undefined });
/** Baca isian form yang opsional dengan aman (kosong / tidak ada → ''). */
const optional = (fields, id) => {
  try {
    return (fields.getTextInputValue(id) || '').trim();
  } catch {
    return '';
  }
};
const typeOf = (cfg, id) => (cfg.types || []).find((t) => t.id === id) || null;
const staffRole = (cfg) => (isId(cfg.staffRoleId) ? cfg.staffRoleId : null);
const isStaff = (member, cfg) =>
  member?.permissions?.has(PermissionFlagsBits.Administrator) || (staffRole(cfg) && member?.roles?.cache?.has(staffRole(cfg)));

// ───────────────────────── Panel ─────────────────────────
/**
 * Panel memakai Components V2 → garis pemisah (separator) selalu pas sampai ujung kotak di HP & laptop.
 */
function buildPanel(guild, cfg) {
  const p = cfg.panel || {};
  const types = (cfg.types || []).filter((t) => t.enabled !== false);
  const open = Object.values(data.tickets).filter((t) => t.status === 'open').length;
  const line = () => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
  const text = (content) => new TextDisplayBuilder().setContent(String(content).slice(0, 4000));

  const box = UI.accent(new ContainerBuilder(), brand(cfg));
  const header = `# ${p.title || '🎫 NCS Ticket Center'}\n${p.description || ''}`;
  const icon = guild.iconURL({ extension: 'png', size: 256 });
  if (icon) {
    box.addSectionComponents(new SectionBuilder().addTextDisplayComponents(text(header)).setThumbnailAccessory(new ThumbnailBuilder().setURL(icon)));
  } else {
    box.addTextDisplayComponents(text(header));
  }
  if (p.bannerImage) box.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(p.bannerImage)));

  if (types.length) {
    box.addSeparatorComponents(line());
    box.addTextDisplayComponents(
      text(
        '### 📂 Jenis Ticket\n' +
          types.map((t) => `${t.emoji || '🎫'} **${t.label}**${t.comingSoon ? ' `SEGERA`' : ''}\n┗ ${t.description || '-'}`).join('\n'),
      ),
    );
  }
  if (p.notes?.length) {
    box.addSeparatorComponents(line()); // garis sebelum "Sebelum Membuka Ticket"
    box.addTextDisplayComponents(text(`### 📌 Sebelum Membuka Ticket\n${p.notes.map((x) => `▸ ${x}`).join('\n')}`));
  }
  box.addSeparatorComponents(line());
  box.addTextDisplayComponents(text(`🟢 **Ticket Aktif:** \`${open} ticket\`　•　⏱️ **Respon:** \`Secepatnya\``));

  const select = new StringSelectMenuBuilder()
    .setCustomId('st:open')
    .setPlaceholder(p.placeholder || '📂 Pilih jenis ticket...')
    .addOptions(
      (types.length ? types : [{ id: 'none', label: 'Belum ada layanan', comingSoon: true }]).slice(0, 25).map((t) => ({
        label: `${t.label}${t.comingSoon ? ' (Segera Hadir)' : ''}`.slice(0, 100),
        description: (t.description || '').slice(0, 100) || undefined,
        value: t.id,
        emoji: t.emoji || '🎫',
      })),
    );
  box.addActionRowComponents(new ActionRowBuilder().addComponents(select));
  return { components: [box], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } };
}

async function refreshPanel() {
  const loc = data.panel;
  if (!client || !loc) return;
  const ch = await client.channels.fetch(loc.channelId).catch(() => null);
  if (!ch?.guild) return;
  await ch.messages.edit(loc.messageId, buildPanel(ch.guild, loadConfig())).catch(() => {});
}

// ───────────────────────── Jenis hadiah (claim giveaway) ─────────────────────────
const DEFAULT_REWARDS = [
  { id: 'robux', label: 'Robux', emoji: '💎', description: 'Robux Roblox — dikirim ke akun Roblox', keywords: ['robux', 'rbx', 'gamepass', 'roblox'] },
  { id: 'ewallet', label: 'E-Wallet', emoji: '📱', description: 'DANA, OVO, GoPay, ShopeePay, dll.', keywords: ['dana', 'ovo', 'gopay', 'shopee', 'e-wallet', 'ewallet', 'linkaja', 'saldo'] },
  { id: 'cash', label: 'Uang Tunai (Transfer Bank)', emoji: '💵', description: 'Transfer ke rekening bank', keywords: ['rp', 'uang', 'cash', 'tunai', 'transfer', 'bank', 'rupiah'] },
  { id: 'pulsa', label: 'Pulsa / Kuota', emoji: '📶', description: 'Pulsa atau paket data ke nomor HP', keywords: ['pulsa', 'kuota', 'paket data'] },
  { id: 'digital', label: 'Produk Digital', emoji: '🎨', description: 'Canva Pro, Nitro, akun premium, dll.', keywords: ['canva', 'nitro', 'premium', 'spotify', 'netflix', 'akun'] },
  { id: 'voucher', label: 'Voucher / Game Item', emoji: '🎟️', description: 'Voucher game, item, skin, top up game lain', keywords: ['voucher', 'item', 'skin', 'diamond', 'uc', 'top up'] },
  { id: 'other', label: 'Lainnya', emoji: '🎁', description: 'Hadiah lain — jelaskan di data penerimaan', keywords: [] },
];
const rewardTypes = () => {
  const list = loadConfig().claimRewardTypes;
  return (Array.isArray(list) && list.length ? list : DEFAULT_REWARDS).slice(0, 25).map((r) => ({ emoji: '🎁', description: '', keywords: [], ...r }));
};
const rewardOf = (id) => rewardTypes().find((r) => r.id === id) || { id, label: id || '-', emoji: '🎁' };
function guessRewardType(prize) {
  const p = String(prize || '').toLowerCase();
  // Cek yang paling spesifik dulu (e-wallet sebelum uang tunai karena "Saldo DANA Rp 50.000" juga mengandung "rp").
  for (const r of rewardTypes()) if ((r.keywords || []).some((k) => p.includes(String(k).toLowerCase()))) return r.id;
  return null;
}

// ───────────────────────── 👑 Bantuan Premium App ─────────────────────────
const INSTANT_HELP = 'instant-help';
const DEFAULT_ISSUES = [
  { id: 'login', label: 'Akun tidak bisa login', emoji: '🔐' },
  { id: 'password', label: 'Email / password salah', emoji: '🔑' },
  { id: 'expired', label: 'Akun expired / kena limit', emoji: '⌛' },
  { id: 'not-received', label: 'Sudah bayar, akun belum diterima', emoji: '📭' },
  { id: 'warranty', label: 'Klaim garansi / minta pengganti', emoji: '🛡️' },
  { id: 'other', label: 'Lainnya', emoji: '💬' },
];
const instantIssues = () => {
  const list = loadConfig().instantIssues;
  return (Array.isArray(list) && list.length ? list : DEFAULT_ISSUES).slice(0, 25);
};
/** Pesanan Premium App milik member (terbaru dulu). */
function instantOrdersOf(userId) {
  try {
    const { state } = require('./store/state');
    return Object.values(state.tickets || {})
      .filter((t) => t.kind === 'instant' && t.userId === userId && ['open', 'completed'].includes(t.status))
      .sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}
/** Status garansi pesanan Premium App. */
function warrantyOf(o) {
  const i = o?.ins || {};
  if (o.status !== 'completed') return { state: 'pending', text: '`⏳ Pesanan belum selesai`' };
  if (i.noWarranty) return { state: 'none', text: '`⚠️ Tanpa Garansi`' };
  if (!i.warrantyDays) return { state: 'unknown', text: '`🛡️ Sesuai S&K produk`' };
  const until = (i.deliveredAt || o.closedAt) + i.warrantyDays * 86400000;
  return until > Date.now()
    ? { state: 'active', text: `\`✅ Aktif\` sampai ${ts(until, 'D')} (${ts(until, 'R')})`, until }
    : { state: 'expired', text: `\`❌ Habis\` sejak ${ts(until, 'D')}`, until };
}
const orderLabel = (o) => `${o.id} • ${o.ins?.product || o.productLabel} ${o.ins?.variant ? `— ${o.ins.variant}` : ''}`.slice(0, 100);

// ───────────────────────── Form ─────────────────────────
function buildForm(type, userId) {
  const modal = new ModalBuilder().setCustomId(`st:form:${type.id}`).setTitle(`${type.label}`.slice(0, 45));
  if (type.id === INSTANT_HELP) {
    const orders = instantOrdersOf(userId).slice(0, 25);
    const first = orders.length
      ? new LabelBuilder()
          .setLabel('Pesanan yang Bermasalah')
          .setDescription('Pilih pesanan Premium App kamu.')
          .setStringSelectMenuComponent(
            new StringSelectMenuBuilder()
              .setCustomId('order')
              .setPlaceholder('Pilih pesanan...')
              .setRequired(true)
              .addOptions(
                orders.map((o, i) => {
                  const w = warrantyOf(o);
                  return {
                    label: orderLabel(o),
                    value: o.id,
                    description: `${new Date(o.createdAt).toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta' })} • ${{ active: 'Garansi aktif', expired: 'Garansi habis', none: 'Tanpa garansi', pending: 'Belum selesai', unknown: 'Garansi sesuai S&K' }[w.state]}`.slice(0, 100),
                    emoji: { active: '🛡️', expired: '⌛', none: '⚠️', pending: '⏳', unknown: '📦' }[w.state],
                    default: orders.length === 1 && i === 0,
                  };
                }),
              ),
          )
      : new LabelBuilder()
          .setLabel('ID Pesanan')
          .setDescription('Contoh: PA-0001 (ada di DM / ticket pesananmu).')
          .setTextInputComponent(new TextInputBuilder().setCustomId('ordertext').setStyle(TextInputStyle.Short).setPlaceholder('PA-0001').setMaxLength(30).setRequired(true));
    modal.addLabelComponents(
      first,
      new LabelBuilder()
        .setLabel('Jenis Kendala')
        .setStringSelectMenuComponent(
          new StringSelectMenuBuilder()
            .setCustomId('issue')
            .setPlaceholder('Pilih jenis kendala...')
            .setRequired(true)
            .addOptions(instantIssues().map((x) => ({ label: String(x.label).slice(0, 100), value: String(x.id), emoji: x.emoji || '💬' }))),
        ),
      new LabelBuilder()
        .setLabel('Jelaskan Kendalamu')
        .setDescription('Kirim screenshot error di ticket setelah dibuat.')
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId('detail')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('contoh: Login Netflix muncul "password salah" sejak tadi pagi.')
            .setMinLength(10)
            .setMaxLength(1000)
            .setRequired(true),
        ),
    );
    return modal;
  }
  if (type.id === 'claim-giveaway') {
    const wins = giveaway.winsOf ? giveaway.winsOf(userId).slice(0, 25) : [];
    const first = wins.length
      ? new LabelBuilder()
          .setLabel('Giveaway yang Dimenangkan')
          .setStringSelectMenuComponent(
            new StringSelectMenuBuilder()
              .setCustomId('gaid')
              .setPlaceholder('Pilih giveaway...')
              .setRequired(true)
              .addOptions(wins.map((g, i) => ({ label: `${g.id} • ${g.prize}`.slice(0, 100), value: g.id, emoji: '🎁', default: wins.length === 1 && i === 0 }))),
          )
      : new LabelBuilder()
          .setLabel('ID Giveaway / Nama Hadiah')
          .setDescription('Contoh: GA-0001 atau Saldo DANA Rp 50.000')
          .setTextInputComponent(new TextInputBuilder().setCustomId('gatext').setStyle(TextInputStyle.Short).setMaxLength(100).setRequired(true));
    // Tebak jenis hadiah dari nama hadiah giveaway terbaru (pemenang tetap bisa mengganti).
    const guess = wins[0] ? guessRewardType(wins[0].prize) : null;
    modal.addLabelComponents(
      first,
      new LabelBuilder()
        .setLabel('Jenis Hadiah')
        .setDescription('Pilih sesuai hadiah yang kamu menangkan.')
        .setStringSelectMenuComponent(
          new StringSelectMenuBuilder()
            .setCustomId('rtype')
            .setPlaceholder('Pilih jenis hadiah...')
            .setRequired(true)
            .addOptions(
              rewardTypes().map((r) => ({ label: r.label, description: r.description.slice(0, 100), value: r.id, emoji: r.emoji, default: r.id === guess })),
            ),
        ),
      new LabelBuilder()
        .setLabel('Data Penerimaan Hadiah')
        .setDescription('Robux: username Roblox • Bank: bank + no. rekening • E-Wallet: jenis + no. HP')
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId('receiver')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('contoh: DANA 0812xxxxxxx  /  BCA 1234567890  /  Roblox: Builderman')
            .setMaxLength(300)
            .setRequired(true),
        ),
      new LabelBuilder()
        .setLabel('Nama Penerima (a.n.)')
        .setDescription('Wajib untuk uang tunai / e-wallet, sesuai nama di rekening / akun.')
        .setTextInputComponent(new TextInputBuilder().setCustomId('holder').setStyle(TextInputStyle.Short).setPlaceholder('contoh: Ahmad Saputra').setMaxLength(100).setRequired(false)),
      new LabelBuilder()
        .setLabel('Catatan (opsional)')
        .setTextInputComponent(new TextInputBuilder().setCustomId('note').setStyle(TextInputStyle.Paragraph).setMaxLength(500).setRequired(false)),
    );
  } else {
    modal.addLabelComponents(
      new LabelBuilder()
        .setLabel('Topik')
        .setDescription('Ringkasan singkat kendalamu.')
        .setTextInputComponent(
          new TextInputBuilder().setCustomId('topic').setStyle(TextInputStyle.Short).setPlaceholder('contoh: Pesanan belum masuk').setMinLength(3).setMaxLength(100).setRequired(true),
        ),
      new LabelBuilder()
        .setLabel('Jelaskan Kendalamu')
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId('detail')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('Ceritakan detail kendalamu agar tim kami bisa membantu lebih cepat.')
            .setMinLength(10)
            .setMaxLength(1000)
            .setRequired(true),
        ),
    );
  }
  return modal;
}

// ───────────────────────── Ticket ─────────────────────────
function buildTicketMessageLegacy(guild, cfg, t) {
  const type = typeOf(cfg, t.type) || { label: t.type, emoji: '🎫' };
  const closed = t.status !== 'open';
  const e = new EmbedBuilder()
    .setColor(closed ? 0x95a5a6 : brand(cfg))
    .setAuthor({ name: `${guild.name} • NCS Ticket Center`, iconURL: guild.iconURL({ size: 128 }) || undefined })
    .setTitle(`${type.emoji || '🎫'} ${type.label} • ${t.id}`)
    .setDescription(type.welcome || 'Tim kami akan segera membantumu.')
    .setThumbnail(t.avatar || guild.iconURL({ extension: 'png', size: 256 }) || null)
    .addFields(
      { name: '👤 Dibuka Oleh', value: `<@${t.userId}>`, inline: true },
      { name: '📂 Jenis', value: `\`${type.label}\``, inline: true },
      { name: '🕒 Dibuat', value: ts(t.createdAt, 'R'), inline: true },
    );
  for (const [k, v] of t.answers || []) e.addFields({ name: k, value: String(v).slice(0, 1024) || '-' });
  if (t.verified != null) {
    e.addFields({ name: '🔎 Verifikasi Pemenang', value: t.verified ? '`✅ Terverifikasi sebagai pemenang`' : '`⚠️ Tidak ditemukan di data giveaway — cek manual`' });
  }
  e.addFields({
    name: '📌 Status',
    value: closed ? `\`🔒 Ditutup\` ${t.closedAt ? ts(t.closedAt, 'R') : ''}` : t.claimedBy ? `\`🙋 Ditangani\` oleh <@${t.claimedBy}>` : '`⏳ Menunggu Staff`',
    inline: true,
  });
  e.setFooter(footer(guild, `NCS Ticket Center • ${t.id}`)).setTimestamp(t.createdAt);

  const components = closed
    ? []
    : [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`st:claim:${t.id}`)
            .setLabel(t.claimedBy ? 'Sudah Ditangani' : 'Tangani Ticket (Staff)')
            .setEmoji('🙋')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(Boolean(t.claimedBy)),
          new ButtonBuilder().setCustomId(`st:close:${t.id}`).setLabel('Tutup Ticket').setEmoji('🔒').setStyle(ButtonStyle.Danger),
        ),
      ];
  return { embeds: [e], components, allowedMentions: { parse: [] } };
}


// ───────────────────────── Pesan ticket (Components V2) ─────────────────────────
const v2text = (c) => new TextDisplayBuilder().setContent(String(c).slice(0, 4000));
const v2line = () => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
const V2 = MessageFlags.IsComponentsV2;
const isV2Msg = (m) => Boolean(m?.flags?.has?.(V2));

/** Kotak V2 sederhana untuk pesan-pesan di dalam ticket. */
function card({ color, header, thumb, blocks = [], footer: foot, rows = [], top }) {
  const box = UI.accent(new ContainerBuilder(), color);
  if (thumb) box.addSectionComponents(new SectionBuilder().addTextDisplayComponents(v2text(header)).setThumbnailAccessory(new ThumbnailBuilder().setURL(thumb)));
  else box.addTextDisplayComponents(v2text(header));
  for (const b of blocks.filter(Boolean)) {
    box.addSeparatorComponents(v2line());
    box.addTextDisplayComponents(v2text(b));
  }
  if (foot) {
    box.addSeparatorComponents(v2line());
    box.addTextDisplayComponents(v2text(`-# ${foot}`));
  }
  for (const r of rows.filter(Boolean)) box.addActionRowComponents(r);
  return { components: top ? [v2text(top), box] : [box], flags: V2, allowedMentions: { parse: [] } };
}

function statusText(t) {
  if (t.status !== 'open') return `\`🔒 Ditutup\` ${t.closedAt ? ts(t.closedAt, 'R') : ''}`;
  if (t.delivered) return `\`🎁 Hadiah Terkirim\` ${ts(t.deliveredAt, 'R')}`;
  if (t.claimedBy) return `\`🙋 Ditangani\` oleh <@${t.claimedBy}>`;
  return '`⏳ Menunggu Staff`';
}

function buildTicketMessage(guild, cfg, t) {
  const type = typeOf(cfg, t.type) || { label: t.type, emoji: '🎫' };
  const closed = t.status !== 'open';
  const claim = t.type === 'claim-giveaway';
  const accent = closed ? 0x95a5a6 : t.delivered ? 0x2ecc71 : t.claimedBy ? 0x9b59b6 : brand(cfg);

  const info = [
    `**👤 Dibuka Oleh:** <@${t.userId}>`,
    `**📂 Jenis:** \`${type.label}\``,
    `**🕒 Dibuat:** ${ts(t.createdAt, 'f')} (${ts(t.createdAt, 'R')})`,
    `**📌 Status:** ${statusText(t)}`,
  ].join('\n');

  // Jawaban form: yang pendek digabung jadi baris, yang panjang / code block jadi blok sendiri.
  const short = [];
  const long = [];
  for (const [k, v] of t.answers || []) {
    const val = String(v || '-');
    if (val.includes('\n') || val.length > 120) long.push(`### ${k}\n${val}`);
    else short.push(`**${k}:** ${val}`);
  }
  const detailTitle = claim ? '### 🎁 Detail Klaim Hadiah' : '### 📋 Detail Ticket';
  const instantHelp = t.type === INSTANT_HELP;
  const verify =
    t.verified == null
      ? null
      : instantHelp
        ? t.verified
          ? '✅ **Pesanan terverifikasi** — pesanan ini milik member yang membuka ticket.'
          : '⚠️ **Pesanan tidak cocok** — tidak ditemukan / bukan milik member ini. Staff perlu **cek manual**.'
        : t.verified
        ? '✅ **Terverifikasi** — member ini tercatat sebagai **pemenang** giveaway tersebut.'
        : '⚠️ **Belum terverifikasi** — tidak ditemukan di data pemenang giveaway. Staff perlu **cek manual**.';
  const instantChecklist =
    instantHelp && !closed
      ? [
          '### 🛡️ Checklist Staff',
          `${t.warranty === 'active' ? '✅' : '▫️'} Cek status garansi (${{ active: 'aktif', expired: 'habis', none: 'tanpa garansi', pending: 'pesanan belum selesai', unknown: 'sesuai S&K' }[t.warranty] || 'cek manual'})`,
          `${t.claimedBy ? '✅' : '▫️'} Minta screenshot kendala & cek akun`,
          '▫️ Klaim ke pusat (Waroengkuy) / kirim akun pengganti',
          '▫️ Pastikan akun sudah normal, lalu tutup ticket',
        ].join('\n')
      : null;
  const checklist = claim && !closed
    ? [
        '### 🛡️ Checklist Staff',
        `${t.verified ? '✅' : '▫️'} Cek data pemenang giveaway`,
        `${t.claimedBy ? '✅' : '▫️'} Tangani ticket & cek data penerimaan`,
        `${t.delivered ? '✅' : '▫️'} Kirim hadiah lalu klik **🎁 Hadiah Terkirim**`,
        '▫️ Lampirkan bukti pengiriman & tutup ticket',
      ].join('\n')
    : null;

  const rows = [];
  if (!closed) {
    const buttons = [
      new ButtonBuilder()
        .setCustomId(`st:claim:${t.id}`)
        .setLabel(t.claimedBy ? 'Sudah Ditangani' : 'Tangani Ticket (Staff)')
        .setEmoji('🙋')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(Boolean(t.claimedBy)),
    ];
    if (claim) {
      buttons.push(
        new ButtonBuilder()
          .setCustomId(`st:deliver:${t.id}`)
          .setLabel(t.delivered ? 'Hadiah Terkirim' : 'Hadiah Terkirim (Staff)')
          .setEmoji('🎁')
          .setStyle(ButtonStyle.Success)
          .setDisabled(Boolean(t.delivered)),
      );
    }
    buttons.push(new ButtonBuilder().setCustomId(`st:close:${t.id}`).setLabel('Tutup Ticket').setEmoji('🔒').setStyle(ButtonStyle.Danger));
    rows.push(new ActionRowBuilder().addComponents(buttons));
  }

  return card({
    color: accent,
    thumb: t.avatar || guild.iconURL({ extension: 'png', size: 256 }),
    header: `-# ${guild.name} • NCS Ticket Center\n## ${type.emoji || '🎫'} ${type.label} • ${t.id}\n${type.welcome || 'Tim kami akan segera membantumu.'}`,
    blocks: [info, short.length || long.length ? [instantHelp ? '### 👑 Detail Kendala Premium App' : detailTitle, ...short].join('\n') : null, ...long, verify, checklist || instantChecklist],
    footer: `NCS Ticket Center • ${t.id} • ${ts(t.createdAt, 'f')}`,
    rows,
  });
}
/** Ticket lama (embed) tetap memakai tampilan lama; ticket baru memakai V2. */
const ticketPayloadFor = (msg, guild, cfg, t) => (msg && !isV2Msg(msg) ? buildTicketMessageLegacy(guild, cfg, t) : buildTicketMessage(guild, cfg, t));
async function editTicketMsg(channel, guild, cfg, t) {
  if (!channel || !t.messageId) return;
  const msg = await channel.messages.fetch(t.messageId).catch(() => null);
  if (msg) await msg.edit(ticketPayloadFor(msg, guild, cfg, t)).catch((e) => console.warn(`[ticket] edit ${t.id}:`, e.message));
}

async function createTicket(interaction, type, answers, extra = {}) {
  const cfg = loadConfig();
  const guild = interaction.guild;
  const prefix = type.prefix || type.id.slice(0, 3).toUpperCase();
  data.seq[type.id] = (data.seq[type.id] || 0) + 1;
  const id = `${prefix}-${String(data.seq[type.id]).padStart(4, '0')}`;
  const t = {
    id,
    type: type.id,
    guildId: guild.id,
    userId: interaction.user.id,
    avatar: interaction.user.displayAvatarURL({ extension: 'png', size: 256 }),
    answers,
    ...extra,
    status: 'open',
    createdAt: Date.now(),
  };

  // Kategori: tickets.json → categoryId, atau kategori channel panel (Customer Service).
  let parent = isId(cfg.categoryId) ? cfg.categoryId : null;
  if (!parent) {
    const panelCh = await guild.channels.fetch(cfg.panelChannelId || data.panel?.channelId || interaction.channelId).catch(() => null);
    parent = panelCh?.parentId || null;
  }
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
  if (staffRole(cfg)) overwrites.push({ id: staffRole(cfg), allow: member });
  const slug = interaction.user.username.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20);
  const channel = await guild.channels.create({
    name: `${type.emoji || '🎫'}・${id.toLowerCase()}-${slug}`,
    type: ChannelType.GuildText,
    parent: parent || undefined,
    topic: `${id} • ${type.label} • ${interaction.user.tag}`,
    permissionOverwrites: overwrites,
  });
  t.channelId = channel.id;
  const msg = await channel.send({
    ...buildTicketMessage(guild, cfg, t),
    components: [v2text(`<@${interaction.user.id}>${staffRole(cfg) ? ` <@&${staffRole(cfg)}>` : ''}`), ...buildTicketMessage(guild, cfg, t).components],
    allowedMentions: { users: [interaction.user.id], roles: staffRole(cfg) ? [staffRole(cfg)] : [] },
  });
  await msg.pin().catch(() => {});
  t.messageId = msg.id;
  data.tickets[id] = t;
  save();
  refreshPanel().catch(() => {});
  logTicket(guild, cfg, t, 'open').catch(() => {});
  historyLog(guild, t, '🆕 Ticket dibuka');
  return { t, channel };
}

// ───────────────────────── Tickets History (Components V2, 1 pesan per ticket) ─────────────────────────
const historyQueues = new Map();
const HSTATUS = {
  waiting: { text: '⏳ Menunggu Staff', color: 0x3498db },
  claimed: { text: '🙋 Sedang Ditangani', color: 0x9b59b6 },
  closed: { text: '✅ Selesai', color: 0x2ecc71 },
};
const hline = () => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
const htext = (c) => new TextDisplayBuilder().setContent(String(c).slice(0, 4000));
const hrow = (label, value) => `» **${label} :** ${value}`;

function buildHistoryCard(guild, cfg, t) {
  const type = typeOf(cfg, t.type) || { label: t.type, emoji: '🎫' };
  const st = t.status !== 'open' ? HSTATUS.closed : t.claimedBy ? HSTATUS.claimed : HSTATUS.waiting;
  const h = cfg.history || {};
  const box = UI.accent(new ContainerBuilder(), st.color);
  box.addTextDisplayComponents(htext(`## ${type.emoji || '🎫'} ${t.id} • ${st.text}\n-# Tickets History`));
  box.addSeparatorComponents(hline());

  const info = [hrow('Jenis', `\`${type.label}\``), hrow('Dibuka Oleh', `<@${t.userId}>`)];
  info.push(hrow('Ditangani', t.claimedBy ? `<@${t.claimedBy}>` : '`Belum ada`'));
  if (t.giveawayId) info.push(hrow('Giveaway', `\`${t.giveawayId}\``));
  if (h.showTopic !== false) {
    const topic = (t.answers || []).find(([k]) => /Topik/.test(k));
    if (topic) info.push(hrow('Topik', topic[1]));
  }
  const thumb = t.avatar || guild.iconURL({ extension: 'png', size: 256 });
  if (thumb) box.addSectionComponents(new SectionBuilder().addTextDisplayComponents(htext(info.join('\n'))).setThumbnailAccessory(new ThumbnailBuilder().setURL(thumb)));
  else box.addTextDisplayComponents(htext(info.join('\n')));

  const time = [hrow('Status', `**${st.text}**`), hrow('Dibuka', ts(t.createdAt, 'f'))];
  if (t.claimedAt) time.push(hrow('Respon Staff', `\`${duration(t.claimedAt - t.createdAt)}\``));
  if (t.closedAt) {
    time.push(hrow('Ditutup', ts(t.closedAt, 'f')), hrow('Durasi', `\`${duration(t.closedAt - t.createdAt)}\``));
    if (t.closedBy) time.push(hrow('Ditutup Oleh', `<@${t.closedBy}>`));
    if (t.closeReason && h.showCloseReason !== false) time.push(hrow('Alasan', t.closeReason.slice(0, 200)));
  }
  box.addSeparatorComponents(hline());
  box.addTextDisplayComponents(htext(time.join('\n')));

  const timeline = (t.history || []).slice(-10).map((x) => `${ts(x.at, 't')} ┃ ${x.text}`).join('\n');
  if (timeline) {
    box.addSeparatorComponents(hline());
    box.addTextDisplayComponents(htext(`**🗂️ Progress**\n${timeline}`));
  }
  box.addSeparatorComponents(hline());
  box.addTextDisplayComponents(htext(`-# 🎫 NCS Ticket Center • ${ts(t.closedAt || t.createdAt, 'f')}`));
  return { components: [box], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } };
}

/** Catat kejadian ticket & perbarui kartunya di channel Tickets History (antrian per ticket, tidak dobel). */
function historyLog(guild, t, text) {
  if (text) {
    t.history = t.history || [];
    t.history.push({ at: Date.now(), text });
    save();
  }
  const prev = historyQueues.get(t.id) || Promise.resolve();
  const next = prev
    .then(async () => {
      const cfg = loadConfig();
      if (!isId(cfg.historyChannelId) || !guild) return;
      const ch = await guild.channels.fetch(cfg.historyChannelId).catch(() => null);
      if (!ch?.isTextBased()) return;
      const payload = buildHistoryCard(guild, cfg, t);
      if (t.historyMessageId) {
        try {
          await ch.messages.edit(t.historyMessageId, payload);
          return;
        } catch {
          // pesan dihapus manual → kirim baru
        }
      }
      const msg = await ch.send(payload);
      t.historyMessageId = msg.id;
      save();
    })
    .catch((e) => console.error(`[ticket] history ${t.id}:`, e.message));
  historyQueues.set(t.id, next);
  return next;
}

async function logTicket(guild, cfg, t, kind, files = []) {
  if (!isId(cfg.logChannelId)) return;
  const ch = await guild.channels.fetch(cfg.logChannelId).catch(() => null);
  if (!ch?.isTextBased()) return;
  const type = typeOf(cfg, t.type) || { label: t.type, emoji: '🎫' };
  const e = new EmbedBuilder()
    .setColor(kind === 'open' ? 0x2ecc71 : 0xe74c3c)
    .setTitle(`${kind === 'open' ? '📥 Ticket Dibuka' : '🔒 Ticket Ditutup'} • ${t.id}`)
    .addFields(
      { name: '📂 Jenis', value: `${type.emoji || ''} ${type.label}`, inline: true },
      { name: '👤 Pembuka', value: `<@${t.userId}>`, inline: true },
      { name: kind === 'open' ? '🎫 Channel' : '🙋 Ditutup Oleh', value: kind === 'open' ? `<#${t.channelId}>` : `<@${t.closedBy}>`, inline: true },
    )
    .setFooter(footer(guild, 'NCS Ticket Center'))
    .setTimestamp(new Date());
  if (kind === 'close') {
    if (t.claimedBy) e.addFields({ name: '🛡️ Ditangani', value: `<@${t.claimedBy}>`, inline: true });
    if (t.closeReason) e.addFields({ name: '📝 Alasan', value: t.closeReason.slice(0, 1024) });
  }
  await ch.send({ embeds: [e], files, allowedMentions: { parse: [] } }).catch(() => {});
}

/** Ambil semua teks dari pesan Components V2 (untuk transcript). */
function v2Texts(components = []) {
  const out = [];
  const walk = (list) => {
    for (const c of list || []) {
      const j = c.toJSON ? c.toJSON() : c;
      if (j.type === 10 && j.content) out.push(j.content.replace(/\n+/g, ' / '));
      if (j.components) walk(j.components);
    }
  };
  walk(components);
  return out;
}

/** Transcript teks seluruh percakapan ticket. */
async function buildTranscript(channel, t) {
  const lines = [];
  let before;
  for (let i = 0; i < 5; i++) {
    const batch = await channel.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!batch?.size) break;
    lines.push(...batch.values());
    before = batch.last().id;
    if (batch.size < 100) break;
  }
  const text = lines
    .reverse()
    .map((m) => {
      const time = new Date(m.createdTimestamp).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
      const body = [m.content, ...m.embeds.map((e) => `[embed] ${e.title || ''} ${e.description || ''}`.trim()), ...v2Texts(m.components).map((x) => `[kotak] ${x}`), ...[...m.attachments.values()].map((a) => `[lampiran] ${a.url}`)]
        .filter(Boolean)
        .join(' | ');
      return `[${time}] ${m.author?.tag || 'unknown'}: ${body}`;
    })
    .join('\n');
  const header = `NCS Ticket Center — Transcript ${t.id}\nDibuka oleh: ${t.userId} • ${new Date(t.createdAt).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}\n${'='.repeat(60)}\n`;
  return { attachment: Buffer.from(header + text, 'utf8'), name: `transcript-${t.id}.txt` };
}

async function closeTicket(interaction, t, reason) {
  const cfg = loadConfig();
  const guild = interaction.guild;
  t.status = 'closed';
  t.closedAt = Date.now();
  t.closedBy = interaction.user.id;
  t.closeReason = reason || null;
  save();
  const channel = await guild.channels.fetch(t.channelId).catch(() => null);
  const secs = Number(cfg.deleteAfterSeconds) || 10;
  if (channel) {
    await editTicketMsg(channel, guild, cfg, t);
    await channel
      .send(
        card({
          color: 0xe74c3c,
          header: `## 🔒 Ticket Ditutup\nTicket **${t.id}** ditutup oleh <@${t.closedBy}>.`,
          blocks: [
            reason ? `**📝 Alasan:** ${reason}` : null,
            `**⏱️ Durasi:** \`${duration(t.closedAt - t.createdAt)}\`${t.claimedBy ? ` • **🛡️ Ditangani:** <@${t.claimedBy}>` : ''}\n**📄 Transcript:** dikirim ke DM pembuka ticket`,
            `⏳ Channel ini akan dihapus dalam **${secs} detik**.`,
          ],
          footer: `NCS Ticket Center • ${t.id} • ${ts(Date.now(), 'f')}`,
        }),
      )
      .catch(() => {});
  }
  const transcript = channel ? await buildTranscript(channel, t).catch(() => null) : null;
  await logTicket(guild, cfg, t, 'close', transcript ? [transcript] : []);
  // Arsip lengkap (kartu V2 + transkrip HTML) ke channel arsip NCS — sebelum channel dihapus.
  await archiveNcsTicket(guild, cfg, t, channel).catch((e) => console.error(`[ticket] arsip ${t.id}:`, e.message));
  save();
  historyLog(guild, t, `🔒 Ditutup oleh <@${t.closedBy}>`);

  // DM pembuka ticket
  const user = await client.users.fetch(t.userId).catch(() => null);
  const type = typeOf(cfg, t.type) || { label: t.type, emoji: '🎫' };
  await user
    ?.send({
      embeds: [
        new EmbedBuilder()
          .setColor(brand(cfg))
          .setAuthor({ name: `${guild.name} • NCS Ticket Center`, iconURL: guild.iconURL({ size: 128 }) || undefined })
          .setTitle('🔒 Ticket Kamu Telah Ditutup')
          .setDescription(`Terima kasih telah menghubungi kami! 💙 Jika masih ada kendala, silakan buka ticket baru kapan saja.`)
          .addFields(
            { name: '🎫 Ticket', value: `\`${t.id}\``, inline: true },
            { name: '📂 Jenis', value: `\`${type.label}\``, inline: true },
            { name: '⏱️ Durasi', value: `\`${duration(t.closedAt - t.createdAt)}\``, inline: true },
          )
          .addFields(reason ? [{ name: '📝 Alasan', value: reason.slice(0, 1024) }] : [])
          .setFooter(footer(guild, 'Transcript percakapan terlampir'))
          .setTimestamp(new Date()),
      ],
      files: transcript ? [transcript] : [],
    })
    .catch(() => {});

  refreshPanel().catch(() => {});
  if (channel) setTimeout(() => channel.delete(`Ticket ${t.id} ditutup`).catch(() => {}), secs * 1000);
}

function duration(ms) {
  const m = Math.max(1, Math.round(ms / 60000));
  if (m < 60) return `${m} menit`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} jam ${m % 60} menit` : `${Math.floor(h / 24)} hari ${h % 24} jam`;
}

// ───────────────────────── Interaksi ─────────────────────────
async function handleInteraction(interaction) {
  const id = interaction.customId;
  if (typeof id !== 'string' || !id.startsWith('st:')) return false;
  const [, action, arg] = id.split(':');
  const cfg = loadConfig();
  try {
    if (action === 'open' && interaction.isStringSelectMenu()) {
      const type = typeOf(cfg, interaction.values[0]);
      // Reset pilihan dropdown supaya bisa dipilih lagi.
      interaction.message?.edit(buildPanel(interaction.guild, cfg)).catch(() => {});
      if (!type || type.enabled === false || type.comingSoon) {
        return void (await interaction.reply({ content: '🔒 Layanan ini **segera hadir**. Nantikan ya! ✨', flags: EPH }));
      }
      const max = Number(cfg.maxOpenPerUser) || 1;
      const mine = Object.values(data.tickets).filter((t) => t.status === 'open' && t.userId === interaction.user.id && t.type === type.id);
      if (mine.length >= max) {
        return void (await interaction.reply({
          content: `⚠️ Kamu masih punya ticket **${type.label}** yang aktif: <#${mine[0].channelId}> (\`${mine[0].id}\`).`,
          flags: EPH,
        }));
      }
      return void (await interaction.showModal(buildForm(type, interaction.user.id)));
    }

    if (action === 'form' && interaction.isModalSubmit()) {
      const type = typeOf(cfg, arg);
      if (!type) return void (await interaction.reply({ content: '❌ Jenis ticket tidak ditemukan.', flags: EPH }));
      await interaction.deferReply({ flags: EPH });
      const answers = [];
      const extra = {};
      if (type.id === 'claim-giveaway') {
        let picked = null;
        let typed = null;
        try {
          picked = interaction.fields.getStringSelectValues('gaid')?.[0] || null;
        } catch {}
        if (!picked) {
          try {
            typed = interaction.fields.getTextInputValue('gatext');
          } catch {}
        }
        const g = giveaway.getGiveaway ? giveaway.getGiveaway(picked || typed) : null;
        const won = g && (g.allWinners || g.winners || []).includes(interaction.user.id);
        answers.push(['🎁 Giveaway', g ? `\`${g.id}\` • **${g.prize}**` : `\`${typed || picked}\``]);
        if (g) answers.push(['📅 Berakhir', g.endedAt ? ts(g.endedAt, 'f') : '-']);
        let rtype = null;
        try {
          rtype = interaction.fields.getStringSelectValues('rtype')?.[0] || null;
        } catch {}
        const reward = rewardOf(rtype || guessRewardType(g?.prize) || 'other');
        answers.push(['🎀 Jenis Hadiah', `${reward.emoji} \`${reward.label}\``]);
        answers.push(['📦 Data Penerimaan', '```\n' + interaction.fields.getTextInputValue('receiver').trim().replace(/`/g, 'ˋ') + '\n```']);
        const holder = optional(interaction.fields, 'holder');
        if (holder) answers.push(['👤 Nama Penerima', `\`${holder}\``]);
        else if (['cash', 'ewallet'].includes(reward.id)) answers.push(['👤 Nama Penerima', '`⚠️ Belum diisi — staff akan menanyakan`']);
        const note = optional(interaction.fields, 'note');
        if (note) answers.push(['📝 Catatan', note]);
        extra.rewardType = reward.id;
        extra.verified = Boolean(won);
        extra.giveawayId = g?.id || null;
      } else if (type.id === INSTANT_HELP) {
        let picked = null;
        try {
          picked = interaction.fields.getStringSelectValues('order')?.[0] || null;
        } catch {}
        if (!picked) picked = (optional(interaction.fields, 'ordertext') || '').toUpperCase().replace(/\s+/g, '');
        const mine = instantOrdersOf(interaction.user.id);
        let o = mine.find((x) => x.id === picked) || null;
        let other = false;
        if (!o) {
          try {
            const { state } = require('./store/state');
            o = state.tickets?.[picked]?.kind === 'instant' ? state.tickets[picked] : null;
            other = Boolean(o);
          } catch {}
        }
        let issue = null;
        try {
          issue = interaction.fields.getStringSelectValues('issue')?.[0] || null;
        } catch {}
        const iss = instantIssues().find((x) => String(x.id) === issue) || { label: issue || '-', emoji: '💬' };
        if (o) {
          const i = o.ins || {};
          const w = warrantyOf(o);
          answers.push(['🧾 Pesanan', `\`${o.id}\` • **${i.product || o.productLabel}** — ${i.variant || '-'} × ${o.qty || i.qty || 1}`]);
          answers.push(['📅 Dibeli', `${ts(o.createdAt, 'f')}${i.deliveredAt ? ` • akun dikirim ${ts(i.deliveredAt, 'R')}` : ''}`]);
          answers.push(['🛡️ Garansi', w.text]);
          answers.push(['💰 Dibayar', `\`Rp ${Math.round(Number(o.payment?.amount || o.price) || 0).toLocaleString('id-ID')}\``]);
          if (i.order?.ref) answers.push(['🏭 No. Pusat', `\`${i.order.ref}\``]);
          extra.warranty = w.state;
        } else {
          answers.push(['🧾 Pesanan', `\`${picked || '-'}\` • ⚠️ tidak ditemukan — staff cek manual`]);
        }
        answers.push(['⚠️ Jenis Kendala', `${iss.emoji || '💬'} \`${iss.label}\``]);
        answers.push(['💬 Detail Kendala', interaction.fields.getTextInputValue('detail').trim()]);
        extra.orderId = o?.id || picked || null;
        extra.verified = o ? !other : false;
      } else {
        answers.push(['📌 Topik', `\`${interaction.fields.getTextInputValue('topic').trim()}\``]);
        answers.push(['💬 Detail Kendala', interaction.fields.getTextInputValue('detail').trim()]);
      }
      try {
        const { channel } = await createTicket(interaction, type, answers, extra);
        return void (await interaction.editReply({
          content: `✅ Ticket **${type.label}** berhasil dibuat: ${channel}`,
          components: [
            new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setStyle(ButtonStyle.Link)
                .setLabel('Buka Ticket')
                .setEmoji('🎫')
                .setURL(`https://discord.com/channels/${interaction.guild.id}/${channel.id}`),
            ),
          ],
        }));
      } catch (err) {
        console.error('[ticket] gagal membuat ticket:', err);
        return void (await interaction.editReply('❌ Gagal membuat ticket. Pastikan bot punya izin **Manage Channels** & **Manage Roles**.'));
      }
    }

    const t = data.tickets[arg];
    if (!t || t.status !== 'open') {
      if (interaction.isRepliable() && !interaction.replied) await interaction.reply({ content: 'Ticket ini sudah ditutup.', flags: EPH }).catch(() => {});
      return true;
    }

    if (action === 'claim') {
      if (!isStaff(interaction.member, cfg)) return void (await interaction.reply({ content: '⛔ Hanya **staff** yang bisa menangani ticket.', flags: EPH }));
      t.claimedBy = interaction.user.id;
      t.claimedAt = Date.now();
      historyLog(interaction.guild, t, `🙋 Ditangani oleh <@${interaction.user.id}>`);
      save();
      await interaction.update(ticketPayloadFor(interaction.message, interaction.guild, cfg, t));
      const claimTicket = t.type === 'claim-giveaway';
      const notice = card({
        color: 0x9b59b6,
        top: `<@${t.userId}>`,
        thumb: interaction.user.displayAvatarURL({ extension: 'png', size: 128 }),
        header: `## 🙋 Ticket Sedang Ditangani\n<@${interaction.user.id}> akan **${claimTicket ? 'memproses klaim hadiahmu' : 'menangani ticket kamu'}**. 💙`,
        blocks: [
          claimTicket
            ? 'Mohon tunggu sebentar — staff sedang **memverifikasi** data giveaway & data penerimaanmu. Jika ada data yang kurang, staff akan menanyakannya di sini.'
            : t.type === INSTANT_HELP
              ? 'Kirim **screenshot kendala** (misal pesan error saat login) di sini ya. Staff akan mengecek akun & garansimu.'
              : 'Silakan jelaskan kendalamu di sini dan lampirkan **screenshot** bila ada.',
        ],
        footer: `NCS Ticket Center • ${t.id}`,
      });
      notice.allowedMentions = { users: [t.userId] };
      await interaction.channel.send(notice).catch(() => {});
      return true;
    }

    if (action === 'deliver') {
      if (!isStaff(interaction.member, cfg)) return void (await interaction.reply({ content: '⛔ Hanya **staff** yang bisa menandai hadiah terkirim.', flags: EPH }));
      if (t.delivered) return void (await interaction.reply({ content: '🎁 Hadiah ticket ini sudah ditandai terkirim.', flags: EPH }));
      t.delivered = true;
      t.deliveredAt = Date.now();
      t.deliveredBy = interaction.user.id;
      if (!t.claimedBy) {
        t.claimedBy = interaction.user.id;
        t.claimedAt = Date.now();
      }
      save();
      historyLog(interaction.guild, t, `🎁 Hadiah dikirim oleh <@${interaction.user.id}>`);
      await interaction.update(ticketPayloadFor(interaction.message, interaction.guild, cfg, t));
      const reward = rewardOf(t.rewardType);
      const g = t.giveawayId && giveaway.getGiveaway ? giveaway.getGiveaway(t.giveawayId) : null;
      const done = card({
        color: 0x2ecc71,
        top: `<@${t.userId}>`,
        header: `## 🎁 Hadiah Sudah Dikirim!\nSelamat <@${t.userId}>, hadiahmu sudah **dikirim** oleh <@${interaction.user.id}>! 🎉`,
        blocks: [
          [g ? `**🎉 Giveaway:** \`${g.id}\` • ${g.prize}` : null, `**🎀 Jenis Hadiah:** ${reward.emoji} \`${reward.label}\``, `**🕒 Dikirim:** ${ts(t.deliveredAt, 'f')}`]
            .filter(Boolean)
            .join('\n'),
          'Silakan **cek** hadiahmu ya. Kalau sudah diterima, kamu boleh menutup ticket ini dengan tombol **🔒 Tutup Ticket**. Terima kasih sudah ikut giveaway kami! 💙',
        ],
        footer: `NCS Ticket Center • ${t.id}`,
      });
      done.allowedMentions = { users: [t.userId] };
      await interaction.channel.send(done).catch(() => {});
      return true;
    }

    if (action === 'close') {
      if (interaction.user.id !== t.userId && !isStaff(interaction.member, cfg)) {
        return void (await interaction.reply({ content: '⛔ Hanya pembuka ticket atau staff yang bisa menutup ticket.', flags: EPH }));
      }
      return void (await interaction.showModal(
        new ModalBuilder()
          .setCustomId(`st:closemodal:${t.id}`)
          .setTitle(`Tutup Ticket ${t.id}`)
          .addLabelComponents(
            new LabelBuilder()
              .setLabel('Alasan Penutupan (opsional)')
              .setTextInputComponent(
                new TextInputBuilder().setCustomId('reason').setStyle(TextInputStyle.Paragraph).setPlaceholder('contoh: Masalah sudah selesai').setMaxLength(300).setRequired(false),
              ),
          ),
      ));
    }

    if (action === 'closemodal' && interaction.isModalSubmit()) {
      await interaction.deferReply({ flags: EPH });
      await closeTicket(interaction, t, optional(interaction.fields, 'reason'));
      return void (await interaction.editReply(`🔒 Ticket **${t.id}** ditutup.`));
    }
  } catch (err) {
    console.error('[ticket] error:', err);
    const msg = { content: '❌ Terjadi kesalahan, coba lagi.', flags: EPH };
    if (interaction.deferred || interaction.replied) await interaction.followUp(msg).catch(() => {});
    else await interaction.reply(msg).catch(() => {});
  }
  return true;
}

// ───────────────────────── Command ─────────────────────────
const ticketCommand = {
  data: new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('NCS Ticket Center')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addSubcommand((s) =>
      s
        .setName('panel')
        .setDescription('Kirim / pindahkan panel NCS Ticket Center')
        .addChannelOption((o) => o.setName('channel').setDescription('Default: panelChannelId di tickets.json').addChannelTypes(ChannelType.GuildText)),
    )
    .addSubcommand((s) =>
      s
        .setName('tambah')
        .setDescription('Tambahkan member ke ticket ini')
        .addUserOption((o) => o.setName('member').setDescription('Member yang ditambahkan').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('keluarkan')
        .setDescription('Keluarkan member dari ticket ini')
        .addUserOption((o) => o.setName('member').setDescription('Member yang dikeluarkan').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('tutup')
        .setDescription('Tutup ticket ini')
        .addStringOption((o) => o.setName('alasan').setDescription('Alasan penutupan (opsional)').setMaxLength(300)),
    ),

  async execute(interaction) {
    const cfg = loadConfig();
    const sub = interaction.options.getSubcommand();
    if (sub === 'panel') {
      await interaction.deferReply({ flags: EPH });
      const channel =
        interaction.options.getChannel('channel') ||
        (isId(cfg.panelChannelId) ? await interaction.guild.channels.fetch(cfg.panelChannelId).catch(() => null) : null) ||
        interaction.channel;
      const old = data.panel;
      const sent = await channel.send(buildPanel(interaction.guild, cfg));
      data.panel = { channelId: channel.id, messageId: sent.id };
      save();
      if (old && old.messageId !== sent.id) {
        const oldCh = await interaction.guild.channels.fetch(old.channelId).catch(() => null);
        await oldCh?.messages.delete(old.messageId).catch(() => {});
      }
      return interaction.editReply(`✅ Panel **NCS Ticket Center** dikirim ke ${channel}.`);
    }

    const t = Object.values(data.tickets).find((x) => x.channelId === interaction.channelId && x.status === 'open');
    if (!t) return interaction.reply({ content: '❌ Jalankan perintah ini di dalam **channel ticket** yang masih aktif.', flags: EPH });

    if (sub === 'tambah' || sub === 'keluarkan') {
      const user = interaction.options.getUser('member');
      if (sub === 'tambah') {
        await interaction.channel.permissionOverwrites.edit(user.id, {
          ViewChannel: true,
          SendMessages: true,
          ReadMessageHistory: true,
          AttachFiles: true,
          EmbedLinks: true,
        });
        return interaction.reply({ content: `➕ ${user} ditambahkan ke ticket ini.`, allowedMentions: { parse: [] } });
      }
      if (user.id === t.userId) return interaction.reply({ content: '❌ Pembuka ticket tidak bisa dikeluarkan.', flags: EPH });
      await interaction.channel.permissionOverwrites.delete(user.id).catch(() => {});
      return interaction.reply({ content: `➖ ${user} dikeluarkan dari ticket ini.`, allowedMentions: { parse: [] } });
    }

    if (sub === 'tutup') {
      await interaction.deferReply({ flags: EPH });
      await closeTicket(interaction, t, interaction.options.getString('alasan'));
      return interaction.editReply(`🔒 Ticket **${t.id}** ditutup.`);
    }
  },
};

function registerSupportTickets(c) {
  client = c;
  c.once(Events.ClientReady, () => refreshPanel().catch(() => {}));
  // Channel ticket dihapus manual → tandai ditutup.
  c.on(Events.ChannelDelete, (ch) => {
    const t = Object.values(data.tickets).find((x) => x.channelId === ch.id && x.status === 'open');
    if (!t) return;
    t.status = 'closed';
    t.closedAt = Date.now();
    t.closeReason = 'Channel dihapus manual';
    historyLog(ch.guild, t, '🗑️ Channel ticket dihapus manual');
    save();
    archiveNcsTicket(ch.guild, loadConfig(), t, null)
      .then(() => save())
      .catch((e) => console.error(`[ticket] arsip ${t.id}:`, e.message));
    refreshPanel().catch(() => {});
  });
}

module.exports = { ticketCommand, registerSupportTickets, handleInteraction };
