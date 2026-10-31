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

module.exports = { ROBUX, CANVA, plain };
