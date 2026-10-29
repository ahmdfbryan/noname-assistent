const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const {
  MessageFlags,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  FileBuilder,
  ModalBuilder,
  LabelBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  FileUploadBuilder,
  AttachmentBuilder,
} = require('discord.js');
const UI = require('./ui');

/**
 * 📄 Tools file (Tools Noname): Office → PDF, PDF → Word, gabung / pisah / kompres PDF, PDF → JPG,
 * gambar → PDF, kompres gambar, ubah format gambar. Hasil hanya terlihat oleh pemakai.
 *
 * Program di VPS (sekali pasang):
 *   sudo apt install -y libreoffice-writer libreoffice-calc libreoffice-impress ghostscript poppler-utils fonts-noto-core fonts-liberation
 *   python3 -m venv .venv && .venv/bin/pip install pdf2docx      (di folder bot)
 * Library npm: pdf-lib, sharp, jszip (npm install).
 * Tool yang programnya belum terpasang otomatis tampil "belum tersedia".
 */

const ROOT = path.join(__dirname, '..');
const V2 = MessageFlags.IsComponentsV2;
const EPH = MessageFlags.Ephemeral;
const BRAND = 0x3498db;
const MAX_INPUT_MB = Number(process.env.TOOLS_MAX_INPUT_MB) || 25; // per file
const COOLDOWN_MS = 10 * 1000;
const text = (c) => new TextDisplayBuilder().setContent(String(c).slice(0, 4000));
const line = () => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
const mb = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(b >= 10485760 ? 0 : 1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const base = (name) => path.basename(String(name || 'file'), path.extname(String(name || ''))).replace(/[^\w.\-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 60) || 'file';
const extOf = (name) => path.extname(String(name || '')).toLowerCase().replace('.', '');

// ───────────────────────── Program eksternal ─────────────────────────
function run(cmd, args, { timeout = 120000, cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, cwd, env: { ...process.env, ...(env || {}) }, maxBuffer: 20 * 1024 * 1024, killSignal: 'SIGKILL' }, (err, stdout, stderr) => {
      if (err) {
        err.message = `${err.killed ? 'Waktu proses habis' : err.message}${stderr ? ` — ${String(stderr).slice(-300)}` : ''}`;
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
  });
}
const has = async (cmd, args = ['--version']) => run(cmd, args, { timeout: 30000 }).then(() => true).catch(() => false);
/** Cari program di PATH (cepat, tanpa menjalankannya). Return path lengkap atau null. */
function which(cmd) {
  if (!cmd) return null;
  if (cmd.includes('/')) return fs.existsSync(cmd) ? cmd : null;
  const dirs = String(process.env.PATH || '').split(path.delimiter).concat(['/usr/bin', '/usr/local/bin', '/bin', '/snap/bin', '/usr/lib/libreoffice/program', '/opt/libreoffice/program']);
  for (const d of dirs) {
    const f = path.join(d, cmd);
    try {
      fs.accessSync(f, fs.constants.X_OK);
      return f;
    } catch {}
  }
  return null;
}
const pythonPath = () => process.env.TOOLS_PYTHON || ['.venv/bin/python', '.venv/bin/python3'].map((p) => path.join(ROOT, p)).find((p) => fs.existsSync(p)) || 'python3';

const avail = { checked: false, soffice: null, gs: false, pdftoppm: false, pdf2docx: false, pymupdf: false, sharp: false, pdflib: false, jszip: false };
let lastDetect = 0;
/**
 * Cek program pendukung. Hasil disimpan; kalau masih ada yang belum tersedia, dicek ulang otomatis
 * (maks tiap 60 detik) → setelah memasang program di VPS tidak wajib restart bot.
 */
async function detect(force = false) {
  const missing = !avail.soffice || !avail.gs || !avail.pdftoppm || !avail.pdf2docx || !avail.sharp || !avail.pdflib || !avail.jszip;
  if (avail.checked && !force && (!missing || Date.now() - lastDetect < 60000)) return avail;
  avail.checked = true;
  lastDetect = Date.now();
  const tryReq = (m) => {
    try {
      require(m);
      return true;
    } catch {
      return false;
    }
  };
  avail.sharp = tryReq('sharp');
  avail.pdflib = tryReq('pdf-lib');
  avail.jszip = tryReq('jszip');
  avail.soffice = [process.env.TOOLS_SOFFICE, 'soffice', 'libreoffice'].map(which).find(Boolean) || null;
  avail.gs = Boolean(which('gs'));
  avail.pdftoppm = Boolean(which('pdftoppm'));
  const py = pythonPath();
  avail.pdf2docx = await has(py, ['-c', 'import pdf2docx']);
  avail.pymupdf = await has(py, ['-c', 'import fitz']);
  const sig = JSON.stringify(avail);
  if (sig === detect.lastSig) return avail; // tidak berubah → tidak perlu log ulang
  detect.lastSig = sig;
  const hint = [];
  if (!avail.soffice) hint.push('LibreOffice (sudo apt install -y libreoffice-writer libreoffice-calc libreoffice-impress)');
  if (!avail.gs && !avail.pymupdf) hint.push('Ghostscript (sudo apt install -y ghostscript)');
  if (!avail.pdftoppm) hint.push('poppler-utils (sudo apt install -y poppler-utils)');
  if (!avail.pdf2docx) hint.push(`pdf2docx (python3 -m venv .venv && .venv/bin/pip install pdf2docx) — python: ${py}`);
  if (!avail.sharp || !avail.pdflib || !avail.jszip) hint.push('library npm (jalankan: npm install)');
  if (hint.length) console.warn(`[tools] belum terpasang → ${hint.join(' • ')}`);
  console.log(
    `[tools] tersedia: office→pdf ${avail.soffice ? '✓' : '✗'} • pdf→word ${avail.pdf2docx ? '✓' : '✗'} • kompres pdf ${avail.gs ? '✓ gs' : avail.pymupdf ? '✓ pymupdf' : '✗'} • pdf→jpg ${avail.pdftoppm ? '✓' : '✗'} • sharp ${avail.sharp ? '✓' : '✗'} • pdf-lib ${avail.pdflib ? '✓' : '✗'}`,
  );
  return avail;
}

// ───────────────────────── Antrean (VPS tidak overload) ─────────────────────────
const queue = [];
let running = 0;
const MAX_JOBS = Number(process.env.TOOLS_MAX_JOBS) || 2;
let officeBusy = Promise.resolve(); // LibreOffice: 1 per 1
function enqueue(fn) {
  return new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    pump();
  });
}
function pump() {
  while (running < MAX_JOBS && queue.length) {
    const job = queue.shift();
    running += 1;
    Promise.resolve()
      .then(job.fn)
      .then(job.resolve, job.reject)
      .finally(() => {
        running -= 1;
        pump();
      });
  }
}
const waitingAhead = () => queue.length + Math.max(0, running - MAX_JOBS + 1);

// ───────────────────────── Daftar tool ─────────────────────────
// ───────────────────────── remove.bg ─────────────────────────
const removeBgKey = () => process.env.REMOVEBG_API_KEY || process.env.REMOVE_BG_API_KEY || '';
/** Batas pemakaian per member per hari (kredit remove.bg terbatas). Admin tanpa batas. 0 = tanpa batas. */
const REMOVEBG_DAILY = () => (process.env.REMOVEBG_DAILY_LIMIT === undefined ? 3 : Number(process.env.REMOVEBG_DAILY_LIMIT) || 0);
const USAGE_FILE = path.join(ROOT, 'data', 'tools-usage.json');
const todayKey = () => new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10); // tanggal WIB
function usage() {
  let u;
  try {
    u = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
  } catch {
    u = {};
  }
  if (u.date !== todayKey()) u = { date: todayKey(), removebg: {} };
  u.removebg = u.removebg || {};
  return u;
}
function addUsage(userId) {
  const u = usage();
  u.removebg[userId] = (u.removebg[userId] || 0) + 1;
  fs.mkdirSync(path.dirname(USAGE_FILE), { recursive: true });
  fs.writeFileSync(USAGE_FILE, JSON.stringify(u));
}
const usedToday = (userId) => usage().removebg[userId] || 0;

const DOC_EXT = ['doc', 'docx', 'odt', 'rtf', 'txt', 'xls', 'xlsx', 'ods', 'csv', 'ppt', 'pptx', 'odp'];
const IMG_EXT = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tiff', 'tif', 'heic', 'avif'];
const TOOLS = {
  office: { emoji: '📄', title: 'Word / Excel / PPT → PDF', short: 'Office → PDF', desc: 'Dokumen Word, Excel, PowerPoint jadi PDF rapi', needs: () => avail.soffice },
  pdfword: { emoji: '📝', title: 'PDF → Word', short: 'PDF → Word', desc: 'PDF jadi dokumen Word (.docx) yang bisa diedit', needs: () => avail.pdf2docx },
  merge: { emoji: '📑', title: 'Gabung PDF', short: 'Gabung PDF', desc: '2–10 PDF digabung jadi 1 file', needs: () => avail.pdflib },
  split: { emoji: '✂️', title: 'Pisah / Ambil Halaman PDF', short: 'Pisah PDF', desc: 'Ambil halaman tertentu atau pecah per halaman', needs: () => avail.pdflib && avail.jszip },
  pdfcompress: { emoji: '🗜️', title: 'Kompres PDF', short: 'Kompres PDF', desc: 'Perkecil ukuran PDF untuk dikirim via WA / email', needs: () => avail.gs || avail.pymupdf },
  pdfjpg: { emoji: '🖼️', title: 'PDF → Gambar (JPG)', short: 'PDF → JPG', desc: 'Setiap halaman PDF jadi gambar JPG', needs: () => avail.pdftoppm && avail.jszip },
  imgpdf: { emoji: '📸', title: 'Gambar → PDF', short: 'Gambar → PDF', desc: 'Foto / screenshot (maks 10) jadi 1 PDF', needs: () => avail.pdflib && avail.sharp },
  imgcompress: { emoji: '🗜️', title: 'Kompres Gambar', short: 'Kompres Gambar', desc: 'Ukuran gambar turun jauh, kualitas tetap bagus', needs: () => avail.sharp },
  imgconvert: { emoji: '🔄', title: 'Ubah Format Gambar', short: 'JPG ↔ PNG ↔ WEBP', desc: 'Ubah format JPG / PNG / WEBP (maks 10 gambar)', needs: () => avail.sharp },
  removebg: { emoji: '🪄', title: 'Hapus Background', short: 'Hapus Background', desc: 'Hapus latar foto otomatis (AI remove.bg)', needs: () => Boolean(removeBgKey()) },
};
const DOC_TOOLS = ['office', 'pdfword', 'merge', 'split', 'pdfcompress', 'pdfjpg'];
const IMG_TOOLS = ['removebg', 'imgpdf', 'imgcompress', 'imgconvert'];
const ready = (id) => Boolean(TOOLS[id]?.needs());

// ───────────────────────── Form (modal) ─────────────────────────
const upload = (label, desc, { min = 1, max = 1 } = {}) =>
  new LabelBuilder()
    .setLabel(label)
    .setDescription(desc.slice(0, 100))
    .setFileUploadComponent(new FileUploadBuilder().setCustomId('file').setMinValues(min).setMaxValues(max).setRequired(true));
const select = (id, label, options, desc) => {
  const l = new LabelBuilder().setLabel(label).setStringSelectMenuComponent(
    new StringSelectMenuBuilder()
      .setCustomId(id)
      .setRequired(true)
      .addOptions(options.map((o, i) => ({ ...o, default: o.default ?? i === 0 }))),
  );
  if (desc) l.setDescription(desc);
  return l;
};
const textIn = (id, label, { placeholder, required = false, desc, max = 100 } = {}) => {
  const l = new LabelBuilder().setLabel(label).setTextInputComponent(new TextInputBuilder().setCustomId(id).setStyle(TextInputStyle.Short).setPlaceholder(placeholder || '').setMaxLength(max).setRequired(required));
  if (desc) l.setDescription(desc);
  return l;
};

function buildModal(id) {
  const t = TOOLS[id];
  const m = new ModalBuilder().setCustomId(`bp:m:f:${id}`).setTitle(`${t.emoji} ${t.title}`.slice(0, 45));
  if (id === 'office') m.addLabelComponents(upload('File Word / Excel / PowerPoint', `.docx .doc .xlsx .xls .pptx .ppt .odt .rtf .txt • maks ${MAX_INPUT_MB} MB`));
  if (id === 'pdfword') m.addLabelComponents(upload('File PDF', `PDF berisi teks (bukan hasil scan) • maks ${MAX_INPUT_MB} MB`));
  if (id === 'merge') m.addLabelComponents(upload('File PDF (2–10 file)', 'Urutan gabung = urutan upload.', { min: 2, max: 10 }));
  if (id === 'split') {
    m.addLabelComponents(
      upload('File PDF', `Maks ${MAX_INPUT_MB} MB`),
      textIn('pages', 'Halaman', { placeholder: 'contoh: 1-3, 5, 8-10  (kosong = semua)', desc: 'Pisahkan dengan koma. Contoh 1-3, 5 = halaman 1, 2, 3 dan 5.' }),
      select('mode', 'Hasil', [
        { label: 'Ambil halaman → 1 PDF', value: 'one', emoji: '📄' },
        { label: 'Pecah per halaman → ZIP', value: 'each', emoji: '🗂️' },
      ]),
    );
  }
  if (id === 'pdfcompress') {
    m.addLabelComponents(
      upload('File PDF', `Maks ${MAX_INPUT_MB} MB`),
      select('level', 'Level Kompres', [
        { label: 'Sedang — seimbang (disarankan)', value: 'medium', emoji: '⚖️' },
        { label: 'Ringan — kualitas tinggi', value: 'light', emoji: '🪶' },
        { label: 'Kuat — ukuran paling kecil', value: 'strong', emoji: '💪' },
      ]),
    );
  }
  if (id === 'pdfjpg') {
    m.addLabelComponents(
      upload('File PDF', `Maks ${MAX_INPUT_MB} MB • maks 50 halaman`),
      textIn('pages', 'Halaman (opsional)', { placeholder: 'contoh: 1-5  (kosong = semua)' }),
      select('dpi', 'Kualitas Gambar', [
        { label: 'Sedang (150 DPI) — disarankan', value: '150', emoji: '⚖️' },
        { label: 'Tinggi (220 DPI)', value: '220', emoji: '✨' },
        { label: 'Rendah (100 DPI) — ukuran kecil', value: '100', emoji: '🪶' },
      ]),
    );
  }
  if (id === 'imgpdf') {
    m.addLabelComponents(
      upload('Gambar (1–10)', 'JPG / PNG / WEBP / HEIC. Urutan halaman = urutan upload.', { max: 10 }),
      select('size', 'Ukuran Halaman', [
        { label: 'A4 — rapi untuk dicetak', value: 'a4', emoji: '📄' },
        { label: 'Sesuai ukuran gambar', value: 'fit', emoji: '🖼️' },
      ]),
    );
  }
  if (id === 'imgcompress') {
    m.addLabelComponents(
      upload('Gambar (1–10)', 'JPG / PNG / WEBP. Format tetap sama.', { max: 10 }),
      select('level', 'Level Kompres', [
        { label: 'Sedang — seimbang (disarankan)', value: 'medium', emoji: '⚖️' },
        { label: 'Ringan — kualitas tinggi', value: 'light', emoji: '🪶' },
        { label: 'Kuat — ukuran paling kecil', value: 'strong', emoji: '💪' },
      ]),
    );
  }
  if (id === 'removebg') {
    m.addLabelComponents(
      upload('Foto', 'JPG / PNG / WEBP • orang, produk, hewan, mobil, dll. Maks 1 foto.', { max: 1 }),
      select('bg', 'Latar Hasil', [
        { label: 'Transparan (PNG)', value: 'transparent', emoji: '🧩' },
        { label: 'Putih', value: 'ffffff', emoji: '⬜' },
        { label: 'Hitam', value: '000000', emoji: '⬛' },
        { label: 'Biru (pas foto)', value: '1f4fbf', emoji: '🟦' },
        { label: 'Merah (pas foto)', value: 'c8102e', emoji: '🟥' },
      ]),
    );
  }
  if (id === 'imgconvert') {
    m.addLabelComponents(
      upload('Gambar (1–10)', 'JPG / PNG / WEBP / HEIC / GIF / BMP.', { max: 10 }),
      select('format', 'Ubah ke Format', [
        { label: 'JPG', value: 'jpg', emoji: '🖼️' },
        { label: 'PNG (transparan tetap)', value: 'png', emoji: '🧩' },
        { label: 'WEBP (paling kecil)', value: 'webp', emoji: '🌐' },
      ]),
    );
  }
  return m;
}

// ───────────────────────── Helper proses ─────────────────────────
function parsePages(raw, total) {
  const s = String(raw || '').trim();
  if (!s) return Array.from({ length: total }, (_, i) => i);
  const out = [];
  for (const part of s.split(/[,;\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) throw new Error(`Format halaman "${part}" tidak valid. Contoh: 1-3, 5`);
    let a = Number(m[1]);
    let b = Number(m[2] || m[1]);
    if (a > b) [a, b] = [b, a];
    for (let p = a; p <= b; p++) if (p >= 1 && p <= total && !out.includes(p - 1)) out.push(p - 1);
  }
  if (!out.length) throw new Error(`Halaman di luar jangkauan (PDF ini ${total} halaman).`);
  return out;
}

async function download(att, dir, i) {
  const res = await fetch(att.url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`Gagal mengunduh ${att.name} (HTTP ${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  const file = path.join(dir, `in-${i}.${extOf(att.name) || 'bin'}`);
  fs.writeFileSync(file, buf);
  return { file, name: att.name, size: buf.length, buf };
}

async function loadPdf(buf) {
  const { PDFDocument } = require('pdf-lib');
  try {
    return await PDFDocument.load(buf, { ignoreEncryption: false });
  } catch (e) {
    if (/encrypt/i.test(e.message)) throw new Error('PDF ini **terkunci password** — buka kuncinya dulu.');
    throw new Error('File PDF rusak / tidak bisa dibaca.');
  }
}

async function zipFiles(files, name) {
  const JSZip = require('jszip');
  const zip = new JSZip();
  for (const f of files) zip.file(f.name, f.buf);
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  return { name, buf };
}

const IMG_LEVEL = { light: 85, medium: 72, strong: 55 };

/** Jalankan tool. Return { outputs: [{ name, buf }], note }. */
async function process_(id, inputs, opts, dir) {
  const sharp = avail.sharp ? require('sharp') : null;
  const first = inputs[0];

  if (id === 'office') {
    if (!DOC_EXT.includes(extOf(first.name))) throw new Error('Format tidak didukung. Gunakan .docx / .doc / .xlsx / .xls / .pptx / .ppt / .odt / .rtf / .txt');
    const profile = path.join(dir, 'lo-profile');
    const job = officeBusy.then(() =>
      run(avail.soffice, [`-env:UserInstallation=file://${profile}`, '--headless', '--norestore', '--nolockcheck', '--convert-to', 'pdf', '--outdir', dir, first.file], { timeout: 180000, env: { HOME: dir } }),
    );
    officeBusy = job.catch(() => {});
    await job;
    const out = path.join(dir, `${path.basename(first.file, path.extname(first.file))}.pdf`);
    if (!fs.existsSync(out)) throw new Error('Konversi gagal — file mungkin rusak / terkunci password.');
    return { outputs: [{ name: `${base(first.name)}.pdf`, buf: fs.readFileSync(out) }] };
  }

  if (id === 'pdfword') {
    if (extOf(first.name) !== 'pdf') throw new Error('Upload file **PDF**.');
    const out = path.join(dir, 'out.docx');
    const script = 'import sys\nfrom pdf2docx import Converter\ncv = Converter(sys.argv[1])\ncv.convert(sys.argv[2])\ncv.close()';
    await run(pythonPath(), ['-c', script, first.file, out], { timeout: 240000 });
    if (!fs.existsSync(out)) throw new Error('Konversi gagal.');
    return { outputs: [{ name: `${base(first.name)}.docx`, buf: fs.readFileSync(out) }], note: 'PDF hasil **scan / foto** akan menjadi gambar di Word (teksnya tidak bisa diedit).' };
  }

  if (id === 'merge') {
    const { PDFDocument } = require('pdf-lib');
    if (inputs.some((x) => extOf(x.name) !== 'pdf')) throw new Error('Semua file harus **PDF**.');
    const outDoc = await PDFDocument.create();
    let pages = 0;
    for (const x of inputs) {
      const src = await loadPdf(x.buf);
      const copied = await outDoc.copyPages(src, src.getPageIndices());
      copied.forEach((pg) => outDoc.addPage(pg));
      pages += copied.length;
    }
    return { outputs: [{ name: `gabungan-${inputs.length}-pdf.pdf`, buf: Buffer.from(await outDoc.save()) }], note: `${inputs.length} file • ${pages} halaman` };
  }

  if (id === 'split') {
    const { PDFDocument } = require('pdf-lib');
    if (extOf(first.name) !== 'pdf') throw new Error('Upload file **PDF**.');
    const src = await loadPdf(first.buf);
    const idx = parsePages(opts.pages, src.getPageCount());
    if (opts.mode === 'each') {
      const files = [];
      for (const p of idx) {
        const d = await PDFDocument.create();
        const [pg] = await d.copyPages(src, [p]);
        d.addPage(pg);
        files.push({ name: `${base(first.name)}-hal-${p + 1}.pdf`, buf: Buffer.from(await d.save()) });
      }
      if (files.length === 1) return { outputs: files };
      return { outputs: [await zipFiles(files, `${base(first.name)}-per-halaman.zip`)], note: `${files.length} file PDF (1 per halaman) di dalam ZIP` };
    }
    const d = await PDFDocument.create();
    (await d.copyPages(src, idx)).forEach((pg) => d.addPage(pg));
    return { outputs: [{ name: `${base(first.name)}-hal-${opts.pages ? String(opts.pages).replace(/[^\d,-]/g, '').replace(/,/g, '_').slice(0, 30) || 'pilihan' : 'semua'}.pdf`, buf: Buffer.from(await d.save()) }], note: `${idx.length} dari ${src.getPageCount()} halaman` };
  }

  if (id === 'pdfcompress') {
    if (extOf(first.name) !== 'pdf') throw new Error('Upload file **PDF**.');
    const out = path.join(dir, 'out.pdf');
    if (avail.gs) {
      const preset = { light: '/printer', medium: '/ebook', strong: '/screen' }[opts.level] || '/ebook';
      await run('gs', ['-sDEVICE=pdfwrite', '-dCompatibilityLevel=1.5', `-dPDFSETTINGS=${preset}`, '-dNOPAUSE', '-dQUIET', '-dBATCH', '-dDetectDuplicateImages=true', `-sOutputFile=${out}`, first.file], { timeout: 240000 });
    } else {
      const q = { light: 85, medium: 70, strong: 50 }[opts.level] || 70;
      const dpi = { light: 200, medium: 150, strong: 100 }[opts.level] || 150;
      const script = [
        'import sys, fitz',
        'doc = fitz.open(sys.argv[1])',
        'try:',
        `    doc.rewrite_images(dpi_threshold=${dpi + 20}, dpi_target=${dpi}, quality=${q})`,
        'except Exception:',
        '    pass',
        'doc.save(sys.argv[2], garbage=4, deflate=True, clean=True)',
      ].join('\n');
      await run(pythonPath(), ['-c', script, first.file, out], { timeout: 240000 });
    }
    const buf = fs.readFileSync(out);
    if (buf.length >= first.size) return { outputs: [{ name: `${base(first.name)}.pdf`, buf: first.buf }], note: 'PDF ini **sudah optimal** — tidak bisa diperkecil lagi, file asli dikembalikan.' };
    return { outputs: [{ name: `${base(first.name)}-kompres.pdf`, buf }], note: `Hemat **${Math.round((1 - buf.length / first.size) * 100)}%**` };
  }

  if (id === 'pdfjpg') {
    if (extOf(first.name) !== 'pdf') throw new Error('Upload file **PDF**.');
    const total = (await loadPdf(first.buf)).getPageCount();
    const idx = parsePages(opts.pages, total).slice(0, 50);
    const dpi = String(Number(opts.dpi) || 150);
    const files = [];
    for (const p of idx) {
      const prefix = path.join(dir, `pg-${p + 1}`);
      await run('pdftoppm', ['-jpeg', '-jpegopt', 'quality=85', '-r', dpi, '-f', String(p + 1), '-l', String(p + 1), '-singlefile', first.file, prefix], { timeout: 60000 });
      files.push({ name: `${base(first.name)}-hal-${p + 1}.jpg`, buf: fs.readFileSync(`${prefix}.jpg`) });
    }
    const note = `${files.length} halaman${total > 50 && !opts.pages ? ` (maks 50 dari ${total})` : ''}`;
    if (files.length <= 10) return { outputs: files, note, images: true };
    return { outputs: [await zipFiles(files, `${base(first.name)}-jpg.zip`)], note: `${note} di dalam ZIP` };
  }

  if (id === 'imgpdf') {
    const { PDFDocument } = require('pdf-lib');
    const d = await PDFDocument.create();
    const A4 = [595.28, 841.89];
    for (const x of inputs) {
      let img;
      try {
        img = await sharp(x.buf, { failOn: 'none' }).rotate().flatten({ background: '#ffffff' }).jpeg({ quality: 88 }).toBuffer();
      } catch {
        throw new Error(`**${x.name}** bukan gambar yang valid.`);
      }
      const emb = await d.embedJpg(img);
      if (opts.size === 'fit') {
        const pg = d.addPage([emb.width, emb.height]);
        pg.drawImage(emb, { x: 0, y: 0, width: emb.width, height: emb.height });
      } else {
        const landscape = emb.width > emb.height;
        const [W, H] = landscape ? [A4[1], A4[0]] : A4;
        const margin = 24;
        const s = Math.min((W - margin * 2) / emb.width, (H - margin * 2) / emb.height);
        const pg = d.addPage([W, H]);
        pg.drawImage(emb, { x: (W - emb.width * s) / 2, y: (H - emb.height * s) / 2, width: emb.width * s, height: emb.height * s });
      }
    }
    return { outputs: [{ name: inputs.length === 1 ? `${base(first.name)}.pdf` : `gambar-${inputs.length}-halaman.pdf`, buf: Buffer.from(await d.save()) }], note: `${inputs.length} halaman` };
  }

  if (id === 'removebg') {
    if (!IMG_EXT.includes(extOf(first.name))) throw new Error('Upload file **gambar** (JPG / PNG / WEBP).');
    // remove.bg menerima JPG / PNG / WEBP → format lain diubah dulu ke JPG.
    let img = first.buf;
    let imgName = first.name;
    if (!['jpg', 'jpeg', 'png', 'webp'].includes(extOf(first.name)) && sharp) {
      img = await sharp(first.buf, { failOn: 'none' }).rotate().jpeg({ quality: 92 }).toBuffer();
      imgName = `${base(first.name)}.jpg`;
    }
    const transparent = opts.bg === 'transparent' || !/^[0-9a-f]{6}$/i.test(opts.bg || '');
    const form = new FormData();
    form.append('image_file', new Blob([img]), imgName);
    form.append('size', process.env.REMOVEBG_SIZE || 'auto');
    form.append('format', transparent ? 'png' : 'jpg');
    if (!transparent) form.append('bg_color', opts.bg);
    let res;
    try {
      res = await fetch('https://api.remove.bg/v1.0/removebg', { method: 'POST', headers: { 'X-Api-Key': removeBgKey() }, body: form, signal: AbortSignal.timeout(90000) });
    } catch (e) {
      throw new Error(`Server remove.bg tidak bisa dihubungi (${e?.cause?.code || e.message}). Coba lagi sebentar.`);
    }
    if (!res.ok) {
      let detail = '';
      try {
        const j = await res.json();
        detail = j?.errors?.[0]?.title || '';
      } catch {}
      if (res.status === 402) throw new Error('Kuota **remove.bg** server sudah habis bulan ini. Hubungi admin ya 🙏');
      if (res.status === 429) throw new Error('Terlalu banyak permintaan ke remove.bg — coba lagi 1 menit lagi.');
      if (res.status === 403) throw new Error('API key remove.bg ditolak — admin perlu cek `REMOVEBG_API_KEY` di .env.');
      if (/foreground/i.test(detail)) throw new Error('Objek utama di foto **tidak terdeteksi**. Coba foto yang objeknya lebih jelas.');
      throw new Error(`remove.bg menolak gambar ini${detail ? `: ${detail}` : ` (HTTP ${res.status})`}.`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const credits = res.headers.get('x-credits-charged');
    console.log(`[tools] remove.bg dipakai (${credits || '?'} kredit).`);
    return {
      outputs: [{ name: `${base(first.name)}-nobg.${transparent ? 'png' : 'jpg'}`, buf }],
      images: true,
      note: `Latar ${transparent ? '**transparan** (PNG)' : `warna \`#${opts.bg.toUpperCase()}\``}`,
    };
  }

  if (id === 'imgcompress' || id === 'imgconvert') {
    const outputs = [];
    let before = 0;
    let after = 0;
    for (const x of inputs) {
      let fmt = id === 'imgconvert' ? opts.format : { jpeg: 'jpg', jpg: 'jpg', png: 'png', webp: 'webp' }[extOf(x.name)] || 'jpg';
      const q = id === 'imgcompress' ? IMG_LEVEL[opts.level] || 72 : 90;
      let pipe;
      try {
        pipe = sharp(x.buf, { failOn: 'none', animated: false }).rotate();
        await pipe.metadata();
      } catch {
        throw new Error(`**${x.name}** bukan gambar yang valid.`);
      }
      if (fmt === 'jpg') pipe = pipe.flatten({ background: '#ffffff' }).jpeg({ quality: q, mozjpeg: true });
      else if (fmt === 'png') pipe = id === 'imgcompress' ? pipe.png({ palette: true, quality: q, compressionLevel: 9, effort: 8 }) : pipe.png({ compressionLevel: 9 });
      else pipe = pipe.webp({ quality: q, effort: 5 });
      let buf = await pipe.toBuffer();
      if (id === 'imgcompress' && buf.length >= x.size) buf = x.buf; // sudah optimal
      before += x.size;
      after += buf.length;
      outputs.push({ name: `${base(x.name)}${id === 'imgcompress' ? '-kompres' : ''}.${fmt}`, buf });
    }
    const note = id === 'imgcompress' ? `${mb(before)} → **${mb(after)}** (hemat ${Math.max(0, Math.round((1 - after / before) * 100))}%)` : `${inputs.length} gambar → **${opts.format.toUpperCase()}**`;
    return { outputs, note, images: true };
  }
  throw new Error('Tool tidak dikenal.');
}

// ───────────────────────── Jalankan dari form ─────────────────────────
const cooldown = new Map();
const busyUsers = new Set();
const uploadLimit = (guild) => ({ 2: 50, 3: 100 }[Number(guild?.premiumTier) || 0] || 10) * 1024 * 1024 - 256 * 1024;

/** Pesan status / error (Components V2 supaya bisa di-edit jadi hasil). */
const statusBox = (content) => ({ components: [UI.accent(new ContainerBuilder(), BRAND).addTextDisplayComponents(text(content))], flags: V2 });

async function onSubmit(i, id) {
  const t = TOOLS[id];
  if (!t) return;
  if (!ready(id)) return i.reply({ content: `🔧 **${t.title}** belum tersedia di server ini (program pendukung belum terpasang).`, flags: EPH });
  if (busyUsers.has(i.user.id)) return i.reply({ content: '⏳ File kamu sebelumnya masih diproses — tunggu sampai selesai ya.', flags: EPH });
  const wait = COOLDOWN_MS - (Date.now() - (cooldown.get(i.user.id) || 0));
  if (wait > 0) return i.reply({ content: `⏳ Tunggu **${Math.ceil(wait / 1000)} detik** lagi sebelum memakai tools.`, flags: EPH });
  const files = [...(i.fields.getUploadedFiles('file')?.values?.() || [])];
  if (!files.length) return i.reply({ content: '📎 Upload file terlebih dahulu.', flags: EPH });
  const big = files.find((f) => f.size > MAX_INPUT_MB * 1024 * 1024);
  if (big) return i.reply({ content: `❌ **${big.name}** terlalu besar (${mb(big.size)}). Maksimal **${MAX_INPUT_MB} MB** per file.`, flags: EPH });
  const get = (k) => {
    try {
      return i.fields.getTextInputValue(k);
    } catch {
      return '';
    }
  };
  const pick = (k, d) => {
    try {
      return i.fields.getStringSelectValues(k)?.[0] || d;
    } catch {
      return d;
    }
  };
  const opts = { pages: get('pages'), mode: pick('mode', 'one'), level: pick('level', 'medium'), dpi: pick('dpi', '150'), size: pick('size', 'a4'), format: pick('format', 'jpg'), bg: pick('bg', 'transparent') };
  // Hapus background: batas harian per member (admin tanpa batas).
  const admin = i.member?.permissions?.has?.('Administrator');
  if (id === 'removebg' && !admin && REMOVEBG_DAILY() > 0 && usedToday(i.user.id) >= REMOVEBG_DAILY()) {
    return i.reply({ content: `⏳ Jatah **Hapus Background** kamu hari ini sudah habis (**${REMOVEBG_DAILY()}x / hari**). Coba lagi besok ya!`, flags: EPH });
  }

  await i.deferReply({ flags: EPH });
  cooldown.set(i.user.id, Date.now());
  busyUsers.add(i.user.id);
  const ahead = waitingAhead();
  await i
    .editReply(statusBox(ahead > 0 ? `### ⏳ Masuk Antrean\nAda **${ahead}** proses di depanmu — hasil dikirim di sini otomatis.` : `### ⚙️ Sedang Memproses...\n${t.emoji} **${t.title}** • ${files.length} file — tunggu sebentar ya.`))
    .catch(() => {});

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noname-tools-'));
  const started = Date.now();
  try {
    const result = await enqueue(async () => {
      const inputs = [];
      for (const [n, f] of files.entries()) inputs.push(await download(f, dir, n));
      return { ...(await process_(id, inputs, opts, dir)), inputs };
    });
    if (id === 'removebg') {
      addUsage(i.user.id);
      if (!admin && REMOVEBG_DAILY() > 0) result.note = `${result.note} • sisa jatah hari ini **${Math.max(0, REMOVEBG_DAILY() - usedToday(i.user.id))}x**`;
    }
    const total = result.outputs.reduce((a, o) => a + o.buf.length, 0);
    const limit = uploadLimit(i.guild);
    if (total > limit) {
      return i.editReply(statusBox(`### ❌ File Hasil Terlalu Besar\nHasilnya **${mb(total)}** — melebihi batas kirim Discord (${mb(limit)}).${id === 'pdfjpg' ? ' Coba kualitas **Rendah** atau pilih lebih sedikit halaman.' : ' Coba kompres file terlebih dahulu.'}`));
    }
    const box = UI.accent(new ContainerBuilder(), BRAND);
    box.addTextDisplayComponents(text(`## ✅ ${t.emoji} ${t.title} — Selesai!\n-# Diproses dalam ${((Date.now() - started) / 1000).toFixed(1)} detik • hasil hanya terlihat olehmu`));
    const att = result.outputs.map((o) => new AttachmentBuilder(o.buf, { name: o.name }));
    if (result.images && result.outputs.length <= 10) {
      box.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(result.outputs.map((o) => new MediaGalleryItemBuilder().setURL(`attachment://${o.name}`))));
    }
    box.addSeparatorComponents(line());
    box.addTextDisplayComponents(
      text(
        [
          `📥 **Input:** ${result.inputs.length === 1 ? `\`${result.inputs[0].name.slice(0, 60)}\`` : `\`${result.inputs.length} file\``} • ${mb(result.inputs.reduce((a, x) => a + x.size, 0))}`,
          `📤 **Hasil:** ${result.outputs.length === 1 ? `\`${result.outputs[0].name.slice(0, 60)}\`` : `\`${result.outputs.length} file\``} • ${mb(total)}`,
          result.note ? `ℹ️ ${result.note}` : null,
        ]
          .filter(Boolean)
          .join('\n'),
      ),
    );
    if (!result.images) for (const o of result.outputs) box.addFileComponents(new FileBuilder().setURL(`attachment://${o.name}`));
    box.addSeparatorComponents(line());
    box.addTextDisplayComponents(text('-# 💾 Klik file / gambar → Download untuk menyimpan. File langsung dihapus dari server setelah dikirim. 🔒'));
    return i.editReply({ components: [box], files: att, flags: V2 });
  } catch (err) {
    console.warn(`[tools] ${id} gagal:`, err.message);
    const msg = /password|rusak|valid|Format|didukung|Upload|jangkauan|terkunci|remove\.bg|Kuota|Objek|Terlalu banyak|API key/i.test(err.message) ? err.message : `Proses gagal: ${String(err.message).split(' — ')[0].slice(0, 200)}`;
    return i.editReply(statusBox(`### ❌ Gagal\n${msg}`)).catch(() => {});
  } finally {
    busyUsers.delete(i.user.id);
    fs.rm(dir, { recursive: true, force: true }, () => {});
  }
}

module.exports = { TOOLS, DOC_TOOLS, IMG_TOOLS, ready, detect, buildModal, onSubmit, parsePages, process_ };
