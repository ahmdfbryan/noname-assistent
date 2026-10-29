const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', '..', 'store.json');

/** Dibaca ulang tiap dipakai → edit store.json tidak perlu restart bot. */
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (err) {
    console.error('[store] store.json tidak bisa dibaca:', err.message);
    return null;
  }
}

function color(cfg, key, fallback) {
  const n = parseInt(String(cfg?.colors?.[key] || '').replace('#', ''), 16);
  return Number.isNaN(n) ? fallback : n;
}

const isId = (v) => /^\d{17,20}$/.test(String(v || ''));
const rupiah = (n) => `Rp ${Math.round(Number(n) || 0).toLocaleString('id-ID')}`;
const num = (n) => Math.round(Number(n) || 0).toLocaleString('id-ID');
const fill = (text, guild) => String(text || '').replace(/\{server\}/g, guild?.name || 'Server');
const ts = (ms, style = 'f') => `<t:${Math.floor(ms / 1000)}:${style}>`;

function getProduct(cfg, id) {
  return (cfg?.products || []).find((p) => p.id === id) || null;
}

// ───────────────────────── Kategori panel: Store utama & Produk Digital ─────────────────────────
/** main = panel store utama (Robux, Rekber, ...). digital = panel Produk Digital (Canva Pro, ...). */
const GROUPS = {
  main: { panelKey: 'panel', catalogKey: 'catalog' },
  digital: { panelKey: 'digitalPanel', catalogKey: 'digitalCatalog' },
  instant: { panelKey: 'instantPanel', catalogKey: null }, // 👑 Premium App: panel sendiri, kartu katalog ikut katalog digital
};
const DEFAULT_CHANNELS = { instantPanel: '1565040089573101588', digitalPanel: '1560602559062999120', digitalCatalog: '1560602363553775686', reputation: '1561325807559901234' };
/** Grup produk: store.json → products[].group, atau otomatis (Canva = digital). */
const groupOf = (p) => (p?.type === 'instant' ? 'instant' : p?.group || (['canva', 'boost'].includes(p?.type) ? 'digital' : 'main'));
/** Daftar produk per grup. Panel digital otomatis punya tombol Coming Soon kalau belum ada. */
function productsOf(cfg, group = 'main') {
  const list = (cfg?.products || []).filter((p) => groupOf(p) === group);
  if (group === 'digital' && !list.some((p) => p.type === 'soon')) {
    list.push({
      id: 'coming-soon-digital',
      type: 'soon',
      label: 'Coming Soon',
      emoji: '🔒',
      group: 'digital',
      catalog: { tagline: 'Produk digital baru sedang kami siapkan. **Nantikan kejutannya!** 👀' },
    });
  }
  return list;
}
const channelOf = (cfg, key) => cfg?.channels?.[key] || DEFAULT_CHANNELS[key] || null;
const DIGITAL_TEXT = {
  panel: {
    title: '🛒 Produk Digital',
    subtitle: 'Official Store • {server}',
    description:
      'Butuh **akun premium & produk digital** dengan harga super hemat? ✨\n\nPilih produk di bawah untuk melihat detail & membuka ticket pemesanan. Proses **cepat, aman,** dan dibantu admin sampai aktif!',
  },
  catalog: {
    title: '🛒 Katalog Produk Digital | {server}',
    subtitle: 'Digital Catalog • {server}',
    description:
      'Semua **produk digital {server}** ada di sini! 💎\nSetiap kartu menampilkan **harga, paket, dan sisa slot terkini** — semuanya ter-update otomatis.\n\nKlik **🛒 Order Sekarang** di kartu produk untuk mulai belanja.',
  },
};
/** Teks panel / katalog per grup (store.json → panel / catalog / digitalPanel / digitalCatalog). */
function groupText(cfg, group, kind) {
  if (group === 'digital') return { ...DIGITAL_TEXT[kind], ...(cfg?.[kind === 'panel' ? 'digitalPanel' : 'digitalCatalog'] || {}) };
  return cfg?.[kind] || {};
}

module.exports = { loadConfig, color, isId, rupiah, num, fill, ts, getProduct, GROUPS, groupOf, productsOf, channelOf, groupText };
