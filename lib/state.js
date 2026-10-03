// Shared state bridge: the Telegram bot (bot.js) and the web panel (panel/server.js)
// run in the SAME process via PM2 one-app mode. This module holds everything both UIs
// need: wallet list, providers, fast-list settings, ca-memory, schedules, mint history.
// The panel never touches Telegram; the bot never reads panel state.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const opensea = require('./opensea');
const mint = require('./mint');

const ROOT = path.join(__dirname, '..');

const OPENSEA_API_KEY = process.env.OPENSEA_API_KEY;
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const AUTHORIZED_USER_ID = process.env.AUTHORIZED_USER_ID;
const PRIVATE_KEYS = (process.env.PRIVATE_KEYS || '').split(',').map((k) => k.trim()).filter(Boolean);

const RPC_URLS = {
  ethereum: process.env.RPC_URL_ETHEREUM,
  polygon: process.env.RPC_URL_POLYGON,
  base: process.env.RPC_URL_BASE,
  arc: process.env.RPC_URL_ARC,
  robinhood: process.env.RPC_URL_ROBINHOOD,
};

// Optional extra endpoints per chain (comma separated), e.g. RPC_URL_ROBINHOOD_EXTRA=https://...
// Signed mint txs are broadcast to the primary + every extra at once; first acceptance wins.
const RPC_ENDPOINTS = Object.fromEntries(
  Object.entries(RPC_URLS)
    .filter(([, url]) => url)
    .map(([name, url]) => [name, [
      url,
      ...(process.env[`RPC_URL_${name.toUpperCase()}_EXTRA`] || '').split(',').map((u) => u.trim()).filter(Boolean),
    ]]),
);

// batchMaxCount:1 turns off ethers' request batching (it holds each call ~10ms to fill a batch).
const providers = Object.fromEntries(
  Object.entries(RPC_URLS)
    .filter(([, url]) => url)
    .map(([name, url]) => [name, new ethers.JsonRpcProvider(url, undefined, { batchMaxCount: 1 })]),
);

const walletWallets = PRIVATE_KEYS.map((pk) => {
  const w = new ethers.Wallet(pk);
  return { wallet: w, address: w.address };
});
const walletAddresses = walletWallets.map((w) => w.address);

function shortAddr(address) {
  return `${address.slice(0, 7)}...${address.slice(-5)}`;
}

const CA_MEMORY_FILE = path.join(ROOT, 'ca-memory.json');
const CA_MEMORY_LIMIT = 3;
let caMemory = [];
try { caMemory = JSON.parse(fs.readFileSync(CA_MEMORY_FILE, 'utf8')); } catch {}
function rememberCa(entry) {
  caMemory = [entry, ...caMemory.filter((e) => e.address.toLowerCase() !== entry.address.toLowerCase() || e.chain !== entry.chain)].slice(0, CA_MEMORY_LIMIT);
  fs.writeFileSync(CA_MEMORY_FILE, JSON.stringify(caMemory));
}

function mintSchedulesSlug(ca, chainInput) {
  const hit = caMemory.find((e) => e.address.toLowerCase() === ca.toLowerCase() && e.chain === chainInput);
  return hit ? hit.slug : null;
}

const SETTINGS_FILE = path.join(ROOT, 'fastlist-settings.json');
let fastSettings = { price: '-40%', confirm: true, currency: 'eth', wallets: {} };
try {
  const loaded = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  if (loaded && typeof loaded === 'object') fastSettings = { ...fastSettings, ...loaded };
} catch {}
function saveFastSettings() {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(fastSettings));
}

const GAS_SETTINGS_FILE = path.join(ROOT, 'gas-settings.json');
let gasSettings = { strategy: 'medium' }; // keys must match lib/gasstrategy.js PRESETS
try {
  const loaded = JSON.parse(fs.readFileSync(GAS_SETTINGS_FILE, 'utf8'));
  if (loaded && typeof loaded === 'object') gasSettings = { ...gasSettings, ...loaded };
} catch {}
function saveGasSettings() {
  fs.writeFileSync(GAS_SETTINGS_FILE, JSON.stringify(gasSettings));
}

module.exports = {
  ROOT,
  OPENSEA_API_KEY,
  TELEGRAM_TOKEN,
  AUTHORIZED_USER_ID,
  PRIVATE_KEYS,
  providers,
  RPC_ENDPOINTS,
  walletAddresses,
  walletWallets,
  shortAddr,
  opensea,
  mint,
  caMemory,
  rememberCa,
  mintSchedulesSlug,
  fastSettings,
  saveFastSettings,
  gasSettings,
  saveGasSettings,
};
