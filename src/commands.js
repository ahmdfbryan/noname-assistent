const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags } = require('discord.js');
const { sendWelcome } = require('./welcome');
const { verifyCommand } = require('./verify');
const { rulesCommand } = require('./rules');
const { voiceFinderCommand } = require('./voice-finder');
const { storeCommand, danaMasukCommand, spenderCommand } = require('./store');
const { socialCommand } = require('./social');
const { invitesCommand, inviteLogCommand } = require('./invite-tracker');
const { giveawayCommand } = require('./giveaway');
const { serverStatsCommand } = require('./server-stats');
const { ticketCommand } = require('./support-ticket');
const { suggestionCommand } = require('./suggestions');
const { boosterCommand } = require('./booster');
const { systemCommand } = require('./system');
const { userInfoCommand, robloxCommand } = require('./profile-info');
const { clearCommand } = require('./clear');
const { rankCommand, levelCommand } = require('./leveling');
const { membersCommand } = require('./member-list');
const { serverCheckCommand } = require('./server-check');
const { botPanelCommand } = require('./bot-panel');
const { canvaCommand } = require('./canva-manager');
const { pesanCommand } = require('./pesan');

const TEXT_CHANNELS = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

/** /welcome test → kirim contoh pesan welcome memakai akun kamu sendiri. */
const welcomeCommand = {
  data: new SlashCommandBuilder()
    .setName('welcome')
    .setDescription('Pesan welcome member baru')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addSubcommand((s) =>
      s
        .setName('test')
        .setDescription('Kirim contoh pesan welcome (pakai akun kamu) untuk cek tampilan')
        .addChannelOption((o) =>
          o
            .setName('channel')
            .setDescription('Kirim contoh ke channel ini (default: channel welcome di welcome.json)')
            .addChannelTypes(...TEXT_CHANNELS),
        ),
    ),
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const member = await interaction.guild.members.fetch(interaction.user.id);
    const res = await sendWelcome(member, { channelOverride: interaction.options.getChannel('channel') });
    return interaction.editReply(res.ok ? `✅ Contoh welcome dikirim ke ${res.channel}.` : `❌ ${res.reason}`);
  },
};

const commands = [
  welcomeCommand,
  verifyCommand,
  rulesCommand,
  voiceFinderCommand,
  storeCommand,
  danaMasukCommand,
  spenderCommand,
  socialCommand,
  invitesCommand,
  inviteLogCommand,
  giveawayCommand,
  serverStatsCommand,
  ticketCommand,
  suggestionCommand,
  boosterCommand,
  systemCommand,
  userInfoCommand,
  robloxCommand,
  clearCommand,
  rankCommand,
  levelCommand,
  membersCommand,
  serverCheckCommand,
  botPanelCommand,
  canvaCommand,
  pesanCommand,
];

module.exports = { commands };
