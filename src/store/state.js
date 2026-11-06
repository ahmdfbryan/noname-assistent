const fs = require('fs');
const path = require('path');

/**
 * Data toko yang tersimpan permanen (tahan restart): status buka/tutup per produk, stock, rate,
 * lokasi panel & leaderboard, semua ticket, statistik, dan data spender.
 */
const FILE = path.join(__dirname, '..', '..', 'data', 'store-state.json');

const DEFAULT = {
  products: {}, // { productId: { open, autoClosed } } — autoClosed = tutup otomatis karena stock habis
  stock: 0, // stock Robux
  stocks: {}, // stock produk lain { productId: jumlah } — misal slot Canva Pro
  rates: {}, // { productId: rate }
  minAmounts: {}, // { productId: minimal order Robux } — diatur dari Store Control Center
  panel: null, // { channelId, messageId }
  leaderboard: null, // { channelId, messageId }
  reputation: null, // panel Store Reputation { channelId, messageId }
  howto: null, // panel How to Order { channelId, messageId }
  catalog: null, // { channelId, headerId, cards: { productId: messageId } }
  digitalPanel: null, // panel Produk Digital { channelId, messageId }
  digitalCatalog: null, // katalog Produk Digital { channelId, headerId, cards }
  seq: 0,
  rekberSeq: 0,
  gamepassSeq: 0,
  canvaSeq: 0,
  boostSeq: 0,
  tickets: {},
  stats: { transactions: 0, robux: 0, revenue: 0, ratingSum: 0, ratingCount: 0, testimonies: 0, rekber: 0, rekberVolume: 0 },
  spenders: {}, // { userId: { robux, revenue, orders } }
  productStats: {}, // { productId: { orders, robux, revenue } } — statistik per produk
};

function load() {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT));
  }
  // Migrasi data versi lama (status buka/tutup masih 1 untuk seluruh toko → jadi milik Robux Visend).
  if (!data.products && 'open' in data) {
    data.products = { 'robux-visend': { open: Boolean(data.open), autoClosed: Boolean(data.autoClosed) } };
  }
  delete data.open;
  delete data.autoClosed;
  // Statistik per produk belum ada → semua transaksi lama milik Robux Visend.
  if (!data.productStats) {
    const st = data.stats || {};
    data.productStats = { 'robux-visend': { orders: st.transactions || 0, robux: st.robux || 0, revenue: st.revenue || 0 } };
  }
  return { ...DEFAULT, ...data, stats: { ...DEFAULT.stats, ...(data.stats || {}) } };
}

const state = load();

function save() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  // Data besar (banyak ticket) → simpan ringkas tanpa spasi supaya lebih cepat & hemat disk.
  const pretty = Object.keys(state.tickets || {}).length < 300;
  fs.writeFileSync(tmp, pretty ? JSON.stringify(state, null, 2) : JSON.stringify(state));
  fs.renameSync(tmp, FILE);
}

/** Statistik satu produk (jumlah order selesai, Robux terjual, omzet). */
function productStatsOf(productId) {
  if (!state.productStats[productId]) state.productStats[productId] = { orders: 0, robux: 0, revenue: 0 };
  return state.productStats[productId];
}

/** Status buka/tutup satu produk. */
function productState(productId) {
  if (!state.products[productId]) state.products[productId] = { open: false, autoClosed: false };
  return state.products[productId];
}

/** Produk yang memakai stock: Robux Visend (Robux) & Canva Pro (slot). */
const hasStock = (product) => ['robux', 'canva', 'boost'].includes(product?.type);
const stockUnit = (product) => (product?.type === 'robux' ? 'Robux' : product?.stockUnit || 'slot');
function stockOf(product) {
  if (product?.type === 'robux') return state.stock;
  // Server Boost: stock terpisah per paket (1 Bulan / 3 Bulan) → total = jumlah semua paket.
  if (product?.type === 'boost') return (product.plans || []).reduce((a, x) => a + planStockOf(product, x.id), 0);
  return Number(state.stocks?.[product?.id]) || 0;
}
/** Stock satu paket (khusus produk dengan stock per paket, misal Server Boost). */
const planKey = (product, planId) => `${product.id}:${planId}`;
function planStockOf(product, planId) {
  return Number(state.stocks?.[planKey(product, planId)]) || 0;
}
function setPlanStock(product, planId, n) {
  const v = Math.max(0, Math.floor(n));
  state.stocks = state.stocks || {};
  state.stocks[planKey(product, planId)] = v;
  return v;
}
function setStock(product, n) {
  const v = Math.max(0, Math.floor(n));
  if (product.type === 'robux') state.stock = v;
  else {
    state.stocks = state.stocks || {};
    state.stocks[product.id] = v;
  }
  return v;
}

/** Produk bisa dipesan sekarang? (produk ber-stock juga butuh stock > 0, Coming Soon selalu tidak.) */
function isProductOpen(product) {
  if (!product || product.type === 'soon') return false;
  const open = productState(product.id).open;
  return hasStock(product) ? open && stockOf(product) > 0 : open;
}

const kindOf = (t) => t.kind || 'robux';

/**
 * Ticket yang masih berjalan.
 * - kind 'robux'  → cocok berdasarkan pembeli Discord / akun Roblox.
 * - kind 'canva'    → cocok berdasarkan pembeli Discord / email yang sama.
 * - kind 'gamepass' → cocok berdasarkan pembeli Discord / akun Roblox / gamepass yang sama.
 * - kind 'rekber' → cocok kalau user adalah salah satu pihak rekber.
 */
function activeTicketOf({ userId, robloxId, gamepassId, email, kind = 'robux' }) {
  return (
    Object.values(state.tickets).find((t) => {
      if (t.status !== 'open' || kindOf(t) !== kind) return false;
      if (kind === 'rekber') return userId && (t.userId === userId || t.partnerId === userId);
      if (kind === 'canva') return (userId && t.userId === userId) || (email && t.email === email);
      if (kind === 'boost') return userId && t.userId === userId;
      if (kind === 'gamepass' && gamepassId && t.gamepass?.id === gamepassId) return true;
      return (userId && t.userId === userId) || (robloxId && t.roblox?.id === robloxId);
    }) || null
  );
}

function nextTicketId(prefix, key = 'seq') {
  state[key] = (state[key] || 0) + 1;
  return `${prefix || 'NCS'}-${String(state[key]).padStart(4, '0')}`;
}

module.exports = { state, save, productState, productStatsOf, hasStock, stockUnit, stockOf, setStock, planStockOf, setPlanStock, isProductOpen, kindOf, activeTicketOf, nextTicketId };
