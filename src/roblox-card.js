/**
 * Kartu gambar premium untuk Log Pembelian Roblox (PNG, tema gelap).
 *   [gambar item]  PEMBELIAN BARU
 *                  Nama Item
 *                  (avatar) Display Name  @username
 *                  [ HARGA ⬡ 1.299 ]  [ KOMISI ⬡ 520 ]
 * Font: Inter (assets/fonts, SIL OFL 1.1). Kalau @napi-rs/canvas tidak ada → render() mengembalikan null
 * dan pemanggil memakai tampilan teks biasa.
 */
const path = require('path');

let Canvas = null;
try {
  Canvas = require('@napi-rs/canvas');
  const dir = path.join(__dirname, '..', 'assets', 'fonts');
  Canvas.GlobalFonts.registerFromPath(path.join(dir, 'Inter_600SemiBold.ttf'), 'RLInter600');
  Canvas.GlobalFonts.registerFromPath(path.join(dir, 'Inter_700Bold.ttf'), 'RLInter700');
} catch {
  Canvas = null;
}

const W = 960;
const S = 2;
const f6 = (px) => `${px * S}px RLInter600, sans-serif`;
const f7 = (px) => `${px * S}px RLInter700, sans-serif`;
const C = { bg1: '#1b1e29', bg2: '#0f1118', line: 'rgba(255,255,255,0.09)', tile: '#262a3a', text: '#ffffff', mute: '#8d95aa', green: '#3ee0a0', greenBg: 'rgba(62,224,160,0.12)', greenLine: 'rgba(62,224,160,0.38)', amber: '#ffc857' };

const num = (n) => Math.round(Number(n || 0)).toLocaleString('id-ID');

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo((x + r) * S, y * S);
  ctx.arcTo((x + w) * S, y * S, (x + w) * S, (y + h) * S, r * S);
  ctx.arcTo((x + w) * S, (y + h) * S, x * S, (y + h) * S, r * S);
  ctx.arcTo(x * S, (y + h) * S, x * S, y * S, r * S);
  ctx.arcTo(x * S, y * S, (x + w) * S, y * S, r * S);
  ctx.closePath();
}
const T = (ctx, str, x, y) => ctx.fillText(str, x * S, y * S);
const width = (ctx, str) => ctx.measureText(str).width / S;
function fit(ctx, str, maxW) {
  let s = String(str);
  if (width(ctx, s) <= maxW) return s;
  while (s.length > 1 && width(ctx, `${s}…`) > maxW) s = s.slice(0, -1);
  return `${s.trimEnd()}…`;
}
/** Bungkus teks maksimal `lines` baris. */
function wrap(ctx, str, maxW, lines) {
  const words = String(str).split(/\s+/);
  const out = [];
  let cur = '';
  for (let i = 0; i < words.length; i++) {
    const test = cur ? `${cur} ${words[i]}` : words[i];
    if (width(ctx, test) <= maxW || !cur) cur = test;
    else {
      out.push(cur);
      cur = words[i];
      if (out.length === lines - 1) {
        cur = words.slice(i).join(' ');
        break;
      }
    }
  }
  out.push(cur);
  return out.map((l, i) => (i === out.length - 1 ? fit(ctx, l, maxW) : l));
}

function hexFill(ctx, apothem, color, round) {
  const rc = (apothem - round) / Math.cos(Math.PI / 6);
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
/** Ikon Robux versi terang (untuk latar gelap). cx, cy = pusat, A = apotema luar. */
function robuxIcon(ctx, cx, cy, A, fg, bg) {
  ctx.save();
  ctx.translate(cx * S, cy * S);
  ctx.scale(S, S);
  hexFill(ctx, A, fg, A * 0.12);
  hexFill(ctx, A * 0.81, bg, A * 0.08);
  hexFill(ctx, A * 0.675, fg, A * 0.08);
  ctx.fillStyle = bg;
  const q = A * 0.34;
  ctx.fillRect(-q, -q, q * 2, q * 2);
  ctx.restore();
}

async function load(buf) {
  if (!buf) return null;
  try {
    return await Canvas.loadImage(buf);
  } catch {
    return null;
  }
}
function cover(ctx, img, x, y, w, h, r) {
  ctx.save();
  rr(ctx, x, y, w, h, r);
  ctx.clip();
  const k = Math.max(w / img.width, h / img.height);
  const dw = img.width * k;
  const dh = img.height * k;
  ctx.drawImage(img, (x + (w - dw) / 2) * S, (y + (h - dh) / 2) * S, dw * S, dh * S);
  ctx.restore();
}
function placeholder(ctx, x, y, w, h, r, letter) {
  const g = ctx.createLinearGradient(x * S, y * S, (x + w) * S, (y + h) * S);
  g.addColorStop(0, '#30364d');
  g.addColorStop(1, '#1f2333');
  ctx.fillStyle = g;
  rr(ctx, x, y, w, h, r);
  ctx.fill();
  ctx.fillStyle = C.mute;
  ctx.font = f7(Math.round(h * 0.4));
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  T(ctx, String(letter || '?').slice(0, 1).toUpperCase(), x + w / 2, y + h / 2 + 3);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}
function avatar(ctx, img, cx, cy, R, letter) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx * S, cy * S, R * S, 0, Math.PI * 2);
  ctx.clip();
  if (img) ctx.drawImage(img, (cx - R) * S, (cy - R) * S, R * 2 * S, R * 2 * S);
  else placeholder(ctx, cx - R, cy - R, R * 2, R * 2, R, letter);
  ctx.restore();
  ctx.beginPath();
  ctx.arc(cx * S, cy * S, R * S, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.16)';
  ctx.lineWidth = 2 * S;
  ctx.stroke();
}
function base(H) {
  const canvas = Canvas.createCanvas(W * S, H * S);
  const ctx = canvas.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, W * S, H * S);
  g.addColorStop(0, C.bg1);
  g.addColorStop(1, C.bg2);
  ctx.fillStyle = g;
  rr(ctx, 0, 0, W, H, 30);
  ctx.fill();
  // cahaya halus di pojok kanan atas
  const glow = ctx.createRadialGradient(W * S, 0, 0, W * S, 0, 460 * S);
  glow.addColorStop(0, 'rgba(62,224,160,0.13)');
  glow.addColorStop(1, 'rgba(62,224,160,0)');
  ctx.save();
  rr(ctx, 0, 0, W, H, 30);
  ctx.clip();
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W * S, H * S);
  ctx.restore();
  rr(ctx, 1, 1, W - 2, H - 2, 29);
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 2 * S;
  ctx.stroke();
  ctx.textBaseline = 'alphabetic';
  return { canvas, ctx };
}
function label(ctx, str, x, y, color = C.mute) {
  ctx.fillStyle = color;
  ctx.font = f7(15);
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${2 * S}px`;
  T(ctx, str.toUpperCase(), x, y);
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
}
function badge(ctx, str, rightX, y) {
  ctx.font = f7(14);
  const w = width(ctx, str) + 24;
  const x = rightX - w;
  ctx.fillStyle = 'rgba(255,200,87,0.14)';
  rr(ctx, x, y, w, 30, 15);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,200,87,0.45)';
  ctx.lineWidth = 1.5 * S;
  ctx.stroke();
  ctx.fillStyle = C.amber;
  T(ctx, str, x + 12, y + 20);
}
/** Kotak angka: label kecil + ikon Robux + nilai besar. */
function pill(ctx, x, y, w, h, title, value, tone) {
  const green = tone === 'green';
  ctx.fillStyle = green ? C.greenBg : 'rgba(255,255,255,0.05)';
  rr(ctx, x, y, w, h, 20);
  ctx.fill();
  ctx.strokeStyle = green ? C.greenLine : C.line;
  ctx.lineWidth = 1.5 * S;
  ctx.stroke();
  ctx.fillStyle = green ? C.green : C.mute;
  ctx.font = f7(14);
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${1.6 * S}px`;
  T(ctx, title.toUpperCase(), x + 22, y + 28);
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
  const fg = green ? C.green : '#ffffff';
  if (value === null) return;
  robuxIcon(ctx, x + 22 + 15, y + 56, 13, fg, green ? '#16352a' : '#1d2030');
  ctx.fillStyle = fg;
  ctx.font = f7(34);
  T(ctx, num(value), x + 22 + 38, y + 67);
}

/** Kartu pembelian. d: { itemImg, avatarImg (Buffer|null), itemName, displayName, username, price, commission, noCashback, hideCommission, studio, minCashback } */
async function renderPurchase(d) {
  if (!Canvas) return null;
  const H = 400;
  const { canvas, ctx } = base(H);
  const [itemImg, avImg] = await Promise.all([load(d.itemImg), load(d.avatarImg)]);
  // Gambar item
  ctx.fillStyle = C.tile;
  rr(ctx, 40, 40, 320, 320, 28);
  ctx.fill();
  if (itemImg) cover(ctx, itemImg, 40, 40, 320, 320, 28);
  else placeholder(ctx, 40, 40, 320, 320, 28, d.itemName);
  rr(ctx, 40, 40, 320, 320, 28);
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 2 * S;
  ctx.stroke();

  const X = 396;
  const R = W - 40;
  label(ctx, 'Pembelian Baru', X, 66);
  if (d.studio) badge(ctx, 'STUDIO TEST', R, 44);
  // Nama item (maks. 2 baris)
  ctx.fillStyle = C.text;
  ctx.font = f7(36);
  const lines = wrap(ctx, d.itemName, R - X, 2);
  lines.forEach((l, i) => T(ctx, l, X, 114 + i * 44));
  // Pembeli
  const by = lines.length > 1 ? 218 : 184;
  avatar(ctx, avImg, X + 26, by, 26, d.displayName);
  ctx.fillStyle = C.text;
  ctx.font = f7(23);
  T(ctx, fit(ctx, d.displayName, R - X - 76), X + 66, by - 2);
  ctx.fillStyle = C.mute;
  ctx.font = f6(17);
  T(ctx, fit(ctx, `@${d.username}`, R - X - 76), X + 66, by + 22);
  // Angka
  const py = 268;
  const ph = 92;
  if (d.hideCommission) {
    pill(ctx, X, py, R - X, ph, 'Harga', d.price);
  } else {
    const pw = (R - X - 18) / 2;
    pill(ctx, X, py, pw, ph, 'Harga', d.price);
    if (d.noCashback) {
      pill(ctx, X + pw + 18, py, pw, ph, 'Komisi', null);
      ctx.fillStyle = C.mute;
      ctx.font = f7(22);
      T(ctx, 'Tanpa cashback', X + pw + 18 + 22, py + 62);
      ctx.font = f6(13);
      T(ctx, `item di bawah ${d.minCashback} Robux`, X + pw + 18 + 22, py + 80);
    } else {
      pill(ctx, X + pw + 18, py, pw, ph, 'Komisi', d.commission, 'green');
    }
  }
  return canvas.toBuffer('image/png');
}

/** Kartu Roblox Plus. d: { avatarImg, displayName, username, studio } */
async function renderPlus(d) {
  if (!Canvas) return null;
  const H = 260;
  const { canvas, ctx } = base(H);
  const avImg = await load(d.avatarImg);
  avatar(ctx, avImg, 40 + 90, H / 2, 90, d.displayName);
  const X = 262;
  const R = W - 40;
  // bintang emas
  ctx.fillStyle = C.amber;
  ctx.beginPath();
  const sx = X + 11;
  const sy = 64;
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? 5 : 12;
    const a = (Math.PI / 5) * i - Math.PI / 2;
    const px = (sx + Math.cos(a) * r) * S;
    const py = (sy + Math.sin(a) * r) * S;
    if (i) ctx.lineTo(px, py);
    else ctx.moveTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
  label(ctx, 'Langganan Roblox Plus', X + 32, 69, C.amber);
  if (d.studio) badge(ctx, 'STUDIO TEST', R, 44);
  ctx.fillStyle = C.text;
  ctx.font = f7(44);
  T(ctx, fit(ctx, d.displayName, R - X), X, 140);
  ctx.fillStyle = C.mute;
  ctx.font = f6(22);
  T(ctx, fit(ctx, `@${d.username}`, R - X), X, 176);
  ctx.fillStyle = C.mute;
  ctx.font = f6(16);
  T(ctx, 'Member baru berlangganan Roblox Plus', X, 214);
  return canvas.toBuffer('image/png');
}

module.exports = { renderPurchase, renderPlus, available: () => Boolean(Canvas) };
