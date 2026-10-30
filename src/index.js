const { ensureSingleInstance } = require('./single-instance');
ensureSingleInstance(); // tolak jalan kalau bot sudah jalan di proses lain

const { Client, GatewayIntentBits, Events, MessageFlags, Partials } = require('discord.js');
const config = require('./config');
const { commands } = require('./commands');
const { registerWelcome } = require('./welcome');
const { handleVerifyButton, BUTTON_ID: VERIFY_BUTTON } = require('./verify');
const { handleTranslateButton, TRANSLATE_BUTTON } = require('./rules');
const voiceFinder = require('./voice-finder');
const store = require('./store');
const { registerSocial } = require('./social');
const { registerInviteTracker } = require('./invite-tracker');
const giveaway = require('./giveaway');
const { registerServerStats } = require('./server-stats');
const supportTicket = require('./support-ticket');
const suggestions = require('./suggestions');
const booster = require('./booster');
const system = require('./system');
const leveling = require('./leveling');
const botPanel = require('./bot-panel');
const canvaManager = require('./canva-manager');
const { registerPrefix } = require('./prefix');
const aiCs = require('./ai-cs');

const byName = new Map(commands.map((c) => [c.data.name, c]));
// GuildMembers wajib untuk fitur welcome → aktifkan "Server Members Intent" di Discord Developer Portal.
// GuildVoiceStates dipakai fitur cari voice (tidak perlu diaktifkan di Developer Portal).
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages, // panel sticky & prefix command
    GatewayIntentBits.GuildInvites, // invite log: mendeteksi link undangan yang dipakai member baru
    GatewayIntentBits.MessageContent, // prefix command (!say) → aktifkan "Message Content Intent" di Developer Portal
  ],
  // Partials: event member keluar tetap diterima walau member belum tersimpan di cache bot (member lama / setelah restart).
  partials: [Partials.GuildMember, Partials.User],
});
registerWelcome(client);
voiceFinder.registerStickyPanel(client);
store.registerStore(client);
registerSocial(client);
registerInviteTracker(client);
giveaway.registerGiveaway(client);
registerServerStats(client);
supportTicket.registerSupportTickets(client);
suggestions.registerSuggestions(client);
booster.registerBooster(client);
system.registerSystem(client);
leveling.registerLeveling(client);
botPanel.registerBotPanel(client);
canvaManager.registerCanvaManager(client);
registerPrefix(client);
aiCs.registerAiCs(client);

const wib = () => new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'medium', timeStyle: 'medium' });
client.once(Events.ClientReady, (c) => {
  const restarts = process.env.restart_time ? ` • restart ke-${process.env.restart_time} (pm2)` : '';
  console.log(`🤖 Login sebagai ${c.user.tag} • ${wib()} WIB${restarts}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  // 🤖 Noname Assistent (AI CS): tombol 👍 / 👎 ("ai:fb:...")
  if (await aiCs.handleInteraction(interaction)) return;
  // Store: semua tombol / dropdown / form dengan customId "store:..."
  if (await store.handleInteraction(interaction)) return;
  // Giveaway: tombol ikut / keluar / daftar peserta ("ga:...")
  if (await giveaway.handleInteraction(interaction)) return;
  // NCS Ticket Center: dropdown / form / tombol ("st:...")
  if (await supportTicket.handleInteraction(interaction)) return;
  // Suggestions: dropdown / form / vote / kelola ("sg:...")
  if (await suggestions.handleInteraction(interaction)) return;
  // Booster: tombol "Ucapkan Terima Kasih" ("bs:...")
  if (await booster.handleInteraction(interaction)) return;
  // System Operational: tombol Refresh Status ("sys:refresh")
  if (await system.handleInteraction(interaction)) return;
  // Bot Command Center: tombol & form panel ("bp:...") — ditangani di bot-panel.js
  if (typeof interaction.customId === 'string' && interaction.customId.startsWith('bp:')) return;
  // Canva Manager: dashboard, form & tombol pengingat ("cv:...") — ditangani di canva-manager.js
  if (typeof interaction.customId === 'string' && interaction.customId.startsWith('cv:')) return;
  // Autocomplete ID giveaway
  if (interaction.isAutocomplete()) {
    const cmd = byName.get(interaction.commandName);
    if (cmd?.autocomplete) await cmd.autocomplete(interaction).catch(() => {});
    return;
  }

  // Tombol "Verify Sekarang"
  if (interaction.isButton() && interaction.customId === VERIFY_BUTTON) {
    try {
      await handleVerifyButton(interaction);
    } catch (err) {
      console.error('[verify] error:', err);
      const msg = { content: '❌ Verifikasi gagal diproses. Silakan hubungi admin.', flags: MessageFlags.Ephemeral };
      if (interaction.deferred || interaction.replied) await interaction.editReply(msg).catch(() => {});
      else await interaction.reply(msg).catch(() => {});
    }
    return;
  }

  // Tombol "Bahasa Inggris" di rules
  if (interaction.isButton() && interaction.customId === TRANSLATE_BUTTON) {
    await handleTranslateButton(interaction).catch((err) => console.error('[rules] error:', err));
    return;
  }

  // Cari member di voice: pilih member dari daftar → hasil
  if (interaction.isUserSelectMenu() && interaction.customId === voiceFinder.SELECT_ID) {
    try {
      await voiceFinder.handleSelect(interaction);
    } catch (err) {
      console.error('[voice-finder] error:', err);
      const msg = { content: '❌ Pencarian gagal, coba lagi.', flags: MessageFlags.Ephemeral };
      if (interaction.deferred || interaction.replied) await interaction.editReply(msg).catch(() => {});
      else await interaction.reply(msg).catch(() => {});
    }
    return;
  }

  // Cari voice: tombol "Lihat Semua Voice"
  if (interaction.isButton() && interaction.customId === voiceFinder.ALL_ID) {
    await voiceFinder.handleAll(interaction).catch((err) => console.error('[voice-finder] error:', err));
    return;
  }

  if (!interaction.isChatInputCommand()) return;
  const command = byName.get(interaction.commandName);
  if (!command) return;
  try {
    await command.execute(interaction);
  } catch (err) {
    console.error('[command] error:', err);
    const msg = { content: '❌ Terjadi kesalahan saat menjalankan perintah.', flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) await interaction.editReply(msg).catch(() => {});
    else await interaction.reply(msg).catch(() => {});
  }
});

// ───── Pengaman global: error tidak membuat bot mati / crash-loop ─────
client.on(Events.Error, (err) => console.error('[client] error:', err?.message || err));
client.on(Events.ShardError, (err, id) => console.error(`[shard ${id}] koneksi error:`, err?.message || err));
client.on(Events.ShardDisconnect, (ev, id) => console.warn(`[shard ${id}] terputus (kode ${ev?.code}) — menyambung ulang otomatis...`));
client.on(Events.ShardReconnecting, (id) => console.warn(`[shard ${id}] menyambung ulang...`));
client.on(Events.ShardResume, (id, replayed) => console.log(`[shard ${id}] tersambung kembali (${replayed} event diputar ulang).`));
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err?.stack || err));
process.on('uncaughtException', (err) => console.error(`[uncaughtException] ${wib()} WIB`, err?.stack || err));

client.login(config.token);
