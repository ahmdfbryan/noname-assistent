const fs = require('fs');
const path = require('path');
const { Events, PermissionFlagsBits, ChannelType } = require('discord.js');

/**
 * Prefix command (khusus admin) — bot yang mengirim pesan, bukan akun admin.
 *   !say <pesan>                → kirim pesan di channel ini (pesan admin otomatis dihapus)
 *   !say #channel <pesan>       → kirim pesan ke channel lain
 *   !edit <link / ID pesan> <pesan baru> → edit pesan yang sebelumnya dikirim bot
 *   !reply <link / ID pesan> <pesan>     → bot membalas (reply) pesan tertentu
 * Lampiran (gambar / file) di pesan admin ikut dikirim ulang oleh bot.
 * Mendukung markdown Discord, emoji, mention, @everyone / @here, dan pesan multi-baris.
 * Butuh "Message Content Intent" aktif di Discord Developer Portal.
 */
const FILE = path.join(__dirname, '..', 'prefix.json');
const DEFAULT = { prefix: '!', allowedRoleIds: [], deleteCommand: true };
function loadConfig() {
  try {
    return { ...DEFAULT, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
  } catch {
    return DEFAULT;
  }
}
const isId = (v) => /^\d{17,20}$/.test(String(v || ''));

function allowed(member, cfg) {
  if (!member) return false;
  if (member.permissions.has(PermissionFlagsBits.Administrator) || member.permissions.has(PermissionFlagsBits.ManageGuild)) return true;
  return (cfg.allowedRoleIds || []).some((id) => member.roles.cache.has(id));
}

/** Pesan peringatan singkat yang hilang sendiri. */
async function warn(msg, text) {
  const m = await msg.channel.send({ content: `⚠️ ${text}`, allowedMentions: { parse: [] } }).catch(() => null);
  if (m) setTimeout(() => m.delete().catch(() => {}), 6000);
}

/** Ambil lampiran dari pesan admin untuk dikirim ulang oleh bot. */
const filesOf = (msg) => [...msg.attachments.values()].map((a) => ({ attachment: a.url, name: a.name, description: a.description || undefined }));

/** "123" / link pesan → { channelId?, messageId } */
function parseMessageRef(ref) {
  const link = String(ref || '').match(/channels\/\d+\/(\d+)\/(\d+)/);
  if (link) return { channelId: link[1], messageId: link[2] };
  return isId(ref) ? { messageId: ref } : null;
}

const mentionsFor = (text, member) => {
  const canEveryone = member.permissions.has(PermissionFlagsBits.MentionEveryone);
  return { parse: ['users', 'roles', ...(canEveryone && /@(everyone|here)/.test(text) ? ['everyone'] : [])] };
};

async function handle(msg) {
  if (!msg.guild || msg.author.bot || msg.webhookId) return;
  const cfg = loadConfig();
  const prefix = String(cfg.prefix || '!');
  if (!msg.content.startsWith(prefix)) return;
  const body = msg.content.slice(prefix.length);
  const cmd = body.split(/\s+/)[0].toLowerCase();
  if (!['say', 'edit', 'reply'].includes(cmd)) return;
  const member = msg.member || (await msg.guild.members.fetch(msg.author.id).catch(() => null));
  if (!allowed(member, cfg)) return; // diam saja untuk member biasa
  let rest = body.slice(cmd.length).replace(/^[ \t]+/, ''); // pertahankan baris baru di isi pesan

  try {
    if (cmd === 'say') {
      // Channel tujuan opsional di awal: #channel / <#id> / id
      let target = msg.channel;
      const m = rest.match(/^(?:<#(\d{17,20})>|(\d{17,20}))(?=\s|$)/);
      if (m) {
        const ch = await msg.guild.channels.fetch(m[1] || m[2]).catch(() => null);
        if (!ch || !ch.isTextBased() || ch.type === ChannelType.GuildCategory) return void warn(msg, 'Channel tujuan tidak ditemukan.');
        target = ch;
        rest = rest.slice(m[0].length).replace(/^[ \t]*\n?/, '');
      }
      const files = filesOf(msg);
      if (!rest.trim() && !files.length) return void warn(msg, `Isi pesan kosong. Contoh: \`${prefix}say Halo semua!\``);
      const perms = target.permissionsFor(msg.guild.members.me);
      if (!perms?.has(PermissionFlagsBits.SendMessages)) return void warn(msg, `Bot tidak punya izin kirim pesan di ${target}.`);
      await target.send({ content: rest || undefined, files, allowedMentions: mentionsFor(rest, member) });
      if (cfg.deleteCommand !== false) await msg.delete().catch(() => {});
      else if (target.id !== msg.channel.id) await msg.react('✅').catch(() => {});
      return;
    }

    // edit / reply → butuh referensi pesan (link / ID) atau balas (reply) pesannya langsung
    let ref = null;
    const first = rest.split(/\s+/)[0];
    const parsed = parseMessageRef(first);
    if (parsed) {
      ref = parsed;
      rest = rest.slice(first.length).replace(/^[ \t]*\n?/, '');
    } else if (msg.reference?.messageId) {
      ref = { channelId: msg.reference.channelId, messageId: msg.reference.messageId };
    }
    if (!ref) return void warn(msg, `Sertakan link / ID pesan, atau gunakan \`${prefix}${cmd}\` sambil membalas (reply) pesannya.`);
    const ch = ref.channelId ? await msg.guild.channels.fetch(ref.channelId).catch(() => null) : msg.channel;
    const target = await ch?.messages?.fetch(ref.messageId).catch(() => null);
    if (!target) return void warn(msg, 'Pesan tidak ditemukan.');

    if (cmd === 'edit') {
      if (target.author.id !== msg.client.user.id) return void warn(msg, 'Hanya pesan yang dikirim bot yang bisa diedit.');
      if (!rest.trim()) return void warn(msg, 'Isi pesan baru kosong.');
      await target.edit({ content: rest, allowedMentions: mentionsFor(rest, member) });
    } else {
      const files = filesOf(msg);
      if (!rest.trim() && !files.length) return void warn(msg, 'Isi balasan kosong.');
      await target.reply({ content: rest || undefined, files, allowedMentions: { ...mentionsFor(rest, member), repliedUser: true } });
    }
    if (cfg.deleteCommand !== false) await msg.delete().catch(() => {});
  } catch (err) {
    console.error('[prefix] error:', err.message);
    warn(msg, `Gagal: ${err.message}`);
  }
}

function registerPrefix(client) {
  client.on(Events.MessageCreate, (msg) => handle(msg).catch((e) => console.error('[prefix]', e.message)));
}

module.exports = { registerPrefix };
