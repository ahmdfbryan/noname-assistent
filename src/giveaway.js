const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
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

/**
 * Giveaway premium (Components V2).
 * /giveaway mulai | akhiri | reroll | batal | list | ban | unban | banlist
 * Peserta ikut lewat tombol, jumlah peserta ter-update otomatis, pemenang diundi otomatis
 * saat waktu habis (tetap jalan walau bot restart). Teks & warna di giveaway.json.
 * Ban: pemenang otomatis di-ban dari giveaway berikutnya (autoBanWinners), bisa di-unban.
 */
const FILE = path.join(__dirname, '..', 'giveaway.json');
const DATA = path.join(__dirname, '..', 'data', 'giveaways.json');
const EPH = MessageFlags.Ephemeral;
const V2 = MessageFlags.IsComponentsV2;
const isId = (v) => /^\d{17,20}$/.test(String(v || ''));
const num = (n) => Math.round(Number(n) || 0).toLocaleString('id-ID');
const ts = (ms, s = 'R') => `<t:${Math.floor(ms / 1000)}:${s}>`;
let client = null;

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (err) {
    console.error('[giveaway] giveaway.json tidak bisa dibaca:', err.message);
    return {};
  }
}
function loadData() {
  try {
    return { seq: 0, items: {}, banned: {}, ...JSON.parse(fs.readFileSync(DATA, 'utf8')) };
  } catch {
    return { seq: 0, items: {}, banned: {} };
  }
}
const data = loadData();
if (!data.banned) data.banned = {};
function save() {
  fs.mkdirSync(path.dirname(DATA), { recursive: true });
  fs.writeFileSync(`${DATA}.tmp`, JSON.stringify(data, null, 2));
  fs.renameSync(`${DATA}.tmp`, DATA);
}
const color = (cfg, key, fb) => {
  const n = parseInt(String(cfg.colors?.[key] || '').replace('#', ''), 16);
  return Number.isNaN(n) ? fb : n;
};
const FALLBACK = { active: 0x3498db, ended: 0x2ecc71, cancelled: 0xe74c3c, banned: 0xe74c3c };
const accent = (cfg, key) => color(cfg, key, FALLBACK[key] ?? 0x3498db);

/** "30m", "2j", "1h", "1d12j", "1 hari 2 jam" → milidetik. */
function parseDuration(text) {
  const units = { s: 1e3, detik: 1e3, m: 6e4, mnt: 6e4, menit: 6e4, j: 36e5, jam: 36e5, h: 36e5, d: 864e5, hari: 864e5, w: 6048e5, minggu: 6048e5 };
  const re = /(\d+)\s*(detik|menit|mnt|jam|hari|minggu|[smjhdw])/gi;
  let total = 0;
  let m;
  let matched = '';
  while ((m = re.exec(String(text || '')))) {
    total += Number(m[1]) * units[m[2].toLowerCase()];
    matched += m[0];
  }
  return matched.replace(/\s/g, '').length === String(text || '').replace(/\s/g, '').length ? total : 0;
}
function durationText(ms) {
  const d = Math.floor(ms / 864e5);
  const h = Math.floor((ms % 864e5) / 36e5);
  const m = Math.round((ms % 36e5) / 6e4);
  return [d && `${d} hari`, h && `${h} jam`, m && `${m} menit`].filter(Boolean).join(' ') || '< 1 menit';
}

/** Ambil N pemenang acak (kriptografis) dari daftar, kecuali yang dikecualikan. */
function pickWinners(entries, count, exclude = []) {
  const pool = entries.filter((id) => !exclude.includes(id));
  const winners = [];
  while (pool.length && winners.length < count) winners.push(pool.splice(crypto.randomInt(pool.length), 1)[0]);
  return winners;
}

// ───────────────────────── Ban giveaway ─────────────────────────
/** Data ban user (null kalau tidak di-ban / masa ban sudah habis). */
function isBanned(userId) {
  const b = data.banned[userId];
  if (!b) return null;
  if (b.until && b.until <= Date.now()) {
    delete data.banned[userId];
    save();
    return null;
  }
  return b;
}
const banUntilText = (b) => (b.until ? `${ts(b.until, 'f')} (${ts(b.until, 'R')})` : '**Permanen** (sampai di-unban)');
const autoBanOn = (cfg) => cfg.autoBanWinners !== false;
const autoBanDays = (cfg) => Math.max(0, Number(cfg.autoBanDays) || 0);
const autoBanText = (cfg) => (autoBanDays(cfg) ? `selama **${num(autoBanDays(cfg))} hari**` : 'secara **permanen** (sampai di-unban admin)');

/** Ban user dari giveaway + keluarkan dari giveaway yang sedang berjalan. */
function banUser(userId, { by, reason, until = 0, giveawayId = null, auto = false }) {
  data.banned[userId] = { by, at: Date.now(), reason: reason || null, until: until || 0, giveawayId, auto };
  for (const g of Object.values(data.items)) {
    if (g.status === 'active' && g.entries.includes(userId)) {
      g.entries = g.entries.filter((u) => u !== userId);
      scheduleEdit(g);
    }
  }
  save();
  return data.banned[userId];
}

// ───────────────────────── Tampilan (Components V2) ─────────────────────────
const text = (c) => new TextDisplayBuilder().setContent(String(c).slice(0, 4000));
const line = () => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
const icon = (guild) => guild?.iconURL?.({ extension: 'png', size: 256 }) || null;
const msgLink = (guild, g) => `https://discord.com/channels/${guild.id}/${g.channelId}/${g.messageId}`;
const linkRow = (url, label = 'Lihat Giveaway') =>
  new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(label).setEmoji('🎁').setURL(url));

/** Kotak V2: header (+ logo) → blok-blok teks dipisah garis → gambar → footer kecil → tombol. */
function card({ color: c, header, thumb, blocks = [], image, footer, rows = [], top }) {
  // Tanpa warna aksen di kiri (hanya garis kotak), kecuali giveaway.json "showAccent": true.
  const box = new ContainerBuilder();
  if (loadConfig()?.showAccent === true && c != null) box.setAccentColor(c);
  if (thumb) box.addSectionComponents(new SectionBuilder().addTextDisplayComponents(text(header)).setThumbnailAccessory(new ThumbnailBuilder().setURL(thumb)));
  else box.addTextDisplayComponents(text(header));
  for (const b of blocks.filter(Boolean)) {
    box.addSeparatorComponents(line());
    box.addTextDisplayComponents(text(b));
  }
  if (image) box.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(image)));
  if (footer) {
    box.addSeparatorComponents(line());
    box.addTextDisplayComponents(text(`-# ${footer}`));
  }
  for (const r of rows.filter(Boolean)) box.addActionRowComponents(r);
  return { components: top ? [text(top), box] : [box], flags: V2, allowedMentions: { parse: [] } };
}
const eph = (p) => ({ ...p, flags: (p.flags || 0) | EPH });

function requirementLines(g, cfg) {
  const reqs = [];
  if (g.roleId) reqs.push(`▸ Memiliki role <@&${g.roleId}>`);
  if (g.minAccountDays) reqs.push(`▸ Umur akun Discord minimal **${num(g.minAccountDays)} hari**`);
  if (g.minServerDays) reqs.push(`▸ Sudah di server minimal **${num(g.minServerDays)} hari**`);
  if (cfg.showBanRule !== false) reqs.push('▸ Tidak sedang terkena **ban giveaway**');
  return reqs;
}

/** Pesan giveaway utama (V2). */
function buildGiveaway(g, guild) {
  const cfg = loadConfig();
  const st = g.status;
  const prize = `## 🎁 ${g.prize}`;
  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`ga:join:${g.id}`)
      .setLabel(st === 'active' ? cfg.joinButton || 'Ikuti Giveaway' : st === 'ended' ? 'Giveaway Selesai' : 'Dibatalkan')
      .setEmoji('🎉')
      .setStyle(st === 'active' ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(st !== 'active'),
    new ButtonBuilder()
      .setCustomId(`ga:list:${g.id}`)
      .setLabel(`${cfg.participantsButton || 'Peserta'} (${num(g.entries.length)})`)
      .setEmoji('👥')
      .setStyle(ButtonStyle.Secondary),
  );

  if (st === 'active') {
    const reqs = requirementLines(g, cfg);
    return card({
      color: accent(cfg, 'active'),
      top: g.ping ? '@everyone' : null,
      thumb: icon(guild),
      header: `# ${cfg.title || '🎉 GIVEAWAY 🎉'}\n${prize}`,
      blocks: [
        g.description || cfg.defaultDescription || null,
        [
          `⏰ **Berakhir:** ${ts(g.endAt, 'R')} • ${ts(g.endAt, 'f')}`,
          `🏆 **Pemenang:** \`${num(g.winnerCount)} orang\``,
          `👥 **Peserta:** \`${num(g.entries.length)} orang\``,
          `🎟️ **Penyelenggara:** <@${g.hostId}>`,
        ].join('\n'),
        reqs.length ? `### 📌 Syarat Ikut\n${reqs.join('\n')}` : null,
      ],
      image: g.image,
      footer: `🆔 ${g.id} • ${guild.name} • Berakhir ${ts(g.endAt, 'f')}`,
      rows: [buttons],
    });
  }

  if (st === 'ended') {
    return card({
      color: accent(cfg, 'ended'),
      thumb: icon(guild),
      header: `# 🎊 GIVEAWAY SELESAI 🎊\n${prize}`,
      blocks: [
        `### 🏆 Pemenang (${g.winners.length})\n${
          g.winners.length ? g.winners.map((id, i) => `\`${i + 1}.\` <@${id}>`).join('\n') : '_Tidak ada peserta yang memenuhi syarat._'
        }`,
        [
          `👥 **Total Peserta:** \`${num(g.entries.length)} orang\``,
          `⏱️ **Berakhir:** ${ts(g.endedAt || g.endAt, 'f')}`,
          `🎟️ **Penyelenggara:** <@${g.hostId}>`,
        ].join('\n'),
      ],
      image: g.image,
      footer: `🆔 ${g.id} • ${guild.name} • Selesai ${ts(g.endedAt || g.endAt, 'f')}`,
      rows: [buttons],
    });
  }

  return card({
    color: accent(cfg, 'cancelled'),
    thumb: icon(guild),
    header: `# 🚫 GIVEAWAY DIBATALKAN\n${prize}`,
    blocks: [`Giveaway ini telah **dibatalkan** oleh penyelenggara — tidak ada pemenang.\n\n🎟️ **Penyelenggara:** <@${g.hostId}>`],
    footer: `🆔 ${g.id} • ${guild.name} • Dibatalkan ${ts(g.endedAt || Date.now(), 'f')}`,
    rows: [buttons],
  });
}

/** Tampilan lama (embed) — hanya untuk giveaway yang dibuat sebelum update V2 & masih berjalan. */
function buildGiveawayLegacy(g, guild) {
  const cfg = loadConfig();
  const status = g.status;
  const e = new EmbedBuilder()
    .setColor(accent(cfg, status === 'active' ? 'active' : status === 'ended' ? 'ended' : 'cancelled'))
    .setAuthor({ name: `${guild.name} • Giveaway`, iconURL: guild.iconURL({ size: 128 }) || undefined })
    .setTitle(status === 'active' ? cfg.title || '🎉 GIVEAWAY 🎉' : status === 'ended' ? '🎊 GIVEAWAY SELESAI 🎊' : '🚫 GIVEAWAY DIBATALKAN')
    .setDescription(`## 🎁 ${g.prize}\n${g.description || (status === 'active' ? cfg.defaultDescription || '' : '')}`.slice(0, 4096))
    .setThumbnail(icon(guild));
  if (status === 'active') {
    e.addFields(
      { name: '⏰ Berakhir', value: `${ts(g.endAt, 'R')}\n┗ ${ts(g.endAt, 'f')}`, inline: true },
      { name: '🏆 Pemenang', value: `\`${num(g.winnerCount)} orang\``, inline: true },
      { name: '👥 Peserta', value: `\`${num(g.entries.length)} orang\``, inline: true },
    );
  } else if (status === 'ended') {
    e.addFields(
      {
        name: `🏆 Pemenang (${g.winners.length})`,
        value: g.winners.length ? g.winners.map((id, i) => `\`${i + 1}.\` <@${id}>`).join('\n').slice(0, 1024) : '_Tidak ada peserta yang memenuhi syarat._',
      },
      { name: '👥 Total Peserta', value: `\`${num(g.entries.length)} orang\``, inline: true },
      { name: '⏱️ Berakhir', value: ts(g.endedAt || g.endAt, 'f'), inline: true },
    );
  }
  e.addFields({ name: '🎟️ Penyelenggara', value: `<@${g.hostId}>`, inline: true });
  const reqs = requirementLines(g, cfg);
  if (reqs.length && status === 'active') e.addFields({ name: '📌 Syarat Ikut', value: reqs.join('\n') });
  if (g.image) e.setImage(g.image);
  e.setFooter({ text: `${g.id} • ${{ active: 'Berakhir', ended: 'Selesai', cancelled: 'Dibatalkan' }[status]}`, iconURL: guild.iconURL({ size: 64 }) || undefined }).setTimestamp(
    status === 'active' ? g.endAt : g.endedAt || Date.now(),
  );
  const buttons = [
    new ButtonBuilder()
      .setCustomId(`ga:join:${g.id}`)
      .setLabel(status === 'active' ? cfg.joinButton || 'Ikuti Giveaway' : 'Giveaway Selesai')
      .setEmoji('🎉')
      .setStyle(status === 'active' ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(status !== 'active'),
    new ButtonBuilder().setCustomId(`ga:list:${g.id}`).setLabel(`${cfg.participantsButton || 'Peserta'} (${num(g.entries.length)})`).setEmoji('👥').setStyle(ButtonStyle.Secondary),
  ];
  return { embeds: [e], components: [new ActionRowBuilder().addComponents(buttons)], allowedMentions: { parse: [] } };
}
/** Pilih tampilan sesuai pesan yang ada (pesan embed lama tidak bisa diubah ke V2). */
const render = (g, guild, msg) => (msg && !msg.flags?.has?.(V2) ? buildGiveawayLegacy(g, guild) : buildGiveaway(g, guild));

/** Pengumuman pemenang (balasan ke pesan giveaway). */
function buildWinnerAnnouncement(g, guild, { reroll = false } = {}) {
  const cfg = loadConfig();
  const link = msgLink(guild, g);
  const footer = `🆔 ${g.id} • ${guild.name} • ${ts(Date.now(), 'f')}`;
  if (!g.winners.length) {
    return card({
      color: accent(cfg, 'cancelled'),
      thumb: icon(guild),
      header: `# 😢 Tidak Ada Pemenang\nGiveaway **${g.prize}** berakhir tanpa pemenang karena tidak ada peserta yang memenuhi syarat.`,
      blocks: [`👥 **Total Peserta:** \`${num(g.entries.length)} orang\`\n🎟️ **Penyelenggara:** <@${g.hostId}>`],
      footer,
      rows: [linkRow(link)],
    });
  }
  const p = card({
    color: accent(cfg, 'ended'),
    thumb: icon(guild),
    header: `# ${reroll ? '🔁 Pemenang Baru (Reroll)!' : '🎊 Selamat Kepada Pemenang!'}\nKamu memenangkan **${g.prize}**! 🎉`,
    blocks: [
      `### 🏆 Pemenang\n${g.winners.map((id) => `🏆 <@${id}>`).join('\n')}`,
      cfg.claimText ? `### 📩 Cara Klaim\n${cfg.claimText}` : null,
      `👥 **Total Peserta:** \`${num(g.entries.length)} orang\`\n🎟️ **Penyelenggara:** <@${g.hostId}>`,
      autoBanOn(cfg) ? `-# 🔒 Pemenang otomatis tidak bisa ikut giveaway berikutnya ${autoBanText(cfg)}.` : null,
    ],
    footer,
    rows: [linkRow(link)],
  });
  p.allowedMentions = { users: g.winners };
  return p;
}

/** DM untuk pemenang. */
function buildWinnerDM(g, guild) {
  const cfg = loadConfig();
  return card({
    color: accent(cfg, 'ended'),
    thumb: icon(guild),
    header: `# 🎉 Kamu Memenangkan Giveaway!\nSelamat! Kamu memenangkan **${g.prize}** di **${guild.name}**! 🏆`,
    blocks: [
      cfg.claimText ? `### 📩 Cara Klaim\n${cfg.claimText}` : null,
      autoBanOn(cfg) ? `### 🔒 Info\nKarena sudah menang, kamu **tidak bisa ikut giveaway berikutnya** ${autoBanText(cfg)}. Beri kesempatan member lain ya! 💙` : null,
    ],
    footer: `🆔 ${g.id} • ${guild.name} • ${ts(Date.now(), 'f')}`,
    rows: [linkRow(msgLink(guild, g))],
  });
}

/** Ringkasan hasil giveaway untuk penyelenggara (DM). */
async function buildHostSummary(g, guild) {
  const cfg = loadConfig();
  // Mention + username (mention di DM kadang tampil sebagai ID kalau belum ter-cache).
  const names = [];
  for (const id of g.winners) {
    const u = await client.users.fetch(id).catch(() => null);
    names.push(`\`${names.length + 1}.\` <@${id}>${u ? ` • @${u.username}` : ''}`);
  }
  const lasted = (g.endedAt || Date.now()) - (g.createdAt || g.endedAt || Date.now());
  const next = g.winners.length
    ? ['▸ Hubungi pemenang & serahkan hadiahnya', '▸ Pemenang tidak merespons? Gunakan `/giveaway reroll`']
    : ['▸ Buat giveaway baru dengan `/giveaway mulai`'];
  if (g.winners.length && autoBanOn(cfg)) {
    next.push(`▸ Pemenang otomatis di-ban giveaway (${autoBanDays(cfg) ? `${num(autoBanDays(cfg))} hari` : 'permanen'}) • lepas dengan \`/giveaway unban\``);
  }
  return card({
    color: accent(cfg, 'ended'),
    thumb: icon(guild),
    header: `# 📋 Giveaway Kamu Telah Selesai!\n## 🎁 ${g.prize}\nBerikut ringkasan hasil giveaway yang kamu selenggarakan. 🎉`,
    blocks: [
      [`🆔 **ID Giveaway:** \`${g.id}\``, `👥 **Total Peserta:** \`${num(g.entries.length)} orang\``, `⏱️ **Durasi:** \`${durationText(lasted)}\``].join('\n'),
      `### 🏆 Pemenang (${g.winners.length}/${g.winnerCount})\n${names.length ? names.join('\n') : '_Tidak ada peserta yang memenuhi syarat._'}`,
      `### 📌 Langkah Selanjutnya\n${next.join('\n')}`,
    ],
    footer: `${guild.name} • Laporan Giveaway • ${ts(g.endedAt || Date.now(), 'f')}`,
    rows: [linkRow(msgLink(guild, g))],
  });
}

/** Kartu kecil untuk balasan (hanya terlihat yang menekan / menjalankan command). */
const notice = (cfg, key, header, blocks = [], rows = []) => eph(card({ color: accent(cfg, key), header, blocks, rows }));

function buildBanNotice(cfg, b) {
  const won = b.giveawayId ? data.items[b.giveawayId] : null;
  return notice(cfg, 'banned', '## 🔒 Kamu Tidak Bisa Ikut Giveaway\nKamu sedang terkena **ban giveaway** sehingga tidak bisa ikut giveaway ini.', [
    [
      `📝 **Alasan:** ${b.reason || (b.auto ? 'Sudah pernah memenangkan giveaway' : '-')}`,
      won ? `🏆 **Menang di:** \`${won.id}\` • ${won.prize}` : null,
      `⏳ **Berlaku sampai:** ${banUntilText(b)}`,
    ]
      .filter(Boolean)
      .join('\n'),
    '-# Merasa ini keliru? Hubungi admin / buka ticket support.',
  ]);
}

// ───────────────────────── Aksi ─────────────────────────
async function fetchMessage(g) {
  const channel = await client.channels.fetch(g.channelId).catch(() => null);
  const msg = channel && g.messageId ? await channel.messages.fetch(g.messageId).catch(() => null) : null;
  return { channel, msg };
}

const editTimers = new Map();
function scheduleEdit(g) {
  if (!client) return;
  clearTimeout(editTimers.get(g.id));
  editTimers.set(
    g.id,
    setTimeout(async () => {
      editTimers.delete(g.id);
      const { channel, msg } = await fetchMessage(g);
      if (msg) await msg.edit(render(g, channel.guild, msg)).catch((e) => console.warn(`[giveaway] edit ${g.id}:`, e.message));
    }, 2000),
  );
}

async function endGiveaway(g, { reroll = false, count } = {}) {
  const { channel, msg } = await fetchMessage(g);
  if (!channel) return null;
  const guild = channel.guild;
  const cfg = loadConfig();
  // Hanya peserta yang masih ada di server & tidak terkena ban giveaway yang bisa menang.
  const present = [];
  for (const id of g.entries) if (!isBanned(id) && (await guild.members.fetch(id).catch(() => null))) present.push(id);

  if (reroll) {
    g.winners = pickWinners(present, count || g.winnerCount, g.allWinners || g.winners || []);
  } else {
    g.status = 'ended';
    g.endedAt = Date.now();
    g.winners = pickWinners(present, g.winnerCount);
  }
  g.allWinners = [...new Set([...(g.allWinners || []), ...g.winners])];
  // Auto-ban pemenang dari giveaway berikutnya.
  if (autoBanOn(cfg)) {
    const days = autoBanDays(cfg);
    for (const id of g.winners) {
      if (!isBanned(id)) {
        banUser(id, { by: client.user?.id || null, reason: `Menang giveaway ${g.id}`, until: days ? Date.now() + days * 864e5 : 0, giveawayId: g.id, auto: true });
      }
    }
  }
  save();

  if (msg) await msg.edit(render(g, guild, msg)).catch((e) => console.warn(`[giveaway] edit ${g.id}:`, e.message));
  const announce = buildWinnerAnnouncement(g, guild, { reroll });
  if (msg) await msg.reply(announce).catch(() => channel.send(announce).catch(() => {}));
  else await channel.send(announce).catch(() => {});

  if (cfg.dmWinners !== false) {
    for (const id of g.winners) {
      const u = await client.users.fetch(id).catch(() => null);
      await u?.send(buildWinnerDM(g, guild)).catch(() => {});
    }
  }
  if (cfg.dmHost !== false && !reroll) {
    const host = await client.users.fetch(g.hostId).catch(() => null);
    if (host) await host.send(await buildHostSummary(g, guild)).catch(() => {});
  }
  return g;
}

/** Cek syarat peserta. Return teks alasan kalau tidak memenuhi. */
function checkRequirements(g, member) {
  if (g.roleId && !member.roles.cache.has(g.roleId)) return `Kamu harus memiliki role <@&${g.roleId}> untuk ikut giveaway ini.`;
  if (g.minAccountDays && Date.now() - member.user.createdTimestamp < g.minAccountDays * 864e5) {
    return `Umur akun Discord kamu minimal **${num(g.minAccountDays)} hari** untuk ikut giveaway ini.`;
  }
  if (g.minServerDays && Date.now() - (member.joinedTimestamp || Date.now()) < g.minServerDays * 864e5) {
    return `Kamu harus sudah berada di server minimal **${num(g.minServerDays)} hari** untuk ikut giveaway ini.`;
  }
  return null;
}

function buildParticipants(g, cfg, userId) {
  const list = g.entries.slice(-30).reverse();
  return notice(cfg, 'active', `## 👥 Peserta Giveaway\n🎁 **${g.prize}**`, [
    list.length
      ? `${list.map((u) => `▸ <@${u}>`).join('\n')}${g.entries.length > 30 ? `\n\n_…dan ${num(g.entries.length - 30)} peserta lainnya_` : ''}`
      : '_Belum ada peserta. Jadilah yang pertama!_ 🎉',
    [
      `👥 **Total:** \`${num(g.entries.length)} orang\``,
      `🏆 **Pemenang:** \`${num(g.winnerCount)} orang\``,
      `🎟️ **Status Kamu:** ${g.entries.includes(userId) ? '`✅ Sudah ikut`' : isBanned(userId) ? '`🔒 Terkena ban giveaway`' : '`Belum ikut`'}`,
    ].join('\n'),
  ]);
}

async function handleInteraction(interaction) {
  const id = interaction.customId;
  if (typeof id !== 'string' || !id.startsWith('ga:')) return false;
  const [, action, gid] = id.split(':');
  const g = data.items[gid];
  const cfg = loadConfig();
  try {
    if (!g) {
      await interaction.reply({ content: '❌ Giveaway tidak ditemukan.', flags: EPH });
      return true;
    }
    if (action === 'join') {
      const ban = isBanned(interaction.user.id);
      if (g.status !== 'active' || g.endAt <= Date.now()) {
        await interaction.reply(notice(cfg, 'cancelled', '## ⌛ Giveaway Sudah Berakhir', [`Giveaway **${g.prize}** sudah tidak menerima peserta.`]));
      } else if (g.entries.includes(interaction.user.id)) {
        await interaction.reply(
          notice(
            cfg,
            'active',
            '## ✅ Kamu Sudah Terdaftar',
            [`Kamu sudah ikut giveaway **${g.prize}**.\n⏰ Pemenang diundi ${ts(g.endAt, 'R')}.`, '-# Ingin keluar dari giveaway? Tekan tombol di bawah.'],
            [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`ga:leave:${g.id}`).setLabel('Keluar dari Giveaway').setEmoji('🚪').setStyle(ButtonStyle.Danger))],
          ),
        );
      } else if (ban) {
        await interaction.reply(buildBanNotice(cfg, ban));
      } else {
        const reason = checkRequirements(g, interaction.member);
        if (reason) {
          await interaction.reply(notice(cfg, 'cancelled', '## ⛔ Belum Memenuhi Syarat', [reason]));
        } else {
          g.entries.push(interaction.user.id);
          save();
          scheduleEdit(g);
          await interaction.reply(
            notice(cfg, 'ended', '## 🎉 Berhasil Ikut Giveaway!', [
              `🎁 **Hadiah:** ${g.prize}\n⏰ **Diundi:** ${ts(g.endAt, 'R')} • ${ts(g.endAt, 'f')}\n👥 **Peserta:** \`${num(g.entries.length)} orang\``,
              '-# Semoga beruntung! 🍀',
            ]),
          );
        }
      }
    } else if (action === 'leave') {
      if (g.status === 'active') {
        g.entries = g.entries.filter((u) => u !== interaction.user.id);
        save();
        scheduleEdit(g);
      }
      await interaction.update(card({ color: accent(cfg, 'cancelled'), header: '## 🚪 Kamu Telah Keluar', blocks: [`Kamu sudah keluar dari giveaway **${g.prize}**.`] }));
    } else if (action === 'list') {
      await interaction.reply(buildParticipants(g, cfg, interaction.user.id));
    }
  } catch (err) {
    console.error('[giveaway] error:', err);
    if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: '❌ Terjadi kesalahan, coba lagi.', flags: EPH }).catch(() => {});
  }
  return true;
}

// ───────────────────────── Command ─────────────────────────
const idOption = (o) => o.setName('id').setDescription('ID giveaway (contoh GA-0001)').setRequired(true).setAutocomplete(true);

function buildActiveList(cfg) {
  const active = Object.values(data.items).filter((g) => g.status === 'active');
  return notice(
    cfg,
    'active',
    `## 🎉 Giveaway Berjalan (${active.length})`,
    active.length
      ? active.slice(0, 15).map((g) => `\`${g.id}\` **${g.prize}**\n┗ 👥 ${num(g.entries.length)} peserta • 🏆 ${g.winnerCount} pemenang • ⏰ ${ts(g.endAt, 'R')} • <#${g.channelId}>`)
      : ['_Tidak ada giveaway yang sedang berjalan._'],
  );
}

function buildBanList(cfg) {
  const list = Object.entries(data.banned)
    .filter(([uid]) => isBanned(uid))
    .sort((a, b) => b[1].at - a[1].at);
  const shown = list.slice(0, 20).map(([uid, b], i) => {
    const won = b.giveawayId ? data.items[b.giveawayId] : null;
    return [
      `\`${i + 1}.\` <@${uid}> ${b.auto ? '• `🏆 Auto (menang)`' : '• `🛠️ Manual`'}`,
      `┣ 📝 ${b.reason || '-'}${won ? ` • 🎁 ${won.prize}` : ''}`,
      `┗ ⏳ ${b.until ? `sampai ${ts(b.until, 'R')}` : 'Permanen'} • oleh ${b.auto || !b.by ? 'sistem' : `<@${b.by}>`} • ${ts(b.at, 'd')}`,
    ].join('\n');
  });
  return notice(cfg, 'banned', `## 🔒 Daftar Ban Giveaway (${list.length})\nMember di bawah ini **tidak bisa ikut** giveaway.`, [
    shown.length ? shown.join('\n\n') : '_Tidak ada member yang di-ban._',
    list.length > 20 ? `_…dan ${num(list.length - 20)} lainnya_` : null,
    `-# Auto-ban pemenang: ${autoBanOn(cfg) ? `**aktif** (${autoBanDays(cfg) ? `${num(autoBanDays(cfg))} hari` : 'permanen'})` : '**nonaktif**'} • Lepas ban: \`/giveaway unban\``,
  ]);
}

const giveawayCommand = {
  data: new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('Kelola giveaway')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addSubcommand((s) =>
      s
        .setName('mulai')
        .setDescription('Mulai giveaway baru')
        .addStringOption((o) => o.setName('hadiah').setDescription('Hadiah giveaway, contoh: 1.000 Robux').setRequired(true).setMaxLength(200))
        .addStringOption((o) => o.setName('durasi').setDescription('Contoh: 30m, 2j, 1d, 1d12j (m=menit, j=jam, d=hari)').setRequired(true).setMaxLength(30))
        .addIntegerOption((o) => o.setName('pemenang').setDescription('Jumlah pemenang (default 1)').setMinValue(1).setMaxValue(50))
        .addStringOption((o) => o.setName('deskripsi').setDescription('Keterangan tambahan').setMaxLength(1000))
        .addAttachmentOption((o) => o.setName('gambar').setDescription('Gambar / banner giveaway'))
        .addRoleOption((o) => o.setName('syarat_role').setDescription('Hanya member dengan role ini yang bisa ikut'))
        .addIntegerOption((o) => o.setName('umur_akun').setDescription('Minimal umur akun Discord (hari)').setMinValue(1).setMaxValue(3650))
        .addIntegerOption((o) => o.setName('lama_di_server').setDescription('Minimal lama berada di server (hari)').setMinValue(1).setMaxValue(3650))
        .addBooleanOption((o) => o.setName('ping').setDescription('Mention @everyone saat giveaway dimulai'))
        .addChannelOption((o) => o.setName('channel').setDescription('Default: channel giveaway di giveaway.json').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
    )
    .addSubcommand((s) => s.setName('akhiri').setDescription('Akhiri giveaway sekarang & undi pemenang').addStringOption(idOption))
    .addSubcommand((s) =>
      s
        .setName('reroll')
        .setDescription('Undi ulang pemenang giveaway yang sudah selesai')
        .addStringOption(idOption)
        .addIntegerOption((o) => o.setName('jumlah').setDescription('Jumlah pemenang baru (default = jumlah pemenang awal)').setMinValue(1).setMaxValue(50)),
    )
    .addSubcommand((s) => s.setName('batal').setDescription('Batalkan giveaway (tanpa pemenang)').addStringOption(idOption))
    .addSubcommand((s) => s.setName('list').setDescription('Daftar giveaway yang sedang berjalan'))
    .addSubcommand((s) =>
      s
        .setName('ban')
        .setDescription('Ban member dari giveaway (tidak bisa ikut giveaway)')
        .addUserOption((o) => o.setName('member').setDescription('Member yang di-ban').setRequired(true))
        .addStringOption((o) => o.setName('durasi').setDescription('Contoh: 7d, 30d, 12j. Kosongkan = permanen').setMaxLength(30))
        .addStringOption((o) => o.setName('alasan').setDescription('Alasan ban').setMaxLength(200)),
    )
    .addSubcommand((s) =>
      s
        .setName('unban')
        .setDescription('Lepas ban giveaway member')
        .addUserOption((o) => o.setName('member').setDescription('Member yang di-unban').setRequired(true)),
    )
    .addSubcommand((s) => s.setName('banlist').setDescription('Daftar member yang terkena ban giveaway')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const cfg = loadConfig();

    if (sub === 'list') return interaction.reply(buildActiveList(cfg));
    if (sub === 'banlist') return interaction.reply(buildBanList(cfg));

    if (sub === 'ban') {
      const user = interaction.options.getUser('member');
      if (user.bot) return interaction.reply({ content: '❌ Tidak bisa mem-ban bot.', flags: EPH });
      const durText = interaction.options.getString('durasi');
      const ms = durText ? parseDuration(durText) : 0;
      if (durText && !ms) return interaction.reply({ content: '❌ Durasi tidak valid. Contoh: `7d`, `30d`, `12j`. Kosongkan untuk permanen.', flags: EPH });
      const removed = Object.values(data.items).filter((g) => g.status === 'active' && g.entries.includes(user.id)).length;
      const b = banUser(user.id, { by: interaction.user.id, reason: interaction.options.getString('alasan'), until: ms ? Date.now() + ms : 0 });
      return interaction.reply(
        notice(cfg, 'banned', `## 🔒 Member Di-ban dari Giveaway\n<@${user.id}> • @${user.username}`, [
          [`📝 **Alasan:** ${b.reason || '-'}`, `⏳ **Berlaku sampai:** ${banUntilText(b)}`, `🛠️ **Oleh:** <@${interaction.user.id}>`].join('\n'),
          removed ? `-# Dikeluarkan dari ${removed} giveaway yang sedang berjalan.` : null,
        ]),
      );
    }

    if (sub === 'unban') {
      const user = interaction.options.getUser('member');
      const b = isBanned(user.id);
      if (!b) return interaction.reply(notice(cfg, 'active', '## ℹ️ Tidak Terkena Ban', [`<@${user.id}> tidak sedang terkena ban giveaway.`]));
      delete data.banned[user.id];
      save();
      return interaction.reply(
        notice(cfg, 'ended', `## 🔓 Ban Giveaway Dilepas\n<@${user.id}> • @${user.username}`, [
          `Member ini **sudah bisa ikut giveaway** lagi. 🎉\n📝 **Alasan ban sebelumnya:** ${b.reason || '-'}`,
        ]),
      );
    }

    if (sub === 'mulai') {
      await interaction.deferReply({ flags: EPH });
      const ms = parseDuration(interaction.options.getString('durasi'));
      if (!ms || ms < 60e3 || ms > 60 * 864e5) {
        return interaction.editReply('❌ Durasi tidak valid. Contoh: `30m`, `2j`, `1d`, `1d12j` (minimal 1 menit, maksimal 60 hari).');
      }
      const channel =
        interaction.options.getChannel('channel') ||
        (isId(cfg.channelId) ? await interaction.guild.channels.fetch(cfg.channelId).catch(() => null) : null) ||
        interaction.channel;
      if (!channel?.isTextBased()) return interaction.editReply('❌ Channel tidak ditemukan.');
      const img = interaction.options.getAttachment('gambar');
      if (img && img.contentType && !img.contentType.startsWith('image/')) return interaction.editReply('❌ File gambar harus berupa gambar (PNG / JPG / GIF).');

      data.seq = (data.seq || 0) + 1;
      const ping = !!interaction.options.getBoolean('ping');
      const g = {
        id: `GA-${String(data.seq).padStart(4, '0')}`,
        guildId: interaction.guild.id,
        channelId: channel.id,
        messageId: null,
        hostId: interaction.user.id,
        prize: interaction.options.getString('hadiah'),
        description: interaction.options.getString('deskripsi') || null,
        winnerCount: interaction.options.getInteger('pemenang') || 1,
        roleId: interaction.options.getRole('syarat_role')?.id || null,
        minAccountDays: interaction.options.getInteger('umur_akun') || 0,
        minServerDays: interaction.options.getInteger('lama_di_server') || 0,
        image: null,
        ping,
        entries: [],
        winners: [],
        status: 'active',
        createdAt: Date.now(),
        endAt: Date.now() + ms,
      };
      // Gambar diunggah ulang bersama pesan supaya link-nya tidak kedaluwarsa.
      const files = [];
      if (img) {
        const name = `giveaway${path.extname(img.name || '.png').split('?')[0].toLowerCase() || '.png'}`;
        files.push({ attachment: img.url, name });
        g.image = `attachment://${name}`;
      }
      let msg;
      try {
        msg = await channel.send({ ...buildGiveaway(g, interaction.guild), files, allowedMentions: { parse: ping ? ['everyone'] : [] } });
      } catch (err) {
        data.seq -= 1;
        return interaction.editReply(`❌ Gagal mengirim giveaway: ${err.message}`);
      }
      g.messageId = msg.id;
      data.items[g.id] = g;
      save();
      return interaction.editReply(`✅ Giveaway \`${g.id}\` **${g.prize}** dimulai di ${channel} — berakhir ${ts(g.endAt, 'R')} (${durationText(ms)}).`);
    }

    const gid = interaction.options.getString('id').trim().toUpperCase();
    const g = data.items[gid];
    if (!g) return interaction.reply({ content: `❌ Giveaway \`${gid}\` tidak ditemukan.`, flags: EPH });
    await interaction.deferReply({ flags: EPH });

    if (sub === 'akhiri') {
      if (g.status !== 'active') return interaction.editReply('Giveaway ini sudah tidak berjalan.');
      await endGiveaway(g);
      return interaction.editReply(`✅ Giveaway \`${g.id}\` diakhiri. Pemenang: ${g.winners.map((id) => `<@${id}>`).join(', ') || '-'}`);
    }
    if (sub === 'reroll') {
      if (g.status !== 'ended') return interaction.editReply('❌ Reroll hanya untuk giveaway yang sudah selesai.');
      await endGiveaway(g, { reroll: true, count: interaction.options.getInteger('jumlah') });
      return interaction.editReply(
        g.winners.length ? `🔁 Pemenang baru \`${g.id}\`: ${g.winners.map((id) => `<@${id}>`).join(', ')}` : '❌ Tidak ada peserta lain yang bisa dipilih.',
      );
    }
    if (sub === 'batal') {
      if (g.status !== 'active') return interaction.editReply('Giveaway ini sudah tidak berjalan.');
      g.status = 'cancelled';
      g.endedAt = Date.now();
      save();
      const { channel, msg } = await fetchMessage(g);
      if (msg) await msg.edit(render(g, channel.guild, msg)).catch(() => {});
      return interaction.editReply(`🚫 Giveaway \`${g.id}\` dibatalkan.`);
    }
  },

  async autocomplete(interaction) {
    const sub = interaction.options.getSubcommand();
    const q = String(interaction.options.getFocused() || '').toLowerCase();
    const want = sub === 'reroll' ? 'ended' : 'active';
    const choices = Object.values(data.items)
      .filter((g) => g.status === want && g.guildId === interaction.guildId)
      .filter((g) => !q || g.id.toLowerCase().includes(q) || g.prize.toLowerCase().includes(q))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 25)
      .map((g) => ({ name: `${g.id} • ${g.prize}`.slice(0, 100), value: g.id }));
    await interaction.respond(choices).catch(() => {});
  },
};

// ───────────────────────── Timer ─────────────────────────
let checking = false;
async function tick() {
  if (checking || !client) return;
  checking = true;
  try {
    for (const g of Object.values(data.items)) {
      if (g.status === 'active' && g.endAt <= Date.now()) await endGiveaway(g).catch((e) => console.error(`[giveaway] ${g.id}:`, e.message));
    }
  } finally {
    checking = false;
  }
}

function registerGiveaway(c) {
  client = c;
  c.once(Events.ClientReady, () => {
    tick();
    setInterval(tick, 10 * 1000); // cek tiap 10 detik → tetap terundi walau bot sempat restart
  });
}

/** Giveaway yang pernah dimenangkan user (untuk ticket Claim Giveaway). */
function winsOf(userId) {
  return Object.values(data.items)
    .filter((g) => g.status === 'ended' && (g.allWinners || g.winners || []).includes(userId))
    .sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0));
}
const getGiveaway = (id) => data.items[String(id || '').toUpperCase()] || null;

module.exports = { giveawayCommand, registerGiveaway, handleInteraction, parseDuration, pickWinners, winsOf, getGiveaway, isBanned };
