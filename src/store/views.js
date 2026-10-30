const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  FileBuilder,
  MessageFlags,
} = require('discord.js');
const UI = require('../ui');
const { color, rupiah, num, fill, ts, loadConfig, GROUPS, groupOf, productsOf, groupText } = require('./config');
const SP = require('./spender');
const { state, productState, productStatsOf, hasStock, stockOf, stockUnit, isProductOpen, kindOf, planStockOf } = require('./state');

const STATUS_LABEL = {
  open: '⏳ Menunggu Pembayaran / Proses',
  completed: '✅ Completed — Produk berhasil dikirim',
  cancelled: '❌ Cancelled — Dibatalkan',
  refund: '💸 Refund — Dana dikembalikan',
};
const REKBER_STATUS = {
  open: '🔄 Transaksi Sedang Berjalan',
  completed: '✅ Completed — Dana dicairkan ke penjual',
  cancelled: '❌ Cancelled — Transaksi dibatalkan',
  refund: '💸 Refund — Dana dikembalikan ke pembeli',
};
const statusLabel = (t) => (kindOf(t) === 'rekber' ? REKBER_STATUS : STATUS_LABEL)[t.status];
const STARS = (n) => '⭐'.repeat(n) + '☆'.repeat(5 - n);

/** Nama toko yang tampil di semua keterangan (store.json → storeName). */
function storeName(cfg, guild) {
  return cfg?.storeName || guild.name;
}

function serverFooter(guild, text) {
  return { text: text || guild.name, iconURL: guild.iconURL({ extension: 'png', size: 128 }) || undefined };
}

function rateOf(cfg, product) {
  return Number(state.rates[product.id]) || Number(product.rate) || 0;
}

// ───────────────────────── Panel utama ─────────────────────────
/** Panel di channel store: hanya judul, keterangan, logo server, dan tombol produk. */
function buildPanel(guild, cfg) {
  const p = cfg.panel || {};
  const name = { name: storeName(cfg, guild) };

  const embed = new EmbedBuilder()
    .setColor(color(cfg, 'brand', 0x3498db))
    .setTitle(fill(p.title || '🛒 {server}', name))
    .setDescription(fill(p.description, name).slice(0, 4096) || null)
    .setThumbnail(guild.iconURL({ extension: 'png', size: 256 }) || null);
  if (p.bannerImage) embed.setImage(p.bannerImage);

  // Total transaksi & rating (ter-update otomatis setiap ada transaksi / testimoni baru).
  const s = state.stats;
  const avg = s.ratingCount ? (s.ratingSum / s.ratingCount).toFixed(1) : '-';
  // Total = semua transaksi selesai dari semua produk (Robux Visend, Robux Gamepass, Rekber, dst.).
  embed.addFields(
    { name: '🧾 Total Transaksi', value: `\`${num((s.transactions || 0) + (s.rekber || 0))} transaksi\``, inline: true },
    { name: '⭐ Rating Toko', value: `\`${avg} / 5 (${num(s.ratingCount)} ulasan)\``, inline: true },
  );

  // Tombol produk tanpa warna (abu-abu). store.json → "panelButtonColors": true untuk memakai warna lagi.
  const styles = cfg.panelButtonColors === true ? { robux: ButtonStyle.Success, gamepass: ButtonStyle.Success, canva: ButtonStyle.Primary, rekber: ButtonStyle.Primary } : {};
  const buttons = (cfg.products || []).slice(0, 5).map((prod) =>
    new ButtonBuilder()
      .setCustomId(`store:buy:${prod.id}`)
      .setLabel(prod.label)
      .setEmoji(prod.emoji || '🛒')
      .setStyle(styles[prod.type] || ButtonStyle.Secondary)
      .setDisabled(!isProductOpen(prod)),
  );
  return { embeds: [embed], components: buttons.length ? [new ActionRowBuilder().addComponents(buttons)] : [] };
}

// ───────────────────────── Info produk (hanya terlihat pembeli) ─────────────────────────
function buildProductInfo(guild, cfg, product) {
  const open = isProductOpen(product);
  const s = state.stats;
  const avg = s.ratingCount ? (s.ratingSum / s.ratingCount).toFixed(1) : '-';
  const embed = new EmbedBuilder()
    .setColor(color(cfg, 'brand', 0x3498db))
    .setTitle(`${product.emoji || '💎'} ${product.label}`)
    .setDescription(fill(product.description || '', { name: storeName(cfg, guild) }) || null)
    .setThumbnail(guild.iconURL({ extension: 'png', size: 256 }) || null)
    .addFields(
      { name: `💎 Harga ${product.label}`, value: `\`${rupiah(rateOf(cfg, product))} / Robux\``, inline: true },
      { name: '📦 Sisa Stock', value: `\`${num(state.stock)} Robux\``, inline: true },
      { name: '🏪 Status', value: open ? '`🟢 BUKA`' : '`🔴 TUTUP`', inline: true },
      { name: '🧾 Total Transaksi', value: `\`${num(s.transactions)} transaksi\``, inline: true },
      { name: `💎 ${product.label} Terjual`, value: `\`${num(productStatsOf(product.id).robux)} Robux\``, inline: true },
      { name: '⭐ Rating Pembeli', value: `\`${avg} / 5 (${num(s.ratingCount)} ulasan)\``, inline: true },
    );

  const buttons = [
    new ButtonBuilder()
      .setCustomId(`store:order:${product.id}`)
      .setLabel(open ? 'Beli Sekarang' : 'Toko Sedang Tutup')
      .setEmoji('🛒')
      .setStyle(ButtonStyle.Success)
      .setDisabled(!open),
  ];
  if (product.terms?.description) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`store:terms:${product.id}`)
        .setLabel(product.terms.button || 'Syarat Pembelian')
        .setEmoji('📌')
        .setStyle(ButtonStyle.Secondary),
    );
  }
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(buttons)] };
}

/** Syarat sebelum membeli produk (hanya terlihat pembeli). */
function buildProductTerms(guild, cfg, product) {
  const t = product.terms || {};
  return {
    embeds: [
      new EmbedBuilder()
        .setColor(color(cfg, 'brand', 0x3498db))
        .setTitle(t.title || `📌 Persyaratan ${product.label}`)
        .setDescription(fill(t.description || '-', { name: storeName(cfg, guild) }).slice(0, 4096)),
    ],
  };
}

// ───────────────────────── Leaderboard ─────────────────────────
function buildLeaderboard(guild, cfg) {
  const medals = ['🥇', '🥈', '🥉'];
  const top = Object.entries(state.spenders)
    .sort((a, b) => b[1].revenue - a[1].revenue || b[1].orders - a[1].orders)
    .slice(0, 10);

  const lines = top.length
    ? top.map(([userId, d], i) => {
        const rank = medals[i] || `\`#${i + 1}\``;
        const tier = SP.tierFor(d.revenue, cfg);
        return `${rank} <@${userId}>\n┗ 💰 **${rupiah(d.revenue)}** • ${num(d.orders)} order${tier ? ` • ${SP.tierLabel(tier)}` : ''}`;
      })
    : ['_Belum ada transaksi. Jadilah spender pertama!_ 🚀'];

  const embed = new EmbedBuilder()
    .setColor(color(cfg, 'brand', 0x3498db))
    .setTitle(`🏆 Top 10 Spender Leaderboard | ${storeName(cfg, guild)}`)
    // \u200b di awal = 1 baris kosong di bawah judul (Discord membuang baris kosong biasa di awal deskripsi).
    .setDescription(`\u200b\n${lines.join('\n\n')}`)
    .setThumbnail(guild.iconURL({ extension: 'png', size: 256 }) || null)
    .addFields(
      { name: '🧾 Total Transaksi', value: `\`${num(state.stats.transactions)}\``, inline: true },
      { name: '👥 Total Pembeli', value: `\`${num(Object.keys(state.spenders).length)}\``, inline: true },
    )
    .setFooter(serverFooter(guild, storeName(cfg, guild)))
    .setTimestamp(new Date());
  return { embeds: [embed], allowedMentions: { parse: [] } };
}

// ───────────────────────── Konfirmasi akun Roblox ─────────────────────────
function buildConfirmAccount(cfg, roblox) {
  const embed = new EmbedBuilder()
    .setColor(color(cfg, 'brand', 0x3498db))
    .setTitle('🔍 Confirm Your Roblox Account')
    .setDescription('Is this really your Roblox account?')
    .addFields(
      { name: '👤 Username', value: `\`${roblox.name}\``, inline: true },
      { name: '✨ Display Name', value: `\`${roblox.displayName}\``, inline: true },
      { name: '🆔 User ID', value: `\`${roblox.id}\``, inline: true },
    )
    .setURL(`https://www.roblox.com/users/${roblox.id}/profile`);
  if (roblox.created) embed.addFields({ name: '📅 Akun Dibuat', value: ts(Date.parse(roblox.created), 'D'), inline: true });
  if (roblox.avatar) embed.setThumbnail(roblox.avatar);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('store:confirm:yes').setLabel('Ya, Lanjutkan').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('store:confirm:no').setLabel('Tidak, Batalkan').setEmoji('✖️').setStyle(ButtonStyle.Danger),
  );
  return { embeds: [embed], components: [row] };
}

// ───────────────────────── Pilih jumlah Robux ─────────────────────────
function buildAmountPicker(cfg, product, roblox) {
  const rate = rateOf(cfg, product);
  const max = Math.min(Number(product.maxAmount) || 5000, state.stock);
  const embed = new EmbedBuilder()
    .setColor(color(cfg, 'brand', 0x3498db))
    .setTitle(`${product.emoji || '💎'} Pilih Jumlah ${product.label}`)
    .setDescription(
      `Akun Roblox: **${roblox.displayName}** (\`@${roblox.name}\`)\n\n` +
        `💱 Rate: **${rupiah(rate)} / Robux**\n📦 Sisa stock: **${num(state.stock)} Robux**\n\n` +
        `Pilih jumlah di bawah, atau pilih **✏️ Jumlah Lain** untuk memasukkan jumlah sendiri ` +
        `(${num(product.minAmount || 1)} – ${num(Math.max(max, 0))} Robux).`,
    );
  if (roblox.avatar) embed.setThumbnail(roblox.avatar);

  const options = (product.presets || []).slice(0, 24).map((amount) => ({
    label: `${num(amount)} Robux`,
    description: `${rupiah(amount * rate)}${amount > state.stock ? ' • stock tidak cukup' : ''}`,
    value: String(amount),
    emoji: amount > state.stock ? '⛔' : '💎',
  }));
  options.push({ label: 'Jumlah Lain', description: `Maksimal ${num(product.maxAmount || 5000)} Robux`, value: 'custom', emoji: '✏️' });

  const select = new StringSelectMenuBuilder()
    .setCustomId(`store:amount:${product.id}`)
    .setPlaceholder('💎 Pilih jumlah Robux...')
    .addOptions(options);
  const cancel = new ButtonBuilder().setCustomId('store:confirm:no').setLabel('Batalkan').setEmoji('✖️').setStyle(ButtonStyle.Secondary);
  return {
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(select), new ActionRowBuilder().addComponents(cancel)],
  };
}

// ───────────────────────── Isi ticket ─────────────────────────
function buildTicketMessage(guild, cfg, t) {
  if (kindOf(t) === 'rekber') return buildRekberTicket(guild, cfg, t);
  if (kindOf(t) === 'gamepass') return buildGamepassTicket(guild, cfg, t);
  if (kindOf(t) === 'canva') return buildCanvaTicket(guild, cfg, t);
  if (kindOf(t) === 'boost') return buildBoostTicket(guild, cfg, t);
  if (kindOf(t) === 'instant') return require('./instant').buildTicket(guild, cfg, t);
  const statusColor = {
    open: color(cfg, 'brand', 0x3498db),
    completed: color(cfg, 'open', 0x2ecc71),
    cancelled: color(cfg, 'closed', 0xe74c3c),
    refund: color(cfg, 'refund', 0xe67e22),
  }[t.status];

  const info = new EmbedBuilder()
    .setColor(statusColor)
    .setTitle(`🧾 Detail Pesanan • ${t.id}`)
    .setDescription(`Halo <@${t.userId}>, terima kasih sudah berbelanja di **${storeName(cfg, guild)}**! 💜`)
    .addFields(
      { name: '👤 Pembeli', value: `<@${t.userId}>`, inline: true },
      {
        name: '🎮 Akun Roblox',
        value: `[${t.roblox.displayName}](https://www.roblox.com/users/${t.roblox.id}/profile)\n\`@${t.roblox.name}\``,
        inline: true,
      },
      { name: '🆔 Roblox ID', value: `\`${t.roblox.id}\``, inline: true },
      { name: '📦 Produk', value: `\`${t.productLabel}\``, inline: true },
      { name: '💎 Jumlah', value: `\`${num(t.amount)} Robux\``, inline: true },
      { name: '💱 Rate', value: `\`${rupiah(t.rate)} / Robux\``, inline: true },
      { name: '💰 Total Bayar', value: `## ${rupiah(t.price)}`, inline: false },
      { name: '📌 Status', value: `**${ticketStatusText(t)}**`, inline: true },
      { name: '💳 Pembayaran', value: payStatusText(t), inline: true },
      { name: '🕒 Dibuat', value: ts(t.createdAt, 'f'), inline: true },
    )
    .setFooter(serverFooter(guild, `${storeName(cfg, guild)} • Ticket ${t.id}`))
    .setTimestamp(t.closedAt || t.createdAt);
  if (t.roblox.avatar) info.setThumbnail(t.roblox.avatar);
  if (t.closedAt) info.addFields({ name: '🔒 Ditutup', value: `${ts(t.closedAt, 'f')} oleh <@${t.closedBy}>`, inline: true });

  const embeds = [info, ...paymentEmbeds(guild, cfg, t)];

  const components =
    t.status === 'open'
      ? [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`store:close:${t.id}`)
              .setLabel('Tutup Ticket')
              .setEmoji('🔒')
              .setStyle(ButtonStyle.Danger),
          ),
          ...paymentRows(t),
        ]
      : [];
  return { embeds, components };
}

// ───────────────────────── DM ke pembeli ─────────────────────────
function buildDmCreated(guild, cfg, t, channelUrl) {
  const embed = new EmbedBuilder()
    .setColor(color(cfg, 'brand', 0x3498db))
    .setTitle('🎫 Ticket Order Berhasil Dibuat')
    .setDescription(
      `Ticket order kamu di **${storeName(cfg, guild)}** sudah berhasil dibuat.\n\n` +
        `Silakan lanjutkan ke channel ticket kamu untuk menyelesaikan pembayaran:\n${channelUrl}`,
    )
    .addFields(
      { name: '📦 Produk', value: `\`${t.productLabel} • ${itemText(t)}\``, inline: true },
      { name: '🎫 Ticket ID', value: `\`${t.id}\``, inline: true },
      { name: '💰 Total Bayar', value: `\`${rupiah(t.price)}\``, inline: true },
    )
    .setThumbnail(guild.iconURL({ extension: 'png', size: 256 }) || null)
    .setFooter(serverFooter(guild, storeName(cfg, guild)))
    .setTimestamp(new Date());
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Buka Ticket').setEmoji('🎫').setURL(channelUrl),
  );
  return { embeds: [embed], components: [row] };
}

function buildDmClosed(guild, cfg, t) {
  if (kindOf(t) === 'rekber') return buildRekberDmClosed(guild, cfg, t);
  const titles = {
    completed: '✅ Pesanan Kamu Sudah Selesai',
    cancelled: '❌ Pesanan Kamu Dibatalkan',
    refund: '💸 Pesanan Kamu Di-refund',
  };
  const gp = kindOf(t) === 'gamepass';
  const canva = kindOf(t) === 'canva';
  const boost = kindOf(t) === 'boost';
  const instant = kindOf(t) === 'instant';
  const desc = {
    completed: instant
      ? `**${t.ins?.product || t.productLabel} — ${t.ins?.variant || ''}** (${num(t.qty || 1)} akun) sudah **dikirim otomatis**! ⚡\n` +
        `Data akun ada di ticket & DM kamu — simpan baik-baik ya.\n\n` +
        `Terima kasih sudah berbelanja di **${storeName(cfg, guild)}**! 💜 Jangan lupa beri testimoni di ticket kamu ya ⭐`
      : boost
      ? `**${num(t.qty)} Server Boost (${t.plan.label})** untuk server **${t.server?.name || '-'}** sudah **AKTIF**! 🚀\n` +
        `Masa aktif sekitar **${t.plan.duration || `${num(t.plan.days)} hari`}** dengan **garansi penuh** selama masa aktif boost. 🛡️\n\n` +
        `Terima kasih sudah berbelanja di **${storeName(cfg, guild)}**! 💜 Jangan lupa beri testimoni di ticket kamu ya ⭐`
      : canva
      ? `**${t.productLabel} (${t.plan.label})** kamu sudah **AKTIF**! 🎉\n` +
        `Berlaku hingga **${ts(t.expiresAt || Date.now(), 'D')}** untuk email \`${t.email}\`.\n\n` +
        `Terima kasih sudah berbelanja di **${storeName(cfg, guild)}**! 💜 Jangan lupa beri testimoni di ticket kamu ya ⭐`
      : gp
      ? `Gamepass **${t.gamepass?.name || t.gamepass?.id}** sudah kami beli! 🎉\n` +
        `Robux kamu sedang dalam **masa pending Roblox** dan akan masuk otomatis sekitar ` +
        `**${ts((t.closedAt || Date.now()) + (Number(t.pendingDays) || 5) * 86400000, 'D')}**.\n\n` +
        `Terima kasih sudah berbelanja di **${storeName(cfg, guild)}**! 💜 Jangan lupa beri testimoni di ticket kamu ya ⭐`
      : `Robux kamu sudah berhasil dikirim. Terima kasih sudah berbelanja di **${storeName(cfg, guild)}**! 💜\nJangan lupa beri testimoni di ticket kamu ya ⭐`,
    cancelled: `Pesanan kamu di **${storeName(cfg, guild)}** telah dibatalkan.`,
    refund: `Dana pesanan kamu di **${storeName(cfg, guild)}** telah dikembalikan.`,
  };
  const embed = new EmbedBuilder()
    .setColor(t.status === 'completed' ? color(cfg, 'open', 0x2ecc71) : color(cfg, 'refund', 0xe67e22))
    .setTitle(titles[t.status])
    .setDescription(desc[t.status] + (t.note ? `\n\n📝 Catatan admin: ${t.note}` : ''))
    .addFields(
      { name: '🎫 Ticket ID', value: `\`${t.id}\``, inline: true },
      { name: '📦 Produk', value: `\`${t.productLabel} • ${itemText(t)}\``, inline: true },
    )
    .setFooter(serverFooter(guild, storeName(cfg, guild)))
    .setTimestamp(new Date());
  if (t.proofUrl && t.status === 'completed') embed.setImage(t.proofUrl);
  return { embeds: [embed] };
}

// ───────────────────────── Testimoni ─────────────────────────
/** Siapa yang diminta memberi testimoni: pembeli Robux / pihak pembeli di rekber. */
const testimonyUserId = (t) => (kindOf(t) === 'rekber' ? t.buyerId : t.userId);

function buildTestimonyPrompt(guild, cfg, t) {
  if (kindOf(t) === 'rekber') return buildRekberTestimonyPrompt(guild, cfg, t);
  const embed = new EmbedBuilder()
    .setColor(color(cfg, 'brand', 0x3498db))
    .setTitle('⭐ Bagaimana Pengalaman Belanjamu?')
    .setDescription(
      `<@${t.userId}>, pesananmu sudah selesai! 🎉\n\nBantu kami jadi lebih baik dengan memberikan **rating & testimoni** ` +
        `lewat tombol di bawah. Testimonimu akan ditampilkan di channel testimoni.`
    )
    .setFooter(serverFooter(guild, storeName(cfg, guild)));
  if (t.proofUrl) embed.setImage(t.proofUrl);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`store:testi:${t.id}`).setLabel('Beri Testimoni').setEmoji('⭐').setStyle(ButtonStyle.Primary),
  );
  return { content: `<@${t.userId}>`, embeds: [embed], components: [row], allowedMentions: { users: [t.userId] } };
}

function buildTestimony(guild, cfg, t, buyer) {
  if (kindOf(t) === 'rekber') return buildRekberTestimony(guild, cfg, t, buyer);
  if (kindOf(t) === 'canva') return buildCanvaTestimony(guild, cfg, t, buyer);
  const r = t.testimony;
  const embed = new EmbedBuilder()
    .setColor(color(cfg, 'brand', 0x3498db))
    .setTitle(`🧾 Testimoni #${String(state.stats.testimonies).padStart(4, '0')}`)
    .setDescription(
      r
        ? `**Rating:** ${STARS(r.rating)}  **${r.rating}/5**\n\n>>> ${r.comment}`
        : '✅ **Transaksi Berhasil**\n\n_Pembeli tidak memberikan ulasan._',
    )
    .addFields(
      { name: '👤 Pembeli', value: `<@${t.userId}>`, inline: true },
      { name: '📦 Produk', value: `\`${t.productLabel}\``, inline: true },
      { name: '💎 Jumlah', value: `\`${num(t.amount)} Robux\``, inline: true },
      { name: '🎮 Roblox', value: `\`@${t.roblox.name}\``, inline: true },
      { name: '💰 Total', value: `\`${rupiah(t.price)}\``, inline: true },
      { name: '🎫 Ticket', value: `\`${t.id}\``, inline: true },
    )
    .setThumbnail(buyer?.displayAvatarURL({ extension: 'png', size: 256 }) || t.roblox.avatar || null)
    .setFooter(serverFooter(guild, storeName(cfg, guild)))
    .setTimestamp(new Date());
  if (t.proofUrl) embed.setImage(t.proofUrl);
  return { embeds: [embed], allowedMentions: { parse: [] } };
}

// ───────────────────────── Pengumuman di channel stock ─────────────────────────
/**
 * kind: 'open' | 'close' → extra.products = daftar produk yang dibuka / ditutup.
 *       'stock' | 'returned' → khusus Robux.
 */
function buildStoreAnnouncement(guild, cfg, kind, extra = {}) {
  // Semua produk yang diumumkan dari panel Produk Digital → tombol mengarah ke panel digital.
  const onlyDigital = (extra.products || []).length && (extra.products || []).every((x) => groupOf(x) === 'digital');
  const panelLink = panelUrlFor(guild, onlyDigital ? 'digital' : 'main');
  const robux = (cfg.products || []).find((x) => x.type === 'robux');
  const rate = robux ? rateOf(cfg, robux) : 0;
  const name = storeName(cfg, guild);
  const e = new EmbedBuilder().setFooter(serverFooter(guild, name)).setTimestamp(new Date());
  const products = extra.products || [];
  const single = products.length === 1 ? products[0] : null;
  const label = single ? single.label : name;
  const listText = products.map((p) => `${p.emoji || '•'} **${p.label}**`).join('\n');
  const robuxIncluded = products.some((p) => p.type === 'robux');
  const gamepassOpened = products.filter((p) => p.type === 'gamepass');
  const slotProducts = products.filter((p) => hasStock(p) && p.type !== 'robux');

  if (kind === 'open') {
    e.setColor(color(cfg, 'open', 0x2ecc71))
      .setTitle(`🟢 ${label} Sudah Dibuka!`)
      .setDescription(
        (single
          ? `**${single.label}** di **${name}** sekarang **BUKA** dan siap menerima pesanan! 🎉`
          : `**${name}** sekarang **BUKA** dan siap menerima pesanan! 🎉\n\n${listText}`) +
          (panelLink ? `\n\n🛒 Order sekarang: ${panelLink}` : ''),
      );
    if (robuxIncluded) {
      e.addFields(
        { name: '📦 Stock Robux', value: `\`${num(state.stock)} Robux\``, inline: true },
        { name: '💱 Rate', value: `\`${rupiah(rate)} / Robux\``, inline: true },
      );
    }
    for (const gp of gamepassOpened) {
      e.addFields({ name: `${gp.emoji || '🎟️'} Rate ${gp.label}`, value: `\`${rupiah(rateOf(cfg, gp))} / Robux\``, inline: true });
    }
    for (const sp of slotProducts) {
      e.addFields({ name: `${sp.emoji || '📦'} Slot ${sp.label}`, value: `\`${num(stockOf(sp))} ${stockUnit(sp)}\``, inline: true });
    }
  } else if (kind === 'close') {
    e.setColor(color(cfg, 'closed', 0xe74c3c))
      .setTitle(`🔴 ${label} Ditutup`)
      .setDescription(
        `${extra.reason || (single ? `**${single.label}** di **${name}** saat ini **TUTUP** dan tidak menerima pesanan baru.` : `**${name}** saat ini **TUTUP** dan tidak menerima pesanan baru.\n\n${listText}`)}\n\n` +
          'Pantau terus channel ini untuk info buka berikutnya. Terima kasih! 💜',
      );
    if (robuxIncluded) e.addFields({ name: '📦 Sisa Stock Robux', value: `\`${num(state.stock)} Robux\``, inline: true });
    for (const sp of slotProducts) {
      e.addFields({ name: `📦 Sisa Slot ${sp.label}`, value: `\`${num(stockOf(sp))} ${stockUnit(sp)}\``, inline: true });
    }
  } else if (kind === 'stock') {
    // extra.product = produk yang stock-nya berubah (default Robux)
    const sp = extra.product || robux;
    const unit = stockUnit(sp);
    e.setColor(color(cfg, 'brand', 0x3498db))
      .setTitle(`📦 Update Stock ${sp?.label || 'Robux'}`)
      .setDescription(extra.text || `Stock ${sp?.label || 'Robux'} telah diperbarui.`)
      .addFields(
        { name: sp?.type === 'boost' ? '📦 Total Stock' : '📦 Stock Sekarang', value: `\`${num(stockOf(sp))} ${unit}\``, inline: true },
        { name: '🏪 Status', value: sp && isProductOpen(sp) ? '`🟢 BUKA`' : '`🔴 TUTUP`', inline: true },
      );
    if (sp?.type === 'boost') e.addFields({ name: '🚀 Stock per Paket', value: boostStockLines(sp) || '-' });
  } else if (kind === 'sold') {
    // extra.product = produk Robux yang terjual, extra.amount = jumlah terjual, extra.count = jumlah order
    const sp = extra.product || robux;
    const unit = stockUnit(sp);
    const left = stockOf(sp);
    const sold = Number(extra.amount) || 0;
    const total = Math.max(Number(state.stockBase) || 0, left + sold); // patokan = stock yang terakhir dibuka admin
    const pct = total > 0 ? Math.round((left / total) * 100) : 0;
    const filled = Math.round(pct / 10);
    const bar = `${'🟦'.repeat(filled)}${'⬛'.repeat(10 - filled)} \`${pct}%\``;
    e.setColor(color(cfg, 'brand', 0x3498db))
      .setTitle(`🛒 ${sp?.label || 'Robux'} Baru Saja Terjual!`)
      .setDescription(
        `${extra.count > 1 ? `**${num(extra.count)} pesanan**` : 'Ada pesanan'} masuk sebanyak **${num(sold)} ${unit}**. 🎉\n` +
          `Sisa stock tinggal **${num(left)} ${unit}** — buruan order sebelum kehabisan! 🔥` +
          (panelLink ? `\n\n🛒 Order sekarang: ${panelLink}` : ''),
      )
      .addFields(
        { name: '📤 Terjual', value: `\`${num(sold)} ${unit}\``, inline: true },
        { name: '📦 Sisa Stock', value: `\`${num(left)} ${unit}\``, inline: true },
        { name: '💱 Rate', value: `\`${rupiah(rateOf(cfg, sp))} / Robux\``, inline: true },
        { name: '📊 Ketersediaan Stock', value: bar },
      );
  } else if (kind === 'returned') {
    const t = extra.ticket;
    const sp = (cfg.products || []).find((x) => x.id === t.productId) || robux;
    const unit = stockUnit(sp);
    const qty = kindOf(t) === 'robux' ? t.amount : Number(t.qty) || 1;
    e.setColor(color(cfg, 'refund', 0xe67e22))
      .setTitle(t.status === 'refund' ? '💸 Pesanan Di-refund — Stock Dikembalikan' : '❌ Pesanan Dibatalkan — Stock Dikembalikan')
      .setDescription(`Ticket **${t.id}** (${sp?.label || t.productLabel}) ditutup dengan status **${STATUS_LABEL[t.status]}**.`)
      .addFields(
        { name: '♻️ Stock Kembali', value: `\`+${num(qty)} ${unit}\`${kindOf(t) === 'boost' && t.plan ? ` • ${t.plan.label}` : ''}`, inline: true },
        { name: '📦 Stock Sekarang', value: `\`${num(stockOf(sp))} ${unit}\``, inline: true },
        { name: '🏪 Status', value: sp && isProductOpen(sp) ? '`🟢 BUKA`' : '`🔴 TUTUP`', inline: true },
      );
  }
  return e;
}

/**
 * Pengumuman di channel stock (Components V2, premium):
 * open / close → extra.products • stock → extra.product + extra.text • sold → extra.product, amount, count • returned → extra.ticket.
 * ping = mention @everyone di atas kotak.
 */
/**
 * Gambar produk untuk pengumuman (sama seperti kartu katalog):
 * products[].catalog.thumbnail / products[].thumbnail (link https atau path file) → assets/products/<id>.png → logo server.
 */
function productThumb(guild, p) {
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..', '..');
  for (const set of [p?.catalog?.thumbnail, p?.thumbnail].map((x) => String(x || '').trim()).filter(Boolean)) {
    if (/^https?:\/\//i.test(set)) return { url: set, files: [], real: true };
    const file = path.join(root, set);
    if (fs.existsSync(file)) {
      const name = `product-${String(p.id).replace(/[^\w-]/g, '')}${path.extname(file) || '.png'}`;
      return { url: `attachment://${name}`, files: [{ attachment: file, name }], real: true };
    }
  }
  if (p?.id) {
    const file = path.join(root, 'assets', 'products', `${p.id}.png`);
    if (fs.existsSync(file)) {
      const name = `product-${String(p.id).replace(/[^\w-]/g, '')}.png`;
      return { url: `attachment://${name}`, files: [{ attachment: file, name }], real: true };
    }
  }
  return { url: icon256(guild), files: [], real: false };
}

function buildStoreAnnouncementV2(guild, cfg, kind, extra = {}, ping = false) {
  // Gambar produk (bukan logo server) + file lampirannya.
  const files = [];
  const imgOf = (p) => {
    const r = productThumb(guild, p);
    for (const f of r.files) if (!files.some((x) => x.name === f.name)) files.push(f);
    return r;
  };
  const thumbOf = (p) => (p ? imgOf(p).url : icon256(guild));
  /** Banyak produk sekaligus → galeri gambar produk; 1 produk → gambar kecil produk. */
  const multiImages = (list) => (list.length > 1 ? list.slice(0, 10).map((x) => imgOf(x)).filter((r) => r.real).map((r) => r.url) : []);
  const onlyDigital = (extra.products || []).length && (extra.products || []).every((x) => groupOf(x) === 'digital');
  const robux = (cfg.products || []).find((x) => x.type === 'robux');
  const name = storeName(cfg, guild);
  const products = extra.products || [];
  const single = products.length === 1 ? products[0] : null;
  const listText = products.map((p) => `▸ ${p.emoji || '🛒'} **${p.label}**`).join('\n');
  const robuxIncluded = products.some((p) => p.type === 'robux');
  const gamepass = products.filter((p) => p.type === 'gamepass');
  const slotProducts = products.filter((p) => hasStock(p) && p.type !== 'robux');
  const now = `<t:${Math.floor(Date.now() / 1000)}:f>`;
  const icon = icon256(guild);
  const orderBtn = (group) => {
    const url = panelUrlFor(guild, group);
    return url ? btnRow([new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Order Sekarang').setEmoji('🛒').setURL(url)]) : null;
  };
  const stockBar = (left, total) => {
    const pct = total > 0 ? Math.max(0, Math.min(100, Math.round((left / total) * 100))) : 0;
    const f = Math.round(pct / 10);
    return `${'🟦'.repeat(f)}${'⬛'.repeat(10 - f)} \`${pct}%\``;
  };
  const statusBadge = (sp) => (sp && isProductOpen(sp) ? '`🟢 BUKA`' : '`🔴 TUTUP`');
  let card;

  if (kind === 'open') {
    const info = [];
    if (robuxIncluded) info.push(`**💎 Stock Robux:** \`${num(state.stock)} Robux\``, `**💱 Rate Visend:** \`${rupiah(robux ? rateOf(cfg, robux) : 0)} / Robux\``);
    for (const gp of gamepass) info.push(`**${gp.emoji || '🎟️'} Rate ${gp.label}:** \`${rupiah(rateOf(cfg, gp))} / Robux\``);
    for (const sp of slotProducts) info.push(`**${sp.emoji || '📦'} Slot ${sp.label}:** \`${num(stockOf(sp))} ${stockUnit(sp)}\``);
    const gallery = multiImages(products);
    card = pcard({
      accent: color(cfg, 'open', 0x2ecc71),
      thumb: single ? thumbOf(single) : gallery.length ? null : icon,
      images: gallery,
      header: `# 🟢 ${single ? single.label : name} Resmi Dibuka!\n-# ${name} • Store Update`,
      blocks: [
        single
          ? `Kabar baik! **${single.label}** sekarang **BUKA** dan siap melayani pesananmu ✨\nProses **cepat, aman & terpercaya** — dibantu admin sampai selesai.`
          : `Kabar baik! **${name}** sekarang **BUKA** dan siap melayani pesananmu ✨\n${listText}`,
        info.length ? `### 📊 Info Hari Ini\n${info.join('\n')}` : null,
        '### ⚡ Jangan Sampai Kehabisan\nStock terbatas — **siapa cepat dia dapat!** Klik tombol di bawah untuk langsung order. 🚀',
      ],
      footer: `${name} • Dibuka ${now}`,
      rows: [orderBtn(onlyDigital ? 'digital' : 'main')],
    });
  } else if (kind === 'close') {
    const left = [];
    if (robuxIncluded) left.push(`**💎 Sisa Stock Robux:** \`${num(state.stock)} Robux\``);
    for (const sp of slotProducts) left.push(`**${sp.emoji || '📦'} Sisa Slot ${sp.label}:** \`${num(stockOf(sp))} ${stockUnit(sp)}\``);
    const gallery = multiImages(products);
    card = pcard({
      accent: color(cfg, 'closed', 0xe74c3c),
      thumb: single ? thumbOf(single) : gallery.length ? null : icon,
      images: gallery,
      header: `# 🔴 ${single ? single.label : name} Sementara Ditutup\n-# ${name} • Store Update`,
      blocks: [
        extra.reason
          ? `${extra.reason}${single ? '' : `\n${listText}`}`
          : single
            ? `Terima kasih atas antusiasmenya! 🙏\n**${single.label}** saat ini **tidak menerima pesanan baru**.`
            : `Terima kasih atas antusiasmenya! 🙏\n**${name}** saat ini **tidak menerima pesanan baru**.\n${listText}`,
        left.length ? `### 📦 Sisa Stock\n${left.join('\n')}` : null,
        '### 🔔 Info Selanjutnya\nPesanan yang **sudah masuk tetap diproses** sampai selesai ✅\nPantau terus channel ini — kami kabari begitu **dibuka kembali**! 💙',
      ],
      footer: `${name} • Ditutup ${now}`,
    });
  } else if (kind === 'stock') {
    const sp = extra.product || robux;
    const unit = stockUnit(sp);
    const lines = [
      `**${sp?.type === 'boost' ? '🚀 Total Stock' : '📦 Stock Sekarang'}:** \`${num(stockOf(sp))} ${unit}\``,
      `**🏪 Status:** ${statusBadge(sp)}`,
      sp?.type === 'robux' ? `**💱 Rate:** \`${rupiah(rateOf(cfg, sp))} / Robux\`` : null,
    ].filter(Boolean);
    card = pcard({
      accent: color(cfg, 'brand', 0x3498db),
      thumb: icon,
      header: `# 📦 Stock ${sp?.label || 'Robux'} Diperbarui!\n-# ${name} • Stock Update`,
      thumbOverride: thumbOf(sp),
      blocks: [
        extra.text ? `${extra.text}\n${sp && isProductOpen(sp) ? 'Stock sudah siap — yuk langsung order! 🛒' : 'Order dibuka kembali segera, pantau terus ya! 🔔'}` : null,
        `### 📊 Detail Stock\n${lines.join('\n')}`,
        sp?.type === 'boost' ? `### 🚀 Stock per Paket\n${boostStockLines(sp) || '-'}` : null,
      ],
      footer: `${name} • Diperbarui ${now}`,
      rows: [sp && isProductOpen(sp) ? orderBtn(groupOf(sp)) : null],
    });
  } else if (kind === 'sold') {
    const sp = extra.product || robux;
    const unit = stockUnit(sp);
    const left = stockOf(sp);
    const sold = Number(extra.amount) || 0;
    const total = Math.max(Number(state.stockBase) || 0, left + sold);
    card = pcard({
      accent: color(cfg, 'brand', 0x3498db),
      thumb: icon,
      header: `# 🛒 ${sp?.label || 'Robux'} Baru Saja Terjual!\n-# ${name} • Live Sales`,
      thumbOverride: thumbOf(sp),
      blocks: [
        `🎉 ${extra.count > 1 ? `**${num(extra.count)} pesanan**` : '**Pesanan baru**'} masuk sebanyak **${num(sold)} ${unit}**!\nSisa stock tinggal **${num(left)} ${unit}** — amankan bagianmu sebelum kehabisan! 🔥`,
        [
          '### 📊 Ringkasan',
          `**📤 Terjual:** \`${num(sold)} ${unit}\` • **📦 Sisa:** \`${num(left)} ${unit}\``,
          sp?.type === 'robux' ? `**💱 Rate:** \`${rupiah(rateOf(cfg, sp))} / Robux\`` : null,
          `**📈 Ketersediaan:** ${stockBar(left, total)}`,
        ]
          .filter(Boolean)
          .join('\n'),
      ],
      footer: `${name} • ${now}`,
      rows: [orderBtn(groupOf(sp))],
    });
  } else if (kind === 'price') {
    // extra.product + extra.changes = [{ label, before, after, suffix }]
    const sp = extra.product;
    const changes = (extra.changes || []).filter((c) => Number(c.before) !== Number(c.after));
    const down = changes.length && changes.every((c) => c.after < c.before);
    const up = changes.length && changes.every((c) => c.after > c.before);
    const arrow = (c) => {
      if (c.after < c.before) return `⬇️ \`hemat ${Math.round(((c.before - c.after) / c.before) * 100)}%\``;
      return '⬆️';
    };
    const lines = changes.map((c) => `**${c.label}:** ~~${rupiah(c.before)}~~ ➜ **${rupiah(c.after)}${c.suffix || ''}** ${arrow(c)}`);
    const rate = sp && (sp.type === 'robux' || sp.type === 'gamepass') ? rateOf(cfg, sp) : 0;
    const examples = rate
      ? [100, 500, 1000].map((n) => `\`${num(n).padStart(5)} Robux\` ➜ **${rupiah(sp.type === 'gamepass' ? gpBeforeTax(sp, n) * rate : n * rate)}**`).join('\n')
      : null;
    card = pcard({
      accent: color(cfg, down ? 'open' : 'brand', down ? 0x2ecc71 : 0x3498db),
      thumb: thumbOf(sp),
      header: `# ${down ? `🔥 Harga ${sp?.label || ''} Turun!` : `💱 Harga ${sp?.label || ''} Diperbarui`}\n-# ${name} • Price Update`,
      blocks: [
        down
          ? `Kabar gembira! Harga **${sp?.label}** sekarang **lebih murah** 🎉\nWaktunya order sebelum kehabisan stock! 🛒`
          : `Harga **${sp?.label}** telah diperbarui.\nHarga baru **langsung berlaku** untuk pesanan berikutnya ✨`,
        `### 🏷️ Harga Baru\n${lines.join('\n') || '-'}`,
        examples ? `### 🧮 Contoh Harga${sp.type === 'gamepass' ? ' (Robux diterima)' : ''}\n${examples}` : null,
        [`**🏪 Status:** ${statusBadge(sp)}`, hasStock(sp) ? `**📦 Stock:** \`${num(stockOf(sp))} ${stockUnit(sp)}\`` : null].filter(Boolean).join('\n'),
        '-# Pesanan yang sudah berjalan tetap memakai harga sebelumnya.',
      ],
      footer: `${name} • Diperbarui ${now}`,
      rows: [sp && isProductOpen(sp) ? orderBtn(groupOf(sp)) : null],
    });
  } else if (kind === 'returned') {
    const t = extra.ticket;
    const sp = (cfg.products || []).find((x) => x.id === t.productId) || robux;
    const unit = stockUnit(sp);
    const qty = kindOf(t) === 'robux' ? t.amount : Number(t.qty) || 1;
    card = pcard({
      accent: color(cfg, 'refund', 0xe67e22),
      thumb: icon,
      header: `# ♻️ Stock ${sp?.label || t.productLabel} Kembali Tersedia!\n-# ${name} • Stock Update`,
      thumbOverride: thumbOf(sp),
      blocks: [
        `Pesanan \`${t.id}\` ${t.status === 'refund' ? '**di-refund**' : '**dibatalkan**'} — stock dikembalikan ke toko${sp && isProductOpen(sp) ? ' dan **bisa dipesan lagi**! ✨' : '. 🔔'}`,
        [
          '### 📊 Detail Stock',
          `**♻️ Stock Kembali:** \`+${num(qty)} ${unit}\`${kindOf(t) === 'boost' && t.plan ? ` • ${t.plan.label}` : ''}`,
          `**📦 Stock Sekarang:** \`${num(stockOf(sp))} ${unit}\``,
          `**🏪 Status:** ${statusBadge(sp)}`,
        ].join('\n'),
      ],
      footer: `${name} • ${now}`,
      rows: [sp && isProductOpen(sp) ? orderBtn(groupOf(sp)) : null],
    });
  }
  if (!card) return null;
  if (files.length) card.files = files;
  if (ping) {
    card.components.unshift(v2Text('@everyone'));
    card.allowedMentions = { parse: ['everyone'] };
  }
  return card;
}

// ═════════════════════════════════════ REKBER ═════════════════════════════════════
/** Hitung fee rekber dari tabel fee di store.json. */
function rekberFee(product, nominal) {
  const tiers = product.feeTiers || [];
  const tier = tiers.find((x) => x.upTo == null || nominal <= x.upTo) || tiers.at(-1) || { fee: 0 };
  const fee = tier.percent != null ? Math.ceil((nominal * tier.percent) / 100) : Number(tier.fee) || 0;
  const byBuyer = (product.feePaidBy || 'pembeli') !== 'penjual';
  return { fee, buyerPays: byBuyer ? nominal + fee : nominal, sellerGets: byBuyer ? nominal : nominal - fee, byBuyer };
}

function feeTable(product) {
  return (product.feeTiers || [])
    .map((x) => {
      const range = x.upTo == null ? 'Di atas itu' : `≤ ${rupiah(x.upTo)}`;
      const fee = x.percent != null ? `${x.percent}% dari nominal` : rupiah(x.fee);
      return `▸ ${range} — **${fee}**`;
    })
    .join('\n');
}

function buildRekberInfo(guild, cfg, product) {
  const open = isProductOpen(product);
  const s = state.stats;
  const embed = new EmbedBuilder()
    .setColor(color(cfg, 'brand', 0x3498db))
    .setTitle(`${product.emoji || '🤝'} ${product.label} — Rekening Bersama`)
    .setDescription(fill(product.description || '', { name: storeName(cfg, guild) }) || null)
    .setThumbnail(guild.iconURL({ extension: 'png', size: 256 }) || null)
    .addFields(
      { name: '🧾 Fee Rekber', value: feeTable(product) || '-', inline: false },
      {
        name: '💵 Nominal Transaksi',
        value: `\`${rupiah(product.minNominal || 0)} – ${rupiah(product.maxNominal || 0)}\``,
        inline: true,
      },
      { name: '💳 Fee Ditanggung', value: `\`${(product.feePaidBy || 'pembeli') === 'penjual' ? 'Penjual' : 'Pembeli'}\``, inline: true },
      { name: '🏪 Status', value: open ? '`🟢 BUKA`' : '`🔴 TUTUP`', inline: true },
      { name: '🤝 Rekber Sukses', value: `\`${num(s.rekber)} transaksi\``, inline: true },
      { name: '🛡️ Dana Diamankan', value: `\`${rupiah(s.rekberVolume)}\``, inline: true },
    );

  const buttons = [
    new ButtonBuilder()
      .setCustomId(`store:order:${product.id}`)
      .setLabel(open ? 'Buat Ticket Rekber' : 'Rekber Sedang Tutup')
      .setEmoji('🤝')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!open),
  ];
  if (product.terms?.description) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`store:terms:${product.id}`)
        .setLabel(product.terms.button || 'Syarat & Ketentuan')
        .setEmoji('📌')
        .setStyle(ButtonStyle.Secondary),
    );
  }
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(buttons)] };
}

function rekberMoneyFields(t) {
  return [
    { name: '💵 Nominal Transaksi', value: `\`${rupiah(t.nominal)}\``, inline: true },
    { name: '🧾 Fee Rekber', value: `\`${rupiah(t.fee)}\`\n┗ ditanggung ${t.feeByBuyer ? 'pembeli' : 'penjual'}`, inline: true },
    { name: '\u200b', value: '\u200b', inline: true },
    { name: '💳 Transfer Pembeli ke Admin', value: `## ${rupiah(t.buyerPays)}`, inline: true },
    { name: '💰 Dana Diterima Penjual', value: `## ${rupiah(t.sellerGets)}`, inline: true },
  ];
}

/** Ringkasan sebelum ticket rekber dibuat (hanya terlihat pembuat). */
function buildRekberConfirm(guild, cfg, d) {
  const embed = new EmbedBuilder()
    .setColor(color(cfg, 'brand', 0x3498db))
    .setTitle('🤝 Konfirmasi Transaksi Rekber')
    .setDescription('Periksa kembali detail transaksi di bawah. Pastikan **pihak lawan** dan **nominal** sudah benar sebelum membuat ticket.')
    .addFields(
      { name: '🛒 Pembeli', value: `<@${d.buyerId}>`, inline: true },
      { name: '🏷️ Penjual', value: `<@${d.sellerId}>`, inline: true },
      { name: '📦 Objek Transaksi', value: d.item.slice(0, 1024), inline: false },
      ...rekberMoneyFields(d),
    );
  if (d.detail) embed.addFields({ name: '📝 Detail', value: d.detail.slice(0, 1024) });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('store:rbconfirm:yes').setLabel('Ya, Buat Ticket Rekber').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('store:rbconfirm:no').setLabel('Batalkan').setEmoji('✖️').setStyle(ButtonStyle.Danger),
  );
  return { embeds: [embed], components: [row], allowedMentions: { parse: [] } };
}

function rekberSteps(t) {
  const st = t.stage || {};
  const done = t.status === 'completed';
  const mark = (ok, current) => (ok ? '✅' : current ? '⏳' : '▫️');
  const rows = [
    [st.agreed, `<@${t.partnerId}> menyetujui transaksi`],
    [st.funded, `Pembeli transfer **${rupiah(t.buyerPays)}** ke admin & admin konfirmasi dana`],
    [st.received, 'Penjual mengirim barang / jasa & pembeli konfirmasi sudah diterima'],
    [done, `Admin mencairkan **${rupiah(t.sellerGets)}** ke penjual`],
  ];
  const currentIdx = rows.findIndex((r) => !r[0]);
  return rows.map((r, i) => `${mark(r[0], t.status === 'open' && i === currentIdx)} \`${i + 1}\` ${r[1]}`).join('\n');
}

function buildRekberTicket(guild, cfg, t) {
  const product = (cfg.products || []).find((p) => p.id === t.productId) || {};
  const st = t.stage || {};
  const statusColor = {
    open: color(cfg, 'brand', 0x3498db),
    completed: color(cfg, 'open', 0x2ecc71),
    cancelled: color(cfg, 'closed', 0xe74c3c),
    refund: color(cfg, 'refund', 0xe67e22),
  }[t.status];

  const main = new EmbedBuilder()
    .setColor(statusColor)
    .setAuthor({ name: `${storeName(cfg, guild)} • Rekening Bersama`, iconURL: guild.iconURL({ size: 128 }) || undefined })
    .setTitle(`🤝 Ticket Rekber • ${t.id}`)
    .setDescription(
      `Transaksi antara <@${t.buyerId}> dan <@${t.sellerId}> kini **diamankan oleh ${storeName(cfg, guild)}**. 🛡️\n` +
        'Dana pembeli ditahan admin dan **baru diteruskan ke penjual setelah barang / jasa diterima**.',
    )
    .addFields(
      { name: '🛒 Pembeli', value: `<@${t.buyerId}>`, inline: true },
      { name: '🏷️ Penjual', value: `<@${t.sellerId}>`, inline: true },
      { name: '🙋 Dibuat oleh', value: `<@${t.userId}>`, inline: true },
      { name: '📦 Objek Transaksi', value: t.item.slice(0, 1024), inline: false },
    );
  if (t.detail) main.addFields({ name: '📝 Detail', value: t.detail.slice(0, 1024), inline: false });
  main
    .addFields(...rekberMoneyFields(t))
    .addFields(
      { name: '📍 Progress Transaksi', value: rekberSteps(t), inline: false },
      { name: '📌 Status', value: `**${REKBER_STATUS[t.status]}**`, inline: true },
      { name: '🕒 Dibuat', value: ts(t.createdAt, 'f'), inline: true },
    )
    .setThumbnail(guild.iconURL({ extension: 'png', size: 256 }) || null)
    .setFooter(serverFooter(guild, `${storeName(cfg, guild)} • Rekber ${t.id}`))
    .setTimestamp(t.closedAt || t.createdAt);
  if (t.closedAt) main.addFields({ name: '🔒 Ditutup', value: `${ts(t.closedAt, 'f')} oleh <@${t.closedBy}>`, inline: true });

  const embeds = [main];
  if (st.agreed) embeds.push(...paymentEmbeds(guild, cfg, t)); // rekening admin muncul setelah transaksi disetujui
  if (t.status === 'open' && product.guide) {
    embeds.push(
      new EmbedBuilder()
        .setColor(color(cfg, 'brand', 0x3498db))
        .setTitle(product.guideTitle || '🛡️ Alur Rekber')
        .setDescription(fill(product.guide, { name: storeName(cfg, guild) }).slice(0, 4096)),
    );
  }

  const components =
    t.status === 'open'
      ? [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`store:rbagree:${t.id}`)
              .setLabel(st.agreed ? 'Disetujui' : 'Setujui Transaksi')
              .setEmoji('🤝')
              .setStyle(ButtonStyle.Success)
              .setDisabled(Boolean(st.agreed)),
            new ButtonBuilder()
              .setCustomId(`store:rbfund:${t.id}`)
              .setLabel(st.funded ? 'Dana Diterima' : 'Konfirmasi Dana (Admin)')
              .setEmoji('💰')
              .setStyle(ButtonStyle.Primary)
              .setDisabled(!st.agreed || Boolean(st.funded)),
            new ButtonBuilder()
              .setCustomId(`store:rbrecv:${t.id}`)
              .setLabel(st.received ? 'Barang Diterima' : 'Barang Sudah Diterima')
              .setEmoji('📦')
              .setStyle(ButtonStyle.Primary)
              .setDisabled(!st.funded || Boolean(st.received)),
            new ButtonBuilder().setCustomId(`store:close:${t.id}`).setLabel('Tutup Ticket').setEmoji('🔒').setStyle(ButtonStyle.Danger),
          ),
          ...(st.agreed ? paymentRows(t) : []),
        ]
      : [];
  return { embeds, components };
}

function buildRekberDmCreated(guild, cfg, t, channelUrl, forUserId) {
  const role = forUserId === t.buyerId ? 'Pembeli' : 'Penjual';
  const embed = new EmbedBuilder()
    .setColor(color(cfg, 'brand', 0x3498db))
    .setTitle('🤝 Ticket Rekber Berhasil Dibuat')
    .setDescription(
      `Kamu terdaftar sebagai **${role}** dalam transaksi rekber di **${storeName(cfg, guild)}**.\n\n` +
        `Silakan lanjutkan ke channel ticket rekber untuk memproses transaksi:\n${channelUrl}`,
    )
    .addFields(
      { name: '🤝 Ticket ID', value: `\`${t.id}\``, inline: true },
      { name: '📦 Objek', value: `\`${t.item.slice(0, 80)}\``, inline: true },
      { name: '💵 Nominal', value: `\`${rupiah(t.nominal)}\``, inline: true },
    )
    .setThumbnail(guild.iconURL({ extension: 'png', size: 256 }) || null)
    .setFooter(serverFooter(guild, storeName(cfg, guild)))
    .setTimestamp(new Date());
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Buka Ticket Rekber').setEmoji('🤝').setURL(channelUrl),
  );
  return { embeds: [embed], components: [row] };
}

function buildRekberDmClosed(guild, cfg, t) {
  const name = storeName(cfg, guild);
  const titles = {
    completed: '✅ Transaksi Rekber Selesai',
    cancelled: '❌ Transaksi Rekber Dibatalkan',
    refund: '💸 Transaksi Rekber Di-refund',
  };
  const desc = {
    completed: `Transaksi rekber **${t.id}** telah selesai dan dana sudah dicairkan ke penjual. Terima kasih telah mempercayakan transaksimu kepada **${name}**! 🛡️`,
    cancelled: `Transaksi rekber **${t.id}** di **${name}** telah dibatalkan.`,
    refund: `Transaksi rekber **${t.id}** di-refund — dana telah dikembalikan ke pembeli.`,
  };
  const embed = new EmbedBuilder()
    .setColor(t.status === 'completed' ? color(cfg, 'open', 0x2ecc71) : color(cfg, 'refund', 0xe67e22))
    .setTitle(titles[t.status])
    .setDescription(desc[t.status] + (t.note ? `\n\n📝 Catatan admin: ${t.note}` : ''))
    .addFields(
      { name: '🤝 Ticket ID', value: `\`${t.id}\``, inline: true },
      { name: '📦 Objek', value: `\`${t.item.slice(0, 80)}\``, inline: true },
      { name: '💵 Nominal', value: `\`${rupiah(t.nominal)}\``, inline: true },
    )
    .setFooter(serverFooter(guild, name))
    .setTimestamp(new Date());
  if (t.proofUrl && t.status === 'completed') embed.setImage(t.proofUrl);
  return { embeds: [embed] };
}

function buildRekberTestimonyPrompt(guild, cfg, t) {
  const embed = new EmbedBuilder()
    .setColor(color(cfg, 'brand', 0x3498db))
    .setTitle('⭐ Bagaimana Pengalaman Rekber-mu?')
    .setDescription(
      `<@${t.buyerId}>, transaksi rekber **${t.id}** sudah selesai! 🎉\n\n` +
        'Bantu kami jadi lebih baik dengan memberikan **rating & testimoni** lewat tombol di bawah.',
    )
    .setFooter(serverFooter(guild, storeName(cfg, guild)));
  if (t.proofUrl) embed.setImage(t.proofUrl);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`store:testi:${t.id}`).setLabel('Beri Testimoni').setEmoji('⭐').setStyle(ButtonStyle.Primary),
  );
  return { content: `<@${t.buyerId}>`, embeds: [embed], components: [row], allowedMentions: { users: [t.buyerId] } };
}

function buildRekberTestimony(guild, cfg, t, buyer) {
  const r = t.testimony;
  const embed = new EmbedBuilder()
    .setColor(color(cfg, 'brand', 0x3498db))
    .setTitle(`🧾 Testimoni #${String(state.stats.testimonies).padStart(4, '0')}`)
    .setDescription(
      r
        ? `**Rating:** ${STARS(r.rating)}  **${r.rating}/5**\n\n>>> ${r.comment}`
        : '✅ **Rekber Berhasil**\n\n_Pembeli tidak memberikan ulasan._',
    )
    .addFields(
      { name: '🤝 Layanan', value: '`Rekber`', inline: true },
      { name: '🛒 Pembeli', value: `<@${t.buyerId}>`, inline: true },
      { name: '🏷️ Penjual', value: `<@${t.sellerId}>`, inline: true },
      { name: '📦 Objek', value: `\`${t.item.slice(0, 100)}\``, inline: true },
      { name: '💵 Nominal', value: `\`${rupiah(t.nominal)}\``, inline: true },
      { name: '🎫 Ticket', value: `\`${t.id}\``, inline: true },
    )
    .setThumbnail(buyer?.displayAvatarURL({ extension: 'png', size: 256 }) || null)
    .setFooter(serverFooter(guild, storeName(cfg, guild)))
    .setTimestamp(new Date());
  if (t.proofUrl) embed.setImage(t.proofUrl);
  return { embeds: [embed], allowedMentions: { parse: [] } };
}


/**
 * Embed pemberitahuan setiap langkah rekber (dikirim di dalam ticket).
 * step: 'invite' | 'agreed' | 'funded' | 'received'
 */
function buildRekberStep(guild, cfg, t, step) {
  const name = storeName(cfg, guild);
  const e = new EmbedBuilder()
    .setColor(color(cfg, 'brand', 0x3498db))
    .setFooter(serverFooter(guild, `${name} • Rekber ${t.id}`))
    .setTimestamp(new Date());
  let ping = [];

  if (step === 'invite') {
    const role = t.partnerId === t.buyerId ? '🛒 Pembeli' : '🏷️ Penjual';
    ping = [t.partnerId];
    e.setTitle('📨 Undangan Transaksi Rekber')
      .setDescription(
        `Halo <@${t.partnerId}>, kamu diundang oleh <@${t.userId}> untuk melakukan transaksi melalui layanan **Rekber ${name}**. 🛡️\n\n` +
          'Mohon periksa kembali seluruh detail transaksi di atas dengan teliti. Apabila semuanya sudah **sesuai kesepakatan**, ' +
          'klik **🤝 Setujui Transaksi** untuk memulai proses rekber.',
      )
      .addFields(
        { name: '🎭 Peranmu', value: `\`${role.replace(/^\S+\s/, '')}\``, inline: true },
        { name: '📦 Objek', value: `\`${t.item.slice(0, 80)}\``, inline: true },
        { name: '💵 Nominal', value: `\`${rupiah(t.nominal)}\``, inline: true },
        { name: '⏭️ Langkah Selanjutnya', value: `<@${t.partnerId}> menyetujui transaksi.` },
      );
  } else if (step === 'agreed') {
    ping = [t.buyerId];
    e.setTitle('🤝 Transaksi Resmi Disetujui')
      .setDescription(
        `<@${t.partnerId}> telah **menyetujui** transaksi ini. Kesepakatan kini **resmi berjalan** dan diawasi penuh oleh **${name}**. ✨`,
      )
      .addFields(
        { name: '📍 Progress', value: '`✅ Disetujui` ➜ `⏳ Pembayaran` ➜ `▫️ Pengiriman` ➜ `▫️ Pencairan`' },
        {
          name: '💳 Langkah Selanjutnya — Pembeli',
          value:
            `<@${t.buyerId}>, silakan transfer sebesar **${rupiah(t.buyerPays)}** ke rekening admin sesuai instruksi, ` +
            'lalu kirimkan **bukti transfer** di ticket ini.',
        },
        { name: '⚠️ Penting', value: '**Jangan** mentransfer dana langsung ke penjual. Seluruh dana wajib melalui admin.' },
      );
  } else if (step === 'funded') {
    ping = [t.sellerId, t.buyerId];
    e.setTitle('💰 Dana Telah Diamankan')
      .setDescription(
        `Admin <@${t.stage.fundedBy}> telah mengonfirmasi bahwa dana sebesar **${rupiah(t.buyerPays)}** dari <@${t.buyerId}> ` +
          `**sudah diterima** dan kini **ditahan dengan aman** oleh **${name}**. 🛡️`,
      )
      .addFields(
        { name: '📍 Progress', value: '`✅ Disetujui` ➜ `✅ Pembayaran` ➜ `⏳ Pengiriman` ➜ `▫️ Pencairan`' },
        {
          name: '📦 Langkah Selanjutnya — Penjual',
          value: `<@${t.sellerId}>, silakan kirimkan barang / jasa kepada pembeli sesuai kesepakatan dan lampirkan **bukti pengiriman** di ticket ini.`,
        },
        {
          name: '🔔 Untuk Pembeli',
          value: `<@${t.buyerId}>, klik **📦 Barang Sudah Diterima** hanya setelah barang / jasa **benar-benar kamu terima** dan sesuai kesepakatan.`,
        },
      );
  } else if (step === 'received') {
    ping = [t.sellerId];
    e.setColor(color(cfg, 'open', 0x2ecc71))
      .setTitle('📦 Barang Telah Diterima')
      .setDescription(
        `<@${t.buyerId}> telah mengonfirmasi bahwa barang / jasa **diterima dengan baik** dan sesuai kesepakatan. 🎉`,
      )
      .addFields(
        { name: '📍 Progress', value: '`✅ Disetujui` ➜ `✅ Pembayaran` ➜ `✅ Pengiriman` ➜ `⏳ Pencairan`' },
        {
          name: '🏦 Langkah Terakhir — Admin',
          value: `Admin akan segera mencairkan dana sebesar **${rupiah(t.sellerGets)}** kepada <@${t.sellerId}>, lalu menutup ticket ini.`,
        },
      );
  }
  return {
    content: ping.map((id) => `<@${id}>`).join(' ') || undefined,
    embeds: [e],
    allowedMentions: { users: ping },
  };
}

/** Ucapan terima kasih setelah pembeli memberi testimoni. */
function buildTestimonyThanks(guild, cfg, t, rating, seconds) {
  const uid = testimonyUserId(t);
  return {
    embeds: [
      new EmbedBuilder()
        .setColor(color(cfg, 'brand', 0x3498db))
        .setTitle('💜 Terima Kasih atas Testimonimu!')
        .setDescription(
          `<@${uid}>, rating ${STARS(rating)} **${rating}/5** darimu sudah kami terima dan kini tampil di channel testimoni.\n\n` +
            `Dukunganmu sangat berarti bagi **${storeName(cfg, guild)}**. Sampai jumpa di transaksi berikutnya! ✨`,
        )
        .addFields({ name: '🔒 Ticket Ditutup Otomatis', value: `Channel ini akan dihapus dalam **${seconds} detik**.` })
        .setFooter(serverFooter(guild, storeName(cfg, guild)))
        .setTimestamp(new Date()),
    ],
    allowedMentions: { parse: [] },
  };
}


// ═════════════════════════════════════ ROBUX GAMEPASS ═════════════════════════════════════
const KEYCAPS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
const gpUrl = (id) => `https://www.roblox.com/game-pass/${id}`;
const taxOf = (product) => Math.min(Math.max(Number(product?.taxPercent ?? 30), 0), 99);

/** Robux yang diterima pembeli dari harga gamepass (setelah dipotong pajak Roblox). */
function gpAfterTax(product, before) {
  return Math.floor((before * (100 - taxOf(product))) / 100);
}
/** Harga gamepass (Before Tax) supaya pembeli menerima `after` Robux. */
function gpBeforeTax(product, after) {
  return Math.ceil((after * 100) / (100 - taxOf(product)));
}
/** Hitung semua angka order gamepass dari harga gamepass (Before Tax). */
function gpQuote(cfg, product, before) {
  const rate = rateOf(cfg, product);
  const after = gpAfterTax(product, before);
  return { before, after, tax: before - after, rate, price: before * rate };
}
const gpEstimate = (product) => `Robux masuk dalam **${num(product.pendingDays || 5)} hari** setelah pembayaran.`;

function gpExamples(cfg, product) {
  const rows = (product.examples || []).map((after) => {
    const q = gpQuote(cfg, product, gpBeforeTax(product, after));
    return [`${num(after)} Robux`, rupiah(q.price)];
  });
  if (!rows.length) return null;
  const w = Math.max(...rows.map((r) => r[0].length));
  return '```\n' + rows.map(([a, b]) => `${a.padStart(w)}  ➜  ${b}`).join('\n') + '\n```';
}

function gpButtons(product, { order = true, price = true, tax = true, tutorial = true, terms = true } = {}) {
  const open = isProductOpen(product);
  const b = [];
  if (order) {
    b.push(
      new ButtonBuilder()
        .setCustomId(`store:order:${product.id}`)
        .setLabel(open ? 'Order Sekarang' : 'Sedang Tutup')
        .setEmoji('🛒')
        .setStyle(ButtonStyle.Success)
        .setDisabled(!open),
    );
  }
  if (price) b.push(new ButtonBuilder().setCustomId(`store:gpprice:${product.id}`).setLabel('Cek Harga').setEmoji('💰').setStyle(ButtonStyle.Primary));
  if (tax) b.push(new ButtonBuilder().setCustomId(`store:gptax:${product.id}`).setLabel('Tax Calculator').setEmoji('🧮').setStyle(ButtonStyle.Primary));
  if (tutorial) b.push(new ButtonBuilder().setCustomId(`store:gptutor:${product.id}`).setLabel('Tutorial').setEmoji('📖').setStyle(ButtonStyle.Secondary));
  if (terms && product.terms?.description) {
    b.push(
      new ButtonBuilder()
        .setCustomId(`store:terms:${product.id}`)
        .setLabel(product.terms.button || 'Syarat')
        .setEmoji('📌')
        .setStyle(ButtonStyle.Secondary),
    );
  }
  return b.slice(0, 5);
}

/** Info produk Robux Gamepass (hanya terlihat pembeli). */
function buildGamepassInfo(guild, cfg, product) {
  const open = isProductOpen(product);
  const s = state.stats;
  const ps = productStatsOf(product.id);
  const avg = s.ratingCount ? (s.ratingSum / s.ratingCount).toFixed(1) : '-';
  const embed = new EmbedBuilder()
    .setColor(color(cfg, 'brand', 0x3498db))
    .setTitle(`${product.emoji || '🎟️'} ${product.label}`)
    .setDescription(fill(product.description || '', { name: storeName(cfg, guild) }) || null)
    .setThumbnail(guild.iconURL({ extension: 'png', size: 256 }) || null)
    .addFields(
      { name: '💱 Rate', value: `\`${rupiah(rateOf(cfg, product))} / Robux\``, inline: true },
      { name: '⏱️ Estimasi', value: `\`± ${num(product.pendingDays || 5)} hari\``, inline: true },
      { name: '🏪 Status', value: open ? '`🟢 BUKA`' : '`🔴 TUTUP`', inline: true },
    );
  const ex = gpExamples(cfg, product);
  if (ex) embed.addFields({ name: '📊 Contoh Harga (After Tax)', value: ex });
  const notes = (product.notes || []).map((n) => `▸ ${fill(n, { name: storeName(cfg, guild) })}`);
  notes.push(`▸ ⏳ ${gpEstimate(product)}`);
  embed.addFields(
    { name: '📝 Catatan', value: notes.join('\n').slice(0, 1024) },
    { name: '🧾 Transaksi Gamepass', value: `\`${num(ps.orders)} transaksi\``, inline: true },
    { name: '💎 Robux Terkirim', value: `\`${num(ps.robux)} Robux\``, inline: true },
    { name: '⭐ Rating Pembeli', value: `\`${avg} / 5 (${num(s.ratingCount)} ulasan)\``, inline: true },
  );
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(gpButtons(product))] };
}

/** Tutorial order Robux Gamepass. */
function buildGamepassTutorial(guild, cfg, product) {
  const tu = product.tutorial || {};
  const steps = (tu.steps || []).map((x, i) => `${KEYCAPS[i] || `\`${i + 1}\``} ${x}`).join('\n\n');
  const embed = new EmbedBuilder()
    .setColor(color(cfg, 'brand', 0x3498db))
    .setTitle(tu.title || `📖 Tutorial Order ${product.label}`)
    .setDescription(
      `${fill(tu.intro || `Ikuti langkah berikut agar order **${product.label}** kamu berjalan lancar:`, { name: storeName(cfg, guild) })}\n\n${steps}`.slice(0, 4096),
    )
    .setThumbnail(guild.iconURL({ extension: 'png', size: 256 }) || null);
  if (tu.tips?.length) embed.addFields({ name: '💡 Tips Penting', value: tu.tips.map((x) => `▸ ${x}`).join('\n').slice(0, 1024) });
  embed.addFields({
    name: '🧮 Rumus Pajak Roblox',
    value: `Roblox memotong **${taxOf(product)}%** dari setiap penjualan gamepass.\n\`Before Tax = Robux diterima ÷ ${(100 - taxOf(product)) / 100}\` (dibulatkan ke atas)`,
  });

  const row1 = new ActionRowBuilder().addComponents(gpButtons(product, { tutorial: false, terms: false }));
  const links = [];
  if (tu.creatorHubUrl !== '') {
    links.push(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel('Buka Creator Hub')
        .setEmoji('🛠️')
        .setURL(tu.creatorHubUrl || 'https://create.roblox.com/dashboard/creations'),
    );
  }
  if (tu.videoUrl) links.push(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Video Tutorial').setEmoji('🎬').setURL(tu.videoUrl));
  const components = [row1];
  if (links.length) components.push(new ActionRowBuilder().addComponents(links));
  return { embeds: [embed], components };
}

/**
 * Hasil kalkulator (hanya terlihat pembeli).
 * mode 'price' → input = harga gamepass (Before Tax)
 * mode 'tax'   → input = Robux yang ingin diterima (After Tax)
 */
function buildGamepassCalc(guild, cfg, product, mode, input) {
  const before = mode === 'tax' ? gpBeforeTax(product, input) : input;
  const q = gpQuote(cfg, product, before);
  const min = Number(product.minAmount) || 1;
  const max = Number(product.maxAmount) || Infinity;
  const e = new EmbedBuilder().setColor(color(cfg, 'brand', 0x3498db)).setThumbnail(guild.iconURL({ extension: 'png', size: 256 }) || null);

  if (mode === 'tax') {
    e.setTitle('🧮 Tax Calculator Roblox')
      .setDescription(
        `Agar kamu menerima **${num(q.after)} Robux**, set harga gamepass ke:\n## 🎟️ ${num(q.before)} Robux\n` +
          `_Roblox memotong pajak **${taxOf(product)}%** dari setiap penjualan gamepass._`,
      )
      .addFields(
        { name: '💎 Robux Diterima', value: `\`${num(q.after)} Robux\``, inline: true },
        { name: '🎟️ Before Tax', value: `\`${num(q.before)} Robux\``, inline: true },
        { name: `🏛️ Pajak Roblox (${taxOf(product)}%)`, value: `\`${num(q.tax)} Robux\``, inline: true },
        { name: '💰 Total Harga', value: `## ${rupiah(q.price)}\n\`${num(q.before)} × ${rupiah(q.rate)}\`` },
      );
  } else {
    e.setTitle(`💰 Cek Harga ${product.label}`)
      .setDescription(`Perhitungan harga untuk gamepass seharga **${num(q.before)} Robux** (Before Tax).`)
      .addFields(
        { name: '🎟️ Harga Gamepass (Before Tax)', value: `\`${num(q.before)} Robux\``, inline: true },
        { name: '💎 Robux Diterima (After Tax)', value: `\`${num(q.after)} Robux\``, inline: true },
        { name: '💱 Rate', value: `\`${rupiah(q.rate)} / Robux\``, inline: true },
        { name: '💰 Total Harga', value: `## ${rupiah(q.price)}\n\`${num(q.before)} × ${rupiah(q.rate)}\`` },
      );
  }
  if (q.after < min || q.after > max) {
    e.addFields({
      name: '⚠️ Di Luar Batas Order',
      value: `Order **${product.label}** hanya untuk **${num(min)} – ${num(max)} Robux diterima** (After Tax).`,
    });
  }
  e.setFooter({ text: `⏳ Estimasi: Robux masuk ± ${num(product.pendingDays || 5)} hari setelah pembayaran` });

  const again = new ButtonBuilder()
    .setCustomId(`store:${mode === 'tax' ? 'gptax' : 'gpprice'}:${product.id}`)
    .setLabel('Hitung Lagi')
    .setEmoji('🔁')
    .setStyle(ButtonStyle.Secondary);
  const buttons = gpButtons(product, { price: mode === 'tax', tax: mode !== 'tax', tutorial: false, terms: false });
  return { embeds: [e], components: [new ActionRowBuilder().addComponents(...buttons, again)] };
}

/** Ringkasan order gamepass sebelum ticket dibuat (hanya terlihat pembeli). */
function buildGamepassConfirm(guild, cfg, product, d) {
  const gp = d.gamepass;
  const e = new EmbedBuilder()
    .setColor(color(cfg, 'brand', 0x3498db))
    .setAuthor({ name: `${d.roblox.displayName} (@${d.roblox.name})`, iconURL: d.roblox.avatar || undefined, url: `https://www.roblox.com/users/${d.roblox.id}/profile` })
    .setTitle(`🔍 Konfirmasi Order ${product.label}`)
    .setDescription('Periksa kembali detail di bawah. Pastikan **gamepass** dan **harganya** sudah benar sebelum membuat ticket.')
    .addFields(
      { name: '🎮 Akun Roblox', value: `[${d.roblox.displayName}](https://www.roblox.com/users/${d.roblox.id}/profile)\n\`@${d.roblox.name}\``, inline: true },
      { name: '🎟️ Gamepass', value: `[${gp.name}](${gpUrl(gp.id)})\n\`ID ${gp.id}\``, inline: true },
      {
        name: '✅ Verifikasi',
        value: gp.verified ? '`🟢 Terverifikasi otomatis`' : '`🟡 Dicek manual oleh admin`',
        inline: true,
      },
      { name: '🎟️ Harga Gamepass (Before Tax)', value: `\`${num(d.before)} Robux\``, inline: true },
      { name: '💎 Robux Diterima (After Tax)', value: `\`${num(d.after)} Robux\``, inline: true },
      { name: '💱 Rate', value: `\`${rupiah(d.rate)} / Robux\``, inline: true },
      { name: '💰 Total Bayar', value: `## ${rupiah(d.price)}\n\`${num(d.before)} × ${rupiah(d.rate)}\`` },
      { name: '⏳ Estimasi', value: gpEstimate(product) },
    );
  if (d.warnings?.length) e.addFields({ name: '⚠️ Perhatian', value: d.warnings.map((w) => `▸ ${w}`).join('\n').slice(0, 1024) });
  if (gp.icon) e.setThumbnail(gp.icon);
  else if (d.roblox.avatar) e.setThumbnail(d.roblox.avatar);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('store:gpconfirm:yes').setLabel('Ya, Buat Ticket').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Lihat Gamepass').setEmoji('🔗').setURL(gpUrl(gp.id)),
    new ButtonBuilder().setCustomId('store:gpconfirm:no').setLabel('Batalkan').setEmoji('✖️').setStyle(ButtonStyle.Danger),
  );
  return { embeds: [e], components: [row] };
}

/** Isi ticket order Robux Gamepass. */
function buildGamepassTicket(guild, cfg, t) {
  const gp = t.gamepass;
  const name = storeName(cfg, guild);
  const statusColor = {
    open: color(cfg, 'brand', 0x3498db),
    completed: color(cfg, 'open', 0x2ecc71),
    cancelled: color(cfg, 'closed', 0xe74c3c),
    refund: color(cfg, 'refund', 0xe67e22),
  }[t.status];

  const info = new EmbedBuilder()
    .setColor(statusColor)
    .setAuthor({ name: `${name} • ${t.productLabel}`, iconURL: guild.iconURL({ size: 128 }) || undefined })
    .setTitle(`🧾 Detail Pesanan • ${t.id}`)
    .setDescription(`Halo <@${t.userId}>, terima kasih sudah berbelanja di **${name}**! 💜`)
    .addFields(
      { name: '👤 Pembeli', value: `<@${t.userId}>`, inline: true },
      {
        name: '🎮 Akun Roblox',
        value: `[${t.roblox.displayName}](https://www.roblox.com/users/${t.roblox.id}/profile)\n\`@${t.roblox.name}\``,
        inline: true,
      },
      { name: '🆔 Roblox ID', value: `\`${t.roblox.id}\``, inline: true },
      { name: '🎟️ Gamepass', value: `[${gp.name}](${gpUrl(gp.id)})`, inline: true },
      { name: '🔢 Gamepass ID', value: `\`${gp.id}\``, inline: true },
      { name: '✅ Verifikasi', value: gp.verified ? '`🟢 Otomatis`' : '`🟡 Manual`', inline: true },
      { name: '🎟️ Harga Gamepass', value: `\`${num(t.before)} Robux\`\n┗ Before Tax`, inline: true },
      { name: '💎 Robux Diterima', value: `\`${num(t.amount)} Robux\`\n┗ After Tax`, inline: true },
      { name: '💱 Rate', value: `\`${rupiah(t.rate)} / Robux\``, inline: true },
      { name: '💰 Total Bayar', value: `## ${rupiah(t.price)}`, inline: false },
      { name: '📌 Status', value: `**${ticketStatusText(t)}**`, inline: true },
      { name: '💳 Pembayaran', value: payStatusText(t), inline: true },
      { name: '🕒 Dibuat', value: ts(t.createdAt, 'f'), inline: true },
    )
    .setFooter(serverFooter(guild, `${name} • Ticket ${t.id}`))
    .setTimestamp(t.closedAt || t.createdAt);
  if (gp.icon) info.setThumbnail(gp.icon);
  else if (t.roblox.avatar) info.setThumbnail(t.roblox.avatar);
  if (t.status === 'open') info.addFields({ name: '⏳ Estimasi', value: `± **${num(t.pendingDays || 5)} hari** setelah pembayaran`, inline: true });
  if (t.closedAt) info.addFields({ name: '🔒 Ditutup', value: `${ts(t.closedAt, 'f')} oleh <@${t.closedBy}>`, inline: true });
  if (t.status === 'completed') {
    info.addFields({
      name: '📅 Perkiraan Robux Masuk',
      value: ts(t.closedAt + (Number(t.pendingDays) || 5) * 86400000, 'D'),
      inline: true,
    });
  }

  const embeds = [info];
  if (t.status === 'open') {
    const product = (cfg.products || []).find((p) => p.id === t.productId) || {};
    embeds.push(...paymentEmbeds(guild, cfg, t));
    if (product.ticketNote) {
      embeds.push(
        new EmbedBuilder()
          .setColor(color(cfg, 'refund', 0xe67e22))
          .setTitle(product.ticketNoteTitle || '📌 Penting — Jaga Gamepass Kamu')
          .setDescription(fill(product.ticketNote, { name }).slice(0, 4096)),
      );
    }
  }

  const components =
    t.status === 'open'
      ? [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Buka Gamepass').setEmoji('🔗').setURL(gpUrl(gp.id)),
            new ButtonBuilder().setCustomId(`store:gpcheck:${t.id}`).setLabel('Cek Gamepass').setEmoji('🔍').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`store:close:${t.id}`).setLabel('Tutup Ticket').setEmoji('🔒').setStyle(ButtonStyle.Danger),
          ),
          ...paymentRows(t),
        ]
      : [];
  return { embeds, components };
}

/** Hasil cek ulang gamepass oleh admin sebelum membeli. */
function buildGamepassCheck(cfg, t, live, problems) {
  const ok = !problems.length;
  const e = new EmbedBuilder()
    .setColor(ok ? color(cfg, 'open', 0x2ecc71) : color(cfg, 'closed', 0xe74c3c))
    .setTitle(ok ? '✅ Gamepass Siap Dibeli' : '⚠️ Gamepass Bermasalah')
    .setDescription(ok ? 'Harga dan status gamepass **sesuai** dengan pesanan.' : problems.map((p) => `▸ ${p}`).join('\n'))
    .addFields(
      { name: '🎟️ Gamepass', value: `[${live?.name || t.gamepass.name}](${gpUrl(t.gamepass.id)})`, inline: true },
      { name: '💲 Harga Sekarang', value: live?.price ? `\`${num(live.price)} Robux\`` : '`-`', inline: true },
      { name: '🧾 Harga di Pesanan', value: `\`${num(t.before)} Robux\``, inline: true },
      { name: '🛍️ Status', value: live?.forSale ? '`🟢 On Sale`' : '`🔴 Off Sale`', inline: true },
      { name: '👤 Pemilik', value: `\`${live?.creatorName || '-'}\``, inline: true },
    );
  if (live?.icon) e.setThumbnail(live.icon);
  return { embeds: [e] };
}

// ═════════════════════════════════════ CANVA PRO ═════════════════════════════════════
/** Teks item di DM / status: paket Canva atau jumlah Robux. */
function itemText(t) {
  if (kindOf(t) === 'instant') return `${t.ins?.variant || '-'} × ${num(t.qty || 1)}`;
  if (kindOf(t) === 'canva') return t.plan?.label || '-';
  if (kindOf(t) === 'boost') return `${num(t.qty)} Boost • ${t.plan?.label || '-'}`;
  return `${num(t.amount)} Robux`;
}

/** Samarkan email untuk log publik: ahmadfebryan@gmail.com → ah********an@gmail.com */
function maskEmail(email) {
  const [user, domain] = String(email || '').split('@');
  if (!domain) return maskName(user);
  return `${maskName(user)}@${domain}`;
}

const canvaPlans = (product) => (product?.plans || []).filter((x) => x && x.id && Number(x.price) > 0);

/** Lama paket dalam bulan (pakai `months` di store.json, kalau tidak ada dihitung dari days). */
const planMonths = (x) => Number(x.months) || Math.max(1, Math.round((Number(x.days) || 30) / 30));

/** Persen hemat paket dibanding paket termahal per bulan (contoh: 1 Tahun 30k vs 12 × 5k = hemat 50%). */
function planSaving(product, plan) {
  const plans = canvaPlans(product);
  const base = plans.reduce((m, x) => (!m || x.price / planMonths(x) > m.price / planMonths(m) ? x : m), null);
  if (!base || base.id === plan.id) return 0;
  const normal = (base.price / planMonths(base)) * planMonths(plan);
  return Math.max(0, Math.round((1 - plan.price / normal) * 100));
}

function planTable(product) {
  const plans = canvaPlans(product);
  if (!plans.length) return null;
  const w = Math.max(...plans.map((x) => x.label.length));
  const pw = Math.max(...plans.map((x) => rupiah(x.price).length));
  return (
    '```\n' +
    plans
      .map((x) => {
        const save = planSaving(product, x);
        return `${x.label.padEnd(w)}  ➜  ${rupiah(x.price).padStart(pw)}${save ? `  (Hemat ${save}%)` : ''}`;
      })
      .join('\n') +
    '\n```'
  );
}

const minPlanPrice = (product) => Math.min(...canvaPlans(product).map((x) => x.price));

/** Member Canva yang masih aktif (order selesai & belum habis masa aktifnya). */
function canvaActiveCount(productId) {
  const now = Date.now();
  return Object.values(state.tickets).filter((t) => t.productId === productId && t.status === 'completed' && t.expiresAt > now).length;
}

/** Info produk Canva Pro (hanya terlihat pembeli). */
function buildCanvaInfo(guild, cfg, product) {
  const open = isProductOpen(product);
  const name = { name: storeName(cfg, guild) };
  const s = state.stats;
  const ps = productStatsOf(product.id);
  const avg = s.ratingCount ? (s.ratingSum / s.ratingCount).toFixed(1) : '-';
  const e = new EmbedBuilder()
    .setColor(color(cfg, 'brand', 0x3498db))
    .setTitle(`${product.emoji || '🎨'} ${product.label}`)
    .setDescription(fill(product.description || '', name) || null)
    .setThumbnail(product.thumbnail || guild.iconURL({ extension: 'png', size: 256 }) || null);
  const table = planTable(product);
  if (table) e.addFields({ name: '🗓️ Pilihan Paket', value: table });
  e.addFields(
    { name: '🎟️ Sisa Slot', value: `\`${num(stockOf(product))} ${stockUnit(product)}\``, inline: true },
    { name: '🏪 Status', value: open ? '`🟢 BUKA`' : '`🔴 TUTUP`', inline: true },
    { name: '📧 Aktivasi', value: '`Undangan via email`', inline: true },
  );
  if (product.features?.length) e.addFields({ name: '✨ Keuntungan', value: product.features.map((x) => `▸ ${x}`).join('\n').slice(0, 1024) });
  if (product.howItWorks?.length) {
    e.addFields({ name: '🔄 Cara Kerja', value: product.howItWorks.map((x, i) => `${KEYCAPS[i] || `\`${i + 1}\``} ${x}`).join('\n').slice(0, 1024) });
  }
  e.addFields(
    { name: '✅ Order Selesai', value: `\`${num(ps.orders)} order\``, inline: true },
    { name: '👥 Member Aktif', value: `\`${num(canvaActiveCount(product.id))} member\``, inline: true },
    { name: '⭐ Rating Pembeli', value: `\`${avg} / 5 (${num(s.ratingCount)} ulasan)\``, inline: true },
  );

  const buttons = [
    new ButtonBuilder()
      .setCustomId(`store:order:${product.id}`)
      .setLabel(open ? 'Order Sekarang' : stockOf(product) <= 0 ? 'Slot Habis' : 'Sedang Tutup')
      .setEmoji('🛒')
      .setStyle(ButtonStyle.Success)
      .setDisabled(!open),
  ];
  if (product.howTo) buttons.push(new ButtonBuilder().setCustomId(`store:howtobtn:${product.id}`).setLabel('Cara Order').setEmoji('📖').setStyle(ButtonStyle.Primary));
  if (product.terms?.description) {
    buttons.push(
      new ButtonBuilder().setCustomId(`store:terms:${product.id}`).setLabel(product.terms.button || 'Syarat').setEmoji('📌').setStyle(ButtonStyle.Secondary),
    );
  }
  return { embeds: [e], components: [new ActionRowBuilder().addComponents(buttons)] };
}

/** Ringkasan sebelum ticket Canva dibuat. */
function buildCanvaConfirm(guild, cfg, product, d) {
  const save = planSaving(product, d.plan);
  const e = new EmbedBuilder()
    .setColor(color(cfg, 'brand', 0x3498db))
    .setTitle(`🔍 Konfirmasi Order ${product.label}`)
    .setDescription('Periksa kembali detail di bawah. Pastikan **alamat email** sudah benar — undangan team akan dikirim ke email ini.')
    .addFields(
      { name: '🗓️ Paket', value: `\`${d.plan.label}\`${save ? `\n┗ Hemat ${save}%` : ''}`, inline: true },
      { name: '⏳ Masa Aktif', value: `\`${num(d.plan.days)} hari\``, inline: true },
      { name: '🎟️ Sisa Slot', value: `\`${num(stockOf(product))} ${stockUnit(product)}\``, inline: true },
      { name: '📧 Email Canva', value: `\`${d.email}\`` },
      { name: '💰 Total Bayar', value: `## ${rupiah(d.price)}` },
    )
    .setThumbnail(product.thumbnail || guild.iconURL({ extension: 'png', size: 256 }) || null);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('store:cvconfirm:yes').setLabel('Ya, Buat Ticket').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('store:cvconfirm:no').setLabel('Batalkan').setEmoji('✖️').setStyle(ButtonStyle.Danger),
  );
  return { embeds: [e], components: [row] };
}

function canvaSteps(t) {
  const st = t.stage || {};
  const done = t.status === 'completed';
  const rows = [
    [st.invited, `Admin mengirim **undangan team** ke \`${t.email}\``],
    [st.joined, 'Pembeli **menerima undangan** lewat email'],
    [done, `**Canva Pro aktif** selama ${num(t.plan.days)} hari ✨`],
  ];
  const cur = rows.findIndex((r) => !r[0]);
  return rows.map((r, i) => `${r[0] ? '✅' : t.status === 'open' && i === cur ? '⏳' : '▫️'} \`${i + 1}\` ${r[1]}`).join('\n');
}

/** Isi ticket Canva Pro. */
function buildCanvaTicket(guild, cfg, t) {
  const name = storeName(cfg, guild);
  const product = (cfg.products || []).find((p) => p.id === t.productId) || {};
  const st = t.stage || {};
  const statusColor = {
    open: color(cfg, 'brand', 0x3498db),
    completed: color(cfg, 'open', 0x2ecc71),
    cancelled: color(cfg, 'closed', 0xe74c3c),
    refund: color(cfg, 'refund', 0xe67e22),
  }[t.status];

  const info = new EmbedBuilder()
    .setColor(statusColor)
    .setAuthor({ name: `${name} • ${t.productLabel}`, iconURL: guild.iconURL({ size: 128 }) || undefined })
    .setTitle(`🧾 Detail Pesanan • ${t.id}`)
    .setDescription(`Halo <@${t.userId}>, terima kasih sudah berbelanja di **${name}**! 💜`)
    .addFields(
      { name: '👤 Pembeli', value: `<@${t.userId}>`, inline: true },
      { name: '🗓️ Paket', value: `\`${t.plan.label}\``, inline: true },
      { name: '⏳ Masa Aktif', value: `\`${num(t.plan.days)} hari\``, inline: true },
      { name: '📧 Email Canva', value: `\`${t.email}\`` },
      { name: '💰 Total Bayar', value: `## ${rupiah(t.price)}` },
      { name: '📍 Progress Aktivasi', value: canvaSteps(t) },
      { name: '📌 Status', value: `**${ticketStatusText(t)}**`, inline: true },
      { name: '💳 Pembayaran', value: payStatusText(t), inline: true },
      { name: '🕒 Dibuat', value: ts(t.createdAt, 'f'), inline: true },
    )
    .setThumbnail(product.thumbnail || guild.iconURL({ extension: 'png', size: 256 }) || null)
    .setFooter(serverFooter(guild, `${name} • Ticket ${t.id}`))
    .setTimestamp(t.closedAt || t.createdAt);
  if (t.closedAt) info.addFields({ name: '🔒 Ditutup', value: `${ts(t.closedAt, 'f')} oleh <@${t.closedBy}>`, inline: true });
  if (t.status === 'completed' && t.expiresAt) info.addFields({ name: '📅 Aktif Hingga', value: ts(t.expiresAt, 'D'), inline: true });

  const embeds = [info];
  if (t.status === 'open') {
    embeds.push(...paymentEmbeds(guild, cfg, t));
    if (product.ticketNote) {
      embeds.push(
        new EmbedBuilder()
          .setColor(color(cfg, 'refund', 0xe67e22))
          .setTitle(product.ticketNoteTitle || '📌 Penting')
          .setDescription(fill(product.ticketNote, { name }).slice(0, 4096)),
      );
    }
  }

  const components =
    t.status === 'open'
      ? [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`store:cvinvite:${t.id}`)
              .setLabel(st.invited ? 'Undangan Terkirim' : 'Undangan Terkirim (Admin)')
              .setEmoji('📨')
              .setStyle(ButtonStyle.Primary)
              .setDisabled(Boolean(st.invited)),
            new ButtonBuilder()
              .setCustomId(`store:cvjoined:${t.id}`)
              .setLabel(st.joined ? 'Sudah Join Team' : 'Saya Sudah Join Team')
              .setEmoji('✅')
              .setStyle(ButtonStyle.Success)
              .setDisabled(!st.invited || Boolean(st.joined)),
            new ButtonBuilder().setCustomId(`store:close:${t.id}`).setLabel('Tutup Ticket').setEmoji('🔒').setStyle(ButtonStyle.Danger),
          ),
          ...paymentRows(t),
        ]
      : [];
  return { embeds, components };
}

/** Pemberitahuan langkah aktivasi Canva di dalam ticket. step: 'invited' | 'joined' */
function buildCanvaStep(guild, cfg, t, step) {
  const name = storeName(cfg, guild);
  const product = (cfg.products || []).find((p) => p.id === t.productId) || {};
  const e = new EmbedBuilder()
    .setColor(color(cfg, step === 'joined' ? 'open' : 'brand', step === 'joined' ? 0x2ecc71 : 0x3498db))
    .setFooter(serverFooter(guild, `${name} • Ticket ${t.id}`))
    .setTimestamp(new Date());
  let ping = [];
  if (step === 'invited') {
    ping = [t.userId];
    const guide = product.inviteGuide?.length
      ? product.inviteGuide
      : ['Buka inbox email kamu (cek juga folder **Spam / Promosi**)', 'Cari email dari **Canva** berisi undangan bergabung ke team', 'Klik **Join team / Gabung tim**', 'Login ke Canva memakai email tersebut', 'Klik **✅ Saya Sudah Join Team** di ticket ini'];
    e.setTitle('📨 Undangan Team Canva Pro Terkirim!')
      .setDescription(`<@${t.userId}>, admin telah mengirim **undangan team Canva Pro** ke email kamu. 🎉`)
      .addFields(
        { name: '📧 Dikirim ke', value: `\`${t.email}\`` },
        { name: '📍 Progress', value: '`✅ Undangan Dikirim` ➜ `⏳ Terima Undangan` ➜ `▫️ Pro Aktif`' },
        { name: '🪄 Cara Menerima Undangan', value: guide.map((x, i) => `${KEYCAPS[i] || `\`${i + 1}\``} ${x}`).join('\n').slice(0, 1024) },
      );
  } else if (step === 'joined') {
    e.setTitle('🎉 Pembeli Sudah Bergabung ke Team')
      .setDescription(`<@${t.userId}> telah **menerima undangan** dan bergabung ke team Canva Pro. ✨`)
      .addFields(
        { name: '📍 Progress', value: '`✅ Undangan Dikirim` ➜ `✅ Terima Undangan` ➜ `⏳ Pro Aktif`' },
        { name: '🔒 Langkah Terakhir — Admin', value: 'Admin akan mengecek status Pro kamu lalu menutup ticket ini. Setelah itu kamu bisa memberi **testimoni** ⭐' },
      );
  }
  return { content: ping.map((id) => `<@${id}>`).join(' ') || undefined, embeds: [e], allowedMentions: { users: ping } };
}

function buildCanvaTestimony(guild, cfg, t, buyer) {
  const r = t.testimony;
  const embed = new EmbedBuilder()
    .setColor(color(cfg, 'brand', 0x3498db))
    .setTitle(`🧾 Testimoni #${String(state.stats.testimonies).padStart(4, '0')}`)
    .setDescription(
      r ? `**Rating:** ${STARS(r.rating)}  **${r.rating}/5**\n\n>>> ${r.comment}` : '✅ **Transaksi Berhasil**\n\n_Pembeli tidak memberikan ulasan._',
    )
    .addFields(
      { name: '👤 Pembeli', value: `<@${t.userId}>`, inline: true },
      { name: '📦 Produk', value: `\`${t.productLabel}\``, inline: true },
      { name: '🗓️ Paket', value: `\`${t.plan.label}\``, inline: true },
      { name: '💰 Total', value: `\`${rupiah(t.price)}\``, inline: true },
      { name: '🎫 Ticket', value: `\`${t.id}\``, inline: true },
    )
    .setThumbnail(buyer?.displayAvatarURL({ extension: 'png', size: 256 }) || null)
    .setFooter(serverFooter(guild, storeName(cfg, guild)))
    .setTimestamp(new Date());
  if (t.proofUrl) embed.setImage(t.proofUrl);
  return { embeds: [embed], allowedMentions: { parse: [] } };
}

/** Pengingat masa aktif Canva hampir habis (DM pembeli) / sudah habis (DM admin). */
function buildCanvaExpiry(guild, cfg, t, who) {
  const name = storeName(cfg, guild);
  const e = new EmbedBuilder().setFooter(serverFooter(guild, name)).setTimestamp(new Date());
  if (who === 'buyer') {
    const url = panelUrlFor(guild, 'digital') || panelUrlFor(guild, 'main');
    e.setColor(color(cfg, 'refund', 0xe67e22))
      .setTitle(`⏰ ${t.productLabel} Kamu Segera Berakhir`)
      .setDescription(
        `Masa aktif **${t.productLabel} (${t.plan.label})** untuk \`${t.email}\` akan berakhir **${ts(t.expiresAt, 'R')}** (${ts(t.expiresAt, 'D')}).\n\n` +
          `Perpanjang sekarang di **${name}** supaya tetap bisa pakai fitur Pro tanpa terputus! ✨` +
          (url ? `\n\n🛒 ${url}` : ''),
      );
  } else {
    e.setColor(color(cfg, 'closed', 0xe74c3c))
      .setTitle(`⌛ Masa Aktif ${t.productLabel} Habis`)
      .setDescription(`Masa aktif ticket **${t.id}** sudah berakhir. Keluarkan email berikut dari team Canva bila tidak diperpanjang.`)
      .addFields(
        { name: '👤 Pembeli', value: `<@${t.userId}>`, inline: true },
        { name: '🗓️ Paket', value: `\`${t.plan.label}\``, inline: true },
        { name: '📧 Email', value: `\`${t.email}\`` },
      );
  }
  return { embeds: [e] };
}

// ═════════════════════════════════════ PEMBAYARAN ═════════════════════════════════════
/** Nominal yang harus ditransfer pembeli. */
const payAmount = (t) => (kindOf(t) === 'rekber' ? t.buyerPays : t.price);
/** Sudah lunas? (rekber: dana sudah dikonfirmasi admin) */
const isPaid = (t) => (kindOf(t) === 'rekber' ? Boolean(t.stage?.funded) : t.payment?.status === 'paid');
const payMethods = (cfg) => (cfg.payment?.methods || []).filter((m) => m && m.bank && m.number);

function payStatusText(t) {
  if (isPaid(t)) return '`✅ Lunas`';
  const st = t.payment?.status;
  if (st === 'pending') return '`🧾 Menunggu Verifikasi`';
  if (st === 'rejected') return '`❌ Bukti Ditolak`';
  return '`⏳ Belum Dibayar`';
}
function ticketStatusText(t) {
  if (t.status === 'open' && isPaid(t)) return '🔄 Dana Diterima — Sedang Diproses';
  return STATUS_LABEL[t.status];
}

/** Embed rekening pembayaran (hanya tampil selama belum lunas). */
function paymentEmbeds(guild, cfg, t) {
  if (t.status !== 'open' || isPaid(t)) return [];
  const pay = cfg.payment || {};
  const name = { name: storeName(cfg, guild) };
  const methods = payMethods(cfg);
  const e = new EmbedBuilder()
    .setColor(color(cfg, 'brand', 0x3498db))
    .setTitle(pay.title || '💳 Cara Pembayaran')
    .setDescription(
      `Transfer **tepat** sebesar:\n## ${rupiah(payAmount(t))}\n` +
        (pay.accountName ? `ke salah satu rekening di bawah — semua **a.n. ${pay.accountName}**` : 'ke salah satu rekening di bawah:'),
    );
  for (const m of methods.slice(0, 18)) {
    e.addFields({ name: `${m.emoji || '🏦'} ${m.bank}`, value: `\`${m.number}\`${m.holder ? `\n┗ a.n. ${m.holder}` : ''}`, inline: true });
  }
  const rest = methods.length % 3;
  for (let i = 0; rest && i < 3 - rest; i++) e.addFields({ name: '​', value: '​', inline: true }); // rapikan grid
  if (pay.description) e.addFields({ name: '🧾 Langkah Pembayaran', value: fill(pay.description, name).slice(0, 1024) });
  if (pay.image) e.setImage(pay.image);
  return [e];
}

/** Tombol pembayaran pembeli (selama belum lunas). */
function paymentRows(t) {
  if (t.status !== 'open' || isPaid(t)) return [];
  const st = t.payment?.status;
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`store:paybtn:${t.id}`)
        .setLabel(st === 'pending' || st === 'rejected' ? 'Kirim Ulang Bukti Pembayaran' : 'Konfirmasi Pembayaran')
        .setEmoji('💳')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`store:copyacc:${t.id}`).setLabel('Salin No. Rekening').setEmoji('📋').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

/** Daftar nomor rekening polos (mudah disalin di HP). */
function buildCopyAccounts(cfg, t) {
  const methods = payMethods(cfg);
  const lines = methods.map((m) => `**${m.bank}**\n${m.number}`);
  return {
    content:
      `💰 **Total transfer: ${rupiah(payAmount(t))}**${cfg.payment?.accountName ? `\n👤 a.n. **${cfg.payment.accountName}**` : ''}\n\n` +
      `${lines.join('\n\n')}\n\n_Tekan lama nomor rekening untuk menyalin._`,
  };
}

/** Bukti pembayaran dari pembeli (dikirim ke ticket, admin verifikasi). */
function buildPaymentProof(guild, cfg, t, p, imageUrl) {
  const e = new EmbedBuilder()
    .setColor(color(cfg, 'refund', 0xe67e22))
    .setAuthor({ name: `${storeName(cfg, guild)} • Konfirmasi Pembayaran`, iconURL: guild.iconURL({ size: 128 }) || undefined })
    .setTitle('🧾 Bukti Pembayaran Diterima')
    .setDescription(`<@${p.userId}> telah mengirim bukti pembayaran untuk **${t.id}**.\nAdmin akan segera **memverifikasi** pembayaranmu. ⏳`)
    .addFields(
      { name: '💰 Nominal Tagihan', value: `\`${rupiah(payAmount(t))}\``, inline: true },
      { name: '🏦 Transfer ke', value: `\`${p.bank}\``, inline: true },
      { name: '👤 Nama Pengirim', value: `\`${p.sender}\``, inline: true },
    )
    .setFooter(serverFooter(guild, `${storeName(cfg, guild)} • Ticket ${t.id}`))
    .setTimestamp(new Date());
  if (p.note) e.addFields({ name: '📝 Catatan', value: p.note.slice(0, 1024) });
  if (imageUrl) e.setImage(imageUrl);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`store:paid:${t.id}`).setLabel('Dana Masuk (Admin)').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`store:payreject:${t.id}`).setLabel('Tolak (Admin)').setEmoji('❌').setStyle(ButtonStyle.Danger),
  );
  return { embeds: [e], components: [row] };
}

/** Langkah berikutnya setelah dana masuk, sesuai produk. */
function nextStepText(t) {
  const k = kindOf(t);
  if (k === 'gamepass') {
    return `Admin akan segera **membeli gamepass** [${t.gamepass?.name || t.gamepass?.id}](${gpUrl(t.gamepass?.id)}). Robux masuk ke akunmu setelah masa pending Roblox (± **${num(t.pendingDays || 5)} hari**).`;
  }
  if (k === 'canva') return `Admin akan segera mengirim **undangan Team Canva Pro** ke \`${t.email}\`. Pantau inbox email kamu ya! 📨`;
  if (k === 'boost') return `Admin akan segera mem-boost server **${t.server?.name || 'kamu'}** dengan **${num(t.qty)} boost** 🚀 (estimasi ${t.estimate || '1x24 jam'}).`;
  if (k === 'instant') return 'Akun sedang **dikirim otomatis** ke ticket ini & DM kamu. ⚡';
  if (k === 'rekber') return `<@${t.sellerId}>, silakan kirim barang / jasa ke pembeli. Pembeli klik **📦 Barang Sudah Diterima** setelah barang sesuai.`;
  return `Admin sedang memproses pengiriman **${num(t.amount)} Robux** ke akun Roblox \`@${t.roblox?.name}\`. 🚀`;
}

/** Pemberitahuan dana masuk (dari /danamasuk atau tombol Dana Masuk). */
function buildDanaMasuk(guild, cfg, t, { amount, note, by }) {
  const rekber = kindOf(t) === 'rekber';
  const buyer = rekber ? t.buyerId : t.userId;
  const e = new EmbedBuilder()
    .setColor(color(cfg, 'open', 0x2ecc71))
    .setAuthor({ name: `${storeName(cfg, guild)} • Pembayaran Terverifikasi`, iconURL: guild.iconURL({ size: 128 }) || undefined })
    .setTitle('💰 Dana Masuk!')
    .setDescription(
      `Pembayaran <@${buyer}> untuk **${t.id}** telah **diterima & diverifikasi** oleh admin. Terima kasih! 🙏\n` +
        (rekber ? 'Dana kini **ditahan dengan aman** oleh admin sampai barang diterima pembeli. 🛡️' : 'Pesananmu kini **sedang diproses**. ✨'),
    )
    .addFields(
      { name: '💰 Nominal Diterima', value: `\`${rupiah(amount)}\``, inline: true },
      { name: '📦 Produk', value: `\`${t.productLabel}${rekber ? '' : ` • ${itemText(t)}`}\``, inline: true },
      { name: '🛡️ Diverifikasi', value: `<@${by}>`, inline: true },
      { name: '⏭️ Langkah Selanjutnya', value: nextStepText(t).slice(0, 1024) },
    )
    .setThumbnail(guild.iconURL({ extension: 'png', size: 256 }) || null)
    .setFooter(serverFooter(guild, `${storeName(cfg, guild)} • Ticket ${t.id}`))
    .setTimestamp(new Date());
  if (amount !== payAmount(t)) {
    e.addFields({ name: '⚠️ Selisih Nominal', value: `Tagihan \`${rupiah(payAmount(t))}\` • diterima \`${rupiah(amount)}\`` });
  }
  if (note) e.addFields({ name: '📝 Catatan Admin', value: note.slice(0, 1024) });
  const ping = rekber ? [t.buyerId, t.sellerId] : [buyer];
  return { content: ping.map((id) => `<@${id}>`).join(' '), embeds: [e], allowedMentions: { users: ping } };
}

/** Bukti pembayaran ditolak admin. */
function buildPayRejected(guild, cfg, t, reason, by) {
  const buyer = kindOf(t) === 'rekber' ? t.buyerId : t.userId;
  return {
    content: `<@${buyer}>`,
    embeds: [
      new EmbedBuilder()
        .setColor(color(cfg, 'closed', 0xe74c3c))
        .setTitle('❌ Bukti Pembayaran Ditolak')
        .setDescription(
          `Maaf <@${buyer}>, bukti pembayaranmu untuk **${t.id}** **belum bisa diverifikasi** oleh <@${by}>.\n\n` +
            `📝 **Alasan:** ${reason || 'Bukti tidak sesuai / dana belum masuk.'}\n\nSilakan periksa kembali lalu klik **💳 Kirim Ulang Bukti Pembayaran**.`,
        )
        .setFooter(serverFooter(guild, `${storeName(cfg, guild)} • Ticket ${t.id}`))
        .setTimestamp(new Date()),
    ],
    allowedMentions: { users: [buyer] },
  };
}

// ───────────────────────── Log order (channel log admin) ─────────────────────────
function duration(ms) {
  const m = Math.max(1, Math.round(ms / 60000));
  if (m < 60) return `${m} menit`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} jam ${m % 60} menit`;
  return `${Math.floor(h / 24)} hari ${h % 24} jam`;
}

/** Samarkan username Roblox untuk log publik: Builderman → Bu******an */
function maskName(n) {
  const str = String(n || '');
  if (str.length <= 4) return `${str[0] || ''}${'*'.repeat(Math.max(str.length - 1, 0))}`;
  return `${str.slice(0, 2)}${'*'.repeat(str.length - 4)}${str.slice(-2)}`;
}

const PUBLIC_STATUS = {
  robux: { open: '⏳ Sedang Diproses', completed: '✅ Selesai', cancelled: '❌ Dibatalkan', refund: '💸 Refund' },
  rekber: { open: '🔄 Sedang Berjalan', completed: '✅ Selesai', cancelled: '❌ Dibatalkan', refund: '💸 Refund' },
};

/**
 * Log order PUBLIK — 1 pesan per ticket, di-edit otomatis setiap ada perubahan.
 * Tidak menampilkan catatan admin, nama admin, maupun link ticket. Detail sensitif bisa diatur
 * lewat store.json → publicLog.
 */
function buildOrderLog(guild, cfg, t) {
  const rekber = kindOf(t) === 'rekber';
  const pl = { showBuyer: true, maskRoblox: true, showPrice: true, showRekberItem: false, ...(cfg.publicLog || {}) };
  const statusColor = {
    open: color(cfg, 'brand', 0x3498db),
    completed: color(cfg, 'open', 0x2ecc71),
    cancelled: color(cfg, 'closed', 0xe74c3c),
    refund: color(cfg, 'refund', 0xe67e22),
  }[t.status];
  const name = storeName(cfg, guild);
  const pub = PUBLIC_STATUS[rekber ? 'rekber' : 'robux'][t.status];

  const e = new EmbedBuilder()
    .setColor(statusColor)
    .setAuthor({ name: `${name} • ${rekber ? 'Rekber Log' : 'Order Log'}`, iconURL: guild.iconURL({ size: 128 }) || undefined })
    .setTitle(`${rekber ? '🤝' : '🧾'} ${t.id}  •  ${pub}`)
    .setThumbnail(guild.iconURL({ extension: 'png', size: 256 }) || null)
    .setFooter(serverFooter(guild, name))
    .setTimestamp(t.closedAt || t.createdAt);

  if (rekber) {
    if (pl.showBuyer) {
      e.addFields(
        { name: '🛒 Pembeli', value: `<@${t.buyerId}>`, inline: true },
        { name: '🏷️ Penjual', value: `<@${t.sellerId}>`, inline: true },
      );
    }
    e.addFields({ name: '🛡️ Layanan', value: '`Rekber`', inline: true });
    if (pl.showRekberItem) e.addFields({ name: '📦 Objek', value: `\`${t.item.slice(0, 100)}\``, inline: true });
    if (pl.showPrice) e.addFields({ name: '💵 Nominal', value: `\`${rupiah(t.nominal)}\``, inline: true });
  } else if (kindOf(t) === 'canva') {
    if (pl.showBuyer) e.addFields({ name: '👤 Pembeli', value: `<@${t.userId}>`, inline: true });
    e.addFields(
      { name: '📦 Produk', value: `\`${t.productLabel}\``, inline: true },
      { name: '🗓️ Paket', value: `\`${t.plan.label}\``, inline: true },
    );
    if (pl.showPrice) e.addFields({ name: '💰 Total', value: `\`${rupiah(t.price)}\``, inline: true });
    e.addFields({ name: '📧 Email', value: `\`${maskEmail(t.email)}\``, inline: true });
  } else {
    if (pl.showBuyer) e.addFields({ name: '👤 Pembeli', value: `<@${t.userId}>`, inline: true });
    e.addFields(
      { name: '📦 Produk', value: `\`${t.productLabel}\``, inline: true },
      { name: kindOf(t) === 'gamepass' ? '💎 Robux Diterima' : '💎 Jumlah', value: `\`${num(t.amount)} Robux\``, inline: true },
    );
    if (kindOf(t) === 'gamepass') e.addFields({ name: '🎟️ Harga Gamepass', value: `\`${num(t.before)} Robux\``, inline: true });
    e.addFields({ name: '💱 Rate', value: `\`${rupiah(t.rate)} / Robux\``, inline: true });
    if (pl.showPrice) e.addFields({ name: '💰 Total', value: `\`${rupiah(t.price)}\``, inline: true });
    e.addFields({ name: '🎮 Akun Roblox', value: `\`@${pl.maskRoblox ? maskName(t.roblox.name) : t.roblox.name}\``, inline: true });
  }

  e.addFields({ name: '📌 Status', value: `**${pub}**`, inline: false }, { name: '🕒 Order Masuk', value: ts(t.createdAt, 'f'), inline: true });
  if (t.closedAt) {
    e.addFields(
      { name: t.status === 'completed' ? '✅ Selesai Pada' : '🔒 Ditutup Pada', value: ts(t.closedAt, 'f'), inline: true },
      { name: '⚡ Waktu Proses', value: `\`${duration(t.closedAt - t.createdAt)}\``, inline: true },
    );
  }
  if (t.testimony) e.addFields({ name: '⭐ Rating Pembeli', value: `${STARS(t.testimony.rating)}  **${t.testimony.rating}/5**` });

  const timeline = (t.log || []).slice(-10).map((x) => `${ts(x.at, 't')} ┃ ${x.text}`).join('\n');
  if (timeline) e.addFields({ name: '🗂️ Progress', value: timeline.slice(0, 1024) });

  return { embeds: [e], components: [], allowedMentions: { parse: [] } };
}

// ═════════════════════════════ COMPONENTS V2 (testimoni & history order) ═════════════════════════════
// Garis pemisah (separator) selalu pas sampai ujung kotak di HP & laptop.
const v2Line = () => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
const v2Text = (content) => new TextDisplayBuilder().setContent(String(content).slice(0, 4000));
const row = (label, value) => `» **${label} :** ${value}`;
/** Isi komentar aman di dalam kotak code block. */
const boxed = (s) => '```\n' + String(s || '-').replace(/`/g, 'ˋ').slice(0, 900) + '\n```';

function v2Card({ color: accent, header, lines, thumb, after = [], image, footer }) {
  const box = new ContainerBuilder().setAccentColor(accent);
  box.addTextDisplayComponents(v2Text(header));
  box.addSeparatorComponents(v2Line());
  const body = lines.filter(Boolean).join('\n');
  if (thumb) box.addSectionComponents(new SectionBuilder().addTextDisplayComponents(v2Text(body)).setThumbnailAccessory(new ThumbnailBuilder().setURL(thumb)));
  else box.addTextDisplayComponents(v2Text(body));
  for (const block of after.filter(Boolean)) {
    box.addSeparatorComponents(v2Line());
    box.addTextDisplayComponents(v2Text(block));
  }
  if (image) box.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(image)));
  if (footer) {
    box.addSeparatorComponents(v2Line());
    box.addTextDisplayComponents(v2Text(`-# ${footer}`));
  }
  return { components: [box], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } };
}

/** Testimoni (semua produk) — Components V2. */
function buildTestimonyV2(guild, cfg, t, buyer, opts = {}) {
  const no = opts.number || t.testimonyNo || state.stats.testimonies;
  const at = opts.at || t.testimonyAt || Date.now();
  const r = t.testimony;
  const k = kindOf(t);
  const buyerId = k === 'rekber' ? t.buyerId : t.userId;
  let lines;
  if (k === 'rekber') {
    lines = [
      row('Layanan', '`🤝 Rekber`'),
      row('Pembeli', `<@${t.buyerId}>`),
      row('Penjual', `<@${t.sellerId}>`),
      row('Objek', `\`${t.item.slice(0, 80)}\``),
      row('Nominal', `\`${rupiah(t.nominal)}\``),
    ];
  } else if (k === 'canva') {
    lines = [row('Pembeli', `<@${t.userId}>`), row('Produk', `\`${t.productLabel}\``), row('Paket', `\`${t.plan.label}\``), row('Harga', `\`${rupiah(t.price)}\``)];
  } else if (k === 'boost') {
    lines = [
      row('Pembeli', `<@${t.userId}>`),
      row('Produk', `\`${t.productLabel}\``),
      row('Paket', `\`${num(t.qty)} Boost • ${t.plan.label}\``),
      row('Server', `\`${t.server?.name || '-'}\``),
      row('Harga', `\`${rupiah(t.price)}\``),
    ];
  } else if (k === 'instant') {
    lines = [
      row('Pembeli', `<@${t.userId}>`),
      row('Produk', `\`${t.ins?.product || t.productLabel}\``),
      row('Varian', `\`${t.ins?.variant || '-'} × ${num(t.qty || 1)}\``),
      row('Pengiriman', '`⚡ Otomatis`'),
      row('Harga', `\`${rupiah(t.price)}\``),
    ];
  } else {
    lines = [
      row('Pembeli', `<@${t.userId}>`),
      row('Produk', `\`${t.productLabel}\``),
      row(k === 'gamepass' ? 'Robux Diterima' : 'Jumlah', `\`${num(t.amount)} Robux\``),
      row('Akun Roblox', `\`@${maskName(t.roblox?.name)}\``), // disensor: Bu******an
      row('Harga', `\`${rupiah(t.price)}\``),
    ];
  }
  lines.push(row('Order ID', `\`${t.id}\``));
  // Total belanja pembeli di toko (semua order Completed) + tier spender.
  const sp = state.spenders?.[buyerId];
  const tier = sp ? SP.tierFor(sp.revenue, cfg) : null;
  const after = [
    r ? row('Rating', `${STARS(r.rating)}  **${r.rating}/5**`) : row('Status', '`✅ Transaksi Berhasil`'),
    `**💬 Komentar**\n${boxed(r ? r.comment : 'Pembeli tidak memberikan ulasan.')}`,
    sp?.revenue ? row('Total Spend', `\`${rupiah(sp.revenue)}\` • ${num(sp.orders)} order${tier ? ` • ${SP.tierLabel(tier)}` : ''}`) : null,
  ];
  return v2Card({
    color: color(cfg, 'brand', 0x3498db),
    header: `## 🧾 Testimoni #${String(no).padStart(4, '0')}`,
    lines,
    thumb: buyer?.displayAvatarURL({ extension: 'png', size: 256 }) || guild.iconURL({ extension: 'png', size: 256 }) || null,
    after,
    image: t.proofUrl || null,
    footer: `🛒 ${storeName(cfg, guild)} • ${ts(at, 'f')}`,
  });
}

/** History order publik — Components V2 (1 pesan per ticket, di-edit otomatis). */
function buildOrderLogV2(guild, cfg, t) {
  const k = kindOf(t);
  const rekber = k === 'rekber';
  const pl = { showBuyer: true, maskRoblox: true, showPrice: true, showRekberItem: false, ...(cfg.publicLog || {}) };
  const statusColor = {
    open: color(cfg, 'brand', 0x3498db),
    completed: color(cfg, 'open', 0x2ecc71),
    cancelled: color(cfg, 'closed', 0xe74c3c),
    refund: color(cfg, 'refund', 0xe67e22),
  }[t.status];
  const pub = PUBLIC_STATUS[rekber ? 'rekber' : 'robux'][t.status];
  const lines = [];
  if (rekber) {
    if (pl.showBuyer) lines.push(row('Pembeli', `<@${t.buyerId}>`), row('Penjual', `<@${t.sellerId}>`));
    lines.push(row('Layanan', '`🤝 Rekber`'));
    if (pl.showRekberItem) lines.push(row('Objek', `\`${t.item.slice(0, 80)}\``));
    if (pl.showPrice) lines.push(row('Nominal', `\`${rupiah(t.nominal)}\``));
  } else if (k === 'canva') {
    if (pl.showBuyer) lines.push(row('Pembeli', `<@${t.userId}>`));
    lines.push(row('Produk', `\`${t.productLabel}\``), row('Paket', `\`${t.plan.label}\``));
    if (pl.showPrice) lines.push(row('Total', `\`${rupiah(t.price)}\``));
    lines.push(row('Email', `\`${maskEmail(t.email)}\``));
  } else if (k === 'boost') {
    if (pl.showBuyer) lines.push(row('Pembeli', `<@${t.userId}>`));
    lines.push(row('Produk', `\`${t.productLabel}\``), row('Paket', `\`${num(t.qty)} Boost • ${t.plan.label}\``));
    if (pl.showPrice) lines.push(row('Total', `\`${rupiah(t.price)}\``));
  } else if (k === 'instant') {
    if (pl.showBuyer) lines.push(row('Pembeli', `<@${t.userId}>`));
    lines.push(row('Produk', `\`${t.ins?.product || t.productLabel}\``), row('Varian', `\`${t.ins?.variant || '-'} × ${num(t.qty || 1)}\``), row('Pengiriman', '`⚡ Otomatis`'));
    if (pl.showPrice) lines.push(row('Total', `\`${rupiah(t.price)}\``));
  } else {
    if (pl.showBuyer) lines.push(row('Pembeli', `<@${t.userId}>`));
    lines.push(row('Produk', `\`${t.productLabel}\``), row(k === 'gamepass' ? 'Robux Diterima' : 'Jumlah', `\`${num(t.amount)} Robux\``));
    if (k === 'gamepass') lines.push(row('Harga Gamepass', `\`${num(t.before)} Robux\``));
    lines.push(row('Rate', `\`${rupiah(t.rate)} / Robux\``));
    if (pl.showPrice) lines.push(row('Total', `\`${rupiah(t.price)}\``));
    lines.push(row('Akun Roblox', `\`@${pl.maskRoblox ? maskName(t.roblox?.name) : t.roblox?.name}\``));
  }
  const status = [row('Status', `**${pub}**`), row('Order Masuk', ts(t.createdAt, 'f'))];
  if (t.closedAt) {
    status.push(row(t.status === 'completed' ? 'Selesai Pada' : 'Ditutup Pada', ts(t.closedAt, 'f')), row('Waktu Proses', `\`${duration(t.closedAt - t.createdAt)}\``));
  }
  if (t.testimony) status.push(row('Rating', `${STARS(t.testimony.rating)}  **${t.testimony.rating}/5**`));
  const timeline = (t.log || []).slice(-10).map((x) => `${ts(x.at, 't')} ┃ ${x.text}`).join('\n');
  return v2Card({
    color: statusColor,
    header: `## ${rekber ? '🤝' : '🧾'} ${t.id} • ${pub}\n-# ${rekber ? 'Rekber Log' : 'Order Log'}`,
    lines,
    // Foto profil pembeli (disimpan saat log dibuat); fallback ke logo server.
    thumb: t.buyerAvatar || guild.client?.users?.cache?.get(rekber ? t.buyerId : t.userId)?.displayAvatarURL({ extension: 'png', size: 256 }) || guild.iconURL({ extension: 'png', size: 256 }) || null,
    after: [status.join('\n'), timeline ? `**🗂️ Progress**\n${timeline}` : null],
    footer: `🛒 ${storeName(cfg, guild)} • ${ts(t.closedAt || t.createdAt, 'f')}`,
  });
}

// ═════════════════════════════════════ SERVER BOOST ═════════════════════════════════════
/** Teks masa aktif paket boost (store.json → plans[].duration, contoh "25–31 hari"). */
const planDuration = (plan) => plan?.duration || `${num(plan?.days || 30)} hari`;
const boostPrice = (plan, qty) => Number(plan.price) * Number(qty);
/** Stock per paket: "🗓️ 1 Bulan: `5 boost` • 💎 3 Bulan: `0 boost` (Habis)". */
function boostStockLines(product) {
  return canvaPlans(product)
    .map((x) => {
      const n = planStockOf(product, x.id);
      return `${x.emoji || '🗓️'} **${x.label}:** \`${num(n)} ${stockUnit(product)}\`${n ? '' : ' • `🔴 Habis`'}`;
    })
    .join('\n');
}
/** Tabel harga per boost tiap paket. */
function boostTable(product) {
  const plans = canvaPlans(product);
  if (!plans.length) return null;
  const w = Math.max(...plans.map((x) => x.label.length));
  const pw = Math.max(...plans.map((x) => rupiah(x.price).length));
  const base = plans[0];
  return (
    '```\n' +
    plans
      .map((x) => {
        const perMonth = Number(x.price) / (Number(x.months) || 1);
        const save = base && x !== base && perMonth < Number(base.price) / (Number(base.months) || 1) ? Math.round((1 - perMonth / (Number(base.price) / (Number(base.months) || 1))) * 100) : 0;
        return `${x.label.padEnd(w)}  ➜  ${rupiah(x.price).padStart(pw)} / boost${save ? `  (Hemat ${save}%)` : ''}`;
      })
      .join('\n') +
    '\n```'
  );
}

/** Info Server Boost (V2, hanya terlihat pembeli). */
function buildBoostInfo(guild, cfg, product) {
  const open = isProductOpen(product);
  const name = { name: storeName(cfg, guild) };
  const ps = productStatsOf(product.id);
  const table = boostTable(product);
  return pcard({
    accent: color(cfg, 'brand', 0x3498db),
    thumb: product.thumbnail || icon256(guild),
    header: `## ${product.emoji || '🚀'} ${product.label}\n${fill(product.description || '', name)}`,
    blocks: [
      table ? `### 🗓️ Pilihan Paket\n${table}\n-# 💡 ${product.priceNote || 'Harga per 1 boost'} • tanpa minimum order` : null,
      canvaPlans(product).some((x) => x.notes?.length)
        ? canvaPlans(product)
            .map((x) => `**${x.emoji || '🗓️'} ${x.label.toUpperCase()}**\n${(x.notes || []).map((n) => `▸ ${n}`).join('\n')}`)
            .join('\n\n')
        : null,
      `### 🚀 Stock Boost\n${boostStockLines(product)}`,
      [
        `⏱️ **Estimasi Proses:** \`${product.estimate || '1x24 jam'}\``,
        `🏪 **Status:** ${openBadge(open)}`,
        '🔗 **Yang Dibutuhkan:** `Link server Discord`',
      ].join('\n'),
      product.features?.length ? `### ✨ Keunggulan Produk\n${product.features.map((x) => `▸ ${x}`).join('\n')}` : null,
      product.howItWorks?.length ? `### 🔄 Cara Kerja\n${product.howItWorks.map((x, i) => `${KEYCAPS[i] || `\`${i + 1}\``} ${x}`).join('\n')}` : null,
      [`✅ **Order Selesai:** \`${num(ps.orders)} order\``, `🚀 **Boost Aktif:** \`${num(boostActiveCount(product.id))} boost\``, ratingLine()].join('\n'),
    ],
    footer: `${name.name} • ${nowTs()}`,
    rows: [
      btnRow([
        new ButtonBuilder()
          .setCustomId(`store:order:${product.id}`)
          .setLabel(open ? 'Order Sekarang' : stockOf(product) <= 0 ? 'Stock Habis' : 'Sedang Tutup')
          .setEmoji('🛒')
          .setStyle(ButtonStyle.Success)
          .setDisabled(!open),
        product.howTo ? new ButtonBuilder().setCustomId(`store:howtobtn:${product.id}`).setLabel('Cara Order').setEmoji('📖').setStyle(ButtonStyle.Primary) : null,
        termsButton(product, 'Syarat & Ketentuan'),
      ]),
    ],
  });
}

/** Jumlah boost yang sedang aktif (masa aktif belum habis). */
function boostActiveCount(productId) {
  const now = Date.now();
  return Object.values(state.tickets)
    .filter((t) => kindOf(t) === 'boost' && t.productId === productId && t.status === 'completed' && t.expiresAt > now)
    .reduce((a, t) => a + (Number(t.qty) || 0), 0);
}

const serverLine = (s) =>
  s?.name ? `**${s.name}**${s.members ? ` • 👥 ${num(s.members)} member` : ''}${s.boosts != null ? ` • 🚀 ${num(s.boosts)} boost saat ini` : ''}` : '`Tidak bisa dibaca — admin akan cek manual`';

/** Ringkasan sebelum ticket Server Boost dibuat. */
function buildBoostConfirm(guild, cfg, product, d) {
  const e = new EmbedBuilder()
    .setColor(color(cfg, 'brand', 0x3498db))
    .setTitle(`🔍 Konfirmasi Order ${product.label}`)
    .setDescription('Periksa kembali detail di bawah. Pastikan **link server** sudah benar & **tidak kedaluwarsa**.')
    .addFields(
      { name: '🗓️ Paket', value: `\`${d.plan.label}\``, inline: true },
      { name: '🚀 Jumlah Boost', value: `\`${num(d.qty)} boost\``, inline: true },
      { name: '⏳ Masa Aktif', value: `\`${planDuration(d.plan)}\``, inline: true },
      { name: '📦 Sisa Stock Paket', value: `\`${num(planStockOf(product, d.plan.id))} boost\``, inline: true },
      { name: '🏠 Server', value: serverLine(d.server) },
      { name: '🔗 Link Server', value: d.invite },
      { name: '💰 Total Bayar', value: `## ${rupiah(d.price)}\n-# ${num(d.qty)} boost × ${rupiah(d.plan.price)}` },
    )
    .setThumbnail(d.server?.icon || product.thumbnail || guild.iconURL({ extension: 'png', size: 256 }) || null);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('store:bsconfirm:yes').setLabel('Ya, Buat Ticket').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('store:bsconfirm:no').setLabel('Batalkan').setEmoji('✖️').setStyle(ButtonStyle.Danger),
  );
  return { embeds: [e], components: [row] };
}

function boostSteps(t) {
  const st = t.stage || {};
  const done = t.status === 'completed';
  const rows = [
    [isPaid(t), `Pembayaran **${rupiah(t.price)}** terverifikasi`],
    [st.sent, `Admin mem-boost server **${t.server?.name || '-'}** (${num(t.qty)} boost)`],
    [st.received, 'Pembeli konfirmasi **boost sudah masuk**'],
    [done, `**Boost aktif & bergaransi** selama ${planDuration(t.plan)} ✨`],
  ];
  const cur = rows.findIndex((r) => !r[0]);
  return rows.map((r, i) => `${r[0] ? '✅' : t.status === 'open' && i === cur ? '⏳' : '▫️'} \`${i + 1}\` ${r[1]}`).join('\n');
}

/** Isi ticket Server Boost (dikonversi ke Components V2 saat dikirim). */
function buildBoostTicket(guild, cfg, t) {
  const name = storeName(cfg, guild);
  const product = (cfg.products || []).find((p) => p.id === t.productId) || {};
  const st = t.stage || {};
  const statusColor = {
    open: color(cfg, 'brand', 0x3498db),
    completed: color(cfg, 'open', 0x2ecc71),
    cancelled: color(cfg, 'closed', 0xe74c3c),
    refund: color(cfg, 'refund', 0xe67e22),
  }[t.status];
  const info = new EmbedBuilder()
    .setColor(statusColor)
    .setAuthor({ name: `${name} • ${t.productLabel}`, iconURL: guild.iconURL({ size: 128 }) || undefined })
    .setTitle(`🧾 Detail Pesanan • ${t.id}`)
    .setDescription(`Halo <@${t.userId}>, terima kasih sudah berbelanja di **${name}**! 💜`)
    .addFields(
      { name: '👤 Pembeli', value: `<@${t.userId}>`, inline: true },
      { name: '🗓️ Paket', value: `\`${t.plan.label}\` • ${planDuration(t.plan)}`, inline: true },
      { name: '🚀 Jumlah Boost', value: `\`${num(t.qty)} boost\``, inline: true },
      { name: '⏱️ Estimasi', value: `\`${t.estimate || '1x24 jam'}\``, inline: true },
      { name: '🏠 Server Tujuan', value: `${serverLine(t.server)}\n🔗 ${t.invite}` },
      { name: '💰 Total Bayar', value: `## ${rupiah(t.price)}\n-# ${num(t.qty)} boost × ${rupiah(t.plan.price)}` },
      { name: '📍 Progress Boost', value: boostSteps(t) },
      { name: '📌 Status', value: `**${ticketStatusText(t)}**`, inline: true },
      { name: '💳 Pembayaran', value: payStatusText(t), inline: true },
      { name: '🕒 Dibuat', value: ts(t.createdAt, 'f'), inline: true },
    )
    .setThumbnail(t.server?.icon || product.thumbnail || guild.iconURL({ extension: 'png', size: 256 }) || null)
    .setFooter(serverFooter(guild, `${name} • Ticket ${t.id}`))
    .setTimestamp(t.closedAt || t.createdAt);
  if (t.closedAt) info.addFields({ name: '🔒 Ditutup', value: `${ts(t.closedAt, 'f')} oleh <@${t.closedBy}>`, inline: true });
  if (t.status === 'completed') info.addFields({ name: '🛡️ Garansi', value: `Selama masa aktif boost (${planDuration(t.plan)})`, inline: true });

  const embeds = [info];
  if (t.status === 'open') {
    embeds.push(...paymentEmbeds(guild, cfg, t));
    if (product.ticketNote) {
      embeds.push(new EmbedBuilder().setColor(color(cfg, 'refund', 0xe67e22)).setTitle(product.ticketNoteTitle || '📌 Penting').setDescription(fill(product.ticketNote, { name }).slice(0, 4096)));
    }
  }
  const components =
    t.status === 'open'
      ? [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`store:bssent:${t.id}`)
              .setLabel(st.sent ? 'Boost Terkirim' : 'Boost Terkirim (Admin)')
              .setEmoji('🚀')
              .setStyle(ButtonStyle.Primary)
              .setDisabled(Boolean(st.sent)),
            new ButtonBuilder()
              .setCustomId(`store:bsdone:${t.id}`)
              .setLabel(st.received ? 'Boost Sudah Masuk' : 'Boost Sudah Masuk')
              .setEmoji('✅')
              .setStyle(ButtonStyle.Success)
              .setDisabled(!st.sent || Boolean(st.received)),
            new ButtonBuilder().setCustomId(`store:close:${t.id}`).setLabel('Tutup Ticket').setEmoji('🔒').setStyle(ButtonStyle.Danger),
          ),
          ...paymentRows(t),
        ]
      : [];
  return { embeds, components };
}

/** Pemberitahuan langkah Server Boost di dalam ticket. step: 'sent' | 'received' */
function buildBoostStep(guild, cfg, t, step) {
  const name = storeName(cfg, guild);
  const e = new EmbedBuilder()
    .setColor(color(cfg, step === 'received' ? 'open' : 'brand', step === 'received' ? 0x2ecc71 : 0x3498db))
    .setFooter(serverFooter(guild, `${name} • Ticket ${t.id}`))
    .setTimestamp(new Date())
    .setThumbnail(t.server?.icon || null);
  let ping = [];
  if (step === 'sent') {
    ping = [t.userId];
    e.setTitle('🚀 Server Kamu Sudah Di-Boost!')
      .setDescription(`<@${t.userId}>, admin telah mem-boost server **${t.server?.name || 'kamu'}** dengan **${num(t.qty)} boost**. 🎉`)
      .addFields(
        { name: '📍 Progress', value: '`✅ Boost Dikirim` ➜ `⏳ Konfirmasi Pembeli` ➜ `▫️ Boost Aktif`' },
        {
          name: '🪄 Cara Cek Boost',
          value: [
            'Buka server kamu ➜ klik **nama server** di kiri atas',
            'Lihat bilah **Server Boost** & level server',
            'Pastikan jumlah boost bertambah sesuai pesanan',
            'Klik **✅ Boost Sudah Masuk** di ticket ini',
          ]
            .map((x, i) => `${KEYCAPS[i]} ${x}`)
            .join('\n'),
        },
      );
  } else if (step === 'received') {
    e.setTitle('🎉 Boost Sudah Masuk!')
      .setDescription(`<@${t.userId}> mengonfirmasi **${num(t.qty)} boost** sudah masuk ke server **${t.server?.name || '-'}**. ✨`)
      .addFields(
        { name: '📍 Progress', value: '`✅ Boost Dikirim` ➜ `✅ Konfirmasi Pembeli` ➜ `⏳ Boost Aktif`' },
        { name: '🔒 Langkah Terakhir — Admin', value: 'Admin akan menutup ticket ini sebagai **Completed**. Setelah itu kamu bisa memberi **testimoni** ⭐\n🛡️ Garansi berlaku selama masa aktif boost.' },
      );
  }
  return { content: ping.map((id) => `<@${id}>`).join(' ') || undefined, embeds: [e], allowedMentions: { users: ping } };
}

/** Pengingat masa aktif boost hampir habis (DM pembeli) / sudah habis (DM admin). */
function buildBoostExpiry(guild, cfg, t, who) {
  const name = storeName(cfg, guild);
  const e = new EmbedBuilder().setFooter(serverFooter(guild, name)).setTimestamp(new Date());
  if (who === 'buyer') {
    const url = panelUrlFor(guild, 'digital') || panelUrlFor(guild, 'main');
    e.setColor(color(cfg, 'refund', 0xe67e22))
      .setTitle('⏰ Server Boost Kamu Segera Berakhir')
      .setDescription(
        `Masa aktif **${num(t.qty)} Server Boost (${t.plan.label})** untuk server **${t.server?.name || '-'}** akan berakhir **${ts(t.expiresAt, 'R')}** (${ts(t.expiresAt, 'D')}).\n\n` +
          `Perpanjang sekarang di **${name}** supaya level server kamu tidak turun! 🚀` +
          (url ? `\n\n🛒 ${url}` : ''),
      );
  } else {
    e.setColor(color(cfg, 'closed', 0xe74c3c))
      .setTitle('⌛ Masa Aktif Server Boost Habis')
      .setDescription(`Masa aktif ticket **${t.id}** sudah berakhir.`)
      .addFields(
        { name: '👤 Pembeli', value: `<@${t.userId}>`, inline: true },
        { name: '🚀 Paket', value: `\`${num(t.qty)} Boost • ${t.plan.label}\``, inline: true },
        { name: '🏠 Server', value: `${t.server?.name || '-'}\n${t.invite}` },
      );
  }
  return { embeds: [e] };
}

// ══════════════════════ Panel & info produk (Components V2) ══════════════════════
function pcard({ accent, header, thumb, thumbOverride, image, images = [], blocks = [], footer, rows = [] }) {
  if (thumbOverride) thumb = thumbOverride;
  const box = UI.accent(new ContainerBuilder(), accent);
  if (thumb) box.addSectionComponents(new SectionBuilder().addTextDisplayComponents(v2Text(header)).setThumbnailAccessory(new ThumbnailBuilder().setURL(thumb)));
  else box.addTextDisplayComponents(v2Text(header));
  if (image) box.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(image)));
  if (images.length) box.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(images.slice(0, 10).map((u) => new MediaGalleryItemBuilder().setURL(u))));
  for (const b of blocks.filter(Boolean)) {
    box.addSeparatorComponents(v2Line());
    box.addTextDisplayComponents(v2Text(b));
  }
  if (footer) {
    box.addSeparatorComponents(v2Line());
    box.addTextDisplayComponents(v2Text(`-# ${footer}`));
  }
  for (const r of rows.filter(Boolean)) box.addActionRowComponents(r);
  return { components: [box], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } };
}
const icon256 = (guild) => guild.iconURL({ extension: 'png', size: 256 }) || null;
const nowTs = () => `<t:${Math.floor(Date.now() / 1000)}:f>`;
const openBadge = (open) => (open ? '`🟢 BUKA`' : '`🔴 TUTUP`');
const ratingLine = () => {
  const s = state.stats;
  const avg = s.ratingCount ? (s.ratingSum / s.ratingCount).toFixed(1) : '-';
  const stars = s.ratingCount ? STARS(Math.round(s.ratingSum / s.ratingCount)) : '☆☆☆☆☆';
  return `⭐ **Rating Toko:** ${stars} \`${avg} / 5\` (${num(s.ratingCount)} ulasan)`;
};
const termsButton = (product, label) =>
  product.terms?.description
    ? new ButtonBuilder().setCustomId(`store:terms:${product.id}`).setLabel(product.terms.button || label).setEmoji('📌').setStyle(ButtonStyle.Secondary)
    : null;
const btnRow = (buttons) => new ActionRowBuilder().addComponents(buttons.filter(Boolean).slice(0, 5));

/** Link ke panel tempat produk berada (store utama / produk digital). */
function panelUrlFor(guild, group = 'main') {
  const loc = state[GROUPS[group]?.panelKey || 'panel'] || state.panel;
  return loc ? `https://discord.com/channels/${guild.id}/${loc.channelId}/${loc.messageId}` : null;
}

/** Panel store (V2): judul, keterangan, total transaksi, rating, tombol produk. group = main | digital. */
function buildPanelV2(guild, cfg, group = 'main') {
  const p = groupText(cfg, group, 'panel');
  const name = { name: storeName(cfg, guild) };
  const s = state.stats;
  const products = productsOf(cfg, group);
  // Tombol produk tanpa warna (abu-abu). store.json → "panelButtonColors": true untuk memakai warna lagi.
  const styles = cfg.panelButtonColors === true ? { robux: ButtonStyle.Success, gamepass: ButtonStyle.Success, canva: ButtonStyle.Primary, rekber: ButtonStyle.Primary } : {};
  const buttons = products.slice(0, 5).map((prod) =>
    new ButtonBuilder()
      .setCustomId(`store:buy:${prod.id}`)
      .setLabel(prod.label)
      .setEmoji(prod.emoji || '🛒')
      .setStyle(styles[prod.type] || ButtonStyle.Secondary)
      .setDisabled(!isProductOpen(prod)),
  );
  const digital = group === 'digital';
  const orders = products.reduce((a, x) => a + (productStatsOf(x.id).orders || 0), 0);
  const stats = digital
    ? [`🧾 **Order Produk Digital:** \`${num(orders)} order\``, `🛒 **Produk Tersedia:** \`${products.filter((x) => x.type !== 'soon').length} produk\``, ratingLine()]
    : [`🧾 **Total Transaksi:** \`${num((s.transactions || 0) + (s.rekber || 0))} transaksi\``, ratingLine()];
  return pcard({
    accent: color(cfg, 'brand', 0x3498db),
    thumb: icon256(guild),
    header: `# ${fill(p.title || '🛒 {server}', name)}\n-# ${fill(p.subtitle || 'Official Store • {server}', name)}`,
    image: p.bannerImage || null,
    blocks: [fill(p.description, name) || null, stats.join('\n')],
    footer: `${name.name} • Diperbarui <t:${Math.floor(Date.now() / 1000)}:R>`,
    rows: buttons.length ? [new ActionRowBuilder().addComponents(buttons)] : [],
  });
}

/** Info Robux Visend (V2, hanya terlihat pembeli). */
function buildProductInfoV2(guild, cfg, product) {
  const open = isProductOpen(product);
  const name = { name: storeName(cfg, guild) };
  return pcard({
    accent: color(cfg, 'brand', 0x3498db),
    thumb: product.thumbnail || icon256(guild),
    header: `## ${product.emoji || '💎'} ${product.label}\n${fill(product.description || '', name)}`,
    blocks: [
      [`💎 **Harga:** \`${rupiah(rateOf(cfg, product))} / Robux\``, `📦 **Sisa Stock:** \`${num(state.stock)} Robux\``, `🏪 **Status:** ${openBadge(open)}`].join('\n'),
      [
        `🧾 **Total Transaksi:** \`${num(state.stats.transactions)} transaksi\``,
        `💎 **${product.label} Terjual:** \`${num(productStatsOf(product.id).robux)} Robux\``,
        ratingLine(),
      ].join('\n'),
    ],
    footer: `${name.name} • ${nowTs()}`,
    rows: [
      btnRow([
        new ButtonBuilder()
          .setCustomId(`store:order:${product.id}`)
          .setLabel(open ? 'Beli Sekarang' : 'Toko Sedang Tutup')
          .setEmoji('🛒')
          .setStyle(ButtonStyle.Success)
          .setDisabled(!open),
        product.howTo ? new ButtonBuilder().setCustomId(`store:howtobtn:${product.id}`).setLabel('Cara Order').setEmoji('📖').setStyle(ButtonStyle.Primary) : null,
        termsButton(product, 'Syarat Pembelian'),
      ]),
    ],
  });
}

/** Info Robux Gamepass (V2). */
function buildGamepassInfoV2(guild, cfg, product) {
  const open = isProductOpen(product);
  const name = { name: storeName(cfg, guild) };
  const ps = productStatsOf(product.id);
  const ex = gpExamples(cfg, product);
  const notes = (product.notes || []).map((n) => `▸ ${fill(n, name)}`);
  notes.push(`▸ ⏳ ${gpEstimate(product)}`);
  return pcard({
    accent: color(cfg, 'brand', 0x3498db),
    thumb: product.thumbnail || icon256(guild),
    header: `## ${product.emoji || '🎟️'} ${product.label}\n${fill(product.description || '', name)}`,
    blocks: [
      [`💱 **Rate:** \`${rupiah(rateOf(cfg, product))} / Robux\``, `⏱️ **Estimasi:** \`± ${num(product.pendingDays || 5)} hari\``, `🏪 **Status:** ${openBadge(open)}`].join('\n'),
      ex ? `### 📊 Contoh Harga (After Tax)\n${ex}` : null,
      `### 📝 Catatan\n${notes.join('\n')}`,
      [`🧾 **Transaksi Gamepass:** \`${num(ps.orders)} transaksi\``, `💎 **Robux Terkirim:** \`${num(ps.robux)} Robux\``, ratingLine()].join('\n'),
    ],
    footer: `${name.name} • ${nowTs()}`,
    rows: [btnRow(gpButtons(product))],
  });
}

/** Info Canva Pro (V2). */
function buildCanvaInfoV2(guild, cfg, product) {
  const open = isProductOpen(product);
  const name = { name: storeName(cfg, guild) };
  const ps = productStatsOf(product.id);
  const table = planTable(product);
  return pcard({
    accent: color(cfg, 'brand', 0x3498db),
    thumb: product.thumbnail || icon256(guild),
    header: `## ${product.emoji || '🎨'} ${product.label}\n${fill(product.description || '', name)}`,
    blocks: [
      table ? `### 🗓️ Pilihan Paket\n${table}` : null,
      [`🎟️ **Sisa Slot:** \`${num(stockOf(product))} ${stockUnit(product)}\``, `🏪 **Status:** ${openBadge(open)}`, '📧 **Aktivasi:** `Undangan via email`'].join('\n'),
      product.features?.length ? `### ✨ Keuntungan\n${product.features.map((x) => `▸ ${x}`).join('\n')}` : null,
      product.howItWorks?.length ? `### 🔄 Cara Kerja\n${product.howItWorks.map((x, i) => `${KEYCAPS[i] || `\`${i + 1}\``} ${x}`).join('\n')}` : null,
      [`✅ **Order Selesai:** \`${num(ps.orders)} order\``, `👥 **Member Aktif:** \`${num(canvaActiveCount(product.id))} member\``, ratingLine()].join('\n'),
    ],
    footer: `${name.name} • ${nowTs()}`,
    rows: [
      btnRow([
        new ButtonBuilder()
          .setCustomId(`store:order:${product.id}`)
          .setLabel(open ? 'Order Sekarang' : stockOf(product) <= 0 ? 'Slot Habis' : 'Sedang Tutup')
          .setEmoji('🛒')
          .setStyle(ButtonStyle.Success)
          .setDisabled(!open),
        product.howTo ? new ButtonBuilder().setCustomId(`store:howtobtn:${product.id}`).setLabel('Cara Order').setEmoji('📖').setStyle(ButtonStyle.Primary) : null,
        termsButton(product, 'Syarat'),
      ]),
    ],
  });
}

/** Info Rekber (V2). */
function buildRekberInfoV2(guild, cfg, product) {
  const open = isProductOpen(product);
  const name = { name: storeName(cfg, guild) };
  const s = state.stats;
  return pcard({
    accent: color(cfg, 'brand', 0x3498db),
    thumb: product.thumbnail || icon256(guild),
    header: `## ${product.emoji || '🤝'} ${product.label} — Rekening Bersama\n${fill(product.description || '', name)}`,
    blocks: [
      `### 🧾 Fee Rekber\n${feeTable(product) || '-'}`,
      [
        `💵 **Nominal Transaksi:** \`${rupiah(product.minNominal || 0)} – ${rupiah(product.maxNominal || 0)}\``,
        `💳 **Fee Ditanggung:** \`${(product.feePaidBy || 'pembeli') === 'penjual' ? 'Penjual' : 'Pembeli'}\``,
        `🏪 **Status:** ${openBadge(open)}`,
      ].join('\n'),
      [`🤝 **Rekber Sukses:** \`${num(s.rekber)} transaksi\``, `🛡️ **Dana Diamankan:** \`${rupiah(s.rekberVolume)}\``].join('\n'),
    ],
    footer: `${name.name} • ${nowTs()}`,
    rows: [
      btnRow([
        new ButtonBuilder()
          .setCustomId(`store:order:${product.id}`)
          .setLabel(open ? 'Buat Ticket Rekber' : 'Rekber Sedang Tutup')
          .setEmoji('🤝')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(!open),
        product.howTo ? new ButtonBuilder().setCustomId(`store:howtobtn:${product.id}`).setLabel('Cara Order').setEmoji('📖').setStyle(ButtonStyle.Secondary) : null,
        termsButton(product, 'Syarat & Ketentuan'),
      ]),
    ],
  });
}

/** Syarat produk (V2). */
function buildProductTermsV2(guild, cfg, product) {
  const t = product.terms || {};
  return pcard({
    accent: color(cfg, 'brand', 0x3498db),
    header: `## ${t.title || `📌 Persyaratan ${product.label}`}`,
    blocks: [fill(t.description || '-', { name: storeName(cfg, guild) })],
    footer: `${storeName(cfg, guild)} • ${nowTs()}`,
  });
}

/** Top 10 Spender (V2): podium 3 besar + peringkat 4–10 + statistik. */
function buildLeaderboardV2(guild, cfg) {
  const medals = ['🥇', '🥈', '🥉'];
  const top = Object.entries(state.spenders)
    .sort((a, b) => b[1].revenue - a[1].revenue || b[1].orders - a[1].orders)
    .slice(0, 10);
  const tierOf = (d) => {
    const tier = SP.tierFor(d.revenue, cfg);
    return tier ? ` • ${SP.tierLabel(tier)}` : '';
  };
  const podium = top
    .slice(0, 3)
    .map(([id, d], i) => `${medals[i]} <@${id}>\n┗ 💰 **${rupiah(d.revenue)}** • 🧾 ${num(d.orders)} order${tierOf(d)}`);
  const rest = top.slice(3).map(([id, d], i) => `\`#${i + 4}\` <@${id}> • 💰 **${rupiah(d.revenue)}** • ${num(d.orders)} order${tierOf(d)}`);
  const name = storeName(cfg, guild);
  return pcard({
    accent: color(cfg, 'brand', 0x3498db),
    thumb: icon256(guild),
    header: `# 🏆 Top 10 Spender | ${guild.name}\n-# ${name} • Spender Leaderboard`,
    blocks: [
      top.length ? `### 👑 Podium Sultan\n${podium.join('\n\n')}` : '_Belum ada transaksi. Jadilah spender pertama!_ 🚀',
      rest.length ? `### 📋 Peringkat 4 – 10\n${rest.join('\n')}` : null,
      [`🧾 **Total Transaksi:** \`${num(state.stats.transactions)} transaksi\``, `👥 **Total Pembeli:** \`${num(Object.keys(state.spenders).length)} pembeli\``].join('\n'),
    ],
    footer: `${name} • Diperbarui <t:${Math.floor(Date.now() / 1000)}:R>`,
  });
}

// ══════════════════════ Konversi embed → Components V2 (pesan di dalam ticket) ══════════════════════
/**
 * Ubah payload format embed (content + embeds + tombol) menjadi Components V2:
 * tiap embed = 1 kotak berwarna (judul + thumbnail, blok dipisah garis sampai ujung, gambar, footer),
 * tombol masuk ke dalam kotak terakhir, content (mention) tampil di atas kotak.
 */
function toV2(payload) {
  if (!payload) return payload;
  if ((payload.flags || 0) & MessageFlags.IsComponentsV2) return payload;
  const { content, embeds = [], components = [], ...rest } = payload;
  const clean = (v) => String(v ?? '').trim();
  const blank = (v) => !clean(v) || clean(v) === '​';

  // 1) Susun isi tiap embed jadi blok teks.
  const parts = [];
  for (const raw of embeds) {
    const e = raw?.toJSON ? raw.toJSON() : raw;
    if (!e) continue;
    const head = [];
    if (e.author?.name) head.push(`-# ${e.author.name}`);
    if (e.title) head.push(`## ${e.url ? `[${e.title}](${e.url})` : e.title}`);
    if (e.description) head.push(e.description);
    const blocks = [];
    let inline = [];
    const flush = () => {
      if (inline.length) blocks.push(inline.join('\n'));
      inline = [];
    };
    for (const f of e.fields || []) {
      if (blank(f.name) && blank(f.value)) continue;
      if (f.inline && !/^#/.test(clean(f.value))) {
        const v = clean(f.value).replace(/\n┗\s*/g, ' • ').replace(/\n+/g, ' • ');
        inline.push(blank(f.name) ? v : `**${f.name}:** ${v}`);
      } else {
        flush();
        blocks.push(blank(f.name) ? clean(f.value) : `### ${f.name}\n${clean(f.value)}`);
      }
    }
    flush();
    const foot = [e.footer?.text, e.timestamp ? `<t:${Math.floor(Date.parse(e.timestamp) / 1000)}:f>` : null].filter(Boolean).join(' • ');
    parts.push({ e, head: head.join('\n').slice(0, 3900) || '​', blocks, foot });
  }

  // 2) Batas Discord: maksimal 40 komponen per pesan → gabungkan blok terpendek kalau perlu.
  const rowCount = (components || []).reduce((n, r) => n + 1 + ((r.toJSON ? r.toJSON() : r).components?.length || 0), 0);
  const count = () =>
    (content && parts.length ? 1 : 0) +
    rowCount +
    parts.reduce((n, p) => n + 1 + (p.e.thumbnail?.url ? 3 : 1) + p.blocks.length * 2 + (p.e.image?.url ? 2 : 0) + (p.foot ? 2 : 0), 0);
  while (count() > 40) {
    const p = parts.filter((x) => x.blocks.length > 1).sort((x, y) => y.blocks.length - x.blocks.length)[0];
    if (!p) break;
    let best = 0;
    for (let i = 1; i < p.blocks.length - 1; i++) if (p.blocks[i].length + p.blocks[i + 1].length < p.blocks[best].length + p.blocks[best + 1].length) best = i;
    p.blocks.splice(best, 2, `${p.blocks[best]}\n\n${p.blocks[best + 1]}`);
  }

  // 3) Bangun kotak V2.
  const boxes = parts.map(({ e, head, blocks, foot }) => {
    const box = UI.accent(new ContainerBuilder(), e.color ?? null); // garis warna mengikuti ui.json
    if (e.thumbnail?.url) {
      box.addSectionComponents(new SectionBuilder().addTextDisplayComponents(v2Text(head)).setThumbnailAccessory(new ThumbnailBuilder().setURL(e.thumbnail.url)));
    } else box.addTextDisplayComponents(v2Text(head));
    for (const b of blocks) {
      box.addSeparatorComponents(v2Line());
      box.addTextDisplayComponents(v2Text(b));
    }
    if (e.image?.url) box.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(e.image.url)));
    if (foot) {
      box.addSeparatorComponents(v2Line());
      box.addTextDisplayComponents(v2Text(`-# ${foot}`));
    }
    return box;
  });
  const out = [];
  if (!boxes.length) {
    const box = UI.accent(new ContainerBuilder(), color(loadConfig() || {}, 'brand', 0x3498db));
    box.addTextDisplayComponents(v2Text(content || '​'));
    boxes.push(box);
  } else if (content) out.push(v2Text(content));
  for (const r of components || []) boxes.at(-1).addActionRowComponents(r);
  // Lampiran yang tidak tampil sebagai gambar (misal transcript .txt) → komponen File supaya tetap terlihat.
  const used = JSON.stringify(boxes.map((b) => b.toJSON()));
  for (const f of rest.files || []) {
    const name = f?.name || f?.attachment?.name;
    if (name && !used.includes(`attachment://${name}`)) boxes.at(-1).addFileComponents(new FileBuilder().setURL(`attachment://${name}`));
  }
  return { ...rest, components: [...out, ...boxes], flags: (payload.flags || 0) | MessageFlags.IsComponentsV2 };
}

/** Pesan DM (pembeli / owner) → Components V2 premium. Mention di atas kotak dibuang (tidak perlu di DM). */
function dm(payload) {
  if (!payload) return payload;
  const { content, ...rest } = payload;
  void content;
  const out = toV2({ ...rest, allowedMentions: { parse: [] } });
  return { ...out, allowedMentions: { parse: [] } };
}

module.exports = {
  toV2,
  dm,
  boostPrice,
  boostTable,
  boostStockLines,
  boostActiveCount,
  buildBoostInfo,
  buildBoostConfirm,
  buildBoostTicket,
  buildBoostStep,
  buildBoostExpiry,
  panelUrlFor,
  payAmount,
  isPaid,
  paymentEmbeds,
  paymentRows,
  payMethods,
  buildCopyAccounts,
  buildPaymentProof,
  buildDanaMasuk,
  buildPayRejected,
  itemText,
  maskEmail,
  canvaPlans,
  planSaving,
  planTable,
  minPlanPrice,
  canvaActiveCount,
  buildCanvaInfo: buildCanvaInfoV2,
  buildCanvaConfirm,
  buildCanvaStep,
  buildCanvaExpiry,
  gpUrl,
  gpQuote,
  gpAfterTax,
  gpBeforeTax,
  buildGamepassInfo: buildGamepassInfoV2,
  buildGamepassTutorial,
  buildGamepassCalc,
  buildGamepassConfirm,
  buildGamepassCheck,
  STATUS_LABEL,
  REKBER_STATUS,
  statusLabel,
  testimonyUserId,
  rekberFee,
  buildRekberInfo: buildRekberInfoV2,
  buildRekberConfirm,
  buildRekberDmCreated,
  buildRekberStep,
  buildOrderLog: buildOrderLogV2,
  buildOrderLogLegacy: buildOrderLog,
  buildTestimonyThanks,
  rateOf,
  buildPanel: buildPanelV2,
  buildProductInfo: buildProductInfoV2,
  buildProductTerms: buildProductTermsV2,
  storeName,
  buildLeaderboard: buildLeaderboardV2,
  buildLeaderboardLegacy: buildLeaderboard,
  buildConfirmAccount,
  buildAmountPicker,
  buildTicketMessage,
  buildDmCreated,
  buildDmClosed,
  buildTestimonyPrompt,
  buildTestimony: buildTestimonyV2,
  buildTestimonyLegacy: buildTestimony,
  buildStoreAnnouncement,
  buildStoreAnnouncementV2,
};
