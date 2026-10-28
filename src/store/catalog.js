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
const I = require('./instant');
const fs = require('fs');
const path = require('path');

/**
 * Gambar kecil (kanan atas) tiap kartu produk.
 * Urutan: store.json → products[].catalog.thumbnail (link https ATAU path file di folder bot)
 *         → file otomatis assets/products/<id produk>.png (Coming Soon: assets/products/coming-soon.png)
 *         → logo server.
 * File lokal ikut dikirim bersama kartu (attachment) supaya tidak pernah kedaluwarsa.
 */
function productImage(guild, p) {
  const set = String(p.catalog?.thumbnail || '').trim();
  if (/^https?:\/\//i.test(set)) return { url: set, files: [] };
  const root = path.join(__dirname, '..', '..');
  const candidates = [set, `assets/products/${p.id}.png`, p.type === 'soon' ? 'assets/products/coming-soon.png' : null].filter(Boolean);
  for (const rel of candidates) {
    const file = path.join(root, rel);
    if (fs.existsSync(file)) {
      const name = `product-${String(p.id).replace(/[^\w-]/g, '')}${path.extname(file) || '.png'}`;
      return { url: `attachment://${name}`, files: [{ attachment: file, name }] };
    }
  }
  return { url: guild.iconURL({ extension: 'png', size: 256 }), files: [] };
}

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
/**
 * Kartu produk ringkas: nama + tagline → Harga / Stock / Status → tombol Beli Sekarang & Cara Order.
 */
function buildCatalogCard(guild, cfg, p) {
  const cc = p.catalog || {};
  const name = { name: V.storeName(cfg, guild) };
  const open = isProductOpen(p);
  const soon = p.type === 'soon';
  const tagline = fill(cc.tagline || (soon ? 'Produk baru sedang kami siapkan. **Nantikan kejutannya!** 👀' : ''), name);

  const info = [];
  if (p.type === 'robux') {
    info.push(`💱 **Harga:** \`${rupiah(V.rateOf(cfg, p))} / Robux\``, `📦 **Stock:** \`${num(state.stock)} Robux\``);
  } else if (p.type === 'gamepass') {
    info.push(`💱 **Harga:** \`${rupiah(V.rateOf(cfg, p))} / Robux\``);
  } else if (p.type === 'canva') {
    info.push(`💱 **Harga:** \`Mulai ${rupiah(V.minPlanPrice(p))}\``, `📦 **Stock:** \`${num(stockOf(p))} ${stockUnit(p)}\``);
  } else if (p.type === 'boost') {
    info.push(`💱 **Harga:** \`Mulai ${rupiah(V.minPlanPrice(p))} / boost\``, `📦 **Stock:** \`${num(stockOf(p))} ${stockUnit(p)}\``);
  } else if (p.type === 'instant') {
    const s = I.summaryOf(p);
    info.push(
      `💱 **Harga:** \`${s.min ? `Mulai ${rupiah(s.min)}` : '-'}\``,
      `📦 **Stock:** \`${s.ready ? `${num(s.products)} produk • ${num(s.variants)} varian` : 'Memuat...'}\``,
      '⚡ **Pengiriman:** `Otomatis`',
    );
  } else if (p.type === 'rekber') {
    const fees = (p.feeTiers || []).map((x) => (x.percent != null ? null : Number(x.fee))).filter((x) => x != null);
    const pct = (p.feeTiers || []).find((x) => x.percent != null);
    info.push(`💱 **Fee:** \`${fees.length ? `Mulai ${rupiah(Math.min(...fees))}` : pct ? `${pct.percent}%` : '-'}\``);
  }
  if (!soon) info.push(`🏪 **Status:** ${statusBadge(p)}`);

  // Tombol: Beli Sekarang (→ panel tempat produk dijual) + Cara Order
  const buttons = [];
  if (!soon) {
    const panelUrl = open ? V.panelUrlFor(guild, groupOf(p)) : null;
    buttons.push(
      panelUrl
        ? new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(panelUrl).setLabel('Beli Sekarang').setEmoji('🛒')
        : new ButtonBuilder()
            .setCustomId(`store:buy:${p.id}`)
            .setLabel('Beli Sekarang')
            .setEmoji('🛒')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(!open),
    );
    if (p.howTo) buttons.push(new ButtonBuilder().setCustomId(`store:howtobtn:${p.id}`).setLabel('Cara Order').setEmoji('📖').setStyle(ButtonStyle.Secondary));
  }

  const img = productImage(guild, p);
  const payload = card({
    accent: color(cfg, 'brand', 0x3498db),
    thumb: img.url,
    header: `## ${p.emoji || '🛒'} ${p.label}${tagline ? `\n${tagline}` : ''}`,
    // Coming Soon: hanya nama, tagline & gambar (tanpa status & tombol).
    blocks: [info.length ? info.join('\n') : null],
    rows: [buttons.length ? new ActionRowBuilder().addComponents(buttons) : null],
  });
  if (img.files.length) payload.files = img.files;
  return payload;
}

module.exports = { buildCatalogHeader, buildCatalogCard, catalogProducts };
