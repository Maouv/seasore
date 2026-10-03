// Web panel backend. Same process as the Telegram bot (PM2 single app), shares lib/state.
// Zero dependencies: node:http + hand-rolled JSON API + one static HTML file.
require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const state = require('../lib/state');
const sessionStore = require('../lib/session');
const schedules = require('../lib/schedules');
const holdings = require('../lib/holdings');
const osoffers = require('../lib/osoffers');
const osauth = require('../lib/osauth');
const minttx = require('../lib/minttx');

const { ROOT, OPENSEA_API_KEY, PRIVATE_KEYS, providers, walletAddresses, walletWallets, shortAddr, opensea, mint } = state;
const PORT = Number(process.env.PANEL_PORT) || 20129;
const PANEL_TOKEN = process.env.PANEL_TOKEN;
const PUBLIC_DIR = path.join(__dirname, 'public');
const CONCURRENCY = 3;

if (!PANEL_TOKEN) {
  console.warn('panel: PANEL_TOKEN not set in .env — panel disabled, Telegram bot keeps running');
}

// in-memory job registry: the UI polls /api/jobs/:id for progress
const jobs = new Map();
let jobSeq = 0;
function startJob(kind, label, total) {
  const id = `${kind}-${++jobSeq}`;
  const job = { id, kind, label, total, done: 0, results: [], status: 'running', started: Date.now(), log: [] };
  jobs.set(id, job);
  if (jobs.size > 40) {
    for (const [k, v] of jobs) if (jobs.size > 39 && v.status !== 'running') { jobs.delete(k); break; }
  }
  return job;
}
function jobLine(job, line) {
  job.log.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
  if (job.log.length > 200) job.log.splice(0, job.log.length - 200);
  console.log(`panel job ${job.id}: ${line}`);
}

// ---- helpers shared with bot.js flows ----

function detectChainHoldings(address) {
  return Promise.all(Object.entries(providers).map(async ([name, provider]) => {
    const contract = new ethers.Contract(address, ['function balanceOf(address) view returns (uint256)'], provider);
    const balances = await Promise.all(walletAddresses.map((a) => contract.balanceOf(a).catch(() => 0n)));
    return [name, balances.reduce((sum, b) => sum + Number(b), 0)];
  }));
}

async function listFlowData(ca, chainInput) {
  const chain = opensea.CHAIN_MAP[chainInput];
  const provider = providers[chainInput];
  const slug = await opensea.getCollectionSlug(chainInput, ca, OPENSEA_API_KEY);
  if (!slug) throw new Error('Could not resolve collection from this contract address');
  const readOnlySdk = opensea.makeSdk(provider, chain, OPENSEA_API_KEY);
  const floorPrice = await opensea.getFloorPrice(readOnlySdk, slug);
  const walletsData = await Promise.all(walletWallets.map(async ({ wallet }) => {
    const connected = wallet.connect(provider);
    const sdk = opensea.makeSdk(connected, chain, OPENSEA_API_KEY);
    const result = await holdings.getHoldings({
      provider,
      contractAddress: ca,
      wallet: wallet.address,
      loadCandidates: (balance) => opensea.getOwnedTokenIds(sdk, wallet.address, ca, { stopAt: balance }),
    });
    const activeListings = await opensea.getOpenListings(sdk, wallet.address, slug, ca, chain);
    return { address: wallet.address, items: result.ids, listed: activeListings.map((l) => String(l.tokenId)), warnings: result.warnings };
  }));
  return { slug, floorPrice, chain, chainInput, ca, walletsData };
}

// ---- listing execution (mirrors bot.js processItem, no Telegram) ----

async function executeListJob(job, listCfg) {
  const { ca, chainInput, chain, floorPrice } = listCfg;
  const expirationTime = Math.round(Date.now() / 1000 + 60 * 60 * 24 * 7);
  const jobs = [];
  for (const selection of listCfg.selections) {
    const wallet = new ethers.Wallet(PRIVATE_KEYS[selection.walletIndex], providers[chainInput]);
    const sel = { ...selection, wallet };
    const sdk = opensea.makeSdk(wallet, chain, OPENSEA_API_KEY);
    const openListings = await opensea.getOpenListings(sdk, wallet.address, listCfg.slug, ca, chain);
    const cancelMap = openListings.reduce((map, l) => {
      (map[String(l.tokenId)] = map[String(l.tokenId)] || []).push({ orderHash: l.orderHash, protocolAddress: l.protocolAddress });
      return map;
    }, {});
    selection.items.forEach((item, index) => {
      jobs.push({ selection: sel, sdk, item, cancelListings: cancelMap[String(item)] || [] });
    });
  }
  job.total = jobs.length;

  let next = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, async () => {
    while (next < jobs.length) {
      const j = jobs[next]; next += 1;
      const { selection, sdk, item } = j;
      const tokenId = String(item);
      try {
        const stillOwned = await opensea.checkStillOwned(ca, tokenId, selection.wallet.address, providers[chainInput]);
        if (!stillOwned) {
          job.results.push({ tokenId, wallet: selection.wallet.address, status: 'skipped' });
          job.done += 1; continue;
        }
        for (const old of j.cancelListings || []) {
          await opensea.cancelListing(selection.wallet, old, chain);
        }
        if (j.cancelListings?.length > 0) jobLine(job, `cancelled ${j.cancelListings.length} old listing(s) for #${tokenId}`);
        await sdk.createListing({
          asset: { tokenId, tokenAddress: ca },
          accountAddress: selection.wallet.address,
          amount: selection.price,
          expirationTime,
          zone: opensea.signedZone(chain),
        });
        jobLine(job, `#${tokenId} listed at ${selection.price}`);
        job.results.push({ tokenId, wallet: selection.wallet.address, status: 'ok', price: selection.price });
      } catch (err) {
        jobLine(job, `#${tokenId} failed: ${err.message.slice(0, 120)}`);
        job.results.push({ tokenId, wallet: selection.wallet.address, status: 'failed', error: err.message.slice(0, 150) });
      }
      job.done += 1;
    }
  });
  await Promise.all(workers);
  job.status = 'done';
  jobLine(job, `listing done: ${job.results.filter((r) => r.status === 'ok').length} ok, ${job.results.filter((r) => r.status === 'failed').length} failed, ${job.results.filter((r) => r.status === 'skipped').length} skipped (floor ${floorPrice})`);
}

// ---- manage: reprice / close (offchain, free) ----

async function executeManageJob(job, cfg) {
  const { ca, chainInput, chain } = cfg;
  const manageWallet = new ethers.Wallet(PRIVATE_KEYS[cfg.walletIndex], providers[chainInput]);
  const sdk = opensea.makeSdk(manageWallet, chain, OPENSEA_API_KEY);
  const listings = await opensea.getOpenListings(sdk, walletAddresses[cfg.walletIndex], cfg.slug, ca, chain);
  const owned = listings.filter((l) => cfg.tokenIds.includes(String(l.tokenId)));
  job.total = owned.length;
  if (owned.length === 0) {
    job.status = 'done';
    jobLine(job, 'no matching active listings');
    return;
  }
  const relisted = new Set();
  for (const lst of owned) {
    try {
      await opensea.cancelListing(manageWallet, lst, chain);
      jobLine(job, `#${lst.tokenId} closed`);
      job.results.push({ tokenId: String(lst.tokenId), status: 'ok' });
      if (cfg.mode === 'reprice' && !relisted.has(String(lst.tokenId))) {
        await sdk.createListing({
          asset: { tokenId: String(lst.tokenId), tokenAddress: ca },
          accountAddress: walletAddresses[cfg.walletIndex],
          amount: cfg.price,
          expirationTime: Math.round(Date.now() / 1000 + 60 * 60 * 24 * 7),
          zone: opensea.signedZone(chain),
        });
        relisted.add(String(lst.tokenId));
        jobLine(job, `#${lst.tokenId} relisted at ${cfg.price}`);
      }
    } catch (err) {
      jobLine(job, `#${lst.tokenId} failed: ${err.message.slice(0, 120)}`);
      job.results.push({ tokenId: String(lst.tokenId), status: 'failed', error: err.message.slice(0, 150) });
    }
    job.done += 1;
  }
  job.status = 'done';
}

// ---- mint ----

async function runMint(job, cfg) {
  const { chainInput, ca, collection, mintSig, mintName, priceEth, qty, indexes, stageLabel } = cfg;
  const provider = providers[chainInput];
  const priceWei = ethers.parseEther(String(priceEth ?? 0));
  const slug = state.mintSchedulesSlug(ca, chainInput);
  const iface = new ethers.Interface([`function ${mintSig} payable`]);
  const wallets = indexes.map((i) => new ethers.Wallet(PRIVATE_KEYS[i], provider));
  const [network, feeData, blockAtStart] = await Promise.all([provider.getNetwork(), provider.getFeeData(), provider.getBlockNumber()]);
  const probeWallet = wallets[0];
  let probeData; let probeTo = ca; let probeValue = priceWei * BigInt(qty);
  if (slug && OPENSEA_API_KEY) {
    const built = await minttx.buildTx(OPENSEA_API_KEY, slug, probeWallet.address, qty);
    if (!built.ok) throw new Error(`OS mint build: ${built.error}`);
    probeData = built.data; probeTo = built.to; probeValue = built.value;
    jobLine(job, `mint route: os-api (slug=${slug})`);
  } else {
    probeData = iface.encodeFunctionData(mintName, mint.mintArgs(mintSig, probeWallet.address, qty));
  }
  const gasLimit = await provider.estimateGas({ to: probeTo, data: probeData, value: probeValue, from: probeWallet.address })
    .then((g) => (g * 120n) / 100n).catch(() => 600000n);
  job.total = wallets.length;

  const results = await Promise.all(wallets.map(async (wallet) => {
    const base = { wallet: wallet.address };
    try {
      const [balance, nonce] = await Promise.all([provider.getBalance(wallet.address), provider.getTransactionCount(wallet.address, 'pending')]);
      const maxGasCost = gasLimit * (feeData.maxFeePerGas ?? feeData.gasPrice);
      const walletValue = priceWei * BigInt(qty);
      if (balance < walletValue + maxGasCost) {
        jobLine(job, `${shortAddr(wallet.address)} skipped: insufficient balance`);
        job.done += 1;
        return { ...base, status: 'skipped', error: 'insufficient balance' };
      }
      let txTo = ca; let txData = iface.encodeFunctionData(mintName, mint.mintArgs(mintSig, wallet.address, qty)); let txValue = walletValue;
      if (slug && OPENSEA_API_KEY) {
        const built = await minttx.buildTx(OPENSEA_API_KEY, slug, wallet.address, qty);
        if (!built.ok) {
          job.done += 1;
          return { ...base, status: 'failed', error: `OS mint: ${built.error.slice(0, 120)}` };
        }
        txTo = built.to; txData = built.data; txValue = built.value;
      }
      const tx = { to: txTo, data: txData, value: txValue, nonce, chainId: network.chainId, gasLimit };
      if (feeData.maxFeePerGas) { tx.type = 2; tx.maxFeePerGas = feeData.maxFeePerGas; tx.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas; }
      else { tx.gasPrice = feeData.gasPrice; }
      const t0 = Date.now();
      const signed = await wallet.signTransaction(tx);
      const sent = await provider.broadcastTransaction(signed);
      const receipt = await Promise.race([sent.wait(), new Promise((resolve) => setTimeout(() => resolve(null), 60000))]);
      jobLine(job, `${shortAddr(wallet.address)} ${receipt ? (receipt.status === 1 ? 'ok' : 'reverted') : 'pending'} tx ${sent.hash}`);
      job.results.push({ ...base, status: !receipt ? 'pending' : receipt.status === 1 ? 'ok' : 'failed', hash: sent.hash });
      job.done += 1;
      return base;
    } catch (err) {
      jobLine(job, `${shortAddr(wallet.address)} failed: ${err.message.slice(0, 120)}`);
      job.results.push({ ...base, status: 'failed', error: err.message.slice(0, 150) });
      job.done += 1;
      return base;
    }
  }));

  const historyPath = path.join(ROOT, 'mint-history.json');
  let history = [];
  try { history = JSON.parse(fs.readFileSync(historyPath, 'utf8')); } catch {}
  history.push({
    ts: new Date().toISOString(), chain: chainInput, ca, collection, stage: stageLabel || null,
    price: ethers.formatEther(priceWei), qtyPerWallet: qty, blockAtStart,
    wallets: results.map((r) => ({ addr: r.wallet, status: r.status, hash: r.hash || null })),
  });
  fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));
  job.status = 'done';
  jobLine(job, `mint done: ${results.filter((r) => r.status === 'ok').length} ok, ${results.filter((r) => r.status === 'failed').length} failed`);
}

// ---- accept offer ----

async function runAcceptJob(job, cfg) {
  const { chainInput, ca, tokenId, walletIndex, offerIndex, slug } = cfg;
  const provider = providers[chainInput];
  const owner = walletWallets[walletIndex];
  const offers = await osoffers.listOffersWithOrders(slug, tokenId, OPENSEA_API_KEY, provider);
  const offer = offers[offerIndex];
  if (!offer) { job.status = 'done'; jobLine(job, 'offer gone'); return; }
  const stillOwned = await opensea.checkStillOwned(ca, String(tokenId), owner.address, provider);
  if (!stillOwned) { job.status = 'done'; jobLine(job, 'token no longer owned'); return; }
  const sdk = opensea.makeSdk(owner.wallet, opensea.CHAIN_MAP[chainInput], OPENSEA_API_KEY);
  const openListings = await opensea.getOpenListings(sdk, owner.address, slug, ca, opensea.CHAIN_MAP[chainInput]);
  for (const lst of openListings.filter((l) => String(l.tokenId) === String(tokenId))) {
    await opensea.cancelListing(owner.wallet, lst, opensea.CHAIN_MAP[chainInput]);
  }
  jobLine(job, `accepting ${offer.priceStr} on #${tokenId}`);
  const bearer = await osauth.walletJwt(owner.wallet);
  const out = await osoffers.acceptOffer(owner.wallet, offer, ca, tokenId, bearer, OPENSEA_API_KEY, provider);
  job.results.push({ hash: out.hash, status: out.receipt && out.receipt.status === 1 ? 'ok' : 'failed' });
  job.total = 1; job.done = 1;
  job.status = 'done';
  jobLine(job, out.receipt && out.receipt.status === 1 ? `accepted ✓ tx ${out.hash}` : `tx ${out.hash} ${out.receipt ? 'reverted' : 'still pending'}`);
}

// ---- HTTP plumbing ----

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); }
    });
  });
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const auth = req.headers.authorization || '';
  const authed = auth === `Bearer ${PANEL_TOKEN}`;

  if (!url.pathname.startsWith('/api/')) {
    let file = url.pathname === '/' ? '/index.html' : url.pathname;
    file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
    const full = path.join(PUBLIC_DIR, file);
    if (!full.startsWith(PUBLIC_DIR) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
      res.writeHead(404); return res.end('not found');
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream' });
    return res.end(fs.readFileSync(full));
  }
  if (!authed) return json(res, 401, { error: 'unauthorized' });

  const post = () => req.method === 'POST' ? readBody(req) : Promise.resolve({});
  try {
    // ---- status ----
    if (url.pathname === '/api/status') {
      const balances = await Promise.all(walletAddresses.map(async (a) => {
        let sum = 0;
        for (const p of Object.values(providers)) {
          try { sum += Number(ethers.formatEther(await p.getBalance(a))); } catch {}
        }
        return sum;
      }));
      return json(res, 200, {
        wallets: walletAddresses,
        balances,
        chains: Object.keys(providers),
        fastSettings: state.fastSettings,
        caMemory: state.caMemory,
      });
    }

    // ---- detect chain holdings for a CA ----
    if (url.pathname === '/api/detect' && req.method === 'POST') {
      const { ca } = await post();
      if (!ethers.isAddress(ca)) return json(res, 400, { error: 'invalid address' });
      const counts = await detectChainHoldings(ca);
      const mintChains = await Promise.all(Object.entries(providers).map(async ([name, p]) => [name, (await p.getCode(ca).catch(() => '0x')) !== '0x']));
      return json(res, 200, { holdings: counts, codeOn: mintChains.filter(([, has]) => has).map(([n]) => n) });
    }

    // ---- listing flow data (holds + floor) ----
    if (url.pathname === '/api/list/prepare' && req.method === 'POST') {
      const { ca, chain } = await post();
      const data = await listFlowData(ca, chain);
      return json(res, 200, data);
    }

    // ---- execute list / manage / mint / accept ----
    if (url.pathname === '/api/action' && req.method === 'POST') {
      const body = await post();
      const job = startJob(body.kind, body.label || body.kind, body.total ?? 0);
      (async () => {
        try {
          if (body.kind === 'list') await executeListJob(job, body.cfg);
          else if (body.kind === 'manage') await executeManageJob(job, body.cfg);
          else if (body.kind === 'mint') await runMint(job, body.cfg);
          else if (body.kind === 'accept') await runAcceptJob(job, body.cfg);
          else throw new Error('unknown kind');
        } catch (err) {
          job.status = 'failed';
          jobLine(job, `FATAL: ${err.message.slice(0, 200)}`);
        }
      })();
      return json(res, 200, { jobId: job.id });
    }

    if (url.pathname.startsWith('/api/jobs/') && req.method === 'GET') {
      const job = jobs.get(url.pathname.slice(10));
      if (!job) return json(res, 404, { error: 'no such job' });
      return json(res, 200, job);
    }

    // ---- schedules ----
    if (url.pathname === '/api/schedules' && req.method === 'GET') {
      return json(res, 200, schedules.list());
    }
    if (url.pathname === '/api/schedules/cancel' && req.method === 'POST') {
      const { id } = await post();
      schedules.cancel(id);
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/schedules/qty' && req.method === 'POST') {
      const { id, qty } = await post();
      const all = JSON.parse(fs.readFileSync(path.join(ROOT, 'mint-schedules.json'), 'utf8'));
      const s = all.find((x) => x.id === id && x.status === 'pending');
      if (!s) return json(res, 404, { error: 'not found' });
      s.qty = Math.max(1, Number(qty) || 1);
      fs.writeFileSync(path.join(ROOT, 'mint-schedules.json'), JSON.stringify(all, null, 2));
      return json(res, 200, { ok: true, qty: s.qty });
    }

    // ---- fast settings ----
    if (url.pathname === '/api/settings' && req.method === 'POST') {
      const { price, confirm, wallets } = await post();
      if (price !== undefined) {
        const raw = opensea.parsePriceInput(String(price), 1);
        if (!Number.isFinite(raw)) return json(res, 400, { error: 'invalid price (number or % like -40%)' });
        state.fastSettings.price = String(price).trim();
      }
      if (confirm !== undefined) state.fastSettings.confirm = Boolean(confirm);
      if (wallets !== undefined) {
        for (const [addr, on] of Object.entries(wallets)) state.fastSettings.wallets[addr] = !on;
      }
      state.saveFastSettings();
      return json(res, 200, state.fastSettings);
    }

    // ---- mint prepare: slug + drop stages + probe ----
    if (url.pathname === '/api/mint/prepare' && req.method === 'POST') {
      const { ca, chain } = await post();
      const provider = providers[chain];
      if (!provider) return json(res, 400, { error: `no RPC for ${chain}` });
      const probe = await mint.detect(provider, ca, walletAddresses[0]);
      if (probe.error) return json(res, 200, { error: probe.error });
      const slug = await opensea.getCollectionSlug(chain, ca, OPENSEA_API_KEY);
      const drop = slug ? await mint.fetchDrop(slug).catch(() => null) : null;
      const collection = await mint.collectionName(provider, ca) || shortAddr(ca);
      const active = drop ? drop.stages.find((s) => Date.now() >= s.start && Date.now() <= s.end) : null;
      const stage = active || (drop ? drop.stages.find((s) => s.type === 'PUBLIC_SALE') : null);
      return json(res, 200, {
        ca, chainInput: chain, collection, mintSig: probe.sig, mintName: probe.name,
        priceEth: stage ? stage.priceEth : probe.price != null ? Number(ethers.formatEther(probe.price)) : null,
        wallets: walletAddresses, slug,
        stages: drop ? drop.stages.map((s) => ({ index: s.index, label: s.label, type: s.type, priceEth: s.priceEth, start: s.start, end: s.end, maxPerWallet: s.maxPerWallet })) : [],
        supply: drop ? `${drop.totalSupply ?? '?'}/${drop.maxSupply ?? '?'}` : null,
      });
    }

    // ---- create schedule from panel ----
    if (url.pathname === '/api/schedule' && req.method === 'POST') {
      const { ca, chain, slug, collection, stageIndex, label, priceEth, qty, when } = await post();
      const startMs = Date.parse(when);
      if (!Number.isFinite(startMs)) return json(res, 400, { error: 'invalid time' });
      const drop = slug ? await mint.fetchDrop(slug).catch(() => null) : null;
      const st = drop ? drop.stages.find((s) => s.index === stageIndex) : null;
      const schedule = {
        id: Date.now().toString(36),
        chatId: Number(process.env.TELEGRAM_USER_ID),
        chain, ca, slug: slug || null, collection, stageIndex: stageIndex ?? 0,
        maxPerWallet: st ? st.maxPerWallet : null, label: label || 'public',
        type: st ? st.type : 'PUBLIC_SALE', startMs, endMs: st ? st.end : startMs + 36e5,
        priceEth: priceEth ?? 0, qty: Math.max(1, Number(qty) || 1),
        wallets: walletAddresses.map((_, i) => i),
        mintSig: (await mint.detect(providers[chain], ca, walletAddresses[0])).sig,
        mintName: (await mint.detect(providers[chain], ca, walletAddresses[0])).name,
        status: 'pending',
      };
      schedules.add(schedule);
      return json(res, 200, { id: schedule.id });
    }

    // ---- offers on a token ----
    if (url.pathname === '/api/offers' && req.method === 'POST') {
      const { slug, tokenId, chain, ca } = await post();
      const provider = providers[chain];
      const offers = await osoffers.listOffersWithOrders(slug, tokenId, OPENSEA_API_KEY, provider);
      const owned = await Promise.all(walletWallets.map(async ({ wallet, address }) => ({
        index: walletAddresses.indexOf(address), address,
        has: (await holdings.verifyOwned(new ethers.Contract(ca, ['function ownerOf(uint256) view returns (address)'], provider), address, [String(tokenId)])).has(String(tokenId)),
      })));
      return json(res, 200, {
        offers: offers.map((o, i) => ({ i, priceStr: o.priceStr, fundable: o.fundable !== false, nftQty: String(o.nftQty) })),
        walletIndex: (owned.find((o) => o.has) || {}).index,
      });
    }

    return json(res, 404, { error: 'unknown endpoint' });
  } catch (err) {
    return json(res, 500, { error: err.message.slice(0, 200) });
  }
});

if (PANEL_TOKEN) {
  server.listen(PORT, () => console.log(`panel: http://localhost:${PORT} (token auth)`));
} else {
  console.warn('panel: PANEL_TOKEN not set in .env — panel disabled, Telegram bot keeps running');
}
