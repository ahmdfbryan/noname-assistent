const fs = require('fs');
const path = require('path');

/**
 * Banner / GIF di panel store: link https ATAU path file di folder bot (contoh "assets/store-banner.gif").
 * File lokal dikirim sebagai lampiran sekali saja — saat panel di-update, lampiran lama dipakai ulang (tidak upload ulang).
 * Return { url, files } atau null kalau kosong / file tidak ada.
 */
function bannerOf(src, baseName = 'banner') {
  const v = String(src || '').trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) return { url: v, files: [] };
  const file = path.join(__dirname, '..', '..', v);
  if (!fs.existsSync(file)) {
    console.warn(`[store] banner ${v} tidak ditemukan — panel tanpa banner.`);
    return null;
  }
  const name = `${baseName}${path.extname(file).toLowerCase() || '.gif'}`;
  return { url: `attachment://${name}`, files: [{ attachment: file, name }] };
}

/** Edit panel: kalau banner yang sama sudah terlampir di pesan → tidak upload ulang. Gagal → upload ulang penuh. */
async function editPanelMessage(message, payload) {
  const f = payload.files?.[0];
  if (!f) return message.edit(payload);
  let size = -1;
  try {
    size = fs.statSync(f.attachment).size;
  } catch {}
  const same = message.attachments?.find?.((a) => a.name === f.name && a.size === size);
  if (same) {
    const { files, ...rest } = payload; // eslint-disable-line no-unused-vars
    try {
      return await message.edit(rest);
    } catch {
      /* lanjut upload ulang */
    }
  }
  return message.edit({ ...payload, attachments: [] });
}

module.exports = { bannerOf, editPanelMessage };
