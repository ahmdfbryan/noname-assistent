const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags, EmbedBuilder } = require('discord.js');
const { loadConfig, isId, rupiah, num, color, channelOf, GROUPS } = require('./config');
const REP = require('./reputation');
const { state, save, productState, isProductOpen, hasStock, stockOf, setStock, stockUnit, planStockOf, setPlanStock } = require('./state');
const V = require('./views');
const SP = require('./spender');
const H = require('./howto');
const C = require('./catalog');
const I = require('./instant');
const { setProductsOpen, reopenIfAutoClosed, closeIfSoldOut, announce, refreshPanel, onDanaMasukCommand, migrateToV2, postCatalog } = require('./flow');

const TEXT = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

/** Pilihan produk untuk /store buka & tutup (dibaca dari store.json saat npm run deploy). */
function productChoices() {
  const products = (loadConfig()?.products || []).filter((p) => p.type !== 'soon').slice(0, 24);
  return [{ name: '🏪 Semua Produk', value: 'all' }, ...products.map((p) => ({ name: `${p.emoji || '•'} ${p.label}`.slice(0, 100), value: p.id }))];
}
/** Pilihan produk yang punya harga per Robux (Robux Visend, Robux Gamepass, ...). */
function rateChoices() {
  return (loadConfig()?.products || [])
    .filter((p) => p.type === 'robux' || p.type === 'gamepass')
    .slice(0, 25)
    .map((p) => ({ name: `${p.emoji || '•'} ${p.label}`.slice(0, 100), value: p.id }));
}
/** Pilihan produk yang memakai stock (Robux Visend, Canva Pro, ...). */
function stockChoices() {
  const out = [];
  for (const p of (loadConfig()?.products || []).filter(hasStock)) {
    // Server Boost: stock diatur per paket (1 Bulan / 3 Bulan).
    if (p.type === 'boost') for (const x of p.plans || []) out.push({ name: `${p.emoji || '•'} ${p.label} • ${x.label}`.slice(0, 100), value: `${p.id}:${x.id}` });
    else out.push({ name: `${p.emoji || '•'} ${p.label}`.slice(0, 100), value: p.id });
  }
  return out.slice(0, 25);
}
const stockProductOption = (o) => {
  o.setName('produk').setDescription('Produk yang diatur stock-nya (default: Robux Visend)');
  const choices = stockChoices();
  return choices.length ? o.addChoices(...choices) : o;
};
const productOption = (o) =>
  o.setName('produk').setDescription('Produk yang dibuka / ditutup').setRequired(true).addChoices(...productChoices());

/** Kirim pesan baru ke channel & ganti pesan lama (panel / leaderboard). */
async function placeTracked(interaction, key, channel, build) {
  const cfg = loadConfig();
  const old = state[key];
  const msg = await channel.send(build(interaction.guild, cfg));
  state[key] = { channelId: channel.id, messageId: msg.id };
  save();
  if (old && old.messageId !== msg.id) {
    const oldCh = await interaction.guild.channels.fetch(old.channelId).catch(() => null);
    await oldCh?.messages.delete(old.messageId).catch(() => {});
  }
  return msg;
}

async function resolveChannel(interaction, configKey) {
  const picked = interaction.options.getChannel('channel');
  if (picked) return picked;
  const id = channelOf(loadConfig(), configKey);
  return isId(id) ? interaction.guild.channels.fetch(id).catch(() => null) : interaction.channel;
}

const storeCommand = {
  data: new SlashCommandBuilder()
    .setName('store')
    .setDescription('Kelola toko (khusus Administrator)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addSubcommand((s) =>
      s
        .setName('panel')
        .setDescription('Kirim / pindahkan panel store / produk digital (otomatis ter-update)')
        .addStringOption((o) =>
          o
            .setName('jenis')
            .setDescription('Store utama (default), Produk Digital, atau Produk Instan')
            .addChoices({ name: 'Store Utama', value: 'main' }, { name: 'Produk Digital', value: 'digital' }, { name: 'Produk Instan', value: 'instant' }),
        )
        .addChannelOption((o) => o.setName('channel').setDescription('Default: channel panel di store.json').addChannelTypes(...TEXT)),
    )
    .addSubcommand((s) =>
      s
        .setName('leaderboard')
        .setDescription('Kirim / pindahkan Top 10 Spender Leaderboard (otomatis ter-update)')
        .addChannelOption((o) => o.setName('channel').setDescription('Default: channel leaderboard di store.json').addChannelTypes(...TEXT)),
    )
    .addSubcommand((s) =>
      s
        .setName('reputation')
        .setDescription('Kirim / pindahkan panel Reputasi Toko (rating, statistik, feedback terbaru)')
        .addChannelOption((o) => o.setName('channel').setDescription('Default: channels.reputation di store.json').addChannelTypes(...TEXT)),
    )
    .addSubcommand((s) =>
      s
        .setName('catalog')
        .setDescription('Kirim / pindahkan katalog store / produk digital (ter-update otomatis)')
        .addStringOption((o) =>
          o
            .setName('jenis')
            .setDescription('Store utama (default) atau Produk Digital')
            .addChoices({ name: 'Store Utama', value: 'main' }, { name: 'Produk Digital', value: 'digital' }),
        )
        .addChannelOption((o) => o.setName('channel').setDescription('Default: channel catalog di store.json').addChannelTypes(...TEXT)),
    )
    .addSubcommand((s) =>
      s
        .setName('how-to-order')
        .setDescription('Kirim / pindahkan panel How to Order (panduan cara order + dropdown produk)')
        .addChannelOption((o) => o.setName('channel').setDescription('Default: channel howToOrder di store.json').addChannelTypes(...TEXT)),
    )
    .addSubcommand((s) => s.setName('buka').setDescription('Buka produk (pembeli bisa order)').addStringOption(productOption))
    .addSubcommand((s) =>
      s
        .setName('tutup')
        .setDescription('Tutup produk (tombol produk dinonaktifkan)')
        .addStringOption(productOption)
        .addStringOption((o) => o.setName('alasan').setDescription('Alasan tutup (opsional, ditampilkan di pengumuman)').setMaxLength(200)),
    )
    .addSubcommand((s) =>
      s
        .setName('stok-set')
        .setDescription('Atur stock produk (Robux: jumlah Robux • Canva: slot • Server Boost: boost per paket)')
        .addIntegerOption((o) => o.setName('jumlah').setDescription('Jumlah stock (Robux / slot)').setRequired(true).setMinValue(0).setMaxValue(10_000_000))
        .addStringOption(stockProductOption),
    )
    .addSubcommand((s) =>
      s
        .setName('stok-tambah')
        .setDescription('Tambah / kurangi stock produk (pakai angka minus untuk mengurangi)')
        .addIntegerOption((o) => o.setName('jumlah').setDescription('Contoh: 1000 atau -500 (Canva: 5 atau -1)').setRequired(true))
        .addStringOption(stockProductOption),
    )
    .addSubcommand((s) =>
      s
        .setName('harga')
        .setDescription('Atur harga (rate) per 1 Robux')
        .addIntegerOption((o) => o.setName('rate').setDescription('Contoh: 145 (= Rp 145 / Robux)').setRequired(true).setMinValue(1).setMaxValue(100000))
        .addStringOption((o) => {
          o.setName('produk').setDescription('Produk yang diubah harganya (default: Robux Visend)');
          const choices = rateChoices();
          return choices.length ? o.addChoices(...choices) : o;
        }),
    )
    .addSubcommand((s) => s.setName('status').setDescription('Lihat ringkasan toko'))
    .addSubcommand((s) => s.setName('instan').setDescription('Status Produk Instan: koneksi API Waroengkuy, saldo, pesanan bermasalah'))
    .addSubcommand((s) => s.setName('sinkron-role').setDescription('Pasang ulang role Buyer & tier spender ke semua pembeli'))
    .addSubcommand((s) => s.setName('perbarui-tampilan').setDescription('Ubah history order & testimoni lama ke tampilan baru (Components V2)')),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const cfg = loadConfig();
    if (!cfg) return interaction.editReply('❌ store.json tidak bisa dibaca (cek format JSON-nya).');
    const guild = interaction.guild;
    const sub = interaction.options.getSubcommand();
    const product = (cfg.products || []).find((p) => p.type === 'robux');

    if (sub === 'panel') {
      const group = interaction.options.getString('jenis') || 'main';
      const key = GROUPS[group].panelKey;
      const channel = await resolveChannel(interaction, key);
      if (!channel?.isTextBased()) return interaction.editReply('❌ Channel tidak ditemukan.');
      if (group === 'instant' && !I.instantProduct(cfg)) return interaction.editReply('❌ Belum ada produk `"type": "instant"` di store.json.');
      await placeTracked(interaction, key, channel, group === 'instant' ? I.buildPanel : (g, c) => V.buildPanel(g, c, group));
      const names = { main: '**Store Utama**', digital: '**Produk Digital**', instant: '**⚡ Produk Instan**' };
      return interaction.editReply(`✅ Panel ${names[group]} dikirim ke ${channel} dan akan ter-update otomatis.`);
    }
    if (sub === 'leaderboard') {
      const channel = await resolveChannel(interaction, sub);
      if (!channel?.isTextBased()) return interaction.editReply('❌ Channel tidak ditemukan.');
      await placeTracked(interaction, sub, channel, V.buildLeaderboard);
      return interaction.editReply(`✅ Leaderboard dikirim ke ${channel} dan akan ter-update otomatis.`);
    }

    if (sub === 'reputation') {
      const channel = await resolveChannel(interaction, 'reputation');
      if (!channel?.isTextBased()) return interaction.editReply('❌ Channel tidak ditemukan.');
      await placeTracked(interaction, 'reputation', channel, REP.buildReputation);
      return interaction.editReply(`✅ Panel **Reputasi Toko** dikirim ke ${channel} dan akan ter-update otomatis setiap ada testimoni / order selesai.`);
    }

    if (sub === 'catalog') {
      const group = interaction.options.getString('jenis') || 'main';
      const channel = await resolveChannel(interaction, GROUPS[group].catalogKey);
      if (!channel?.isTextBased()) return interaction.editReply('❌ Channel tidak ditemukan.');
      const cards = await postCatalog(channel, cfg, group);
      return interaction.editReply(`✅ Katalog ${group === 'digital' ? '**Produk Digital**' : '**Store Utama**'} (${Object.keys(cards).length} produk) dikirim ke ${channel} dan akan ter-update otomatis.`);
    }

    if (sub === 'how-to-order') {
      const channel = await resolveChannel(interaction, 'howToOrder');
      if (!channel?.isTextBased()) return interaction.editReply('❌ Channel tidak ditemukan.');
      await placeTracked(interaction, 'howto', channel, H.buildHowToPanel);
      return interaction.editReply(`✅ Panel **How to Order** dikirim ke ${channel} dan akan ter-update otomatis.`);
    }

    if (sub === 'buka' || sub === 'tutup') {
      const pick = interaction.options.getString('produk');
      const all = (cfg.products || []).filter((p) => p.type !== 'soon');
      const targets = pick === 'all' ? all : all.filter((p) => p.id === pick);
      if (!targets.length) return interaction.editReply('❌ Produk tidak ditemukan di store.json.');
      const open = sub === 'buka';
      const notes = [];
      const changed = targets.filter((p) => {
        if (open && hasStock(p) && stockOf(p) <= 0) {
          notes.push(`⚠️ **${p.label}** tidak bisa dibuka — stock masih **0**. Atur dulu dengan \`/store stok-set produk:${p.label}\`.`);
          return false;
        }
        if (productState(p.id).open === open) {
          notes.push(`ℹ️ **${p.label}** sudah **${open ? 'BUKA' : 'TUTUP'}**.`);
          return false;
        }
        return true;
      });
      const alasan = interaction.options.getString('alasan');
      await setProductsOpen(guild, changed, open, { reason: alasan ? `📌 ${alasan}` : undefined });
      const done = changed.map((p) => `${open ? '🟢' : '🔴'} **${p.label}** ${open ? 'DIBUKA' : 'DITUTUP'}`);
      return interaction.editReply([...done, ...notes].join('\n') || 'Tidak ada perubahan.');
    }

    if (sub === 'stok-set' || sub === 'stok-tambah') {
      const n = interaction.options.getInteger('jumlah');
      const pick = interaction.options.getString('produk');
      const [pickId, planId] = String(pick || '').split(':');
      const target = pick ? (cfg.products || []).find((p) => p.id === pickId && hasStock(p)) : product;
      if (!target) return interaction.editReply('❌ Produk ber-stock tidak ditemukan di store.json.');
      const plan = target.type === 'boost' ? (target.plans || []).find((x) => x.id === planId) || (target.plans || [])[0] : null;
      if (target.type === 'boost' && !plan) return interaction.editReply('❌ Paket Server Boost tidak ditemukan di store.json.');
      const unit = stockUnit(target);
      const label = plan ? `${target.label} (${plan.label})` : target.label;
      const before = plan ? planStockOf(target, plan.id) : stockOf(target);
      const after = plan ? setPlanStock(target, plan.id, sub === 'stok-set' ? n : before + n) : setStock(target, sub === 'stok-set' ? n : before + n);
      if (target.type === 'robux') state.stockBase = after; // patokan bar "Ketersediaan Stock" di pengumuman terjual
      save();
      refreshPanel();
      await announce(guild, 'stock', {
        product: target,
        text: `Stock **${label}** diperbarui: **${num(before)} → ${num(after)} ${unit}**.`,
      });
      await closeIfSoldOut(guild, `📦 **Stock ${target.label} sudah HABIS!** ${target.label} otomatis ditutup.`, target);
      const reopened = await reopenIfAutoClosed(guild, target);
      return interaction.editReply(
        `📦 Stock **${label}**: **${num(before)} → ${num(after)} ${unit}**.` +
          (plan ? `\n🚀 Total stock ${target.label}: **${num(stockOf(target))} ${unit}**` : '') +
          (reopened ? `\n🟢 **${target.label}** otomatis **DIBUKA** lagi (sebelumnya tutup karena stock habis).` : '') +
          (!isProductOpen(target) && after > 0 ? `\n**${target.label}** masih TUTUP (ditutup manual) — buka dengan \`/store buka\`.` : ''),
      );
    }

    if (sub === 'harga') {
      const pick = interaction.options.getString('produk');
      const target = pick ? (cfg.products || []).find((p) => p.id === pick) : product;
      if (!target) return interaction.editReply('❌ Produk tidak ada di store.json.');
      const rate = interaction.options.getInteger('rate');
      state.rates[target.id] = rate;
      save();
      refreshPanel();
      const example =
        target.type === 'gamepass'
          ? `1.000 Robux diterima = gamepass ${num(V.gpBeforeTax(target, 1000))} Robux = ${rupiah(V.gpBeforeTax(target, 1000) * rate)}`
          : `100 Robux = ${rupiah(rate * 100)}`;
      return interaction.editReply(
        `💱 Harga **${target.label}** sekarang **${rupiah(rate)} / Robux** (${example}).\nTicket yang sudah berjalan tetap memakai harga lama.`,
      );
    }

    if (sub === 'perbarui-tampilan') {
      await interaction.editReply('⏳ Sedang memperbarui history order & testimoni lama... (bisa beberapa menit)');
      const r = await migrateToV2(guild);
      return interaction.editReply(
        `✅ **Selesai!**\n🧾 History order diperbarui: **${r.logs}**\n⭐ Testimoni diperbarui: **${r.testi}**` +
          (r.testiSkipped || r.logSkipped
            ? `\n\nℹ️ Dilewati karena datanya sudah tidak ada di bot (misal pesanan percobaan yang sudah di-reset): ` +
              `**${r.logSkipped}** history & **${r.testiSkipped}** testimoni — bisa dihapus manual.`
            : ''),
      );
    }

    if (sub === 'sinkron-role') {
      const ids = Object.keys(state.spenders);
      let changed = 0;
      for (const id of ids) {
        const res = await SP.applySpenderRoles(guild, id, cfg).catch(() => null);
        if (res && (res.added.length || res.removed.length)) changed += 1;
      }
      return interaction.editReply(
        `✅ Sinkron role spender selesai: **${ids.length}** pembeli dicek, **${changed}** diperbarui.\n` +
          'Kalau ada yang gagal: pastikan bot punya izin **Manage Roles** & role bot berada **di atas** semua role spender.',
      );
    }

    if (sub === 'instan') return interaction.editReply(await I.adminStatus(guild));

    if (sub === 'status') {
      const active = Object.values(state.tickets).filter((t) => t.status === 'open');
      const reserved = active.filter((t) => !t.kind || t.kind === 'robux').reduce((a, t) => a + t.amount, 0);
      const s = state.stats;
      const productLines = (cfg.products || [])
        .filter((p) => p.type !== 'soon')
        .map((p) => `${isProductOpen(p) ? '🟢' : '🔴'} ${p.label}${p.type === 'robux' || p.type === 'gamepass' ? ` • ${rupiah(V.rateOf(cfg, p))}` : ''}`)
        .join('\n');
      const embed = new EmbedBuilder()
        .setColor(color(cfg, 'brand', 0x3498db))
        .setTitle('📊 Ringkasan Toko')
        .addFields(
          { name: '🏪 Status Produk', value: productLines || '-', inline: true },
          {
            name: '📦 Stock',
            value: (cfg.products || []).filter(hasStock).map((p) => `${p.label}: ${num(stockOf(p))} ${stockUnit(p)}`).join('\n') || '-',
            inline: true,
          },
          { name: '💱 Rate', value: product ? `${rupiah(V.rateOf(cfg, product))} / Robux` : '-', inline: true },
          { name: '🎫 Ticket Berjalan', value: `${active.length} ticket (${num(reserved)} Robux tertahan)`, inline: true },
          { name: '🧾 Transaksi Selesai', value: `${num(s.transactions)}`, inline: true },
          { name: '💰 Omzet', value: rupiah(s.revenue), inline: true },
          { name: '🤝 Rekber Sukses', value: `${num(s.rekber)} (${rupiah(s.rekberVolume)})`, inline: true },
          {
            name: '📍 Panel / Panel Digital / Leaderboard',
            value: `${state.panel ? `<#${state.panel.channelId}>` : '❌ belum dikirim'} / ${state.digitalPanel ? `<#${state.digitalPanel.channelId}>` : '❌ belum dikirim'} / ${state.leaderboard ? `<#${state.leaderboard.channelId}>` : '❌ belum dikirim'}`,
          },
        );
      if (active.length) {
        embed.addFields({
          name: 'Daftar Ticket Berjalan',
          value: active
            .slice(0, 15)
            .map((t) =>
              t.kind === 'instant'
                ? `\`${t.id}\` <#${t.channelId}> • ⚡ ${t.productLabel} ×${num(t.qty)} • <@${t.userId}>`
                : t.kind === 'canva'
                ? `\`${t.id}\` <#${t.channelId}> • 🎨 ${t.plan.label} • <@${t.userId}>`
                : t.kind === 'boost'
                ? `\`${t.id}\` <#${t.channelId}> • 🚀 ${num(t.qty)} boost ${t.plan.label} • <@${t.userId}>`
                : t.kind === 'gamepass'
                ? `\`${t.id}\` <#${t.channelId}> • 🎟️ ${num(t.amount)} Robux (gamepass ${num(t.before)}) • <@${t.userId}>`
                : t.kind === 'rekber'
                ? `\`${t.id}\` <#${t.channelId}> • 🤝 ${rupiah(t.nominal)} • <@${t.buyerId}> ↔ <@${t.sellerId}>`
                : `\`${t.id}\` <#${t.channelId}> • ${num(t.amount)} Robux • <@${t.userId}>`,
            )
            .join('\n'),
        });
      }
      return interaction.editReply({ embeds: [embed] });
    }
  },
};

/** /danamasuk → umumkan dana pembeli sudah masuk (dijalankan di channel ticket). */
const danaMasukCommand = {
  data: new SlashCommandBuilder()
    .setName('danamasuk')
    .setDescription('Umumkan dana pembeli sudah masuk (jalankan di channel ticket)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addIntegerOption((o) => o.setName('nominal').setDescription('Nominal yang diterima (default = total tagihan ticket)').setMinValue(1).setMaxValue(1_000_000_000))
    .addStringOption((o) => o.setName('catatan').setDescription('Catatan untuk pembeli (opsional)').setMaxLength(300)),
  execute: (interaction) => onDanaMasukCommand(interaction),
};

/** /spender [member] → kartu total belanja, tier, & progres ke tier berikutnya (semua member). */
const spenderCommand = {
  data: new SlashCommandBuilder()
    .setName('spender')
    .setDescription('Lihat total belanja & tier spender kamu / member lain')
    .setDMPermission(false)
    .addUserOption((o) => o.setName('member').setDescription('Default: kamu sendiri')),
  async execute(interaction) {
    const cfg = loadConfig();
    const user = interaction.options.getUser('member') || interaction.user;
    return interaction.reply({ ...SP.buildSpenderCard(interaction.guild, cfg, user), flags: MessageFlags.Ephemeral });
  },
};

module.exports = { storeCommand, danaMasukCommand, spenderCommand };
