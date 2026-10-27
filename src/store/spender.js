const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { loadConfig, color, rupiah, num, isId } = require('./config');
const { state } = require('./state');

/**
 * Role Spender: Buyer (order pertama) → diganti tier sesuai total belanja (order Completed), seperti role level.
 * Pengaturan di store.json → spenderRoles. Member hanya memegang 1 role (tier tertinggi yang dicapai),
 * kecuali keepLowerTiers / keepBuyerRole = true. Rekber tidak dihitung sebagai belanja.
 */
const settings = (cfg = loadConfig()) => cfg?.spenderRoles || {};
const tiers = (cfg) =>
  (settings(cfg).tiers || []).filter((x) => x && Number(x.min) > 0).sort((a, b) => a.min - b.min);

const spentOf = (userId) => state.spenders[userId] || { revenue: 0, orders: 0, robux: 0 };
function tierFor(revenue, cfg) {
  return tiers(cfg).filter((x) => revenue >= x.min).at(-1) || null;
}
function nextTierFor(revenue, cfg) {
  return tiers(cfg).find((x) => revenue < x.min) || null;
}
const tierLabel = (t) => (t ? `${t.emoji || '🏅'} ${t.name}` : '—');

function progressBar(ratio, size = 12) {
  const filled = Math.max(0, Math.min(size, Math.round(ratio * size)));
  return '▰'.repeat(filled) + '▱'.repeat(size - filled);
}

/**
 * Pasang role Buyer + tier yang sesuai ke member. Return { added, removed, tier } atau null.
 * Aman dipanggil berkali-kali (hanya mengubah yang perlu).
 */
async function applySpenderRoles(guild, userId, cfg = loadConfig()) {
  const s = settings(cfg);
  if (s.enabled === false) return null;
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return null;
  const me = guild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
    console.warn('[spender] bot butuh izin Manage Roles untuk memberi role spender.');
    return null;
  }
  const sp = spentOf(userId);
  const tier = tierFor(sp.revenue, cfg);
  const want = new Set();
  const all = tiers(cfg).filter((x) => isId(x.roleId));
  const hasTier = tier && isId(tier.roleId);
  // Buyer = "tier 0": dipasang saat order pertama, lalu DIGANTI role tier begitu tier pertama tercapai
  // (kecuali keepBuyerRole = true).
  if (sp.orders > 0 && isId(s.buyerRoleId) && (!hasTier || s.keepBuyerRole)) want.add(s.buyerRoleId);
  if (hasTier) {
    if (s.keepLowerTiers) all.filter((x) => x.min <= tier.min).forEach((x) => want.add(x.roleId));
    else want.add(tier.roleId);
  }
  const managed = [...all.map((x) => x.roleId), ...(isId(s.buyerRoleId) ? [s.buyerRoleId] : [])];
  const add = [...want].filter((id) => !member.roles.cache.has(id));
  const remove = [...new Set(managed)].filter((id) => !want.has(id) && member.roles.cache.has(id));
  const usable = (id) => {
    const role = guild.roles.cache.get(id);
    return role && role.position < me.roles.highest.position;
  };
  const addOk = add.filter(usable);
  const removeOk = remove.filter(usable);
  if (addOk.length !== add.length || removeOk.length !== remove.length) {
    console.warn('[spender] beberapa role spender posisinya di atas role bot — geser role bot ke paling atas.');
  }
  if (addOk.length) await member.roles.add(addOk, 'Role spender Noname Store').catch((e) => console.warn('[spender] gagal tambah role:', e.message));
  if (removeOk.length) await member.roles.remove(removeOk, 'Naik tier spender').catch((e) => console.warn('[spender] gagal lepas role:', e.message));
  return { added: addOk, removed: removeOk, tier, member };
}

/** Kartu ucapan saat order pertama / naik tier. */
function buildTierUp(guild, cfg, userId, { prevTier, tier, firstOrder }) {
  const s = settings(cfg);
  const sp = spentOf(userId);
  const next = nextTierFor(sp.revenue, cfg);
  const store = cfg.storeName || guild.name;
  const e = new EmbedBuilder()
    .setColor(color(cfg, 'brand', 0x3498db))
    .setAuthor({ name: `${store} • Spender Rewards`, iconURL: guild.iconURL({ size: 128 }) || undefined })
    .setThumbnail(guild.iconURL({ extension: 'png', size: 256 }) || null)
    .setFooter({ text: store, iconURL: guild.iconURL({ size: 64 }) || undefined })
    .setTimestamp(new Date());

  if (tier && tier !== prevTier) {
    e.setTitle(`🎉 Naik Level! Kamu Sekarang ${tierLabel(tier)}`).setDescription(
      `Selamat <@${userId}>! Total belanjamu di **${store}** sudah mencapai **${rupiah(sp.revenue)}** 🔥\n` +
        `Kamu resmi mendapatkan role ${isId(tier.roleId) ? `<@&${tier.roleId}>` : `**${tier.name}**`}! ✨`,
    );
  } else {
    e.setTitle('🛍️ Selamat Datang, Buyer!').setDescription(
      `Terima kasih <@${userId}> sudah melakukan **order pertama** di **${store}**! 💜\n` +
        `Kamu mendapatkan role ${isId(s.buyerRoleId) ? `<@&${s.buyerRoleId}>` : '**Buyer**'}.`,
    );
  }
  e.addFields(
    { name: '💰 Total Belanja', value: `\`${rupiah(sp.revenue)}\``, inline: true },
    { name: '🧾 Total Order', value: `\`${num(sp.orders)} order\``, inline: true },
    { name: '🏅 Tier', value: `\`${tier ? tierLabel(tier) : 'Buyer'}\``, inline: true },
  );
  if (next) {
    const base = tier?.min || 0;
    const ratio = (sp.revenue - base) / (next.min - base);
    e.addFields({
      name: `⏭️ Menuju ${tierLabel(next)}`,
      value: `${progressBar(ratio)} \`${Math.floor(ratio * 100)}%\`\nKurang **${rupiah(next.min - sp.revenue)}** lagi!`,
    });
  } else if (tier) {
    e.addFields({ name: '👑 Tier Tertinggi', value: 'Kamu sudah mencapai **tier tertinggi**. Terima kasih atas loyalitasmu! 🙏' });
  }
  return { content: `<@${userId}>`, embeds: [e], allowedMentions: { users: [userId] } };
}

/** Kartu /spender — status belanja & tier member. */
function buildSpenderCard(guild, cfg, user) {
  const s = settings(cfg);
  const sp = spentOf(user.id);
  const tier = tierFor(sp.revenue, cfg);
  const next = nextTierFor(sp.revenue, cfg);
  const store = cfg.storeName || guild.name;
  const rank = Object.entries(state.spenders)
    .sort((a, b) => b[1].revenue - a[1].revenue)
    .findIndex(([id]) => id === user.id);
  const e = new EmbedBuilder()
    .setColor(color(cfg, 'brand', 0x3498db))
    .setAuthor({ name: `${user.globalName || user.username} • Spender Card`, iconURL: user.displayAvatarURL({ size: 128 }) })
    .setThumbnail(user.displayAvatarURL({ extension: 'png', size: 256 }))
    .addFields(
      { name: '🏅 Tier', value: `\`${tier ? tierLabel(tier) : sp.orders ? '🛍️ Buyer' : 'Belum ada'}\``, inline: true },
      { name: '💰 Total Belanja', value: `\`${rupiah(sp.revenue)}\``, inline: true },
      { name: '🧾 Total Order', value: `\`${num(sp.orders)} order\``, inline: true },
      { name: '🏆 Peringkat Spender', value: rank >= 0 && sp.orders ? `\`#${rank + 1}\`` : '`-`', inline: true },
    );
  if (next) {
    const base = tier?.min || 0;
    const ratio = (sp.revenue - base) / (next.min - base);
    e.addFields({ name: `⏭️ Menuju ${tierLabel(next)}`, value: `${progressBar(ratio)} \`${Math.floor(ratio * 100)}%\`\nKurang **${rupiah(next.min - sp.revenue)}** lagi` });
  }
  const list = [
    isId(s.buyerRoleId) ? `${sp.orders ? '✅' : '▫️'} 🛍️ **Buyer** — order pertama` : null,
    ...tiers(cfg).map((x) => `${sp.revenue >= x.min ? '✅' : '▫️'} ${tierLabel(x)} — ${rupiah(x.min)}+`),
  ].filter(Boolean);
  if (list.length) e.addFields({ name: '🎖️ Daftar Tier', value: list.join('\n').slice(0, 1024) });
  e.setFooter({ text: `${store} • Total dari order yang selesai`, iconURL: guild.iconURL({ size: 64 }) || undefined }).setTimestamp(new Date());
  return { embeds: [e], allowedMentions: { parse: [] } };
}

module.exports = { tierFor, nextTierFor, tierLabel, applySpenderRoles, buildTierUp, buildSpenderCard, spentOf };
