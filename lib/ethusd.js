// ETH -> USDT rate for display-only conversion (never touches orders).
// Cache 30s. On fetch error reuse stale rate up to 5min, else throw (caller falls back to ETH display).
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const URL = 'https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT';
const FRESH_MS = 30 * 1000;
const STALE_MS = 5 * 60 * 1000;
let cache = { at: 0, rate: null };

async function ethUsdRate() {
  if (cache.rate && Date.now() - cache.at < FRESH_MS) return cache.rate;
  try {
    const r = await fetch(URL, { headers: { 'user-agent': UA } });
    if (!r.ok) throw new Error(`binance ${r.status}`);
    const j = await r.json();
    const rate = Number(j.price);
    if (!(rate > 0)) throw new Error('bad rate');
    cache = { at: Date.now(), rate };
    return rate;
  } catch (e) {
    if (cache.rate && Date.now() - cache.at < STALE_MS) return cache.rate;
    throw e;
  }
}

// ETH amount -> USDT display string (adaptive decimals: 2 above $1, more below).
function usdStr(ethAmt, rate) {
  const v = Number(ethAmt) * rate;
  const s = v >= 1 ? v.toFixed(2) : v.toFixed(v < 0.01 ? 5 : 4).replace(/\.?0+$/, '');
  return `${s} USDT`;
}

module.exports = { ethUsdRate, usdStr };