const fs = require('fs');
const path = require('path');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  UserSelectMenuBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  ChannelType,
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
 * Cari Teman di Voice (Components V2).
 * Panel sticky: pilih member → hasil voice channel + tombol join. Panel menampilkan voice teramai (ter-update otomatis).
 * Teks di voice-finder.json.
 */
const FILE = path.join(__dirname, '..', 'voice-finder.json');
const VERIFY_FILE = path.join(__dirname, '..', 'verify.json');
const PANEL_FILE = path.join(__dirname, '..', 'data', 'voice-finder-panel.json');
const SELECT_ID = 'vf:select';
const ALL_ID = 'vf:all';
const V2 = MessageFlags.IsComponentsV2;
const EPH = MessageFlags.Ephemeral;
const isId = (v) => /^\d{17,20}$/.test(String(v || ''));
const ts = (ms, s = 'R') => `<t:${Math.floor(ms / 1000)}:${s}>`;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
const loadConfig = () => readJson(FILE, {});

function parseColor(value, fallback) {
  const n = parseInt(String(value || '').replace('#', ''), 16);
  return Number.isNaN(n) ? fallback : n;
}

// ---------- Lokasi panel (untuk sticky) ----------
let panels = readJson(PANEL_FILE, {}); // { "<channelId>": "<messageId>" }
function savePanels() {
  fs.mkdirSync(path.dirname(PANEL_FILE), { recursive: true });
  fs.writeFileSync(`${PANEL_FILE}.tmp`, JSON.stringify(panels, null, 2));
  fs.renameSync(`${PANEL_FILE}.tmp`, PANEL_FILE);
}

// ---------- Tampilan (Components V2) ----------
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

/**
 * Role yang dipakai untuk menilai "voice ini boleh diumumkan ke publik?".
 * Pakai role verifikasi dari verify.json kalau ada, kalau tidak pakai @everyone.
 */
function publicRole(guild) {
  const roleId = readJson(VERIFY_FILE, {}).roleId;
  return (isId(roleId) && guild.roles.cache.get(roleId)) || guild.roles.everyone;
}
const isPublic = (guild, ch) => !!ch.permissionsFor(publicRole(guild))?.has(PermissionFlagsBits.ViewChannel);
const humans = (ch) => ch.members.filter((m) => !m.user.bot);

/** Voice channel publik yang sedang ada orangnya, urut dari yang teramai. */
function activeVoices(guild) {
  return guild.channels.cache
    .filter((c) => (c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice) && isPublic(guild, c) && humans(c).size > 0)
    .sort((a, b) => humans(b).size - humans(a).size);
}
const limitText = (ch) => (ch.userLimit ? `${humans(ch).size}/${ch.userLimit}` : `${humans(ch).size}`);

function buildPanel(guild, cfg) {
  const p = cfg.panel || {};
  const voices = [...activeVoices(guild).values()];
  const inVoice = voices.reduce((a, c) => a + humans(c).size, 0);
  const top = voices.slice(0, Math.max(0, Number(cfg.topVoices ?? 3)));
  const live = [`🎧 **Sedang di Voice:** \`${inVoice} member\``, `🔊 **Voice Aktif:** \`${voices.length} channel\``];
  if (top.length) live.push('', '**🔥 Voice Teramai**', ...top.map((c, i) => `\`${i + 1}.\` <#${c.id}> • 👥 \`${limitText(c)}\``));

  return card({
    color: parseColor(cfg.color, 0x3498db),
    thumb: guild.iconURL({ extension: 'png', size: 256 }),
    header: `# ${p.title || '🔎 Cari Teman di Voice'}\n-# ${p.subtitle || `${guild.name} • Voice Finder`}`,
    blocks: [
      p.description || 'Pilih member di bawah untuk melihat dia sedang di voice mana.',
      `### 📡 Live Voice\n${live.join('\n')}`,
    ],
    footer: `${p.footer || guild.name} • Diperbarui ${ts(Date.now())}`,
    rows: [
      new ActionRowBuilder().addComponents(
        new UserSelectMenuBuilder().setCustomId(SELECT_ID).setPlaceholder(p.placeholder || '🔍 Ketik username / nama member...').setMinValues(1).setMaxValues(1),
      ),
      new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(ALL_ID).setLabel(p.allButton || 'Lihat Semua Voice').setEmoji('🎧').setStyle(ButtonStyle.Secondary)),
    ],
  });
}

function statusText(vs) {
  const s = [];
  if (vs.selfDeaf || vs.serverDeaf) s.push('🔇 Deafen');
  else if (vs.selfMute || vs.serverMute) s.push('🔕 Mute');
  else s.push('🎙️ Aktif');
  if (vs.streaming) s.push('🔴 Live');
  if (vs.selfVideo) s.push('📷 Kamera');
  return s.join(' • ');
}

const joinRow = (guild, channel) =>
  new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel(`Join ${channel.name}`.slice(0, 80))
      .setEmoji('🔊')
      .setURL(`https://discord.com/channels/${guild.id}/${channel.id}`),
  );

// ---------- Saat member dipilih ----------
async function handleSelect(interaction) {
  const cfg = loadConfig();
  const guild = interaction.guild;
  const userId = interaction.values[0];
  const member = await guild.members.fetch(userId).catch(() => null);
  const vs = guild.voiceStates.cache.get(userId);
  const channel = vs?.channel;
  const footer = `${cfg.panel?.footer || guild.name} • ${ts(Date.now(), 'f')}`;
  resetPanel(interaction, cfg); // kosongkan pilihan di panel supaya bisa mencari lagi

  // Tidak di voice / voice tidak bisa dilihat pencari → balasan pribadi saja.
  const canSee = channel?.permissionsFor(interaction.member)?.has(PermissionFlagsBits.ViewChannel);
  if (!member || member.user.bot || !channel || !canSee) {
    const voices = [...activeVoices(guild).values()].slice(0, 3);
    const payload = card({
      color: parseColor(cfg.notFoundColor, 0xed4245),
      thumb: member?.displayAvatarURL({ extension: 'png', size: 256 }) || null,
      header: `## ❌ Tidak Sedang di Voice\n${
        member ? `<@${member.id}> (\`@${member.user.username}\`) sedang **tidak berada di voice channel** mana pun.` : 'Member tidak ditemukan di server ini.'
      }`,
      blocks: [voices.length ? `### 🔥 Voice yang Sedang Ramai\n${voices.map((c) => `▸ <#${c.id}> • 👥 \`${limitText(c)}\``).join('\n')}` : null],
      footer,
    });
    return interaction.reply({ ...payload, flags: V2 | EPH });
  }

  const others = humans(channel).filter((m) => m.id !== member.id);
  const list = [...others.values()].slice(0, 10).map((m) => `▸ <@${m.id}>`);
  const payload = card({
    color: parseColor(cfg.foundColor, 0x43b581),
    thumb: member.displayAvatarURL({ extension: 'png', size: 256 }),
    header: `## 🔊 ${member.displayName} Sedang di Voice!\n-# Dicari oleh ${interaction.member.displayName}`,
    blocks: [
      [
        `👤 **Member:** <@${member.id}> • \`@${member.user.username}\``,
        `🔊 **Voice Channel:** <#${channel.id}>`,
        `👥 **Isi Voice:** \`${limitText(channel)} orang\``,
        `🎚️ **Status:** ${statusText(vs)}`,
      ].join('\n'),
      list.length ? `### 🎧 Bersama di Voice\n${list.join('\n')}${others.size > 10 ? `\n-# …dan ${others.size - 10} lainnya` : ''}` : '-# Dia sendirian di voice — yuk temani! 🙌',
    ],
    footer,
    rows: [joinRow(guild, channel)],
  });

  // Voice private (tidak bisa dilihat member biasa) → jangan diumumkan ke publik.
  const pub = isPublic(guild, channel);
  if (!pub) payload.flags = V2 | EPH;
  await interaction.reply(payload);

  // Hapus hasil publik otomatis setelah X menit (0 = tidak dihapus).
  const minutes = Number(cfg.deleteResultAfterMinutes) || 0;
  if (pub && minutes > 0) setTimeout(() => interaction.deleteReply().catch(() => {}), minutes * 60 * 1000);
}

/** Tombol "Lihat Semua Voice" → daftar voice publik yang sedang aktif (hanya terlihat yang menekan). */
async function handleAll(interaction) {
  const cfg = loadConfig();
  const guild = interaction.guild;
  const voices = [...activeVoices(guild).values()].filter((c) => c.permissionsFor(interaction.member)?.has(PermissionFlagsBits.ViewChannel));
  const blocks = voices.slice(0, 10).map((c) => {
    const ms = [...humans(c).values()];
    const names = ms.slice(0, 8).map((m) => `<@${m.id}>`).join(', ');
    return `🔊 <#${c.id}> • 👥 \`${limitText(c)}\`\n┗ ${names}${ms.length > 8 ? ` +${ms.length - 8}` : ''}`;
  });
  const payload = card({
    color: parseColor(cfg.color, 0x3498db),
    header: `## 🎧 Semua Voice Aktif (${voices.length})\nVoice channel yang sedang ada membernya.`,
    blocks: [blocks.length ? blocks.join('\n\n') : '_Belum ada member yang sedang di voice._ 😴', voices.length > 10 ? `-# …dan ${voices.length - 10} voice lainnya` : null],
    footer: `${cfg.panel?.footer || guild.name} • ${ts(Date.now(), 'f')}`,
  });
  return interaction.reply({ ...payload, flags: V2 | EPH });
}

/** Panel di-edit ulang (pilihan dropdown kosong lagi & angka terbaru). */
function resetPanel(interaction, cfg) {
  if (interaction.message && panels[interaction.channelId] === interaction.message.id) {
    interaction.message.edit(buildPanel(interaction.guild, cfg)).catch(() => {});
  }
}

// ---------- Sticky panel ----------
const timers = new Map();
const busy = new Set();

async function repostPanel(channel) {
  if (busy.has(channel.id)) return;
  busy.add(channel.id);
  try {
    const oldId = panels[channel.id];
    const sent = await channel.send(buildPanel(channel.guild, loadConfig()));
    panels[channel.id] = sent.id;
    savePanels();
    if (oldId) await channel.messages.delete(oldId).catch(() => {});
  } catch (err) {
    console.error(`[voice-finder] gagal memindahkan panel di #${channel.name}:`, err.message);
  } finally {
    // Beri jeda supaya event pesan panel sendiri tidak memicu sticky lagi.
    setTimeout(() => busy.delete(channel.id), 1500);
  }
}

/** Cari tombol/dropdown panel di dalam komponen pesan (termasuk di dalam kotak V2). */
function hasPanelSelect(components) {
  return (components || []).some((c) => c.customId === SELECT_ID || hasPanelSelect(c.components));
}

/** Angka "Live Voice" di semua panel ikut ter-update saat member masuk / keluar voice. */
let liveTimer = null;
function scheduleLiveUpdate(client) {
  if (liveTimer) return;
  liveTimer = setTimeout(async () => {
    liveTimer = null;
    const cfg = loadConfig();
    for (const [channelId, messageId] of Object.entries(panels)) {
      if (busy.has(channelId)) continue;
      const ch = await client.channels.fetch(channelId).catch(() => null);
      if (!ch) continue;
      await ch.messages.edit(messageId, buildPanel(ch.guild, cfg)).catch(async (err) => {
        // Panel lama format embed tidak bisa diubah ke V2 → kirim ulang.
        if (err.code !== 10008) await repostPanel(ch);
      });
    }
  }, Math.max(10, Number(loadConfig().liveUpdateSeconds) || 15) * 1000);
}

/** Setiap ada pesan baru di channel panel → panel dipindah ke paling bawah (jeda singkat supaya tidak spam). */
function registerStickyPanel(client) {
  client.on(Events.MessageCreate, (message) => {
    const panelId = panels[message.channelId];
    if (!panelId || message.id === panelId) return;
    // Abaikan panel yang baru dikirim bot sendiri.
    if (message.author.id === client.user.id && (busy.has(message.channelId) || hasPanelSelect(message.components))) return;

    const delay = Math.max(2, Number(loadConfig().stickyDelaySeconds) || 5) * 1000;
    clearTimeout(timers.get(message.channelId));
    timers.set(
      message.channelId,
      setTimeout(() => {
        timers.delete(message.channelId);
        repostPanel(message.channel);
      }, delay),
    );
  });

  client.on(Events.VoiceStateUpdate, (oldS, newS) => {
    if (oldS.channelId !== newS.channelId && Object.keys(panels).length) scheduleLiveUpdate(client);
  });
  client.once(Events.ClientReady, () => scheduleLiveUpdate(client));

  client.on(Events.ChannelDelete, (ch) => {
    if (panels[ch.id]) {
      delete panels[ch.id];
      savePanels();
    }
  });
}

// ---------- /cari-voice ----------
const voiceFinderCommand = {
  data: new SlashCommandBuilder()
    .setName('cari-voice')
    .setDescription('Kirim panel (sticky) untuk mencari member yang sedang di voice')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addChannelOption((o) =>
      o.setName('channel').setDescription('Channel tujuan (default: channel ini)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
    ),

  async execute(interaction) {
    await interaction.deferReply({ flags: EPH });
    const channel = interaction.options.getChannel('channel') || interaction.channel;
    const perms = channel.permissionsFor(interaction.guild.members.me);
    const needed = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory];
    if (!perms?.has(needed)) {
      return interaction.editReply(`❌ Bot butuh izin View Channel, Send Messages, dan Read Message History di ${channel}.`);
    }
    await repostPanel(channel); // kirim panel baru + hapus panel lama di channel ini
    return interaction.editReply(`✅ Panel cari voice dikirim ke ${channel} dan akan selalu berada di paling bawah.`);
  },
};

module.exports = { voiceFinderCommand, handleSelect, handleAll, registerStickyPanel, SELECT_ID, ALL_ID };
