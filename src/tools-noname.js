const QRCode = require('qrcode');
const {
  MessageFlags,
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  ModalBuilder,
  LabelBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  AttachmentBuilder,
} = require('discord.js');
const UI = require('./ui');

/**
 * ⚙️ Tools Noname — kumpulan alat kecil di Bot Command Center (hasil hanya terlihat oleh pemakai).
 * Tools: 🔳 Link → QR Code.
 * Tambah tool baru: tambahkan item di TOOLS + handler di handle().
 */
const V2 = MessageFlags.IsComponentsV2;
const EPH = MessageFlags.Ephemeral;
const BRAND = 0x3498db;
const text = (c) => new TextDisplayBuilder().setContent(String(c).slice(0, 4000));
const line = () => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);

const TOOLS = [
  { id: 'qr', emoji: '🔳', title: 'Link → QR Code', desc: 'Ubah link / teks jadi gambar QR Code siap scan & download.', button: 'Buat QR' },
];

/** Menu tools (pesan pribadi). */
function buildMenu(guild) {
  const box = UI.accent(new ContainerBuilder(), BRAND);
  box.addTextDisplayComponents(text(`# ⚙️ Tools Noname\n-# ${guild?.name || 'Noname'} • Alat bantu gratis untuk member`));
  box.addSeparatorComponents(line());
  for (const t of TOOLS) {
    box.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(text(`### ${t.emoji} ${t.title}\n${t.desc}`))
        .setButtonAccessory(new ButtonBuilder().setCustomId(`bp:t:${t.id}`).setLabel(t.button).setEmoji(t.emoji).setStyle(ButtonStyle.Primary)),
    );
  }
  box.addSeparatorComponents(line());
  box.addTextDisplayComponents(text('-# 🔒 Hasil tools hanya terlihat olehmu • Tools lain segera hadir ✨'));
  return { components: [box], flags: V2 | EPH };
}

// ───────────────────────── 🔳 QR Code ─────────────────────────
const COLORS = {
  black: { label: 'Hitam Klasik', emoji: '⚫', dark: '#000000' },
  blue: { label: 'Biru Noname', emoji: '🔵', dark: '#1D4ED8' },
  purple: { label: 'Ungu', emoji: '🟣', dark: '#6D28D9' },
  green: { label: 'Hijau', emoji: '🟢', dark: '#047857' },
};

function qrModal() {
  return new ModalBuilder()
    .setCustomId('bp:m:qr')
    .setTitle('🔳 Link → QR Code')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('Link / Teks')
        .setDescription('Contoh: https://noname.store atau discord.gg/abcd (tanpa https juga bisa).')
        .setTextInputComponent(new TextInputBuilder().setCustomId('link').setStyle(TextInputStyle.Paragraph).setPlaceholder('https://...').setMinLength(1).setMaxLength(1000).setRequired(true)),
      new LabelBuilder()
        .setLabel('Judul (opsional)')
        .setDescription('Keterangan untuk QR ini, misal "Link Store" atau "Grup WA".')
        .setTextInputComponent(new TextInputBuilder().setCustomId('title').setStyle(TextInputStyle.Short).setMaxLength(60).setRequired(false)),
      new LabelBuilder()
        .setLabel('Warna QR')
        .setStringSelectMenuComponent(
          new StringSelectMenuBuilder()
            .setCustomId('color')
            .setRequired(true)
            .addOptions(Object.entries(COLORS).map(([value, c], i) => ({ label: c.label, value, emoji: c.emoji, default: i === 0 }))),
        ),
    );
}

/** Link tanpa skema (misal "discord.gg/abc") → tambahkan https:// supaya bisa langsung dibuka saat di-scan. */
function normalize(raw) {
  const s = String(raw || '').trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s; // sudah ada skema (https:, mailto:, tel:, ...)
  if (/^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+([/?#].*)?$/i.test(s) && !/\s/.test(s)) return `https://${s}`;
  return s; // teks biasa
}

const cooldown = new Map();
async function onQrSubmit(i) {
  const last = cooldown.get(i.user.id) || 0;
  if (Date.now() - last < 5000) return i.reply({ content: '⏳ Tunggu beberapa detik sebelum membuat QR lagi.', flags: EPH });
  cooldown.set(i.user.id, Date.now());
  await i.deferReply({ flags: EPH });
  const value = normalize(i.fields.getTextInputValue('link'));
  let title = '';
  try {
    title = (i.fields.getTextInputValue('title') || '').trim();
  } catch {}
  let colorId = 'black';
  try {
    colorId = i.fields.getStringSelectValues('color')?.[0] || 'black';
  } catch {}
  const color = COLORS[colorId] || COLORS.black;
  let png;
  try {
    png = await QRCode.toBuffer(value, { type: 'png', width: 1024, margin: 3, errorCorrectionLevel: value.length > 300 ? 'L' : 'M', color: { dark: color.dark, light: '#FFFFFF' } });
  } catch (e) {
    return i.editReply({ content: `❌ QR gagal dibuat: ${e.message.includes('too big') ? 'teks terlalu panjang' : e.message}` });
  }
  const name = `qrcode-${Date.now().toString(36)}.png`;
  const isUrl = /^https?:\/\/\S+$/i.test(value);
  const box = UI.accent(new ContainerBuilder(), BRAND);
  box.addTextDisplayComponents(text(`## 🔳 QR Code Siap!\n-# ${title ? `${title} • ` : ''}Scan pakai kamera HP / Google Lens`));
  box.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(`attachment://${name}`).setDescription(title || 'QR Code')));
  box.addSeparatorComponents(line());
  box.addTextDisplayComponents(
    text(
      [
        `${isUrl ? '🔗 **Link:**' : '📝 **Isi:**'} ${isUrl ? value : `\`${value.slice(0, 300).replace(/`/g, 'ˋ')}\``}`,
        `🎨 **Warna:** ${color.emoji} ${color.label} • 📐 **Ukuran:** \`1024 × 1024 px\``,
        '-# 💾 Klik gambar → **Simpan / Download** untuk menyimpan QR. Hasil hanya terlihat olehmu.',
      ].join('\n'),
    ),
  );
  const buttons = [];
  if (isUrl) buttons.push(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(value.slice(0, 512)).setLabel('Buka Link').setEmoji('🔗'));
  buttons.push(new ButtonBuilder().setCustomId('bp:t:qr').setLabel('Buat QR Lagi').setEmoji('🔳').setStyle(ButtonStyle.Secondary));
  box.addActionRowComponents(new ActionRowBuilder().addComponents(buttons));
  return i.editReply({ components: [box], files: [new AttachmentBuilder(png, { name })], flags: V2 });
}

/** Router tools. Return true kalau interaksi milik Tools Noname. */
async function handle(i) {
  const id = i.customId;
  if (id === 'bp:tools') {
    await i.reply(buildMenu(i.guild));
    return true;
  }
  if (id === 'bp:t:qr' && i.isButton()) {
    await i.showModal(qrModal());
    return true;
  }
  if (id === 'bp:m:qr' && i.isModalSubmit()) {
    await onQrSubmit(i);
    return true;
  }
  return false;
}

module.exports = { handle, buildMenu, normalize };
