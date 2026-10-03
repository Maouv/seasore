require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { ethers } = require('ethers');
const opensea = require('./lib/opensea');
const { ethUsdRate, usdStr } = require('./lib/ethusd');
const state = require('./lib/state');
const holdings = require('./lib/holdings');
const sessionStore = require('./lib/session');
const mint = require('./lib/mint');
const minttx = require('./lib/minttx');
const fastmint = require('./lib/fastmint');
const schedules = require('./lib/schedules');
const dropwatch = require('./lib/dropwatch');
const osoffers = require('./lib/osoffers');
const osauth = require('./lib/osauth');
const fs = require('fs');
const path = require('path');

function shortAddr(address) {
  return `${address.slice(0, 7)}...${address.slice(-5)}`;
}

// Display toggle:fastSettings.currency==='usdt' converts ETH amounts to USDT (cached rate).
// Falls back to ETH on any error — display never blocks a flow.
async function fmtAmt(v) {
  if (fastSettings.currency === 'usdt') {
    try { return usdStr(v, await ethUsdRate()); } catch (_) {}
  }
  return String(v);
}
const { OPENSEA_API_KEY, TELEGRAM_TOKEN, AUTHORIZED_USER_ID, PRIVATE_KEYS, providers, RPC_ENDPOINTS, walletAddresses, walletWallets, fastSettings, saveFastSettings, gasSettings, saveGasSettings, caMemory, rememberCa, mintSchedulesSlug } = state;
const gasstrategy = require('./lib/gasstrategy');

const CA_REGEX = /^0x[0-9a-fA-F]{40}$/;

const CONCURRENCY = Math.max(1, parseInt(process.env.LIST_CONCURRENCY, 10) || 3);
const LISTING_DURATION_DAYS = 7;



const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// Telegram calls are mostly fire-and-forget. A network blip (ECONNRESET/ETIMEDOUT) must be
// logged, not left as an unhandled rejection.
for (const method of ['sendMessage', 'answerCallbackQuery', 'editMessageText']) {
  const original = bot[method].bind(bot);
  bot[method] = (...args) => Promise.resolve(original(...args)).catch((err) => {
    console.log(`${method} failed:`, err.message);
  });
}

function isAuthorized(id) {
  return String(id) === String(AUTHORIZED_USER_ID);
}

function isBusy(chatId) {
  const s = sessionStore.getSession(chatId);
  return Boolean(s && s.step === 'executing');
}

function endAndReturnToMenu(chatId, notice, manageAddress) {
  sessionStore.endSession(chatId);
  showMainMenu(chatId, notice, manageAddress);
}

function showMainMenu(chatId, notice, manageAddress) {
  // idle: the menu is a resting state, it has no inactivity timer
  sessionStore.setSession(chatId, { flow: null, step: 'main_menu', data: {} }, bot, { idle: true });
  const text = notice ? `${notice}\n\nWhat do you want to do?` : 'What do you want to do?';
  const rows = [[
    { text: 'Fast List', callback_data: 'menu_fastlist' },
    { text: 'Listing', callback_data: 'menu_listing' },
    { text: 'Manage Listing', callback_data: 'menu_manage' },
  ]];
  rows.push([{ text: 'Mint', callback_data: 'menu_mint' }, { text: 'Schedule Mint', callback_data: 'menu_schedules' }]);
  rows.push([{ text: 'Settings', callback_data: 'menu_settings' }]);
  if (manageAddress) {
    rows.push([{ text: 'Manage this collection', callback_data: 'manage_recent' }]);
  }
  bot.sendMessage(chatId, text, {
    reply_markup: {
      inline_keyboard: rows,
    },
  });
}

function askCountForCurrentWallet(chatId, session) {
  const w = session.data.chosenWallets[session.data.walletCursor];
  bot.sendMessage(chatId, `How many from ${shortAddr(w.wallet.address)} (max ${w.items.length}, 0 to skip)?`);
}

function advanceWalletCursor(chatId, session) {
  session.data.walletCursor += 1;
  if (session.data.walletCursor < session.data.chosenWallets.length) {
    session.step = 'awaiting_count';
    sessionStore.setSession(chatId, session, bot);
    askCountForCurrentWallet(chatId, session);
  } else {
    goToSummary(chatId, session);
  }
}

function finalizeWalletSelection(chatId, session, wallet, count, price) {
  session.data.selections.push({
    wallet: wallet.wallet,
    items: wallet.items.slice(0, count),
    price,
  });
  advanceWalletCursor(chatId, session);
}

async function goToSummary(chatId, session) {
  if (session.data.selections.length === 0) {
    endAndReturnToMenu(chatId, 'Nothing selected, aborting');
    return;
  }

  let summary = '--- Summary ---\n';
  let totalGasEth = 0;

  if (session.flow === 'list') {
    await Promise.all(session.data.selections.map(async (selection) => {
      const gasInfo = await opensea.estimateApprovalGas(selection.wallet, session.data.contractAddress, session.data.provider, session.data.chain);
      selection.gasNeeded = gasInfo.needed;
      selection.gasCost = gasInfo.costEth;
    }));
    for (const selection of session.data.selections) {
      totalGasEth += selection.gasCost;
      summary += `${shortAddr(selection.wallet.address)}: list ${selection.items.length} NFT(s) at ${await fmtAmt(selection.price)} each${selection.gasNeeded ? ` (approval needed, ~${selection.gasCost.toFixed(5)} ETH gas)` : ''}\n`;
    }
    summary += `Estimated total approval gas: ~${totalGasEth.toFixed(5)} ETH`;
    const listedMap = session.data.listedMap || {};
    const alreadyListed = session.data.selections.reduce((sum, s) => sum + s.items.filter((id) => (listedMap[s.wallet.address] || []).includes(String(id))).length, 0);
    if (alreadyListed > 0) {
      summary += `\nWARN: ${alreadyListed} item(s) already have an active listing, listing again may double-list`;
    }
  } else if (session.mode === 'close') {
    for (const selection of session.data.selections) {
      summary += `${shortAddr(selection.wallet.address)}: close ${selection.items.length} listing(s), no gas\n`;
    }
  } else {
    for (const selection of session.data.selections) {
      summary += `${shortAddr(selection.wallet.address)}: reprice ${selection.items.length} listing(s) to ${await fmtAmt(selection.price)} each, no gas\n`;
    }
  }

  const skipConfirm = session.flow === 'list' && session.data.fast && fastSettings.confirm === false;
  const buttons = skipConfirm ? undefined : {
    reply_markup: {
      inline_keyboard: [[
        { text: 'Yes', callback_data: 'confirm_yes' },
        { text: 'No', callback_data: 'confirm_no' },
      ]],
    },
  };
  bot.sendMessage(chatId, skipConfirm ? `${summary.trim()}\n\nListing now (confirmation is OFF in settings)` : summary.trim(), buttons);

  if (skipConfirm) {
    session.step = 'executing';
    sessionStore.setSession(chatId, session, bot);
    await executeAction(chatId, session);
    return;
  }

  session.step = 'awaiting_confirm';
  sessionStore.setSession(chatId, session, bot);
}

// Sends up to CONCURRENCY listings at once. The OpenSea request rate itself is capped by the shared
// limiter in lib/opensea.js, so more concurrency only hides latency, it cannot exceed the limit.
async function runPool(jobs, worker, limit) {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    while (next < jobs.length) {
      const job = jobs[next];
      next += 1;
      await worker(job);
    }
  });
  await Promise.all(runners);
}

async function processItem(chatId, session, job, expirationTime) {
  const { selection, sdk, item } = job;
  // heartbeat: a long batch must not hit the 3 minute inactivity timeout mid-run
  sessionStore.setSession(chatId, session, bot);

  const tokenId = session.flow === 'list' ? item : item.tokenId;
  const base = { wallet: selection.wallet.address, tokenId };
  let cancelled = false;

  try {
    const stillOwned = await opensea.checkStillOwned(session.data.contractAddress, tokenId, selection.wallet.address, session.data.provider);
    if (!stillOwned) return { ...base, status: 'skipped' };

    const listingParams = {
      asset: { tokenId, tokenAddress: session.data.contractAddress },
      accountAddress: selection.wallet.address,
      amount: selection.price,
      expirationTime,
      zone: opensea.signedZone(session.data.chain),
    };
    if (session.flow === 'list') {
      for (const old of job.cancelListings || []) {
        await opensea.cancelListing(selection.wallet, old, session.data.chain);
      }
      if (job.cancelListings?.length > 0) {
        console.log(`cancelled ${job.cancelListings.length} old listing(s) for token ${tokenId} before relisting`);
      }
      await sdk.createListing(listingParams);
    } else if (session.mode === 'close') {
      for (const lst of item.allListings || [item]) {
        await opensea.cancelListing(selection.wallet, lst, session.data.chain);
      }
    } else if (Number(selection.price) < Number(item.priceDisplay)) {
      // Price goes DOWN:the new listing becomes the cheapest one, so cancelling the old (higher) one is
      // optional. List first (never a gap without a listing), then cancel off-chain on a best-effort basis.

      // An old listing without a signed zone cannot be cancelled off-chain;it is left to expire(no gas..
      await sdk.createListing(listingParams);
      let left =0;
      for (const lst of item.allListings || [item]) {
        try {
          await opensea.cancelListing(selection.wallet, lst, session.data.chain, { onchain: false });
        } catch (cancelErr) {
          left +=1;
        }
      }
      if (left > 0) return { ...base, status: 'ok', note: `${left} old higher listing(s) left active` };
    } else {
      // Price goes UP (or stays):the old cheaper listing would still be buyable, so it MUST be cancelled first..
      for (const lst of item.allListings || [item]) {
        await opensea.cancelListing(selection.wallet, lst, session.data.chain);
      }
      cancelled = true;
      await sdk.createListing(listingParams);
    }
    return { ...base, status: 'ok' };
  } catch (err) {
    const error = cancelled ? `old listing cancelled but relist failed: ${err.message}` : err.message;
    return { ...base, status: 'failed', error };
  }
}


function buildResultSummary(results, startedAt, statsBefore) {
  const count = (status) => results.filter((r) => r.status === status).length;
  const statsNow = opensea.getTransportStats();
  const seconds = Math.round((Date.now() - startedAt) / 1000);
  const rateLimited = statsNow.rateLimited - statsBefore.rateLimited;

  let text = `Done in ${seconds}s. Success: ${count('ok')}, failed: ${count('failed')}, skipped due to race condition: ${count('skipped')}`;
  text += `\nOpenSea rate limited: ${rateLimited}x (cap ${statsNow.capRps} req/s)`;

  const failed = results.filter((r) => r.status === 'failed');
  if (failed.length > 0) {
    const byError = new Map();
    for (const r of failed) {
      if (!byError.has(r.error)) byError.set(r.error, []);
      byError.get(r.error).push(r.tokenId);
    }
    text += '\n\nFailed:';
    for (const [error, ids] of [...byError].slice(0, 5)) {
      text += `\n${error}\n  tokens: ${ids.slice(0, 15).join(', ')}${ids.length > 15 ? ` (+${ids.length - 15} more)` : ''}`;
    }
  }

  const left = results.filter((r) => r.note).map((r) => r.tokenId);
  if (left.length > 0) {
    text += `\n\nRelisted cheaper, but the old higher listing could not be cancelled off-chain (no signed zone) and stays until it expires: ${left.slice(0, 15).join(', ')}${left.length > 15 ? ` (+${left.length - 15} more)` : ''}`;
  }

  const skipped = results.filter((r) => r.status === 'skipped').map((r) => r.tokenId);
  if (skipped.length > 0) {
    text += `\n\nSkipped (no longer owned): ${skipped.slice(0, 15).join(', ')}${skipped.length > 15 ? ` (+${skipped.length - 15} more)` : ''}`;
  }

  return text.slice(0, 3900);
}

async function executeAction(chatId, session) {
  session.step = 'executing';
  const expirationTime = Math.round(Date.now() / 1000 + 60 * 60 * 24 * LISTING_DURATION_DAYS);
  const startedAt = Date.now();
  const statsBefore = opensea.getTransportStats();

  const firstJobs = [];
  const restJobs = [];
  for (const selection of session.data.selections) {
    const sdk = opensea.makeSdk(selection.wallet, session.data.chain, OPENSEA_API_KEY);
    let cancelMap = {};
    if (session.flow === 'list') {
      const openListings = await opensea.getOpenListings(sdk, selection.wallet.address, session.data.slug, session.data.contractAddress, session.data.chain);
      cancelMap = openListings.reduce((map, l) => {
        (map[String(l.tokenId)] = map[String(l.tokenId)] || []).push({ orderHash: l.orderHash, protocolAddress: l.protocolAddress });
        return map;
      }, {});
    }
    selection.items.forEach((item, index) => {
      const job = { selection, sdk, item, cancelListings: cancelMap[String(item)] || [] };
      // A wallet that still needs the one-time approval does its FIRST listing alone. Otherwise
      // parallel listings would each send their own approval tx from the same wallet (same nonce).
      const warmUp = session.flow === 'list' && selection.gasNeeded && index === 0;
      (warmUp ? firstJobs : restJobs).push(job);
    });
  }

  const total = firstJobs.length + restJobs.length;
  const progressMsg = await bot.sendMessage(chatId, `Executing... 0/${total}`);
  const results = [];
  let lastEdit = Date.now();

  const worker = async (job) => {
    results.push(await processItem(chatId, session, job, expirationTime));
    const now = Date.now();
    if (progressMsg && now - lastEdit >= 4000) {
      lastEdit = now;
      bot.editMessageText(`Executing... ${results.length}/${total}`, { chat_id: chatId, message_id: progressMsg.message_id });
    }
  };

  await runPool(firstJobs, worker, CONCURRENCY);
  await runPool(restJobs, worker, CONCURRENCY);

  endAndReturnToMenu(chatId, buildResultSummary(results, startedAt, statsBefore), session.flow === 'list' ? session.data.contractAddress : null);
}

async function detectChainHoldings(address) {
  return Promise.all(Object.entries(providers).map(async ([name, provider]) => {
    const contract = new ethers.Contract(address, ['function balanceOf(address) view returns (uint256)'], provider);
    const balances = await Promise.all(walletAddresses.map((a) => contract.balanceOf(a).catch(() => 0n)));
    return [name, balances.reduce((sum, b) => sum + Number(b), 0)];
  }));
}

function resolveForFlow(chatId, session, chainInput) {
  if (session.flow === 'mint') return mintFlow.resolveMint(chatId, session, chainInput);
  if (session.flow === 'offer') return offerFlow.offerChainPick(chatId, session, chainInput);
  return resolveCollectionAndWallets(chatId, session, chainInput);
}

async function resolveCollectionAndWallets(chatId, session, chainInput) {
  const chain = opensea.CHAIN_MAP[chainInput];
  const provider = providers[chainInput];

  if (!provider) {
    console.log(`abort: no RPC for ${chainInput}`);
    endAndReturnToMenu(chatId, `No RPC_URL configured for "${chainInput}" in .env, aborting`);
    return;
  }

  console.log(`resolve chain=${chainInput} flow=${session.flow} mode=${session.mode}`);
  session.data.chainInput = chainInput;
  session.data.chain = chain;
  session.data.provider = provider;

  const slug = await opensea.getCollectionSlug(chainInput, session.data.contractAddress, OPENSEA_API_KEY);

  if (!slug) {
    console.log(`abort: no slug for ${session.data.contractAddress} on ${chainInput}`);
    endAndReturnToMenu(chatId, 'Could not resolve collection from this contract address, aborting');
    return;
  }

  session.data.slug = slug;
  rememberCa({ address: session.data.contractAddress, chain: chainInput, slug });
  bot.sendMessage(chatId, `Collection detected: ${slug}`);

  const readOnlySdk = opensea.makeSdk(provider, chain, OPENSEA_API_KEY);
  const floorPrice = await opensea.getFloorPrice(readOnlySdk, slug);

  if (!floorPrice || floorPrice <= 0) {
    endAndReturnToMenu(chatId, 'Floor price not found, aborting');
    return;
  }

  session.data.floorPrice = floorPrice;
  bot.sendMessage(chatId, `Floor price: ${await fmtAmt(floorPrice)}`);

  const listedMap = {};
  const walletsData = await Promise.all(PRIVATE_KEYS.map(async (pk) => {
    const wallet = new ethers.Wallet(pk, provider);
    const sdk = opensea.makeSdk(wallet, chain, OPENSEA_API_KEY);
    const notes = [];
    let items;

    if (session.flow === 'list') {
      // On-chain is the source of truth. OpenSea's indexer lags (sold NFTs linger, fresh mints
      // are missing), so it is only used to find candidates that are then verified on-chain.
      const result = await holdings.getHoldings({
        provider,
        contractAddress: session.data.contractAddress,
        wallet: wallet.address,
        loadCandidates: (balance) => opensea.getOwnedTokenIds(sdk, wallet.address, session.data.contractAddress, { stopAt: balance }),
      });
      items = result.ids;
      notes.push(...result.warnings);
      if (result.complete === false) {
        notes.push(`on-chain balance is ${result.balance} but only ${result.ids.length} found, recent NFTs may be missing`);
      }
      const activeListings = await opensea.getOpenListings(sdk, wallet.address, slug, session.data.contractAddress, chain);
      listedMap[wallet.address] = activeListings.map((l) => String(l.tokenId));
    } else {
      const listings = await opensea.getOpenListings(sdk, wallet.address, slug, session.data.contractAddress, chain);
      const verified = await holdings.filterOwned(provider, session.data.contractAddress, wallet.address, listings, (l) => l.tokenId);
      const byToken = new Map();
      for (const l of verified.items) {
        const key = String(l.tokenId);
        const cur = byToken.get(key);
        if (cur) {
          cur.allListings.push(l);
          if (Number(l.priceDisplay) < Number(cur.priceDisplay)) cur.priceDisplay = l.priceDisplay;
        } else {
          byToken.set(key, { ...l, allListings: [l], priceDisplay: Number(l.priceDisplay) });
        }
      }
      items = [...byToken.values()];
      if (verified.items.length > items.length) {
        notes.push(`${verified.items.length - items.length} extra stacked listing(s) on the same token(s) (counted once)`);
      }
      if (verified.removed > 0) {
        notes.push(`${verified.removed} stale listing(s) hidden, token no longer owned`);
      }
    }

    return { wallet, items, notes };
  }));

  session.data.walletsData = walletsData;
  session.data.listedMap = listedMap;

  const verb = session.flow === 'list' ? 'holds' : 'lists';
  let menuText = '';
  walletsData.forEach((w, i) => {
    const listedCount = (listedMap[w.wallet.address] || []).length;
    menuText += `${i + 1}. ${shortAddr(w.wallet.address)} ${verb} ${w.items.length} NFT(s) from this collection${listedCount > 0 ? ` (${listedCount} already listed)` : ''}\n`;
    w.notes.forEach((note) => { menuText += `   note: ${note}\n`; });
  });
  bot.sendMessage(chatId, menuText.trim());

  if (session.flow === 'list' && session.data.fast) {
    const rawPrice = opensea.parsePriceInput(fastSettings.price, session.data.floorPrice);
    const price = opensea.roundPriceForChain(rawPrice, chainInput);

    if (!Number.isFinite(price) || price <= 0) {
      endAndReturnToMenu(chatId, `Invalid fast list price in settings (${fastSettings.price}), fix it in Settings`);
      return;
    }

    const scoped = walletsData.filter((w) => w.items.length > 0 && fastSettings.wallets[w.wallet.address] !== false);
    session.data.selections = scoped.map((w) => ({ wallet: w.wallet, items: w.items, price }));
    console.log(`fast list: ${session.data.selections.length} wallet(s), price=${price}`);

    if (session.data.selections.length === 0) {
      endAndReturnToMenu(chatId, 'No wallet enabled in Fast List settings, aborting');
      return;
    }

    await goToSummary(chatId, session);
    return;
  }

  if (session.flow === 'list') {
    session.step = 'awaiting_list_mode';
    sessionStore.setSession(chatId, session, bot);
    bot.sendMessage(chatId, 'Listing mode:', {
      reply_markup: {
        inline_keyboard: [[
          { text: 'Separate List', callback_data: 'mode_separate' },
          { text: 'Bulk List', callback_data: 'mode_bulk' },
        ]],
      },
    });
    return;
  }

  enterWalletPick(chatId, session);
}

function enterWalletPick(chatId, session) {
  const menuNumbers = session.data.walletsData.map((_, i) => i + 1).join('/');
  session.step = 'awaiting_wallet_pick';
  sessionStore.setSession(chatId, session, bot);
  bot.sendMessage(chatId, `Which one you want to ${session.mode} (${menuNumbers}/all)?`);
}

function showFastSettings(chatId) {
  sessionStore.setSession(chatId, { flow: null, step: 'awaiting_settings', data: {} }, bot);
  const rows = [[{ text: `Price: ${fastSettings.price}`, callback_data: 'set_price' }]];
  rows.push([{ text: `Currency: ${fastSettings.currency === 'usdt' ? 'USDT' : 'ETH'}`, callback_data: 'set_currency' }]);
  rows.push([{ text: `Confirmation: ${fastSettings.confirm === false ? 'OFF' : 'ON'}`, callback_data: 'set_confirm' }]);
  PRIVATE_KEYS.forEach((pk, i) => {
    const address = new ethers.Wallet(pk).address;
    const on = fastSettings.wallets[address] !== false;
    rows.push([{ text: `${shortAddr(address)}: ${on ? 'ON' : 'OFF'}`, callback_data: `setw_${i}` }]);
  });
  rows.push([{ text: `Gas: ${gasSettings.strategy}`, callback_data: 'set_gas' }]);
  rows.push([{ text: 'Done', callback_data: 'set_done' }]);
  bot.sendMessage(chatId, 'Fast List settings — tap a wallet to toggle, price applies to every enabled wallet:', {
    reply_markup: { inline_keyboard: rows },
  });
}

function showGasSettings(chatId) {
  const rows = Object.entries(gasstrategy.PRESETS).map(([key, p]) => [
    { text: `${key === gasSettings.strategy ? '✓ ' : ''}${p.label}`, callback_data: `gas_${key}` },
  ]);
  rows.push([{ text: 'Back', callback_data: 'menu_settings' }]);
  bot.sendMessage(
    chatId,
    'Gas strategy — sets the priority fee for every mint that doesn\'t have MINT_TIP_GWEI set manually in .env. Reads live fee data each time, not a fixed number:',
    { reply_markup: { inline_keyboard: rows } },
  );
}

function promptContract(chatId, session) {
  session.step = 'awaiting_contract';
  sessionStore.setSession(chatId, session, bot);
  const rows = caMemory.map((e, i) => [{ text: `${e.slug} (${e.chain})`, callback_data: `mem_${i}` }]);
  bot.sendMessage(chatId, rows.length ? 'Contract address, or pick recent:' : 'Contract address:', rows.length ? { reply_markup: { inline_keyboard: rows } } : undefined);
}

async function startDetection(chatId, session) {
  if (session.flow === 'mint') return mintFlow.startMintDetection(chatId, session);
  session.step = 'detecting_chain';
  sessionStore.setSession(chatId, session, bot);
  bot.sendMessage(chatId, 'Scanning chains...');
  const counts = await detectChainHoldings(session.data.contractAddress);
  console.log(`detect ${session.data.contractAddress}:`, JSON.stringify(counts));
  const withHoldings = counts.filter(([, total]) => total > 0);
  if (withHoldings.length === 1) {
    bot.sendMessage(chatId, `Chain detected: ${withHoldings[0][0]} (${withHoldings[0][1]} NFT)`);
    await resolveCollectionAndWallets(chatId, session, withHoldings[0][0]);
  } else if (withHoldings.length > 1) {
    session.step = 'awaiting_chain_pick';
    sessionStore.setSession(chatId, session, bot);
    bot.sendMessage(chatId, 'Holdings on multiple chains, pick one:', {
      reply_markup: {
        inline_keyboard: [
          withHoldings.map(([name, total]) => ({ text: `${name} (${total})`, callback_data: `chain_${name}` })),
        ],
      },
    });
  } else {
    session.step = 'awaiting_chain';
    sessionStore.setSession(chatId, session, bot);
    bot.sendMessage(chatId, 'No holdings found on any configured chain. Chain manually (ethereum/polygon/base/arc/robinhood, d = ethereum):');
  }
}

const mintFlow = require('./lib/mintflow')({ bot, sessionStore, providers, opensea, mint, ethers, walletAddresses, walletWallets, OPENSEA_API_KEY, endAndReturnToMenu, shortAddr, PRIVATE_KEYS, RPC_ENDPOINTS, mintSchedulesSlug, gasSettings });

// ---- Acc offer flow: paste CA -> owned tokens -> offers -> accept ----

const OF_PAGE = 5;

// token ids held by each wallet on chain, plus chain pick for multi-chain CA
const offerFlow = require('./lib/offerflow')({ bot, sessionStore, opensea, OPENSEA_API_KEY, providers, rememberCa, mint, holdings, PRIVATE_KEYS, ethers, osauth, osoffers, OF_PAGE, endAndReturnToMenu, shortAddr, detectChainHoldings, fastSettings });
const bulkOffer = require('./lib/bulkoffer')({ bot, sessionStore, osoffers, osauth, opensea, OPENSEA_API_KEY, OF_PAGE, endAndReturnToMenu, shortAddr, fastSettings });

const scheduleMod = require('./lib/schedule')({ bot, sessionStore, schedules, mint, ethers, providers, fastmint, walletAddresses, endAndReturnToMenu, shortAddr, runMint: mintFlow.runMint, prepareMint: mintFlow.prepareMint, refreshPrep: mintFlow.refreshPrep, estimateGasCost: mintFlow.estimateGasCost, defaultGasLimit: mintFlow.defaultGasLimit });

// resolve chain ids once at boot so the first mint doesn't pay for eth_chainId
Object.values(RPC_ENDPOINTS).forEach((urls) => fastmint.chainId(urls[0]).catch(() => {}));

async function handleStep(chatId, session, text) {
  switch (session.step) {
    case 'awaiting_contract': {
      const address = text.trim();
      if (!ethers.isAddress(address)) {
        bot.sendMessage(chatId, 'Not a valid contract address, try again:');
        return;
      }
      session.data.contractAddress = address;
      await startDetection(chatId, session);
      break;
    }

    case 'awaiting_chain': {
      const rawChain = (text || '').trim().toLowerCase();
      const chainInput = rawChain === 'd' ? 'ethereum' : rawChain;

      if (!opensea.CHAIN_MAP[chainInput]) {
        bot.sendMessage(chatId, 'Unsupported chain, try again:');
        return;
      }

      await resolveForFlow(chatId, session, chainInput);
      break;
    }

    case 'awaiting_mint_price': {
      let wei = null;
      try {
        wei = ethers.parseEther(text.trim());
      } catch {}
      if (wei === null || wei < 0n) {
        bot.sendMessage(chatId, 'Invalid price, try again (0 = free):');
        return;
      }
      const check = await mint.checkWithPrice(session.data.provider, session.data.contractAddress, walletAddresses[0], session.data.mintSig, wei);
      if (!check.active && session.data.seadrop) {
        const probe = await mint.probeSeadrop(session.data.provider, session.data.contractAddress, walletAddresses[0], wei, session.data.seadrop.feeRecipient, 1n);
        if (probe && probe.active) check.active = true;
        else check.reason = probe && probe.reason ? probe.reason : check.reason;
      }
      if (!check.active) {
        endAndReturnToMenu(chatId, `Mint still not available: ${check.reason}`);
        return;
      }
      session.data.priceWei = wei;
      session.data.collection = session.data.collection || await mint.collectionName(session.data.provider, session.data.contractAddress) || shortAddr(session.data.contractAddress);
      mintFlow.askMintQty(chatId, session);
      break;
    }

    case 'awaiting_mint_qty': {
      const qty = parseInt(text, 10);
      if (!Number.isInteger(qty) || qty < 1 || qty > 100) {
        bot.sendMessage(chatId, 'Enter a count between 1 and 100:');
        return;
      }
      session.data.mintQty = qty;
      await mintFlow.askMintWallets(chatId, session);
      break;
    }

    case 'awaiting_mint_wallets': {
      await mintFlow.goToMintSummary(chatId, session, mintFlow.parseMintWallets(text));
      break;
    }

    case 'awaiting_offer_token': {
      const raw = text.trim().replace(/^#/, '');
      const all = session.data.owned.flatMap((w) => w.ids.map(String));
      if (!all.includes(raw)) {
        bot.sendMessage(chatId, `Token id not held (${all.length} held, e.g. ${all[0]}), try again:`);
        return;
      }
      session.data.offerTokenId = raw;
      await offerFlow.showTokenOffers(chatId, session);
      break;
    }

    case 'schedule_manage_qty': {
      const qty = parseInt(text, 10);
      const s = schedules.list().find((x) => x.id === session.data.schdId);
      if (!s) return endAndReturnToMenu(chatId, 'Schedule already fired/cancelled.');
      const max = s.maxPerWallet ?? 100;
      if (!Number.isInteger(qty) || qty < 1 || qty > max) {
        bot.sendMessage(chatId, `Enter a count between 1 and ${max}:`);
        return;
      }
      s.qty = qty;
      const all = JSON.parse(fs.readFileSync(path.join(__dirname, 'mint-schedules.json'), 'utf8'));
      const ent = all.find((x) => x.id === s.id);
      if (ent) { ent.qty = qty; fs.writeFileSync(path.join(__dirname, 'mint-schedules.json'), JSON.stringify(all, null, 2)); }
      return scheduleMod.showScheduleDetail(chatId, session, s.id);
    }

    case 'schedule_bulk_count': {
      const eligReasons = scheduleMod.stageReasons(session, session.data.schStage);
      const eligIdx = eligReasons
        ? eligReasons.map((r, i) => (r.ok ? i : -1)).filter((i) => i >= 0)
        : walletAddresses.map((_, i) => i);
      const positions = mintFlow.parseBulkWalletSelector(text, eligIdx.length);
      if (!positions) {
        bot.sendMessage(
          chatId,
          `Only ${eligIdx.length}/${walletAddresses.length} wallet(s) eligible for this stage. ` +
            `Enter a count (e.g. 2), a range (e.g. 1-3), or a list (e.g. 1,3) — up to ${eligIdx.length}:`,
        );
        return;
      }
      session.data.schSel = positions.map((p) => eligIdx[p]);
      await scheduleMod.askSchQty(chatId, session);
      break;
    }

    case 'schedule_qty': {
      const max = session.data.schStage.maxPerWallet ?? 100;
      const qty = parseInt(text, 10);
      if (!Number.isInteger(qty) || qty < 1 || qty > max) {
        bot.sendMessage(chatId, `Enter a count between 1 and ${max}:`);
        return;
      }
      session.data.schQty = qty;
      scheduleMod.schConfirm(chatId, session);
      break;
    }

    case 'schedule_sep': {
      const nums = text.split(',').map((p) => parseInt(p.trim(), 10) - 1);
      const valid = nums.filter((i) => Number.isInteger(i) && i >= 0 && i < walletAddresses.length);
      if (valid.length === 0) {
        bot.sendMessage(chatId, 'No valid wallet numbers, try again (e.g. 1, 7, 8):');
        return;
      }
      const sel = new Set(session.data.schSel);
      for (const i of valid) {
        if (sel.has(i)) sel.delete(i);
        else sel.add(i);
      }
      session.data.schSel = [...sel].sort((a, b) => a - b);
      scheduleMod.renderSchSepPage(chatId, session);
      break;
    }

    case 'awaiting_wallet_pick': {
      const answer = text.trim().toLowerCase();
      let chosen;

      if (answer === 'all') {
        chosen = session.data.walletsData.filter((w) => w.items.length > 0);
        const excluded = session.data.walletsData.length - chosen.length;
        if (excluded > 0) {
          bot.sendMessage(chatId, `Excluded ${excluded} wallet(s) with no NFTs from this collection`);
        }
      } else {
        const idx = parseInt(answer, 10) - 1;
        const picked = session.data.walletsData[idx];

        if (!picked || picked.items.length === 0) {
          endAndReturnToMenu(chatId, 'Invalid selection or wallet has no NFTs, aborting');
          return;
        }

        chosen = [picked];
      }

      session.data.chosenWallets = chosen;
      session.data.selections = [];
      session.data.walletCursor = 0;
      session.step = 'awaiting_count';
      sessionStore.setSession(chatId, session, bot);
      askCountForCurrentWallet(chatId, session);
      break;
    }

    case 'awaiting_count': {
      const currentWallet = session.data.chosenWallets[session.data.walletCursor];
      const count = Math.min(parseInt(text, 10) || 0, currentWallet.items.length);

      if (count === 0) {
        advanceWalletCursor(chatId, session);
        return;
      }

      session.data.currentCount = count;

      if (session.flow === 'list' || session.mode === 'reprice') {
        session.step = 'awaiting_price';
        sessionStore.setSession(chatId, session, bot);
        bot.sendMessage(chatId, 'Price per NFT: enter a number, or a % like -40% for discount off floor (d = floor -10%):');
      } else {
        finalizeWalletSelection(chatId, session, currentWallet, count, null);
      }
      break;
    }

    case 'awaiting_price': {
      const currentWallet = session.data.chosenWallets[session.data.walletCursor];
      const rawPrice = opensea.parsePriceInput(text, session.data.floorPrice);
      const price = opensea.roundPriceForChain(rawPrice, session.data.chain);

      if (!Number.isFinite(price) || price <= 0) {
        bot.sendMessage(chatId, 'Invalid price (use a number > 0, a % like -40%, or d), try again:');
        return;
      }

      finalizeWalletSelection(chatId, session, currentWallet, session.data.currentCount, price);
      break;
    }

    case 'awaiting_settings_price': {
      const raw = opensea.parsePriceInput(text, 1);
      if (!Number.isFinite(raw)) {
        bot.sendMessage(chatId, 'Invalid (use a number or % like -40%), try again:');
        return;
      }
      fastSettings.price = text.trim();
      saveFastSettings();
      showFastSettings(chatId);
      break;
    }

    case 'awaiting_bulk_count': {
      const maxTotal = session.data.walletsData.reduce((sum, w) => sum + w.items.length, 0);
      const count = Math.min(parseInt(text, 10) || 0, maxTotal);

      if (count === 0) {
        endAndReturnToMenu(chatId, 'Nothing selected, aborting');
        return;
      }

      session.data.bulkCount = count;
      session.step = 'awaiting_bulk_price';
      sessionStore.setSession(chatId, session, bot);
      bot.sendMessage(chatId, 'Price per NFT: enter a number, or a % like -40% for discount off floor (d = floor -10%):');
      break;
    }

    case 'awaiting_bulk_price': {
      const rawPrice = opensea.parsePriceInput(text, session.data.floorPrice);
      const price = opensea.roundPriceForChain(rawPrice, session.data.chain);

      if (!Number.isFinite(price) || price <= 0) {
        bot.sendMessage(chatId, 'Invalid price (use a number > 0, a % like -40%, or d), try again:');
        return;
      }

      session.data.selections = [];
      let remaining = session.data.bulkCount;
      for (const w of session.data.walletsData) {
        if (remaining <= 0) break;
        const take = Math.min(remaining, w.items.length);
        if (take > 0) {
          session.data.selections.push({ wallet: w.wallet, items: w.items.slice(0, take), price });
          remaining -= take;
        }
      }

      if (session.data.selections.length === 0) {
        endAndReturnToMenu(chatId, 'Nothing selected, aborting');
        return;
      }

      await goToSummary(chatId, session);
      break;
    }

    default:
      break;
  }
}

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  if (!isAuthorized(msg.from.id)) return console.log(`start unauthorized: ${msg.from.id}`);
  if (isBusy(chatId)) return bot.sendMessage(chatId, 'Still executing, please wait until it finishes');
  try {
    showMainMenu(chatId);
  } catch (err) {
    console.log('start handler error:', err.message);
  }
});

bot.onText(/\/manage-listing/, (msg) => {
  const chatId = msg.chat.id;
  if (!isAuthorized(msg.from.id)) return;
  if (isBusy(chatId)) return bot.sendMessage(chatId, 'Still executing, please wait until it finishes');
  sessionStore.setSession(chatId, { flow: 'manage', step: 'awaiting_mode', data: {} }, bot);
  bot.sendMessage(chatId, 'Choose action:', {
    reply_markup: {
      inline_keyboard: [[
        { text: 'Reprice', callback_data: 'mode_reprice' },
        { text: 'Close', callback_data: 'mode_close' },
      ]],
    },
  });
});

bot.on('polling_error', (err) => console.log('polling_error:', err.code, err.message));

bot.on('callback_query', async (query) => {
  console.log(`cb received: ${query.data}`);
  const chatId = query.message.chat.id;

  try {
    await handleCallback(chatId, query);
  } catch (err) {
    console.log(`callback error ${query.data}:`, err.message);
    try { await bot.answerCallbackQuery(query.id, { text: 'Error' }); } catch {}
    endAndReturnToMenu(chatId, `Error: ${err.message}`);
  }
});

async function handleCallback(chatId, query) {
  if (!isAuthorized(query.from.id)) {
    return bot.answerCallbackQuery(query.id, { text: 'Unauthorized' });
  }

  // Menu buttons always work, even on an old menu message or after a restart/timeout.
  if (['menu_listing', 'menu_manage', 'menu_fastlist', 'menu_settings', 'menu_mint', 'menu_schedules'].includes(query.data)) {
    console.log(`menu tap: ${query.data}`);
    if (isBusy(chatId)) {
      return bot.answerCallbackQuery(query.id, { text: 'Still executing, please wait' });
    }

    await bot.answerCallbackQuery(query.id);

    if (query.data === 'menu_listing') {
      const session = { flow: 'list', step: 'awaiting_contract', data: {} };
      sessionStore.setSession(chatId, session, bot);
      return promptContract(chatId, session);
    }

    if (query.data === 'menu_mint') {
      const session = { flow: 'mint', step: 'awaiting_contract', data: {} };
      sessionStore.setSession(chatId, session, bot);
      return promptContract(chatId, session);
    }

    if (query.data === 'menu_fastlist') {
      sessionStore.setSession(chatId, { flow: 'list', step: 'awaiting_contract', data: { fast: true } }, bot);
      return promptContract(chatId, { flow: 'list', step: 'awaiting_contract', data: { fast: true } });
    }

    if (query.data === 'menu_settings') {
      return showFastSettings(chatId);
    }

    if (query.data === 'menu_schedules') {
      return scheduleMod.showScheduleList(chatId, sessionStore.getSession(chatId));
    }

    sessionStore.setSession(chatId, { flow: 'manage', step: 'awaiting_mode', data: {} }, bot);
    return bot.sendMessage(chatId, 'Choose action:', {
      reply_markup: {
        inline_keyboard: [[
          { text: 'Reprice', callback_data: 'mode_reprice' },
          { text: 'Close', callback_data: 'mode_close' },
        ]],
      },
    });
  }

  if (query.data === 'manage_recent') {
    if (isBusy(chatId)) {
      return bot.answerCallbackQuery(query.id, { text: 'Still executing, please wait' });
    }
    const recent = caMemory[0];
    if (!recent) {
      return bot.answerCallbackQuery(query.id, { text: 'No recent collection yet' });
    }
    await bot.answerCallbackQuery(query.id);
    sessionStore.setSession(chatId, { flow: 'manage', step: 'awaiting_mode', data: { contractAddress: recent.address } }, bot);
    return bot.sendMessage(chatId, `Manage ${recent.slug} (${recent.chain}):`, {
      reply_markup: {
        inline_keyboard: [[
          { text: 'Reprice', callback_data: 'mode_reprice' },
          { text: 'Close', callback_data: 'mode_close' },
        ]],
      },
    });
  }

  const session = sessionStore.getSession(chatId);

  // Stale button (session timed out / bot restarted): recover to the menu instead of a dead end.
  if (!session) {
    await bot.answerCallbackQuery(query.id, { text: 'Session expired' });
    return showMainMenu(chatId);
  }

  if (query.data === 'mode_reprice' || query.data === 'mode_close') {
    if (session.step !== 'awaiting_mode') {
      return bot.answerCallbackQuery(query.id, { text: 'Button no longer valid' });
    }
    session.mode = query.data === 'mode_reprice' ? 'reprice' : 'close';
    await bot.answerCallbackQuery(query.id);
    if (session.data.contractAddress) {
      return startDetection(chatId, session);
    }
    return promptContract(chatId, session);
  }

  if (query.data === 'start_list' || query.data === 'start_manage' || query.data === 'start_mint' || query.data === 'start_offer') {
    if (session.step !== 'awaiting_start_mode') {
      return bot.answerCallbackQuery(query.id, { text: 'Button no longer valid' });
    }
    await bot.answerCallbackQuery(query.id);
    if (query.data === 'start_list') {
      session.flow = 'list';
      return startDetection(chatId, session);
    }
    if (query.data === 'start_mint') {
      session.flow = 'mint';
      return startDetection(chatId, session);
    }
    if (query.data === 'start_offer') {
      session.flow = 'offer';
      return offerFlow.startOfferFlow(chatId, session);
    }
    if (query.data === 'start_fastlist') {
      session.flow = 'list';
      session.data.fast = true;
      return startDetection(chatId, session);
    }
    session.flow = 'manage';
    session.step = 'awaiting_mode';
    sessionStore.setSession(chatId, session, bot);
    return bot.sendMessage(chatId, 'Choose action:', {
      reply_markup: {
        inline_keyboard: [[
          { text: 'Reprice', callback_data: 'mode_reprice' },
          { text: 'Close', callback_data: 'mode_close' },
        ]],
      },
    });
  }

  if (query.data.startsWith('mem_')) {
    if (session.step !== 'awaiting_contract') {
      return bot.answerCallbackQuery(query.id, { text: 'Button no longer valid' });
    }
    const entry = caMemory[Number(query.data.slice(4))];
    if (!entry) {
      return bot.answerCallbackQuery(query.id, { text: 'Not found' });
    }
    await bot.answerCallbackQuery(query.id);
    session.data.contractAddress = entry.address;
    return startDetection(chatId, session);
  }

  if (query.data === 'set_price' || query.data === 'set_currency' || query.data === 'set_confirm' || query.data === 'set_done' || query.data === 'set_gas' || query.data.startsWith('setw_') || query.data.startsWith('gas_')) {
    if (!session || session.step !== 'awaiting_settings') {
      return bot.answerCallbackQuery(query.id, { text: 'Button no longer valid' });
    }
    await bot.answerCallbackQuery(query.id);

    if (query.data === 'set_gas') {
      return showGasSettings(chatId);
    }

    if (query.data.startsWith('gas_')) {
      const strategy = query.data.slice(4);
      if (!gasstrategy.PRESETS[strategy]) return bot.answerCallbackQuery(query.id, { text: 'Unknown preset' });
      gasSettings.strategy = strategy;
      saveGasSettings();
      return showFastSettings(chatId);
    }

    if (query.data === 'set_currency') {
      fastSettings.currency = fastSettings.currency === 'usdt' ? 'eth' : 'usdt';
      saveFastSettings();
      return showFastSettings(chatId);
    }

    if (query.data === 'set_price') {
      session.step = 'awaiting_settings_price';
      sessionStore.setSession(chatId, session, bot);
      return bot.sendMessage(chatId, 'New price: a number, or % off floor like -40%:');
    }

    if (query.data.startsWith('setw_')) {
      const address = new ethers.Wallet(PRIVATE_KEYS[Number(query.data.slice(5))]).address;
      fastSettings.wallets[address] = fastSettings.wallets[address] === false;
      saveFastSettings();
      return showFastSettings(chatId);
    }

    if (query.data === 'set_confirm') {
      fastSettings.confirm = fastSettings.confirm === false;
      saveFastSettings();
      return showFastSettings(chatId);
    }

    return showMainMenu(chatId, 'Fast List settings saved');
  }

  if (query.data.startsWith('chain_')) {
    if (session.step !== 'awaiting_chain_pick') {
      return bot.answerCallbackQuery(query.id, { text: 'Button no longer valid' });
    }
    await bot.answerCallbackQuery(query.id);
    return resolveForFlow(chatId, session, query.data.slice(6));
  }

  if (query.data === 'menu_home') {
    await bot.answerCallbackQuery(query.id);
    sessionStore.setSession(chatId, { flow: null, step: 'main_menu', data: {} }, bot);
    return showMainMenu(chatId);
  }

  if (query.data.startsWith('offacc_')) {
    if (session.step !== 'offer_pick') {
      return bot.answerCallbackQuery(query.id, { text: 'Button no longer valid' });
    }
    await bot.answerCallbackQuery(query.id);
    const idx = Number(query.data.slice(7));
    session.step = 'executing';
    sessionStore.setSession(chatId, session, bot);
    try {
      await offerFlow.acceptOfferAt(chatId, session, idx);
    } catch (err) {
      endAndReturnToMenu(chatId, `Accept failed: ${err.message.slice(0, 200)}`);
    }
    return;
  }

  if (query.data === 'off_back_tokens') {
    await bot.answerCallbackQuery(query.id);
    return offerFlow.renderOfferTokens(chatId, session);
  }

  if (query.data === 'offmode_bulk') {
    if (session.step !== 'offer_mode_pick') return bot.answerCallbackQuery(query.id, { text: 'Button no longer valid' });
    await bot.answerCallbackQuery(query.id);
    try {
      await bulkOffer.startBulkOffer(chatId, session);
    } catch (err) {
      endAndReturnToMenu(chatId, `Bulk scan failed: ${err.message.slice(0, 200)}`);
    }
    return;
  }

  if (query.data === 'offmode_sep') {
    if (session.step !== 'offer_mode_pick') return bot.answerCallbackQuery(query.id, { text: 'Button no longer valid' });
    await bot.answerCallbackQuery(query.id);
    return offerFlow.renderOfferTokens(chatId, session);
  }

  if (query.data.startsWith('offtok_')) {
    if (session.step !== 'awaiting_offer_token') return bot.answerCallbackQuery(query.id, { text: 'Button no longer valid' });
    await bot.answerCallbackQuery(query.id);
    return offerFlow.pickOfferToken(chatId, session, Number(query.data.slice(7)));
  }

  if (query.data.startsWith('offpage_')) {
    if (session.step !== 'awaiting_offer_token') return bot.answerCallbackQuery(query.id, { text: 'Button no longer valid' });
    await bot.answerCallbackQuery(query.id);
    return offerFlow.pageOfferTokens(chatId, session, query.data.slice(8));
  }

  if (query.data.startsWith('bulkoff_tgl_')) {
    if (session.step !== 'bulk_offer_pick' || !session.data.bulkOffer) return bot.answerCallbackQuery(query.id, { text: 'Button no longer valid' });
    await bot.answerCallbackQuery(query.id);
    return bulkOffer.toggleOffer(chatId, session, Number(query.data.slice(12)));
  }

  if (query.data === 'bulkoff_more') {
    if (session.step !== 'bulk_offer_pick' || !session.data.bulkOffer) return bot.answerCallbackQuery(query.id, { text: 'Button no longer valid' });
    await bot.answerCallbackQuery(query.id);
    return bulkOffer.loadMoreOffers(chatId, session);
  }

  if (query.data === 'bulkoff_continue') {
    if (session.step !== 'bulk_offer_pick' || !session.data.bulkOffer) return bot.answerCallbackQuery(query.id, { text: 'Button no longer valid' });
    if (session.data.bulkOffer.selected.size === 0) return bot.answerCallbackQuery(query.id, { text: 'Select at least one offer' });
    await bot.answerCallbackQuery(query.id);
    try {
      await bulkOffer.computeAllocation(chatId, session);
    } catch (err) {
      endAndReturnToMenu(chatId, `Allocation failed: ${err.message.slice(0, 200)}`);
    }
    return;
  }

  if (query.data === 'bulkoff_back') {
    if (!session.data.bulkOffer) return bot.answerCallbackQuery(query.id, { text: 'Button no longer valid' });
    await bot.answerCallbackQuery(query.id);
    session.step = 'bulk_offer_pick';
    sessionStore.setSession(chatId, session, bot);
    return bulkOffer.renderOfferPicker(chatId, session, session.data.bulkOffer.pickerMsgId, false);
  }

  if (query.data === 'bulkoff_excl') {
    if (session.step !== 'bulk_offer_alloc' || !session.data.bulkOffer?.allocation) return bot.answerCallbackQuery(query.id, { text: 'Button no longer valid' });
    await bot.answerCallbackQuery(query.id);
    return bulkOffer.renderBulkExcluded(chatId, session);
  }

  if (query.data === 'bulkoff_confirm') {
    if (session.step !== 'bulk_offer_alloc' || !session.data.bulkOffer?.allocation) return bot.answerCallbackQuery(query.id, { text: 'Button no longer valid' });
    await bot.answerCallbackQuery(query.id);
    try {
      await bulkOffer.fireBulkOffer(chatId, session);
    } catch (err) {
      endAndReturnToMenu(chatId, `Bulk accept failed: ${err.message.slice(0, 200)}`);
    }
    return;
  }

  if (query.data === 'bulkoff_cancel') {
    await bot.answerCallbackQuery(query.id);
    return endAndReturnToMenu(chatId, 'Bulk accept cancelled.');
  }

  if (query.data === 'schd_qty') {
    if (session.step !== 'schedule_manage_detail') {
      return bot.answerCallbackQuery(query.id, { text: 'Button no longer valid' });
    }
    await bot.answerCallbackQuery(query.id);
    const s = schedules.list().find((x) => x.id === session.data.schdId);
    if (!s) return endAndReturnToMenu(chatId, 'Schedule already fired/cancelled.');
    session.step = 'schedule_manage_qty';
    sessionStore.setSession(chatId, session, bot);
    return bot.sendMessage(chatId, `How many per wallet? (1-${s.maxPerWallet ?? 100})`);
  }

  if (query.data === 'schd_wallets') {
    if (session.step !== 'schedule_manage_detail') {
      return bot.answerCallbackQuery(query.id, { text: 'Button no longer valid' });
    }
    await bot.answerCallbackQuery(query.id);
    return scheduleMod.renderSchdWallets(chatId, session);
  }

  if (query.data === 'schd_close') {
    if (session.step !== 'schedule_manage_detail') {
      return bot.answerCallbackQuery(query.id, { text: 'Button no longer valid' });
    }
    await bot.answerCallbackQuery(query.id);
    schedules.cancel(session.data.schdId);
    return endAndReturnToMenu(chatId, `Schedule #${session.data.schdId} cancelled ✓`);
  }

  if (query.data.startsWith('schd_')) {
    await bot.answerCallbackQuery(query.id);
    return scheduleMod.showScheduleDetail(chatId, session, query.data.slice(5));
  }

  if (query.data === 'menu_sch') {
    if (session.step !== 'mint_stages') {
      return bot.answerCallbackQuery(query.id, { text: 'Button no longer valid' });
    }
    await bot.answerCallbackQuery(query.id);
    return scheduleMod.enterScheduleMenu(chatId, session);
  }

  if (query.data.startsWith('stage_')) {
    if (session.step !== 'sch_stage_pick') {
      return bot.answerCallbackQuery(query.id, { text: 'Button no longer valid' });
    }
    await bot.answerCallbackQuery(query.id);
    const idx = Number(query.data.slice(6));
    const stage = session.data.drop.stages.find((s) => s.index === idx);
    if (!stage) return endAndReturnToMenu(chatId, 'Stage not found, aborting');
    return scheduleMod.enterSchWalletMenu(chatId, session, stage);
  }

  if (query.data === 'sch_bulk') {
    if (session.step !== 'sch_menu') {
      return bot.answerCallbackQuery(query.id, { text: 'Button no longer valid' });
    }
    await bot.answerCallbackQuery(query.id);
    session.step = 'schedule_bulk_count';
    sessionStore.setSession(chatId, session, bot);
    return bot.sendMessage(chatId, 'How many wallets to mint? Enter a count (e.g. 2), a range (e.g. 1-3), or a list (e.g. 1,3) — fills ELIGIBLE wallets, in order shown.');
  }

  if (query.data === 'sch_sep') {
    if (session.step !== 'sch_menu') {
      return bot.answerCallbackQuery(query.id, { text: 'Button no longer valid' });
    }
    await bot.answerCallbackQuery(query.id);
    session.data.schSel = [];
    session.data.schPage = 0;
    return scheduleMod.renderSchSepPage(chatId, session);
  }

  if (query.data === 'schp_next' || query.data === 'schp_prev') {
    if (session.step !== 'schedule_sep') {
      return bot.answerCallbackQuery(query.id, { text: 'Button no longer valid' });
    }
    await bot.answerCallbackQuery(query.id);
    session.data.schPage += query.data === 'schp_next' ? 1 : -1;
    return scheduleMod.renderSchSepPage(chatId, session);
  }

  if (query.data === 'schp_noop') {
    return bot.answerCallbackQuery(query.id);
  }

  if (query.data === 'schp_done') {
    if (session.step !== 'schedule_sep') {
      return bot.answerCallbackQuery(query.id, { text: 'Button no longer valid' });
    }
    await bot.answerCallbackQuery(query.id);
    if (session.data.schSel.length === 0) {
      return bot.answerCallbackQuery(query.id, { text: 'Select at least one wallet first' });
    }
    return scheduleMod.askSchQty(chatId, session);
  }

  if (query.data === 'sch_elig') {
    if (session.step !== 'sch_menu') {
      return bot.answerCallbackQuery(query.id, { text: 'Button no longer valid' });
    }
    await bot.answerCallbackQuery(query.id);
    return scheduleMod.renderSchElig(chatId, session);
  }

  if (query.data === 'sch_seeall') {
    if (session.step !== 'sch_menu') {
      return bot.answerCallbackQuery(query.id, { text: 'Button no longer valid' });
    }
    await bot.answerCallbackQuery(query.id);
    session.data.schPage = 0;
    return scheduleMod.renderSchSeeAll(chatId, session);
  }

  if (query.data === 'see_next' || query.data === 'see_prev') {
    if (session.step !== 'schedule_seeall') {
      return bot.answerCallbackQuery(query.id, { text: 'Button no longer valid' });
    }
    await bot.answerCallbackQuery(query.id);
    session.data.schPage += query.data === 'see_next' ? 1 : -1;
    return scheduleMod.renderSchSeeAll(chatId, session);
  }

  if (query.data === 'sch_back') {
    if (session.step !== 'schedule_seeall') {
      return bot.answerCallbackQuery(query.id, { text: 'Button no longer valid' });
    }
    await bot.answerCallbackQuery(query.id);
    session.step = 'sch_menu';
    sessionStore.setSession(chatId, session, bot);
    return bot.sendMessage(chatId, `Stage: ${session.data.schStage.label} — pick a mode:`, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Bulk-mint', callback_data: 'sch_bulk' },
            { text: 'Separate-mint', callback_data: 'sch_sep' },
          ],
          [
            { text: 'See all wallet', callback_data: 'sch_seeall' },
            { text: 'Menu', callback_data: 'menu_home' },
          ],
        ],
      },
    });
  }

  if (query.data === 'sch_confirm_yes') {
    if (session.step !== 'schedule_confirm') {
      return bot.answerCallbackQuery(query.id, { text: 'Nothing to confirm' });
    }
    await bot.answerCallbackQuery(query.id);
    const stage = session.data.schStage;
    const schedule = {
      id: Date.now().toString(36),
      chatId,
      chain: session.data.chainInput,
      ca: session.data.contractAddress,
      slug: session.data.slug,
      collection: session.data.collection,
      stageIndex: stage.index,
      maxPerWallet: stage.maxPerWallet ?? null,
      label: stage.label,
      type: stage.type,
      startMs: stage.start,
      endMs: stage.end,
      priceEth: stage.priceEth ?? 0,
      qty: session.data.schQty,
      wallets: session.data.schSel,
      mintSig: session.data.mintSig,
      mintName: session.data.mintName,
      status: 'pending',
    };
    schedules.add(schedule);
    session.step = 'scheduled';
    sessionStore.setSession(chatId, session, bot);
    return endAndReturnToMenu(chatId, `Scheduled ✓ #${schedule.id}\n${schedule.collection} — ${schedule.label}\n${mint.fmtRangeWIB(schedule.startMs, schedule.endMs)} WIB\n${schedule.wallets.length} wallet × ${schedule.qty}, ${schedule.priceEth} ETH each.\nBot fires automatically.`);
  }

  if (query.data === 'mode_separate' || query.data === 'mode_bulk') {
    if (session.step !== 'awaiting_list_mode') {
      return bot.answerCallbackQuery(query.id, { text: 'Button no longer valid' });
    }
    await bot.answerCallbackQuery(query.id);
    if (query.data === 'mode_separate') {
      return enterWalletPick(chatId, session);
    }
    const maxTotal = session.data.walletsData.reduce((sum, w) => sum + w.items.length, 0);
    if (maxTotal === 0) {
      return endAndReturnToMenu(chatId, 'No wallets hold NFTs from this collection, aborting');
    }
    session.step = 'awaiting_bulk_count';
    sessionStore.setSession(chatId, session, bot);
    return bot.sendMessage(chatId, `How many NFTs total (max ${maxTotal}, fills wallets in order)?`);
  }

  if (query.data === 'confirm_yes' || query.data === 'confirm_no') {
    // guards against double taps and old summary buttons
    if (session.step !== 'awaiting_confirm') {
      return bot.answerCallbackQuery(query.id, { text: 'Nothing to confirm' });
    }

    // claim the state synchronously, BEFORE any await, so a second tap can't slip in
    const confirmed = query.data === 'confirm_yes';
    session.step = confirmed ? 'executing' : 'cancelled';

    await bot.answerCallbackQuery(query.id);

    if (!confirmed) {
      return endAndReturnToMenu(chatId, 'Cancelled');
    }

    return session.flow === 'mint' ? mintFlow.executeMint(chatId, session) : executeAction(chatId, session);
  }
}

bot.on('message', async (msg) => {
  console.log(`msg received: ${msg.chat.id} ${msg.from?.id} ${String(msg.text||'').slice(0, 30)}`);
  if (!msg.text || msg.text.startsWith('/')) return;

  const chatId = msg.chat.id;
  if (!isAuthorized(msg.from.id)) return;

  const session = sessionStore.getSession(chatId);
  const text = msg.text.trim();

  if (CA_REGEX.test(text) && (!session || session.step === 'main_menu')) {
    if (isBusy(chatId)) return bot.sendMessage(chatId, 'Still executing, please wait until it finishes');
    sessionStore.setSession(chatId, { flow: null, step: 'awaiting_start_mode', data: { contractAddress: text } }, bot);
    return bot.sendMessage(chatId, 'What do you want to do with this collection?', {
      reply_markup: {
        inline_keyboard: [[
          { text: 'Fast List', callback_data: 'start_fastlist' },
          { text: 'Listing', callback_data: 'start_list' },
          { text: 'Manage Listing', callback_data: 'start_manage' },
        ], [
          { text: 'Mint', callback_data: 'start_mint' },
          { text: 'Acc offer', callback_data: 'start_offer' },
        ]],
      },
    });
  }

  // nothing to handle while idle on the menu; don't re-arm a timer for it
  if (!session || session.step === 'main_menu') return;

  sessionStore.setSession(chatId, session, bot);

  try {
    await handleStep(chatId, session, msg.text);
  } catch (err) {
    endAndReturnToMenu(chatId, `Error: ${err.message}`);
  }
});

sessionStore.configureTimeoutHandler((chatId) => {
  showMainMenu(chatId, 'Session timed out after 3 minutes of inactivity.');
});

bot.on('polling_error', (err) => {
  console.log('Polling error:', err.message);
});

const armed = schedules.armAll();
if (armed > 0) console.log(`armed ${armed} mint schedule(s)`);
dropwatch.start(bot);

console.log('Bot running');

