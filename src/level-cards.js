const path = require('path');

/**
 * 🎨 Kartu gambar Leveling — "Level Up!" & "Rank Card" (PNG, digambar dengan @napi-rs/canvas).
 * Font: assets/fonts (Poppins & Inter, lisensi SIL OFL 1.1 — gratis dipakai).
 * Kalau @napi-rs/canvas belum ter-install, fungsi mengembalikan null → leveling.js memakai tampilan teks biasa.
 */
let Canvas = null;
try {
  Canvas = require('@napi-rs/canvas');
  const dir = path.join(__dirname, '..', 'assets', 'fonts');
  const reg = (file, family) => {
    try {
      Canvas.GlobalFonts.registerFromPath(path.join(dir, file), family);
    } catch {}
  };
  reg('Poppins_800ExtraBold.ttf', 'NPoppins800');
  reg('Poppins_700Bold.ttf', 'NPoppins700');
  reg('Inter_600SemiBold.ttf', 'NInter600');
  reg('Inter_700Bold.ttf', 'NInter700');
} catch (e) {
  console.warn('[level-cards] @napi-rs/canvas belum ter-install — kartu level memakai teks biasa. Jalankan: npm install');
}

const W = 1000;
const H = 300;
const SCALE = 1.6; // resolusi gambar (1600 × 480) — tajam di HP & PC
const F = {
  head: (px) => `${px}px NPoppins800`,
  bold: (px) => `${px}px NPoppins700`,
  semi: (px) => `${px}px NInter600`,
  inter: (px) => `${px}px NInter700`,
};
const num = (n) => Math.round(Number(n) || 0).toLocaleString('id-ID');
/** Font kartu tidak punya emoji → buang emoji & simbol aneh dari teks (nama, gelar). */
const clean = (s) =>
  String(s || '')
    .replace(/<a?:\w+:\d+>/g, '')
    .replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}\u{20E3}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

// ───────────────────────── Helper gambar ─────────────────────────
function rr(ctx, x, y, w, h, r) {
  const k = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + k, y);
  ctx.arcTo(x + w, y, x + w, y + h, k);
  ctx.arcTo(x + w, y + h, x, y + h, k);
  ctx.arcTo(x, y + h, x, y, k);
  ctx.arcTo(x, y, x + w, y, k);
  ctx.closePath();
}
function hexagon(ctx, cx, cy, r) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i - Math.PI / 2;
    const x = cx + r * Math.cos(a);
    const y = cy + r * Math.sin(a);
    if (i) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
  }
  ctx.closePath();
}
function star4(ctx, cx, cy, r, color) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(cx, cy - r);
  ctx.quadraticCurveTo(cx + r * 0.18, cy - r * 0.18, cx + r, cy);
  ctx.quadraticCurveTo(cx + r * 0.18, cy + r * 0.18, cx, cy + r);
  ctx.quadraticCurveTo(cx - r * 0.18, cy + r * 0.18, cx - r, cy);
  ctx.quadraticCurveTo(cx - r * 0.18, cy - r * 0.18, cx, cy - r);
  ctx.fill();
  ctx.restore();
}
/** Tulis teks, kecilkan font kalau lebih lebar dari maxW (minimal minPx, lalu dipotong "…"). */
function fitText(ctx, txt, x, y, maxW, fontFn, px, minPx = 12) {
  let size = px;
  let s = String(txt);
  ctx.font = fontFn(size);
  while (ctx.measureText(s).width > maxW && size > minPx) {
    size -= 1;
    ctx.font = fontFn(size);
  }
  if (ctx.measureText(s).width > maxW) {
    while (s.length > 1 && ctx.measureText(`${s}…`).width > maxW) s = s.slice(0, -1);
    s = `${s.trimEnd()}…`;
  }
  ctx.fillText(s, x, y);
  return ctx.measureText(s).width;
}
function spaced(ctx, txt, x, y, spacing) {
  let cx = x;
  for (const ch of String(txt)) {
    ctx.fillText(ch, cx, y);
    cx += ctx.measureText(ch).width + spacing;
  }
  return cx - x - spacing;
}
function spacedWidth(ctx, txt, spacing) {
  return [...String(txt)].reduce((a, ch) => a + ctx.measureText(ch).width + spacing, 0) - spacing;
}
function dots(ctx, x0, y0, x1, y1, gap, color, radius = 1.4) {
  ctx.save();
  ctx.fillStyle = color;
  for (let x = x0; x <= x1; x += gap) {
    for (let y = y0; y <= y1; y += gap) {
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

async function loadAvatar(url) {
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    return await Canvas.loadImage(Buffer.from(await res.arrayBuffer()));
  } catch {
    return null;
  }
}

/** Foto profil bulat + cincin gradasi biru → kuning (seperti contoh). */
function avatarRing(ctx, img, cx, cy, r, initial, dark) {
  // cincin luar tipis
  ctx.save();
  ctx.strokeStyle = dark ? 'rgba(255,255,255,0.12)' : 'rgba(99,102,241,0.12)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, r + 20, 0, Math.PI * 2);
  ctx.stroke();
  // cincin gradasi
  const g = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
  g.addColorStop(0, '#3b82f6');
  g.addColorStop(0.5, '#22d3ee');
  g.addColorStop(1, '#f59e0b');
  ctx.strokeStyle = g;
  ctx.lineWidth = 9;
  ctx.beginPath();
  ctx.arc(cx, cy, r + 8, 0, Math.PI * 2);
  ctx.stroke();
  // foto
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  if (img) {
    // potong tengah (cover) supaya foto tidak gepeng
    const side = Math.min(img.width, img.height);
    ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, cx - r, cy - r, r * 2, r * 2);
  }
  else {
    const bg = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
    bg.addColorStop(0, '#6366f1');
    bg.addColorStop(1, '#3b82f6');
    ctx.fillStyle = bg;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    ctx.fillStyle = '#ffffff';
    ctx.font = F.head(r);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText((initial || '?').slice(0, 1).toUpperCase(), cx, cy + 4);
  }
  ctx.restore();
}

function canvas() {
  const c = Canvas.createCanvas(Math.round(W * SCALE), Math.round(H * SCALE));
  const ctx = c.getContext('2d');
  ctx.scale(SCALE, SCALE);
  ctx.textBaseline = 'alphabetic';
  return { c, ctx };
}

// ═════════════════════════════ LEVEL UP ═════════════════════════════
/**
 * @param {object} o { avatarUrl, name, from, to, current, need }
 * @returns {Promise<Buffer|null>} PNG
 */
async function renderLevelUp(o) {
  if (!Canvas) return null;
  const { c, ctx } = canvas();
  const avatar = await loadAvatar(o.avatarUrl);

  // Latar ungu gelap + kilau
  rr(ctx, 0, 0, W, H, 34);
  ctx.save();
  ctx.clip();
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#2a2275');
  bg.addColorStop(0.55, '#33278a');
  bg.addColorStop(1, '#1d1a5c');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  dots(ctx, 14, 14, W, H, 24, 'rgba(255,255,255,0.06)');
  const glow = ctx.createRadialGradient(165, 150, 20, 165, 150, 230);
  glow.addColorStop(0, 'rgba(99,102,241,0.55)');
  glow.addColorStop(1, 'rgba(99,102,241,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, 420, H);
  ctx.fillStyle = 'rgba(255,255,255,0.04)';
  ctx.beginPath();
  ctx.arc(150, 150, 170, 0, Math.PI * 2);
  ctx.fill();
  // watermark "N"
  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  ctx.font = F.head(230);
  ctx.textAlign = 'right';
  ctx.fillText('N', 1000, 300);
  ctx.textAlign = 'left';
  // konfeti
  const conf = [
    [585, 30, '#f59e0b', 0.5],
    [770, 26, '#ec4899', -0.4],
    [905, 42, '#f59e0b', 0.9],
    [960, 120, '#a78bfa', 0.2],
    [985, 168, '#ec4899', -0.7],
    [612, 252, '#f59e0b', 0.6],
    [455, 268, '#22d3ee', -0.3],
    [880, 284, '#a78bfa', 1.1],
    [640, 66, '#22d3ee', 0.8],
  ];
  for (const [x, y, col, rot] of conf) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.fillStyle = col;
    ctx.globalAlpha = 0.8;
    rr(ctx, -6, -3, 12, 6, 2);
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();

  // Foto + badge level baru
  avatarRing(ctx, avatar, 165, 150, 92, o.name, true);
  const bx = 238;
  const by = 220;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = 10;
  const bgBadge = ctx.createLinearGradient(bx - 28, by - 28, bx + 28, by + 28);
  bgBadge.addColorStop(0, '#fbbf24');
  bgBadge.addColorStop(1, '#f97316');
  ctx.fillStyle = bgBadge;
  ctx.beginPath();
  ctx.arc(bx, by, 28, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = '#1d1a5c';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(bx, by, 28, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = '#1f1147';
  ctx.textAlign = 'center';
  fitText(ctx, String(o.to), bx, by + 8, 44, F.head, 24, 12);
  ctx.textAlign = 'left';

  // Judul "LEVEL UP!"
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowOffsetY = 4;
  ctx.shadowBlur = 6;
  const tg = ctx.createLinearGradient(0, 40, 0, 110);
  tg.addColorStop(0, '#fcd34d');
  tg.addColorStop(1, '#f97316');
  ctx.fillStyle = tg;
  ctx.font = F.head(74);
  ctx.fillText('LEVEL UP!', 298, 108);
  ctx.restore();
  // bintang kilau
  star4(ctx, 735, 52, 20, '#fde68a');
  star4(ctx, 770, 92, 9, '#ffffff');

  // Subjudul
  ctx.fillStyle = '#ffffff';
  fitText(ctx, `Selamat ${clean(o.name) || 'Member'}, kamu naik ke level baru!`, 300, 150, 620, F.inter, 23, 15);

  // Level lama → level baru
  hexagon(ctx, 362, 222, 42);
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.16)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = 'rgba(224,231,255,0.85)';
  ctx.textAlign = 'center';
  fitText(ctx, String(o.from), 362, 233, 64, F.bold, 32, 14);
  ctx.textAlign = 'left';
  // panah
  ctx.strokeStyle = '#facc15';
  ctx.fillStyle = '#facc15';
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(420, 222);
  ctx.lineTo(492, 222);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(502, 222);
  ctx.lineTo(486, 211);
  ctx.lineTo(486, 233);
  ctx.closePath();
  ctx.fill();
  // heksagon level baru
  ctx.save();
  ctx.shadowColor = 'rgba(249,115,22,0.55)';
  ctx.shadowBlur = 22;
  hexagon(ctx, 560, 222, 54);
  const hg = ctx.createLinearGradient(510, 170, 610, 275);
  hg.addColorStop(0, '#fbbf24');
  hg.addColorStop(1, '#f97316');
  ctx.fillStyle = hg;
  ctx.fill();
  ctx.restore();
  hexagon(ctx, 560, 222, 54);
  ctx.strokeStyle = '#fff7ed';
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.fillStyle = '#1f1147';
  ctx.textAlign = 'center';
  fitText(ctx, String(o.to), 560, 236, 80, F.head, 40, 16);
  ctx.textAlign = 'left';

  // Kotak "NEXT LEVEL"
  rr(ctx, 650, 182, 318, 82, 18);
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.2)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = '#a5b4fc';
  ctx.font = F.inter(14);
  spaced(ctx, 'NEXT LEVEL', 674, 212, 2.5);
  ctx.fillStyle = '#ffffff';
  fitText(ctx, `${num(o.current)} / ${num(o.need)} XP · Terus aktif!`, 674, 246, 278, F.inter, 21, 13);

  return c.encode('png');
}

// ═════════════════════════════ RANK CARD ═════════════════════════════
function icon(ctx, kind, x, y, color) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  if (kind === 'chat') {
    rr(ctx, x, y, 26, 19, 5);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x + 5, y + 17);
    ctx.lineTo(x + 4, y + 25);
    ctx.lineTo(x + 12, y + 18);
    ctx.closePath();
    ctx.fill();
  } else if (kind === 'mic') {
    rr(ctx, x + 8, y, 11, 17, 5.5);
    ctx.fill();
    ctx.lineWidth = 2.6;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(x + 13.5, y + 10, 9, 0.1 * Math.PI, 0.9 * Math.PI);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x + 13.5, y + 19);
    ctx.lineTo(x + 13.5, y + 25);
    ctx.stroke();
  } else if (kind === 'crown') {
    ctx.beginPath();
    ctx.moveTo(x, y + 6);
    ctx.lineTo(x + 7, y + 13);
    ctx.lineTo(x + 13.5, y + 2);
    ctx.lineTo(x + 20, y + 13);
    ctx.lineTo(x + 27, y + 6);
    ctx.lineTo(x + 24, y + 21);
    ctx.lineTo(x + 3, y + 21);
    ctx.closePath();
    ctx.fill();
    rr(ctx, x + 3, y + 22, 21, 3.5, 1.5);
    ctx.fill();
  }
  ctx.restore();
}

/**
 * @param {object} o { avatarUrl, name, username, server, tag, tagBadgeUrl, rank, level, current, need, pct, messages, voice, tier, status }
 * status: 'online' | 'idle' | 'dnd' | 'offline' | null (null = tidak ditampilkan)
 * @returns {Promise<Buffer|null>} PNG
 */
async function renderRankCard(o) {
  if (!Canvas) return null;
  const { c, ctx } = canvas();
  const [avatar, tagBadge] = await Promise.all([loadAvatar(o.avatarUrl), o.tag ? loadAvatar(o.tagBadgeUrl) : null]);

  // Latar putih + pola titik + watermark
  rr(ctx, 1, 1, W - 2, H - 2, 32);
  ctx.save();
  ctx.clip();
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  dots(ctx, 640, 14, W, 150, 18, 'rgba(165,180,252,0.45)', 1.5);
  ctx.fillStyle = 'rgba(245,158,11,0.07)';
  ctx.font = F.head(240);
  ctx.textAlign = 'right';
  ctx.fillText('N', 1010, 330);
  ctx.textAlign = 'left';
  // aksen kiri
  const ag = ctx.createLinearGradient(0, 40, 0, 260);
  ag.addColorStop(0, '#6366f1');
  ag.addColorStop(1, '#3b82f6');
  ctx.fillStyle = ag;
  rr(ctx, -6, 44, 14, 212, 6);
  ctx.fill();
  ctx.restore();
  rr(ctx, 1, 1, W - 2, H - 2, 32);
  ctx.strokeStyle = '#e5e7eb';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Foto + status
  avatarRing(ctx, avatar, 158, 150, 90, o.name, false);
  const stColor = { online: '#22c55e', idle: '#f59e0b', dnd: '#ef4444', offline: '#9ca3af' }[o.status];
  if (stColor) {
    ctx.fillStyle = stColor;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(228, 220, 15, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  // Rank & level (kanan atas)
  const right = 962;
  ctx.textAlign = 'left';
  ctx.font = F.head(42);
  const lvTxt = String(o.level);
  const rankTxt = o.rank ? `#${num(o.rank)}` : '#-';
  const lvW = ctx.measureText(lvTxt).width;
  const rkW = ctx.measureText(rankTxt).width;
  ctx.font = F.inter(14);
  const lvLabW = spacedWidth(ctx, 'LEVEL', 2.5);
  const rkLabW = spacedWidth(ctx, 'RANK', 2.5);
  let x = right - (rkLabW + 8 + rkW + 16 + lvLabW + 8 + lvW);
  ctx.fillStyle = '#9ca3af';
  spaced(ctx, 'RANK', x, 62, 2.5);
  x += rkLabW + 8;
  ctx.fillStyle = '#1e1b4b';
  ctx.font = F.head(42);
  ctx.fillText(rankTxt, x, 68);
  x += rkW + 16;
  ctx.font = F.inter(14);
  ctx.fillStyle = '#9ca3af';
  spaced(ctx, 'LEVEL', x, 62, 2.5);
  x += lvLabW + 8;
  ctx.font = F.head(42);
  ctx.fillStyle = '#f59e0b';
  ctx.fillText(lvTxt, x, 68);

  // Nama + server tag
  const left = 292;
  const nameMax = right - left - (o.tag ? 130 : 0);
  ctx.fillStyle = '#1e1b4b';
  const nameW = fitText(ctx, clean(o.name) || o.username, left, 112, nameMax, F.head, 44, 24);
  if (o.tag) {
    const tagTxt = clean(o.tag).slice(0, 4).toUpperCase();
    ctx.font = F.inter(16);
    const tw = ctx.measureText(tagTxt).width;
    const bw = tw + (tagBadge ? 46 : 26);
    const tx = left + nameW + 16;
    rr(ctx, tx, 84, bw, 32, 9);
    ctx.fillStyle = '#1e1b4b';
    ctx.fill();
    if (tagBadge) ctx.drawImage(tagBadge, tx + 10, 90, 20, 20);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(tagTxt, tx + (tagBadge ? 36 : 13), 106);
  }
  ctx.fillStyle = '#6b7280';
  fitText(ctx, `@${o.username} · ${clean(o.server)}`, left, 145, 660, F.semi, 19, 13);

  // Progres
  const barX = left;
  const barW = right - left;
  ctx.fillStyle = '#6366f1';
  ctx.font = F.inter(15);
  spaced(ctx, `PROGRESS ${o.pct}%`, barX, 179, 1.2);
  ctx.textAlign = 'right';
  ctx.font = F.inter(18);
  const needTxt = `/ ${num(o.need)} XP`;
  ctx.fillStyle = '#9ca3af';
  ctx.fillText(needTxt, right, 179);
  const nw = ctx.measureText(needTxt).width;
  ctx.fillStyle = '#1e1b4b';
  ctx.fillText(`${num(o.current)} `, right - nw, 179);
  ctx.textAlign = 'left';
  const barY = 190;
  const barH = 24;
  rr(ctx, barX, barY, barW, barH, barH / 2);
  ctx.fillStyle = '#eef2ff';
  ctx.fill();
  // isi bar sampai tengah kenop (kenop menutup ujungnya, rapi juga saat progres masih kecil)
  const kx = Math.min(Math.max(barX + Math.round((barW * Math.min(100, Math.max(0, o.pct))) / 100), barX + 17), right - 17);
  const fillW = kx - barX;
  ctx.save();
  if (fillW > 22) rr(ctx, barX, barY, fillW, barH, barH / 2);
  else ctx.rect(0, 0, 0, 0); // progres masih sangat kecil → cukup kenop saja
  ctx.clip();
  const pg = ctx.createLinearGradient(barX, 0, barX + fillW, 0); // ujung isi selalu oranye (seperti contoh)
  pg.addColorStop(0, '#4f46e5');
  pg.addColorStop(0.4, '#3b82f6');
  pg.addColorStop(0.7, '#22d3ee');
  pg.addColorStop(1, '#f59e0b');
  ctx.fillStyle = pg;
  ctx.fillRect(barX, barY, fillW, barH);
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 7;
  for (let sx = barX - barH; sx < barX + fillW + barH; sx += 18) {
    ctx.beginPath();
    ctx.moveTo(sx, barY + barH);
    ctx.lineTo(sx + barH, barY);
    ctx.stroke();
  }
  ctx.restore();
  // kenop
  const ky = barY + barH / 2;
  ctx.save();
  ctx.shadowColor = 'rgba(245,158,11,0.5)';
  ctx.shadowBlur = 10;
  const kg = ctx.createLinearGradient(kx - 17, ky - 17, kx + 17, ky + 17);
  kg.addColorStop(0, '#fbbf24');
  kg.addColorStop(1, '#f97316');
  ctx.fillStyle = kg;
  ctx.beginPath();
  ctx.arc(kx, ky, 17, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(kx, ky, 17, 0, Math.PI * 2);
  ctx.stroke();
  star4(ctx, kx, ky, 8, '#ffffff');

  // Statistik (3 kotak)
  const pills = [
    ['chat', 'Pesan', num(o.messages), '#6366f1'],
    ['mic', 'Voice', o.voice, '#6366f1'],
    ['crown', 'Tier', clean(o.tier) || '-', '#f59e0b'],
  ];
  const gap = 14;
  const pw = (barW - gap * 2) / 3;
  pills.forEach(([ic, label, value, col], i) => {
    const px = barX + i * (pw + gap);
    const py = 232;
    rr(ctx, px, py, pw, 48, 14);
    ctx.fillStyle = '#f5f7ff';
    ctx.fill();
    ctx.strokeStyle = '#e0e7ff';
    ctx.lineWidth = 2;
    ctx.stroke();
    icon(ctx, ic, px + 14, py + 11, col);
    ctx.fillStyle = '#4b5563';
    ctx.font = F.semi(16);
    ctx.fillText(label, px + 50, py + 30);
    const labW = ctx.measureText(label).width;
    ctx.fillStyle = '#1e1b4b';
    ctx.textAlign = 'right';
    fitText(ctx, value, px + pw - 14, py + 31, pw - 50 - labW - 26, F.inter, 18, 11);
    ctx.textAlign = 'left';
  });

  return c.encode('png');
}

module.exports = { renderLevelUp, renderRankCard, available: () => Boolean(Canvas), clean };
