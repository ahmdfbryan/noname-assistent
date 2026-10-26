const fs = require('fs');
const path = require('path');
const {
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
} = require('discord.js');
const UI = require('./ui');

/**
 * Suggestions (Components V2).
 * Panel di channel suggestions → pilih peruntukan (Server Discord / Noname Store) → isi form.
 * Saran tampil di channel yang sama (vote 👍/👎 + thread diskusi), panel otomatis pindah ke paling bawah (sticky).
 * Staff mengelola status saran lewat tombol 🛠️ Kelola atau /suggestion status. Teks di suggestions.json.
 */
const FILE = path.join(__dirname, '..', 'suggestions.json');
const DATA = path.join(__dirname, '..', 'data', 'suggestions.json');
const V2 = MessageFlags.IsComponentsV2;
const EPH = MessageFlags.Ephemeral;
const isId = (v) => /^\d{17,20}$/.test(String(v || ''));
const num = (n) => Math.round(Number(n) || 0).toLocaleString('id-ID');
const ts = (ms, s = 'f') => `<t:${Math.floor(ms / 1000)}:${s}>`;
let client = null;

const DEFAULTS = {
  channelId: '',
  cooldownMinutes: 5,
  createThread: true,
  dmAuthor: true,
  stickyDelaySeconds: 3,
  colors: {},
  panel: {},
  categories: [
    { id: 'server', label: 'Server Discord', emoji: '🏠', description: 'Saran untuk server Discord' },
    { id: 'store', label: 'Noname Store', emoji: '🛒', description: 'Saran untuk jualan / layanan store' },
  ],
};
let warned = false;
function loadConfig() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
  } catch (err) {
    if (!warned) console.error('[suggestions] suggestions.json tidak bisa dibaca:', err.message);
    warned = true;
    return DEFAULTS;
  }
}
function loadData() {
  try {
    return { seq: 0, items: {}, panel: null, ...JSON.parse(fs.readFileSync(DATA, 'utf8')) };
  } catch {
    return { seq: 0, items: {}, panel: null };
  }
}
const data = loadData();
function save() {
  fs.mkdirSync(path.dirname(DATA), { recursive: true });
  fs.writeFileSync(`${DATA}.tmp`, JSON.stringify(data, null, 2));
  fs.renameSync(`${DATA}.tmp`, DATA);
}
const hex = (v, fb) => {
  const n = parseInt(String(v || '').replace('#', ''), 16);
  return Number.isNaN(n) ? fb : n;
};
const fill = (t, guild) => String(t || '').replace(/\{server\}/g, guild.name);

const STATUS = {
  pending: { label: 'Menunggu Review', emoji: '⏳', color: 0x3498db },
  considered: { label: 'Dipertimbangkan', emoji: '🤔', color: 0xf1c40f },
  approved: { label: 'Diterima', emoji: '✅', color: 0x2ecc71 },
  done: { label: 'Sudah Diterapkan', emoji: '🎉', color: 0x9b59b6 },
  rejected: { label: 'Ditolak', emoji: '❌', color: 0xe74c3c },
};
const statusColor = (cfg, st) => hex(cfg.colors?.[st], STATUS[st]?.color ?? 0x3498db);
const catOf = (cfg, id) => (cfg.categories || []).find((c) => c.id === id) || { id, label: id, emoji: '💡' };
const locked = (s) => s.status === 'rejected' || s.status === 'done';

function isStaff(member, cfg) {
  if (!member) return false;
  if (member.permissions?.has?.(PermissionFlagsBits.ManageGuild)) return true;
  return isId(cfg.staffRoleId) && member.roles?.cache?.has(cfg.staffRoleId);
}

// ───────────────────────── Tampilan (Components V2) ─────────────────────────
const text = (c) => new TextDisplayBuilder().setContent(String(c).slice(0, 4000));
const line = () => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);

function card({ color, header, thumb, blocks = [], footer, rows = [] }) {
  const box = UI.accent(new ContainerBuilder(), color);
  if (thumb) box.addSectionComponents(new SectionBuilder().addTextDisplayComponents(text(header)).setThumbnailAccessory(new ThumbnailBuilder().setURL(thumb)));
  else box.addTextDisplayComponents(text(header));
  for (const b of blocks.filter(Boolean)) {
    box.addSeparatorComponents(line());
    box.addTextDisplayComponents(text(b));
  }
  if (footer) {
    box.addSeparatorComponents(line());
    box.addTextDisplayComponents(text(`-# ${footer}`));
  }
  for (const r of rows.filter(Boolean)) box.addActionRowComponents(r);
  return { components: [box], flags: V2, allowedMentions: { parse: [] } };
}
const eph = (p) => ({ ...p, flags: (p.flags || 0) | EPH });
const notice = (cfg, color, header, blocks = [], rows = []) => eph(card({ color, header, blocks, rows }));

function counts() {
  const all = Object.values(data.items).filter((s) => !s.deleted);
  const by = (st) => all.filter((s) => s.status === st).length;
  return { total: all.length, approved: by('approved'), done: by('done'), pending: by('pending') + by('considered') };
}

/** Panel sticky. */
function buildPanel(guild, cfg) {
  const p = cfg.panel || {};
  const KEY = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣'];
  const cats = cfg.categories || [];
  const c = counts();
  const steps = (p.steps || []).map((x, i) => `${KEY[i] || `\`${i + 1}\``} ${x}`).join('\n');
  const rules = (p.rules || []).map((x) => `▸ ${x}`).join('\n');
  return card({
    color: hex(cfg.colors?.brand, 0x3498db),
    thumb: guild.iconURL({ extension: 'png', size: 256 }),
    header: `# ${fill(p.title || '💡 Suggestions | {server}', guild)}\n-# ${fill(p.subtitle || 'Kotak Saran Resmi • {server}', guild)}`,
    blocks: [
      fill(p.description, guild) || null,
      cats.length ? `### 🗂️ Peruntukan Saran\n${cats.map((x) => `${x.emoji || '💡'} **${x.label}** — ${x.description || ''}`).join('\n')}` : null,
      steps ? `### 🧭 Cara Mengirim Saran\n${steps}` : null,
      rules ? `### 📜 Ketentuan\n${rules}` : null,
      `📊 **Total Saran:** \`${num(c.total)}\` • ⏳ **Ditinjau:** \`${num(c.pending)}\` • ✅ **Diterima:** \`${num(c.approved)}\` • 🎉 **Diterapkan:** \`${num(c.done)}\``,
    ],
    footer: `${fill(p.footer || '{server} • Suggestions', guild)} • Diperbarui <t:${Math.floor(Date.now() / 1000)}:R>`,
    rows: [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('sg:cat')
          .setPlaceholder('💡 Pilih peruntukan saranmu...')
          .addOptions(
            cats.slice(0, 25).map((x) => ({ label: `Saran untuk ${x.label}`.slice(0, 100), description: (x.description || '').slice(0, 100) || undefined, value: x.id, emoji: x.emoji || '💡' })),
          ),
      ),
      new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('sg:mine').setLabel('Saran Saya').setEmoji('📋').setStyle(ButtonStyle.Secondary)),
    ],
  });
}

function voteBlock(s) {
  const up = s.up.length;
  const down = s.down.length;
  const total = up + down;
  const pct = total ? Math.round((up / total) * 100) : 0;
  const filled = total ? Math.round(pct / 10) : 0;
  const bar = total ? `${'🟩'.repeat(filled)}${'🟥'.repeat(10 - filled)}` : '⬜'.repeat(10);
  return `### 📊 Hasil Vote\n${bar}\n👍 **Setuju:** \`${num(up)}\` ${total ? `(${pct}%)` : ''} • 👎 **Tidak Setuju:** \`${num(down)}\` ${total ? `(${100 - pct}%)` : ''} • 🗳️ **Total:** \`${num(total)}\``;
}

/** Kartu satu saran. */
function buildSuggestion(guild, cfg, s) {
  const cat = catOf(cfg, s.category);
  const st = STATUS[s.status] || STATUS.pending;
  const statusLines = [`🏷️ **Status:** \`${st.emoji} ${st.label}\``];
  if (s.response) statusLines.push(`💬 **Tanggapan Staff:** ${s.response}`);
  if (s.reviewedBy) statusLines.push(`🛠️ **Ditinjau oleh:** <@${s.reviewedBy}> • ${ts(s.reviewedAt, 'R')}`);
  const lock = locked(s);
  return card({
    color: statusColor(cfg, s.status),
    thumb: s.avatar || guild.iconURL({ extension: 'png', size: 256 }),
    header: `## 💡 Saran ${s.id}\n-# ${cat.emoji || '💡'} ${cat.label} • oleh <@${s.userId}>`,
    blocks: [
      `### 📌 ${s.title}\n${s.detail}`,
      s.benefit ? `### 🎯 Manfaat\n${s.benefit}` : null,
      voteBlock(s),
      statusLines.join('\n'),
    ],
    footer: `🆔 ${s.id} • Dikirim ${ts(s.createdAt, 'f')}${s.threadId ? ` • Diskusi di <#${s.threadId}>` : ''}`,
    rows: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`sg:up:${s.id}`).setLabel(`Setuju (${num(s.up.length)})`).setEmoji('👍').setStyle(ButtonStyle.Success).setDisabled(lock),
        new ButtonBuilder().setCustomId(`sg:down:${s.id}`).setLabel(`Tidak Setuju (${num(s.down.length)})`).setEmoji('👎').setStyle(ButtonStyle.Danger).setDisabled(lock),
        new ButtonBuilder().setCustomId(`sg:manage:${s.id}`).setLabel('Kelola').setEmoji('🛠️').setStyle(ButtonStyle.Secondary),
      ),
    ],
  });
}

function buildForm(cat) {
  return new ModalBuilder()
    .setCustomId(`sg:form:${cat.id}`)
    .setTitle(`Saran untuk ${cat.label}`.slice(0, 45))
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('Judul Saran')
        .setDescription('Ringkas & jelas, maksimal 100 karakter.')
        .setTextInputComponent(
          new TextInputBuilder().setCustomId('title').setStyle(TextInputStyle.Short).setPlaceholder('contoh: Tambah event mabar mingguan').setMinLength(5).setMaxLength(100).setRequired(true),
        ),
      new LabelBuilder()
        .setLabel('Detail Saran')
        .setDescription('Jelaskan idemu selengkap mungkin.')
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId('detail')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('Ceritakan saranmu secara detail...')
            .setMinLength(15)
            .setMaxLength(1500)
            .setRequired(true),
        ),
      new LabelBuilder()
        .setLabel('Manfaat / Alasan (opsional)')
        .setDescription('Kenapa saran ini bagus untuk komunitas / store?')
        .setTextInputComponent(new TextInputBuilder().setCustomId('benefit').setStyle(TextInputStyle.Paragraph).setMaxLength(500).setRequired(false)),
    );
}

function buildStatusModal(s, status) {
  return new ModalBuilder()
    .setCustomId(`sg:stmodal:${s.id}:${status}`)
    .setTitle(`${STATUS[status].emoji} ${STATUS[status].label} • ${s.id}`.slice(0, 45))
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('Tanggapan untuk Pengirim (opsional)')
        .setTextInputComponent(
          new TextInputBuilder().setCustomId('note').setStyle(TextInputStyle.Paragraph).setPlaceholder('contoh: Terima kasih, akan kami tambahkan minggu depan!').setMaxLength(500).setRequired(false),
        ),
    );
}

function buildManage(cfg, s) {
  return notice(cfg, statusColor(cfg, s.status), `## 🛠️ Kelola Saran ${s.id}\n**${s.title}**`, [
    `🏷️ **Status sekarang:** \`${STATUS[s.status].emoji} ${STATUS[s.status].label}\`\n👍 \`${num(s.up.length)}\` • 👎 \`${num(s.down.length)}\``,
    '-# Pilih status baru di bawah. Kamu bisa menambahkan tanggapan untuk pengirim.',
  ], [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`sg:setst:${s.id}`)
        .setPlaceholder('🏷️ Ubah status saran...')
        .addOptions(Object.entries(STATUS).map(([value, x]) => ({ label: x.label, value, emoji: x.emoji, default: value === s.status }))),
    ),
    new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`sg:del:${s.id}`).setLabel('Hapus Saran').setEmoji('🗑️').setStyle(ButtonStyle.Danger)),
  ]);
}

function buildMine(cfg, userId) {
  const mine = Object.values(data.items)
    .filter((s) => s.userId === userId && !s.deleted)
    .sort((a, b) => b.createdAt - a.createdAt);
  const list = mine.slice(0, 10).map((s) => {
    const st = STATUS[s.status];
    const cat = catOf(cfg, s.category);
    const link = s.messageId ? `[Lihat](https://discord.com/channels/${s.guildId}/${s.channelId}/${s.messageId})` : '';
    return `\`${s.id}\` ${cat.emoji || '💡'} **${s.title}**\n┗ ${st.emoji} ${st.label} • 👍 ${num(s.up.length)} • 👎 ${num(s.down.length)} • ${ts(s.createdAt, 'R')} ${link}`;
  });
  return notice(cfg, hex(cfg.colors?.brand, 0x3498db), `## 📋 Saran Saya (${mine.length})`, [
    list.length ? list.join('\n\n') : '_Kamu belum pernah mengirim saran. Yuk kirim saran pertamamu!_ 💡',
    mine.length > 10 ? `-# Menampilkan 10 saran terbaru dari ${num(mine.length)} saran.` : null,
  ]);
}

function buildStatusDM(guild, cfg, s) {
  const st = STATUS[s.status];
  return card({
    color: statusColor(cfg, s.status),
    thumb: guild.iconURL({ extension: 'png', size: 256 }),
    header: `# ${st.emoji} Saranmu ${st.label}!\nUpdate untuk saran **${s.id}** di **${guild.name}**.`,
    blocks: [
      `### 📌 ${s.title}\n🏷️ **Status:** \`${st.emoji} ${st.label}\`${s.response ? `\n💬 **Tanggapan Staff:** ${s.response}` : ''}`,
      `👍 \`${num(s.up.length)}\` • 👎 \`${num(s.down.length)}\`\n\nTerima kasih sudah membantu kami berkembang! 💙`,
    ],
    footer: `${guild.name} • Suggestions • ${ts(Date.now(), 'f')}`,
    rows: s.messageId
      ? [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Lihat Saran').setEmoji('💡').setURL(`https://discord.com/channels/${s.guildId}/${s.channelId}/${s.messageId}`),
          ),
        ]
      : [],
  });
}

// ───────────────────────── Sticky panel ─────────────────────────
let stickyTimer = null;
let stickyBusy = false;
async function repostPanel(channel) {
  if (stickyBusy) return scheduleSticky(channel, 1500);
  stickyBusy = true;
  try {
    const cfg = loadConfig();
    const old = data.panel;
    const sent = await channel.send(buildPanel(channel.guild, cfg));
    data.panel = { channelId: channel.id, messageId: sent.id };
    save();
    if (old?.messageId && old.messageId !== sent.id) {
      const oldCh = old.channelId === channel.id ? channel : await channel.guild.channels.fetch(old.channelId).catch(() => null);
      await oldCh?.messages.delete(old.messageId).catch(() => {});
    }
    return sent;
  } finally {
    stickyBusy = false;
  }
}
function scheduleSticky(channel, ms) {
  clearTimeout(stickyTimer);
  const delay = ms ?? Math.max(1, Number(loadConfig().stickyDelaySeconds) || 3) * 1000;
  stickyTimer = setTimeout(() => repostPanel(channel).catch((e) => console.warn('[suggestions] sticky:', e.message)), delay);
}
/** Perbarui angka di panel tanpa memindahkannya. */
let panelEditTimer = null;
function refreshPanel() {
  clearTimeout(panelEditTimer);
  panelEditTimer = setTimeout(async () => {
    if (!client || !data.panel) return;
    const ch = await client.channels.fetch(data.panel.channelId).catch(() => null);
    if (ch) await ch.messages.edit(data.panel.messageId, buildPanel(ch.guild, loadConfig())).catch(() => {});
  }, 2000);
}

// ───────────────────────── Aksi ─────────────────────────
async function fetchCard(s) {
  const ch = await client.channels.fetch(s.channelId).catch(() => null);
  const msg = ch && s.messageId ? await ch.messages.fetch(s.messageId).catch(() => null) : null;
  return { ch, msg };
}

/** Ubah status saran (dipakai tombol Kelola & /suggestion status). */
async function setStatus(guild, s, status, staffId, note) {
  const cfg = loadConfig();
  s.status = status;
  s.response = note || null;
  s.reviewedBy = staffId;
  s.reviewedAt = Date.now();
  save();
  const { msg } = await fetchCard(s);
  if (msg) await msg.edit(buildSuggestion(guild, cfg, s)).catch((e) => console.warn('[suggestions] edit:', e.message));
  if (s.threadId) {
    const th = await guild.channels.fetch(s.threadId).catch(() => null);
    if (th) {
      await th
        .send({
          ...card({
            color: statusColor(cfg, status),
            header: `## ${STATUS[status].emoji} Status Diperbarui: ${STATUS[status].label}`,
            blocks: [`🛠️ **Oleh:** <@${staffId}>${note ? `\n💬 **Tanggapan:** ${note}` : ''}`],
          }),
        })
        .catch(() => {});
      if (locked(s)) await th.setLocked(true).catch(() => {});
      else if (th.locked) await th.setLocked(false).catch(() => {});
    }
  }
  if (cfg.dmAuthor !== false) {
    const u = await client.users.fetch(s.userId).catch(() => null);
    await u?.send(buildStatusDM(guild, cfg, s)).catch(() => {});
  }
  refreshPanel();
}

async function deleteSuggestion(guild, s) {
  s.deleted = true;
  save();
  const { msg } = await fetchCard(s);
  await msg?.delete().catch(() => {});
  if (s.threadId) {
    const th = await guild.channels.fetch(s.threadId).catch(() => null);
    await th?.delete().catch(() => {});
  }
  refreshPanel();
}

const optional = (fields, id) => {
  try {
    return (fields.getTextInputValue(id) || '').trim();
  } catch {
    return '';
  }
};

async function submit(interaction, cat) {
  const cfg = loadConfig();
  const guild = interaction.guild;
  const channel =
    (isId(cfg.channelId) && (await guild.channels.fetch(cfg.channelId).catch(() => null))) ||
    (data.panel ? await guild.channels.fetch(data.panel.channelId).catch(() => null) : null) ||
    interaction.channel;
  if (!channel?.isTextBased()) return interaction.editReply({ content: '❌ Channel suggestions tidak ditemukan. Hubungi admin.' });

  data.seq = (data.seq || 0) + 1;
  const s = {
    id: `SG-${String(data.seq).padStart(4, '0')}`,
    guildId: guild.id,
    channelId: channel.id,
    messageId: null,
    threadId: null,
    userId: interaction.user.id,
    avatar: interaction.user.displayAvatarURL({ extension: 'png', size: 256 }),
    category: cat.id,
    title: interaction.fields.getTextInputValue('title').trim(),
    detail: interaction.fields.getTextInputValue('detail').trim(),
    benefit: optional(interaction.fields, 'benefit') || null,
    up: [],
    down: [],
    status: 'pending',
    createdAt: Date.now(),
  };
  let msg;
  try {
    msg = await channel.send(buildSuggestion(guild, cfg, s));
  } catch (err) {
    data.seq -= 1;
    console.error('[suggestions] gagal kirim:', err.message);
    return interaction.editReply({ content: '❌ Saran gagal dikirim. Coba lagi atau hubungi admin.' });
  }
  s.messageId = msg.id;
  data.items[s.id] = s;
  save();
  if (cfg.createThread !== false) {
    const th = await msg.startThread({ name: `💬 ${s.id} • ${s.title}`.slice(0, 100), autoArchiveDuration: 10080, reason: `Diskusi saran ${s.id}` }).catch((e) => {
      console.warn('[suggestions] gagal buat thread:', e.message);
      return null;
    });
    if (th) {
      s.threadId = th.id;
      save();
      await msg.edit(buildSuggestion(guild, cfg, s)).catch(() => {});
    }
  }
  scheduleSticky(channel);

  const done = card({
      color: hex(cfg.colors?.approved, 0x2ecc71),
      header: `## ✅ Saran Terkirim!\nTerima kasih, saranmu **${s.id}** sudah masuk. 💙`,
      blocks: [
        `${cat.emoji || '💡'} **Peruntukan:** ${cat.label}\n📌 **Judul:** ${s.title}\n🏷️ **Status:** \`⏳ Menunggu Review\``,
        '-# Kamu akan mendapat DM saat status saranmu diperbarui oleh tim kami.',
      ],
      rows: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Lihat Saran').setEmoji('💡').setURL(`https://discord.com/channels/${guild.id}/${channel.id}/${msg.id}`),
        ),
      ],
    });
  return interaction.editReply(done).catch(() => interaction.editReply({ content: `✅ Saran **${s.id}** terkirim! Terima kasih 💙` }).catch(() => {}));
}

async function handleInteraction(interaction) {
  const id = interaction.customId;
  if (typeof id !== 'string' || !id.startsWith('sg:')) return false;
  const [, action, sid, extra] = id.split(':');
  const cfg = loadConfig();
  try {
    if (action === 'cat' && interaction.isStringSelectMenu()) {
      const cat = catOf(cfg, interaction.values[0]);
      // Reset pilihan dropdown di panel supaya bisa dipilih lagi.
      const resetPanel = () => interaction.message?.edit(buildPanel(interaction.guild, cfg)).catch(() => {});
      const last = Object.values(data.items)
        .filter((s) => s.userId === interaction.user.id)
        .sort((a, b) => b.createdAt - a.createdAt)[0];
      const wait = last ? last.createdAt + (Number(cfg.cooldownMinutes) || 0) * 6e4 - Date.now() : 0;
      if (wait > 0 && !isStaff(interaction.member, cfg)) {
        await interaction.reply(
          notice(cfg, hex(cfg.colors?.rejected, 0xe74c3c), '## ⏳ Tunggu Sebentar', [`Kamu baru saja mengirim saran. Kamu bisa mengirim saran lagi ${ts(Date.now() + wait, 'R')}.`]),
        );
        return void resetPanel();
      }
      await interaction.showModal(buildForm(cat));
      return void resetPanel();
    }

    if (action === 'form' && interaction.isModalSubmit()) {
      await interaction.deferReply({ flags: EPH });
      return void (await submit(interaction, catOf(cfg, sid)));
    }

    if (action === 'mine') return void (await interaction.reply(buildMine(cfg, interaction.user.id)));

    const s = data.items[sid];
    if (!s || s.deleted) {
      return void (await interaction.reply({ content: '❌ Saran tidak ditemukan / sudah dihapus.', flags: EPH }));
    }

    if (action === 'up' || action === 'down') {
      if (locked(s)) return void (await interaction.reply({ content: '🔒 Vote untuk saran ini sudah ditutup.', flags: EPH }));
      const uid = interaction.user.id;
      const mine = action === 'up' ? s.up : s.down;
      const other = action === 'up' ? s.down : s.up;
      if (mine.includes(uid)) mine.splice(mine.indexOf(uid), 1); // klik lagi = batal vote
      else {
        mine.push(uid);
        if (other.includes(uid)) other.splice(other.indexOf(uid), 1);
      }
      save();
      return void (await interaction.update(buildSuggestion(interaction.guild, cfg, s)));
    }

    if (action === 'manage') {
      if (!isStaff(interaction.member, cfg)) {
        return void (await interaction.reply({ content: '⛔ Hanya staff yang bisa mengelola saran.', flags: EPH }));
      }
      return void (await interaction.reply(buildManage(cfg, s)));
    }

    if (action === 'setst' && interaction.isStringSelectMenu()) {
      if (!isStaff(interaction.member, cfg)) return void (await interaction.reply({ content: '⛔ Khusus staff.', flags: EPH }));
      return void (await interaction.showModal(buildStatusModal(s, interaction.values[0])));
    }

    if (action === 'stmodal' && interaction.isModalSubmit()) {
      if (!isStaff(interaction.member, cfg) || !STATUS[extra]) return void (await interaction.reply({ content: '⛔ Khusus staff.', flags: EPH }));
      await interaction.deferReply({ flags: EPH });
      await setStatus(interaction.guild, s, extra, interaction.user.id, optional(interaction.fields, 'note'));
      return void (await interaction.editReply({ content: `✅ Status **${s.id}** diubah menjadi **${STATUS[extra].emoji} ${STATUS[extra].label}**.` }));
    }

    if (action === 'del') {
      if (!isStaff(interaction.member, cfg)) return void (await interaction.reply({ content: '⛔ Khusus staff.', flags: EPH }));
      await deleteSuggestion(interaction.guild, s);
      return void (await interaction.update(card({ color: hex(cfg.colors?.rejected, 0xe74c3c), header: `## 🗑️ Saran ${s.id} Dihapus`, blocks: ['Pesan saran & thread diskusinya sudah dihapus.'] })));
    }
  } catch (err) {
    console.error('[suggestions] error:', err);
    const msg = { content: '❌ Terjadi kesalahan, coba lagi.', flags: EPH };
    if (interaction.deferred || interaction.replied) await interaction.followUp(msg).catch(() => {});
    else await interaction.reply(msg).catch(() => {});
  }
  return true;
}

// ───────────────────────── Command ─────────────────────────
const idOption = (o) => o.setName('id').setDescription('ID saran (contoh SG-0001)').setRequired(true).setAutocomplete(true);

const suggestionCommand = {
  data: new SlashCommandBuilder()
    .setName('suggestion')
    .setDescription('Kelola fitur suggestions / kotak saran')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addSubcommand((s) =>
      s
        .setName('panel')
        .setDescription('Kirim panel suggestions (sticky, selalu di paling bawah)')
        .addChannelOption((o) => o.setName('channel').setDescription('Default: channelId di suggestions.json').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
    )
    .addSubcommand((s) =>
      s
        .setName('status')
        .setDescription('Ubah status saran')
        .addStringOption(idOption)
        .addStringOption((o) =>
          o
            .setName('status')
            .setDescription('Status baru')
            .setRequired(true)
            .addChoices(...Object.entries(STATUS).map(([value, x]) => ({ name: `${x.emoji} ${x.label}`, value }))),
        )
        .addStringOption((o) => o.setName('tanggapan').setDescription('Tanggapan untuk pengirim').setMaxLength(500)),
    )
    .addSubcommand((s) => s.setName('hapus').setDescription('Hapus saran (beserta thread diskusinya)').addStringOption(idOption)),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const cfg = loadConfig();
    await interaction.deferReply({ flags: EPH });

    if (sub === 'panel') {
      const channel =
        interaction.options.getChannel('channel') ||
        (isId(cfg.channelId) ? await interaction.guild.channels.fetch(cfg.channelId).catch(() => null) : null) ||
        interaction.channel;
      if (!channel?.isTextBased()) return interaction.editReply('❌ Channel tidak ditemukan.');
      await repostPanel(channel);
      return interaction.editReply(`✅ Panel suggestions dikirim ke ${channel}. Panel akan otomatis pindah ke paling bawah setiap ada saran / pesan baru.`);
    }

    const sid = interaction.options.getString('id').trim().toUpperCase();
    const s = data.items[sid];
    if (!s || s.deleted) return interaction.editReply(`❌ Saran \`${sid}\` tidak ditemukan.`);

    if (sub === 'status') {
      const status = interaction.options.getString('status');
      await setStatus(interaction.guild, s, status, interaction.user.id, interaction.options.getString('tanggapan'));
      return interaction.editReply(`✅ Status **${s.id}** diubah menjadi **${STATUS[status].emoji} ${STATUS[status].label}**.`);
    }
    if (sub === 'hapus') {
      await deleteSuggestion(interaction.guild, s);
      return interaction.editReply(`🗑️ Saran **${s.id}** dihapus.`);
    }
  },

  async autocomplete(interaction) {
    const q = String(interaction.options.getFocused() || '').toLowerCase();
    const choices = Object.values(data.items)
      .filter((s) => !s.deleted && s.guildId === interaction.guildId)
      .filter((s) => !q || s.id.toLowerCase().includes(q) || s.title.toLowerCase().includes(q))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 25)
      .map((s) => ({ name: `${s.id} • ${STATUS[s.status].emoji} ${s.title}`.slice(0, 100), value: s.id }));
    await interaction.respond(choices).catch(() => {});
  },
};

function registerSuggestions(c) {
  client = c;
  // Ada pesan baru dari member di channel suggestions → panel dipindah ke paling bawah (sticky).
  c.on(Events.MessageCreate, (msg) => {
    if (!data.panel || msg.channelId !== data.panel.channelId) return;
    if (msg.author?.id === c.user?.id) return; // pesan bot sendiri (saran / panel) ditangani langsung
    scheduleSticky(msg.channel);
  });
  c.once(Events.ClientReady, () => refreshPanel());
}

module.exports = { suggestionCommand, handleInteraction, registerSuggestions };
