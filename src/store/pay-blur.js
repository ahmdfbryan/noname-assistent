/**
 * Blur otomatis nama & nomor rekening pada screenshot bukti pembayaran.
 *
 * Cara kerja: OCR lokal (tesseract.js, offline — gambar tidak keluar dari VPS) membaca teks beserta posisinya,
 * lalu area yang dianggap sensitif di-blur dengan sharp:
 *   1. Deretan angka panjang (≥ 8 digit) → nomor rekening / HP / referensi (nominal "Rp 100.000" dilewati).
 *   2. Teks di sebelah label Nama / Penerima / Pengirim / Dari / Ke / Rekening ... (atau baris di bawah label).
 *   3. Baris nama KAPITAL (mis. "AHMAD FAUZI") yang bukan kata umum bank / status.
 *   4. Nama pengirim yang diisi pembeli di form + nomor/nama rekening toko (dikirim lewat `known`).
 * Tidak ada jaminan 100% — makanya admin tetap meninjau hasilnya sebelum testimoni terkirim.
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

let tesseract = null;
try {
  tesseract = require('tesseract.js');
} catch {
  /* paket belum terpasang → blur otomatis nonaktif */
}

const LANG_DIR = (() => {
  try {
    const base = path.dirname(require.resolve('@tesseract.js-data/eng/package.json'));
    const sub = path.join(base, '4.0.0_best_int');
    return fs.existsSync(sub) ? sub : base;
  } catch {
    return null;
  }
})();

const LABELS = /^(nama|name|penerima|pengirim|dari|ke|kepada|tujuan|sumber|rekening|rek|akun|account|recipient|sender|from|to|beneficiary|pemilik|an|a\/n)$/i;
const SKIP_UPPER = new Set(
  ('BERHASIL SUKSES TRANSFER TRANSAKSI PEMBAYARAN PEMBAYARAN BUKTI STRUK RINCIAN DETAIL STATUS SELESAI SUCCESS SUCCESSFUL COMPLETED PAID ' +
    'BANK BCA BNI BRI BSI MANDIRI JAGO SEABANK DANA OVO GOPAY SHOPEEPAY QRIS LINKAJA ALLO CIMB NIAGA PERMATA DANAMON BTN MEGA ' +
    'RP IDR TOTAL NOMINAL JUMLAH BIAYA ADMIN GRATIS TANGGAL WAKTU REFERENSI NOMOR KODE ID BI FAST BIFAST ONLINE ANTAR ANTARBANK ' +
    'SESAMA MOBILE BANKING INTERNET E-WALLET WALLET SALDO PESAN CATATAN BAGIKAN SIMPAN SELESAI OK TUTUP KEMBALI LIHAT DETAIL ' +
    'TERIMA KASIH THANK YOU PAYMENT RECEIPT TRANSACTION CONFIRMATION SENT MONEY TOPUP TOP UP UP').split(/\s+/),
);

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const digitsOf = (s) => String(s || '').replace(/\D/g, '');
const isCurrency = (s) => /^(rp\.?)?\d{1,3}([.,]\d{3})+([.,]\d{1,2})?$/i.test(String(s || '').trim());

// Antrian: OCR berat di CPU, jadi satu per satu.
let queue = Promise.resolve();

async function ocr(buffer) {
  const worker = await tesseract.createWorker('eng', 1, LANG_DIR ? { langPath: LANG_DIR, gzip: true, cacheMethod: 'none' } : {});
  try {
    const r = await worker.recognize(buffer, {}, { blocks: true });
    return r.data;
  } finally {
    await worker.terminate().catch(() => {});
  }
}

/** Ambil kata-kata (dengan posisi) dikelompokkan per baris. */
function linesOf(data) {
  const out = [];
  for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) {
    const words = (l.words || []).filter((w) => w.text && w.text.trim() && (w.confidence ?? 100) > 20 && w.bbox);
    if (words.length) out.push({ words, bbox: l.bbox });
  }
  return out;
}

const boxOf = (ws) => ({
  x0: Math.min(...ws.map((w) => w.bbox.x0)),
  y0: Math.min(...ws.map((w) => w.bbox.y0)),
  x1: Math.max(...ws.map((w) => w.bbox.x1)),
  y1: Math.max(...ws.map((w) => w.bbox.y1)),
});

/** Tentukan kotak yang harus di-blur. */
function findBoxes(lines, known = {}) {
  const boxes = [];
  const add = (ws, why) => ws.length && boxes.push({ ...boxOf(ws), why });
  const knownNames = new Set((known.names || []).flatMap((n) => String(n).split(/\s+/)).map(norm).filter((s) => s.length >= 3));
  const knownNums = new Set((known.numbers || []).map(digitsOf).filter((s) => s.length >= 6));

  lines.forEach((line, li) => {
    const ws = line.words;
    const picked = new Set();

    // 1) Angka panjang (gabungkan kata angka yang berdekatan: "1234 5678 9012").
    let run = [];
    const flush = () => {
      const d = digitsOf(run.map((w) => w.text).join(''));
      const asText = run.map((w) => w.text).join('');
      if (run.length && d.length >= 8 && !run.every((w) => isCurrency(w.text)) && !isCurrency(asText)) run.forEach((w) => picked.add(w));
      run = [];
    };
    ws.forEach((w, i) => {
      const t = w.text.replace(/[Oo]/g, '0');
      if (/^[\d*xX•\-]{3,}$/.test(t) || /\d{4,}/.test(t) || (run.length && /^[\d*xX•\-]{2,}$/.test(t))) {
        if (isCurrency(w.text)) flush();
        else run.push(w);
      } else flush();
      if (i === ws.length - 1) flush();
    });

    // nomor rekening toko yang sudah dikenal
    const lineDigits = digitsOf(ws.map((w) => w.text).join(''));
    for (const n of knownNums) if (lineDigits.includes(n)) ws.forEach((w) => /\d/.test(w.text) && picked.add(w));

    // 2) Nilai di sebelah label (Nama: ..., Penerima ..., Ke ...)
    let labelAt = -1;
    ws.forEach((w, i) => {
      if (labelAt < 0 && LABELS.test(w.text.replace(/[:.\-]+$/, '')) && !/^(ke|to|an)$/i.test(w.text) ) labelAt = i;
      else if (labelAt < 0 && /^(ke|to|dari|from)$/i.test(w.text.replace(/[:]+$/, '')) && i === 0) labelAt = i;
    });
    if (labelAt >= 0) {
      const rest = ws.slice(labelAt + 1).filter((w) => /[A-Za-z0-9]/.test(w.text) && !/^(rekening|bank|akun|account|name|nama)$/i.test(w.text));
      if (rest.length) rest.forEach((w) => picked.add(w));
      else if (lines[li + 1]) lines[li + 1].words.forEach((w) => /[A-Za-z0-9]/.test(w.text) && !isCurrency(w.text) && picked.add(w)); // nilai di baris bawah label
    }

    // 3) Baris nama KAPITAL (≥ 2 kata huruf)
    const alpha = ws.filter((w) => /^[A-Z][A-Z.'-]{2,}$/.test(w.text));
    if (alpha.length >= 2 && alpha.length === ws.length && !alpha.some((w) => SKIP_UPPER.has(w.text.replace(/[^A-Z]/g, '')))) alpha.forEach((w) => picked.add(w));

    // 4) Nama pengirim dari form / nama rekening toko
    ws.forEach((w) => knownNames.has(norm(w.text)) && picked.add(w));

    if (picked.size) add([...picked], 'sensitif');
  });
  return boxes;
}

/** Blur kotak-kotak pada gambar; kembalikan buffer PNG. */
async function applyBlur(buffer, boxes) {
  const img = sharp(buffer, { failOn: 'none' }).rotate();
  const meta = await img.metadata();
  const { width: W, height: H } = meta;
  const parts = [];
  for (const b of boxes) {
    const h = b.y1 - b.y0;
    const padX = Math.round(h * 0.45) + 6;
    const padY = Math.round(h * 0.4) + 4;
    const left = Math.max(0, Math.floor(b.x0 - padX));
    const top = Math.max(0, Math.floor(b.y0 - padY));
    const width = Math.min(W - left, Math.ceil(b.x1 - b.x0 + padX * 2));
    const height = Math.min(H - top, Math.ceil(h + padY * 2));
    if (width < 4 || height < 4) continue;
    const sigma = Math.min(60, Math.max(10, height * 0.55));
    const piece = await sharp(buffer, { failOn: 'none' }).rotate().extract({ left, top, width, height }).blur(sigma).png().toBuffer();
    parts.push({ input: piece, left, top });
  }
  return img.composite(parts).png().toBuffer();
}

/**
 * @param {string} file     path gambar bukti asli
 * @param {string} outFile  path hasil blur (.png)
 * @param {{names?:string[], numbers?:string[]}} known
 * @returns {Promise<{ok:boolean, boxes:number, error?:string}>}
 */
function blurPaymentProof(file, outFile, known = {}) {
  const job = queue.then(async () => {
    if (!tesseract) return { ok: false, boxes: 0, error: 'tesseract.js belum terpasang (jalankan npm install)' };
    try {
      let buf = fs.readFileSync(file);
      // Perbesar gambar kecil supaya OCR lebih akurat (koordinat dikonversi balik).
      const meta = await sharp(buf, { failOn: 'none' }).rotate().metadata();
      const scale = meta.width < 900 ? 2 : 1;
      const ocrBuf = await sharp(buf, { failOn: 'none' }).rotate().resize({ width: Math.round(meta.width * scale) }).greyscale().normalise().png().toBuffer();
      const data = await Promise.race([ocr(ocrBuf), new Promise((_, rej) => setTimeout(() => rej(new Error('OCR timeout')), 90000))]);
      const boxes = findBoxes(linesOf(data), known).map((b) => ({ ...b, x0: b.x0 / scale, y0: b.y0 / scale, x1: b.x1 / scale, y1: b.y1 / scale }));
      const out = await applyBlur(buf, boxes);
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      fs.writeFileSync(outFile, out);
      return { ok: true, boxes: boxes.length };
    } catch (e) {
      return { ok: false, boxes: 0, error: e.message };
    }
  });
  queue = job.catch(() => {});
  return job;
}

module.exports = { blurPaymentProof, __findBoxes: findBoxes };
