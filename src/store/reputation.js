const {
  MessageFlags,
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const UI = require('../ui');
const { color, rupiah, num, GROUPS, getProduct } = require('./config');
const { state, kindOf } = require('./state');

/**
 * Store Reputation (Components V2) — 1 pesan yang ter-update otomatis:
 * skor rating, distribusi bintang, badge kepercayaan, statistik toko, rating per produk & feedback terbaru.
 * Pengaturan teks di store.json → "reputation" (opsional).
 */
const fill = (t, v) => String(t || '').replace(/\{server\}/g, v.server).replace(/\{name\}/g, v.name);
const text = (c) => new TextDisplayBuilder().setContent(String(c).slice(0, 4000));
const line = (big = false) => new SeparatorBuilder().setDivider(true).setSpacing(big ? SeparatorSpacingSize.Large : SeparatorSpacingSize.Small);
const tsR = (ms) => `<t:${Math.floor(ms / 1000)}:R>`;

const BADGES = [
  { min: 4.8, reviews: 50, label: '💎 Diamond Trusted Seller', note: 'Reputasi luar biasa & sangat terpercaya' },
  { min: 4.6, reviews: 20, label: '🏆 Gold Trusted Seller', note: 'Reputasi sangat baik & konsisten' },
  { min: 4.3, reviews: 5, label: '🥈 Silver Trusted Seller', note: 'Reputasi baik & terpercaya' },
  { min: 0, reviews: 0, label: '🌱 Rising Seller', note: 'Toko sedang berkembang — terima kasih atas dukunganmu!' },
];

/** Bintang dengan setengah bintang (contoh 4.6 → ★★★★½). */
function starText(avg) {
  if (!avg) return '☆☆☆☆☆';
  const full = Math.floor(avg + 0.25);
  const half = avg - full >= 0.25 && avg - full < 0.75 && full < 5;
  return '⭐'.repeat(Math.min(5, full)) + (half ? '✨' : '') + '☆'.repeat(Math.max(0, 5 - full - (half ? 1 : 0)));
}
const bar = (pct, size = 10) => {
  const f = Math.round((pct / 100) * size);
  return '🟦'.repeat(f) + '⬛'.repeat(size - f);
};
function avgDuration(list) {
  if (!list.length) return '-';
  const ms = list.reduce((a, t) => a + (t.closedAt - t.createdAt), 0) / list.length;
  const m = Math.max(1, Math.round(ms / 60000));
  if (m < 60) return `${m} menit`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} jam ${m % 60} menit` : `${Math.floor(h / 24)} hari ${h % 24} jam`;
}
const quote = (s, max = 180) => {
  const c = String(s || '').replace(/\s+/g, ' ').trim();
  return `> ${c.length > max ? `${c.slice(0, max - 1)}…` : c}`;
};

function computeReputation(cfg) {
  const tickets = Object.values(state.tickets || {});
  const reviews = tickets.filter((t) => t.testimony?.rating).sort((a, b) => (b.testimony.at || 0) - (a.testimony.at || 0));
  const dist = [0, 0, 0, 0, 0, 0];
  for (const t of reviews) dist[Math.min(5, Math.max(1, t.testimony.rating))] += 1;
  // Rating utama memakai statistik toko (termasuk ulasan lama yang ticketnya sudah tidak tersimpan).
  const count = state.stats.ratingCount || reviews.length;
  const sum = state.stats.ratingCount ? state.stats.ratingSum : reviews.reduce((a, t) => a + t.testimony.rating, 0);
  const avg = count ? sum / count : 0;
  const positive = reviews.length ? Math.round(((dist[4] + dist[5]) / reviews.length) * 100) : 0;
  const closed = tickets.filter((t) => ['completed', 'cancelled', 'refund'].includes(t.status));
  const completed = closed.filter((t) => t.status === 'completed');
  const success = closed.length ? Math.round((completed.length / closed.length) * 100) : 100;
  const last30 = completed.filter((t) => t.closedAt > Date.now() - 30 * 86400000).length;
  const badge = BADGES.find((b) => avg >= b.min && count >= b.reviews) || BADGES.at(-1);

  // Rating per produk.
  const perProduct = new Map();
  for (const t of reviews) {
    const key = t.productId || kindOf(t);
    const p = perProduct.get(key) || { label: t.productLabel || getProduct(cfg, t.productId)?.label || key, emoji: getProduct(cfg, t.productId)?.emoji || '🛒', sum: 0, n: 0 };
    p.sum += t.testimony.rating;
    p.n += 1;
    perProduct.set(key, p);
  }
  return { reviews, dist, count, avg, positive, closed, completed, success, last30, badge, perProduct: [...perProduct.values()].sort((a, b) => b.n - a.n) };
}

function buildReputation(guild, cfg) {
  const rc = cfg.reputation || {};
  const name = cfg.storeName || guild.name;
  const r = computeReputation(cfg);
  const s = state.stats;
  const box = UI.accent(new ContainerBuilder(), color(cfg, 'brand', 0x3498db));

  // ── Header
  const header = `# ${fill(rc.title || '⭐ Reputasi Toko | {server}', { server: guild.name, name })}\n-# ${fill(rc.subtitle || '{name} • Store Reputation', { server: guild.name, name })}`;
  const icon = guild.iconURL({ extension: 'png', size: 256 });
  if (icon) box.addSectionComponents(new SectionBuilder().addTextDisplayComponents(text(header)).setThumbnailAccessory(new ThumbnailBuilder().setURL(icon)));
  else box.addTextDisplayComponents(text(header));
  if (rc.bannerImage) box.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(rc.bannerImage)));
  if (rc.description) {
    box.addSeparatorComponents(line());
    box.addTextDisplayComponents(text(fill(rc.description, { server: guild.name, name })));
  }

  // ── Skor utama
  box.addSeparatorComponents(line());
  box.addTextDisplayComponents(
    text(
      r.count
        ? [
            `## ${starText(r.avg)}  ${r.avg.toFixed(1)} / 5.0`,
            `Berdasarkan **${num(r.count)} ulasan** pembeli asli • **${r.positive}%** pembeli puas`,
            `### ${r.badge.label}`,
            `-# ${r.badge.note}`,
          ].join('\n')
        : ['## ☆☆☆☆☆  - / 5.0', 'Belum ada ulasan. Jadilah pembeli pertama yang memberi testimoni! ✨', `### ${r.badge.label}`, `-# ${r.badge.note}`].join('\n'),
    ),
  );

  // ── Distribusi bintang
  if (r.reviews.length) {
    const total = r.reviews.length;
    const rows = [5, 4, 3, 2, 1].map((n) => {
      const pct = Math.round((r.dist[n] / total) * 100);
      return `\`${n} ⭐\` ${bar(pct)} \`${String(pct).padStart(3, ' ')}%\` • ${num(r.dist[n])}`;
    });
    box.addSeparatorComponents(line());
    box.addTextDisplayComponents(text(`### 📊 Distribusi Rating\n${rows.join('\n')}`));
  }

  // ── Statistik toko
  const buyers = Object.keys(state.spenders || {}).length;
  box.addSeparatorComponents(line());
  box.addTextDisplayComponents(
    text(
      [
        '### 📈 Statistik Toko',
        `**🧾 Transaksi Sukses:** \`${num(s.transactions)}\` • **📅 30 Hari:** \`${num(r.last30)}\``,
        `**✅ Tingkat Keberhasilan:** \`${r.success}%\` ${bar(r.success, 8)}`,
        `**👥 Pembeli Puas:** \`${num(buyers)} pembeli\` • **💬 Testimoni:** \`${num(s.testimonies || r.count)}\``,
        `**💎 Robux Terkirim:** \`${num(s.robux)} Robux\``,
        s.rekber ? `**🤝 Rekber Sukses:** \`${num(s.rekber)}\` • **🛡️ Dana Diamankan:** \`${rupiah(s.rekberVolume)}\`` : null,
        `**⚡ Rata-rata Proses:** \`${avgDuration(r.completed)}\``,
      ]
        .filter(Boolean)
        .join('\n'),
    ),
  );

  // ── Rating per produk
  if (r.perProduct.length) {
    box.addSeparatorComponents(line());
    box.addTextDisplayComponents(
      text(
        `### 🛒 Rating per Produk\n${r.perProduct
          .slice(0, 8)
          .map((p) => `${p.emoji} **${p.label}** — ⭐ \`${(p.sum / p.n).toFixed(1)}\` • ${num(p.n)} ulasan`)
          .join('\n')}`,
      ),
    );
  }

  // ── Feedback terbaru
  const showBuyer = cfg.publicLog?.showBuyer !== false;
  const latest = r.reviews.slice(0, Math.min(8, Math.max(1, Number(rc.latestCount) || 5)));
  box.addSeparatorComponents(line());
  box.addTextDisplayComponents(
    text(
      latest.length
        ? `### 💬 Feedback Terbaru\n${latest
            .map((t) => {
              const uid = kindOf(t) === 'rekber' ? t.buyerId : t.userId;
              const who = showBuyer && uid ? `<@${uid}>` : '`Pembeli`';
              return `${'⭐'.repeat(t.testimony.rating)} • ${who} • **${t.productLabel || 'Order'}** • ${tsR(t.testimony.at || t.closedAt)}\n${quote(t.testimony.comment)}`;
            })
            .join('\n\n')}`
        : '### 💬 Feedback Terbaru\n_Belum ada feedback. Feedback pembeli akan muncul di sini secara otomatis._',
    ),
  );

  // ── Footer + tombol
  box.addSeparatorComponents(line());
  box.addTextDisplayComponents(
    text(`${rc.tip ? `-# ${rc.tip}\n` : ''}-# ${name} • Diperbarui <t:${Math.floor(Date.now() / 1000)}:R>`),
  );
  const buttons = [];
  const testi = cfg.channels?.testimoni;
  if (/^\d{17,20}$/.test(String(testi || ''))) {
    buttons.push(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Lihat Semua Testimoni').setEmoji('💬').setURL(`https://discord.com/channels/${guild.id}/${testi}`));
  }
  const panel = state[GROUPS.main.panelKey];
  if (panel) buttons.push(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Order Sekarang').setEmoji('🛒').setURL(`https://discord.com/channels/${guild.id}/${panel.channelId}/${panel.messageId}`));
  if (buttons.length) box.addActionRowComponents(new ActionRowBuilder().addComponents(buttons));

  return { components: [box], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } };
}

module.exports = { buildReputation, computeReputation };
