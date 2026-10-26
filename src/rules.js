const fs = require('fs');
const path = require('path');
const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  ChannelType,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  SectionBuilder,
  ThumbnailBuilder,
} = require('discord.js');

const FILE = path.join(__dirname, '..', 'rules.json');
const TRANSLATE_BUTTON = 'rules:en';
const SENT_FILE = path.join(__dirname, '..', 'data', 'rules-messages.json');

// Discord membatasi total teks 4000 karakter per pesan (Components V2) → sisakan ruang aman.
const MAX_CHARS_PER_MESSAGE = 3800;
const MAX_COMPONENTS_PER_MESSAGE = 35;
const NO_PINGS = { parse: [] }; // @everyone/@here di teks rules tidak mem-ping siapa pun

/** Dibaca ulang tiap dipakai → edit rules.json tidak perlu restart bot. */
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (err) {
    console.error('[rules] rules.json tidak bisa dibaca:', err.message);
    return null;
  }
}

function parseColor(value) {
  const n = parseInt(String(value || '').replace('#', ''), 16);
  return Number.isNaN(n) ? 0x5865f2 : n;
}

const divider = () => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
const td = (c) => new TextDisplayBuilder().setContent(String(c).slice(0, MAX_CHARS_PER_MESSAGE));

/** Ringkasan judul aturan otomatis dari baris "### `Aturan 1` 💬 Judul". */
function summaryText(sections, lang, cfg) {
  if (cfg.showSummary === false) return null;
  const items = [];
  for (const sec of sections || []) {
    for (const t of sec.texts || []) {
      const m = String(t).match(/^#{1,3}\s*`([^`]+)`\s*(.+)$/m);
      if (m) items.push(m[2].trim());
    }
  }
  if (items.length < 2) return null;
  const title = lang === 'en' ? cfg.summaryTitle?.en || '📑 Rules Summary' : cfg.summaryTitle?.id || '📑 Ringkasan Aturan';
  return `### ${title}\n${items.map((x, i) => `\`${String(i + 1).padStart(2, '0')}\` ${x}`).join('\n')}`;
}

/**
 * Ubah daftar section menjadi beberapa pesan (masing-masing ≤ batas Discord).
 * Satu section = satu kotak (garis tepi saja, tanpa warna di kiri — kecuali rules.json "showAccent": true),
 * tiap teks dipisah garis tipis sampai ujung.
 * Kotak pertama memakai logo server di kanan atas + ringkasan aturan; kotak terakhir berisi footer.
 */
function buildMessages(sections, { guild, lang, cfg }) {
  const messages = [];
  let current = null; // { containers: [], chars, count }
  const newMessage = () => {
    current = { containers: [], chars: 0, count: 0 };
    messages.push(current);
  };
  newMessage();
  const icon = guild?.iconURL?.({ extension: 'png', size: 256 }) || null;
  const summary = summaryText(sections, lang, cfg);
  let first = true;

  (sections || []).forEach((section, si) => {
    // Default tanpa warna aksen (hanya garis kotak). rules.json → "showAccent": true untuk memakai warna section lagi.
    const color = cfg.showAccent === true ? parseColor(section.color || cfg.color) : null;
    let box = null;
    const texts = [...(section.texts || [])];
    if (si === 0 && summary) texts.push(summary);

    for (const raw of texts) {
      const text = String(raw).slice(0, MAX_CHARS_PER_MESSAGE);
      const overflow = current.chars + text.length > MAX_CHARS_PER_MESSAGE || current.count + 4 > MAX_COMPONENTS_PER_MESSAGE;
      if (overflow && current.count > 0) {
        newMessage();
        box = null;
      }
      if (!box) {
        box = new ContainerBuilder();
        if (color != null) box.setAccentColor(color);
        current.containers.push(box);
        current.count += 1;
      } else {
        box.addSeparatorComponents(divider());
        current.count += 1;
      }
      if (first && icon && cfg.showIcon !== false) {
        box.addSectionComponents(new SectionBuilder().addTextDisplayComponents(td(text)).setThumbnailAccessory(new ThumbnailBuilder().setURL(icon)));
        current.count += 3;
      } else {
        box.addTextDisplayComponents(td(text));
        current.count += 1;
      }
      first = false;
      current.chars += text.length;
    }
  });
  return messages.filter((m) => m.containers.length);
}

function footerText(cfg, guild, lang) {
  const name = guild?.name || 'Noname Studios Creative';
  const raw = lang === 'en' ? cfg.footer?.en || '{server} • Community Guidelines' : cfg.footer?.id || '{server} • Community Guidelines';
  const label = lang === 'en' ? 'Last updated' : 'Terakhir diperbarui';
  return `-# 📜 ${String(raw).replace(/\{server\}/g, name)} • ${label} <t:${Math.floor(Date.now() / 1000)}:D>`;
}

function translateRow(cfg) {
  const b = cfg.translateButton || {};
  const button = new ButtonBuilder()
    .setCustomId(TRANSLATE_BUTTON)
    .setStyle(ButtonStyle.Secondary)
    .setLabel(b.label || 'Bahasa Inggris');
  if (b.emoji) button.setEmoji(b.emoji);
  return new ActionRowBuilder().addComponents(button);
}

/**
 * Banner (GIF / gambar) di paling atas rules.
 * rules.json → banner: path file di folder bot (contoh "assets/rules-banner.gif") atau link https.
 */
function bannerPart(cfg) {
  const src = String(cfg.banner || '').trim();
  if (!src) return null;
  if (/^https?:\/\//i.test(src)) {
    return { gallery: new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(src)), files: [] };
  }
  const file = path.join(__dirname, '..', src);
  if (!fs.existsSync(file)) {
    console.warn(`[rules] banner ${src} tidak ditemukan — rules dikirim tanpa banner.`);
    return null;
  }
  const name = `rules-banner${path.extname(file) || '.gif'}`;
  return {
    gallery: new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(`attachment://${name}`)),
    files: [{ attachment: file, name }],
  };
}

/**
 * Payload pesan untuk satu bahasa.
 * withButton → tombol terjemahan di pesan terakhir. withBanner → banner di atas pesan pertama.
 */
function buildPayloads(cfg, lang, { withButton = false, ephemeral = false, withBanner = false, guild = null } = {}) {
  const messages = buildMessages(cfg.languages?.[lang], { guild, lang, cfg });
  const banner = withBanner ? bannerPart(cfg) : null;
  return messages.map((m, i) => {
    const components = [...m.containers];
    if (i === messages.length - 1) {
      // Footer + tombol terjemahan di dalam kotak terakhir.
      const last = components.at(-1);
      last.addSeparatorComponents(divider()).addTextDisplayComponents(td(footerText(cfg, guild, lang)));
      if (withButton) last.addActionRowComponents(translateRow(cfg));
    }
    let flags = MessageFlags.IsComponentsV2;
    if (ephemeral) flags |= MessageFlags.Ephemeral;
    const payload = { components, flags, allowedMentions: NO_PINGS };
    if (banner && i === 0) {
      payload.components = [banner.gallery, ...components];
      payload.files = banner.files;
    }
    return payload;
  });
}

function loadSent() {
  try {
    return JSON.parse(fs.readFileSync(SENT_FILE, 'utf8'));
  } catch {
    return null;
  }
}
function saveSent(v) {
  fs.mkdirSync(path.dirname(SENT_FILE), { recursive: true });
  fs.writeFileSync(`${SENT_FILE}.tmp`, JSON.stringify(v, null, 2));
  fs.renameSync(`${SENT_FILE}.tmp`, SENT_FILE);
}

/** Tombol "Bahasa Inggris": tampilkan versi Inggris khusus untuk yang klik. */
async function handleTranslateButton(interaction) {
  const cfg = loadConfig();
  const payloads = cfg ? buildPayloads(cfg, 'en', { ephemeral: true, guild: interaction.guild }) : [];
  if (!payloads.length) {
    return interaction.reply({ content: '❌ English version is not available yet.', flags: MessageFlags.Ephemeral });
  }
  await interaction.reply(payloads[0]);
  for (const p of payloads.slice(1)) await interaction.followUp(p);
}

/** /rules [channel] → kirim rules versi Indonesia + tombol Bahasa Inggris. */
const rulesCommand = {
  data: new SlashCommandBuilder()
    .setName('rules')
    .setDescription('Kirim rules / community guidelines server')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addChannelOption((o) =>
      o
        .setName('channel')
        .setDescription('Channel tujuan (default: channel ini)')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
    ),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const cfg = loadConfig();
    if (!cfg) return interaction.editReply('❌ rules.json tidak bisa dibaca (cek format JSON-nya).');

    const channel = interaction.options.getChannel('channel') || interaction.channel;
    const perms = channel.permissionsFor(interaction.guild.members.me);
    if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
      return interaction.editReply(`❌ Bot tidak punya izin kirim pesan di ${channel}.`);
    }

    const payloads = buildPayloads(cfg, 'id', { withButton: true, withBanner: true, guild: interaction.guild });
    if (!payloads.length) return interaction.editReply('❌ Isi rules (languages.id) di rules.json masih kosong.');

    const ids = [];
    for (const p of payloads) ids.push((await channel.send(p)).id);
    // Hapus rules lama yang dikirim bot sebelumnya (supaya tidak dobel).
    const old = loadSent();
    let removed = 0;
    if (old?.messageIds?.length) {
      const oldCh = await interaction.guild.channels.fetch(old.channelId).catch(() => null);
      for (const id of old.messageIds) if (oldCh && (await oldCh.messages.delete(id).then(() => true).catch(() => false))) removed += 1;
    }
    saveSent({ channelId: channel.id, messageIds: ids });
    return interaction.editReply(`✅ Rules dikirim ke ${channel} (${payloads.length} pesan)${removed ? ` • ${removed} pesan rules lama dihapus` : ''}.`);
  },
};

module.exports = { rulesCommand, handleTranslateButton, TRANSLATE_BUTTON, buildPayloads, loadConfig };
