// ---- Mint flow: detect -> resolve stage -> qty/wallets -> summary -> fire ----
const path = require('path');
const fs = require('fs');
// bot.js: const mintFlow = require('./lib/mintflow')({ bot, sessionStore, providers, opensea, mint,
//   ethers, walletAddresses, walletWallets, OPENSEA_API_KEY, endAndReturnToMenu, shortAddr,
//   PRIVATE_KEYS, RPC_ENDPOINTS, mintSchedulesSlug });

module.exports = ({ bot, sessionStore, providers, opensea, mint, ethers, walletAddresses, walletWallets, OPENSEA_API_KEY, endAndReturnToMenu, shortAddr, PRIVATE_KEYS, RPC_ENDPOINTS, mintSchedulesSlug, gasSettings }) => {
  async function startMintDetection(chatId, session) {
    session.step = 'detecting_chain';
    sessionStore.setSession(chatId, session, bot);
    bot.sendMessage(chatId, 'Scanning chains for contract...');
    const present = await Promise.all(Object.entries(providers).map(async ([name, provider]) => {
      const code = await provider.getCode(session.data.contractAddress).catch(() => '0x');
      return [name, code !== '0x'];
    }));
    console.log(`mint chain detect ${session.data.contractAddress}:`, JSON.stringify(present));
    const live = present.filter(([, exists]) => exists).map(([name]) => name);
    if (live.length === 1) {
      bot.sendMessage(chatId, `Chain detected: ${live[0]}`);
      return resolveMint(chatId, session, live[0]);
    }
    if (live.length > 1) {
      session.step = 'awaiting_chain_pick';
      sessionStore.setSession(chatId, session, bot);
      return bot.sendMessage(chatId, 'Contract exists on multiple chains, pick one:', {
        reply_markup: { inline_keyboard: [live.map((name) => ({ text: name, callback_data: `chain_${name}` }))] },
      });
    }
    session.step = 'awaiting_chain';
    sessionStore.setSession(chatId, session, bot);
    bot.sendMessage(chatId, 'Contract not found on any configured chain. Chain manually (ethereum/polygon/base/arc/robinhood, d = ethereum):');
  }

  async function resolveMint(chatId, session, chainInput) {
    const provider = providers[chainInput];
    if (!provider) {
      console.log(`abort: no RPC for ${chainInput}`);
      return endAndReturnToMenu(chatId, `No RPC_URL configured for "${chainInput}" in .env, aborting`);
    }
    session.data.chainInput = chainInput;
    session.data.chain = opensea.CHAIN_MAP[chainInput];
    session.data.provider = provider;

    const minter = walletAddresses[0];
    const result = await mint.detect(provider, session.data.contractAddress, minter);
    console.log(`mint probe ${chainInput}:`, JSON.stringify(result, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
    if (result.error) return endAndReturnToMenu(chatId, result.error);
    // sold-out preflight before anything else (auth/elig/broadcast all wasted on a full drop)
    const supply = await mint.supplyCheck(provider, session.data.contractAddress);
    if (supply && supply.soldOut) {
      return endAndReturnToMenu(chatId, `${session.data.collection || shortAddr(session.data.contractAddress)} SOLD OUT — ${supply.total}/${supply.max} minted. Stopping early.`);
    }
    session.data.mintSig = result.sig;
    session.data.mintName = result.name;
    session.data.collection = await mint.collectionName(provider, session.data.contractAddress) || shortAddr(session.data.contractAddress);
    session.data.minted = result.minted;

    // SeaDrop collections: mintPublic route (mintSeaDrop is onlySeaDrop — direct EOA call always reverts).
    if (result.sig === 'mintSeaDrop(address,uint256)') {
      const sd = await mint.detectSeadrop(provider, session.data.contractAddress);
      if (sd && sd.feeRecipient) session.data.seadrop = sd;
    }

    const drop = await (async () => {
      try {
        const slug = await opensea.getCollectionSlug(chainInput, session.data.contractAddress, OPENSEA_API_KEY);
        session.data.slug = slug;
        return slug ? await mint.fetchDrop(slug) : null;
      } catch {
        return null;
      }
    })();

    if (drop && drop.stages.length > 0) {
      session.data.drop = drop;
      const active = mint.activeStage(drop);
      if (!active) {
        const elig = await mint.computeStageEligibility(drop, provider, session.data.contractAddress, walletWallets, session.data.mintSig, session.data.slug, OPENSEA_API_KEY);
        session.data.stageElig = elig;
        const upcomingPublic = drop.stages.some((s) => s.type === 'PUBLIC_SALE' && s.start > Date.now());
        session.step = 'mint_stages';
        sessionStore.setSession(chatId, session, bot);
        const keyboard = upcomingPublic
          ? [[{ text: 'Set schedule mint', callback_data: 'menu_sch' }, { text: 'Menu', callback_data: 'menu_home' }]]
          : [[{ text: 'Menu', callback_data: 'menu_home' }]];
        return bot.sendMessage(
          chatId,
          `${session.data.collection} — drop stages:\n${mint.describeStages(drop, elig)}\n\nNo stage open right now, come back when one starts.`,
          { reply_markup: { inline_keyboard: keyboard } },
        );
      }
      session.data.dropStage = active;
      // on-chain public drop wins over stale OS page data — ONLY for the public stage.
      // getPublicDrop describes the public stage; applying it to signed/allowlist stages corrupts their window.
      if (session.data.seadrop && active.type === 'PUBLIC_SALE') {
        const sd = session.data.seadrop;
        active.priceEth = Number(ethers.formatEther(sd.price));
        active.start = sd.start;
        active.end = sd.end;
        active.maxPerWallet = sd.maxPer;
      }
      const elig = await mint.computeStageEligibility(drop, provider, session.data.contractAddress, walletWallets, session.data.mintSig, session.data.slug, OPENSEA_API_KEY);
      session.data.stageElig = elig;
      const matrix = `${session.data.collection} — drop stages:\n${mint.describeStages(drop, elig)}`;
      const activeElig = elig.find((e) => e.stage.index === active.index);
      const upcomingPublic = drop.stages.some((s) => s.type === 'PUBLIC_SALE' && s.start > Date.now());
      if (!activeElig || activeElig.count === 0) {
        session.step = 'mint_stages';
        sessionStore.setSession(chatId, session, bot);
        const keyboard = upcomingPublic
          ? [[{ text: 'Set schedule mint', callback_data: 'menu_sch' }, { text: 'Menu', callback_data: 'menu_home' }]]
          : [[{ text: 'Menu', callback_data: 'menu_home' }]];
        return bot.sendMessage(chatId, matrix, { reply_markup: { inline_keyboard: keyboard } });
      }
      if (active.priceEth != null) {
        session.data.priceWei = ethers.parseEther(String(active.priceEth));
      } else {
        session.data.priceWei = result.price ?? 0n;
      }
      bot.sendMessage(chatId, matrix);
      return askMintQty(chatId, session);
    }

    if (!result.active && result.needsPrice) {
      session.step = 'awaiting_mint_price';
      sessionStore.setSession(chatId, session, bot);
      return bot.sendMessage(chatId, `Found ${result.name} (${session.data.collection}) but price not auto-detected (${result.reason}). Enter mint price (0 = free):`);
    }
    if (!result.active) {
      return endAndReturnToMenu(chatId, `Mint found (${session.data.collection}) but not available now: ${result.reason}`);
    }
    session.data.priceWei = result.price;
    askMintQty(chatId, session);
  }

  function askMintQty(chatId, session) {
    session.step = 'awaiting_mint_qty';
    sessionStore.setSession(chatId, session, bot);
    const stage = session.data.dropStage;
    const stageLine = stage ? `\nStage: ${stage.label} (${stage.type}), max ${stage.maxPerWallet ?? '?'}/wallet` : '';
    bot.sendMessage(chatId, `Mint detected: ${session.data.mintSig} at ${ethers.formatEther(session.data.priceWei)} each.${stageLine}\nHow many per wallet?`);
  }

  async function askMintWallets(chatId, session) {
    const balances = await Promise.all(walletAddresses.map((a) => session.data.provider.getBalance(a)));
    let eligible = null;
    const stageElig = session.data.dropStage && session.data.stageElig
      ? session.data.stageElig.find((x) => x.stage.index === session.data.dropStage.index)
      : null;
    if (stageElig && stageElig.reasons) {
      eligible = stageElig.reasons;
    } else if (session.data.dropStage && session.data.dropStage.type !== 'SIGNED_PRESALE') {
      // signed stages can't be simulated on-chain — OS eligibility only
      const sd = session.data.seadrop;
      if (sd) {
        // real route sim: SeaDrop.mintPublic — price per on-chain drop, not stage priceEth
        const price = session.data.priceWei;
        const reasons = await Promise.all(walletAddresses.map(async (a) => {
          const probe = await mint.probeSeadrop(session.data.provider, session.data.contractAddress, a, price, sd.feeRecipient, BigInt(session.data.mintQty));
          return { minter: a, ok: !!(probe && probe.active), reason: probe && probe.reason ? probe.reason : 'mint call reverted' };
        }));
        eligible = reasons;
      } else {
        eligible = await mint.checkEligibility(
          session.data.provider,
          session.data.contractAddress,
          walletAddresses,
          session.data.mintSig,
          session.data.priceWei,
        );
      }
    }
    const lines = walletAddresses.map((a, i) => {
      const bal = Number(ethers.formatEther(balances[i])).toFixed(4);
      const mark = eligible ? (eligible[i].ok ? ' eligible' : ` NOT eligible (${eligible[i].reason.slice(0, 60)})`) : '';
      return `${i + 1}. ${shortAddr(a)} — ${bal} native${mark}`;
    }).join('\n');
    session.step = 'awaiting_mint_wallets';
    sessionStore.setSession(chatId, session, bot);
    const head = eligible
      ? `Stage: ${session.data.dropStage.label} — eligibility (simulated on-chain):\n`
      : 'Wallet balance (native):\n';
    bot.sendMessage(chatId, `${head}${lines}\n\nWhich wallets mint? (e.g. 1,3 or all)`);
  }

  // Parses the "how many wallets" prompt for schedule_bulk_count. Supports:
  //   "3"      -> first 3 eligible wallets (original behavior, kept for back-compat)
  //   "2-3"    -> eligible wallets at position 2 through 3 (order shown on screen)
  //   "1,3"    -> eligible wallets at positions 1 and 3
  //   "1-2,4"  -> mix of ranges and singles
  // All numbers are 1-based positions in the ELIGIBLE list, not raw wallet numbers. Returns 0-based
  // positions into that list, or null if nothing valid was found (caller re-prompts on null).
  function parseBulkWalletSelector(text, maxN) {
    const parts = text.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length === 0) return null;
    const positions = new Set();
    for (const part of parts) {
      const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
      if (range) {
        let a = Number(range[1]), b = Number(range[2]);
        if (a > b) [a, b] = [b, a];
        for (let i = a; i <= b; i++) positions.add(i);
      } else if (/^\d+$/.test(part)) {
        // a single bare number with nothing else in the list still means "first N" (old behavior);
        // as one entry among several (e.g. "1,3") it means just that position.
        if (parts.length === 1) { for (let i = 1; i <= Number(part); i++) positions.add(i); }
        else positions.add(Number(part));
      } else {
        return null;
      }
    }
    const arr = [...positions];
    if (arr.length === 0 || arr.some((p) => !Number.isInteger(p) || p < 1 || p > maxN)) return null;
    return arr.sort((a, b) => a - b).map((p) => p - 1);
  }

  function parseMintWallets(text) {
    const answer = text.trim().toLowerCase();
    if (answer === 'all') return walletAddresses.map((_, i) => i);
    return answer
      .split(',')
      .map((part) => parseInt(part.trim(), 10) - 1)
      .filter((i) => Number.isInteger(i) && i >= 0 && i < walletAddresses.length);
  }

  async function goToMintSummary(chatId, session, indexes) {
    if (indexes.length === 0) return endAndReturnToMenu(chatId, 'Nothing selected, aborting');
    session.data.selections = indexes.map((i) => ({
      index: i,
      wallet: new ethers.Wallet(PRIVATE_KEYS[i], session.data.provider),
      qty: session.data.mintQty,
    }));
    const total = session.data.selections.reduce((sum, s) => sum + session.data.priceWei * BigInt(s.qty), 0n);
    const lines = session.data.selections
      .map((s) => `${shortAddr(s.wallet.address)}: mint ${s.qty} × ${ethers.formatEther(session.data.priceWei)} = ${ethers.formatEther(session.data.priceWei * BigInt(s.qty))}`)
      .join('\n');
    const mintedLine = session.data.minted != null ? `\nWallet[0] already minted: ${session.data.minted}` : '';
    const stageLine = session.data.dropStage ? `\nStage: ${session.data.dropStage.label} (${session.data.dropStage.type})` : '';
    session.step = 'awaiting_confirm';
    sessionStore.setSession(chatId, session, bot);

    // Same live gas estimate as the schedule confirmation screen — this fires immediately (not
    // hours from now), so the number is close to what will actually be charged.
    const nWallets = session.data.selections.length;
    const gasLimit = defaultGasLimit(session.data.mintQty, session.data.chainInput);
    let gasLine = 'Gas: unable to estimate right now (will still be checked live before firing)';
    try {
      const est = await estimateGasCost({ chainInput: session.data.chainInput, gasLimit });
      if (est) {
        const likelyAll = est.likelyEth * nWallets;
        const worstAll = est.worstCaseEth * nWallets;
        gasLine = `Gas (${nWallets} wallet${nWallets > 1 ? 's' : ''}, right now): ~${likelyAll.toFixed(6)} ETH likely, up to ${worstAll.toFixed(6)} ETH worst-case (tip ${est.tipGwei.toFixed(2)} gwei, base ${est.baseFeeGwei.toFixed(2)} gwei)`;
        if (est.capEth != null && est.worstCaseEth > est.capEth) {
          gasLine += `\n⚠️ Your gas cap is ${est.capEth} ETH/tx — at today's fees this would be SKIPPED, not fired.`;
        }
      }
    } catch (err) {
      console.error('goToMintSummary gas estimate failed:', err.message);
    }

    bot.sendMessage(chatId, `--- Mint Summary ---\n${session.data.collection}${stageLine}\n${lines}\nTotal: ${ethers.formatEther(total)} + gas\n${gasLine}${mintedLine}`, {
      reply_markup: {
        inline_keyboard: [[
          { text: 'Yes', callback_data: 'confirm_yes' },
          { text: 'No', callback_data: 'confirm_no' },
        ]],
      },
    });
  }

  const { prepareMint, refreshPrep, fireMint, estimateGasCost, defaultGasLimit } = require('./mintpipe')({ PRIVATE_KEYS, OPENSEA_API_KEY, RPC_ENDPOINTS, mintSchedulesSlug, gasSettings });

  async function runMint(provider, chainInput, ca, collection, mintSig, mintName, priceWei, qty, indexes, stageLabel, chatId, seadrop = null, prep = null, slug = null) {
    prep = prep || await prepareMint({ chainInput, ca, mintSig, mintName, priceWei, qty, indexes, seadrop, slug });
    const { results, blockAtStart } = await fireMint(prep);

    const count = (status) => results.filter((r) => r.status === status).length;
    const gw = (v) => Number(ethers.formatUnits(v, 'gwei')).toFixed(3);
    const feeTxt = prep.fee.eip1559 ? `maxFee ${gw(prep.fee.maxFeePerGas)} / tip ${gw(prep.fee.maxPriorityFeePerGas)} gwei` : `gasPrice ${gw(prep.fee.gasPrice)} gwei`;
    let text = `Mint done — ${collection}\nRoute: ${prep.route}. Fee: ${feeTxt}. Gas limit: ${prep.gasLimit}. Block at fire: ${blockAtStart ?? '?'}. Success: ${count('ok')}, failed: ${count('failed')}, skipped: ${count('skipped')}, pending: ${count('pending')}`;
    for (const r of results) {
      const timing = r.msBroadcast != null ? ` [${r.msPrep}ms build, ${r.msBroadcast}ms send${r.msConfirm != null ? `, ${r.msConfirm}ms total${r.block ? `, block ${r.block}` : ''}` : ''}]` : '';
      text += r.hash ? `\n${shortAddr(r.wallet)}: ${r.status} ${r.hash}${timing}` : `\n${shortAddr(r.wallet)}: ${r.error}`;
    }
    const historyPath = path.join(__dirname, 'mint-history.json');
    let history = [];
    try { history = JSON.parse(fs.readFileSync(historyPath, 'utf8')); } catch {}
    history.push({
      ts: new Date().toISOString(),
      chain: chainInput,
      ca,
      collection,
      stage: stageLabel || null,
      price: ethers.formatEther(priceWei),
      qtyPerWallet: qty,
      route: prep.route,
      blockAtStart,
      wallets: results.map((r) => ({
        addr: r.wallet,
        status: r.status,
        hash: r.hash || null,
        msPrep: r.msPrep ?? null,
        msBroadcast: r.msBroadcast ?? null,
        msConfirm: r.msConfirm ?? null,
        sentAt: r.sentAt ?? null,
        block: r.block ?? null,
        error: r.error || null,
      })),
    });
    fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));
    return { results, blockAtStart, text };
  }

  async function executeMint(chatId, session) {
    session.step = 'executing';
    sessionStore.setSession(chatId, session, bot);
    const indexes = session.data.selections.map((s) => s.index);
    bot.sendMessage(chatId, `Minting ${session.data.collection}: ${indexes.length} wallet(s)...`);
    const out = await runMint(
      session.data.provider,
      session.data.chainInput,
      session.data.contractAddress,
      session.data.collection,
      session.data.mintSig,
      session.data.mintName,
      session.data.priceWei,
      session.data.mintQty,
      indexes,
      session.data.dropStage ? session.data.dropStage.label : null,
      chatId,
      // SeaDrop.mintPublic only works for the public stage; signed/allowlist go via the OS route
      session.data.dropStage && session.data.dropStage.type !== 'PUBLIC_SALE' ? null : (session.data.seadrop || null),
      null,
      session.data.dropStage && session.data.dropStage.type !== 'PUBLIC_SALE' ? (session.data.slug || null) : null,
    );
    endAndReturnToMenu(chatId, out.text.slice(0, 3900));
  }

  return {
    startMintDetection, resolveMint, askMintQty, askMintWallets, parseBulkWalletSelector,
    parseMintWallets, goToMintSummary, runMint, executeMint, prepareMint, refreshPrep, estimateGasCost, defaultGasLimit,
  };
};

