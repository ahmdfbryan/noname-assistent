const fs = require('fs');
const path = require('path');
const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  MessageFlags,
  ModalBuilder,
  LabelBuilder,
  TextInputBuilder,
  TextInputStyle,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  FileBuilder,
  FileUploadBuilder,
  ChannelSelectMenuBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const UI = require('./ui');

/**
 * /pesan — bot mengirim, mengedit & menghapus pesan atas nama admin (lewat form).
 *   /pesan kirim [gaya] [mention] [balas]                      → form: channel tujuan, judul, isi, upload gambar, tombol link
 *   /pesan edit link:<link pesan bot>                          → form terisi isi lama
 *   /pesan hapus link:<link pesan bot>
 * Gaya: ✨ Premium (Components V2: judul, isi, gambar, tombol) atau 💬 Biasa (teks biasa).
 * Pesan hasil /pesan kirim disimpan di data/pesan.json supaya bisa diedit lagi dengan form yang sama.
 * Pemakai: Manage Server / Administrator + role di prefix.json → allowedRoleIds (sama dengan !say).
 */
const V2 = MessageFlags.IsComponentsV2;
const EPH = MessageFlags.Ephemeral;
const DATA = path.join(__dirname, '..', 'data', 'pesan.json');
const PREFIX_CFG = path.join(__dirname, '..', 'prefix.json');
const MAX_BODY = { premium: 3500, plain: 1900 };
const MAX_BUTTONS = 5;
const PENDING_TTL = 15 * 60 * 1000;
const pending = new Map(); // token → data form yang sedang diisi

// ───── Penyimpanan ─────
let records = (() => {
  try {
    return JSON.parse(fs.readFileSync(DATA, 'utf8'));
  } catch {
    return {};
  }
})();
function saveRecords() {
  fs.mkdirSync(path.dirname(DATA), { recursive: true });
  fs.writeFileSync(`${DATA}.tmp`, JSON.stringify(records));
  fs.renameSync(`${DATA}.tmp`, DATA);
}

// ───── Izin ─────
function canUse(member) {
  if (!member) return false;
  if (member.permissions.has(PermissionFlagsBits.Administrator) || member.permissions.has(PermissionFlagsBits.ManageGuild)) return true;
  let ids = [];
  try {
    ids = JSON.parse(fs.readFileSync(PREFIX_CFG, 'utf8')).allowedRoleIds || [];
  } catch {}
  return ids.some((id) => member.roles.cache.has(id));
}

// ───── Util ─────
const isHttps = (u) => /^https:\/\/\S+$/i.test(String(u || '').trim());
const text = (c) => new TextDisplayBuilder().setContent(String(c).slice(0, 4000));
const line = () => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
const reply = (i, content) => (i.deferred || i.replied ? i.editReply({ content }) : i.reply({ content, flags: EPH }));

/** "Label | https://link" per baris → [{label,url}] atau { error } */
function parseButtons(raw) {
  const out = [];
  for (const ln of String(raw || '').split('\n')) {
    const t = ln.trim();
    if (!t) continue;
    const idx = t.lastIndexOf('|');
    const label = (idx > 0 ? t.slice(0, idx) : '').trim();
    const url = (idx > 0 ? t.slice(idx + 1) : t).trim();
    if (!isHttps(url)) return { error: `Link tombol harus diawali https:// → \`${t.slice(0, 60)}\`` };
    out.push({ label: (label || 'Buka Link').slice(0, 80), url });
  }
  if (out.length > MAX_BUTTONS) return { error: `Maksimal ${MAX_BUTTONS} tombol.` };
  return out;
}
const buttonRow = (buttons) =>
  buttons?.length
    ? new ActionRowBuilder().addComponents(buttons.map((b) => new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(b.label).setURL(b.url)))
    : null;

/** Susun payload pesan dari data (gaya premium = Components V2, gaya biasa = teks). */
function buildPayload(e, mentionParse) {
  const allowedMentions = mentionParse;
  const rows = [buttonRow(e.buttons)].filter(Boolean);
  if (e.style === 'plain') {
    const content = [e.title ? `**${e.title}**` : '', e.body, e.image && !e.image.startsWith('attachment://') ? e.image : ''].filter(Boolean).join('\n').slice(0, 2000);
    return { content: content || undefined, components: rows, allowedMentions };
  }
  const box = UI.accent(new ContainerBuilder(), 0x5865f2);
  if (e.title) box.addTextDisplayComponents(text(`## ${e.title}`)).addSeparatorComponents(line());
  box.addTextDisplayComponents(text(e.body));
  if (e.image) box.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(e.image)));
  if (e.file) box.addFileComponents(new FileBuilder().setURL(`attachment://${e.file}`));
  if (rows.length) box.addSeparatorComponents(line()).addActionRowComponents(rows[0]);
  const top = [];
  if (e.roleId) top.push(text(`<@&${e.roleId}>`));
  return { components: [...top, box], flags: V2, allowedMentions };
}

function mentionsFor(body, member) {
  const canEveryone = member.permissions.has(PermissionFlagsBits.MentionEveryone);
  const parse = ['users', 'roles'];
  if (canEveryone && /@(everyone|here)/.test(body)) parse.push('everyone');
  return { parse };
}

// ───── Form ─────
function input(id, label, { desc, style = TextInputStyle.Short, value, required = false, max, placeholder } = {}) {
  const t = new TextInputBuilder().setCustomId(id).setStyle(style).setRequired(required);
  if (max) t.setMaxLength(max);
  if (placeholder) t.setPlaceholder(placeholder.slice(0, 100));
  if (value) t.setValue(String(value).slice(0, max || 4000));
  const l = new LabelBuilder().setLabel(label.slice(0, 45)).setTextInputComponent(t);
  if (desc) l.setDescription(desc.slice(0, 100));
  return l;
}
const SEND_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.PublicThread, ChannelType.PrivateThread];
function formModal(customId, title, style, v = {}) {
  const sending = !v.editing;
  const channelPick = new LabelBuilder()
    .setLabel('Kirim ke channel')
    .setDescription('Kosongkan = channel tempat kamu mengetik command.')
    .setChannelSelectMenuComponent(
      new ChannelSelectMenuBuilder().setCustomId('tujuan').setChannelTypes(...SEND_TYPES).setMinValues(0).setMaxValues(1).setRequired(false).setPlaceholder('Pilih channel tujuan...'),
    );
  const filePick = new LabelBuilder()
    .setLabel('Gambar / file (opsional)')
    .setDescription('Unggah langsung dari perangkatmu.')
    .setFileUploadComponent(new FileUploadBuilder().setCustomId('berkas').setMinValues(0).setMaxValues(1).setRequired(false));
  const imageLink = input('gambar', 'Link gambar (opsional)', {
    max: 400,
    value: v.imageUrl,
    desc: 'Kosong = tetap • ketik "hapus" = buang gambar • link baru = ganti.',
    placeholder: 'https://...',
  });
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title.slice(0, 45))
    .addLabelComponents(
      ...(sending ? [channelPick] : []),
      input('judul', 'Judul (opsional)', { max: 100, value: v.title, placeholder: 'Contoh: 📢 Pengumuman' }),
      input('isi', 'Isi pesan', {
        style: TextInputStyle.Paragraph,
        required: true,
        max: MAX_BODY[style],
        value: v.body,
        desc: style === 'premium' ? 'Mendukung **tebal**, *miring*, emoji, mention, dan baris baru.' : 'Teks biasa. Mendukung markdown Discord & mention.',
      }),
      sending ? filePick : imageLink,
      input('tombol', 'Tombol link (opsional)', {
        style: TextInputStyle.Paragraph,
        max: 600,
        value: v.buttonsRaw,
        desc: `Satu per baris: Label | https://link (maks ${MAX_BUTTONS}).`,
        placeholder: 'Daftar Sekarang | https://contoh.com',
      }),
    );
}
const newToken = () => Math.random().toString(36).slice(2, 10);
function gc() {
  const now = Date.now();
  for (const [k, v] of pending) if (v.expires < now) pending.delete(k);
}

// ───── Util pesan ─────
const parseLink = (s) => {
  const m = String(s || '').match(/channels\/(\d+)\/(\d+)\/(\d+)/);
  return m ? { guildId: m[1], channelId: m[2], messageId: m[3] } : null;
};
async function fetchBotMessage(i, link) {
  const ref = parseLink(link);
  if (!ref || ref.guildId !== i.guildId) return { error: 'Link pesan tidak valid. Salin lewat klik kanan pesan → **Salin Link Pesan**.' };
  const ch = await i.guild.channels.fetch(ref.channelId).catch(() => null);
  const msg = await ch?.messages?.fetch(ref.messageId).catch(() => null);
  if (!msg) return { error: 'Pesan tidak ditemukan (mungkin sudah dihapus, atau bot tidak bisa melihat channelnya).' };
  if (msg.author.id !== i.client.user.id) return { error: 'Hanya pesan yang dikirim **bot** yang bisa diubah / dihapus.' };
  return { msg, ch };
}
const imageExt = (a) => (path.extname(String(a.name || '')) || '.png').toLowerCase();

// ───── Command ─────
const pesanCommand = {
  data: new SlashCommandBuilder()
    .setName('pesan')
    .setDescription('Kirim, edit & hapus pesan lewat bot (tampilan premium / biasa)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addSubcommand((s) =>
      s
        .setName('kirim')
        .setDescription('Kirim pesan baru lewat bot (isi lewat form)')
        .addStringOption((o) =>
          o
            .setName('gaya')
            .setDescription('Tampilan pesan (default: Premium)')
            .addChoices({ name: '✨ Premium (judul, isi, gambar, tombol)', value: 'premium' }, { name: '💬 Biasa (teks)', value: 'plain' }),
        )
        .addRoleOption((o) => o.setName('mention').setDescription('Role yang di-mention di atas pesan'))
        .addStringOption((o) => o.setName('balas').setDescription('Link pesan yang mau dibalas (bot membalas pesan itu)')),
    )
    .addSubcommand((s) =>
      s
        .setName('edit')
        .setDescription('Edit pesan yang dikirim bot')
        .addStringOption((o) => o.setName('link').setDescription('Link pesan bot (klik kanan pesan → Salin Link Pesan)').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('hapus')
        .setDescription('Hapus pesan yang dikirim bot')
        .addStringOption((o) => o.setName('link').setDescription('Link pesan bot').setRequired(true)),
    ),

  async execute(interaction) {
    if (!canUse(interaction.member)) return reply(interaction, '❌ Fitur ini hanya untuk admin.');
    const sub = interaction.options.getSubcommand();
    gc();

    if (sub === 'kirim') {
      const style = interaction.options.getString('gaya') || 'premium';
      const role = interaction.options.getRole('mention');
      const replyLink = interaction.options.getString('balas');
      if (replyLink && !parseLink(replyLink)) return reply(interaction, '❌ Link pesan untuk dibalas tidak valid.');
      const token = newToken();
      pending.set(token, { kind: 'kirim', userId: interaction.user.id, style, channelId: interaction.channelId, roleId: role?.id || null, replyLink, expires: Date.now() + PENDING_TTL });
      return interaction.showModal(formModal(`pesan:m:kirim:${token}`, style === 'premium' ? '✨ Pesan Premium' : '💬 Pesan Biasa', style));
    }

    // edit / hapus
    const found = await fetchBotMessage(interaction, interaction.options.getString('link'));
    if (found.error) return reply(interaction, `❌ ${found.error}`);
    const { msg } = found;

    if (sub === 'hapus') {
      await msg.delete().catch(() => null);
      delete records[msg.id];
      saveRecords();
      console.log(`[pesan] ${interaction.user.tag} menghapus pesan bot ${msg.id}`);
      return reply(interaction, '🗑️ Pesan bot sudah dihapus.');
    }

    // edit
    const rec = records[msg.id];
    const isV2 = msg.flags?.has?.(MessageFlags.IsComponentsV2);
    if (!rec && isV2) return reply(interaction, '❌ Pesan ini panel / pesan sistem bot, bukan hasil `/pesan kirim`, jadi tidak bisa diedit dari sini.');
    const style = rec?.style || 'plain';
    const entry = rec || { style: 'plain', title: '', body: msg.content || '', image: '', buttons: [] };
    const token = newToken();
    pending.set(token, { kind: 'edit', userId: interaction.user.id, msgId: msg.id, channelId: msg.channelId, style, expires: Date.now() + PENDING_TTL });
    return interaction.showModal(
      formModal(`pesan:m:edit:${token}`, '✏️ Edit Pesan Bot', style, {
        title: entry.title,
        body: entry.body,
        imageUrl: entry.image && !entry.image.startsWith('attachment://') ? entry.image : '',
        buttonsRaw: (entry.buttons || []).map((b) => `${b.label} | ${b.url}`).join('\n'),
        editing: true,
      }),
    );
  },
};

// ───── Form masuk ─────
async function submitKirim(i, token, p) {
  const f = (k) => (i.fields.getTextInputValue(k) || '').trim();
  const body = f('isi');
  if (!body) return reply(i, '❌ Isi pesan tidak boleh kosong.');
  const buttons = parseButtons(f('tombol'));
  if (buttons.error) return reply(i, `❌ ${buttons.error}`);
  await i.deferReply({ flags: EPH });

  const picked = i.fields.getSelectedChannels('tujuan', false)?.first();
  const target = await i.guild.channels.fetch(picked?.id || p.channelId).catch(() => null);
  if (!target) return i.editReply({ content: '❌ Channel tujuan tidak ditemukan.' });
  const perms = target.permissionsFor(i.guild.members.me);
  if (!perms?.has(PermissionFlagsBits.ViewChannel) || !perms.has(PermissionFlagsBits.SendMessages)) return i.editReply({ content: `❌ Bot tidak punya izin kirim pesan di ${target}.` });
  p.att = i.fields.getUploadedFiles('berkas', false)?.first() || null;
  if (p.att && !perms.has(PermissionFlagsBits.AttachFiles)) return i.editReply({ content: `❌ Bot tidak punya izin **Attach Files** di ${target}.` });
  const e = { style: p.style, title: f('judul'), body, image: '', buttons, roleId: p.roleId };
  const files = [];
  if (p.att) {
    const name = `pesan-${Date.now().toString(36)}${imageExt(p.att)}`;
    files.push({ attachment: p.att.url, name, description: p.att.description || undefined });
    if (p.style === 'premium') {
      if ((p.att.contentType || '').startsWith('image/')) e.image = `attachment://${name}`;
      else e.file = name;
    }
  }
  const payload = { ...buildPayload(e, mentionsFor(body, i.member)), files };
  if (p.style === 'plain' && p.roleId) payload.content = `<@&${p.roleId}>\n${payload.content || ''}`.slice(0, 2000);

  let sent;
  try {
    const ref = p.replyLink ? parseLink(p.replyLink) : null;
    if (ref) {
      const rch = await i.guild.channels.fetch(ref.channelId).catch(() => null);
      const rmsg = await rch?.messages?.fetch(ref.messageId).catch(() => null);
      if (!rmsg) return i.editReply({ content: '❌ Pesan yang mau dibalas tidak ditemukan.' });
      sent = await rmsg.reply({ ...payload, allowedMentions: { ...payload.allowedMentions, repliedUser: true } });
    } else {
      sent = await target.send(payload);
    }
  } catch (err) {
    console.error('[pesan] gagal kirim:', err.message);
    return i.editReply({ content: `❌ Gagal mengirim: ${err.message}` });
  }
  records[sent.id] = { ...e, file: e.file || null, by: i.user.id, at: Date.now(), channelId: sent.channelId, uploaded: Boolean(files.length) };
  saveRecords();
  pending.delete(token);
  console.log(`[pesan] ${i.user.tag} mengirim pesan ${p.style} ke #${target.name || target.id}`);
  return i.editReply({
    content: `✅ Pesan terkirim ke ${target}.\n-# Edit lagi kapan saja dengan \`/pesan edit\` (salin link pesannya).`,
    components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Lihat Pesan').setEmoji('📨').setURL(sent.url))],
  });
}

async function submitEdit(i, token, p) {
  const f = (k) => (i.fields.getTextInputValue(k) || '').trim();
  const body = f('isi');
  if (!body) return reply(i, '❌ Isi pesan tidak boleh kosong.');
  const buttons = parseButtons(f('tombol'));
  if (buttons.error) return reply(i, `❌ ${buttons.error}`);
  const imgInput = f('gambar');
  if (imgInput && imgInput.toLowerCase() !== 'hapus' && !isHttps(imgInput)) return reply(i, '❌ Link gambar harus diawali https:// (atau ketik "hapus").');
  await i.deferReply({ flags: EPH });

  const ch = await i.guild.channels.fetch(p.channelId).catch(() => null);
  const msg = await ch?.messages?.fetch(p.msgId).catch(() => null);
  if (!msg) return i.editReply({ content: '❌ Pesan tidak ditemukan lagi.' });
  const rec = records[p.msgId] || { style: 'plain', title: '', body: '', image: '', buttons: [] };
  const e = { ...rec, style: p.style, title: f('judul'), body, buttons };
  const payload = {};
  let dropAttachments = false;
  if (imgInput.toLowerCase() === 'hapus') {
    e.image = '';
    e.file = null;
    dropAttachments = true;
  } else if (imgInput) {
    e.image = imgInput;
    e.file = null;
    dropAttachments = true;
  } // kosong → gambar / lampiran lama dipertahankan

  Object.assign(payload, buildPayload(e, mentionsFor(body, i.member)));
  if (p.style === 'plain') {
    payload.content = payload.content || '';
    if (e.roleId) payload.content = `<@&${e.roleId}>\n${payload.content}`.slice(0, 2000);
  }
  if (dropAttachments) payload.attachments = [];
  try {
    await msg.edit(payload);
  } catch (err) {
    console.error('[pesan] gagal edit:', err.message);
    return i.editReply({ content: `❌ Gagal mengedit: ${err.message}` });
  }
  records[msg.id] = { ...e, by: rec.by || i.user.id, at: rec.at || Date.now(), channelId: msg.channelId, editedBy: i.user.id, editedAt: Date.now() };
  saveRecords();
  pending.delete(token);
  console.log(`[pesan] ${i.user.tag} mengedit pesan bot ${msg.id}`);
  return i.editReply({
    content: '✅ Pesan sudah diedit.',
    components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Lihat Pesan').setEmoji('📨').setURL(msg.url))],
  });
}

async function handleInteraction(i) {
  if (!i.isModalSubmit() || !String(i.customId).startsWith('pesan:m:')) return false;
  const [, , kind, token] = i.customId.split(':');
  const p = pending.get(token);
  if (!p || p.kind !== kind || p.userId !== i.user.id) {
    await i.reply({ content: '⌛ Form sudah kedaluwarsa. Jalankan `/pesan` lagi.', flags: EPH }).catch(() => {});
    return true;
  }
  if (!canUse(i.member)) {
    await i.reply({ content: '❌ Fitur ini hanya untuk admin.', flags: EPH }).catch(() => {});
    return true;
  }
  try {
    if (kind === 'kirim') await submitKirim(i, token, p);
    else await submitEdit(i, token, p);
  } catch (err) {
    console.error('[pesan] error:', err);
    await reply(i, `❌ Terjadi kesalahan: ${err.message}`).catch(() => {});
  }
  return true;
}

module.exports = { pesanCommand, handleInteraction };
