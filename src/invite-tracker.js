const fs = require('fs');
const path = require('path');
const {
  EmbedBuilder,
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

/**
 * Invite Log + Top 10 Inviter (channel terpisah, ter-update otomatis).
 * - Member masuk → log siapa yang mengundang (link siapa, kode, total undangan inviter) + STATUS VERIFIKASI.
 * - Undangan baru dihitung VALID setelah member yang diundang verifikasi (dapat role verifikasi di verify.json).
 *   Tidak ada sistem "fake" — akun baru tetap valid asalkan sudah verifikasi.
 * - Status verifikasi di pesan log join ter-update otomatis: ⏳ Belum verifikasi → ✅ Sudah verifikasi
 *   (atau 📤 Keluar sebelum verifikasi), jadi admin bisa melihat siapa yang sudah klik tombol Verifikasi.
 * - Member keluar → log + jumlah undangan inviter dikurangi.
 * - Top 10 Inviter di channel terpisah (leaderboardChannelId), 1 pesan yang di-edit otomatis.
 * Setiap member hanya dihitung 1x per inviter (keluar-masuk tidak menggandakan hitungan).
 */
const { fetchAllMembers } = require('./member-cache');
const FILE = path.join(__dirname, '..', 'invites.json');
const DATA = path.join(__dirname, '..', 'data', 'invites.json');
const isId = (v) => /^\d{17,20}$/.test(String(v || ''));
const num = (n) => Math.round(Number(n) || 0).toLocaleString('id-ID');
const ts = (ms, s = 'R') => `<t:${Math.floor(ms / 1000)}:${s}>`;

// Pengaturan bawaan kalau invites.json belum ada / rusak (supaya bot tetap jalan).
const DEFAULT_CONFIG = { channelId: '1559920442318258359', leaderboardChannelId: '1560212055074799696', colors: {}, leaderboard: {} };
let warned = false;
function loadConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    warned = false;
    return { ...DEFAULT_CONFIG, ...cfg };
  } catch (err) {
    if (!warned) console.error('[invites] invites.json tidak bisa dibaca (pakai pengaturan bawaan):', err.message);
    warned = true; // cukup 1x, tidak spam log
    return DEFAULT_CONFIG;
  }
}
/** Role verifikasi diambil dari verify.json (roleId). */
function verifyRoleId() {
  try {
    const id = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'verify.json'), 'utf8')).roleId;
    return isId(id) ? String(id) : null;
  } catch {
    return null;
  }
}
/** Kalau role verifikasi belum diatur, semua undangan langsung valid (supaya tidak macet). */
const isVerifiedMember = (member) => {
  const rid = verifyRoleId();
  return !rid || Boolean(member?.roles?.cache?.has(rid));
};
function loadData() {
  try {
    const d = JSON.parse(fs.readFileSync(DATA, 'utf8'));
    return { members: {}, leaderboard: null, ...d };
  } catch {
    return { members: {}, leaderboard: null };
  }
}
const data = loadData();
function save() {
  fs.mkdirSync(path.dirname(DATA), { recursive: true });
  fs.writeFileSync(`${DATA}.tmp`, JSON.stringify(data, null, 2));
  fs.renameSync(`${DATA}.tmp`, DATA);
}

const color = (cfg, key, fb) => {
  const n = parseInt(String(cfg.colors?.[key] || '').replace('#', ''), 16);
  return Number.isNaN(n) ? fb : n;
};
const fill = (t, guild) => String(t || '').replace(/\{server\}/g, guild.name);
const footer = (guild) => ({ text: guild.name, iconURL: guild.iconURL({ extension: 'png', size: 128 }) || undefined });

// ───────────────────────── Statistik ─────────────────────────
/** { inviterId: { total, left, pending, valid } } dihitung dari data member.
 *  valid = sudah verifikasi & masih di server • pending = belum verifikasi • left = sudah keluar. */
const EMPTY = () => ({ total: 0, left: 0, pending: 0, valid: 0 });
function computeStats() {
  const stats = {};
  for (const m of Object.values(data.members)) {
    if (!m.inviterId || m.inviterId === 'vanity') continue;
    const s = (stats[m.inviterId] ||= EMPTY());
    s.total += 1;
    if (m.left) s.left += 1;
    else if (m.verified === false) s.pending += 1;
    else s.valid += 1;
  }
  return stats;
}
const statsOf = (userId) => computeStats()[userId] || EMPTY();

// ───────────────────────── Cache undangan ─────────────────────────
const cache = new Map(); // guildId → Map(code → { uses, inviterId, maxUses })
const vanityUses = new Map(); // guildId → uses
const queues = new Map(); // guildId → Promise (supaya join beruntun diproses berurutan)

async function snapshot(guild) {
  const invites = await guild.invites.fetch({ cache: false });
  const map = new Map();
  for (const inv of invites.values()) map.set(inv.code, { uses: inv.uses || 0, inviterId: inv.inviter?.id || inv.inviterId || null, maxUses: inv.maxUses || 0 });
  return map;
}
async function refreshCache(guild) {
  try {
    cache.set(guild.id, await snapshot(guild));
    if (guild.vanityURLCode) {
      const v = await guild.fetchVanityData().catch(() => null);
      if (v) vanityUses.set(guild.id, v.uses);
    }
  } catch (err) {
    console.warn(`[invites] gagal membaca undangan ${guild.name} (butuh izin Manage Server):`, err.message);
  }
}

/** Cari undangan yang dipakai member baru: { inviterId, code } | { inviterId: 'vanity' } | null */
async function detectInvite(guild) {
  const before = cache.get(guild.id);
  let after;
  try {
    after = await snapshot(guild);
  } catch {
    return null;
  }
  cache.set(guild.id, after);
  // Belum ada data pembanding (misal izin baru diberikan) → jangan menebak, cukup simpan data terbaru.
  if (!before) return null;
  for (const [code, inv] of after) {
    const old = before.get(code);
    if (inv.uses > (old?.uses || 0)) return { inviterId: inv.inviterId, code };
  }
  // Undangan sekali pakai / batas pemakaian habis → hilang dari daftar setelah dipakai.
  for (const [code, inv] of before) {
    if (!after.has(code) && inv.maxUses && inv.uses + 1 >= inv.maxUses) return { inviterId: inv.inviterId, code };
  }
  if (guild.vanityURLCode) {
    const v = await guild.fetchVanityData().catch(() => null);
    const known = vanityUses.has(guild.id);
    const prev = vanityUses.get(guild.id) ?? 0;
    if (v) vanityUses.set(guild.id, v.uses);
    if (v && known && v.uses > prev) return { inviterId: 'vanity', code: guild.vanityURLCode };
  }
  return null;
}

// ───────────────────────── Tampilan ─────────────────────────
function inviterText(rec) {
  if (!rec?.inviterId) return '`❔ Tidak diketahui`';
  if (rec.inviterId === 'vanity') return '`🔗 Vanity URL`';
  return `<@${rec.inviterId}>`;
}

/** Kotak V2 untuk log invite. */
function logCard({ accent, header, thumb, blocks, guild, at }) {
  const text = (c) => new TextDisplayBuilder().setContent(String(c).slice(0, 4000));
  const line = () => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
  // Default tanpa warna aksen di kiri (hanya garis kotak). invites.json → "showAccent": true untuk memakai warna lagi.
  const box = new ContainerBuilder();
  if (loadConfig().showAccent === true && accent != null) box.setAccentColor(accent);
  if (thumb) box.addSectionComponents(new SectionBuilder().addTextDisplayComponents(text(header)).setThumbnailAccessory(new ThumbnailBuilder().setURL(thumb)));
  else box.addTextDisplayComponents(text(header));
  for (const b of [...blocks.filter(Boolean), `-# ${guild.name} • Invite Log • ${ts(at || Date.now(), 'f')}`]) {
    box.addSeparatorComponents(line());
    box.addTextDisplayComponents(text(b));
  }
  return { components: [box], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } };
}
const userLine = (member) => `**👤 Member:** \`${member.user.globalName || member.user.username}\` • @${member.user.username}`;

/** Status verifikasi member baru (tampil di log join & ter-update otomatis). */
function verifyStatus(rec) {
  if (rec?.left && rec.verified === false) {
    return {
      accent: 0x95a5a6,
      text: `### 📤 Status Verifikasi\n**Keluar sebelum verifikasi** ${rec.leftAt ? ts(rec.leftAt) : ''}\n-# Undangan ini tidak dihitung.`,
    };
  }
  if (rec?.verified === false) {
    return {
      accent: 0xf1c40f,
      text: '### ⏳ Status Verifikasi\n**Belum klik tombol Verifikasi**\n-# Undangan dihitung **valid** setelah member ini menyelesaikan verifikasi.',
    };
  }
  return {
    accent: null,
    text: `### ✅ Status Verifikasi\n**Sudah verifikasi**${rec?.verifiedAt ? ` ${ts(rec.verifiedAt)} (${ts(rec.verifiedAt, 'f')})` : ''}${
      rec?.inviterId && rec.inviterId !== 'vanity' ? '\n-# Undangan sudah dihitung **valid** untuk inviter.' : ''
    }`,
  };
}

function buildJoinLog(member, rec, cfg) {
  const guild = member.guild;
  const s = rec?.inviterId && rec.inviterId !== 'vanity' ? statsOf(rec.inviterId) : null;
  const vs = verifyStatus(rec);
  return logCard({
    guild,
    at: rec?.joinedAt,
    accent: vs.accent ?? color(cfg, 'join', 0x2ecc71),
    thumb: member.user.displayAvatarURL({ extension: 'png', size: 256 }),
    header: `## 📥 Member Baru Bergabung\n<@${member.id}> bergabung ke **${guild.name}**! 🎉`,
    blocks: [
      [
        userLine(member),
        `**📅 Akun Dibuat:** ${ts(member.user.createdTimestamp, 'D')} (${ts(member.user.createdTimestamp, 'R')})`,
        rec?.memberNo ? `**🔢 Member Ke:** \`#${num(rec.memberNo)}\`` : null,
      ]
        .filter(Boolean)
        .join('\n'),
      [
        '### 🎫 Info Undangan',
        `**🙋 Diundang Oleh:** ${inviterText(rec)}`,
        `**🔗 Kode Undangan:** ${rec?.code ? `\`${rec.code}\`` : '`-`'}`,
        s ? `**📊 Undangan Inviter:** \`✅ ${num(s.valid)} valid\` • \`⏳ ${num(s.pending)} menunggu\` • \`📥 ${num(s.total)} total\`` : null,
      ]
        .filter(Boolean)
        .join('\n'),
      vs.text,
      rec?.rejoin ? '🔁 **Rejoin** — member ini pernah bergabung sebelumnya.' : null,
    ],
  });
}

function buildLeaveLog(member, rec, cfg) {
  const guild = member.guild;
  const joinedAt = member.joinedTimestamp || rec?.joinedAt || null;
  const s = rec?.inviterId && rec.inviterId !== 'vanity' ? statsOf(rec.inviterId) : null;
  return logCard({
    guild,
    accent: color(cfg, 'leave', 0xe74c3c),
    thumb: member.user.displayAvatarURL({ extension: 'png', size: 256 }),
    header: `## 📤 Member Keluar\n<@${member.id}> telah meninggalkan **${guild.name}**.`,
    blocks: [
      [userLine(member), `**⏳ Lama di Server:** ${joinedAt ? `\`${stay(Date.now() - joinedAt)}\`` : '`-`'}`, `**👥 Sisa Member:** \`${num(guild.memberCount)}\``].join('\n'),
      [
        '### 🎫 Info Undangan',
        `**🙋 Diundang Oleh:** ${inviterText(rec)}`,
        rec ? `**🛡️ Verifikasi:** ${rec.verified === false ? '`⏳ Belum sempat verifikasi`' : '`✅ Sudah verifikasi`'}` : null,
        s ? `**📊 Undangan Inviter:** \`✅ ${num(s.valid)} valid\` • \`📤 ${num(s.left)} keluar\`` : null,
      ]
        .filter(Boolean)
        .join('\n'),
    ],
  });
}

function stay(ms) {
  const m = Math.max(1, Math.round(ms / 60000));
  if (m < 60) return `${m} menit`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} jam`;
  const d = Math.floor(h / 24);
  return d < 30 ? `${d} hari` : `${Math.floor(d / 30)} bulan`;
}

/** Top 10 Inviter (Components V2): podium 3 besar + peringkat 4–10 + statistik. */
function buildLeaderboard(guild, cfg) {
  const lb = cfg.leaderboard || {};
  const medals = ['🥇', '🥈', '🥉'];
  const stats = computeStats();
  const top = Object.entries(stats)
    .filter(([, s]) => s.valid > 0)
    .sort((a, b) => b[1].valid - a[1].valid)
    .slice(0, 10);
  const podium = top.slice(0, 3).map(([id, s], i) => `${medals[i]} <@${id}>\n┗ ✅ **${num(s.valid)} undangan valid**`);
  const rest = top.slice(3).map(([id, s], i) => `\`#${i + 4}\` <@${id}> • ✅ **${num(s.valid)} undangan valid**`);
  const all = Object.values(stats);

  const text = (c) => new TextDisplayBuilder().setContent(String(c).slice(0, 4000));
  const line = () => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
  // Tanpa warna aksen di kiri (hanya garis kotak), kecuali invites.json "showAccent": true.
  const box = new ContainerBuilder();
  if (cfg.showAccent === true) box.setAccentColor(color(cfg, 'brand', 0x3498db));
  const header = `# ${fill(lb.title || '🏆 Top 10 Inviter | {server}', guild)}\n-# ${fill(lb.subtitle || '{server} • Invite Leaderboard', guild)}`;
  const icon = guild.iconURL({ extension: 'png', size: 256 });
  if (icon) box.addSectionComponents(new SectionBuilder().addTextDisplayComponents(text(header)).setThumbnailAccessory(new ThumbnailBuilder().setURL(icon)));
  else box.addTextDisplayComponents(text(header));
  const blocks = [
    fill(lb.description || '', guild) || null,
    top.length ? `### 👑 Podium Inviter\n${podium.join('\n\n')}` : lb.empty || '_Belum ada undangan._',
    rest.length ? `### 📋 Peringkat 4 – 10\n${rest.join('\n')}` : null,
    [
      `✅ **Total Undangan Valid:** \`${num(all.reduce((a, s) => a + s.valid, 0))}\``,
      `🙋 **Total Inviter:** \`${num(all.filter((s) => s.valid > 0).length)}\``,
    ].join('\n'),
    `-# ✅ Undangan dihitung valid setelah member yang diundang menyelesaikan verifikasi.\n${lb.tip ? `-# 💡 ${lb.tip}\n` : ''}-# ${guild.name} • Diperbarui <t:${Math.floor(Date.now() / 1000)}:R>`,
  ];
  for (const b of blocks.filter(Boolean)) {
    box.addSeparatorComponents(line());
    box.addTextDisplayComponents(text(b));
  }
  return { components: [box], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } };
}

// ───────────────────────── Leaderboard (1 pesan, di-edit otomatis) ─────────────────────────
let lbTimer = null;
async function updateLeaderboard(client) {
  const loc = data.leaderboard;
  if (!loc) return;
  const channel = await client.channels.fetch(loc.channelId).catch(() => null);
  if (!channel) return;
  const payload = buildLeaderboard(channel.guild, loadConfig());
  try {
    await channel.messages.edit(loc.messageId, payload);
  } catch (err) {
    if (err.code === 10008) {
      data.leaderboard = null; // pesan dihapus manual → berhenti di-update
      save();
      return;
    }
    // Pesan lama format embed tidak bisa diubah ke Components V2 → kirim baru & hapus yang lama.
    const sent = await channel.send(payload).catch(() => null);
    if (!sent) return;
    await channel.messages.delete(loc.messageId).catch(() => {});
    data.leaderboard = { channelId: channel.id, messageId: sent.id };
    save();
  }
}
function scheduleLeaderboard(client) {
  clearTimeout(lbTimer);
  lbTimer = setTimeout(() => updateLeaderboard(client).catch(() => {}), 3000);
}

async function sendLog(guild, payload) {
  const cfg = loadConfig();
  if (!isId(cfg.channelId)) return console.warn('[invites] channelId invite log belum diisi di invites.json');
  const channel = await guild.channels.fetch(cfg.channelId).catch(() => null);
  if (!channel?.isTextBased()) return console.warn(`[invites] channel invite log ${cfg.channelId} tidak ditemukan / bot tidak bisa melihatnya`);
  // Coba 2x (jaga-jaga koneksi VPS sedang bermasalah).
  for (let i = 0; i < 2; i++) {
    try {
      return await channel.send(payload);
    } catch (e) {
      if (i === 1 || e.code === 50013 || e.code === 50001) {
        console.error(`[invites] gagal kirim log (${e.code || ''} ${e.message}) — cek izin bot di channel invite log: View Channel, Send Messages.`);
        return null;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return null;
}

/** Perbarui pesan log join (status verifikasi berubah). */
async function updateJoinLog(member, rec) {
  if (!rec?.logMessageId || !rec.logChannelId) return;
  const channel = await member.client.channels.fetch(rec.logChannelId).catch(() => null);
  if (!channel?.isTextBased()) return;
  await channel.messages.edit(rec.logMessageId, buildJoinLog(member, rec, loadConfig())).catch((e) => {
    if (e.code === 10008) {
      rec.logMessageId = null; // pesan log dihapus manual
      save();
    }
  });
}

// ───────────────────────── Event ─────────────────────────
/** Saat bot menyala: cocokkan status verifikasi semua member tercatat (role bisa berubah saat bot mati). */
function syncVerified(guild) {
  const rid = verifyRoleId();
  let changed = false;
  const toUpdate = [];
  for (const [id, rec] of Object.entries(data.members)) {
    if (rec.left) continue;
    const m = guild.members.cache.get(id);
    if (!m) continue;
    const v = !rid || m.roles.cache.has(rid);
    if (rec.verified !== v) {
      if (v && rec.verified === false) {
        rec.verifiedAt = Date.now();
        toUpdate.push([m, rec]);
      }
      rec.verified = v;
      changed = true;
    }
    if ('fake' in rec) {
      delete rec.fake;
      changed = true;
    }
  }
  if (changed) save();
  // Perbarui log join yang statusnya berubah saat bot mati (bertahap, tidak spam API).
  (async () => {
    for (const [m, rec] of toUpdate.slice(0, 50)) {
      await updateJoinLog(m, rec);
      await new Promise((r) => setTimeout(r, 1500));
    }
  })().catch(() => {});
}

function registerInviteTracker(client) {
  client.once(Events.ClientReady, async () => {
    for (const guild of client.guilds.cache.values()) {
      await refreshCache(guild);
      // Simpan semua member ke cache supaya data "lama di server" tersedia saat member keluar.
      await fetchAllMembers(guild);
      syncVerified(guild);
    }
    if (data.leaderboard) scheduleLeaderboard(client);
  });
  client.on(Events.InviteCreate, (inv) => {
    const map = cache.get(inv.guild?.id);
    map?.set(inv.code, { uses: inv.uses || 0, inviterId: inv.inviter?.id || inv.inviterId || null, maxUses: inv.maxUses || 0 });
  });
  client.on(Events.InviteDelete, (inv) => {
    // Jangan langsung dihapus: dibutuhkan untuk mendeteksi undangan sekali pakai yang baru saja dipakai.
    setTimeout(() => cache.get(inv.guild?.id)?.delete(inv.code), 10000);
  });
  client.on(Events.GuildCreate, (guild) => refreshCache(guild));

  client.on(Events.GuildMemberAdd, (member) => {
    const prev = queues.get(member.guild.id) || Promise.resolve();
    const next = prev
      .then(async () => {
        const cfg = loadConfig();
        const found = member.user.bot ? null : await detectInvite(member.guild);
        const old = data.members[member.id];
        const verified = isVerifiedMember(member);
        const rec = {
          inviterId: found?.inviterId || null,
          code: found?.code || null,
          joinedAt: Date.now(),
          memberNo: member.guild.memberCount,
          verified,
          verifiedAt: verified ? Date.now() : null,
          left: false,
          rejoin: Boolean(old),
          bot: member.user.bot || undefined,
        };
        // Undangan diri sendiri tidak dihitung.
        if (rec.inviterId === member.id) rec.inviterId = null;
        if (!member.user.bot) {
          data.members[member.id] = rec;
          save();
        }
        const msg = await sendLog(member.guild, buildJoinLog(member, rec, cfg));
        if (msg && !member.user.bot) {
          rec.logChannelId = msg.channelId;
          rec.logMessageId = msg.id;
          save();
        }
        if (!member.user.bot) scheduleLeaderboard(client);
      })
      .catch((e) => console.error('[invites] join:', e.message));
    queues.set(member.guild.id, next);
  });

  // Member mendapat role verifikasi (klik tombol Verifikasi) → undangan valid & status di log join berubah.
  client.on(Events.GuildMemberUpdate, (oldM, newM) => {
    if (newM.user?.bot) return;
    const rec = data.members[newM.id];
    if (!rec || rec.left || rec.verified !== false) return;
    if (!isVerifiedMember(newM)) return;
    rec.verified = true;
    rec.verifiedAt = Date.now();
    save();
    updateJoinLog(newM, rec).catch(() => {});
    if (rec.inviterId && rec.inviterId !== 'vanity') scheduleLeaderboard(client);
  });

  client.on(Events.GuildMemberRemove, async (member) => {
    try {
      if (member.partial) member = (await member.fetch().catch(() => null)) || member; // biasanya gagal (sudah keluar) → pakai data seadanya
    } catch {}
    if (!member.user || member.user.bot) return;
    const rec = data.members[member.id];
    if (rec) {
      rec.left = true;
      rec.leftAt = Date.now();
      save();
      // Keluar sebelum verifikasi → status di log join ikut berubah.
      if (rec.verified === false) updateJoinLog(member, rec).catch(() => {});
    }
    await sendLog(member.guild, buildLeaveLog(member, rec, loadConfig())).catch(() => {});
    if (rec) scheduleLeaderboard(client);
  });
}

// ───────────────────────── Command ─────────────────────────
/** /invites [member] → statistik undangan (hanya terlihat yang memakai command). */
const invitesCommand = {
  data: new SlashCommandBuilder()
    .setName('invites')
    .setDescription('Lihat jumlah undangan kamu / member lain')
    .setDMPermission(false)
    .addUserOption((o) => o.setName('member').setDescription('Default: kamu sendiri')),
  async execute(interaction) {
    const cfg = loadConfig();
    const user = interaction.options.getUser('member') || interaction.user;
    const s = statsOf(user.id);
    const stats = computeStats();
    const rank = Object.entries(stats)
      .filter(([, x]) => x.valid > 0)
      .sort((a, b) => b[1].valid - a[1].valid)
      .findIndex(([id]) => id === user.id);
    const rec = data.members[user.id];
    const e = new EmbedBuilder()
      .setColor(color(cfg, 'brand', 0x3498db))
      .setAuthor({ name: `${user.globalName || user.username} • Statistik Undangan`, iconURL: user.displayAvatarURL({ size: 128 }) })
      .setThumbnail(user.displayAvatarURL({ extension: 'png', size: 256 }))
      .addFields(
        { name: '✅ Valid', value: `\`${num(s.valid)}\``, inline: true },
        { name: '📥 Total', value: `\`${num(s.total)}\``, inline: true },
        { name: '🏆 Peringkat', value: rank >= 0 ? `\`#${rank + 1}\`` : '`-`', inline: true },
        { name: '📤 Keluar', value: `\`${num(s.left)}\``, inline: true },
        { name: '⏳ Belum Verifikasi', value: `\`${num(s.pending)}\``, inline: true },
        { name: '🎫 Diundang Oleh', value: inviterText(rec), inline: true },
      )
      .setFooter(footer(interaction.guild))
      .setTimestamp(new Date());
    return interaction.reply({ embeds: [e], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  },
};

/** /invite-log leaderboard [channel] → kirim / pindahkan Top 10 Inviter (ter-update otomatis). */
const inviteLogCommand = {
  data: new SlashCommandBuilder()
    .setName('invite-log')
    .setDescription('Pengaturan invite log (khusus admin)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addSubcommand((s) =>
      s
        .setName('leaderboard')
        .setDescription('Kirim / pindahkan Top 10 Inviter (ter-update otomatis)')
        .addChannelOption((o) =>
          o.setName('channel').setDescription('Default: leaderboardChannelId di invites.json').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        ),
    ),
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const cfg = loadConfig();
    const channel =
      interaction.options.getChannel('channel') ||
      (isId(cfg.leaderboardChannelId) ? await interaction.guild.channels.fetch(cfg.leaderboardChannelId).catch(() => null) : null) ||
      interaction.channel;
    if (!channel?.isTextBased()) return interaction.editReply('❌ Channel tidak ditemukan.');
    const old = data.leaderboard;
    const sent = await channel.send(buildLeaderboard(interaction.guild, cfg));
    data.leaderboard = { channelId: channel.id, messageId: sent.id };
    save();
    if (old && old.messageId !== sent.id) {
      const oldCh = await interaction.guild.channels.fetch(old.channelId).catch(() => null);
      await oldCh?.messages.delete(old.messageId).catch(() => {});
    }
    await refreshCache(interaction.guild);
    const canRead = cache.has(interaction.guild.id);
    return interaction.editReply(
      `✅ Top 10 Inviter dikirim ke ${channel} dan akan ter-update otomatis setiap ada member masuk / keluar / verifikasi.` +
        (canRead ? '' : '\n⚠️ Bot belum bisa membaca daftar undangan — beri bot izin **Manage Server** supaya invite log berjalan.'),
    );
  },
};

module.exports = { registerInviteTracker, invitesCommand, inviteLogCommand, buildLeaderboard, computeStats };
