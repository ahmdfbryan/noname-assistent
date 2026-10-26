const {
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
  MessageFlags,
} = require('discord.js');
const UI = require('../ui');
const { color, rupiah, num, fill } = require('./config');
const { state, isProductOpen, stockOf, stockUnit } = require('./state');
const V = require('./views');

/**
 * Channel "How to Order": panel dengan dropdown produk (Components V2 → garis pemisah pas sampai ujung).
 * Pilih produk → panduan lengkap muncul (hanya terlihat yang memilih).
 * Isi teks diatur di store.json → howToOrder & products[].howTo
 */
const KEYCAPS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
const steps = (list) => (list || []).map((x, i) => `${KEYCAPS[i] || `\`${i + 1}\``} ${x}`).join('\n');
const bullets = (list) => (list || []).map((x) => `▸ ${x}`).join('\n');
const guideProducts = (cfg) => (cfg.products || []).filter((p) => p.type !== 'soon' && p.howTo);

const line = () => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
const text = (content) => new TextDisplayBuilder().setContent(String(content).slice(0, 4000));
const V2 = MessageFlags.IsComponentsV2;

/** Kotak V2: header (+ logo), lalu blok-blok teks dipisah garis. */
function card(cfg, guild, { header, blocks = [], image, rows = [], thumb = true }) {
  const box = UI.accent(new ContainerBuilder(), color(cfg, 'brand', 0x3498db));
  const icon = thumb ? guild.iconURL({ extension: 'png', size: 256 }) : null;
  if (icon) box.addSectionComponents(new SectionBuilder().addTextDisplayComponents(text(header)).setThumbnailAccessory(new ThumbnailBuilder().setURL(icon)));
  else box.addTextDisplayComponents(text(header));
  if (image) box.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(image)));
  for (const b of blocks.filter(Boolean)) {
    box.addSeparatorComponents(line());
    box.addTextDisplayComponents(text(b));
  }
  for (const r of rows.filter(Boolean)) box.addActionRowComponents(r);
  return { components: [box], flags: V2, allowedMentions: { parse: [] } };
}

const { groupOf } = require('./config');

function storeLinkButton(guild, label = 'Order di Store', product = null) {
  // Produk digital (Canva Pro, ...) → link ke panel Produk Digital.
  const url = V.panelUrlFor(guild, product ? groupOf(product) : 'main');
  return url ? new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(label).setEmoji('🛒').setURL(url) : null;
}
const linkRow = (guild, label) => {
  const b = storeLinkButton(guild, label);
  return b ? new ActionRowBuilder().addComponents(b) : null;
};

/** Ringkasan singkat produk (tampil di dropdown). */
function productSummary(cfg, p) {
  if (p.type === 'robux') return `${rupiah(V.rateOf(cfg, p))}/Robux • Stock ${num(state.stock)}`;
  if (p.type === 'gamepass') return `${rupiah(V.rateOf(cfg, p))}/Robux • ± ${num(p.pendingDays || 5)} hari`;
  if (p.type === 'rekber') return `Mulai ${rupiah(p.minNominal || 0)} • Dana aman`;
  if (p.type === 'canva') return `Mulai ${rupiah(V.minPlanPrice(p))} • Slot ${num(stockOf(p))}`;
  if (p.type === 'boost') return `Mulai ${rupiah(V.minPlanPrice(p))}/boost • Stock ${num(stockOf(p))} boost`;
  return p.howTo?.short || '';
}

// ───────────────────────── Panel utama ─────────────────────────
function buildHowToPanel(guild, cfg) {
  const h = cfg.howToOrder || {};
  const name = { name: V.storeName(cfg, guild) };
  const products = guideProducts(cfg);

  const options = products.slice(0, 22).map((p) => ({
    label: `Cara Order ${p.label}`.slice(0, 100),
    description: productSummary(cfg, p).slice(0, 100) || undefined,
    value: p.id,
    emoji: p.emoji || '🛒',
  }));
  options.push({ label: 'Metode Pembayaran', description: 'Cara bayar & konfirmasi pembayaran', value: '_pay', emoji: '💳' });
  if (h.faq?.length) options.push({ label: 'FAQ — Pertanyaan Umum', description: 'Jawaban pertanyaan yang sering ditanyakan', value: '_faq', emoji: '❓' });

  return card(cfg, guild, {
    header: `# ${fill(h.title || '📖 How to Order', name)}\n${fill(h.description || '', name)}`,
    image: h.bannerImage || null,
    blocks: [
      h.flow ? `### ⚡ Alur Order Singkat\n${h.flow}` : null,
      h.whyUs?.length ? `### 🛡️ Kenapa ${V.storeName(cfg, guild)}?\n${bullets(h.whyUs)}` : null,
      `### 👇 Pilih Panduan\n${h.pickText || 'Pilih produk di menu bawah untuk melihat **cara order lengkap**. Panduan hanya terlihat olehmu.'}`,
    ],
    rows: [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId('store:howto').setPlaceholder('📖 Pilih produk untuk melihat cara order...').addOptions(options),
      ),
      linkRow(guild, 'Buka Store'),
    ],
  });
}

// ───────────────────────── Panduan per produk (hanya terlihat yang memilih) ─────────────────────────
function buildHowToGuide(guild, cfg, value) {
  const name = { name: V.storeName(cfg, guild) };
  const h = cfg.howToOrder || {};

  if (value === '_pay') {
    const pay = cfg.payment || {};
    const methods = V.payMethods(cfg);
    const list = methods.length
      ? methods.map((m) => `${m.emoji || '🏦'} **${m.bank}** — \`${m.number}\`${m.holder ? ` (a.n. ${m.holder})` : ''}`).join('\n')
      : bullets(h.paymentMethods);
    return card(cfg, guild, {
      header: `## 💳 Metode Pembayaran\n${fill(h.paymentIntro || 'Semua pembayaran dilakukan **di dalam ticket** setelah ticket order dibuat.', name)}`,
      blocks: [
        `### 🧾 Langkah Pembayaran\n${h.paymentSteps?.length ? steps(h.paymentSteps) : fill(pay.description || '-', name)}`,
        list ? `### 🏦 Rekening Tersedia${pay.accountName ? ` (a.n. ${pay.accountName})` : ''}\n${list}` : null,
      ],
      image: pay.image || null,
      rows: [linkRow(guild)],
    });
  }

  if (value === '_faq') {
    const faq = (h.faq || []).slice(0, 20).map((f) => `**💬 ${f.q}**\n${fill(f.a, name)}`);
    return card(cfg, guild, {
      header: `## ❓ FAQ — Pertanyaan Umum\nPertanyaan yang paling sering ditanyakan pembeli **${name.name}**:`,
      blocks: faq,
      rows: [linkRow(guild)],
    });
  }

  const p = (cfg.products || []).find((x) => x.id === value);
  if (!p?.howTo) return card(cfg, guild, { header: 'Panduan untuk produk ini belum tersedia.', thumb: false });
  const ht = p.howTo;
  const open = isProductOpen(p);

  // Info singkat (live dari data toko)
  const info = [`🏪 **Status:** ${open ? '`🟢 BUKA`' : '`🔴 TUTUP`'}`];
  if (p.type === 'robux') info.push(`💱 **Rate:** \`${rupiah(V.rateOf(cfg, p))} / Robux\``, `📦 **Stock:** \`${num(state.stock)} Robux\``);
  else if (p.type === 'gamepass') info.push(`💱 **Rate:** \`${rupiah(V.rateOf(cfg, p))} / Robux\``, `⏱️ **Estimasi:** \`± ${num(p.pendingDays || 5)} hari\``);
  else if (p.type === 'boost') info.push(`💱 **Harga:** \`Mulai ${rupiah(V.minPlanPrice(p))} / boost\``, `⏱️ **Estimasi:** \`${p.estimate || '1x24 jam'}\``, `🚀 **Stock per Paket:**\n${V.boostStockLines(p)}`);
  else if (p.type === 'canva') info.push(`💱 **Harga:** \`Mulai ${rupiah(V.minPlanPrice(p))}\``, `🎟️ **Sisa Slot:** \`${num(stockOf(p))} ${stockUnit(p)}\``);
  else if (p.type === 'rekber') {
    info.push(
      `💵 **Nominal:** \`${rupiah(p.minNominal || 0)} – ${rupiah(p.maxNominal || 0)}\``,
      `💳 **Fee:** \`Ditanggung ${(p.feePaidBy || 'pembeli') === 'penjual' ? 'penjual' : 'pembeli'}\``,
    );
  }

  const buttons = [];
  const link = storeLinkButton(guild, 'Order di Store', p);
  if (link) buttons.push(link);
  if (p.type === 'gamepass') {
    buttons.push(
      new ButtonBuilder().setCustomId(`store:gpprice:${p.id}`).setLabel('Cek Harga').setEmoji('💰').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`store:gptax:${p.id}`).setLabel('Tax Calculator').setEmoji('🧮').setStyle(ButtonStyle.Primary),
    );
  }
  if (p.terms?.description) {
    buttons.push(new ButtonBuilder().setCustomId(`store:terms:${p.id}`).setLabel(p.terms.button || 'Syarat').setEmoji('📌').setStyle(ButtonStyle.Secondary));
  }

  return card(cfg, guild, {
    header: `## ${p.emoji || '🛒'} Cara Order ${p.label}\n${fill(ht.intro || '', name)}`,
    blocks: [
      info.join('\n'),
      ht.requirements?.length ? `### 📋 Yang Perlu Disiapkan\n${bullets(ht.requirements)}` : null,
      ht.steps?.length ? `### 🧭 Langkah Order\n${steps(ht.steps)}` : null,
      ht.tips?.length ? `### 💡 Tips\n${bullets(ht.tips)}` : null,
    ],
    image: ht.image || null,
    rows: [buttons.length ? new ActionRowBuilder().addComponents(buttons.slice(0, 5)) : null],
  });
}

module.exports = { buildHowToPanel, buildHowToGuide };
