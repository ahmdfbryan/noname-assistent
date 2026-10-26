const fs = require('fs');
const path = require('path');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  MessageFlags,
  RESTJSONErrorCodes,
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

/**
 * Social Media (Components V2): 1 kotak pembuka + kotak Roblox, TikTok, Discord (masing-masing dengan tombol link).
 * Data Roblox (username, avatar, followers) & Discord (member, invite) diambil otomatis
 * dan di-update tiap 1 jam. Teks diatur di social.json.
 */
const FILE = path.join(__dirname, '..', 'social.json');
const STATE_FILE = path.join(__dirname, '..', 'data', 'social-state.json');
const REFRESH_MS = 60 * 60 * 1000;
const ROBLOX = process.env.ROBLOX_DOMAIN || 'roblox.com';
const TEXT = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (err) {
    console.error('[social] social.json tidak bisa dibaca:', err.message);
    return null;
  }
}
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}
function saveState(s) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(`${STATE_FILE}.tmp`, JSON.stringify(s, null, 2));
  fs.renameSync(`${STATE_FILE}.tmp`, STATE_FILE);
}

const color = (v, fb) => {
  const n = parseInt(String(v || '').replace('#', ''), 16);
  return Number.isNaN(n) ? fb : n;
};
const num = (n) => Math.round(Number(n) || 0).toLocaleString('id-ID');
const fill = (t, guild) => String(t || '').replace(/\{server\}/g, guild.name);
const ts = (ms, s = 'D') => `<t:${Math.floor(ms / 1000)}:${s}>`;
const isId = (v) => /^\d{17,20}$/.test(String(v || ''));

async function getJson(url) {
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** Data akun Roblox: username, display name, tanggal dibuat, avatar, followers, friends. */
async function robloxInfo(userId) {
  if (!/^\d+$/.test(String(userId || ''))) return null;
  const [user, thumb, followers, friends] = await Promise.all([
    getJson(`https://users.${ROBLOX}/v1/users/${userId}`),
    getJson(`https://thumbnails.${ROBLOX}/v1/users/avatar-headshot?userIds=${userId}&size=420x420&format=Png&isCircular=false`),
    getJson(`https://friends.${ROBLOX}/v1/users/${userId}/followers/count`),
    getJson(`https://friends.${ROBLOX}/v1/users/${userId}/friends/count`),
  ]);
  return {
    name: user?.name || null,
    displayName: user?.displayName || null,
    created: user?.created ? Date.parse(user.created) : null,
    avatar: thumb?.data?.[0]?.imageUrl || null,
    followers: followers?.count ?? null,
    friends: friends?.count ?? null,
  };
}

/** ID Discord → server (buat link undangan permanen) atau akun (link profil). */
async function discordInfo(client, guild, d, st) {
  const id = String(d.id || '');
  const target = client.guilds.cache.get(id) || (id === guild.id ? guild : null);
  if (target) {
    let url = d.inviteUrl || (target.vanityURLCode ? `https://discord.gg/${target.vanityURLCode}` : st.inviteUrl || null);
    if (!url) {
      const ch =
        (isId(d.inviteChannelId) && target.channels.cache.get(d.inviteChannelId)) ||
        target.rulesChannel ||
        target.systemChannel ||
        target.channels.cache.find((c) => c.type === ChannelType.GuildText && c.permissionsFor(target.members.me)?.has(PermissionFlagsBits.CreateInstantInvite));
      const invite = await ch?.createInvite({ maxAge: 0, maxUses: 0, unique: false, reason: 'Link undangan untuk embed Social Media' }).catch((e) => {
        console.warn('[social] gagal membuat invite:', e.message);
        return null;
      });
      if (invite) {
        url = invite.url;
        st.inviteUrl = url; // simpan supaya tidak membuat invite baru terus
      }
    }
    return {
      kind: 'server',
      name: target.name,
      icon: target.iconURL({ extension: 'png', size: 256 }),
      members: target.memberCount,
      created: target.createdTimestamp,
      boosts: target.premiumSubscriptionCount || 0,
      url: url || `https://discord.com/channels/${target.id}`,
    };
  }
  const user = isId(id) ? await client.users.fetch(id).catch(() => null) : null;
  return {
    kind: 'user',
    name: user ? user.globalName || user.username : null,
    username: user?.username || null,
    icon: user?.displayAvatarURL({ extension: 'png', size: 256 }) || null,
    created: user?.createdTimestamp || null,
    url: d.inviteUrl || `https://discord.com/users/${id}`,
  };
}

// ───────────────────────── Tampilan (Components V2) ─────────────────────────
const V2 = MessageFlags.IsComponentsV2;
const text = (c) => new TextDisplayBuilder().setContent(String(c).slice(0, 4000));
const line = () => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);

/** Satu kotak V2 per platform: header (+ avatar) → garis → info → tombol → footer (khusus kotak terakhir). */
function box({ accent, header, thumb, blocks = [], image, button }) {
  // Tanpa warna aksen di kiri (hanya garis kotak), kecuali social.json "showAccent": true.
  const c = new ContainerBuilder();
  if (loadConfig()?.showAccent === true && accent != null) c.setAccentColor(accent);
  if (thumb) c.addSectionComponents(new SectionBuilder().addTextDisplayComponents(text(header)).setThumbnailAccessory(new ThumbnailBuilder().setURL(thumb)));
  else c.addTextDisplayComponents(text(header));
  if (image) c.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(image)));
  for (const b of blocks.filter(Boolean)) {
    c.addSeparatorComponents(line());
    c.addTextDisplayComponents(text(b));
  }
  if (button) c.addActionRowComponents(new ActionRowBuilder().addComponents(button));
  return c;
}
const link = (label, emoji, url) => new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(label).setEmoji(emoji).setURL(url);

async function buildSocial(client, guild) {
  const cfg = loadConfig();
  if (!cfg) return null;
  const st = loadState();
  const boxes = [];

  // Kotak pembuka
  boxes.push(
    box({
      accent: color(cfg.color, 0x3498db),
      thumb: guild.iconURL({ extension: 'png', size: 256 }),
      header: `# ${fill(cfg.title || '🌐 Social Media | {server}', guild)}\n-# ${fill(cfg.subtitle || 'Official Social Media • {server}', guild)}`,
      image: cfg.bannerImage || null,
      blocks: [fill(cfg.description, guild) || null],
    }),
  );

  if (cfg.roblox?.userId) {
    const r = cfg.roblox;
    const info = await robloxInfo(r.userId);
    const url = r.url || `https://www.roblox.com/users/${r.userId}/profile`;
    const lines = [];
    if (info?.name) {
      lines.push(`👤 **Username:** \`@${info.name}\``, `✨ **Display Name:** \`${info.displayName}\``);
      if (info.followers != null) lines.push(`👥 **Followers:** \`${num(info.followers)}\``);
      if (info.friends != null) lines.push(`🤝 **Friends:** \`${num(info.friends)}\``);
      if (info.created) lines.push(`📅 **Bergabung:** ${ts(info.created, 'D')}`);
    }
    boxes.push(
      box({
        accent: color(r.color, 0x00a2ff),
        thumb: info?.avatar || null,
        header: `## ${r.title || '🎮 Roblox'}\n${fill(r.description, guild)}`,
        blocks: [lines.join('\n') || null],
        button: link(r.button || 'Roblox', '🎮', url),
      }),
    );
  }

  if (cfg.tiktok?.url) {
    const t = cfg.tiktok;
    const user = String(t.username || (t.url.match(/@([^/?]+)/) || [])[1] || '').replace(/^@/, '');
    boxes.push(
      box({
        accent: color(t.color, 0xfe2c55),
        thumb: t.thumbnail || null,
        header: `## ${t.title || '🎵 TikTok'}\n${fill(t.description, guild)}`,
        blocks: [[user ? `👤 **Username:** \`@${user}\`` : null, '🔔 **Jangan Lupa:** `Follow • Like • Share`'].filter(Boolean).join('\n')],
        button: link(t.button || 'TikTok', '🎵', t.url),
      }),
    );
  }

  if (cfg.discord?.id || cfg.discord?.inviteUrl) {
    const d = cfg.discord;
    const info = await discordInfo(client, guild, d, st);
    const lines = [];
    if (info.kind === 'server') {
      lines.push(`🏠 **Server:** \`${info.name}\``, `👥 **Member:** \`${num(info.members)}\``);
      if (info.boosts) lines.push(`🚀 **Boost:** \`${num(info.boosts)}\``);
      lines.push(`📅 **Dibuat:** ${ts(info.created, 'D')}`);
    } else if (info.name) {
      lines.push(`👤 **Akun:** \`${info.name}\`${info.username ? ` (@${info.username})` : ''}`);
      if (info.created) lines.push(`📅 **Dibuat:** ${ts(info.created, 'D')}`);
    }
    boxes.push(
      box({
        accent: color(d.color, 0x5865f2),
        thumb: info.icon || null,
        header: `## ${d.title || '💬 Discord'}\n${fill(d.description, guild)}`,
        blocks: [lines.join('\n') || null],
        button: link(d.button || (info.kind === 'server' ? 'Join Discord' : 'Discord'), '💬', info.url),
      }),
    );
  }

  // Footer + waktu hanya di kotak paling bawah.
  boxes.at(-1).addSeparatorComponents(line()).addTextDisplayComponents(text(`-# ${fill(cfg.footer || '{server}', guild)} • Diperbarui <t:${Math.floor(Date.now() / 1000)}:R>`));
  saveState({ ...loadState(), inviteUrl: st.inviteUrl });
  return { components: boxes, flags: V2, allowedMentions: { parse: [] } };
}

// ───────────────────────── Command /social ─────────────────────────
const socialCommand = {
  data: new SlashCommandBuilder()
    .setName('social')
    .setDescription('Embed Social Media server')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addSubcommand((s) =>
      s
        .setName('kirim')
        .setDescription('Kirim / pindahkan embed Social Media (ter-update otomatis tiap 1 jam)')
        .addChannelOption((o) => o.setName('channel').setDescription('Default: channelId di social.json / channel ini').addChannelTypes(...TEXT)),
    )
    .addSubcommand((s) => s.setName('refresh').setDescription('Perbarui Social Media sekarang (setelah mengubah social.json)')),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const cfg = loadConfig();
    if (!cfg) return interaction.editReply('❌ social.json tidak bisa dibaca (cek format JSON-nya).');
    const sub = interaction.options.getSubcommand();
    const guild = interaction.guild;

    if (sub === 'refresh') {
      const ok = await refresh(interaction.client);
      return interaction.editReply(ok ? '✅ Embed Social Media diperbarui.' : '❌ Embed belum dikirim. Jalankan `/social kirim` dulu.');
    }

    const channel =
      interaction.options.getChannel('channel') ||
      (isId(cfg.channelId) ? await guild.channels.fetch(cfg.channelId).catch(() => null) : null) ||
      interaction.channel;
    if (!channel?.isTextBased()) return interaction.editReply('❌ Channel tidak ditemukan.');
    const payload = await buildSocial(interaction.client, guild);
    const msg = await channel.send(payload);
    const old = loadState().message;
    saveState({ ...loadState(), message: { channelId: channel.id, messageId: msg.id, guildId: guild.id } });
    if (old && old.messageId !== msg.id) {
      const oldCh = await guild.channels.fetch(old.channelId).catch(() => null);
      await oldCh?.messages.delete(old.messageId).catch(() => {});
    }
    return interaction.editReply(`✅ Embed Social Media dikirim ke ${channel} dan akan ter-update otomatis tiap 1 jam.`);
  },
};

async function refresh(client) {
  const loc = loadState().message;
  if (!loc) return false;
  const channel = await client.channels.fetch(loc.channelId).catch(() => null);
  if (!channel) return false;
  const payload = await buildSocial(client, channel.guild);
  if (!payload) return false;
  try {
    await channel.messages.edit(loc.messageId, payload);
    return true;
  } catch (err) {
    if (err.code === RESTJSONErrorCodes.UnknownMessage) {
      const s = loadState();
      delete s.message; // pesan dihapus manual → berhenti di-update
      saveState(s);
      return false;
    }
    // Pesan lama berformat embed tidak bisa diubah ke Components V2 → kirim baru & hapus yang lama.
    try {
      const msg = await channel.send(payload);
      saveState({ ...loadState(), message: { ...loc, messageId: msg.id } });
      await channel.messages.delete(loc.messageId).catch(() => {});
      console.log('[social] pesan lama diganti ke tampilan Components V2.');
      return true;
    } catch (e) {
      console.error('[social] refresh:', err.message, '|', e.message);
      return false;
    }
  }
}

function registerSocial(client) {
  client.once(Events.ClientReady, () => {
    refresh(client).catch(() => {});
    setInterval(() => refresh(client).catch(() => {}), REFRESH_MS);
  });
}

module.exports = { socialCommand, registerSocial, buildSocial };
