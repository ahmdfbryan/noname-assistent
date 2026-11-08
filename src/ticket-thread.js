const { ChannelType, PermissionFlagsBits } = require('discord.js');

/**
 * Ticket berbasis THREAD (private thread) — pengganti channel ticket per order.
 * Thread dibuat di channel tempat pembeli menekan tombol (channel panel masing-masing);
 * kalau channel itu tidak cocok (mis. post forum) dipakai channel cadangan (fallbackIds).
 * Kalau thread tidak bisa dibuat (izin kurang, dll.) → kembalikan null supaya pemanggil memakai cara lama (channel).
 *
 * Izin bot di channel induk: View Channel, Create Private Threads, Send Messages in Threads
 * (+ Manage Threads agar bisa menambah anggota & menghapus thread).
 * Staff: beri role staff izin "Manage Threads" di channel induk supaya semua thread privat terlihat.
 */
const warned = new Set();
const warnOnce = (key, msg) => {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(msg);
};

const NEED = [
  ['ViewChannel', PermissionFlagsBits.ViewChannel],
  ['CreatePrivateThreads', PermissionFlagsBits.CreatePrivateThreads],
  ['SendMessagesInThreads', PermissionFlagsBits.SendMessagesInThreads],
  ['ManageThreads', PermissionFlagsBits.ManageThreads],
];

/** Pilih channel induk: channel tempat tombol ditekan → channel cadangan. null kalau tidak ada yang cocok. */
async function resolveParent(guild, interaction, fallbackIds = []) {
  const candidates = [];
  if (interaction?.channel) candidates.push(interaction.channel);
  for (const id of fallbackIds) {
    if (!/^\d{17,20}$/.test(String(id || ''))) continue;
    candidates.push(await guild.channels.fetch(id).catch(() => null));
  }
  for (const ch of candidates) {
    if (!ch || ch.type !== ChannelType.GuildText) continue;
    const perms = ch.permissionsFor(guild.members.me);
    const missing = NEED.filter(([, bit]) => !perms?.has(bit)).map(([n]) => n);
    if (missing.length) {
      warnOnce(`perm:${ch.id}`, `[ticket-thread] bot kekurangan izin di #${ch.name} (${ch.id}): ${missing.join(', ')} — coba channel lain / cara lama.`);
      continue;
    }
    return ch;
  }
  return null;
}

/**
 * Buat private thread untuk ticket & tambahkan anggotanya.
 * opts: { name, userIds, reason, fallbackIds }
 */
async function openTicketThread(guild, interaction, opts) {
  const parent = await resolveParent(guild, interaction, opts.fallbackIds);
  if (!parent) return null;
  let thread = null;
  try {
    thread = await parent.threads.create({
      name: String(opts.name).slice(0, 100),
      type: ChannelType.PrivateThread,
      autoArchiveDuration: 10080, // 7 hari
      invitable: false,
      reason: String(opts.reason || 'Ticket').slice(0, 450),
    });
    for (const id of [...new Set((opts.userIds || []).filter(Boolean))]) {
      await thread.members.add(id);
    }
    return thread;
  } catch (err) {
    console.warn(`[ticket-thread] gagal membuat thread di #${parent.name}: ${err.message} — memakai cara lama (channel).`);
    if (thread) await thread.delete().catch(() => {});
    return null;
  }
}

/** Thread yang terarsip dibuka lagi supaya bot bisa mengirim / mengedit pesan. */
async function ensureOpen(ch) {
  if (ch?.isThread?.() && ch.archived) await ch.setArchived(false, 'Ticket masih berjalan').catch(() => {});
  return ch;
}

module.exports = { openTicketThread, ensureOpen };
