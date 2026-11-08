/**
 * Emoji custom Noname (Application Emoji yang di-upload ke bot di Discord Developer Portal → Emojis).
 * Ganti ID di sini kalau emoji di-upload ulang. Format: <:nama:id> (animasi: <a:nama:id>).
 */
const ROBUX = '<:robux:1566126953147273488>';
const CANVA = '<:canva:1566139381616746607>';

/** Cadangan emoji biasa untuk tiap emoji custom (dipakai di tempat yang tidak bisa menampilkan emoji custom). */
const FALLBACK = { [ROBUX]: '💎', [CANVA]: '🎨' };

/**
 * Teks polos untuk tempat yang TIDAK bisa menampilkan emoji custom
 * (pilihan slash command, placeholder dropdown, judul form/modal, nama channel).
 * Emoji custom → diganti emoji biasa cadangannya (atau fallback), emoji biasa tetap.
 */
const plain = (emoji, fallback = '') => {
  const e = String(emoji || '').trim();
  return /^<a?:\w+:\d+>$/.test(e) ? FALLBACK[e] || fallback : emoji;
};

/**
 * Emoji aplikasi Premium App (Application Emoji). Dicocokkan dari NAMA produk: huruf kecil, tanpa spasi / tanda baca.
 * Tiap aplikasi: [id emoji, nama emoji, kata kunci...]. Produk yang tidak cocok → tanpa emoji aplikasi (pakai 🟢 / 🔴).
 */
const APPS = [
  ['1568976972170788984', 'alightmotion', 'alightmotion'],
  ['1566139381616746607', 'canva', 'canva'],
  ['1568977094497673346', 'applemusic', 'applemusic'],
  ['1568977299607650314', 'capcut', 'capcut'],
  ['1568977410953584733', 'googlegemini', 'gemini'],
  ['1568977493103476736', 'hbomax', 'hbomax', 'hbo'],
  ['1568977667724681388', 'meitu', 'meitu'],
  ['1568977902471487498', 'scribd', 'scribd'],
  ['1568977993001345106', 'spotify', 'spotify'],
  ['1568978080146653225', 'wink', 'wink'],
  ['1568978211495354483', 'zoom', 'zoom'],
  ['1568978309570891827', 'chatgpt', 'chatgpt', 'openai'],
  ['1568978443155152957', 'higgsfield', 'higgsfield'],
  ['1568978566086135899', 'leonardoai', 'leonardo'],
  ['1568979026012409866', 'netflix', 'netflix'],
  ['1568979089816166491', 'remini', 'remini'],
  ['1568979162323091773', 'runninghub', 'runninghub'],
  ['1568979283219714079', 'youtube', 'youtube'],
  ['1568979481228484771', 'hmavpn', 'hmavpn', 'hma'],
  ['1568979556768022733', 'surfsharkvpn', 'surfshark'],
];
/** Emoji aplikasi untuk nama produk, atau null kalau tidak ada yang cocok. Hasil: { id, name, text } */
function appEmoji(productName) {
  const key = String(productName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!key) return null;
  for (const [id, name, ...words] of APPS) {
    if (words.some((w) => key.includes(w))) return { id, name, text: `<:${name}:${id}>` };
  }
  return null;
}

module.exports = { ROBUX, CANVA, plain, appEmoji };
