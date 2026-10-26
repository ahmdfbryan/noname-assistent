const fs = require('fs');
const path = require('path');

/**
 * Pengaturan tampilan bersama (ui.json di folder bot).
 * showAccent false (default) = kotak Components V2 tanpa garis warna di kiri (hanya garis kotak).
 * showAccent true = warna di kiri dipakai lagi seperti sebelumnya.
 * Dibaca ulang otomatis (maks tiap 5 detik) → tidak perlu restart setelah mengubah ui.json.
 */
const FILE = path.join(__dirname, '..', 'ui.json');
let cache = { at: 0, value: false };
function showAccent() {
  if (Date.now() - cache.at > 5000) {
    try {
      cache.value = JSON.parse(fs.readFileSync(FILE, 'utf8')).showAccent === true;
    } catch {
      cache.value = false;
    }
    cache.at = Date.now();
  }
  return cache.value;
}
/** Pasang warna aksen hanya kalau ui.json showAccent: true. Mengembalikan box (bisa di-chain). */
function accent(box, color) {
  if (showAccent() && color != null) box.setAccentColor(color);
  return box;
}

module.exports = { accent, showAccent };
