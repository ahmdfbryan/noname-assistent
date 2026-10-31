/**
 * Emoji custom Noname (Application Emoji yang di-upload ke bot di Discord Developer Portal → Emojis).
 * Ganti ID di sini kalau emoji di-upload ulang. Format: <:nama:id> (animasi: <a:nama:id>).
 */
const ROBUX = '<:robux:1566126953147273488>';

/**
 * Teks polos untuk tempat yang TIDAK bisa menampilkan emoji custom
 * (pilihan slash command, placeholder dropdown, judul form/modal, nama channel).
 * Emoji custom → diganti cadangan (default kosong), emoji biasa tetap.
 */
const plain = (emoji, fallback = '') => (/^<a?:\w+:\d+>$/.test(String(emoji || '').trim()) ? fallback : emoji);

module.exports = { ROBUX, plain };
