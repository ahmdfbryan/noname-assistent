const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
} = require('discord.js');
const UI = require('../ui');
const { color, rupiah, num, fill, productsOf, groupOf, groupText } = require('./config');
const { state, isProductOpen, productStatsOf, stockOf, stockUnit } = require('./state');
const V = require('./views');

/**
 * Channel Catalog (Components V2): 1 kotak header + 1 kotak per produk (masing-masing dengan tombolnya sendiri).
 * Semua kartu ter-update otomatis (status, harga, stock, terjual, rating).
 * Teks diatur di store.json → catalog & products[].catalog
 */
const STARS = (avg) => {
  const full = Math.round(avg);
  return '⭐'.repeat(full) + '☆'.repeat(5 - full);
};
const bullets = (list) => (list || []).map((x) => `▸ ${x}`).join('\n');
/** Produk yang tampil di katalog sesuai grup (main = store utama, digital = produk digital). */
const catalogProducts = (cfg, group = 'main') => productsOf(cfg, group).slice(0, 9);

const V2 = MessageFlags.IsComponentsV2;
const text = (c) => new TextDisplayBuilder().setContent(String(c).slice(0, 4000));
const line = () => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);

/** Kotak V2: header (+ thumbnail) → blok dipisah garis → gambar → footer → tombol. */
function card({ accent, header, thumb, blocks = [], image, footer, rows = [] }) {
  const box = UI.accent(new ContainerBuilder(), accent);
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
const footerText = (guild, cfg) => `${V.storeName(cfg, guild)} • <t:${Math.floor(Date.now() / 1000)}:f>`;

/** Rating rata-rata khusus satu produk (dari testimoni ticket produk tersebut). */
function productRating(productId) {
  const rated = Object.values(state.tickets).filter((t) => t.productId === productId && t.testimony);
  if (!rated.length) return null;
  return { avg: rated.reduce((a, t) => a + t.testimony.rating, 0) / rated.length, count: rated.length };
}

/** Tabel harga rata kanan di dalam code block. */
function priceTable(rows) {
  if (!rows.length) return null;
  const w = Math.max(...rows.map((r) => r[0].length));
  return '```\n' + rows.map(([a, b]) => `${a.padStart(w)}  ➜  ${b}`).join('\n') + '\n```';
}

function statusBadge(p) {
  if (p.type === 'soon') return '`🔒 SEGERA HADIR`';
  return isProductOpen(p) ? '`🟢 BUKA`' : '`🔴 TUTUP`';
}

// ───────────────────────── Kotak header ─────────────────────────
function buildCatalogHeader(guild, cfg, group = 'main') {
  const c = groupText(cfg, group, 'catalog');
  const name = { name: V.storeName(cfg, guild) };
  const s = state.stats;
  const avg = s.ratingCount ? (s.ratingSum / s.ratingCount).toFixed(1) : '-';
  const sellable = productsOf(cfg, group).filter((p) => p.type !== 'soon');
  const open = sellable.filter((p) => isProductOpen(p)).length;
  return card({
    accent: color(cfg, 'brand', 0x3498db),
    thumb: guild.iconURL({ extension: 'png', size: 256 }),
    header: `# ${fill(c.title || '🛍️ Katalog Produk | {server}', name)}\n-# ${fill(c.subtitle || (group === 'digital' ? 'Digital Catalog • {server}' : 'Official Catalog • {server}'), name)}`,
    blocks: [
      fill(c.description || '', name) || null,
      [
        `🛒 **Produk Buka:** \`${open} / ${sellable.length} produk\``,
        group === 'digital'
          ? `🧾 **Order Produk Digital:** \`${num(sellable.reduce((a, p) => a + (productStatsOf(p.id).orders || 0), 0))} order\``
          : `🧾 **Total Transaksi:** \`${num((s.transactions || 0) + (s.rekber || 0))} transaksi\``,
        `⭐ **Rating Pembeli:** \`${avg} / 5 (${num(s.ratingCount)} ulasan)\``,
      ].join('\n'),
    ],
    image: c.bannerImage || null,
  });
}

// ───────────────────────── Kotak produk ─────────────────────────
function buildCatalogCard(guild, cfg, p) {
  const cc = p.catalog || {};
  const name = { name: V.storeName(cfg, guild) };
  const open = isProductOpen(p);
  const ps = productStatsOf(p.id);
  const rating = productRating(p.id);
  const soon = p.type === 'soon';
  const tagline = fill(cc.tagline || (soon ? 'Produk baru sedang kami siapkan. **Nantikan kejutannya!** 👀' : ''), name);

  let info = [];
  let table = null;
  let tableTitle = '';
  if (p.type === 'robux') {
    const rate = V.rateOf(cfg, p);
    const list = (cc.priceList || (p.presets || []).filter((a) => [100, 500, 1000].includes(a))).slice(0, 8);
    info = [`💱 **Harga:** \`${rupiah(rate)} / Robux\``, `📦 **Stock:** \`${num(state.stock)} Robux\``];
    table = priceTable(list.map((a) => [`${num(a)} Robux`, rupiah(a * rate)]));
    tableTitle = '📊 Daftar Harga';
  } else if (p.type === 'gamepass') {
    const list = (cc.priceList || p.examples || []).slice(0, 8);
    info = [`💱 **Harga:** \`${rupiah(V.rateOf(cfg, p))} / Robux\``, `⏱️ **Estimasi:** \`± ${num(p.pendingDays || 5)} hari\``];
    table = priceTable(list.map((a) => [`${num(a)} Robux`, rupiah(V.gpQuote(cfg, p, V.gpBeforeTax(p, a)).price)]));
    tableTitle = '📊 Daftar Harga (After Tax)';
  } else if (p.type === 'boost') {
    info = [`💱 **Harga:** \`Mulai ${rupiah(V.minPlanPrice(p))} / boost\``, `⏱️ **Estimasi:** \`${p.estimate || '1x24 jam'}\``, `🚀 **Stock per Paket:**`, V.boostStockLines(p)];
    table = V.boostTable(p);
    tableTitle = '🗓️ Pilihan Paket (per boost)';
  } else if (p.type === 'canva') {
    info = [`💱 **Harga:** \`Mulai ${rupiah(V.minPlanPrice(p))}\``, `🎟️ **Sisa Slot:** \`${num(stockOf(p))} ${stockUnit(p)}\``];
    table = V.planTable(p);
    tableTitle = '🗓️ Pilihan Paket';
  } else if (p.type === 'rekber') {
    info = [
      `💵 **Nominal:** \`${rupiah(p.minNominal || 0)} – ${rupiah(p.maxNominal || 0)}\``,
      `💳 **Fee:** \`Ditanggung ${(p.feePaidBy || 'pembeli') === 'penjual' ? 'penjual' : 'pembeli'}\``,
    ];
    table = priceTable((p.feeTiers || []).map((x) => [x.upTo == null ? 'Di atas itu' : `≤ ${rupiah(x.upTo)}`, x.percent != null ? `${x.percent}%` : rupiah(x.fee)]));
    tableTitle = '🧾 Fee Rekber';
  }
  info.push(`🏪 **Status:** ${statusBadge(p)}`);

  let stats = null;
  if (!soon) {
    const sold =
      p.type === 'rekber'
        ? [`🤝 **Rekber Sukses:** \`${num(state.stats.rekber)} transaksi\``, `🛡️ **Dana Diamankan:** \`${rupiah(state.stats.rekberVolume)}\``]
        : p.type === 'canva'
          ? [`✅ **Order Selesai:** \`${num(ps.orders)} order\``, `👥 **Member Aktif:** \`${num(V.canvaActiveCount(p.id))} member\``]
          : p.type === 'boost'
          ? [`✅ **Order Selesai:** \`${num(ps.orders)} order\``, `🚀 **Boost Aktif:** \`${num(V.boostActiveCount(p.id))} boost\``]
          : [`✅ **Order Selesai:** \`${num(ps.orders)} order\``, `💎 **Robux Terjual:** \`${num(ps.robux)} Robux\``];
    sold.push(`⭐ **Rating:** ${rating ? `${STARS(rating.avg)} \`${rating.avg.toFixed(1)}\` (${num(rating.count)} ulasan)` : '`Belum ada ulasan`'}`);
    stats = sold.join('\n');
  }

  // Tombol kotak
  const buttons = [];
  if (soon) {
    buttons.push(new ButtonBuilder().setCustomId(`store:buy:${p.id}`).setLabel('Segera Hadir').setEmoji('🔒').setStyle(ButtonStyle.Secondary).setDisabled(true));
  } else {
    // Order Sekarang → langsung ke panel tempat produk ini dijual (Store Utama / Produk Digital).
    const panelUrl = open ? V.panelUrlFor(guild, groupOf(p)) : null;
    buttons.push(
      panelUrl
        ? new ButtonBuilder()
            .setStyle(ButtonStyle.Link)
            .setURL(panelUrl)
            .setLabel(p.type === 'rekber' ? 'Mulai Rekber' : 'Order Sekarang')
            .setEmoji('🛒')
        : new ButtonBuilder()
            .setCustomId(`store:buy:${p.id}`)
            .setLabel(open ? (p.type === 'rekber' ? 'Mulai Rekber' : 'Order Sekarang') : p.type === 'canva' && stockOf(p) <= 0 ? 'Slot Habis' : p.type === 'boost' && stockOf(p) <= 0 ? 'Stock Habis' : 'Sedang Tutup')
            .setEmoji(open ? '🛒' : '🔴')
            .setStyle(open ? ButtonStyle.Success : ButtonStyle.Secondary)
            .setDisabled(!open),
    );
    if (p.howTo) buttons.push(new ButtonBuilder().setCustomId(`store:howtobtn:${p.id}`).setLabel('Cara Order').setEmoji('📖').setStyle(ButtonStyle.Primary));
    if (p.type === 'gamepass') {
      buttons.push(new ButtonBuilder().setCustomId(`store:gptax:${p.id}`).setLabel('Tax Calculator').setEmoji('🧮').setStyle(ButtonStyle.Primary));
    }
    if (p.terms?.description) {
      buttons.push(new ButtonBuilder().setCustomId(`store:terms:${p.id}`).setLabel(p.terms.button || 'Syarat').setEmoji('📌').setStyle(ButtonStyle.Secondary));
    }
  }

  return card({
    accent: color(cfg, 'brand', 0x3498db),
    thumb: cc.thumbnail || guild.iconURL({ extension: 'png', size: 256 }),
    header: `## ${p.emoji || '🛒'} ${p.label}${tagline ? `\n${tagline}` : ''}`,
    blocks: [
      info.join('\n'),
      table ? `### ${tableTitle}\n${table}` : null,
      cc.highlights?.length ? `### ✨ Keunggulan\n${bullets(cc.highlights)}` : null,
      stats,
    ],
    image: cc.image || null,
    // Footer (Noname Store + waktu) hanya di kotak paling bawah.
    footer: catalogProducts(cfg, groupOf(p)).at(-1)?.id === p.id ? footerText(guild, cfg) : null,
    rows: [new ActionRowBuilder().addComponents(buttons.slice(0, 5))],
  });
}

module.exports = { buildCatalogHeader, buildCatalogCard, catalogProducts };
