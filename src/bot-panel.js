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
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  ModalBuilder,
  LabelBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
} = require('discord.js');
const UI = require('./ui');
const { userInfoCommand, robloxCommand } = require('./profile-info');
const { serverCheckCommand } = require('./server-check');

/**
 * Bot Command Center — panel sticky (Components V2) di channel bot command.
 * Tombol: 👤 Info Akun Discord • 🎮 Info Akun Roblox • 🔍 Cek Server.
 * Tombol membuka form kecil → hasil (tampilan /userinfo, /roblox, /cekserver) dikirim PUBLIK ke channel hasil (RESULT_CHANNEL);
 * pemakai mendapat info + tombol menuju hasilnya. Pesan gagal (tidak ditemukan, dll) hanya terlihat oleh pemakai.
 * Panel selalu dipindah ke paling bawah saat ada pesan baru di channel.
 */
const DEFAULT_CHANNEL = '1553613922639151176';
const RESULT_CHANNEL = '1563185053834412134'; // hasil pengecekan dari panel tampil publik di sini
const DATA = path.join(__dirname, '..', 'data', 'bot-panel.json');
const V2 = MessageFlags.IsComponentsV2;
const EPH = MessageFlags.Ephemeral;
const BRAND = 0x3498db;
const isId = (v) => /^\d{17,20}$/.test(String(v || ''));
const text = (c) => new TextDisplayBuilder().setContent(String(c));
const line = (big = false) => new SeparatorBuilder().setDivider(true).setSpacing(big ? SeparatorSpacingSize.Large : SeparatorSpacingSize.Small);

let panel = (() => {
  try {
    return JSON.parse(fs.readFileSync(DATA, 'utf8'));
  } catch {
    return null;
  }
})(); // { channelId, messageId }
function savePanel() {
  fs.mkdirSync(path.dirname(DATA), { recursive: true });
  fs.writeFileSync(`${DATA}.tmp`, JSON.stringify(panel));
  fs.renameSync(`${DATA}.tmp`, DATA);
}

// ───────────────────────── Tampilan panel ─────────────────────────
function buildPanel(guild, client) {
  const box = UI.accent(new ContainerBuilder(), BRAND);
  const avatar = client.user.displayAvatarURL({ extension: 'png', size: 256 });
  box.addSectionComponents(
    new SectionBuilder()
      .addTextDisplayComponents(
        text(`# 🤖 Bot Command Center\n-# ${guild.name} • Tools & Info\nCek profil Discord, akun Roblox, dan info server lain dengan **sekali klik** ✨`),
      )
      .setThumbnailAccessory(new ThumbnailBuilder().setURL(avatar)),
  );
  box.addSeparatorComponents(line());

  const item = (title, desc, id, label, emoji, style = ButtonStyle.Primary) =>
    new SectionBuilder()
      .addTextDisplayComponents(text(`### ${title}\n${desc}`))
      .setButtonAccessory(new ButtonBuilder().setCustomId(id).setLabel(label).setEmoji(emoji).setStyle(style));

  box.addSectionComponents(item('👤 Info Akun Discord', 'Profil, badge, umur akun & role — via member, User ID, atau username.', 'bp:user', 'Cek Akun', '👤'));
  box.addSectionComponents(item('🎮 Info Akun Roblox', 'Avatar, status, teman, grup & username lama.', 'bp:roblox', 'Cek Roblox', '🎮'));
  box.addSectionComponents(item('🔍 Cek Server Discord', 'Member, online, boost, fitur & info invite server lain.', 'bp:server', 'Cek Server', '🔍'));

  box.addSeparatorComponents(line());
  box.addTextDisplayComponents(text(`-# 📬 Hasil pengecekan dikirim ke <#${RESULT_CHANNEL}>`));
  return { components: [box], flags: V2, allowedMentions: { parse: [] } };
}

// ───────────────────────── Form (modal) ─────────────────────────
function userModal() {
  return new ModalBuilder()
    .setCustomId('bp:m:user')
    .setTitle('👤 Info Akun Discord')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('Pilih Member')
        .setDescription('Kosongkan keduanya untuk melihat akun kamu sendiri.')
        .setUserSelectMenuComponent(new UserSelectMenuBuilder().setCustomId('member').setPlaceholder('🔍 Cari member server...').setMinValues(0).setMaxValues(1).setRequired(false)),
      new LabelBuilder()
        .setLabel('Atau User ID / Username')
        .setDescription('User ID = akun siapa saja (termasuk di luar server). Username = member server.')
        .setTextInputComponent(new TextInputBuilder().setCustomId('cari').setStyle(TextInputStyle.Short).setPlaceholder('contoh: 123456789012345678 atau budi_123').setMaxLength(64).setRequired(false)),
    );
}
function robloxModal() {
  return new ModalBuilder()
    .setCustomId('bp:m:roblox')
    .setTitle('🎮 Info Akun Roblox')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('Username Roblox')
        .setDescription('Bisa juga user ID atau link profil Roblox.')
        .setTextInputComponent(new TextInputBuilder().setCustomId('username').setStyle(TextInputStyle.Short).setPlaceholder('contoh: Builderman').setMinLength(1).setMaxLength(100).setRequired(true)),
    );
}
function serverModal() {
  return new ModalBuilder()
    .setCustomId('bp:m:server')
    .setTitle('🔍 Cek Server Discord')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('Link Invite')
        .setDescription('Contoh: discord.gg/abcd atau kodenya saja.')
        .setTextInputComponent(new TextInputBuilder().setCustomId('link').setStyle(TextInputStyle.Short).setPlaceholder('https://discord.gg/...').setMinLength(2).setMaxLength(120).setRequired(true)),
    );
}

const KIND = { userinfo: '👤 Info Akun Discord', roblox: '🎮 Info Akun Roblox', cekserver: '🔍 Cek Server Discord' };

/** Hasil sukses = kartu V2 yang punya tombol (Profil / Gabung Server). Kartu gagal tidak punya tombol. */
function isResult(p) {
  const box = p?.components?.[0];
  const json = box?.toJSON ? box.toJSON() : box;
  return Boolean(json?.type === 17 && json.components?.some((c) => c.type === 1));
}

/** Kirim hasil ke channel publik, lalu beri tahu pemakai (hanya terlihat olehnya). */
async function publishResult(i, commandName, payload) {
  const ch = await i.client.channels.fetch(RESULT_CHANNEL).catch(() => null);
  if (!ch?.isTextBased()) return i.editReply(payload); // channel hasil tidak bisa diakses → tampilkan langsung ke pemakai
  const top = new TextDisplayBuilder().setContent(`-# ${KIND[commandName] || '🔎 Hasil Pengecekan'} • diminta oleh <@${i.user.id}>`);
  const sent = await ch.send({ components: [top, ...payload.components], flags: V2, allowedMentions: { parse: [] } }).catch((e) => {
    console.warn('[bot-panel] gagal kirim hasil:', e.message);
    return null;
  });
  if (!sent) return i.editReply(payload);
  const box = UI.accent(new ContainerBuilder(),
    0x2ecc71)
    .addTextDisplayComponents(text(`## ✅ Pengecekan Selesai!\nHasil **${KIND[commandName] || 'pengecekan'}** sudah dikirim ke <#${RESULT_CHANNEL}>.\nSilakan cek hasilnya di channel tersebut 👇`))
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Lihat Hasil').setEmoji('📬').setURL(sent.url)),
    );
  return i.editReply({ components: [box], flags: V2 });
}

/**
 * Jalankan command yang sudah ada (/userinfo, /roblox, /cekserver) dari form panel.
 * Balasan sementara & pesan gagal hanya terlihat oleh pemakai; hasil sukses dikirim ke channel hasil.
 */
function asCommand(i, commandName, values) {
  const eph = (p = {}) => (typeof p === 'string' ? { content: p, flags: EPH } : { ...p, flags: (p.flags || 0) | EPH });
  return {
    commandName,
    user: i.user,
    member: i.member,
    guild: i.guild,
    guildId: i.guildId,
    channel: i.channel,
    client: i.client,
    memberPermissions: i.memberPermissions,
    get deferred() {
      return i.deferred;
    },
    get replied() {
      return i.replied;
    },
    options: {
      getUser: (k) => values[k] ?? null,
      getString: (k) => values[k] ?? null,
      getBoolean: (k) => values[k] ?? null,
    },
    deferReply: () => i.deferReply({ flags: EPH }),
    reply: (p) => i.reply(eph(p)),
    editReply: (p) => (isResult(p) ? publishResult(i, commandName, p) : i.editReply(p)),
    followUp: (p) => i.followUp(eph(p)),
    deleteReply: () => Promise.resolve(), // pesan sudah privat → tidak perlu dihapus
    fetchReply: () => i.fetchReply(),
  };
}

async function handleInteraction(i) {
  const id = i.customId;
  if (typeof id !== 'string' || !id.startsWith('bp:')) return false;
  try {
    if (i.isButton()) {
      if (id === 'bp:user') await i.showModal(userModal());
      else if (id === 'bp:roblox') await i.showModal(robloxModal());
      else if (id === 'bp:server') await i.showModal(serverModal());
      return true;
    }
    if (i.isModalSubmit()) {
      if (id === 'bp:m:user') {
        const picked = i.fields.getSelectedUsers?.('member')?.first?.() || null;
        const cari = (i.fields.getTextInputValue('cari') || '').trim() || null;
        await userInfoCommand.execute(asCommand(i, 'userinfo', { member: picked, cari }));
      } else if (id === 'bp:m:roblox') {
        await robloxCommand.execute(asCommand(i, 'roblox', { username: i.fields.getTextInputValue('username') }));
      } else if (id === 'bp:m:server') {
        await serverCheckCommand.execute(asCommand(i, 'cekserver', { link: i.fields.getTextInputValue('link'), privat: true }));
      }
      return true;
    }
  } catch (err) {
    console.error('[bot-panel] error:', err);
    const msg = { content: '❌ Terjadi kesalahan, coba lagi.', flags: EPH };
    if (i.deferred || i.replied) await i.editReply(msg).catch(() => {});
    else await i.reply(msg).catch(() => {});
  }
  return true;
}

// ───────────────────────── Sticky ─────────────────────────
let client = null;
let stickyTimer = null;
let busy = false;
async function repost(force = false) {
  if (!panel || !client || busy) return;
  busy = true;
  try {
    const ch = await client.channels.fetch(panel.channelId).catch(() => null);
    if (!ch?.isTextBased()) return;
    if (!force && ch.lastMessageId === panel.messageId) return; // sudah paling bawah
    const old = panel.messageId;
    const sent = await ch.send(buildPanel(ch.guild, client));
    panel = { channelId: ch.id, messageId: sent.id };
    savePanel();
    await ch.messages.delete(old).catch(() => {});
  } catch (e) {
    console.warn('[bot-panel] sticky:', e.message);
  } finally {
    busy = false;
  }
}

function registerBotPanel(c) {
  client = c;
  c.on(Events.InteractionCreate, (i) => {
    if (i.customId?.startsWith?.('bp:')) handleInteraction(i);
  });
  c.on(Events.MessageCreate, (msg) => {
    if (!panel || msg.channelId !== panel.channelId || msg.author?.id === c.user?.id) return;
    clearTimeout(stickyTimer);
    stickyTimer = setTimeout(() => repost(), 6000); // tunggu chat reda → panel pindah ke bawah
  });
  c.once(Events.ClientReady, async () => {
    // Perbarui tampilan panel setelah restart (pesan dihapus manual → berhenti).
    if (!panel) return;
    const ch = await c.channels.fetch(panel.channelId).catch(() => null);
    if (!ch) return;
    try {
      await ch.messages.edit(panel.messageId, buildPanel(ch.guild, c));
    } catch (e) {
      if (e.code === 10008) {
        panel = null;
        savePanel();
      }
    }
  });
}

// ───────────────────────── Command admin ─────────────────────────
const botPanelCommand = {
  data: new SlashCommandBuilder()
    .setName('botpanel')
    .setDescription('Panel Bot Command Center (khusus admin)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addSubcommand((s) =>
      s
        .setName('kirim')
        .setDescription('Kirim / pindahkan panel Bot Command Center')
        .addChannelOption((o) => o.setName('channel').setDescription(`Default: <#${DEFAULT_CHANNEL}>`).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
    )
    .addSubcommand((s) => s.setName('hapus').setDescription('Hapus panel Bot Command Center')),
  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    await interaction.deferReply({ flags: EPH });
    const old = panel;
    if (sub === 'hapus') {
      if (!old) return interaction.editReply('ℹ️ Tidak ada panel yang aktif.');
      panel = null;
      savePanel();
      const ch = await interaction.guild.channels.fetch(old.channelId).catch(() => null);
      await ch?.messages.delete(old.messageId).catch(() => {});
      return interaction.editReply(`🗑️ Panel di <#${old.channelId}> sudah dihapus.`);
    }
    const channel =
      interaction.options.getChannel('channel') || (await interaction.guild.channels.fetch(DEFAULT_CHANNEL).catch(() => null)) || interaction.channel;
    if (!channel?.isTextBased()) return interaction.editReply('❌ Channel tidak ditemukan.');
    const sent = await channel.send(buildPanel(interaction.guild, interaction.client));
    panel = { channelId: channel.id, messageId: sent.id };
    savePanel();
    if (old && old.messageId !== sent.id) {
      const oldCh = await interaction.guild.channels.fetch(old.channelId).catch(() => null);
      await oldCh?.messages.delete(old.messageId).catch(() => {});
    }
    return interaction.editReply(`✅ Panel **Bot Command Center** dikirim ke ${channel} — selalu di paling bawah channel.`);
  },
};

module.exports = { registerBotPanel, botPanelCommand, buildPanel, handleInteraction };
