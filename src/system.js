const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  MessageFlags,
  Events,
  RESTJSONErrorCodes,
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  version: djsVersion,
} = require('discord.js');
const UI = require('./ui');

/**
 * System Operational (Components V2): 1 pesan dashboard status bot yang ter-update otomatis.
 * Isi: status keseluruhan, info bot (uptime, ping, restart), server (RAM, CPU, versi),
 * status tiap layanan/fitur, statistik, dan riwayat perubahan status. Teks di system.json.
 */
const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'system.json');
const DATA = path.join(ROOT, 'data', 'system.json');
const V2 = MessageFlags.IsComponentsV2;
const EPH = MessageFlags.Ephemeral;
const REFRESH_ID = 'sys:refresh';
const isId = (v) => /^\d{17,20}$/.test(String(v || ''));
const num = (n) => Math.round(Number(n) || 0).toLocaleString('id-ID');
const ts = (ms, s = 'R') => `<t:${Math.floor(ms / 1000)}:${s}>`;
const startedAt = Date.now();
let client = null;

const readJson = (file, fb = null) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  } catch {
    return fb;
  }
};
const DEFAULTS = { channelId: '1560498592429379655', updateSeconds: 60, title: '🛰️ System Operational', subtitle: '{server} • Bot Status', colors: {} };
const loadConfig = () => ({ ...DEFAULTS, ...(readJson('system.json', {}) || {}) });
function loadData() {
  try {
    return { message: null, history: [], lastStatus: {}, ...JSON.parse(fs.readFileSync(DATA, 'utf8')) };
  } catch {
    return { message: null, history: [], lastStatus: {} };
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

// Hitung error yang tercatat sejak bot menyala (console.error).
let errorCount = 0;
let lastError = null;
const origError = console.error.bind(console);
console.error = (...args) => {
  errorCount += 1;
  lastError = { at: Date.now(), text: args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ').slice(0, 120) };
  origError(...args);
};

function duration(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return [d && `${d}h`, (d || h) && `${h}j`, `${m}m`].filter(Boolean).join(' ');
}
const mb = (b) => `${num(b / 1024 / 1024)} MB`;
const bar = (pct) => {
  const n = Math.max(0, Math.min(10, Math.round(pct / 10)));
  return `${'▰'.repeat(n)}${'▱'.repeat(10 - n)}`;
};
const DOT = { ok: '🟢', warn: '🟡', down: '🔴', off: '⚪' };

// ───────────────────────── Cek layanan ─────────────────────────
let roblox = { ok: null, ms: 0, at: 0 };
async function checkRoblox() {
  if (Date.now() - roblox.at < 5 * 60 * 1000 && roblox.ok !== null) return roblox;
  const t0 = Date.now();
  try {
    const res = await fetch(`https://users.${process.env.ROBLOX_DOMAIN || 'roblox.com'}/v1/users/1`, { signal: AbortSignal.timeout(6000) });
    roblox = { ok: res.ok, ms: Date.now() - t0, at: Date.now() };
  } catch {
    roblox = { ok: false, ms: 0, at: Date.now() };
  }
  return roblox;
}

/** Daftar layanan + statusnya: { key, name, state: ok|warn|down|off, note } */
async function services(guild) {
  const list = [];
  const add = (key, name, state, note) => list.push({ key, name, state, note });
  const me = guild.members.me;
  const ping = client.ws.ping;

  add('gateway', '📡 Discord Gateway', ping < 0 ? 'warn' : ping < 300 ? 'ok' : ping < 700 ? 'warn' : 'down', ping < 0 ? 'Menghubungkan...' : `Ping ${num(ping)} ms`);

  const rb = await checkRoblox();
  add('roblox', '🎮 Roblox API', rb.ok ? (rb.ms > 2500 ? 'warn' : 'ok') : 'down', rb.ok ? `Respon ${num(rb.ms)} ms` : 'Tidak bisa dihubungi');

  // Store
  try {
    const { state, isProductOpen } = require('./store/state');
    const { loadConfig: storeCfg } = require('./store/config');
    const cfg = storeCfg();
    const sellable = (cfg?.products || []).filter((p) => p.type !== 'soon');
    const open = sellable.filter((p) => isProductOpen(p)).length;
    const tickets = Object.values(state.tickets || {}).filter((t) => t.status === 'open').length;
    add('store', '🛒 Noname Store', !cfg ? 'down' : open ? 'ok' : 'warn', !cfg ? 'store.json bermasalah' : `${open}/${sellable.length} produk buka • ${num(tickets)} ticket aktif`);
  } catch (e) {
    add('store', '🛒 Noname Store', 'down', 'Gagal dimuat');
  }

  // NCS Ticket Center
  const st = readJson('data/support-tickets.json', null);
  const stOpen = st ? Object.values(st.tickets || {}).filter((t) => t.status === 'open').length : 0;
  add('ticket', '🎫 NCS Ticket Center', st?.panel || st ? 'ok' : 'off', st ? `${num(stOpen)} ticket aktif` : 'Panel belum dikirim');

  // Verifikasi
  const vcfg = readJson('verify.json', {});
  const vrole = isId(vcfg?.roleId) ? guild.roles.cache.get(vcfg.roleId) : null;
  if (!vrole) add('verify', '✅ Verifikasi', 'down', 'Role verifikasi tidak ditemukan');
  else if (!me.permissions.has(PermissionFlagsBits.ManageRoles) || me.roles.highest.comparePositionTo(vrole) <= 0) add('verify', '✅ Verifikasi', 'down', 'Bot tidak bisa memberi role');
  else add('verify', '✅ Verifikasi', 'ok', `Role ${vrole.name}`);

  // Giveaway
  const ga = readJson('data/giveaways.json', null);
  const gaActive = ga ? Object.values(ga.items || {}).filter((g) => g.status === 'active').length : 0;
  add('giveaway', '🎉 Giveaway', 'ok', `${num(gaActive)} giveaway berjalan`);

  // Suggestions
  const sg = readJson('data/suggestions.json', null);
  const sgAll = sg ? Object.values(sg.items || {}).filter((s) => !s.deleted) : [];
  add('suggestions', '💡 Suggestions', sg?.panel ? 'ok' : 'off', sg?.panel ? `${num(sgAll.length)} saran • ${num(sgAll.filter((s) => s.status === 'pending').length)} menunggu` : 'Panel belum dikirim');

  // Invite tracker
  add('invites', '📨 Invite Tracker', me.permissions.has(PermissionFlagsBits.ManageGuild) ? 'ok' : 'down', me.permissions.has(PermissionFlagsBits.ManageGuild) ? 'Melacak undangan' : 'Butuh izin Manage Server');

  // Booster
  const bcfg = readJson('booster.json', {});
  add('booster', '💎 Booster', isId(bcfg?.channelId) && guild.channels.cache.has(bcfg.channelId) ? 'ok' : 'off', `${num(guild.premiumSubscriptionCount || 0)} boost • Level ${Number(guild.premiumTier) || 0}`);

  // Server stats
  const ss = readJson('data/server-stats.json', {});
  add('stats', '📊 Server Stats', ss?.categoryId ? 'ok' : 'off', ss?.categoryId ? 'Update tiap 5 menit' : 'Belum di-setup');

  // Voice finder
  const vf = readJson('data/voice-finder-panel.json', {});
  add('voice', '🔎 Cari Voice', Object.keys(vf || {}).length ? 'ok' : 'off', Object.keys(vf || {}).length ? 'Panel aktif' : 'Panel belum dikirim');

  // Social
  const so = readJson('data/social-state.json', {});
  add('social', '🌐 Social Media', so?.message ? 'ok' : 'off', so?.message ? 'Update tiap 1 jam' : 'Belum dikirim');

  return list;
}

function overallOf(list) {
  if (list.some((s) => s.state === 'down')) return { state: 'down', title: '🔴 Terjadi Gangguan', text: 'Ada layanan yang **sedang bermasalah**. Tim kami sedang menanganinya.' };
  if (list.some((s) => s.state === 'warn')) return { state: 'warn', title: '🟡 Sebagian Sistem Terganggu', text: 'Sebagian layanan berjalan **lebih lambat** dari biasanya.' };
  return { state: 'ok', title: '🟢 Semua Sistem Normal', text: 'Semua layanan bot **berjalan dengan baik**. ✨' };
}

/** Catat perubahan status layanan (maks 5 riwayat terakhir). */
function trackHistory(list) {
  let changed = false;
  for (const s of list) {
    const prev = data.lastStatus[s.key];
    if (prev && prev !== s.state && s.state !== 'off' && prev !== 'off') {
      data.history.unshift({ at: Date.now(), name: s.name, from: prev, to: s.state });
      changed = true;
    }
    if (prev !== s.state) changed = true;
    data.lastStatus[s.key] = s.state;
  }
  data.history = data.history.slice(0, 5);
  if (changed) save();
}

// ───────────────────────── Tampilan ─────────────────────────
const text = (c) => new TextDisplayBuilder().setContent(String(c).slice(0, 4000));
const line = () => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);

async function buildDashboard(guild) {
  const cfg = loadConfig();
  const list = await services(guild);
  trackHistory(list);
  const all = overallOf(list);
  const colors = { ok: 0x2ecc71, warn: 0xf1c40f, down: 0xe74c3c };
  const name = (t) => String(t || '').replace(/\{server\}/g, guild.name);

  const mem = process.memoryUsage();
  const total = os.totalmem();
  const used = total - os.freemem();
  const load = os.loadavg()[0];
  const cpuPct = Math.min(100, (load / Math.max(1, os.cpus().length)) * 100);
  const pkg = readJson('package.json', {});
  // Cache member belum lengkap (misal baru restart) → pakai total member dari Discord.
  const cacheFull = guild.members.cache.size >= guild.memberCount * 0.95;
  const humans = cacheFull ? guild.members.cache.filter((m) => !m.user.bot).size : guild.memberCount;
  const bots = cacheFull ? guild.members.cache.filter((m) => m.user.bot).size : null;

  const box = UI.accent(new ContainerBuilder(), hex(cfg.colors?.[all.state], colors[all.state]));
  const header = `# ${cfg.title}\n-# ${name(cfg.subtitle)}`;
  const avatar = client.user.displayAvatarURL({ extension: 'png', size: 256 });
  box.addSectionComponents(new SectionBuilder().addTextDisplayComponents(text(header)).setThumbnailAccessory(new ThumbnailBuilder().setURL(avatar)));

  const blocks = [
    `## ${all.title}\n${all.text}`,
    [
      '### 🤖 Bot',
      `**🟢 Status:** \`Online\` • ${client.user.tag}`,
      `**⏱️ Uptime:** \`${duration(Date.now() - startedAt)}\` • restart ${ts(startedAt)}`,
      `**📡 Ping:** \`${client.ws.ping < 0 ? '-' : `${num(client.ws.ping)} ms`}\``,
      `**⚠️ Error sejak start:** \`${num(errorCount)}\`${lastError ? ` • terakhir ${ts(lastError.at)}` : ''}`,
    ].join('\n'),
    [
      '### 🖥️ Server',
      `**🧠 RAM Bot:** \`${mb(mem.rss)}\` • heap \`${mb(mem.heapUsed)}\``,
      `**💾 RAM VPS:** ${bar((used / total) * 100)} \`${Math.round((used / total) * 100)}%\` (${mb(used)} / ${mb(total)})`,
      `**⚙️ CPU Load:** ${bar(cpuPct)} \`${Math.round(cpuPct)}%\` • ${os.cpus().length} core`,
      `**🕰️ Uptime VPS:** \`${duration(os.uptime() * 1000)}\``,
      `**📦 Versi:** \`v${pkg.version || '1.0.0'}\` • Node \`${process.version}\` • discord.js \`v${djsVersion}\``,
    ].join('\n'),
    `### 🧩 Status Layanan\n${list.map((s) => `${DOT[s.state]} **${s.name}** — ${s.note}`).join('\n')}`,
    [
      '### 📊 Statistik Server',
      `**👥 Member:** \`${num(humans)}\` • **🤖 Bot:** \`${bots == null ? 'memuat...' : num(bots)}\` • **🎧 Di Voice:** \`${num(guild.voiceStates.cache.filter((v) => v.channelId && !v.member?.user.bot).size)}\``,
      `**🚀 Boost:** \`${num(guild.premiumSubscriptionCount || 0)}\` • **🗂️ Channel:** \`${num(guild.channels.cache.size)}\` • **🏷️ Role:** \`${num(guild.roles.cache.size)}\``,
    ].join('\n'),
    data.history.length
      ? `### 📜 Riwayat Status\n${data.history.map((h) => `${DOT[h.to]} ${h.name}: ${DOT[h.from]} → ${DOT[h.to]} • ${ts(h.at)}`).join('\n')}`
      : null,
    `-# ${DOT.ok} Normal • ${DOT.warn} Lambat • ${DOT.down} Gangguan • ${DOT.off} Belum diaktifkan\n-# ${guild.name} • Diperbarui ${ts(Date.now())}`,
  ];
  for (const b of blocks.filter(Boolean)) {
    box.addSeparatorComponents(line());
    box.addTextDisplayComponents(text(b));
  }
  box.addActionRowComponents(
    new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(REFRESH_ID).setLabel('Refresh Status').setEmoji('🔄').setStyle(ButtonStyle.Secondary)),
  );
  return { components: [box], flags: V2, allowedMentions: { parse: [] } };
}

// ───────────────────────── Update otomatis ─────────────────────────
let busy = false;
async function refresh() {
  if (busy || !client || !data.message) return false;
  busy = true;
  try {
    const ch = await client.channels.fetch(data.message.channelId).catch(() => null);
    if (!ch) return false;
    const payload = await buildDashboard(ch.guild);
    try {
      await ch.messages.edit(data.message.messageId, payload);
    } catch (err) {
      if (err.code === RESTJSONErrorCodes.UnknownMessage) {
        data.message = null; // pesan dihapus manual → berhenti di-update
        save();
        return false;
      }
      throw err;
    }
    return true;
  } catch (e) {
    console.warn('[system] gagal update dashboard:', e.message);
    return false;
  } finally {
    busy = false;
  }
}

let lastManual = 0;
async function handleInteraction(interaction) {
  if (!interaction.isButton?.() || interaction.customId !== REFRESH_ID) return false;
  if (Date.now() - lastManual < 10000) {
    await interaction.reply({ content: '⏳ Dashboard baru saja diperbarui, coba lagi beberapa detik lagi.', flags: EPH }).catch(() => {});
    return true;
  }
  lastManual = Date.now();
  await interaction.deferUpdate().catch(() => {});
  await interaction.editReply(await buildDashboard(interaction.guild)).catch((e) => console.warn('[system] refresh:', e.message));
  return true;
}

const systemCommand = {
  data: new SlashCommandBuilder()
    .setName('system')
    .setDescription('Dashboard System Operational (status bot)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addSubcommand((s) =>
      s
        .setName('panel')
        .setDescription('Kirim dashboard status bot (ter-update otomatis)')
        .addChannelOption((o) => o.setName('channel').setDescription('Default: channelId di system.json').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
    )
    .addSubcommand((s) => s.setName('refresh').setDescription('Perbarui dashboard sekarang')),

  async execute(interaction) {
    await interaction.deferReply({ flags: EPH });
    const cfg = loadConfig();
    if (interaction.options.getSubcommand() === 'refresh') {
      const ok = await refresh();
      return interaction.editReply(ok ? '✅ Dashboard diperbarui.' : '❌ Dashboard belum dikirim. Jalankan `/system panel` dulu.');
    }
    const channel =
      interaction.options.getChannel('channel') ||
      (isId(cfg.channelId) ? await interaction.guild.channels.fetch(cfg.channelId).catch(() => null) : null) ||
      interaction.channel;
    if (!channel?.isTextBased()) return interaction.editReply('❌ Channel tidak ditemukan.');
    const sent = await channel.send(await buildDashboard(interaction.guild));
    const old = data.message;
    data.message = { channelId: channel.id, messageId: sent.id };
    save();
    if (old && old.messageId !== sent.id) {
      const oldCh = await interaction.guild.channels.fetch(old.channelId).catch(() => null);
      await oldCh?.messages.delete(old.messageId).catch(() => {});
    }
    return interaction.editReply(`✅ Dashboard System Operational dikirim ke ${channel} dan ter-update otomatis tiap ${Math.max(30, Number(cfg.updateSeconds) || 60)} detik.`);
  },
};

function registerSystem(c) {
  client = c;
  c.once(Events.ClientReady, () => {
    setTimeout(() => refresh(), 8000); // tunggu cache member & ping siap
    const every = Math.max(30, Number(loadConfig().updateSeconds) || 60) * 1000;
    setInterval(() => refresh(), every);
  });
}

module.exports = { systemCommand, registerSystem, handleInteraction, buildDashboard };
