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
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');

/**
 * Leveling (Components V2) — tanpa reward role (bisa ditambah nanti).
 * - XP dari chat (acak min–max, 1x per cooldown) & voice (per menit, minimal 2 orang, tidak deafen).
 * - Notifikasi naik level di channel leveling + Top 10 Level sticky (selalu di paling bawah).
 * - /rank [member] • /level leaderboard • /level panel • /level set / tambah-xp / reset (admin).
 */
const { fetchAllMembers } = require('./member-cache');
const FILE = path.join(__dirname, '..', 'leveling.json');
const DATA = path.join(__dirname, '..', 'data', 'leveling.json');
const V2 = MessageFlags.IsComponentsV2;
const EPH = MessageFlags.Ephemeral;
const isId = (v) => /^\d{17,20}$/.test(String(v || ''));
const num = (n) => Math.round(Number(n) || 0).toLocaleString('id-ID');
const ts = (ms, s = 'R') => `<t:${Math.floor(ms / 1000)}:${s}>`;
const text = (c) => new TextDisplayBuilder().setContent(String(c).slice(0, 4000));
const line = () => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);

const DEFAULT_TITLES = [
  { level: 1, name: '🌱 Fresh Face' },
  { level: 5, name: '🗨️ Talker' },
  { level: 10, name: '🎧 Hangout Buddy' },
  { level: 15, name: '⚡ Energizer' },
  { level: 25, name: '🔥 Hype Maker' },
  { level: 35, name: '🌟 Rising Star' },
  { level: 45, name: '💎 Core Member' },
  { level: 50, name: '🛡️ Server Guardian' },
  { level: 75, name: '👑 Veteran' },
  { level: 100, name: '🏆 Hall of Fame' },
];
const DEFAULT = {
  channelId: '1529215816539701308',
  color: '#3498DB',
  xp: { messageMin: 15, messageMax: 25, cooldownSeconds: 60, voicePerMinute: 10, voiceEnabled: true, voiceMinMembers: 1 },
  ignoredChannels: [],
  ignoredRoles: [],
  pingOnLevelUp: true,
  stickyLeaderboard: true,
  keepPreviousRoles: false,
  titles: DEFAULT_TITLES,
  levelUp: { title: '🎉 Level Up!', message: 'Selamat {user}! Kamu naik ke **Level {level}** 🚀\nTerus aktif ngobrol & nongkrong di voice untuk naik level berikutnya!' },
  leaderboard: { title: '🏆 Top 10 Level | {server}', subtitle: '{server} • Level Leaderboard', bannerImage: '' },
};
function loadConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return {
      ...DEFAULT,
      ...c,
      xp: { ...DEFAULT.xp, ...(c.xp || {}) },
      levelUp: { ...DEFAULT.levelUp, ...(c.levelUp || {}) },
      leaderboard: { ...DEFAULT.leaderboard, ...(c.leaderboard || {}) },
      titles: Array.isArray(c.titles) && c.titles.length ? c.titles : DEFAULT_TITLES,
    };
  } catch {
    return DEFAULT;
  }
}
/** Kotak V2 tanpa warna aksen di kiri (hanya garis kotak), kecuali leveling.json "showAccent": true. */
const boxFor = (cfg) => {
  const box = new ContainerBuilder();
  if (cfg.showAccent === true) box.setAccentColor(brand(cfg));
  return box;
};
const brand = (cfg) => {
  const n = parseInt(String(cfg.color || '').replace('#', ''), 16);
  return Number.isNaN(n) ? 0x3498db : n;
};

// ───────────────────────── Data ─────────────────────────
function loadData() {
  try {
    return { users: {}, panel: null, ...JSON.parse(fs.readFileSync(DATA, 'utf8')) };
  } catch {
    return { users: {}, panel: null };
  }
}
const data = loadData();
let saveTimer = null;
function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  fs.mkdirSync(path.dirname(DATA), { recursive: true });
  fs.writeFileSync(`${DATA}.tmp`, JSON.stringify(data));
  fs.renameSync(`${DATA}.tmp`, DATA);
}
const save = () => {
  if (!saveTimer) saveTimer = setTimeout(saveNow, 10000); // XP sering berubah → simpan berkala
};
process.on('exit', () => saveTimer && saveNow());
const userOf = (id) => (data.users[id] ||= { xp: 0, messages: 0, voiceMin: 0, lastMsg: 0 });

// ───────────────────────── Rumus level ─────────────────────────
/** XP yang dibutuhkan dari level L ke L+1. */
const needFor = (l) => 5 * l * l + 50 * l + 100;
function levelInfo(totalXp) {
  let level = 0;
  let rest = Math.max(0, Math.floor(totalXp));
  while (rest >= needFor(level)) {
    rest -= needFor(level);
    level += 1;
  }
  const need = needFor(level);
  return { level, current: rest, need, pct: Math.floor((rest / need) * 100) };
}
const totalForLevel = (l) => {
  let t = 0;
  for (let i = 0; i < l; i++) t += needFor(i);
  return t;
};
const titleFor = (cfg, level) => [...cfg.titles].sort((a, b) => b.level - a.level).find((t) => level >= t.level) || { level: 0, name: '🥚 Belum Ada Gelar', none: true };
const nextTitle = (cfg, level) => [...cfg.titles].sort((a, b) => a.level - b.level).find((t) => t.level > level) || null;
const bar = (pct, size = 12) => {
  const f = Math.min(size, Math.round((pct / 100) * size));
  return '🟦'.repeat(f) + '⬛'.repeat(size - f);
};
const ranking = () =>
  Object.entries(data.users)
    .filter(([, u]) => u.xp > 0)
    .sort((a, b) => b[1].xp - a[1].xp);
const rankOf = (id) => ranking().findIndex(([uid]) => uid === id) + 1;

// ───────────────────────── Tampilan ─────────────────────────
function rankCard(guild, cfg, user, member) {
  const u = data.users[user.id] || { xp: 0, messages: 0, voiceMin: 0 };
  const info = levelInfo(u.xp);
  const title = titleFor(cfg, info.level);
  const next = nextTitle(cfg, info.level);
  const rank = rankOf(user.id);
  const total = ranking().length;
  const avgMsgXp = (Number(cfg.xp.messageMin) + Number(cfg.xp.messageMax)) / 2 || 20;
  const left = info.need - info.current;
  const box = boxFor(cfg);
  const header = `# ${member?.displayName || user.globalName || user.username}\n-# @${user.username} • ${guild.name}\n**${title.name}** • Level **${info.level}**${rank ? ` • Peringkat **#${rank}**` : ''}`;
  box.addSectionComponents(
    new SectionBuilder().addTextDisplayComponents(text(header)).setThumbnailAccessory(new ThumbnailBuilder().setURL((member || user).displayAvatarURL({ extension: 'png', size: 256 }))),
  );
  box.addSeparatorComponents(line());
  box.addTextDisplayComponents(
    text(
      [
        `### 📈 Progres ke Level ${info.level + 1}`,
        `${bar(info.pct)} \`${info.pct}%\``,
        `**✨ XP:** \`${num(info.current)} / ${num(info.need)}\` • **Kurang:** \`${num(left)} XP\``,
        `-# ≈ ${num(Math.ceil(left / avgMsgXp))} pesan lagi${cfg.xp.voiceEnabled ? ` atau ${num(Math.ceil(left / (Number(cfg.xp.voicePerMinute) || 10)))} menit di voice` : ''}`,
      ].join('\n'),
    ),
  );
  box.addSeparatorComponents(line());
  box.addTextDisplayComponents(
    text(
      [
        '### 📊 Statistik',
        `**🏅 Level:** \`${info.level}\` • **🏆 Peringkat:** \`${rank ? `#${num(rank)} dari ${num(total)}` : '-'}\``,
        `**💠 Total XP:** \`${num(u.xp)}\``,
        `**💬 Pesan:** \`${num(u.messages)}\`${cfg.xp.voiceEnabled ? ` • **🎙️ Voice:** \`${voiceText(u.voiceMin)}\`` : ''}`,
        next ? `**🎯 Role Berikutnya:** ${next.name} di Level \`${next.level}\`` : '**🎯 Gelar:** `Gelar tertinggi tercapai! 👑`',
        voiceLine(cfg, member),
      ]
        .filter(Boolean)
        .join('\n'),
    ),
  );
  box.addSeparatorComponents(line());
  box.addTextDisplayComponents(text(`-# 💡 Dapatkan XP dengan chat${cfg.xp.voiceEnabled ? ' & nongkrong di voice' : ''} • ${guild.name}`));
  return { components: [box], flags: V2, allowedMentions: { parse: [] } };
}
function voiceLine(cfg, member) {
  if (!cfg.xp.voiceEnabled || !member?.voice?.channel) return null;
  const st = voiceStatus(cfg, member, member.voice.channel);
  return st.xp
    ? `**🎙️ Status Voice:** \`🟢 Mendapat XP\` di <#${member.voice.channelId}>`
    : `**🎙️ Status Voice:** \`⏸️ Tidak dapat XP\` — ${st.reason}`;
}
function voiceText(min) {
  const m = Math.round(Number(min) || 0);
  if (m < 60) return `${m} menit`;
  return `${num(Math.floor(m / 60))} jam ${m % 60} menit`;
}

function buildLeaderboard(guild, cfg) {
  const lb = cfg.leaderboard;
  const fill = (t) => String(t || '').replace(/\{server\}/g, guild.name);
  const top = ranking().slice(0, 10);
  const medals = ['🥇', '🥈', '🥉'];
  const row = ([id, u]) => {
    const i = levelInfo(u.xp);
    return { id, u, i, title: titleFor(cfg, i.level) };
  };
  const podium = top.slice(0, 3).map(row).map((r, k) => `${medals[k]} <@${r.id}>\n┗ 🏅 **Level ${r.i.level}** • ${r.title.name} • \`${num(r.u.xp)} XP\``);
  const rest = top.slice(3).map(row).map((r, k) => `\`#${k + 4}\` <@${r.id}> • **Lv ${r.i.level}** • \`${num(r.u.xp)} XP\``);
  const all = Object.values(data.users);
  const box = boxFor(cfg);
  const header = `# ${fill(lb.title)}\n-# ${fill(lb.subtitle)}`;
  const icon = guild.iconURL({ extension: 'png', size: 256 });
  if (icon) box.addSectionComponents(new SectionBuilder().addTextDisplayComponents(text(header)).setThumbnailAccessory(new ThumbnailBuilder().setURL(icon)));
  else box.addTextDisplayComponents(text(header));
  if (lb.bannerImage) box.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(lb.bannerImage)));
  const blocks = [
    top.length ? `### 👑 Podium\n${podium.join('\n\n')}` : '_Belum ada yang punya XP. Ayo mulai ngobrol!_ 💬',
    rest.length ? `### 📋 Peringkat 4 – 10\n${rest.join('\n')}` : null,
    [
      `**👥 Member Aktif:** \`${num(all.filter((u) => u.xp > 0).length)}\``,
      `**💬 Total Pesan:** \`${num(all.reduce((a, u) => a + (u.messages || 0), 0))}\``,
      cfg.xp.voiceEnabled ? `**🎙️ Total Voice:** \`${voiceText(all.reduce((a, u) => a + (u.voiceMin || 0), 0))}\`` : null,
    ]
      .filter(Boolean)
      .join('\n'),
    `-# 💡 Cek level kamu dengan \`/rank\` • XP dari chat${cfg.xp.voiceEnabled ? ' & voice' : ''}\n-# ${guild.name} • Diperbarui ${ts(Date.now())}`,
  ];
  for (const b of blocks.filter(Boolean)) {
    box.addSeparatorComponents(line());
    box.addTextDisplayComponents(text(b));
  }
  return { components: [box], flags: V2, allowedMentions: { parse: [] } };
}

function levelUpCard(guild, cfg, member, from, to, newRoles = []) {
  const u = data.users[member.id];
  const oldTitle = titleFor(cfg, from);
  const newTitle = titleFor(cfg, to);
  const info = levelInfo(u.xp);
  const box = boxFor(cfg);
  const msg = String(cfg.levelUp.message || '').replace(/\{user\}/g, `<@${member.id}>`).replace(/\{level\}/g, to).replace(/\{server\}/g, guild.name);
  box.addSectionComponents(
    new SectionBuilder()
      .addTextDisplayComponents(text(`## ${cfg.levelUp.title}\n${msg}`))
      .setThumbnailAccessory(new ThumbnailBuilder().setURL(member.displayAvatarURL({ extension: 'png', size: 256 }))),
  );
  box.addSeparatorComponents(line());
  box.addTextDisplayComponents(
    text(
      [
        `**🏅 Level:** \`${from}\` ➜ \`${to}\` • **🏆 Peringkat:** \`#${num(rankOf(member.id))}\``,
        newTitle.name !== oldTitle.name ? `**🎖️ Gelar Baru:** ${newTitle.name}` : `**🎖️ Gelar:** ${newTitle.name}`,
        newRoles.length ? `**🎁 Role Baru:** ${newRoles.map((id) => `<@&${id}>`).join(' ')}` : null,
        nextTitle(cfg, to) ? `**🎯 Role Berikutnya:** ${nextTitle(cfg, to).name} di Level \`${nextTitle(cfg, to).level}\`` : null,
        `**✨ Menuju Level ${to + 1}:** ${bar(info.pct, 10)} \`${num(info.current)} / ${num(info.need)} XP\``,
      ]
        .filter(Boolean)
        .join('\n'),
    ),
  );
  box.addSeparatorComponents(line());
  box.addTextDisplayComponents(text(`-# 💡 Cek progresmu dengan \`/rank\` • ${guild.name}`));
  return { components: [box], flags: V2, allowedMentions: { users: cfg.pingOnLevelUp ? [member.id] : [] } };
}

// ───────────────────────── Reward role ─────────────────────────
/** Role level yang seharusnya dimiliki member (keepPreviousRoles false = hanya role tertinggi). */
function wantedRoles(cfg, level) {
  const earned = cfg.titles.filter((t) => isId(t.roleId) && level >= t.level).sort((a, b) => b.level - a.level);
  return cfg.keepPreviousRoles ? earned.map((t) => t.roleId) : earned.slice(0, 1).map((t) => t.roleId);
}
let warnedRoles = false;
/** Pasang / lepas role level sesuai level member sekarang. Mengembalikan role yang baru ditambahkan. */
async function syncRoles(member, cfg = loadConfig()) {
  if (!member?.guild || member.user?.bot) return [];
  const all = cfg.titles.map((t) => t.roleId).filter(isId);
  if (!all.length) return [];
  const level = levelInfo(data.users[member.id]?.xp || 0).level;
  const want = new Set(wantedRoles(cfg, level));
  const me = member.guild.members.me;
  const usable = (id) => {
    const role = member.guild.roles.cache.get(id);
    return role && me && role.position < me.roles.highest.position;
  };
  const add = [...want].filter((id) => !member.roles.cache.has(id));
  const remove = all.filter((id) => !want.has(id) && member.roles.cache.has(id));
  const blocked = [...add, ...remove].filter((id) => !usable(id));
  if (blocked.length && !warnedRoles) {
    warnedRoles = true;
    console.warn('[level] beberapa role level tidak bisa diatur — pastikan bot punya izin Manage Roles & role bot berada DI ATAS semua role level.');
  }
  const addOk = add.filter(usable);
  const removeOk = remove.filter(usable);
  if (addOk.length) await member.roles.add(addOk, `Leveling: Level ${level}`).catch((e) => console.warn('[level] gagal tambah role:', e.message));
  if (removeOk.length) await member.roles.remove(removeOk, `Leveling: Level ${level}`).catch((e) => console.warn('[level] gagal lepas role:', e.message));
  return addOk;
}

// ───────────────────────── XP & level up ─────────────────────────
let client = null;
async function addXp(member, amount, kind) {
  const cfg = loadConfig();
  const u = userOf(member.id);
  const before = levelInfo(u.xp).level;
  u.xp = Math.max(0, u.xp + amount);
  if (kind === 'message') u.messages += 1;
  if (kind === 'voice') u.voiceMin += 1;
  save();
  const after = levelInfo(u.xp).level;
  if (after > before) await announceLevelUp(member, before, after, cfg);
  else scheduleLeaderboard(false);
}
async function announceLevelUp(member, from, to, cfg = loadConfig()) {
  saveNow();
  const newRoles = await syncRoles(member, cfg).catch(() => []);
  if (isId(cfg.channelId)) {
    const ch = await member.guild.channels.fetch(cfg.channelId).catch(() => null);
    if (ch?.isTextBased()) await ch.send(levelUpCard(member.guild, cfg, member, from, to, newRoles)).catch((e) => console.warn('[level] gagal kirim level up:', e.message));
  }
  scheduleLeaderboard(true);
}

/** Status voice member: counted = waktu dicatat, xp = dapat XP, reason = alasan tidak dapat XP. */
function voiceStatus(cfg, member, channel) {
  if (!channel) return { counted: false, xp: false, reason: 'tidak sedang di voice' };
  if (channel.id === channel.guild.afkChannelId) return { counted: false, xp: false, reason: 'berada di channel AFK' };
  if (ignored(cfg, member, channel)) return { counted: false, xp: false, reason: 'channel / role ini tidak mendapat XP' };
  const v = member.voice;
  if (v?.selfDeaf || v?.serverDeaf) return { counted: false, xp: false, reason: 'sedang deafen 🔇' };
  const min = Math.max(1, Number(cfg.xp.voiceMinMembers ?? 1) || 1);
  const humans = [...channel.members.values()].filter((m) => !m.user.bot).length;
  if (humans < min) return { counted: true, xp: false, reason: `butuh minimal ${min} orang (bukan bot) di voice` };
  return { counted: true, xp: true, reason: null };
}

const ignored = (cfg, member, channel) =>
  (cfg.ignoredChannels || []).includes(channel?.id) ||
  (cfg.ignoredChannels || []).includes(channel?.parentId) ||
  (cfg.ignoredRoles || []).some((r) => member?.roles?.cache?.has(r));

// ───────────────────────── Leaderboard sticky ─────────────────────────
let lbTimer = null;
let lbRepost = false;
function scheduleLeaderboard(repost) {
  if (!data.panel) return;
  // Throttle: update biasa maksimal 1x per menit (tidak tertunda terus walau XP masuk tiap detik);
  // repost (ada level up / pesan baru) dipercepat jadi 4 detik.
  if (lbTimer && (!repost || lbRepost)) return;
  lbRepost ||= repost;
  clearTimeout(lbTimer);
  lbTimer = setTimeout(() => {
    lbTimer = null;
    updateLeaderboard().catch((e) => console.warn('[level] leaderboard:', e.message));
  }, repost ? 4000 : 60000);
}
async function updateLeaderboard() {
  const loc = data.panel;
  if (!client || !loc) return;
  const repost = lbRepost;
  lbRepost = false;
  const ch = await client.channels.fetch(loc.channelId).catch(() => null);
  if (!ch) return;
  const cfg = loadConfig();
  const payload = buildLeaderboard(ch.guild, cfg);
  // Sticky: kalau ada pesan baru di bawahnya → kirim ulang supaya leaderboard tetap paling bawah.
  // Pesan leaderboard dihapus manual → berhenti (tidak dikirim ulang).
  const old = await ch.messages.fetch(loc.messageId).catch((e) => (e.code === 10008 ? false : null));
  if (old === false) {
    data.panel = null;
    saveNow();
    return;
  }
  const isLast = ch.lastMessageId === loc.messageId;
  if (repost && cfg.stickyLeaderboard !== false && !isLast) {
    const sent = await ch.send(payload);
    await ch.messages.delete(loc.messageId).catch(() => {});
    data.panel = { channelId: ch.id, messageId: sent.id };
    saveNow();
    return;
  }
  await ch.messages.edit(loc.messageId, payload).catch((e) => console.warn('[level] edit leaderboard:', e.message));
}

// ───────────────────────── Event ─────────────────────────
function registerLeveling(c) {
  client = c;
  c.on(Events.MessageCreate, async (msg) => {
    try {
      if (!msg.guild || msg.author?.bot || msg.system || msg.webhookId) return;
      const cfg = loadConfig();
      const member = msg.member || (await msg.guild.members.fetch(msg.author.id).catch(() => null));
      if (!member || ignored(cfg, member, msg.channel)) return;
      const u = userOf(member.id);
      const cd = (Number(cfg.xp.cooldownSeconds) || 60) * 1000;
      if (Date.now() - (u.lastMsg || 0) < cd) {
        u.messages += 1; // tetap dihitung sebagai pesan, tanpa XP
        save();
        return;
      }
      u.lastMsg = Date.now();
      const min = Number(cfg.xp.messageMin) || 15;
      const max = Math.max(min, Number(cfg.xp.messageMax) || 25);
      await addXp(member, min + Math.floor(Math.random() * (max - min + 1)), 'message');
    } catch (e) {
      console.warn('[level] xp chat:', e.message);
    }
  });

  // XP voice: dicek setiap menit.
  setInterval(async () => {
    const cfg = loadConfig();
    if (!cfg.xp.voiceEnabled) return;
    for (const guild of c.guilds.cache.values()) {
      for (const vs of guild.voiceStates.cache.values()) {
        const m = vs.member;
        const ch = vs.channel;
        if (!m || m.user.bot || !ch) continue;
        const status = voiceStatus(cfg, m, ch);
        if (!status.counted) continue;
        // Waktu voice selalu dicatat; XP hanya kalau syarat terpenuhi (anti AFK sendirian).
        await addXp(m, status.xp ? Number(cfg.xp.voicePerMinute) || 10 : 0, 'voice').catch(() => {});
      }
    }
  }, 60000);

  // Ada pesan baru di channel leveling → leaderboard dipindah ke bawah lagi.
  c.on(Events.MessageCreate, (msg) => {
    if (!data.panel || msg.channelId !== data.panel.channelId || msg.author?.id === c.user?.id) return;
    lbRepost = true;
    clearTimeout(lbTimer);
    lbTimer = setTimeout(() => {
      lbTimer = null;
      updateLeaderboard().catch(() => {});
    }, 8000);
  });
  // Member keluar lalu masuk lagi → role level dikembalikan.
  c.on(Events.GuildMemberAdd, (m) => {
    if (data.users[m.id]?.xp) syncRoles(m).catch(() => {});
  });
}

/** Sinkron role level semua member yang punya data level / memegang role level. */
async function syncAll(guild, cfg = loadConfig()) {
  await fetchAllMembers(guild);
  const all = cfg.titles.map((t) => t.roleId).filter(isId);
  let checked = 0;
  let changed = 0;
  for (const m of guild.members.cache.values()) {
    if (m.user.bot) continue;
    if (!data.users[m.id] && !all.some((id) => m.roles.cache.has(id))) continue;
    checked += 1;
    const before = all.filter((id) => m.roles.cache.has(id)).join(',');
    await syncRoles(m, cfg).catch(() => {});
    const want = wantedRoles(cfg, levelInfo(data.users[m.id]?.xp || 0).level).join(',');
    if (before !== want) changed += 1;
  }
  return { checked, changed };
}

// ───────────────────────── Command ─────────────────────────
const rankCommand = {
  data: new SlashCommandBuilder()
    .setName('rank')
    .setDescription('Lihat level & XP kamu / member lain')
    .setDMPermission(false)
    .addUserOption((o) => o.setName('member').setDescription('Default: kamu sendiri')),
  async execute(interaction) {
    const user = interaction.options.getUser('member') || interaction.user;
    if (user.bot) return interaction.reply({ content: '🤖 Bot tidak punya level.', flags: EPH });
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    return interaction.reply(rankCard(interaction.guild, loadConfig(), user, member));
  },
};

const levelCommand = {
  data: new SlashCommandBuilder()
    .setName('level')
    .setDescription('Sistem leveling')
    .setDMPermission(false)
    .addSubcommand((s) => s.setName('leaderboard').setDescription('Lihat Top 10 Level (hanya terlihat oleh kamu)'))
    .addSubcommand((s) =>
      s
        .setName('panel')
        .setDescription('(Admin) Kirim Top 10 Level sticky ke channel leveling')
        .addChannelOption((o) => o.setName('channel').setDescription('Default: channelId di leveling.json').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
    )
    .addSubcommand((s) =>
      s
        .setName('set')
        .setDescription('(Admin) Atur level member')
        .addUserOption((o) => o.setName('member').setDescription('Member').setRequired(true))
        .addIntegerOption((o) => o.setName('level').setDescription('Level baru').setRequired(true).setMinValue(0).setMaxValue(500)),
    )
    .addSubcommand((s) =>
      s
        .setName('tambah-xp')
        .setDescription('(Admin) Tambah / kurangi XP member')
        .addUserOption((o) => o.setName('member').setDescription('Member').setRequired(true))
        .addIntegerOption((o) => o.setName('xp').setDescription('Contoh: 500 atau -200').setRequired(true).setMinValue(-1000000).setMaxValue(1000000)),
    )
    .addSubcommand((s) => s.setName('hapus-panel').setDescription('(Admin) Hapus Top 10 Level sticky dari channel'))
    .addSubcommand((s) => s.setName('sinkron-role').setDescription('(Admin) Pasang ulang role level ke semua member sesuai level mereka'))
    .addSubcommand((s) =>
      s
        .setName('reset')
        .setDescription('(Admin) Reset level member / semua member')
        .addUserOption((o) => o.setName('member').setDescription('Kosongkan = reset SEMUA member')),
    ),
  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const cfg = loadConfig();
    if (sub === 'leaderboard') {
      // Hanya terlihat oleh yang memakai command.
      const p = buildLeaderboard(interaction.guild, cfg);
      return interaction.reply({ ...p, flags: p.flags | EPH });
    }

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ content: '⛔ Hanya admin (Manage Server) yang bisa memakai perintah ini.', flags: EPH });
    }
    if (sub === 'panel') {
      await interaction.deferReply({ flags: EPH });
      const channel =
        interaction.options.getChannel('channel') || (isId(cfg.channelId) ? await interaction.guild.channels.fetch(cfg.channelId).catch(() => null) : null) || interaction.channel;
      if (!channel?.isTextBased()) return interaction.editReply('❌ Channel tidak ditemukan.');
      const old = data.panel;
      const sent = await channel.send(buildLeaderboard(interaction.guild, cfg));
      data.panel = { channelId: channel.id, messageId: sent.id };
      saveNow();
      if (old && old.messageId !== sent.id) {
        const oldCh = await interaction.guild.channels.fetch(old.channelId).catch(() => null);
        await oldCh?.messages.delete(old.messageId).catch(() => {});
      }
      return interaction.editReply(`✅ Top 10 Level dikirim ke ${channel} — selalu di paling bawah & ter-update otomatis.`);
    }
    if (sub === 'set' || sub === 'tambah-xp') {
      const user = interaction.options.getUser('member');
      if (user.bot) return interaction.reply({ content: '🤖 Bot tidak punya level.', flags: EPH });
      const u = userOf(user.id);
      const before = levelInfo(u.xp).level;
      if (sub === 'set') u.xp = totalForLevel(interaction.options.getInteger('level'));
      else u.xp = Math.max(0, u.xp + interaction.options.getInteger('xp'));
      saveNow();
      const after = levelInfo(u.xp).level;
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);
      if (after > before && member) await announceLevelUp(member, before, after, cfg);
      else {
        if (member) await syncRoles(member, cfg).catch(() => {});
        scheduleLeaderboard(false);
      }
      return interaction.reply({ content: `✅ <@${user.id}> sekarang **Level ${after}** (\`${num(u.xp)} XP\`).`, flags: EPH, allowedMentions: { parse: [] } });
    }
    if (sub === 'reset') {
      const user = interaction.options.getUser('member');
      if (user) {
        delete data.users[user.id];
        saveNow();
        const m = await interaction.guild.members.fetch(user.id).catch(() => null);
        if (m) await syncRoles(m, cfg).catch(() => {});
        scheduleLeaderboard(false);
        return interaction.reply({ content: `♻️ Level <@${user.id}> direset ke 0.`, flags: EPH, allowedMentions: { parse: [] } });
      }
      const res = await interaction.reply({
        content: `⚠️ Yakin reset level **SEMUA member** (${num(Object.keys(data.users).length)} data)? Tindakan ini tidak bisa dibatalkan.`,
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('lvl:reset-yes').setLabel('Ya, Reset Semua').setEmoji('♻️').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId('lvl:reset-no').setLabel('Batal').setStyle(ButtonStyle.Secondary),
          ),
        ],
        flags: EPH,
        withResponse: true,
      });
      const msg = res.resource?.message || (await interaction.fetchReply());
      const btn = await msg.awaitMessageComponent({ filter: (i) => i.user.id === interaction.user.id, time: 60000 }).catch(() => null);
      if (btn?.customId !== 'lvl:reset-yes') return (btn || interaction)[btn ? 'update' : 'editReply']({ content: '✖️ Reset dibatalkan.', components: [] });
      data.users = {};
      saveNow();
      scheduleLeaderboard(false);
      await btn.update({ content: '♻️ Level semua member sudah direset ke 0. Melepas role level…', components: [] });
      const res2 = await syncAll(interaction.guild, cfg);
      return btn.editReply({ content: `♻️ Level semua member sudah direset ke 0. Role level dilepas dari **${num(res2.changed)}** member.`, components: [] });
    }
    if (sub === 'hapus-panel') {
      const loc = data.panel;
      if (!loc) return interaction.reply({ content: 'ℹ️ Tidak ada panel Top 10 Level yang aktif.', flags: EPH });
      data.panel = null;
      clearTimeout(lbTimer);
      lbTimer = null;
      saveNow();
      const ch = await interaction.guild.channels.fetch(loc.channelId).catch(() => null);
      await ch?.messages.delete(loc.messageId).catch(() => {});
      return interaction.reply({ content: `🗑️ Panel Top 10 Level di <#${loc.channelId}> sudah dihapus dan tidak akan dikirim ulang. Kirim lagi kapan saja dengan \`/level panel\`.`, flags: EPH });
    }
    if (sub === 'sinkron-role') {
      await interaction.deferReply({ flags: EPH });
      if (!cfg.titles.some((t) => isId(t.roleId))) return interaction.editReply('❌ Belum ada roleId di titles pada leveling.json.');
      const res2 = await syncAll(interaction.guild, cfg);
      return interaction.editReply(`✅ Role level disinkronkan: **${num(res2.changed)}** member diperbarui dari **${num(res2.checked)}** member yang dicek.`);
    }
  },
};

module.exports = { registerLeveling, rankCommand, levelCommand, levelInfo, buildLeaderboard };
