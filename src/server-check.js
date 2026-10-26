const {
  SlashCommandBuilder,
  MessageFlags,
  ChannelType,
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  SnowflakeUtil,
} = require('discord.js');
const UI = require('./ui');

/**
 * /cekserver <link> — cek server lain lewat link invite (Components V2).
 * Data yang tersedia dari invite: nama, ID, ikon, banner, splash, deskripsi, perkiraan member & online,
 * jumlah boost (→ level), tanggal dibuat (dari ID), vanity URL, verifikasi, NSFW level, fitur server,
 * channel tujuan, pembuat invite, dan masa berlaku invite.
 */
const V2 = MessageFlags.IsComponentsV2;
const EPH = MessageFlags.Ephemeral;
const BRAND = 0x3498db;
const text = (c) => new TextDisplayBuilder().setContent(String(c).slice(0, 4000));
const line = () => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
const num = (n) => Math.round(Number(n) || 0).toLocaleString('id-ID');
const ts = (ms, s = 'D') => `<t:${Math.floor(ms / 1000)}:${s}>`;
const bar = (pct, size = 10) => {
  const f = Math.max(0, Math.min(size, Math.round((pct / 100) * size)));
  return '🟦'.repeat(f) + '⬛'.repeat(size - f);
};

/** Ambil kode invite dari link (discord.gg/…, discord.com/invite/…, discordapp.com/invite/…) atau kode saja. */
function parseCode(input) {
  const s = String(input || '').trim();
  const m = s.match(/(?:discord(?:app)?\.com\/invite|discord\.gg|dsc\.gg)\/([\w-]{2,64})/i);
  if (m) return m[1];
  return /^[\w-]{2,64}$/.test(s) ? s : null;
}

// Boost: Level 1 = 2 boost, Level 2 = 7 boost, Level 3 = 14 boost.
const BOOST_TIERS = [
  { level: 0, need: 0 },
  { level: 1, need: 2 },
  { level: 2, need: 7 },
  { level: 3, need: 14 },
];
function boostInfo(count) {
  const c = Number(count) || 0;
  const cur = [...BOOST_TIERS].reverse().find((t) => c >= t.need);
  const next = BOOST_TIERS.find((t) => t.need > c) || null;
  const pct = next ? Math.round(((c - cur.need) / (next.need - cur.need)) * 100) : 100;
  return { count: c, level: cur.level, next, pct };
}

const VERIFICATION = ['🔓 Tidak Ada', '🟢 Rendah (email terverifikasi)', '🟡 Sedang (akun > 5 menit)', '🟠 Tinggi (member > 10 menit)', '🔴 Sangat Tinggi (nomor HP)'];
const NSFW = ['⚪ Default', '🔞 Eksplisit', '✅ Aman', '🔒 Dibatasi Umur'];

// Fitur server → label. Fitur penting ditampilkan lebih dulu.
const FEATURES = {
  VERIFIED: '☑️ Verified',
  PARTNERED: '🤝 Partnered',
  COMMUNITY: '🏘️ Community',
  DISCOVERABLE: '🧭 Discoverable',
  FEATURABLE: '⭐ Featurable',
  VANITY_URL: '🔗 Vanity URL',
  ANIMATED_ICON: '🎞️ Ikon Animasi',
  ANIMATED_BANNER: '🎬 Banner Animasi',
  BANNER: '🖼️ Banner',
  INVITE_SPLASH: '🌄 Invite Splash',
  WELCOME_SCREEN_ENABLED: '👋 Welcome Screen',
  MEMBER_VERIFICATION_GATE_ENABLED: '📋 Membership Screening',
  GUILD_ONBOARDING: '🧭 Onboarding',
  NEWS: '📢 Announcement Channel',
  ROLE_ICONS: '🎭 Role Icons',
  THREADS_ENABLED: '🧵 Threads',
  PREVIEW_ENABLED: '👀 Preview',
  CREATOR_MONETIZABLE_PROVISIONAL: '💰 Monetization',
  ROLE_SUBSCRIPTIONS_ENABLED: '💎 Role Subscriptions',
  TICKETED_EVENTS_ENABLED: '🎟️ Ticketed Events',
  AUTO_MODERATION: '🛡️ AutoMod',
  RAID_ALERTS_DISABLED: '🚨 Raid Alerts Off',
  MORE_STICKERS: '🏷️ Extra Stickers',
  MORE_SOUNDBOARD: '🔊 Extra Soundboard',
  SOUNDBOARD: '🔊 Soundboard',
  VIP_REGIONS: '🌐 VIP Voice',
  HUB: '🎓 Student Hub',
  INVITES_DISABLED: '⛔ Invite Dinonaktifkan',
  GUILD_TAGS: '🏷️ Server Tag',
  ENHANCED_ROLE_COLORS: '🌈 Enhanced Role Colors',
};
const prettyFeature = (f) => FEATURES[f] || `▫️ ${f.toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}`;

const CHANNEL_TYPE = {
  [ChannelType.GuildText]: '💬 Teks',
  [ChannelType.GuildVoice]: '🔊 Voice',
  [ChannelType.GuildAnnouncement]: '📢 Pengumuman',
  [ChannelType.GuildStageVoice]: '🎙️ Stage',
  [ChannelType.GuildForum]: '🗂️ Forum',
  [ChannelType.GuildMedia]: '🖼️ Media',
};

function age(ms) {
  const days = Math.floor((Date.now() - ms) / 86400000);
  if (days < 30) return `${days} hari`;
  const months = Math.floor(days / 30.44);
  if (months < 12) return `${months} bulan`;
  const y = Math.floor(months / 12);
  return months % 12 ? `${y} tahun ${months % 12} bulan` : `${y} tahun`;
}

function buildCard(invite, requester) {
  const g = invite.guild;
  const icon = g.iconURL({ extension: 'png', size: 512, forceStatic: false });
  const banner = g.bannerURL?.({ extension: 'png', size: 1024 }) || null;
  const splash = g.splashURL?.({ extension: 'png', size: 1024 }) || null;
  const created = Number(SnowflakeUtil.timestampFrom(g.id));
  const total = invite.memberCount || 0;
  const online = invite.presenceCount || 0;
  const onlinePct = total ? Math.round((online / total) * 100) : 0;
  const boost = boostInfo(g.premiumSubscriptionCount);
  const features = [...(g.features || [])];
  const order = Object.keys(FEATURES);
  features.sort((a, b) => (order.indexOf(a) === -1 ? 999 : order.indexOf(a)) - (order.indexOf(b) === -1 ? 999 : order.indexOf(b)));
  const badges = [features.includes('VERIFIED') ? '☑️' : '', features.includes('PARTNERED') ? '🤝' : ''].join('');

  const box = UI.accent(new ContainerBuilder(), BRAND);
  if (banner || splash) box.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(banner || splash).setDescription(`Banner ${g.name}`)));

  const header = [
    `# ${g.name}${badges ? ` ${badges}` : ''}`,
    `-# 🆔 \`${g.id}\` • discord.gg/${invite.code}`,
    g.description ? `> ${String(g.description).replace(/\n+/g, ' ').slice(0, 300)}` : null,
  ]
    .filter(Boolean)
    .join('\n');
  if (icon) box.addSectionComponents(new SectionBuilder().addTextDisplayComponents(text(header)).setThumbnailAccessory(new ThumbnailBuilder().setURL(icon)));
  else box.addTextDisplayComponents(text(header));

  // Member
  box.addSeparatorComponents(line());
  box.addTextDisplayComponents(
    text(
      [
        '### 👥 Member',
        `**👥 Total:** \`± ${num(total)}\` • **🟢 Online:** \`± ${num(online)}\` • **⚫ Offline:** \`± ${num(Math.max(0, total - online))}\``,
        `${bar(onlinePct)} \`${onlinePct}% online\``,
        '-# Angka dari Discord berupa perkiraan.',
      ].join('\n'),
    ),
  );

  // Boost
  box.addSeparatorComponents(line());
  box.addTextDisplayComponents(
    text(
      [
        '### 🚀 Server Boost',
        `**💎 Boost:** \`${num(boost.count)} boost\` • **🏅 Level:** \`${boost.level ? `Level ${boost.level}` : 'Belum ada level'}\``,
        boost.next
          ? `${bar(boost.pct)} \`${num(boost.count)} / ${num(boost.next.need)}\` → Level ${boost.next.level} (kurang ${num(boost.next.need - boost.count)} boost)`
          : `${bar(100)} \`MAX\` — Level 3 tercapai 🎉`,
      ].join('\n'),
    ),
  );

  // Info server
  box.addSeparatorComponents(line());
  box.addTextDisplayComponents(
    text(
      [
        '### 📋 Info Server',
        `**📅 Dibuat:** ${ts(created)} (${ts(created, 'R')}) • \`${age(created)}\``,
        `**🔗 Vanity URL:** ${g.vanityURLCode ? `\`discord.gg/${g.vanityURLCode}\`` : '`Tidak ada`'}`,
        `**🛡️ Verifikasi:** \`${VERIFICATION[g.verificationLevel] ?? '-'}\``,
        `**🔞 NSFW Level:** \`${NSFW[g.nsfwLevel] ?? '-'}\``,
      ].join('\n'),
    ),
  );

  // Fitur
  box.addSeparatorComponents(line());
  const shown = features.slice(0, 18).map(prettyFeature);
  box.addTextDisplayComponents(
    text(
      features.length
        ? `### ✨ Fitur Server (${num(features.length)})\n${shown.join(' • ')}${features.length > shown.length ? `\n-# +${features.length - shown.length} fitur lainnya` : ''}`
        : '### ✨ Fitur Server\n`Tidak ada fitur khusus`',
    ),
  );

  // Invite
  const ch = invite.channel;
  const exp = invite.expiresTimestamp;
  box.addSeparatorComponents(line());
  box.addTextDisplayComponents(
    text(
      [
        '### 🎫 Info Invite',
        `**🔑 Kode:** \`${invite.code}\``,
        ch ? `**📍 Channel Tujuan:** \`#${ch.name}\` • ${CHANNEL_TYPE[ch.type] || 'Channel'}` : '**📍 Channel Tujuan:** `-`',
        invite.inviter ? `**🙋 Dibuat Oleh:** \`${invite.inviter.globalName || invite.inviter.username}\` (@${invite.inviter.username}) • \`${invite.inviter.id}\`` : '**🙋 Dibuat Oleh:** `Tidak diketahui / vanity`',
        `**⏳ Kedaluwarsa:** ${exp ? `${ts(exp, 'f')} (${ts(exp, 'R')})` : '`♾️ Tidak pernah`'}`,
      ].join('\n'),
    ),
  );

  // Splash (kalau ada & beda dengan banner) sebagai galeri tambahan
  if (splash && banner) box.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(splash).setDescription(`Invite splash ${g.name}`)));

  box.addSeparatorComponents(line());
  box.addTextDisplayComponents(text(`-# 🔍 Server Checker • Diminta oleh @${requester.username} • ${ts(Date.now(), 'f')}`));

  const buttons = [new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Gabung Server').setEmoji('🚪').setURL(`https://discord.gg/${invite.code}`)];
  if (icon) buttons.push(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Ikon').setEmoji('🖼️').setURL(g.iconURL({ size: 4096, forceStatic: false })));
  if (banner) buttons.push(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Banner').setEmoji('🎏').setURL(g.bannerURL({ size: 4096 })));
  if (splash) buttons.push(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Splash').setEmoji('🌄').setURL(g.splashURL({ size: 4096 })));
  box.addActionRowComponents(new ActionRowBuilder().addComponents(buttons));
  return box;
}

function errorCard(title, desc) {
  return { components: [UI.accent(new ContainerBuilder(), 0xe74c3c).addTextDisplayComponents(text(`## ${title}\n${desc}`))], flags: V2 };
}

// Cooldown per member (anti spam API Discord).
const cooldowns = new Map();

const serverCheckCommand = {
  data: new SlashCommandBuilder()
    .setName('cekserver')
    .setDescription('Cek info server Discord lain lewat link invite')
    .setDMPermission(false)
    .addStringOption((o) => o.setName('link').setDescription('Link invite, contoh: discord.gg/abcd atau kodenya saja').setRequired(true).setMaxLength(120))
    .addBooleanOption((o) => o.setName('privat').setDescription('Hanya terlihat oleh kamu (default: tampil ke semua orang di channel)')),
  async execute(interaction) {
    const left = (cooldowns.get(interaction.user.id) || 0) - Date.now();
    if (left > 0) return interaction.reply({ content: `⏳ Tunggu **${Math.ceil(left / 1000)} detik** sebelum cek server lagi.`, flags: EPH });
    if (cooldowns.size > 500) for (const [k, t] of cooldowns) if (t < Date.now()) cooldowns.delete(k);
    cooldowns.set(interaction.user.id, Date.now() + 5000);

    const isPublic = !interaction.options.getBoolean('privat'); // default: tampil publik
    const code = parseCode(interaction.options.getString('link'));
    if (!code) {
      return interaction.reply({ ...errorCard('❌ Link Tidak Valid', 'Gunakan link invite seperti `https://discord.gg/abcd`, `discord.com/invite/abcd`, atau kodenya saja (`abcd`).'), flags: V2 | EPH });
    }
    await interaction.deferReply({ flags: isPublic ? undefined : EPH });
    // Pesan gagal hanya terlihat oleh pemakai command (pesan publik yang tertunda dihapus).
    const fail = async (card) => {
      if (!isPublic) return interaction.editReply(card);
      await interaction.deleteReply().catch(() => {});
      return interaction.followUp({ ...card, flags: V2 | EPH });
    };
    let invite;
    try {
      invite = await interaction.client.fetchInvite(code);
    } catch (err) {
      const notFound = err.code === 10006;
      return fail(
        notFound
          ? errorCard('❌ Invite Tidak Ditemukan', `Invite \`${code}\` tidak valid, sudah kedaluwarsa, atau sudah dihapus.`)
          : errorCard('⚠️ Gagal Mengecek', 'Discord sedang tidak bisa dihubungi atau membatasi permintaan. Coba lagi beberapa saat lagi.'),
      );
    }
    if (!invite.guild) return fail(errorCard('ℹ️ Bukan Invite Server', 'Link ini adalah invite **grup DM / teman**, bukan server.'));
    return interaction.editReply({ components: [buildCard(invite, interaction.user)], flags: V2, allowedMentions: { parse: [] } });
  },
};

module.exports = { serverCheckCommand, parseCode, boostInfo, buildCard };
