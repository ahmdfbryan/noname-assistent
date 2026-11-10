const path = require('path');
const sharp = require('sharp');

/**
 * Bukti pengiriman Robux (gaya riwayat transaksi Roblox) — PNG, latar putih.
 *   [foto profil]  Sent Robux to ▒▒▒▒▒▒▒▒.                         - ⬡ 200
 * Username di-blur (sensor), jumlah Robux di ujung kanan.
 * Font: assets/fonts/Inter_600SemiBold.ttf (SIL OFL 1.1).
 */
let Canvas = null;
try {
  Canvas = require('@napi-rs/canvas');
  Canvas.GlobalFonts.registerFromPath(path.join(__dirname, '..', '..', 'assets', 'fonts', 'Inter_600SemiBold.ttf'), 'NInter600');
} catch {
  Canvas = null;
}

const W = 785;
const H = 112;
const S = 2; // resolusi 2x supaya tajam
const FONT = (px) => `${px * S}px NInter600, sans-serif`;
const INK = '#1f2124';

async function loadAvatar(url) {
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    return await Canvas.loadImage(Buffer.from(await res.arrayBuffer()));
  } catch {
    return null;
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Ikon Robux — meniru ikon asli: cincin segi enam tebal di luar, celah putih, segi enam gelap terisi,
 * dan kotak putih di tengah. Ujung runcing di atas, sudut sedikit membulat.
 * cx, cy = pusat, A = apotema (jarak pusat ke sisi) segi enam luar, dalam px sebelum skala.
 */
function hexFill(ctx, apothem, color, round) {
  const rc = (apothem - round) / Math.cos(Math.PI / 6); // jari-jari sudut jalur
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i - Math.PI / 2;
    const x = Math.cos(a) * rc;
    const y = Math.sin(a) * rc;
    if (i) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
  }
  ctx.closePath();
  ctx.lineJoin = 'round';
  ctx.lineWidth = round * 2;
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.fill();
  ctx.stroke();
}
function robuxIcon(ctx, cx, cy, A) {
  const DARK = '#393b3d';
  ctx.save();
  ctx.translate(cx * S, cy * S);
  ctx.scale(S, S);
  hexFill(ctx, A, DARK, A * 0.12); // cincin luar
  hexFill(ctx, A * 0.81, '#ffffff', A * 0.08); // celah putih
  hexFill(ctx, A * 0.675, DARK, A * 0.08); // segi enam dalam
  const q = A * 0.5; // kotak putih di tengah
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(-q / 2, -q / 2, q, q);
  ctx.restore();
}

/** Teks username → PNG, di-blur (sensor) → siap digambar ke kartu. */
async function blurredName(text, px) {
  const pad = 14;
  const m = Canvas.createCanvas(10, 10).getContext('2d');
  m.font = FONT(px);
  const w = Math.ceil(m.measureText(text).width / S);
  const c = Canvas.createCanvas((w + pad * 2) * S, (px + pad * 2) * S);
  const ctx = c.getContext('2d');
  ctx.font = FONT(px);
  ctx.fillStyle = INK;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, pad * S, (px / 2 + pad) * S);
  const blurred = await sharp(c.toBuffer('image/png')).blur(11).png().toBuffer();
  return { img: await Canvas.loadImage(blurred), w, pad };
}

/**
 * @param {{avatarUrl?:string, username:string, amount:number}} o
 * @returns {Promise<Buffer|null>} PNG, atau null kalau canvas tidak tersedia.
 */
async function robuxSentProof({ avatarUrl, username, amount, reveal = false }) {
  if (!Canvas) return null;
  const canvas = Canvas.createCanvas(W * S, H * S);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W * S, H * S);

  // Foto profil (kotak membulat)
  const ax = 28;
  const ay = (H - 64) / 2;
  ctx.save();
  roundRect(ctx, ax * S, ay * S, 64 * S, 64 * S, 10 * S);
  ctx.clip();
  ctx.fillStyle = '#e6e8eb';
  ctx.fillRect(ax * S, ay * S, 64 * S, 64 * S);
  const av = await loadAvatar(avatarUrl);
  if (av) ctx.drawImage(av, ax * S, ay * S, 64 * S, 64 * S);
  ctx.restore();

  // "Sent Robux to ▒▒▒▒."
  const px = 22;
  const tx = ax + 64 + 24;
  const cy = H / 2;
  ctx.font = FONT(px);
  ctx.fillStyle = INK;
  ctx.textBaseline = 'middle';
  const lead = 'Sent Robux to ';
  ctx.fillText(lead, tx * S, cy * S);
  const leadW = ctx.measureText(lead).width / S;
  if (reveal) {
    // Versi untuk pembeli: username tampil jelas (tanpa blur).
    const uname = String(username || 'Roblox');
    ctx.fillText(uname, (tx + leadW) * S, cy * S);
    ctx.fillText('.', (tx + leadW + ctx.measureText(uname).width / S) * S, cy * S);
  } else {
    const name = await blurredName(String(username || 'Roblox'), px);
    ctx.drawImage(name.img, (tx + leadW - name.pad) * S, (cy - px / 2 - name.pad) * S);
    ctx.fillText('.', (tx + leadW + name.w) * S, cy * S);
  }

  // "- ⬡ 200" di ujung kanan (tanda minus pendek, ikon, jumlah — rapat seperti contoh)
  const amt = Math.round(Number(amount) || 0).toLocaleString('en-US');
  ctx.font = FONT(24);
  const amtW = ctx.measureText(amt).width / S;
  const right = W - 32;
  ctx.fillStyle = INK;
  ctx.textBaseline = 'middle';
  ctx.fillText(amt, (right - amtW) * S, cy * S);
  const A = 12.5;
  const iconCx = right - amtW - 7 - A;
  robuxIcon(ctx, iconCx, cy, A);
  const dashRight = iconCx - A - 6;
  ctx.fillRect((dashRight - 8) * S, (cy - 1) * S, 8 * S, 2 * S);

  // garis tepi tipis supaya kartu putih tetap terlihat di tema gelap
  ctx.strokeStyle = '#e3e5e8';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, W * S - 2, H * S - 2);
  return canvas.toBuffer('image/png');
}

module.exports = { robuxSentProof };
