// Tambah produk "Robux Visend 2" ke store.json (aman dijalankan berulang). Jalankan dari folder bot:  node scripts/add-visend-2.js
// - Label produk lama jadi "Robux Visend 1" (ID & riwayat order tidak berubah).
// - Produk baru "robux-visend-2" = salinan Visend 1 (rate 145, stock 0, tutup) → atur rate/stock lewat Control Center.
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'store.json');
const raw = fs.readFileSync(file, 'utf8');
const cfg = JSON.parse(raw);
const ps = cfg.products || [];
const i = ps.findIndex((p) => p.id === 'robux-visend');
if (i < 0) throw new Error('Produk "robux-visend" tidak ditemukan di store.json');
if (ps.some((p) => p.id === 'robux-visend-2')) {
  console.log('✅ robux-visend-2 sudah ada — tidak ada yang diubah.');
  process.exit(0);
}
fs.writeFileSync(`${file}.bak-visend2`, raw);
const R = '<:robux:1566126953147273488>';
const v1 = ps[i];
const v2 = JSON.parse(JSON.stringify(v1));
v2.id = 'robux-visend-2';
for (const [p, n] of [[v1, 1], [v2, 2]]) {
  p.label = `Robux Visend ${n}`;
  if (p.terms?.title) p.terms.title = p.terms.title.replace(/ROBUX VISEND( \d)?/, `ROBUX VISEND ${n}`);
  if (p.description) p.description = p.description.replace(/via \*\*Visend( \d)?\*\*/, `via **Visend ${n}**`);
  if (p.howTo?.steps?.[0]) p.howTo.steps[0] = `Buka channel **Store**, klik tombol **${p.emoji || R} Robux Visend ${n}**`;
}
v2.rate = Number(v1.rate) || 145; // ← ubah rate Visend 2 lewat Control Center → Ubah Rate
ps.splice(i + 1, 0, v2);
fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
console.log(`✅ Selesai. Backup: ${file}.bak-visend2\n   Visend 1 & Visend 2 sekarang ada (rate ${v2.rate}). Jalankan: npm run deploy && pm2 restart noname-assistent`);
