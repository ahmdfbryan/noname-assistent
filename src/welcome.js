const fs = require('fs');
const path = require('path');
const {
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
  MessageFlags,
  PermissionFlagsBits,
} = require('discord.js');

const FILE = path.join(__dirname, '..', 'welcome.json');
const isId = (v) => /^\d{17,20}$/.test(String(v || ''));

/** Dibaca ulang tiap dipakai → edit welcome.json tidak perlu restart bot. */
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (err) {
    console.error('[welcome] welcome.json tidak bisa dibaca:', err.message);
    return null;
  }
}

function parseColor(value) {
  const n = parseInt(String(value || '').replace('#', ''), 16);
  return Number.isNaN(n) ? 0xe53935 : n;
}

function fill(text, member) {
  return String(text || '')
    .replace(/\{name\}/g, member.displayName)
    .replace(/\{username\}/g, member.user.username)
    .replace(/\{mention\}/g, `<@${member.id}>`)
    .replace(/\{server\}/g, member.guild.name)
    .replace(/\{memberCount\}/g, Number(member.guild.memberCount || 0).toLocaleString('id-ID'))
    .replace(/\{channel:(\d{17,20})\}/g, '<#$1>');
}

function thumbnailUrl(setting, member) {
  if (!setting || setting === 'avatar') return member.displayAvatarURL({ extension: 'png', size: 256 });
  if (setting === 'server') return member.guild.iconURL({ extension: 'png', size: 256 });
  return /^https?:\/\//.test(setting) ? setting : null;
}

function buttonUrl(btn, guildId) {
  if (btn.url && /^https?:\/\//.test(btn.url)) return btn.url;
  if (isId(btn.channelId)) return `https://discord.com/channels/${guildId}/${btn.channelId}`;
  return null;
}

/** Banner / GIF di bawah welcome: path file di folder bot (contoh "assets/welcome-banner.gif") atau link https. */
function bannerPart(cfg) {
  const src = String(cfg.banner || '').trim();
  if (!src) return null;
  if (/^https?:\/\//i.test(src)) return { url: src, files: [] };
  const file = path.join(__dirname, '..', src);
  if (!fs.existsSync(file)) {
    console.warn(`[welcome] banner ${src} tidak ditemukan — welcome dikirim tanpa banner.`);
    return null;
  }
  const name = `welcome-banner${path.extname(file) || '.gif'}`;
  return { url: `attachment://${name}`, files: [{ attachment: file, name }] };
}

const line = () => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
const td = (c) => new TextDisplayBuilder().setContent(String(c).slice(0, 4000));

/**
 * Susun pesan welcome (1 kotak Components V2) untuk satu member:
 * sambutan + foto → langkah awal → keuntungan member → GIF → footer → tombol.
 * Default tanpa warna aksen di kiri (hanya garis kotak); welcome.json "showAccent": true untuk memakai accentColor.
 */
function buildWelcomeMessage(member, cfg) {
  const components = [];
  if (cfg.mentionMember) components.push(td(`<@${member.id}>`));

  const box = new ContainerBuilder();
  if (cfg.showAccent === true) box.setAccentColor(parseColor(cfg.accentColor));

  // Sambutan + foto profil di kanan
  const w = cfg.welcome || {};
  const head = [
    `# ${fill(w.title || '👋 Selamat Datang, {name}!', member)}`,
    w.subtitle ? `-# ${fill(w.subtitle, member)}` : null,
    fill(w.description || '', member) || null,
  ]
    .filter(Boolean)
    .join('\n');
  const thumb = thumbnailUrl(w.thumbnail, member);
  if (thumb) box.addSectionComponents(new SectionBuilder().addTextDisplayComponents(td(head)).setThumbnailAccessory(new ThumbnailBuilder().setURL(thumb)));
  else box.addTextDisplayComponents(td(head));

  // Langkah awal (bernomor)
  const steps = (cfg.steps?.items || []).map((x) => fill(x, member)).filter(Boolean);
  if (steps.length) {
    box.addSeparatorComponents(line());
    box.addTextDisplayComponents(
      td(`### ${fill(cfg.steps.title || '🚀 Mulai dari Sini', member)}\n${steps.map((x, i) => `\`${String(i + 1).padStart(2, '0')}\` ${x}`).join('\n')}`),
    );
  }

  // Keuntungan / apa yang ada di server
  const perks = (cfg.perks?.items || []).map((x) => fill(x, member)).filter(Boolean);
  if (perks.length) {
    box.addSeparatorComponents(line());
    box.addTextDisplayComponents(td(`### ${fill(cfg.perks.title || '💎 Yang Bisa Kamu Nikmati', member)}\n${perks.map((x) => `▸ ${x}`).join('\n')}`));
  }

  // GIF / banner di bawah
  const banner = bannerPart(cfg);
  if (banner) box.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(banner.url)));

  // Footer
  box.addSeparatorComponents(line());
  box.addTextDisplayComponents(td(`-# ${fill(cfg.footer || '{server} • Selamat bergabung & have fun!', member)} • <t:${Math.floor(Date.now() / 1000)}:f>`));

  // Tombol (maks 5)
  const buttons = (cfg.buttons || [])
    .map((b) => ({ ...b, url: buttonUrl(b, member.guild.id) }))
    .filter((b) => b.label && b.url)
    .slice(0, 5)
    .map((b) => {
      const btn = new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(String(b.label).slice(0, 80)).setURL(b.url);
      if (b.emoji) btn.setEmoji(b.emoji);
      return btn;
    });
  if (buttons.length) box.addActionRowComponents(new ActionRowBuilder().addComponents(buttons));

  components.push(box);
  return {
    components,
    files: banner?.files || [],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { users: cfg.mentionMember ? [member.id] : [] },
  };
}

/** Kirim welcome ke channel yang diatur di welcome.json. */
async function sendWelcome(member, { channelOverride = null } = {}) {
  const cfg = loadConfig();
  if (!cfg) return { ok: false, reason: 'welcome.json tidak bisa dibaca (cek format JSON-nya).' };
  if (!channelOverride && cfg.enabled === false) return { ok: false, reason: 'Welcome sedang dimatikan (enabled: false).' };

  let channel = channelOverride;
  if (!channel) {
    if (!isId(cfg.channelId)) return { ok: false, reason: 'channelId di welcome.json belum diisi.' };
    channel = await member.guild.channels.fetch(cfg.channelId).catch(() => null);
    if (!channel?.isTextBased()) return { ok: false, reason: `Channel ${cfg.channelId} tidak ditemukan.` };
  }

  const perms = channel.permissionsFor(member.guild.members.me);
  if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
    return { ok: false, reason: `Bot tidak punya izin kirim pesan di ${channel}.` };
  }

  await channel.send(buildWelcomeMessage(member, cfg));
  return { ok: true, channel };
}

/**
 * Catatan member yang sudah pernah disambut: 1 file kecil per member di data/welcomed/.
 * Dibuat dengan mode "wx" (gagal kalau sudah ada) → aman walaupun ada 2 proses bot sekaligus.
 * Mengembalikan true kalau member ini BARU pertama kali disambut.
 */
const WELCOMED_DIR = path.join(__dirname, '..', 'data', 'welcomed');
function claimFirstWelcome(guildId, userId) {
  fs.mkdirSync(WELCOMED_DIR, { recursive: true });
  try {
    fs.writeFileSync(path.join(WELCOMED_DIR, `${guildId}-${userId}`), String(Date.now()), { flag: 'wx' });
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  }
}

const REGISTERED = Symbol('welcomeRegistered');
const recentJoins = new Map(); // "<guild>:<user>" → waktu terakhir diproses

/**
 * Pasang listener member join — CUKUP DIPANGGIL SEKALI saat bot menyala (di index.js, di luar event lain).
 * Kalau terpanggil berkali-kali, panggilan berikutnya diabaikan supaya welcome tidak terkirim dobel.
 */
function registerWelcome(client) {
  if (client[REGISTERED]) {
    console.warn(
      '[welcome] registerWelcome() dipanggil lebih dari sekali — diabaikan. ' +
        'Pindahkan pemanggilannya ke luar event (lihat stack di bawah):\n' + new Error().stack,
    );
    return;
  }
  client[REGISTERED] = true;

  client.on('guildMemberAdd', async (member) => {
    // Pengaman tambahan: event join yang sama dalam 10 detik hanya diproses 1x.
    const key = `${member.guild.id}:${member.id}`;
    const last = recentJoins.get(key) || 0;
    if (Date.now() - last < 10_000) return;
    recentJoins.set(key, Date.now());
    if (recentJoins.size > 5000) recentJoins.clear();

    if (member.user.bot) return;
    const cfg = loadConfig();
    const onlyOnce = cfg?.onlyOnce !== false; // default: 1x per akun

    if (onlyOnce && !claimFirstWelcome(member.guild.id, member.id)) {
      console.log(`[welcome] ${member.user.tag} join lagi → sudah pernah disambut, dilewati.`);
      return;
    }

    try {
      const res = await sendWelcome(member);
      if (!res.ok) console.warn(`[welcome] ${member.user.tag}: ${res.reason}`);
    } catch (err) {
      console.error(`[welcome] gagal kirim welcome untuk ${member.user.tag}:`, err.message);
    }
  });
}

module.exports = { registerWelcome, sendWelcome, buildWelcomeMessage, loadConfig };
