const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  LabelBuilder,
  StringSelectMenuBuilder,
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  ChannelType,
} = require('discord.js');
const UI = require('../ui');
const W = require('./waroengkuy');
const { loadConfig, isId, rupiah, num, fill, ts } = require('./config');
const { state, save, productStatsOf, isProductOpen, kindOf, activeTicketOf, nextTicketId } = require('./state');
const V = require('./views');
const SP = require('./spender');

/**
 * ⚡ PREMIUM APP — produk digital otomatis dari API Reseller Waroeng.
 * Produk, stock & harga diambil langsung dari API; pembayaran QRIS dicek otomatis;
 * akun dikirim otomatis ke ticket + DM pembeli. Masalah (stok habis, saldo kurang, API error)
 * dilaporkan ke channel alert admin.
 *
 * Pengaturan: store.json → products[] dengan "type": "instant" (lihat petunjuk di store.json).
 */

const EPH = MessageFlags.Ephemeral;
const V2F = MessageFlags.IsComponentsV2;
const SESSION_MS = 15 * 60 * 1000;
const POLL_MS = 10 * 1000;
const sessions = new Map(); // userId → { cat, page, wrkProductId, draft, expires }
const busy = new Set(); // ticket yang sedang diproses (hindari dobel)
let ctx = null; // fungsi dari flow.js (client, logOrder, refreshPanel, ...)

const isAdmin = (member) => member?.permissions?.has(PermissionFlagsBits.Administrator);
const channelUrl = (guildId, channelId) => `https://discord.com/channels/${guildId}/${channelId}`;
const text = (c) => new TextDisplayBuilder().setContent(String(c || '​').slice(0, 4000));
const line = () => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
const clip = (s, n) => {
  const c = String(s ?? '');
  return c.length > n ? `${c.slice(0, n - 1)}…` : c;
};
const brand = (cfg) => parseInt(String(cfg?.colors?.brand || '#3498DB').replace('#', ''), 16);

// ═════════════════════════════ Pengaturan produk ═════════════════════════════
const instantProduct = (cfg, id) => (cfg?.products || []).find((p) => p.type === 'instant' && (!id || p.id === id)) || null;
/** deposit (default) = pembeli bayar QRIS isi saldo seharga harga jual → bot beli pakai saldo (margin masuk saldo).
 *  qris = QRIS order langsung dari Waroeng (harga = harga reseller, tanpa margin).
 *  manual = transfer ke rekening toko + admin klik Dana Masuk → akun dikirim otomatis pakai saldo. */
const payMode = (p) => (['deposit', 'qris', 'manual'].includes(p?.payment?.mode) ? p.payment.mode : 'deposit');
const minTotal = (p) => (payMode(p) === 'deposit' ? 10000 : payMode(p) === 'qris' ? 1000 : Number(p?.payment?.minTotal) || 0);
const maxQty = (p) => Math.min(Math.max(Number(p?.maxQty) || 5, 1), payMode(p) === 'qris' ? 10 : 50);
const alertChannelOf = (cfg, p) => [p?.alertChannelId, cfg?.channels?.instantAlert, cfg?.channels?.alert].find(isId) || null;

/** Harga jual per akun. */
function sellPrice(p, item) {
  const cost = Number(item.price) || 0;
  if (payMode(p) === 'qris') return cost;
  const pr = p.pricing || {};
  const fixed = Number(pr.overrides?.[String(item.variant_id)]);
  if (fixed > 0) return fixed;
  const step = Math.max(1, Number(pr.roundTo ?? 500));
  const minProfit = Math.max(0, Number(pr.minProfit ?? 500));
  let price = Math.ceil((cost * (1 + (Number(pr.percent ?? 10) || 0) / 100) + (Number(pr.flat) || 0)) / step) * step;
  // Tidak lebih mahal dari harga toko resmi Waroeng (selama masih untung minimal minProfit).
  if (pr.capAtNormalPrice !== false && Number(item.normal_price) > cost) price = Math.min(price, Math.max(Number(item.normal_price), cost + minProfit));
  return Math.max(price, cost + minProfit);
}

/** Varian yang boleh dijual (filter store.json). */
function sellable(p, items) {
  const f = p.filter || {};
  const low = (a) => (a || []).map((x) => String(x).toLowerCase());
  const onlyCat = low(f.categories);
  const hideCat = low(f.hideCategories);
  const hideProd = (f.hideProducts || []).map(String);
  const hideVar = (f.hideVariants || []).map(String);
  return (items || []).filter((it) => {
    const cat = String(it.category || 'Lainnya').toLowerCase();
    if (onlyCat.length && !onlyCat.includes(cat)) return false;
    if (hideCat.includes(cat)) return false;
    if (hideProd.includes(String(it.product_id)) || hideProd.map((x) => x.toLowerCase()).includes(String(it.product).toLowerCase())) return false;
    if (hideVar.includes(String(it.variant_id))) return false;
    if (f.hideNoWarranty && it.no_warranty) return false;
    if (f.hideManual && it.type === 'manual') return false;
    return true;
  });
}
const inStock = (it) => it.stock == null || Number(it.stock) > 0;
const catName = (it) => it.category || 'Lainnya';

/** Kelompokkan varian → kategori → produk. */
function groupCatalog(p, items) {
  const cats = new Map();
  for (const it of sellable(p, items)) {
    const c = catName(it);
    if (!cats.has(c)) cats.set(c, new Map());
    const prods = cats.get(c);
    const key = String(it.product_id);
    if (!prods.has(key)) prods.set(key, { id: key, name: it.product, image: it.image, description: it.description, category: c, variants: [] });
    prods.get(key).variants.push(it);
  }
  return cats;
}
function productSummary(p, prod) {
  const avail = prod.variants.filter(inStock);
  const prices = (avail.length ? avail : prod.variants).map((v) => sellPrice(p, v));
  const stock = avail.some((v) => v.stock == null) ? null : avail.reduce((a, v) => a + Number(v.stock || 0), 0);
  return { min: Math.min(...prices), available: avail.length > 0, stock };
}

/** Ringkasan untuk panel / katalog / how to order (dari cache, tanpa memanggil API). */
function summaryOf(p) {
  const items = sellable(p, W.cachedProducts()).filter(inStock);
  const products = new Set(items.map((x) => x.product_id)).size;
  const min = items.length ? Math.min(...items.map((x) => sellPrice(p, x))) : 0;
  return { products, variants: items.length, min, ready: W.catalogUpdatedAt() > 0 };
}

// ═════════════════════════════ Kotak V2 (tanpa garis warna, mengikuti ui.json) ═════════════════════════════
function card(cfg, { header, thumb, blocks = [], image, footer, rows = [], top }) {
  const box = UI.accent(new ContainerBuilder(), brand(cfg));
  if (thumb) box.addSectionComponents(new SectionBuilder().addTextDisplayComponents(text(header)).setThumbnailAccessory(new ThumbnailBuilder().setURL(thumb)));
  else box.addTextDisplayComponents(text(header));
  if (image) box.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(image)));
  for (const b of blocks.filter(Boolean)) {
    box.addSeparatorComponents(line());
    box.addTextDisplayComponents(text(b));
  }
  if (footer) {
    box.addSeparatorComponents(line());
    box.addTextDisplayComponents(text(`-# ${footer}`));
  }
  for (const r of rows.filter(Boolean)) box.addActionRowComponents(r);
  return { components: [...(top ? [text(top)] : []), box], flags: V2F, allowedMentions: { parse: [] } };
}
const eph = (p) => ({ ...p, flags: (p.flags || 0) | EPH });
const row = (...b) => new ActionRowBuilder().addComponents(b.filter(Boolean).slice(0, 5));
const btn = (id, label, emoji, style = ButtonStyle.Secondary, disabled = false) =>
  new ButtonBuilder().setCustomId(id).setLabel(label).setEmoji(emoji).setStyle(style).setDisabled(disabled);
const linkBtn = (url, label, emoji) => new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(url).setLabel(label).setEmoji(emoji);
const footerOf = (cfg, guild) => `${V.storeName(cfg, guild)} • ${ts(Date.now(), 'f')}`;
const warrantyText = (it) => (it.no_warranty ? '⚠️ Tanpa Garansi' : Number(it.warranty_days) > 0 ? `🛡️ Garansi ${num(it.warranty_days)} hari` : '🛡️ Sesuai ketentuan produk');
/** Deskripsi produk (Markdown ringan dari API) → teks Discord yang rapi. */
const cleanDesc = (s, max = 1200) =>
  clip(
    String(s || '')
      .replace(/\r/g, '')
      .replace(/^#{1,6}\s*(.+)$/gm, '**$1**')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    max,
  );
const PAY_LABEL = { deposit: 'QRIS Otomatis', qris: 'QRIS Otomatis', manual: 'Transfer Bank / E-Wallet' };

// ═════════════════════════════ Langkah 1: info + pilih kategori ═════════════════════════════
function homeView(guild, cfg, p, items, notice) {
  const name = { name: V.storeName(cfg, guild) };
  const open = isProductOpen(p);
  const cats = groupCatalog(p, items);
  const s = summaryOf(p);
  const catOptions = [...cats.entries()]
    .map(([c, prods]) => {
      const list = [...prods.values()];
      const ready = list.filter((x) => x.variants.some(inStock)).length;
      return { c, ready, total: list.length };
    })
    .sort((a, b) => b.ready - a.ready || a.c.localeCompare(b.c))
    .slice(0, 25)
    .map((x) => ({ label: clip(x.c, 100), value: clip(x.c, 100), description: clip(`${x.ready} produk tersedia${x.total > x.ready ? ` • ${x.total - x.ready} habis` : ''}`, 100), emoji: x.ready ? '📂' : '⛔' }));
  const rows = [];
  if (open && catOptions.length) {
    rows.push(row(new StringSelectMenuBuilder().setCustomId(`store:inscat:${p.id}`).setPlaceholder('📂 Pilih kategori produk...').addOptions(catOptions)));
  }
  rows.push(
    row(
      p.howTo ? btn(`store:howtobtn:${p.id}`, 'Cara Order', '📖') : null,
      p.terms?.description ? btn(`store:terms:${p.id}`, p.terms.button || 'Syarat & Ketentuan', '📌') : null,
      btn(`store:insrefresh:${p.id}`, 'Muat Ulang', '🔄'),
    ),
  );
  const ps = productStatsOf(p.id);
  return card(cfg, {
    thumb: p.thumbnail || guild.iconURL({ extension: 'png', size: 256 }),
    header: `## ${p.emoji || '👑'} ${p.label}\n${fill(p.description || 'Akun premium **siap pakai**, dikirim **otomatis** setelah pembayaran terverifikasi.', name)}`,
    blocks: [
      notice || null,
      [
        `🛍️ **Produk Tersedia:** \`${num(s.products)} produk • ${num(s.variants)} varian\``,
        s.min ? `💱 **Harga:** \`Mulai ${rupiah(s.min)}\`` : null,
        `💳 **Pembayaran:** \`${PAY_LABEL[payMode(p)]}\`${minTotal(p) ? ` • min. \`${rupiah(minTotal(p))}\`` : ''}`,
        '⚡ **Pengiriman:** `Otomatis ke ticket & DM`',
        `🏪 **Status:** ${open ? '`🟢 BUKA`' : '`🔴 TUTUP`'}`,
      ]
        .filter(Boolean)
        .join('\n'),
      `✅ **Order Selesai:** \`${num(ps.orders)} order\``,
      !open ? '🔴 Premium App sedang **TUTUP**. Pantau channel stock untuk info berikutnya.' : !catOptions.length ? '📭 Belum ada produk yang bisa dijual saat ini.' : '👇 **Pilih kategori** untuk melihat produk.',
    ],
    footer: footerOf(cfg, guild),
    rows,
  });
}

async function loadItems(force = false) {
  try {
    return { items: await W.getProducts({ force }) };
  } catch (err) {
    console.warn('[instan] gagal ambil katalog:', err.code, err.message);
    return { items: W.cachedProducts(), error: err };
  }
}
const apiDownNotice = '⚠️ **Server produk sedang gangguan.** Coba lagi beberapa saat lagi ya.';

async function onInfo(interaction, p) {
  await interaction.deferReply({ flags: EPH });
  const cfg = loadConfig();
  const { items, error } = await loadItems();
  setSession(interaction.user.id, { cat: null, page: 0 });
  return interaction.editReply(homeView(interaction.guild, cfg, p, items, error && !items.length ? apiDownNotice : null));
}

function setSession(userId, patch) {
  const s = { ...(sessions.get(userId) || {}), ...patch, expires: Date.now() + SESSION_MS };
  sessions.set(userId, s);
  return s;
}
function getSession(userId) {
  const s = sessions.get(userId);
  if (!s || s.expires < Date.now()) {
    sessions.delete(userId);
    return null;
  }
  return s;
}

// ═════════════════════════════ Langkah 2: daftar produk dalam kategori ═════════════════════════════
const PAGE = 25;
function categoryView(guild, cfg, p, items, cat, page = 0) {
  const prods = [...(groupCatalog(p, items).get(cat)?.values() || [])]
    .map((x) => ({ ...x, sum: productSummary(p, x) }))
    .sort((a, b) => Number(b.sum.available) - Number(a.sum.available) || a.name.localeCompare(b.name));
  const pages = Math.max(1, Math.ceil(prods.length / PAGE));
  const pg = Math.min(Math.max(page, 0), pages - 1);
  const slice = prods.slice(pg * PAGE, pg * PAGE + PAGE);
  const lines = slice.map((x) => `${x.sum.available ? '🟢' : '🔴'} **${clip(x.name, 60)}** — mulai \`${rupiah(x.sum.min)}\`${x.sum.available ? '' : ' • _habis_'}`);
  const rows = [];
  if (slice.length) {
    rows.push(
      row(
        new StringSelectMenuBuilder()
          .setCustomId(`store:insprod:${p.id}`)
          .setPlaceholder('🛍️ Pilih produk...')
          .addOptions(
            slice.map((x) => ({
              label: clip(x.name, 100),
              value: x.id,
              description: clip(x.sum.available ? `Mulai ${rupiah(x.sum.min)}${x.sum.stock != null ? ` • Stok ${num(x.sum.stock)}` : ''}` : 'Stok habis', 100),
              emoji: x.sum.available ? '🛍️' : '⛔',
            })),
          ),
      ),
    );
  }
  rows.push(
    row(
      btn(`store:insback:${p.id}`, 'Kategori', '◀️'),
      pages > 1 ? btn(`store:inspage:prev`, 'Sebelumnya', '⬅️', ButtonStyle.Secondary, pg === 0) : null,
      pages > 1 ? btn(`store:inspage:next`, 'Berikutnya', '➡️', ButtonStyle.Secondary, pg >= pages - 1) : null,
    ),
  );
  return {
    page: pg,
    payload: card(cfg, {
      header: `## 📂 ${clip(cat, 80)}\n-# ${p.label} • ${num(prods.length)} produk${pages > 1 ? ` • Halaman ${pg + 1}/${pages}` : ''}`,
      blocks: [lines.join('\n') || '📭 Tidak ada produk di kategori ini.', '👇 Pilih produk untuk melihat detail & varian.'],
      footer: footerOf(cfg, guild),
      rows,
    }),
  };
}

async function onCategory(interaction, p) {
  const cfg = loadConfig();
  const cat = interaction.values[0];
  // Dipilih dari panel publik → hasil dikirim sebagai pesan pribadi & pilihan di panel direset.
  const fromPanel = interaction.message && !interaction.message.flags?.has?.(MessageFlags.Ephemeral);
  if (fromPanel) await interaction.deferReply({ flags: EPH });
  const { items } = await loadItems();
  const view = categoryView(interaction.guild, cfg, p, items, cat, 0);
  setSession(interaction.user.id, { cat, page: view.page, pid: p.id });
  if (!fromPanel) return interaction.update(view.payload);
  await interaction.editReply(view.payload);
  interaction.message.edit(buildPanel(interaction.guild, cfg)).catch(() => {});
}

// ═════════════════════════════ Panel publik (channel Premium App) ═════════════════════════════
const KEYCAPS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣'];
/** Panel 👑 Premium App di channel sendiri: dropdown kategori langsung di panel. Ter-update otomatis. */
function buildPanel(guild, cfg) {
  const p = instantProduct(cfg);
  if (!p) return card(cfg, { header: '❌ Premium App belum diatur di store.json.' });
  const pt = p.panel || {};
  const name = { name: V.storeName(cfg, guild) };
  const open = isProductOpen(p);
  const items = W.cachedProducts();
  const cats = [...groupCatalog(p, items).entries()]
    .map(([c, prods]) => {
      const list = [...prods.values()].map((x) => ({ ...x, sum: productSummary(p, x) }));
      const ready = list.filter((x) => x.sum.available);
      return { c, ready: ready.length, total: list.length, min: ready.length ? Math.min(...ready.map((x) => x.sum.min)) : 0 };
    })
    .sort((a, b) => b.ready - a.ready || a.c.localeCompare(b.c));
  const s = summaryOf(p);
  const ps = productStatsOf(p.id);
  const st = state.stats;
  const avg = st.ratingCount ? (st.ratingSum / st.ratingCount).toFixed(1) : '-';
  const stars = st.ratingCount ? '⭐'.repeat(Math.round(st.ratingSum / st.ratingCount)) + '☆'.repeat(5 - Math.round(st.ratingSum / st.ratingCount)) : '☆☆☆☆☆';

  const catLines = cats
    .filter((x) => x.ready)
    .slice(0, 12)
    .map((x) => `📂 **${clip(x.c, 40)}** — \`${num(x.ready)} produk\` • mulai \`${rupiah(x.min)}\``);
  const moreCats = cats.filter((x) => x.ready).length - catLines.length;
  const features = pt.features || [
    '⚡ **Kirim Otomatis** — akun masuk ke ticket & DM dalam hitungan detik',
    '💳 **QRIS Semua E-Wallet** — DANA, OVO, GoPay, ShopeePay & m-banking',
    '📦 **Stok & Harga Real-time** — yang tampil = yang tersedia',
    '🕐 **Buka 24 Jam** — tanpa menunggu admin online',
  ];
  const steps = pt.steps || [
    'Pilih **kategori** di menu bawah',
    'Pilih **produk** & **varian** yang kamu mau',
    'Bayar lewat **QRIS** di ticket pribadimu',
    'Akun **terkirim otomatis** — simpan & selamat menikmati! ✨',
  ];

  const options = cats.slice(0, 25).map((x) => ({
    label: clip(x.c, 100),
    value: clip(x.c, 100),
    description: clip(x.ready ? `${x.ready} produk tersedia • mulai ${rupiah(x.min)}` : 'Stok sedang habis', 100),
    emoji: x.ready ? '📂' : '⛔',
  }));
  const select = new StringSelectMenuBuilder().setCustomId(`store:inscat:${p.id}`);
  if (open && options.length) select.setPlaceholder('📂 Pilih kategori untuk mulai belanja...').addOptions(options);
  else select.setPlaceholder(open ? '⏳ Produk sedang dimuat...' : '🔴 Premium App sedang tutup').addOptions({ label: '-', value: '-' }).setDisabled(true);

  return card(cfg, {
    thumb: pt.thumbnail || p.thumbnail || guild.iconURL({ extension: 'png', size: 256 }),
    header: `# ${fill(pt.title || '👑 Premium App', name)}\n-# ${fill(pt.subtitle || 'Auto Delivery 24 Jam • {server}', name)}`,
    image: pt.bannerImage || null,
    blocks: [
      fill(
        pt.description ||
          'Belanja **akun premium siap pakai** tanpa ribet! 💎\nPilih produk, bayar via **QRIS**, dan akun **langsung dikirim otomatis** ke ticket & DM kamu — kapan pun, **24 jam nonstop**. ⚡',
        name,
      ),
      `### ✨ Kenapa Belanja di Sini?\n${features.join('\n')}`,
      catLines.length ? `### 🛍️ Kategori Tersedia\n${catLines.join('\n')}${moreCats > 0 ? `\n-# +${moreCats} kategori lainnya di menu bawah` : ''}` : open ? '### 🛍️ Kategori Tersedia\n_Produk sedang dimuat..._' : null,
      [
        `🏪 **Status:** ${open ? '`🟢 BUKA 24 JAM`' : '`🔴 TUTUP`'}`,
        `📦 **Tersedia:** \`${num(s.products)} produk • ${num(s.variants)} varian\``,
        s.min ? `💱 **Harga:** \`Mulai ${rupiah(s.min)}\`` : null,
        `💳 **Pembayaran:** \`${PAY_LABEL[payMode(p)]}\`${minTotal(p) ? ` • min. \`${rupiah(minTotal(p))}\`` : ''}`,
        `✅ **Order Selesai:** \`${num(ps.orders)} order\``,
        `⭐ **Rating Toko:** ${stars} \`${avg} / 5\` (${num(st.ratingCount)} ulasan)`,
      ]
        .filter(Boolean)
        .join('\n'),
      `### 🔄 Cara Order\n${steps.map((x, i) => `${KEYCAPS[i] || `\`${i + 1}\``} ${x}`).join('\n')}`,
    ],
    footer: `${name.name} • Diperbarui <t:${Math.floor(Date.now() / 1000)}:R>`,
    rows: [
      row(select),
      row(
        btn(`store:insmine:${p.id}`, 'Pesanan Saya', '🎫'),
        p.howTo ? btn(`store:howtobtn:${p.id}`, 'Cara Order', '📖') : null,
        p.terms?.description ? btn(`store:terms:${p.id}`, p.terms.button || 'Syarat & Ketentuan', '📌') : null,
      ),
    ],
  });
}

/** Tombol "Pesanan Saya" di panel. */
async function onMine(interaction) {
  const list = Object.values(state.tickets)
    .filter((t) => kindOf(t) === 'instant' && t.userId === interaction.user.id && (t.status === 'open' || (t.status === 'completed' && !t.deleted)))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 5);
  if (!list.length) return interaction.reply({ content: '📭 Kamu belum punya pesanan Premium App yang aktif. Pilih kategori di panel untuk mulai belanja! ⚡', flags: EPH });
  const lines = list.map((t) => `▸ \`${t.id}\` • **${clip(t.productLabel, 60)}** ×${num(t.qty)} • ${t.status === 'open' ? STAGE_TEXT[t.ins?.stage] || '⏳ Diproses' : '✅ Selesai'}${t.channelId ? ` • <#${t.channelId}>` : ''}`);
  return interaction.reply({ content: `🎫 **Pesanan Premium App Kamu**\n${lines.join('\n')}`, flags: EPH });
}

async function onPage(interaction, dir) {
  const s = getSession(interaction.user.id);
  const cfg = loadConfig();
  const p = instantProduct(cfg, s?.pid);
  if (!s?.cat || !p) return interaction.update(eph(card(cfg, { header: '⌛ Sesi berakhir. Klik tombol produk di panel lagi.' })));
  const { items } = await loadItems();
  const view = categoryView(interaction.guild, cfg, p, items, s.cat, (s.page || 0) + (dir === 'next' ? 1 : -1));
  setSession(interaction.user.id, { page: view.page });
  return interaction.update(view.payload);
}

async function onBack(interaction, p) {
  const cfg = loadConfig();
  const { items, error } = await loadItems();
  return interaction.update(homeView(interaction.guild, cfg, p, items, error && !items.length ? apiDownNotice : null));
}

async function onRefresh(interaction, p) {
  const cfg = loadConfig();
  const { items, error } = await loadItems(true);
  return interaction.update(homeView(interaction.guild, cfg, p, items, error ? apiDownNotice : '🔄 Daftar produk & stok sudah diperbarui.'));
}

// ═════════════════════════════ Langkah 3: detail produk + pilih varian ═════════════════════════════
function productView(guild, cfg, p, prod, notice) {
  const vars = prod.variants;
  const groups = new Set(vars.map((v) => v.variant_group).filter(Boolean));
  const vline = (v) =>
    `${inStock(v) ? '🟢' : '🔴'} **${clip(v.variant, 50)}** — \`${rupiah(sellPrice(p, v))}\` • ${v.stock == null ? 'Stok selalu ada' : inStock(v) ? `Stok ${num(v.stock)}` : '_Habis_'} • ${warrantyText(v)}`;
  const list = groups.size > 1 ? [...groups].map((g) => `**${g}**\n${vars.filter((v) => v.variant_group === g).map(vline).join('\n')}`).join('\n\n') : vars.map(vline).join('\n');
  const detail = vars.find((v) => v.variant_description);
  const options = vars.slice(0, 25).map((v) => ({
    label: clip(`${v.variant_group ? `${v.variant_group} • ` : ''}${v.variant}`, 100),
    value: String(v.variant_id),
    description: clip(`${rupiah(sellPrice(p, v))} • ${v.stock == null ? 'Selalu tersedia' : inStock(v) ? `Stok ${num(v.stock)}` : 'Habis'} • ${v.no_warranty ? 'Tanpa garansi' : Number(v.warranty_days) > 0 ? `Garansi ${v.warranty_days} hari` : 'Garansi sesuai S&K'}`, 100),
    emoji: inStock(v) ? '🛒' : '⛔',
  }));
  return card(cfg, {
    thumb: prod.image || null,
    header: `## 🛍️ ${clip(prod.name, 80)}\n-# ${clip(prod.category, 60)} • ${p.label}`,
    blocks: [
      notice || null,
      prod.description ? cleanDesc(prod.description, 1200) : null,
      `### 🏷️ Pilihan Varian\n${clip(list, 1800)}`,
      detail ? `### ℹ️ Detail Varian\n${cleanDesc(vars.filter((v) => v.variant_description).map((v) => `**${v.variant}:** ${v.variant_description}`).join('\n'), 700)}` : null,
      vars.some((v) => v.no_warranty) ? '⚠️ Varian **Tanpa Garansi** bisa bermasalah kapan saja **tanpa penggantian / refund**.' : null,
    ],
    footer: `${V.storeName(cfg, guild)} • Harga & stok real-time`,
    rows: [
      row(new StringSelectMenuBuilder().setCustomId(`store:insvar:${p.id}`).setPlaceholder('🛒 Pilih varian untuk dibeli...').addOptions(options)),
      row(btn(`store:inscatback:${p.id}`, 'Kembali', '◀️')),
    ],
  });
}

function findProduct(p, items, wrkProductId) {
  for (const prods of groupCatalog(p, items).values()) if (prods.has(String(wrkProductId))) return prods.get(String(wrkProductId));
  return null;
}

async function onProduct(interaction, p) {
  const cfg = loadConfig();
  const { items } = await loadItems();
  const prod = findProduct(p, items, interaction.values[0]);
  if (!prod) return interaction.update(card(cfg, { header: '❌ Produk tidak ditemukan / sudah tidak dijual.', rows: [row(btn(`store:insback:${p.id}`, 'Kategori', '◀️'))] }));
  setSession(interaction.user.id, { wrkProductId: prod.id, pid: p.id, cat: prod.category });
  return interaction.update(productView(interaction.guild, cfg, p, prod));
}

/** Tombol "Beli Sekarang" di post forum katalog → detail & varian produk (pesan pribadi). */
async function onForumBuy(interaction, wrkProductId) {
  const cfg = loadConfig();
  const p = instantProduct(cfg);
  if (!p) return interaction.reply({ content: '❌ Produk belum tersedia.', flags: EPH });
  if (!isProductOpen(p)) return interaction.reply({ content: `🔴 **${p.label}** sedang **TUTUP**. Pantau channel stock untuk info berikutnya.`, flags: EPH });
  await interaction.deferReply({ flags: EPH });
  const { items } = await loadItems();
  const prod = findProduct(p, items, wrkProductId);
  if (!prod) return interaction.editReply('❌ Produk ini sudah tidak dijual. Cek produk lain di katalog ya.');
  setSession(interaction.user.id, { wrkProductId: prod.id, pid: p.id, cat: prod.category, page: 0 });
  return interaction.editReply(productView(interaction.guild, cfg, p, prod));
}

async function onCategoryBack(interaction, p) {
  const s = getSession(interaction.user.id);
  if (!s?.cat) return onBack(interaction, p);
  const cfg = loadConfig();
  const { items } = await loadItems();
  return interaction.update(categoryView(interaction.guild, cfg, p, items, s.cat, s.page || 0).payload);
}

// ═════════════════════════════ Langkah 4: jumlah / data / persetujuan (form) ═════════════════════════════
function findVariant(items, variantId) {
  return (items || []).find((x) => String(x.variant_id) === String(variantId)) || null;
}

async function onVariant(interaction, p) {
  const cfg = loadConfig();
  if (!isProductOpen(p)) return interaction.reply({ content: `🔴 **${p.label}** sedang **TUTUP**.`, flags: EPH });
  const vid = interaction.values[0];
  const it = findVariant(W.cachedProducts(), vid);
  if (!it) return interaction.reply({ content: '❌ Varian tidak ditemukan. Klik **Muat Ulang** lalu coba lagi.', flags: EPH });
  if (!inStock(it)) return interaction.reply({ content: `⛔ **${it.product} — ${it.variant}** sedang **habis**. Pilih varian lain ya.`, flags: EPH });
  const active = activeTicketOf({ userId: interaction.user.id, kind: 'instant' });
  if (active) return interaction.reply({ content: `⚠️ Kamu masih punya pesanan Premium App yang berjalan: <#${active.channelId}> (\`${active.id}\`). Selesaikan / batalkan dulu ya.`, flags: EPH });

  const unit = sellPrice(p, it);
  const maxQ = it.type === 'manual' ? 1 : Math.min(maxQty(p), it.stock == null ? maxQty(p) : Number(it.stock));
  const fields = it.type === 'manual' ? (it.required_fields || []).slice(0, 3) : [];
  const needModal = maxQ > 1 || fields.length || it.no_warranty;
  if (!needModal) return showConfirm(interaction, p, it, { qty: 1, data: null, ack: false }, true);

  const modal = new ModalBuilder().setCustomId(`store:insmodal:${String(it.variant_id).slice(0, 60)}`).setTitle(clip(`Order ${it.product}`, 45));
  const labels = [];
  if (maxQ > 1) {
    const min = minTotal(p);
    labels.push(
      new LabelBuilder()
        .setLabel('Jumlah Akun')
        .setDescription(clip(`${it.variant} • ${rupiah(unit)} / akun${min ? ` • minimal belanja ${rupiah(min)}` : ''}`, 100))
        .setStringSelectMenuComponent(
          new StringSelectMenuBuilder()
            .setCustomId('qty')
            .setPlaceholder('Pilih jumlah...')
            .setRequired(true)
            .addOptions(
              Array.from({ length: Math.min(maxQ, 25) }, (_, i) => i + 1).map((q) => ({
                label: `${q} akun — ${rupiah(unit * q)}`,
                value: String(q),
                description: unit * q < min ? `Di bawah minimal ${rupiah(min)}` : undefined,
                emoji: unit * q < min ? '⛔' : '🛒',
              })),
            ),
        ),
    );
  }
  for (const [i, f] of fields.entries()) {
    const isMail = /e-?mail/i.test(f);
    labels.push(
      new LabelBuilder()
        .setLabel(clip(f, 45))
        .setDescription(isMail ? 'Pastikan email benar — undangan dikirim ke email ini.' : 'Wajib diisi untuk memproses pesanan.')
        .setTextInputComponent(new TextInputBuilder().setCustomId(`f${i}`).setStyle(TextInputStyle.Short).setMaxLength(150).setRequired(true).setPlaceholder(isMail ? 'contoh: namakamu@gmail.com' : '')),
    );
  }
  if (it.no_warranty) {
    labels.push(
      new LabelBuilder()
        .setLabel('Persetujuan Produk TANPA GARANSI')
        .setDescription('Akun bisa bermasalah kapan saja, tanpa penggantian maupun pengembalian dana.')
        .setStringSelectMenuComponent(
          new StringSelectMenuBuilder()
            .setCustomId('ack')
            .setPlaceholder('Pilih untuk menyetujui...')
            .setRequired(true)
            .addOptions({ label: 'Saya mengerti & setuju risikonya', value: 'yes', emoji: '✅' }),
        ),
    );
  }
  modal.addLabelComponents(...labels.slice(0, 5));
  return interaction.showModal(modal);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
async function onModal(interaction, variantId) {
  const cfg = loadConfig();
  const p = instantProduct(cfg, getSession(interaction.user.id)?.pid) || instantProduct(cfg);
  const it = findVariant(W.cachedProducts(), variantId);
  if (!p || !it) return interaction.reply({ content: '❌ Varian tidak ditemukan. Coba lagi dari panel.', flags: EPH });
  const get = (id, fn) => {
    try {
      return fn(id);
    } catch {
      return null;
    }
  };
  const qty = Math.max(1, Number(get('qty', (x) => interaction.fields.getStringSelectValues(x)?.[0])) || 1);
  const data = {};
  const fields = it.type === 'manual' ? (it.required_fields || []).slice(0, 3) : [];
  for (const [i, f] of fields.entries()) {
    const v = String(get(`f${i}`, (x) => interaction.fields.getTextInputValue(x)) || '').trim();
    if (/e-?mail/i.test(f) && !EMAIL_RE.test(v)) return interaction.reply({ content: `❌ **${f}** tidak valid. Contoh: \`namakamu@gmail.com\``, flags: EPH });
    data[f] = v;
  }
  const ack = get('ack', (x) => interaction.fields.getStringSelectValues(x)?.[0]) === 'yes';
  if (it.no_warranty && !ack) return interaction.reply({ content: '❌ Kamu harus menyetujui risiko produk **tanpa garansi**.', flags: EPH });
  return showConfirm(interaction, p, it, { qty, data: fields.length ? data : null, ack }, interaction.isFromMessage?.());
}

// ═════════════════════════════ Langkah 5: konfirmasi ═════════════════════════════
function confirmView(guild, cfg, p, it, d, notice) {
  const unit = sellPrice(p, it);
  const total = unit * d.qty;
  const min = minTotal(p);
  const tooLow = total < min;
  const dataLines = d.data ? Object.entries(d.data).map(([k, v]) => `📝 **${k}:** \`${clip(v, 80)}\``) : [];
  return card(cfg, {
    thumb: it.image || null,
    header: `## 🧾 Konfirmasi Pesanan\n-# ${p.label} • Periksa lagi sebelum membayar`,
    blocks: [
      notice || null,
      [
        `🛍️ **Produk:** \`${clip(it.product, 60)}\``,
        `🏷️ **Varian:** \`${clip(it.variant, 60)}\``,
        `🔢 **Jumlah:** \`${num(d.qty)} akun\``,
        `💱 **Harga Satuan:** \`${rupiah(unit)}\``,
        `${warrantyText(it)}`,
        ...dataLines,
      ].join('\n'),
      `## 💰 Total: ${rupiah(total)}\n-# Pembayaran: ${PAY_LABEL[payMode(p)]}${payMode(p) === 'manual' ? '' : ' • nominal QRIS + kode unik kecil'}`,
      tooLow ? `⛔ Minimal belanja **${rupiah(min)}**. Tambah jumlah akun ya.` : `⚡ Setelah klik **Bayar Sekarang**, ticket dibuat & ${payMode(p) === 'manual' ? 'info rekening' : '**QRIS**'} langsung muncul. Akun dikirim **otomatis** setelah pembayaran terverifikasi.`,
    ],
    footer: `${V.storeName(cfg, guild)} • Sesi berlaku 15 menit`,
    rows: [row(btn('store:insconfirm:yes', 'Bayar Sekarang', '💳', ButtonStyle.Success, tooLow), btn('store:insconfirm:no', 'Batalkan', '✖️'))],
  });
}

async function showConfirm(interaction, p, it, d, update) {
  const cfg = loadConfig();
  setSession(interaction.user.id, { pid: p.id, draft: { variantId: String(it.variant_id), qty: d.qty, data: d.data, ack: d.ack, unit: sellPrice(p, it) } });
  const view = confirmView(interaction.guild, cfg, p, it, d);
  return update ? interaction.update(view) : interaction.reply(eph(view));
}

// ═════════════════════════════ Langkah 6: buat ticket + pembayaran ═════════════════════════════
const pendingDeposits = () =>
  Object.values(state.tickets).filter((t) => kindOf(t) === 'instant' && t.ins?.pay?.mode === 'deposit' && t.ins.pay.status === 'pending' && t.ins.pay.expiresAt > Date.now()).length;

async function onConfirm(interaction, yes) {
  const sess = getSession(interaction.user.id);
  const cfg = loadConfig();
  const done = (msg) => interaction.update(card(cfg, { header: msg }));
  if (!yes) {
    if (sess) sess.draft = null;
    return done('✖️ Pesanan dibatalkan.');
  }
  const p = instantProduct(cfg, sess?.pid);
  if (!sess?.draft || !p) return done('⌛ Sesi sudah berakhir. Silakan pilih produk lagi dari panel.');
  if (!isProductOpen(p)) return done(`🔴 Maaf, **${p.label}** baru saja **TUTUP**.`);
  if (activeTicketOf({ userId: interaction.user.id, kind: 'instant' })) return done('⚠️ Kamu masih punya pesanan Premium App yang sedang berjalan.');
  await interaction.update(card(cfg, { header: '⏳ Mengecek stok & harga terbaru...' }));
  const guild = interaction.guild;
  const d = sess.draft;

  // Cek ulang stok & harga langsung ke API (bukan cache).
  let it;
  try {
    it = findVariant(await W.getProducts({ force: true }), d.variantId);
  } catch (err) {
    return interaction.editReply(card(cfg, { header: `⚠️ ${apiDownNotice}\n-# ${err.message}` }));
  }
  if (!it || !sellable(p, [it]).length) return interaction.editReply(card(cfg, { header: '❌ Varian ini sudah tidak dijual.' }));
  if (!inStock(it) || (it.stock != null && Number(it.stock) < d.qty)) {
    return interaction.editReply(card(cfg, { header: `⛔ Stok **${it.product} — ${it.variant}** tidak cukup (tersisa ${num(it.stock || 0)}).` }));
  }
  const unit = sellPrice(p, it);
  if (unit !== d.unit) {
    d.unit = unit;
    return interaction.editReply(confirmView(guild, cfg, p, it, d, `⚠️ **Harga baru saja berubah** menjadi \`${rupiah(unit)}\` / akun. Periksa lagi lalu klik **Bayar Sekarang**.`));
  }
  const total = unit * d.qty;
  if (total < minTotal(p)) return interaction.editReply(card(cfg, { header: `⛔ Minimal belanja **${rupiah(minTotal(p))}**.` }));
  const mode = payMode(p);
  if (mode === 'deposit' && pendingDeposits() >= 3) {
    return interaction.editReply(card(cfg, { header: '⏳ **Antrean pembayaran sedang penuh** (maks. 3 pembayaran bersamaan).\nCoba lagi dalam beberapa menit ya. 🙏' }));
  }
  sess.draft = null;

  const tc = p.ticket || {};
  const id = nextTicketId(tc.idPrefix || 'PA', 'instantSeq');
  const now = Date.now();
  const t = {
    id,
    kind: 'instant',
    guildId: guild.id,
    userId: interaction.user.id,
    channelId: null,
    messageId: null,
    productId: p.id,
    productLabel: clip(`${it.product} — ${it.variant}`, 100),
    amount: 0,
    qty: d.qty,
    price: total,
    status: 'open',
    createdAt: now,
    ins: {
      mode,
      variantId: String(it.variant_id),
      wrkProductId: String(it.product_id),
      product: it.product,
      variant: it.variant,
      category: catName(it),
      type: it.type || 'auto',
      image: it.image || null,
      qty: d.qty,
      unitPrice: unit,
      unitCost: Number(it.price) || 0,
      warrantyDays: Number(it.warranty_days) || 0,
      noWarranty: Boolean(it.no_warranty),
      data: d.data || null,
      refId: `NNS-${id}-${now.toString(36)}`.slice(0, 64),
      stage: 'waiting_payment',
      attempts: 0,
    },
  };

  // Buat tagihan QRIS lebih dulu (kalau gagal, tidak perlu membuat channel).
  try {
    await createPayment(t);
  } catch (err) {
    console.warn(`[instan] gagal membuat pembayaran ${id}:`, err.code, err.message);
    const full = err.code === 'too_many_pending';
    if (!full) alert(guild, t, { title: 'Gagal Membuat Pembayaran', err, buyerNotified: true }).catch(() => {});
    return interaction.editReply(
      card(cfg, {
        header: full
          ? '⏳ **Antrean pembayaran sedang penuh.** Coba lagi dalam beberapa menit ya. 🙏'
          : err.code === 'out_of_stock'
          ? '⛔ Stok baru saja **habis**. Pilih varian lain ya.'
          : `❌ Pembayaran belum bisa dibuat. Coba lagi sebentar lagi.\n-# ${clip(err.message, 150)}`,
      }),
    );
  }
  state.tickets[id] = t;
  save();

  try {
    const category = await ctx.getTicketCategory(guild, cfg, tc.categoryName || '👑 TICKET PREMIUM APP');
    const perms = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks];
    const overwrites = [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: interaction.user.id, allow: perms },
      { id: guild.members.me.id, allow: [...perms, PermissionFlagsBits.ManageChannels] },
    ];
    const staff = isId(cfg.ticket?.staffRoleId) ? cfg.ticket.staffRoleId : null;
    if (staff) overwrites.push({ id: staff, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
    const slug = interaction.user.username.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20);
    const channel = await guild.channels.create({
      name: `👑・${id.toLowerCase()}-${slug}`,
      type: ChannelType.GuildText,
      parent: category.id,
      topic: `${id} • ${t.productLabel} x${t.qty} • ${interaction.user.tag}`,
      permissionOverwrites: overwrites,
    });
    t.channelId = channel.id;
    const msg = await channel.send(V.toV2({ content: `<@${t.userId}>`, ...buildTicket(guild, cfg, t), allowedMentions: { users: [t.userId] } }));
    await msg.pin().catch(() => {});
    t.messageId = msg.id;
    save();
    ctx.logOrder(guild, t, '🆕 Order Premium App masuk & menunggu pembayaran');

    const url = channelUrl(guild.id, channel.id);
    const dmOk = await interaction.user
      .send(V.dm(V.buildDmCreated(guild, cfg, t, url)))
      .then(() => true)
      .catch(() => false);
    if (!dmOk) channel.send('ℹ️ Bot tidak bisa mengirim DM ke kamu (DM tertutup). **Data akun hanya dikirim di ticket ini** — salin & simpan sebelum ticket ditutup.').catch(() => {});
    await interaction.editReply(
      card(cfg, {
        header: `✅ **Ticket ${id} berhasil dibuat!**\nScan QRIS di ${channel} — akun dikirim **otomatis** setelah pembayaran masuk.`,
        rows: [row(linkBtn(url, 'Buka Ticket', '🎫'))],
      }),
    );
  } catch (err) {
    console.error('[instan] gagal membuat ticket:', err);
    t.status = 'cancelled';
    t.closedAt = Date.now();
    t.note = 'Gagal membuat channel ticket';
    t.deleted = true;
    t.ins.stage = 'cancelled';
    save();
    await interaction.editReply(card(cfg, { header: '❌ Gagal membuat ticket. Pastikan bot punya izin **Manage Channels** & **Manage Roles**. **Jangan membayar** tagihan yang sempat dibuat.' })).catch(() => {});
    return;
  }
  ctx.refreshPanel();
}

/** Buat tagihan sesuai mode pembayaran. */
async function createPayment(t) {
  if (t.ins.mode === 'manual') {
    t.ins.pay = { mode: 'manual', status: 'pending', amount: t.price };
    return;
  }
  if (t.ins.mode === 'qris') {
    const r = await W.createOrder({
      variant_id: t.ins.variantId,
      qty: t.ins.qty,
      ref_id: t.ins.refId,
      payment: 'qris',
      data: t.ins.data || undefined,
      accept_no_warranty: t.ins.noWarranty || undefined,
    });
    const o = r.order || {};
    applyOrder(t, o);
    const pay = o.payment || {};
    t.price = Number(o.total) || t.price;
    t.ins.pay = {
      mode: 'qris',
      status: o.status === 'pending' ? 'pending' : 'paid',
      orderId: String(o.id),
      amount: Number(pay.amount) || Number(o.total) || t.price,
      qrUrl: pay.qr_url || null,
      payUrl: pay.pay_url || null,
      expiresAt: Date.parse(pay.expires_at) || Date.now() + 30 * 60000,
    };
    return;
  }
  const r = await W.createDeposit(t.price);
  const dep = r.deposit || {};
  t.ins.pay = {
    mode: 'deposit',
    status: 'pending',
    depositId: String(dep.id),
    amount: Number(dep.amount) || t.price,
    qrUrl: dep.qr_url || null,
    payUrl: dep.pay_url || null,
    expiresAt: Date.parse(dep.expires_at) || Date.now() + 30 * 60000,
  };
}

function applyOrder(t, o) {
  if (!o) return;
  t.ins.order = { id: String(o.id || t.ins.order?.id || ''), ref: o.ref || t.ins.order?.ref || null, status: o.status || null };
  if (o.claim_code) t.ins.claimCode = o.claim_code;
  if (Array.isArray(o.accounts) && o.accounts.length) t.ins.accounts = o.accounts;
  if (o.note) t.ins.note = o.note;
}

// ═════════════════════════════ Tampilan ticket (embed → otomatis Components V2) ═════════════════════════════
const STAGE_TEXT = {
  waiting_payment: '⏳ Menunggu Pembayaran',
  paid: '💰 Pembayaran Diterima — Mengirim Akun',
  fulfilling: '⚙️ Memproses Pesanan',
  fulfill_retry: '⚙️ Memproses Pesanan',
  processing: '🔄 Sedang Diproses Pusat',
  need_help: '🛠️ Sedang Dibantu Admin',
  delivered: '✅ Akun Terkirim',
  cancelled: '❌ Dibatalkan',
};
function steps(t) {
  const st = t.ins.stage;
  const paid = t.payment?.status === 'paid' || ['paid', 'fulfilling', 'fulfill_retry', 'processing', 'need_help', 'delivered'].includes(st);
  const delivered = st === 'delivered' || t.status === 'completed';
  const rows = [
    [true, 'Pesanan dibuat'],
    [paid, t.ins.mode === 'manual' ? 'Pembayaran diverifikasi admin' : 'Pembayaran QRIS terverifikasi otomatis'],
    [delivered, t.ins.type === 'manual' ? 'Pesanan diproses & selesai' : 'Akun dikirim otomatis ke ticket & DM'],
  ];
  const cur = rows.findIndex((r) => !r[0]);
  return rows.map((r, i) => `${r[0] ? '✅' : t.status === 'open' && i === cur ? (st === 'need_help' ? '🛠️' : '⏳') : '▫️'} \`${i + 1}\` ${r[1]}`).join('\n');
}

/** Isi ticket Premium App (dipanggil V.buildTicketMessage untuk kind 'instant'). */
function buildTicket(guild, cfg, t) {
  const name = V.storeName(cfg, guild);
  const i = t.ins;
  const pay = i.pay || {};
  const info = new EmbedBuilder()
    .setAuthor({ name: `${name} • Premium App`, iconURL: guild.iconURL({ size: 128 }) || undefined })
    .setTitle(`👑 Detail Pesanan • ${t.id}`)
    .setDescription(`Halo <@${t.userId}>, terima kasih sudah berbelanja di **${name}**! 💜`)
    .addFields(
      { name: '👤 Pembeli', value: `<@${t.userId}>`, inline: true },
      { name: '🛍️ Produk', value: `\`${clip(i.product, 80)}\``, inline: true },
      { name: '🏷️ Varian', value: `\`${clip(i.variant, 80)}\``, inline: true },
      { name: '🔢 Jumlah', value: `\`${num(i.qty)} akun\``, inline: true },
      { name: '💱 Harga Satuan', value: `\`${rupiah(i.unitPrice)}\``, inline: true },
      { name: '🛡️ Garansi', value: `\`${i.noWarranty ? 'Tanpa Garansi' : i.warrantyDays ? `${num(i.warrantyDays)} hari` : 'Sesuai S&K'}\``, inline: true },
    )
    .setFooter({ text: `${name} • Ticket ${t.id}`, iconURL: guild.iconURL({ size: 64 }) || undefined })
    .setTimestamp(t.closedAt || t.createdAt);
  if (i.image) info.setThumbnail(i.image);
  if (i.data) info.addFields({ name: '📝 Data Pesanan', value: Object.entries(i.data).map(([k, v]) => `**${k}:** \`${clip(v, 80)}\``).join('\n').slice(0, 1024) });
  info.addFields(
    { name: '💰 Total Bayar', value: `## ${rupiah(pay.amount || t.price)}` },
    { name: '📍 Progress Pesanan', value: steps(t) },
    { name: '📌 Status', value: `**${t.status === 'open' ? STAGE_TEXT[i.stage] || '⏳ Diproses' : V.statusLabel(t)}**`, inline: true },
    { name: '🕒 Dibuat', value: ts(t.createdAt, 'f'), inline: true },
  );
  if (i.order?.ref) info.addFields({ name: '🧾 No. Pesanan Pusat', value: `\`${i.order.ref}\``, inline: true });

  const embeds = [info];
  const rows = [];
  const waiting = t.status === 'open' && i.stage === 'waiting_payment';
  if (waiting && pay.mode !== 'manual') {
    const e = new EmbedBuilder()
      .setTitle('💳 Bayar dengan QRIS')
      .setDescription(
        `Scan QR di bawah pakai **m-banking / e-wallet** (DANA, OVO, GoPay, ShopeePay, dll) lalu bayar **TEPAT**:\n## ${rupiah(pay.amount)}\n` +
          `-# Nominal sudah termasuk kode unik kecil — jangan dibulatkan.\n\n⏰ Bayar sebelum **${ts(pay.expiresAt, 't')}** (${ts(pay.expiresAt, 'R')})\n` +
          '✅ Pembayaran dicek **otomatis** tiap beberapa detik — akun langsung dikirim di sini setelah lunas.',
      );
    if (pay.qrUrl) e.setImage(pay.qrUrl);
    embeds.push(e);
    rows.push(
      row(
        pay.payUrl ? linkBtn(pay.payUrl, 'Buka Halaman Bayar', '🔗') : null,
        btn(`store:inscheck:${t.id}`, 'Cek Pembayaran', '🔄', ButtonStyle.Success),
        btn(`store:inscancel:${t.id}`, 'Batalkan Pesanan', '✖️'),
      ),
    );
  } else if (waiting && pay.mode === 'manual') {
    embeds.push(...V.paymentEmbeds(guild, cfg, t).map((x) => EmbedBuilder.from(x).setColor(null)));
    rows.push(...V.paymentRows(t));
  } else if (t.status === 'open' && i.stage === 'need_help') {
    embeds.push(
      new EmbedBuilder()
        .setTitle('🛠️ Pesananmu Sedang Dibantu Admin')
        .setDescription('Pembayaranmu **sudah kami terima** ✅, tapi pengiriman otomatis mengalami kendala. Admin sudah diberi tahu & akan segera membantu di ticket ini. Mohon ditunggu ya 🙏'),
    );
  } else if (t.status === 'open') {
    embeds.push(new EmbedBuilder().setTitle('⚙️ Sedang Diproses').setDescription(i.type === 'manual' ? 'Pesananmu sedang **diproses oleh pusat**. Kamu akan dikabari di ticket ini begitu selesai.' : 'Pembayaran diterima! Akun sedang **dikirim otomatis** — tunggu sebentar ya.'));
  }
  if (t.status === 'open') {
    rows.push(row(btn(`store:close:${t.id}`, 'Tutup Ticket (Admin)', '🔒', ButtonStyle.Danger), t.payment?.status === 'paid' && i.stage === 'need_help' ? btn(`store:insretry:${t.id}`, 'Kirim Ulang Otomatis (Admin)', '🔁') : null));
  }
  if (t.closedAt) info.addFields({ name: '🔒 Selesai', value: ts(t.closedAt, 'f'), inline: true });
  return { embeds, components: rows };
}

/** Channel panel NCS Ticket Center (tickets.json → panelChannelId). */
function helpChannelId() {
  try {
    const fs = require('fs');
    const path = require('path');
    const root = path.join(__dirname, '..', '..');
    const cfg = JSON.parse(fs.readFileSync(path.join(root, 'tickets.json'), 'utf8'));
    if (isId(cfg.panelChannelId)) return cfg.panelChannelId;
    const d = JSON.parse(fs.readFileSync(path.join(root, 'data', 'support-tickets.json'), 'utf8'));
    return isId(d?.panel?.channelId) ? d.panel.channelId : null;
  } catch {
    return null;
  }
}
const helpText = (t) => {
  const ch = helpChannelId();
  return `Buat **ticket bantuan** di ${ch ? `<#${ch}>` : 'NCS Ticket Center'} (pilih **👑 Bantuan Premium App**) & sertakan ID \`${t.id}\``;
};

/** Pesan pengiriman akun (di ticket & DM). */
function buildDelivery(guild, cfg, t, { forDm = false } = {}) {
  const i = t.ins;
  const name = V.storeName(cfg, guild);
  const accounts = i.accounts || [];
  const box = UI.accent(new ContainerBuilder(), brand(cfg));
  const head = `## ✅ ${i.type === 'manual' && !accounts.length ? 'Pesanan Selesai Diproses' : 'Akun Berhasil Dikirim'}\n-# ${t.id} • ${clip(i.product, 60)} — ${clip(i.variant, 60)} • ${num(i.qty)} akun`;
  if (i.image) box.addSectionComponents(new SectionBuilder().addTextDisplayComponents(text(head)).setThumbnailAccessory(new ThumbnailBuilder().setURL(i.image)));
  else box.addTextDisplayComponents(text(head));
  if (accounts.length) {
    const chunks = [];
    let cur = '';
    accounts.forEach((a, n) => {
      const part = `**🔐 Akun ${n + 1}**\n\`\`\`\n${String(a).replace(/`/g, 'ˋ').slice(0, 900)}\n\`\`\``;
      if ((cur + part).length > 3800) {
        chunks.push(cur);
        cur = '';
      }
      cur += `${cur ? '\n' : ''}${part}`;
    });
    if (cur) chunks.push(cur);
    for (const c of chunks.slice(0, 8)) {
      box.addSeparatorComponents(line());
      box.addTextDisplayComponents(text(c));
    }
  }
  if (i.note) {
    box.addSeparatorComponents(line());
    box.addTextDisplayComponents(text(`### 📝 Catatan Penggunaan\n${cleanDesc(i.note, 1500)}`));
  }
  box.addSeparatorComponents(line());
  box.addTextDisplayComponents(
    text(
      [
        i.noWarranty
          ? `⚠️ **Produk tanpa garansi** — tidak ada penggantian / refund bila akun bermasalah. Butuh bantuan? ${helpText(t)}.`
          : `🛡️ ${i.warrantyDays ? `**Garansi ${num(i.warrantyDays)} hari.** ` : ''}Ada kendala? ${helpText(t)}.`,
        '🔒 **Jangan bagikan** data akun ke siapa pun & **jangan ganti password** kecuali diizinkan.',
        forDm ? '💾 Simpan pesan ini baik-baik ya.' : '💾 **Salin & simpan sekarang** — ticket ini akan ditutup otomatis setelah testimoni. Salinannya juga dikirim ke DM kamu.',
      ].join('\n'),
    ),
  );
  box.addSeparatorComponents(line());
  box.addTextDisplayComponents(text(`-# ${name} • ${ts(Date.now(), 'f')}`));
  const help = helpChannelId();
  const buttons = [!forDm && accounts.length ? btn(`store:inscopy:${t.id}`, 'Salin Data Akun', '📋') : null, help ? linkBtn(channelUrl(guild.id, help), 'Ticket Bantuan', '🛟') : null].filter(Boolean);
  if (buttons.length) box.addActionRowComponents(row(...buttons));
  return { components: [...(forDm ? [] : [text(`<@${t.userId}>`)]), box], flags: V2F, allowedMentions: { users: forDm ? [] : [t.userId] } };
}

// ═════════════════════════════ Pengecekan pembayaran & pengiriman otomatis ═════════════════════════════
async function guildOf(t) {
  const client = ctx.getClient();
  return client?.guilds.cache.get(t.guildId) || (await client?.guilds.fetch(t.guildId).catch(() => null)) || null;
}
async function channelOf(t) {
  return t.channelId ? ctx.getClient()?.channels.fetch(t.channelId).catch(() => null) : null;
}
async function refreshTicket(t) {
  const guild = await guildOf(t);
  const ch = await channelOf(t);
  if (guild && ch) await ctx.editTicketMsg(ch, guild, loadConfig(), t);
}

/** Cek satu ticket. Return teks status singkat (untuk tombol Cek Pembayaran). */
async function checkTicket(t, { manual = false } = {}) {
  if (busy.has(t.id)) return '⏳ Sedang diproses, tunggu sebentar...';
  busy.add(t.id);
  try {
    const i = t.ins;
    const pay = i.pay || {};
    // 1) Menunggu pembayaran
    if (pay.status === 'pending' && pay.mode === 'deposit') {
      const r = await W.getDeposit(pay.depositId);
      const dep = r.deposit || {};
      if (dep.credited || dep.status === 'paid') {
        if (!dep.credited) return '💰 Pembayaran terdeteksi — menunggu saldo masuk (± 1 menit).';
        pay.status = 'paid';
        pay.paidAt = Date.parse(dep.paid_at) || Date.now();
        save();
        if (t.status !== 'open') {
          await alert(await guildOf(t), t, { title: 'Dana Masuk Setelah Pesanan Dibatalkan', text: `Pembeli membayar **${rupiah(pay.amount)}** setelah pesanan dibatalkan / kedaluwarsa. Saldo Waroeng sudah bertambah — **kembalikan dana ke pembeli secara manual** atau kirim pesanan manual.` });
          return '⚠️ Pesanan sudah dibatalkan.';
        }
        await onPaid(t);
        return '✅ Pembayaran diterima!';
      }
      if (['expired', 'cancelled'].includes(dep.status) || Date.now() > pay.expiresAt + 3 * 60000) {
        pay.status = 'expired';
        save();
        if (t.status === 'open') await cancelTicket(t, 'Pembayaran QRIS kedaluwarsa', '⌛ Pembayaran kedaluwarsa');
        return '⌛ Pembayaran kedaluwarsa.';
      }
      return manual ? `⏳ Belum ada pembayaran masuk. Bayar **tepat ${rupiah(pay.amount)}** sebelum ${ts(pay.expiresAt, 't')}.` : null;
    }
    if (pay.status === 'pending' && pay.mode === 'qris') {
      const r = await W.getOrder(pay.orderId);
      const o = r.order || {};
      applyOrder(t, o);
      if (o.status === 'pending') {
        if (Date.now() > pay.expiresAt + 3 * 60000) {
          pay.status = 'expired';
          save();
          if (t.status === 'open') await cancelTicket(t, 'Pembayaran QRIS kedaluwarsa', '⌛ Pembayaran kedaluwarsa');
          return '⌛ Pembayaran kedaluwarsa.';
        }
        return manual ? `⏳ Belum ada pembayaran masuk. Bayar **tepat ${rupiah(pay.amount)}** sebelum ${ts(pay.expiresAt, 't')}.` : null;
      }
      if (['expired', 'cancelled'].includes(o.status)) {
        pay.status = o.status;
        save();
        if (t.status === 'open') await cancelTicket(t, o.status === 'expired' ? 'Pembayaran QRIS kedaluwarsa' : 'Pesanan dibatalkan', o.status === 'expired' ? '⌛ Pembayaran kedaluwarsa' : '❌ Order dibatalkan');
        return '⌛ Pesanan tidak aktif lagi.';
      }
      pay.status = 'paid';
      pay.paidAt = Date.now();
      markPaymentPaid(t);
      save();
      if (t.status !== 'open') {
        await alert(await guildOf(t), t, { title: 'Dibayar Setelah Dibatalkan', text: `Order QRIS \`${o.ref || o.id}\` dibayar setelah ticket ditutup. Akun ada di riwayat Waroeng — kirim manual ke <@${t.userId}>.` });
        return '⚠️ Pesanan sudah ditutup.';
      }
      ctx.logOrder(await guildOf(t), t, '💰 Pembayaran QRIS diterima otomatis');
      await handleOrderState(t, o);
      return '✅ Pembayaran diterima!';
    }
    if (t.status !== 'open') return 'Ticket ini sudah ditutup.';
    // 2) Sudah dibayar → kirim / pantau pesanan
    if (['paid', 'fulfill_retry'].includes(i.stage)) {
      await fulfill(t);
      return '⚙️ Pesanan sedang diproses.';
    }
    if (i.stage === 'processing' && i.order?.id) {
      const r = await W.getOrder(i.order.id);
      await handleOrderState(t, r.order);
      return '🔄 Pesanan sedang diproses pusat.';
    }
    return null;
  } catch (err) {
    if (err.code === 'unauthorized' || err.code === 'no_api_key' || err.code === 'ip_not_allowed') {
      await alertOnce(t, `auth:${err.code}`, { title: 'API Waroeng Ditolak', err });
    } else if (!W.isTemporary(err)) {
      console.warn(`[instan] cek ${t.id}:`, err.code, err.message);
    }
    return manual ? `⚠️ Gagal mengecek: ${clip(err.message, 150)}` : null;
  } finally {
    busy.delete(t.id);
  }
}

function markPaymentPaid(t) {
  t.payment = { ...(t.payment || {}), status: 'paid', paidAt: Date.now(), paidBy: 'qris', amount: t.ins.pay?.amount || t.price };
}

/** Pembayaran lunas (QRIS deposit otomatis / admin Dana Masuk di mode manual). */
async function onPaid(t) {
  if (t.payment?.status !== 'paid') markPaymentPaid(t);
  if (t.ins.pay) t.ins.pay.status = 'paid';
  t.ins.stage = 'paid';
  save();
  const own = !busy.has(t.id); // dipanggil dari luar pemantau (Dana Masuk admin) → kunci ticket
  if (own) busy.add(t.id);
  try {
    const guild = await guildOf(t);
    if (t.ins.mode !== 'manual') ctx.logOrder(guild, t, '💰 Pembayaran QRIS diterima otomatis');
    await refreshTicket(t);
    await fulfill(t);
  } finally {
    if (own) busy.delete(t.id);
  }
}

/** Beli ke Waroeng pakai saldo (ref_id tetap sama → aman diulang, saldo tidak terpotong dua kali). */
async function fulfill(t) {
  const i = t.ins;
  if (t.status !== 'open' || i.stage === 'delivered') return;
  i.stage = 'fulfilling';
  i.attempts = (i.attempts || 0) + 1;
  save();
  let r;
  try {
    r = await W.createOrder({
      variant_id: i.variantId,
      qty: i.qty,
      ref_id: i.refId,
      max_price: i.unitPrice, // tidak pernah membeli lebih mahal dari harga yang dibayar pembeli
      data: i.data || undefined,
      accept_no_warranty: i.noWarranty || undefined,
    });
  } catch (err) {
    i.lastError = { code: err.code, message: err.message, at: Date.now() };
    if (W.isTemporary(err) && i.attempts < 8) {
      i.stage = 'fulfill_retry';
      i.retryAt = Date.now() + Math.min(5 * 60000, 15000 * i.attempts);
      save();
      return;
    }
    i.stage = 'need_help';
    save();
    await refreshTicket(t);
    const guild = await guildOf(t);
    ctx.logOrder(guild, t, '🛠️ Pengiriman otomatis terkendala — dibantu admin');
    await alert(guild, t, { title: 'Pesanan Butuh Bantuan', err });
    return;
  }
  i.lastError = null;
  await handleOrderState(t, r.order);
}

/** Tindak lanjut status order dari Waroeng. */
async function handleOrderState(t, o) {
  if (!o) return;
  const i = t.ins;
  applyOrder(t, o);
  save();
  const guild = await guildOf(t);
  if (o.status === 'success') return deliver(t);
  if (o.status === 'need_data') {
    if (i.data && o.claim_code) {
      try {
        const r = await W.sendInvite(o.claim_code, i.data);
        applyOrder(t, r.order);
      } catch (err) {
        i.stage = 'need_help';
        save();
        await refreshTicket(t);
        return alert(guild, t, { title: 'Gagal Mengirim Data Undangan', err });
      }
    } else {
      i.stage = 'need_help';
      save();
      await refreshTicket(t);
      return alert(guild, t, { title: 'Pesanan Manual Butuh Data', text: `Pesanan pusat menunggu data undangan (claim code \`${o.claim_code || '-'}\`). Minta data ke pembeli lalu kirim lewat panel Waroeng.` });
    }
  }
  if (o.status === 'refunded') {
    i.stage = 'need_help';
    save();
    await refreshTicket(t);
    ctx.logOrder(guild, t, '🛠️ Pesanan ditolak pusat — dibantu admin');
    return alert(guild, t, { title: 'Pesanan Ditolak Pusat (Dana Kembali ke Saldo)', text: `Alasan pusat: ${clip(o.note || '-', 300)}\nModal sudah kembali ke saldo Waroeng. **Kembalikan dana pembeli** (${rupiah(t.payment?.amount || t.price)}) lalu tutup ticket sebagai Refund.` });
  }
  if (['processing', 'need_data'].includes(o.status) || o.status === 'pending') {
    if (i.stage !== 'processing') {
      i.stage = 'processing';
      i.processingSince = Date.now();
      save();
      await refreshTicket(t);
      ctx.logOrder(guild, t, '🔄 Pesanan diproses pusat');
    }
    // Terlalu lama diproses → beri tahu admin (sekali).
    if (Date.now() - (i.processingSince || Date.now()) > 3 * 3600000) await alertOnce(t, 'slow', { title: 'Pesanan Diproses Lebih dari 3 Jam', text: `Status pusat: \`${o.status}\` • No. pesanan \`${o.ref || o.id}\`.` });
  }
}

/** Kirim akun ke ticket + DM, lalu tandai selesai (statistik, role spender, testimoni). */
async function deliver(t) {
  const i = t.ins;
  if (i.stage === 'delivered' || t.status !== 'open') return;
  i.stage = 'delivered';
  i.deliveredAt = Date.now();
  save();
  const guild = await guildOf(t);
  const ch = await channelOf(t);
  const cfg = loadConfig();
  if (!guild) return;
  if (ch) await ch.send(buildDelivery(guild, cfg, t)).catch((e) => console.warn(`[instan] kirim akun ${t.id}:`, e.message));
  const user = await ctx.getClient().users.fetch(t.userId).catch(() => null);
  i.dmSent = await user
    ?.send(buildDelivery(guild, cfg, t, { forDm: true }))
    .then(() => true)
    .catch(() => false);
  save();
  if (!ch && !i.dmSent) {
    await alert(guild, t, { title: 'Akun Gagal Dikirim ke Pembeli', text: `Channel ticket tidak ditemukan & DM pembeli tertutup. Kirim manual akun dari pesanan \`${i.order?.ref || i.refId}\` ke <@${t.userId}>.` });
  }
  await complete(guild, ch, t);
}

/** Tandai ticket Completed (sama seperti tutup ticket admin, tanpa upload bukti). */
async function complete(guild, channel, t) {
  const cfg = loadConfig();
  t.status = 'completed';
  t.closedAt = Date.now();
  t.closedBy = ctx.getClient().user.id;
  state.stats.transactions += 1;
  state.stats.revenue += t.price;
  const sp = state.spenders[t.userId] || { robux: 0, revenue: 0, orders: 0 };
  const before = { tier: SP.tierFor(sp.revenue, cfg), firstOrder: sp.orders === 0 };
  sp.revenue += t.price;
  sp.orders += 1;
  state.spenders[t.userId] = sp;
  const ps = productStatsOf(t.productId);
  ps.orders += 1;
  ps.revenue += t.price;
  // Ticket disimpan lebih lama (data akun) sebelum testimoni otomatis & channel dihapus.
  const keep = Math.max(Number(instantProduct(cfg, t.productId)?.ticket?.keepMinutes) || 30, 1) * 60000;
  t.testimonyDeadline = Date.now() + Math.max(keep, ctx.testimonyTimeoutMs(cfg));
  save();

  const res = await SP.applySpenderRoles(guild, t.userId, cfg).catch(() => null);
  const tierNow = SP.tierFor(sp.revenue, cfg);
  const levelUp = tierNow && tierNow !== before.tier && tierNow.min !== before.tier?.min;
  if (res && (levelUp || before.firstOrder) && cfg.spenderRoles?.announce !== false) {
    const tier = SP.buildTierUp(guild, cfg, t.userId, { prevTier: before.tier, tier: levelUp ? tierNow : null, firstOrder: before.firstOrder });
    await channel?.send(V.toV2(tier)).catch(() => {});
    const u = await ctx.getClient().users.fetch(t.userId).catch(() => null);
    await u?.send(V.dm(tier)).catch(() => {});
  }
  if (channel) {
    await ctx.editTicketMsg(channel, guild, cfg, t).catch(() => {});
    await channel.send(V.toV2(V.buildTestimonyPrompt(guild, cfg, t))).catch(() => {});
  }
  ctx.logOrder(guild, t, t.ins.type === 'manual' ? '✅ Pesanan selesai diproses' : '✅ Akun terkirim otomatis');
  ctx.refreshPanel();
  ctx.refreshLeaderboard();
}

/** Batalkan ticket (kedaluwarsa / dibatalkan pembeli) & hapus channel otomatis. */
async function cancelTicket(t, note, logText) {
  const cfg = loadConfig();
  const guild = await guildOf(t);
  t.status = 'cancelled';
  t.closedAt = Date.now();
  t.closedBy = ctx.getClient()?.user?.id || null;
  t.note = note;
  t.ins.stage = 'cancelled';
  const secs = Number(cfg.ticket?.deleteAfterSeconds) || 15;
  t.deleteAt = Date.now() + Math.max(secs, 30) * 1000;
  save();
  const ch = await channelOf(t);
  if (ch && guild) {
    await ctx.editTicketMsg(ch, guild, cfg, t).catch(() => {});
    await ch
      .send(
        card(cfg, {
          top: `<@${t.userId}>`,
          header: `## ❌ Pesanan Dibatalkan\n${note}.${t.ins.pay?.mode === 'deposit' ? '\n⚠️ **Jangan membayar QRIS lama** — buat pesanan baru dari panel kalau ingin membeli lagi.' : ''}`,
          blocks: [`Channel ini akan dihapus dalam **${Math.max(secs, 30)} detik**.`],
        }),
      )
      .catch(() => {});
  }
  ctx.logOrder(guild, t, logText);
  ctx.refreshPanel();
}

// ═════════════════════════════ Channel alert admin (system error) ═════════════════════════════
const ERROR_HINT = {
  insufficient_balance: '💸 **Saldo Waroeng kurang.** Isi saldo lalu klik **🔁 Kirim Ulang Otomatis**.',
  out_of_stock: '📦 **Stok di pusat habis** saat pesanan dibuat. Tunggu restock lalu kirim ulang, atau refund pembeli.',
  price_changed: '💱 **Harga pusat naik** di atas harga jual. Naikkan harga / kirim ulang setelah harga turun, atau refund pembeli.',
  unauthorized: '🔑 **API key ditolak.** Cek `WRK_KEY` di `.env` (key dibuat ulang = key lama mati), lalu restart bot.',
  no_api_key: '🔑 **API key belum diisi** di `.env` (`WRK_KEY=wrk_...`).',
  ip_not_allowed: '🌐 **IP VPS tidak ada di whitelist** panel reseller Waroeng.',
  no_warranty_ack_required: '⚠️ Varian tanpa garansi butuh persetujuan.',
  too_many_pending: '⏳ QRIS menunggu bayar sudah penuh.',
  rate_limited: '⏳ Terlalu banyak permintaan ke API — otomatis dicoba lagi.',
};
const alerted = new Set();
async function alertOnce(t, key, opts) {
  const k = `${t.id}:${key}`;
  if (alerted.has(k)) return;
  alerted.add(k);
  return alert(await guildOf(t), t, opts);
}

async function alert(guild, t, { title, text: body, err } = {}) {
  const cfg = loadConfig();
  const p = instantProduct(cfg, t?.productId);
  const chId = alertChannelOf(cfg, p);
  const desc = [body, err ? `**Error:** \`${err.code || 'error'}\` — ${clip(err.message, 300)}` : null, err && ERROR_HINT[err.code] ? ERROR_HINT[err.code] : null].filter(Boolean).join('\n');
  console.warn(`[instan] ⚠️ ${title}${t ? ` (${t.id})` : ''}: ${desc.replace(/\n/g, ' | ')}`);
  if (!guild || !chId) return;
  const ch = await guild.channels.fetch(chId).catch(() => null);
  if (!ch?.isTextBased?.()) return;
  const role = isId(p?.alertRoleId) ? p.alertRoleId : null;
  const i = t?.ins || {};
  const details = t
    ? [
        `🎫 **Ticket:** \`${t.id}\`${t.channelId ? ` • <#${t.channelId}>` : ''}`,
        `👤 **Pembeli:** <@${t.userId}>`,
        `🛍️ **Produk:** \`${clip(`${i.product} — ${i.variant}`, 80)}\` × ${num(i.qty)}`,
        `💰 **Dibayar Pembeli:** \`${rupiah(t.payment?.amount || i.pay?.amount || t.price)}\` • **Modal:** \`${rupiah((i.unitCost || 0) * (i.qty || 1))}\``,
        `💳 **Pembayaran:** \`${t.payment?.status === 'paid' ? 'Lunas' : i.pay?.status || '-'}\` (${i.mode || '-'})`,
        `🧾 **ref_id:** \`${i.refId}\`${i.order?.ref ? ` • **No. Pusat:** \`${i.order.ref}\`` : ''}`,
      ].join('\n')
    : null;
  const rows = [];
  if (t) {
    const buttons = [];
    if (t.channelId) buttons.push(linkBtn(channelUrl(guild.id, t.channelId), 'Buka Ticket', '🎫'));
    if (t.status === 'open' && t.payment?.status === 'paid') buttons.push(btn(`store:insretry:${t.id}`, 'Kirim Ulang Otomatis', '🔁', ButtonStyle.Primary));
    if (buttons.length) rows.push(row(...buttons));
  }
  const payload = card(cfg, {
    top: role ? `<@&${role}>` : undefined,
    header: `## ⚠️ ${title}\n-# ${V.storeName(cfg, guild)} • Store System Alert`,
    blocks: [desc || null, details],
    footer: ts(Date.now(), 'f'),
    rows,
  });
  payload.allowedMentions = { roles: role ? [role] : [] };
  await ch.send(payload).catch((e) => console.warn('[instan] kirim alert:', e.message));
}

// ═════════════════════════════ Tombol di ticket ═════════════════════════════
function instantTicket(interaction, ticketId) {
  const t = state.tickets[ticketId];
  if (!t || kindOf(t) !== 'instant') {
    interaction.reply({ content: 'Ticket tidak ditemukan.', flags: EPH }).catch(() => {});
    return null;
  }
  return t;
}

async function onCheck(interaction, ticketId) {
  const t = instantTicket(interaction, ticketId);
  if (!t) return;
  await interaction.deferReply({ flags: EPH });
  const msg = await checkTicket(t, { manual: true });
  return interaction.editReply(msg || (t.status === 'open' ? '⏳ Pesanan sedang diproses.' : 'Ticket ini sudah selesai.'));
}

async function onCancel(interaction, ticketId) {
  const t = instantTicket(interaction, ticketId);
  if (!t) return;
  if (interaction.user.id !== t.userId && !isAdmin(interaction.member)) return interaction.reply({ content: `⛔ Hanya <@${t.userId}> (pembeli) yang bisa membatalkan.`, flags: EPH });
  if (t.status !== 'open' || t.ins.stage !== 'waiting_payment') return interaction.reply({ content: 'Pesanan ini sudah dibayar / ditutup, tidak bisa dibatalkan.', flags: EPH });
  await interaction.deferReply({ flags: EPH });
  const pay = t.ins.pay || {};
  // Cek dulu: siapa tahu sudah dibayar.
  await checkTicket(t);
  if (t.status !== 'open' || t.ins.stage !== 'waiting_payment') return interaction.editReply('✅ Pembayaranmu ternyata **sudah masuk** — pesanan diproses, tidak dibatalkan.');
  if (pay.mode === 'qris') {
    try {
      const r = await W.cancelOrder(pay.orderId);
      if (r.cancelled === false) {
        await checkTicket(t);
        return interaction.editReply('✅ Pembayaranmu ternyata **sudah masuk** — pesanan diproses.');
      }
      pay.status = 'cancelled';
    } catch (err) {
      if (err.code !== 'not_cancellable') return interaction.editReply(`⚠️ Gagal membatalkan: ${clip(err.message, 150)}`);
    }
  }
  // Mode deposit: QRIS tetap dipantau sampai kedaluwarsa (kalau terlanjur dibayar → admin diberi tahu).
  await cancelTicket(t, 'Dibatalkan oleh pembeli', '❌ Order dibatalkan pembeli');
  return interaction.editReply('✖️ Pesanan dibatalkan. **Jangan membayar QRIS lama** ya.');
}

async function onRetry(interaction, ticketId) {
  if (!isAdmin(interaction.member)) return interaction.reply({ content: '⛔ Hanya **Administrator**.', flags: EPH });
  const t = instantTicket(interaction, ticketId);
  if (!t) return;
  if (t.status !== 'open' || t.payment?.status !== 'paid') return interaction.reply({ content: 'Ticket ini tidak sedang menunggu pengiriman.', flags: EPH });
  if (t.ins.stage === 'delivered') return interaction.reply({ content: '✅ Akun sudah terkirim.', flags: EPH });
  if (busy.has(t.id)) return interaction.reply({ content: '⏳ Pesanan ini sedang diproses, tunggu sebentar.', flags: EPH });
  await interaction.deferReply({ flags: EPH });
  busy.add(t.id);
  try {
    t.ins.attempts = 0;
    t.ins.stage = 'paid';
    save();
    await refreshTicket(t);
    await fulfill(t);
  } finally {
    busy.delete(t.id);
  }
  const st = t.ins.stage;
  return interaction.editReply(
    st === 'delivered'
      ? '✅ Berhasil! Akun sudah dikirim ke pembeli.'
      : st === 'processing'
      ? '🔄 Pesanan diterima pusat & sedang diproses — akan dikirim otomatis.'
      : `⚠️ Masih gagal: \`${t.ins.lastError?.code || '-'}\` ${clip(t.ins.lastError?.message || '', 200)}`,
  );
}

async function onCopy(interaction, ticketId) {
  const t = instantTicket(interaction, ticketId);
  if (!t) return;
  if (interaction.user.id !== t.userId && !isAdmin(interaction.member)) return interaction.reply({ content: '⛔ Hanya pembeli yang bisa melihat data akun ini.', flags: EPH });
  const acc = t.ins.accounts || [];
  if (!acc.length) return interaction.reply({ content: 'Belum ada data akun.', flags: EPH });
  return interaction.reply({ content: clip(`**${t.ins.product} — ${t.ins.variant}**\n\n${acc.map((a, n) => `Akun ${n + 1}:\n${a}`).join('\n\n')}\n\n_Tekan lama teks untuk menyalin._`, 2000), flags: EPH });
}

// ═════════════════════════════ Pemantau berkala ═════════════════════════════
let ticking = false;
async function tick() {
  if (ticking || !ctx?.getClient()) return;
  ticking = true;
  try {
    const now = Date.now();
    for (const [k, v] of sessions) if (v.expires < now) sessions.delete(k);
    for (const t of Object.values(state.tickets)) {
      if (kindOf(t) !== 'instant' || !t.ins) continue;
      const pay = t.ins.pay || {};
      const watchPay = pay.status === 'pending' && pay.mode !== 'manual' && now < (pay.expiresAt || 0) + 10 * 60000;
      const work = t.status === 'open' && (['paid'].includes(t.ins.stage) || (t.ins.stage === 'fulfill_retry' && now >= (t.ins.retryAt || 0)));
      // Pesanan diproses pusat: cek tiap ±60 detik.
      const proc = t.status === 'open' && t.ins.stage === 'processing' && now - (t.ins.lastPoll || 0) > 60000;
      if (!watchPay && !work && !proc) continue;
      if (proc) t.ins.lastPoll = now;
      await checkTicket(t);
    }
  } catch (err) {
    console.error('[instan] tick:', err.message);
  } finally {
    ticking = false;
  }
}

let lastSummary = '';
async function refreshCatalogCache() {
  const cfg = loadConfig();
  const p = instantProduct(cfg);
  if (!p || !W.hasKey()) return;
  await W.getProducts({ force: true }).catch((e) => console.warn('[instan] katalog:', e.code, e.message));
  const s = summaryOf(p);
  const key = `${s.products}|${s.variants}|${s.min}`;
  if (key !== lastSummary) {
    lastSummary = key;
    ctx.refreshPanel();
  }
}

/** Dipanggil flow.js. */
function init(c) {
  ctx = c;
}
function start() {
  const p = instantProduct(loadConfig());
  if (!p) return;
  if (!W.hasKey()) console.warn('[instan] WRK_KEY belum diisi di .env — Premium App tidak bisa mengambil produk / memproses pesanan.');
  refreshCatalogCache();
  setInterval(tick, POLL_MS);
  setInterval(refreshCatalogCache, 5 * 60 * 1000);
}

// ═════════════════════════════ Router (dipanggil flow.js) ═════════════════════════════
/** Return true kalau interaksi milik Premium App. */
async function handle(interaction, action, arg) {
  const cfg = loadConfig();
  const p = () => instantProduct(cfg, arg) || instantProduct(cfg);
  const run = async (fn) => {
    await fn();
    return true;
  };
  if (interaction.isButton()) {
    if (action === 'insback') return run(() => onBack(interaction, p()));
    if (action === 'inscatback') return run(() => onCategoryBack(interaction, p()));
    if (action === 'insrefresh') return run(() => onRefresh(interaction, p()));
    if (action === 'inspage') return run(() => onPage(interaction, arg));
    if (action === 'insconfirm') return run(() => onConfirm(interaction, arg === 'yes'));
    if (action === 'inscheck') return run(() => onCheck(interaction, arg));
    if (action === 'inscancel') return run(() => onCancel(interaction, arg));
    if (action === 'insretry') return run(() => onRetry(interaction, arg));
    if (action === 'inscopy') return run(() => onCopy(interaction, arg));
    if (action === 'insmine') return run(() => onMine(interaction));
    if (action === 'insbuy') return run(() => onForumBuy(interaction, arg));
  } else if (interaction.isStringSelectMenu()) {
    if (action === 'inscat') return run(() => onCategory(interaction, p()));
    if (action === 'insprod') return run(() => onProduct(interaction, p()));
    if (action === 'insvar') return run(() => onVariant(interaction, p()));
  } else if (interaction.isModalSubmit()) {
    if (action === 'insmodal') return run(() => onModal(interaction, arg));
  }
  return false;
}

/** Status untuk /store premium-app. */
async function adminStatus(guild) {
  const cfg = loadConfig();
  const p = instantProduct(cfg);
  if (!p) return card(cfg, { header: '❌ Belum ada produk `"type": "instant"` di store.json.' });
  let bal = null;
  let err = null;
  try {
    bal = await W.getBalance();
    await W.getProducts({ force: true });
  } catch (e) {
    err = e;
  }
  const s = summaryOf(p);
  const tickets = Object.values(state.tickets).filter((t) => kindOf(t) === 'instant');
  const open = tickets.filter((t) => t.status === 'open');
  const help = open.filter((t) => t.ins?.stage === 'need_help');
  const chId = alertChannelOf(cfg, p);
  return card(cfg, {
    header: `## 👑 Status Premium App\n-# Waroeng API`,
    blocks: [
      err
        ? `🔴 **API:** gagal — \`${err.code}\` ${clip(err.message, 200)}${ERROR_HINT[err.code] ? `\n${ERROR_HINT[err.code]}` : ''}`
        : `🟢 **API:** terhubung sebagai **${bal?.reseller?.name || '-'}**\n💰 **Saldo:** \`${rupiah(bal?.reseller?.balance)}\`${bal?.bonus ? `\n🎁 Bonus isi saldo ${bal.bonus.pct}% (min ${rupiah(bal.bonus.min)})` : ''}`,
      [
        `🏪 **Status Produk:** ${isProductOpen(p) ? '`🟢 BUKA`' : '`🔴 TUTUP` → `/store buka`'}`,
        `💳 **Mode Bayar:** \`${payMode(p)}\``,
        `🛍️ **Dijual:** \`${num(s.products)} produk • ${num(s.variants)} varian tersedia\``,
        `🔔 **Channel Alert:** ${chId ? `<#${chId}>` : '`belum diatur` (isi alertChannelId di store.json)'}`,
      ].join('\n'),
      [
        `🎫 **Ticket Berjalan:** \`${open.length}\` • 🛠️ **Butuh Bantuan:** \`${help.length}\``,
        `✅ **Order Selesai:** \`${num(productStatsOf(p.id).orders)}\` • 💰 **Omzet:** \`${rupiah(productStatsOf(p.id).revenue)}\``,
        help.length ? help.slice(0, 10).map((t) => `▸ \`${t.id}\` <#${t.channelId}> • ${clip(t.ins.lastError?.code || t.ins.order?.status || '-', 40)}`).join('\n') : null,
      ]
        .filter(Boolean)
        .join('\n'),
    ],
    footer: footerOf(cfg, guild),
  });
}

module.exports = {
  init,
  start,
  handle,
  buildPanel,
  onInfo,
  onPaid,
  buildTicket,
  summaryOf,
  sellPrice,
  instantProduct,
  adminStatus,
  payMode,
  // dipakai katalog forum (forum.js)
  sellable,
  groupCatalog,
  productSummary,
  inStock,
  cleanDesc,
  warrantyText,
  helpChannelId,
  minTotal,
  PAY_LABEL,
};
