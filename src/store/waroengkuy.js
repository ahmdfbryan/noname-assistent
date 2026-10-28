/**
 * Client API Reseller Waroengkuy v1 (https://waroengkuy.com/reseller/docs).
 * API key dibaca dari .env: WRK_KEY (atau WAROENGKUY_API_KEY / WAROENGKUY_KEY).
 * Semua fungsi mengembalikan JSON dari API. Gagal → throw WrkError { code, status, data }.
 */
const BASE = (process.env.WRK_BASE_URL || 'https://waroengkuy.com/api/reseller/v1').replace(/\/+$/, '');
const apiKey = () => process.env.WRK_KEY || process.env.WAROENGKUY_API_KEY || process.env.WAROENGKUY_KEY || '';

class WrkError extends Error {
  constructor(message, { code = 'network_error', status = 0, data = null } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.data = data;
  }
}

/** Error sementara (koneksi / server sibuk) → aman diulang. */
const isTemporary = (err) => !err?.status || err.status >= 500 || ['rate_limited', 'network_error', 'timeout', 'upstream_error', 'gateway_error', 'unavailable'].includes(err?.code);

async function request(method, path, body, { timeout = 30000 } = {}) {
  const key = apiKey();
  if (!key) throw new WrkError('API key Waroengkuy belum diisi di .env (WRK_KEY).', { code: 'no_api_key' });
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    throw new WrkError(timedOut ? 'Waroengkuy tidak merespons (timeout).' : `Koneksi ke Waroengkuy gagal: ${err?.cause?.code || err?.message}`, {
      code: timedOut ? 'timeout' : 'network_error',
    });
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    throw new WrkError(`Respons Waroengkuy tidak valid (HTTP ${res.status}).`, { code: res.status >= 500 ? 'upstream_error' : 'invalid_response', status: res.status });
  }
  if (!res.ok || data?.ok === false) {
    throw new WrkError(data?.error || `HTTP ${res.status}`, { code: data?.code || (res.status === 429 ? 'rate_limited' : 'error'), status: res.status, data });
  }
  return data;
}

// ───────────────────────── Katalog (cache supaya tidak memanggil API tiap pembeli) ─────────────────────────
const CACHE_MS = 3 * 60 * 1000;
let catalog = { at: 0, items: [], error: null };
let loading = null;

/** Ambil katalog (cache 3 menit). force = abaikan cache. Gagal → pakai cache lama kalau ada. */
async function getProducts({ force = false } = {}) {
  if (!force && catalog.items.length && Date.now() - catalog.at < CACHE_MS) return catalog.items;
  if (loading) return loading;
  loading = request('GET', '/products')
    .then((d) => {
      catalog = { at: Date.now(), items: Array.isArray(d.items) ? d.items : [], error: null };
      return catalog.items;
    })
    .catch((err) => {
      catalog.error = err;
      if (catalog.items.length) return catalog.items;
      throw err;
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}
/** Katalog terakhir tanpa memanggil API (untuk tampilan yang harus cepat, misal kartu katalog). */
const cachedProducts = () => catalog.items;
const catalogUpdatedAt = () => catalog.at;

const getBalance = () => request('GET', '/balance');
const createOrder = (body) => request('POST', '/orders', body, { timeout: 45000 });
const getOrder = (id) => request('GET', `/orders/${encodeURIComponent(id)}`);
const getOrderByRef = (refId) => request('GET', `/orders?ref_id=${encodeURIComponent(refId)}`);
const cancelOrder = (id) => request('POST', `/orders/${encodeURIComponent(id)}/cancel`);
const sendInvite = (claimCode, data) => request('POST', '/invites', { claim_code: claimCode, data });
const createDeposit = (amount) => request('POST', '/deposits', { amount });
const getDeposit = (id) => request('GET', `/deposits/${encodeURIComponent(id)}`);

module.exports = {
  WrkError,
  isTemporary,
  hasKey: () => Boolean(apiKey()),
  getProducts,
  cachedProducts,
  catalogUpdatedAt,
  getBalance,
  createOrder,
  getOrder,
  getOrderByRef,
  cancelOrder,
  sendInvite,
  createDeposit,
  getDeposit,
};
