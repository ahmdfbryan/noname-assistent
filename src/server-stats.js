const fs = require('fs');
const { fetchAllMembers } = require('./member-cache');
const path = require('path');
const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags, Events } = require('discord.js');
const { state: storeState, isProductOpen } = require('./store/state');
const { loadConfig: loadStoreConfig, groupOf } = require('./store/config');

/**
 * Server Stats: kategori + voice channel terkunci yang namanya menampilkan angka terkini.
 * Active Tickets / Total Orders + status buka/tutup produk (🟢 buka, 🔴 tutup). Teks di server-stats.json.
 * Angka dicek tiap 1 menit; nama channel hanya diganti kalau angkanya berubah.
 * Discord membatasi ganti nama channel 2x per 10 menit → tiap channel diganti paling cepat 5 menit sekali
 * (perubahan di antaranya otomatis menyusul begitu jedanya lewat, tidak perlu refresh manual).
 */
const FILE = path.join(__dirname, '..', 'server-stats.json');
const DATA = path.join(__dirname, '..', 'data', 'server-stats.json');
const KEYS = ['tickets', 'orders', 'robux', 'gamepass', 'gift', 'digital', 'premium'];
const STATUS_KEYS = ['robux', 'gamepass', 'gift', 'digital', 'premium']; // nilainya buka/tutup, bukan angka
const DEFAULTS = {
  categoryName: '🟢 STORE STATUS',
  channels: {
    tickets: '🎫 Active Tickets: {count}',
    orders: '✅ Total Orders: {count}',
    robux: '{status} Robux Visend',
    gamepass: '{status} Robux Gamepass',
    gift: '{status} Gift In-Game',
    digital: '{status} Produk Digital',
    premium: '{status} Premium App',
  },
  countBots: false,
  formatNumber: false,
  updateMinutes: 5,
};

function loadConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { ...DEFAULTS, ...c, channels: { ...DEFAULTS.channels, ...(c.channels || {}) } };
  } catch {
    return DEFAULTS;
  }
}
function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA, 'utf8'));
  } catch {
    return {};
  }
}
const data = loadData(); // { guildId, categoryId, channels: { members, tickets, orders }, lastNames: {} }
function save() {
  fs.mkdirSync(path.dirname(DATA), { recursive: true });
  fs.writeFileSync(`${DATA}.tmp`, JSON.stringify(data, null, 2));
  fs.renameSync(`${DATA}.tmp`, DATA);
}

/** Angka terkini untuk setiap channel. */
/**
 * Jumlah member tanpa bot. Cache member bisa belum lengkap (misal tepat setelah bot restart),
 * jadi daftar member diambil dulu; kalau tetap belum lengkap, pakai total member dari Discord
 * supaya angkanya tidak salah (misal tiba-tiba jadi 1).
 */
async function memberCount(guild, cfg) {
  if (cfg.countBots) return guild.memberCount;
  if (guild.members.cache.size < guild.memberCount) await fetchAllMembers(guild);
  if (guild.members.cache.size >= guild.memberCount * 0.95) return guild.members.cache.filter((m) => !m.user.bot).size;
  return guild.memberCount;
}

/** Ticket aktif = ticket order store (termasuk Premium App) + ticket NCS Ticket Center. */
function activeTickets() {
  const store = Object.values(storeState.tickets || {}).filter((t) => t.status === 'open').length;
  let ncs = 0;
  try {
    ncs = require('./support-ticket').openCount(); // dimuat saat dipakai (hindari require melingkar)
  } catch {}
  return store + ncs;
}

/** Status buka (true) / tutup (false) tiap produk. Produk Digital & Premium App = buka kalau ada minimal satu produknya yang buka. */
function productStatus() {
  const products = (loadStoreConfig()?.products || []).filter((p) => p.type !== 'soon');
  const anyOpen = (list) => list.some((p) => isProductOpen(p));
  return {
    robux: anyOpen(products.filter((p) => p.id === 'robux-visend')),
    gamepass: anyOpen(products.filter((p) => p.id === 'robux-gamepass')),
    gift: anyOpen(products.filter((p) => p.id === 'gift-ingame')),
    digital: anyOpen(products.filter((p) => groupOf(p) === 'digital')),
    premium: anyOpen(products.filter((p) => p.type === 'instant')),
  };
}

async function values(guild, cfg) {
  const tickets = activeTickets();
  const orders = (storeState.stats?.transactions || 0) + (storeState.stats?.rekber || 0);
  return { tickets, orders, ...productStatus() };
}
function nameFor(key, value, cfg) {
  if (STATUS_KEYS.includes(key)) return String(cfg.channels[key] || `{status} ${key}`).replace(/\{status\}/g, value ? '🟢' : '🔴').slice(0, 100);
  const n = cfg.formatNumber ? Number(value).toLocaleString('id-ID') : String(value);
  return String(cfg.channels[key] || `${key}: {count}`).replace(/\{count\}/g, n).slice(0, 100);
}
const summary = (v) => `🎫 ${v.tickets} • ✅ ${v.orders} • ${v.robux ? '🟢' : '🔴'} Robux • ${v.gamepass ? '🟢' : '🔴'} Gamepass • ${v.gift ? '🟢' : '🔴'} Gift • ${v.digital ? '🟢' : '🔴'} Digital • ${v.premium ? '🟢' : '🔴'} Premium`;

/** Izin: semua bisa melihat tapi tidak bisa masuk (gembok 🔒). */
function lockedOverwrites(guild) {
  return [
    { id: guild.roles.everyone.id, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.Connect] },
    { id: guild.members.me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.ManageChannels] },
  ];
}

let busy = false;
const RENAME_GAP = 5 * 60 * 1000; // aman dari batas Discord (2x / 10 menit per channel)
const lastRename = {}; // key → waktu ganti nama terakhir
/** Perbarui nama channel yang angkanya berubah. force = abaikan cek nama sama. */
async function update(client, { force = false } = {}) {
  if (busy || !data.guildId) return { ok: false, reason: 'belum di-setup' };
  busy = true;
  try {
    const guild = client.guilds.cache.get(data.guildId);
    if (!guild) return { ok: false, reason: 'server tidak ditemukan' };
    const cfg = loadConfig();
    const v = await values(guild, cfg);
    let changed = 0;
    if (data.categoryId) {
      const cat = guild.channels.cache.get(data.categoryId) || (await guild.channels.fetch(data.categoryId).catch(() => null));
      if (cat && cat.name !== cfg.categoryName) await cat.setName(cfg.categoryName).catch(() => {});
    }
    // Channel "Members" (versi lama) dihapus otomatis; channel baru yang belum ada dibuat di kategori yang sama.
    if (data.channels?.members) {
      const old = guild.channels.cache.get(data.channels.members) || (await guild.channels.fetch(data.channels.members).catch(() => null));
      if (old) await old.delete('Server stats: Members dihapus').catch(() => {});
      delete data.channels.members;
      save();
    }
    if (data.categoryId && data.channels && guild.members.me.permissions.has(PermissionFlagsBits.ManageChannels)) {
      for (const key of KEYS) {
        if (data.channels[key]) continue;
        const made = await guild.channels
          .create({ name: nameFor(key, v[key], cfg), type: ChannelType.GuildVoice, parent: data.categoryId, permissionOverwrites: lockedOverwrites(guild) })
          .catch((e) => (console.warn(`[server-stats] gagal membuat channel ${key}:`, e.message), null));
        if (made) {
          data.channels[key] = made.id;
          lastRename[key] = Date.now();
          save();
          // Channel baru diletakkan tepat di bawah channel sebelumnya pada urutan KEYS (mis. Gift In-Game di bawah Gamepass).
          const prevKey = KEYS[KEYS.indexOf(key) - 1];
          const prev = prevKey && data.channels[prevKey] ? guild.channels.cache.get(data.channels[prevKey]) : null;
          if (prev) await made.setPosition(prev.position + 1).catch((e) => console.warn(`[server-stats] gagal mengatur posisi ${key}:`, e.message));
        }
      }
    }
    for (const key of KEYS) {
      const id = data.channels?.[key];
      if (!id) continue;
      const ch = guild.channels.cache.get(id) || (await guild.channels.fetch(id).catch(() => null));
      if (!ch) continue;
      const name = nameFor(key, v[key], cfg);
      if (!force && ch.name === name) continue;
      // Baru saja diganti → tunggu jeda (dicek lagi tiap menit, otomatis menyusul).
      if (!force && Date.now() - (lastRename[key] || 0) < RENAME_GAP) continue;
      lastRename[key] = Date.now();
      // Batas Discord: ganti nama channel 2x / 10 menit. Kalau kena batas, setName menunggu → beri batas waktu.
      await Promise.race([ch.setName(name, 'Server stats'), new Promise((r) => setTimeout(r, 15000))]).catch((e) =>
        console.warn(`[server-stats] gagal ganti nama ${key}:`, e.message),
      );
      changed += 1;
    }
    return { ok: true, changed, values: v };
  } finally {
    busy = false;
  }
}

const serverStatsCommand = {
  data: new SlashCommandBuilder()
    .setName('server-stats')
    .setDescription('Server stats (channel angka otomatis)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addSubcommand((s) => s.setName('setup').setDescription('Buat kategori & channel server stats di paling atas'))
    .addSubcommand((s) => s.setName('refresh').setDescription('Perbarui angka & nama channel sekarang'))
    .addSubcommand((s) => s.setName('hapus').setDescription('Hapus kategori & channel server stats')),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guild = interaction.guild;
    const sub = interaction.options.getSubcommand();
    const cfg = loadConfig();
    if (!guild.members.me.permissions.has(PermissionFlagsBits.ManageChannels)) {
      return interaction.editReply('❌ Bot butuh izin **Manage Channels** untuk server stats.');
    }

    if (sub === 'setup') {
      // Hapus yang lama dulu kalau ada (supaya tidak dobel).
      await removeAll(guild);
      const v = await values(guild, cfg);
      const category = await guild.channels.create({
        name: cfg.categoryName,
        type: ChannelType.GuildCategory,
        position: 0,
        permissionOverwrites: lockedOverwrites(guild),
      });
      data.guildId = guild.id;
      data.categoryId = category.id;
      data.channels = {};
      for (const key of KEYS) {
        const ch = await guild.channels.create({
          name: nameFor(key, v[key], cfg),
          type: ChannelType.GuildVoice,
          parent: category.id,
          permissionOverwrites: lockedOverwrites(guild),
        });
        data.channels[key] = ch.id;
      }
      save();
      await category.setPosition(0).catch(() => {});
      return interaction.editReply(
        `✅ Server stats dibuat di kategori **${cfg.categoryName}** (paling atas).\n` +
          `${summary(v)}\nAngka & status ter-update otomatis (dicek tiap menit, maks. 1x ganti nama per 5 menit per channel — batas Discord).`,
      );
    }

    if (sub === 'refresh') {
      if (!data.guildId) return interaction.editReply('❌ Server stats belum dibuat. Jalankan `/server-stats setup` dulu.');
      const res = await update(interaction.client, { force: true });
      if (!res.ok) return interaction.editReply(`❌ Gagal: ${res.reason}`);
      return interaction.editReply(
        `✅ Diperbarui: ${summary(res.values)}\n` +
          '_Catatan: Discord membatasi ganti nama channel 2x / 10 menit, jadi perubahan bisa tertunda._',
      );
    }

    if (sub === 'hapus') {
      const n = await removeAll(guild);
      return interaction.editReply(n ? '🗑️ Server stats dihapus.' : 'Server stats belum dibuat.');
    }
  },
};

async function removeAll(guild) {
  if (!data.categoryId && !data.channels) return 0;
  let n = 0;
  for (const id of [...Object.values(data.channels || {}), data.categoryId]) {
    if (!id) continue;
    const ch = guild.channels.cache.get(id) || (await guild.channels.fetch(id).catch(() => null));
    if (ch) {
      await ch.delete('Server stats dihapus / dibuat ulang').catch(() => {});
      n += 1;
    }
  }
  delete data.categoryId;
  delete data.channels;
  delete data.guildId;
  save();
  return n;
}

function registerServerStats(client) {
  client.once(Events.ClientReady, () => {
    update(client).catch(() => {});
    // Cek angka tiap 1 menit (ringan: hanya hitung data di memori). Ganti nama tetap dibatasi RENAME_GAP per channel.
    setInterval(() => update(client).catch((e) => console.warn('[server-stats]', e.message)), 60 * 1000);
  });
  // Channel stats dihapus manual → berhenti meng-update channel itu.
  client.on(Events.ChannelDelete, (ch) => {
    if (!data.channels) return;
    let hit = false;
    for (const k of KEYS) if (data.channels[k] === ch.id) (delete data.channels[k], (hit = true));
    if (data.categoryId === ch.id) (delete data.categoryId, (hit = true));
    if (hit) save();
  });
}

module.exports = { serverStatsCommand, registerServerStats, update, memberCount };
