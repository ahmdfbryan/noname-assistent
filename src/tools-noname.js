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
const F = require('./tools-files');

/**
 * ⚙️ Tools Noname — kumpulan alat kecil di Bot Command Center (hasil hanya terlihat oleh pemakai).
 * Tools: 📄 Dokumen & PDF, 🖼️ Gambar (tools-files.js) + 🔳 Link → QR Code.
 */
const V2 = MessageFlags.IsComponentsV2;
const EPH = MessageFlags.Ephemeral;
const BRAND = 0x3498db;
const text = (c) => new TextDisplayBuilder().setContent(String(c).slice(0, 4000));
const line = () => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);

const row = (...b) => new ActionRowBuilder().addComponents(b);
const toolBtn = (id, t) =>
  new ButtonBuilder()
    .setCustomId(`bp:t:${id}`)
    .setLabel(F.ready(id) ? t.short : `${t.short} (segera)`)
    .setEmoji(t.emoji)
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(!F.ready(id));

/** Menu tools (pesan pribadi): daftar tool + tombol, dikelompokkan Dokumen / Gambar / Lainnya. */
async function buildMenu(guild) {
  await F.detect();
  const box = UI.accent(new ContainerBuilder(), BRAND);
  const list = (ids) => ids.map((id) => `${F.TOOLS[id].emoji} **${F.TOOLS[id].title}** — ${F.TOOLS[id].desc}${F.ready(id) ? '' : ' `segera`'}`).join('\n');
  box.addTextDisplayComponents(text(`# ⚙️ Tools Noname\n-# ${guild?.name || 'Noname'} • Alat bantu gratis untuk member — hasil hanya terlihat olehmu 🔒`));
  box.addSeparatorComponents(line());
  box.addTextDisplayComponents(text(`### 📄 Dokumen & PDF\n${list(F.DOC_TOOLS)}`));
  box.addActionRowComponents(row(...F.DOC_TOOLS.slice(0, 3).map((id) => toolBtn(id, F.TOOLS[id]))), row(...F.DOC_TOOLS.slice(3, 6).map((id) => toolBtn(id, F.TOOLS[id]))));
  box.addSeparatorComponents(line());
  box.addTextDisplayComponents(text(`### 🖼️ Gambar & Lainnya\n${list(F.IMG_TOOLS)}\n🔳 **Link → QR Code** — Ubah link / teks jadi QR Code siap scan`));
  box.addActionRowComponents(
    row(
      ...F.IMG_TOOLS.map((id) => toolBtn(id, F.TOOLS[id])),
      new ButtonBuilder().setCustomId('bp:t:qr').setLabel('Link → QR').setEmoji('🔳').setStyle(ButtonStyle.Secondary),
    ),
  );
  box.addSeparatorComponents(line());
  box.addTextDisplayComponents(text('-# 📎 Klik tool → upload file di form → hasil langsung dikirim. File dihapus dari server setelah selesai.'));
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
    await i.reply(await buildMenu(i.guild));
    return true;
  }
  // 📄 Tools file
  const tm = id.match(/^bp:t:(\w+)$/);
  if (tm && F.TOOLS[tm[1]] && i.isButton()) {
    await F.detect();
    if (!F.ready(tm[1])) await i.reply({ content: '🔧 Tool ini belum tersedia di server.', flags: EPH });
    else await i.showModal(F.buildModal(tm[1]));
    return true;
  }
  const fm = id.match(/^bp:m:f:(\w+)$/);
  if (fm && i.isModalSubmit()) {
    await F.detect();
    await F.onSubmit(i, fm[1]);
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

module.exports = { handle, buildMenu, normalize, detect: F.detect };
