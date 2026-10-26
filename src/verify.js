const fs = require('fs');
const { fetchAllMembers } = require('./member-cache');
const path = require('path');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  ChannelType,
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
} = require('discord.js');

const FILE = path.join(__dirname, '..', 'verify.json');
const BUTTON_ID = 'verify:start';
const isId = (v) => /^\d{17,20}$/.test(String(v || ''));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Dibaca ulang tiap dipakai → edit verify.json tidak perlu restart bot. */
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (err) {
    console.error('[verify] verify.json tidak bisa dibaca:', err.message);
    return null;
  }
}

/** Lokasi panel terakhir (data/verify-panel.json) → panel lama dihapus saat kirim ulang. */
const PANEL_FILE = path.join(__dirname, '..', 'data', 'verify-panel.json');
function loadPanel() {
  try {
    return JSON.parse(fs.readFileSync(PANEL_FILE, 'utf8'));
  } catch {
    return null;
  }
}
function savePanel(v) {
  try {
    fs.mkdirSync(path.dirname(PANEL_FILE), { recursive: true });
    fs.writeFileSync(`${PANEL_FILE}.tmp`, JSON.stringify(v, null, 2));
    fs.renameSync(`${PANEL_FILE}.tmp`, PANEL_FILE);
  } catch (err) {
    console.warn('[verify] gagal simpan lokasi panel:', err.message);
  }
}

function parseColor(value) {
  const n = parseInt(String(value || '').replace('#', ''), 16);
  return Number.isNaN(n) ? 0xe53935 : n;
}

/** Cek role verifikasi valid & bisa diberikan bot. Mengembalikan { role } atau { error }. */
async function resolveRole(guild, cfg) {
  if (!isId(cfg?.roleId)) return { error: 'roleId di verify.json belum diisi.' };
  const role = await guild.roles.fetch(cfg.roleId).catch(() => null);
  if (!role) return { error: `Role ${cfg.roleId} tidak ditemukan di server ini.` };

  const me = guild.members.me;
  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return { error: 'Bot belum punya izin **Manage Roles**.' };
  }
  if (me.roles.highest.comparePositionTo(role) <= 0) {
    return { error: `Role bot harus berada **di atas** role ${role} (Server Settings → Roles, geser role bot ke atas).` };
  }
  return { role };
}

// ───────────────────────── Tampilan (Components V2) ─────────────────────────
const V2 = MessageFlags.IsComponentsV2;
const EPH = MessageFlags.Ephemeral;
const KEYCAPS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];
const text = (c) => new TextDisplayBuilder().setContent(String(c).slice(0, 4000));
const line = () => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
const ts = (ms, s = 'R') => `<t:${Math.floor(ms / 1000)}:${s}>`;
const num = (n) => Number(n || 0).toLocaleString('id-ID');

const DEFAULT_PERKS = [
  'Akses ke **seluruh channel** komunitas',
  'Role awal {role}',
  'Ikut **event, giveaway** & belanja di **store**',
];
const DEFAULT_STEPS = ['Klik tombol **Verify Sekarang** di bawah', 'Role diberikan **otomatis** dalam hitungan detik', 'Semua channel langsung **terbuka** — selamat bergabung! 🎉'];

/** Kotak V2 (garis kotak tanpa warna kiri): header (+ gambar kecil) → blok teks dipisah garis → banner → footer → tombol. */
function card({ color, header, thumb, blocks = [], image, footer, rows = [] }) {
  // Default tanpa warna aksen di kiri (hanya garis kotak). verify.json → "showAccent": true untuk memakai warna lagi.
  const box = new ContainerBuilder();
  if (loadConfig()?.showAccent === true && color != null) box.setAccentColor(color);
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
  return { components: [box], flags: V2, allowedMentions: { parse: [] } };
}

/**
 * Panel verifikasi utama (dikirim ke channel, dilihat semua orang).
 * Teks diatur di verify.json → panel (title, description, perks, steps, image, footer, button).
 */
function buildPanel(guild, cfg, { role = null } = {}) {
  const p = cfg.panel || {};
  const fillRole = (t) => String(t).replace(/\{role\}/g, role ? `${role}` : '**Member**');
  const perks = (p.perks || DEFAULT_PERKS).map((x) => `▸ ${fillRole(x)}`).join('\n');
  const steps = (p.steps || DEFAULT_STEPS).map((x, i) => `${KEYCAPS[i] || `\`${i + 1}\``} ${fillRole(x)}`).join('\n');
  const buttons = [
    new ButtonBuilder().setCustomId(BUTTON_ID).setStyle(ButtonStyle.Success).setLabel(p.button || 'Verify Sekarang').setEmoji('✅'),
  ];
  if (isId(cfg.rulesChannelId)) {
    buttons.push(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel(p.rulesButton || 'Baca Rules')
        .setEmoji('📜')
        .setURL(`https://discord.com/channels/${guild.id}/${cfg.rulesChannelId}`),
    );
  }
  return card({
    color: parseColor(cfg.color),
    thumb: guild.iconURL({ extension: 'png', size: 256 }),
    header: `# 🛡️ ${p.title || 'Verifikasi Diperlukan'}\n-# ${p.subtitle || `${guild.name} • Member Verification`}`,
    blocks: [
      fillRole(p.description || 'Klik tombol di bawah untuk verifikasi.'),
      `### 🔓 Yang Kamu Dapatkan\n${perks}`,
      `### 🧭 Cara Verifikasi\n${steps}`,
      p.note ? `-# ${fillRole(p.note)}` : null,
    ],
    image: p.image || null,
    footer: `🔐 ${p.footer || guild.name} • Verifikasi aman & otomatis`,
    rows: [new ActionRowBuilder().addComponents(buttons)],
  });
}

/** Kartu hijau untuk member yang baru / sudah terverifikasi (hanya terlihat olehnya). */
function buildVerified(guild, cfg, member, role, { already = false } = {}) {
  const v = cfg.verifiedPanel || {};
  const fillRole = (t) => String(t).replace(/\{role\}/g, `${role}`).replace(/\{user\}/g, `${member}`);
  const title = already ? v.alreadyTitle || '✅ Kamu Sudah Terverifikasi' : v.title || '✅ Verifikasi Berhasil';
  const desc = already
    ? v.alreadyDescription || 'Kamu sudah terverifikasi sebelumnya dan memiliki role {role}. Semua channel sudah terbuka untukmu!'
    : v.description || 'Kamu sudah terverifikasi dan mendapatkan role {role}. Semua channel sudah terbuka!';
  const info = [
    `👤 **Member:** ${member} • \`@${member.user.username}\``,
    `🎖️ **Role:** ${role}`,
    member.joinedTimestamp ? `📅 **Bergabung:** ${ts(member.joinedTimestamp, 'D')} (${ts(member.joinedTimestamp, 'R')})` : null,
    `🕒 **${already ? 'Dicek' : 'Diverifikasi'}:** ${ts(Date.now(), 'f')}`,
  ].filter(Boolean);
  const next = (v.next || []).map((x) => `▸ ${fillRole(x)}`).join('\n');
  return {
    ...card({
      color: parseColor(v.color || '#43B581'),
      thumb: member.displayAvatarURL({ extension: 'png', size: 256 }),
      header: `# ${title}\nSelamat datang, **${member.displayName}**! 💙`,
      blocks: [fillRole(desc), info.join('\n'), next ? `### 🚀 Langkah Selanjutnya\n${next}` : null],
      footer: `${cfg.panel?.footer || guild.name} • Member Verification`,
      rows: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(BUTTON_ID).setStyle(ButtonStyle.Success).setLabel(v.button || 'Terverifikasi').setEmoji('✅').setDisabled(true),
        ),
      ],
    }),
    allowedMentions: { parse: [] },
  };
}

/** Kartu merah kalau verifikasi gagal. */
function buildFailed(guild, cfg, message) {
  return card({
    color: 0xe74c3c,
    header: '## ❌ Verifikasi Gagal',
    blocks: [message || 'Verifikasi gagal diproses. Silakan hubungi admin.', '-# Coba lagi beberapa saat, atau buka ticket support bila masalah berlanjut.'],
    footer: `${cfg?.panel?.footer || guild.name} • Member Verification`,
  });
}

/** editReply V2; kalau gagal (mis. versi lama), kirim teks biasa. */
async function replyV2(interaction, payload, fallback) {
  try {
    return await interaction.editReply(payload);
  } catch (err) {
    console.warn('[verify] V2 reply gagal, pakai teks:', err.message);
    return interaction.editReply({ content: fallback }).catch(() => {});
  }
}

/** Saat member klik "Verify Sekarang". */
async function handleVerifyButton(interaction) {
  await interaction.deferReply({ flags: EPH });
  const cfg = loadConfig();
  const msg = cfg?.messages || {};
  const failText = String(msg.failed || '❌ Verifikasi gagal diproses. Silakan hubungi admin.').replace(/^❌\s*/, '');

  const { role, error } = await resolveRole(interaction.guild, cfg);
  if (error) {
    console.warn(`[verify] ${interaction.user.tag}: ${error}`);
    return replyV2(interaction, buildFailed(interaction.guild, cfg, failText), `❌ ${failText}`);
  }

  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (member.roles.cache.has(role.id)) {
    return replyV2(interaction, buildVerified(interaction.guild, cfg, member, role, { already: true }), msg.already || '✅ Kamu sudah terverifikasi.');
  }

  try {
    await member.roles.add(role, 'Verifikasi lewat tombol Verify Sekarang');
  } catch (err) {
    console.error(`[verify] gagal memberi role ke ${interaction.user.tag}:`, err.message);
    return replyV2(interaction, buildFailed(interaction.guild, cfg, failText), `❌ ${failText}`);
  }

  console.log(`[verify] ${interaction.user.tag} terverifikasi.`);
  return replyV2(interaction, buildVerified(interaction.guild, cfg, member, role), `✅ Verifikasi berhasil! Kamu mendapat role ${role}.`);
}

/** /verify kirim | beri-semua */
const verifyCommand = {
  data: new SlashCommandBuilder()
    .setName('verify')
    .setDescription('Sistem verifikasi member')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addSubcommand((s) =>
      s
        .setName('kirim')
        .setDescription('Kirim panel verifikasi (embed + tombol Verify Sekarang)')
        .addChannelOption((o) =>
          o
            .setName('channel')
            .setDescription('Channel tujuan (default: channel ini)')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('beri-semua')
        .setDescription('Beri role verifikasi ke SEMUA member lama (jalankan sekali sebelum channel dikunci)'),
    ),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const cfg = loadConfig();
    if (!cfg) return interaction.editReply('❌ verify.json tidak bisa dibaca (cek format JSON-nya).');

    const { role, error } = await resolveRole(interaction.guild, cfg);
    if (error) return interaction.editReply(`❌ ${error}`);

    const sub = interaction.options.getSubcommand();

    if (sub === 'kirim') {
      const channel = interaction.options.getChannel('channel') || interaction.channel;
      const perms = channel.permissionsFor(interaction.guild.members.me);
      if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
        return interaction.editReply(`❌ Bot butuh izin View Channel dan Send Messages di ${channel}.`);
      }
      const sent = await channel.send(buildPanel(interaction.guild, cfg, { role }));
      // Hapus panel lama (supaya tidak dobel), lalu simpan lokasi panel baru.
      const last = loadPanel();
      let removed = false;
      if (last?.messageId && last.messageId !== sent.id) {
        const oldCh = await interaction.guild.channels.fetch(last.channelId).catch(() => null);
        const old = oldCh ? await oldCh.messages.fetch(last.messageId).catch(() => null) : null;
        if (old) removed = await old.delete().then(() => true).catch(() => false);
      }
      savePanel({ channelId: channel.id, messageId: sent.id });
      return interaction.editReply(
        `✅ Panel verifikasi dikirim ke ${channel}${removed ? ' (panel lama dihapus)' : ''}. Member yang klik tombolnya akan mendapat role ${role}.`,
      );
    }

    if (sub === 'beri-semua') {
      await fetchAllMembers(interaction.guild);
      const members = interaction.guild.members.cache;
      const targets = members.filter((m) => !m.user.bot && !m.roles.cache.has(role.id));
      if (!targets.size) return interaction.editReply(`Semua member sudah punya role ${role}.`);

      await interaction.editReply(`⏳ Memberi role ${role} ke ${targets.size} member lama...`);
      let done = 0;
      let failed = 0;
      for (const m of targets.values()) {
        try {
          await m.roles.add(role, 'Member lama — diberi role verifikasi otomatis');
          done++;
        } catch {
          failed++;
        }
        if ((done + failed) % 25 === 0) {
          await interaction.editReply(`⏳ Proses ${done + failed}/${targets.size} member...`).catch(() => {});
        }
        await sleep(300); // jaga-jaga rate limit Discord
      }
      return interaction
        .editReply(`✅ Selesai: ${done} member lama mendapat role ${role}.` + (failed ? ` ⚠️ ${failed} gagal.` : ''))
        .catch(() => {});
    }
  },
};

module.exports = { verifyCommand, handleVerifyButton, BUTTON_ID, buildPanel, buildVerified };
