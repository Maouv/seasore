const { ethers } = require('ethers');
const mint = require('./mint');
const minttx = require('./minttx');
const osmint = require('./osmint');
const fastmint = require('./fastmint');
const gasstrategy = require('./gasstrategy');

// deps: { PRIVATE_KEYS, OPENSEA_API_KEY, RPC_ENDPOINTS, mintSchedulesSlug, gasSettings } — injected
// so the pipeline can be tested against a mock RPC without booting the Telegram bot. gasSettings
// is optional (defaults to 'medium') so existing tests that don't pass it keep working unchanged.
function createPipeline({ PRIVATE_KEYS, OPENSEA_API_KEY, RPC_ENDPOINTS, mintSchedulesSlug, gasSettings = { strategy: 'medium' } }) {
  // ---- Mint pipeline: prepare (slow, can run ahead of time) -> refresh -> fire (hot path) ----
  // prepare/refresh do everything that doesn't need the stage to be open (fees, nonces, balances,
  // gas, pre-signed txs for routes whose calldata is known locally). fire only sends.
  const LOCAL_CALLDATA = process.env.FAST_LOCAL_CALLDATA === '1';
  // Per-chain knob with global fallback: MINT_TIP_GWEI_ETHEREUM beats MINT_TIP_GWEI.
  // Read at call time (not module load) so it can't leak from one chain's setting to another.
  const chainEnv = (name, chain) => process.env[`${name}_${String(chain).toUpperCase()}`] || process.env[name] || null;
  const gasOverride = (chain) => { const v = chainEnv('MINT_GAS_LIMIT', chain); return v ? BigInt(v) : null; };
  // Used when estimateGas can't run (stage not open yet / OS route). Unused gas isn't charged.
  const defaultGasLimit = (qty, chain) => gasOverride(chain) ?? (600000n + 250000n * BigInt(Math.max(0, qty - 1)));
  const NONCE_ERR = /nonce too low|nonce has already been used|already been used/i;
  // MINT_TIP_GWEI[_CHAIN] set explicitly always wins (manual override escape hatch). Otherwise,
  // pull a live tip off the Settings gas-strategy preset (slow/medium/fast) instead of a single
  // fixed number regardless of how busy the chain is right now — see lib/gasstrategy.js.
  async function resolveTipGwei(chain, rpcUrl) {
    const envTip = chainEnv('MINT_TIP_GWEI', chain);
    if (envTip) return envTip;
    const { gwei } = await gasstrategy.suggestTipGwei(rpcUrl, gasSettings.strategy);
    return gwei;
  }

  function fundsError(balance, gasLimit, fee, walletValue) {
    const maxGasCost = gasLimit * (fee.maxFeePerGas ?? fee.gasPrice) * 2n; // ×2: one 1.125-ish bump headroom
    if (balance >= walletValue + maxGasCost) return null;
    // decompose: price vs gas — tells the user WHICH knob is short (§I lesson)
    const have = Number(ethers.formatEther(balance));
    const needPrice = Number(ethers.formatEther(walletValue));
    const needGas = Number(ethers.formatEther(maxGasCost));
    const needed = walletValue + maxGasCost;
    const why = needPrice > 0 && have < needPrice
      ? `balance ${have.toFixed(6)} < mint price ${needPrice.toFixed(6)}`
      : `balance ${have.toFixed(6)} < price+gas reserve ${Number(ethers.formatEther(needed)).toFixed(6)} (price ${needPrice.toFixed(6)} + gas ${needGas.toFixed(6)})`;
    return `insufficient funds: ${why}`;
  }

  // Hard ceiling so a base-fee spike during a hot mint can never silently cost more than the
  // person explicitly agreed to (see chat: 0.03 ETH mint, 0.06 ETH fee — survived on luck, not by
  // design). Opt-in via MINT_MAX_GAS_ETH[_CHAIN]; unset = no cap (old behavior, unchanged).
  // Checked against gasLimit*maxFeePerGas — the actual protocol-guaranteed worst case per tx, so
  // what's really charged (base+tip at inclusion, always <= maxFeePerGas) can only be <= this.
  const chainGasCapWei = (chain) => {
    const v = chainEnv('MINT_MAX_GAS_ETH', chain);
    return v ? ethers.parseEther(v) : null;
  };
  function gasCapError(gasLimit, fee, chain) {
    const cap = chainGasCapWei(chain);
    if (cap == null) return null;
    const worstCase = gasLimit * (fee.maxFeePerGas ?? fee.gasPrice);
    if (worstCase <= cap) return null;
    return `gas cap exceeded: worst-case ${Number(ethers.formatEther(worstCase)).toFixed(6)} ETH > cap ${Number(ethers.formatEther(cap)).toFixed(6)} ETH — network too congested right now, skipped instead of overpaying`;
  }

  // For confirmation screens (schedule/mint summary): a REALISTIC estimate (current base fee +
  // tip, not the 2x-headroom worst case used for the hard cap above) plus that worst-case ceiling,
  // so the person sees both "likely cost" and "the most this could ever charge" before committing.
  async function estimateGasCost({ chainInput, gasLimit }) {
    const rpc = RPC_ENDPOINTS[chainInput] && RPC_ENDPOINTS[chainInput][0];
    if (!rpc) return null;
    const tipGwei = await resolveTipGwei(chainInput, rpc);
    const block = await fastmint.rpcCall(rpc, 'eth_getBlockByNumber', ['latest', false]).catch(() => null);
    if (!block || !block.baseFeePerGas) return null;
    const base = BigInt(block.baseFeePerGas);
    const tip = ethers.parseUnits(String(tipGwei), 'gwei');
    const likely = gasLimit * (base + tip);
    const worstCase = gasLimit * (base * 2n + tip);
    const cap = chainGasCapWei(chainInput);
    return {
      likelyEth: Number(ethers.formatEther(likely)),
      worstCaseEth: Number(ethers.formatEther(worstCase)),
      capEth: cap != null ? Number(ethers.formatEther(cap)) : null,
      tipGwei,
      baseFeeGwei: Number(base) / 1e9,
    };
  }

  function signCall(prep, item, call) {
    const tx = {
      to: call.to,
      data: call.data,
      value: call.value,
      nonce: item.nonce,
      chainId: prep.chainId,
      gasLimit: prep.gasLimit,
    };
    if (prep.fee.eip1559) {
      tx.type = 2;
      tx.maxFeePerGas = prep.fee.maxFeePerGas;
      tx.maxPriorityFeePerGas = prep.fee.maxPriorityFeePerGas;
    } else {
      tx.gasPrice = prep.fee.gasPrice;
    }
    return item.signer.signTransaction(tx);
  }

  // (Re)load fee/nonce/balance for every wallet and re-sign the txs whose calldata is known.
  // Also runs the RPC calls over the same fetch pool that fire uses, which keeps those sockets warm.
  async function refreshPrep(prep) {
    const rpc = prep.urls[0];
    // tip resolution (env override = instant, gas-strategy = one feeHistory call) races with the
    // balance/nonce fetch instead of blocking it — keeps this as fast as before the gas-strategy
    // wiring, since the many-wallet balance/nonce fetch is usually the slower side anyway.
    const [tipGwei, states] = await Promise.all([
      resolveTipGwei(prep.chainInput, rpc),
      Promise.all(prep.items.map((it) => Promise.all([fastmint.balanceOf(rpc, it.address), fastmint.nonceOf(rpc, it.address)]))),
    ]);
    const fee = await fastmint.feeSnapshot(rpc, tipGwei);
    prep.fee = fee;
    prep.items.forEach((it, i) => {
      [it.balance, it.nonce] = states[i];
      it.skip = gasCapError(prep.gasLimit, fee, prep.chainInput) || fundsError(it.balance, prep.gasLimit, fee, it.walletValue);
      it.signed = null;
    });
    await Promise.all(prep.items.map(async (it) => {
      if (!it.skip && it.call) it.signed = await signCall(prep, it, it.call);
    }));
    if (prep.route === 'os-api') osmint.warm(OPENSEA_API_KEY, prep.slug, Math.min(prep.items.length, 8));
    prep.preparedAt = Date.now();
  }

  async function prepareMint({ chainInput, ca, mintSig, mintName, priceWei, qty, indexes, seadrop = null, slug = null }) {
    const urls = RPC_ENDPOINTS[chainInput];
    if (!urls || !urls.length) throw new Error(`no RPC for ${chainInput}`);
    slug = slug || mintSchedulesSlug(ca, chainInput);
    const osRoute = !!(slug && OPENSEA_API_KEY);
    // OS API builds the calldata (only possible while the stage is open). Local routes know their
    // calldata up front, so they can be pre-signed. Local SeaDrop over OS route is opt-in
    // (FAST_LOCAL_CALLDATA=1) because it's unverified against what OS would build.
    const useLocalSeadrop = !!seadrop && (LOCAL_CALLDATA || !osRoute);
    const route = useLocalSeadrop ? 'seadrop-local' : osRoute ? 'os-api' : 'plain';
    const iface = new ethers.Interface([`function ${mintSig} payable`]);
    const walletValue = priceWei * BigInt(qty);

    const items = indexes.map((i) => {
      const signer = new ethers.Wallet(PRIVATE_KEYS[i]); // local signing only, no provider round trips
      const item = { signer, address: signer.address, walletValue, call: null, signed: null, skip: null };
      if (route === 'seadrop-local') {
        item.call = mint.seadropTx(ca, seadrop.feeRecipient, signer.address, priceWei, qty);
      } else if (route === 'plain') {
        item.call = { to: ca, data: iface.encodeFunctionData(mintName, mint.mintArgs(mintSig, signer.address, qty)), value: walletValue };
      }
      return item;
    });

    const prep = {
      chainInput, ca, urls, slug, route, priceWei, qty, items,
      chainId: await fastmint.chainId(urls[0]),
      gasLimit: defaultGasLimit(qty, chainInput),
      fee: null,
      preparedAt: 0,
    };
    // Tight gas limit only when calldata is known and estimate works (stage open); else the default.
    if (!gasOverride(chainInput) && items[0].call) {
      const c = items[0].call;
      prep.gasLimit = await fastmint
        .estimateGas(urls[0], { from: items[0].address, to: c.to, data: c.data, value: c.value })
        .then((g) => (g * 120n) / 100n)
        .catch(() => prep.gasLimit);
    }
    await refreshPrep(prep);
    return prep;
  }

  async function fireOne(prep, item, t0) {
    const base = { wallet: item.address };
    if (item.skip) return { ...base, status: 'skipped', error: item.skip };
    try {
      if (!item.signed) {
              // Prewarm poller may already have filled item.call (os-api) — sign langsung aja.
              // Fallback: OS builds the calldata (+ allowlist signature( for this exact wallet.
              if (!item.call) {
                const built = await minttx.buildTx(OPENSEA_API_KEY, prep.slug, item.address, prep.qty);
                if (!built.ok) return { ...base, status: 'failed', error: `OS mint: ${String(built.error).slice(0, 120)}` };
                item.call = { to: built.to, data: built.data, value: built.value };
              }
              item.signed = await signCall(prep, item, item.call);
            }
      const tSend = Date.now();
      let sent;
      try {
        sent = await fastmint.broadcastRaw(prep.urls, item.signed);
      } catch (err) {
        // pre-signed nonce went stale (wallet sent another tx since refresh): re-nonce once
        if (!NONCE_ERR.test(err.message)) throw err;
        item.nonce = await fastmint.nonceOf(prep.urls[0], item.address);
        item.signed = await signCall(prep, item, item.call);
        sent = await fastmint.broadcastRaw(prep.urls, item.signed);
      }
      const msPrep = tSend - t0;
      const msBroadcast = Date.now() - tSend;
      const receipt = await fastmint.waitReceipt(prep.urls, sent.hash, 60000);
      if (!receipt) return { ...base, status: 'pending', hash: sent.hash, msPrep, msBroadcast, sentAt: tSend };
      const block = Number(BigInt(receipt.blockNumber));
      const timing = { hash: sent.hash, msPrep, msBroadcast, msConfirm: Date.now() - t0, block, sentAt: tSend };
      if (receipt.status === '0x1') return { ...base, status: 'ok', ...timing };
      // reverted on-chain: try to decode why
      let reverted = `mint reverted on-chain (contract rejected at block ${block})`;
      const out = await fastmint.revertOutput(sent.via, sent.hash, { from: item.address, ...item.call }, block);
      const verdict = out ? mint.classifyRevert(out) : null;
      if (verdict && verdict.reason) reverted = `mint reverted: ${verdict.reason}`;
      return { ...base, status: 'failed', error: reverted, ...timing };
    } catch (err) {
      const msg = err && err.shortMessage ? err.shortMessage : err.message;
      return { ...base, status: 'failed', error: String(msg).slice(0, 150) };
    }
  }

  async function fireMint(prep) {
    const t0 = Date.now();
    const resultsP = Promise.all(prep.items.map((item) => fireOne(prep, item, t0)));
    const blockP = fastmint.blockNumber(prep.urls[0]).catch(() => null); // informational only
    const results = await resultsP;
    return { results, blockAtStart: await blockP };
  }


  return { prepareMint, refreshPrep, fireMint, estimateGasCost, defaultGasLimit };
}

module.exports = createPipeline;


