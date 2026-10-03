// ---- Bulk accept (multi-offer checklist) ----
// Flow: scan owned tokens' own best offer (in parallel) + fetch raw collection offers (cheap,
// one call) -> reveal/enrich offers OFF_PAGE at a time (lazy: order-detail fetch only for what's
// shown) -> user checks off which offers to use -> allocate eligible tokens across checked
// offers, highest per-unit price first, capped by live on-chain remaining -> fire all allocated
// tokens in parallel -> report success/failed per offer + excluded/left-over.
//
// Extracted verbatim from bot.js — logic unchanged, only wrapped in this factory so bot.js can
// `const bulkOffer = require('./lib/bulkoffer')({ bot, sessionStore, osoffers, osauth, opensea,
// OPENSEA_API_KEY, OF_PAGE, endAndReturnToMenu, shortAddr })` and call bulkOffer.startBulkOffer(...) etc.

module.exports = ({ bot, sessionStore, osoffers, osauth, opensea, OPENSEA_API_KEY, OF_PAGE, endAndReturnToMenu, shortAddr, fastSettings }) => {
const { ethUsdRate, usdStr } = require('./ethusd');
let rate = null;
  function fmtPerUnit(o) {
    if (rate && o.pricePerUnit != null && (o.price.currency === 'ETH' || o.price.currency === 'WETH')) {
      return usdStr(o.pricePerUnit, rate);
    }
    const v = o.pricePerUnit;
    const s = v >= 1 ? v.toFixed(3).replace(/\.?0+$/, '') : v.toFixed(v < 0.01 ? 6 : 4).replace(/\.?0+$/, '');
    return `${s} ${o.price.currency}/each`;
  }

  async function startBulkOffer(chatId, session) {
    session.step = 'executing';
    sessionStore.setSession(chatId, session, bot);
    rate = null;
    if (fastSettings.currency === 'usdt') rate = await ethUsdRate().catch(() => null);
    const loading = await bot.sendMessage(chatId, `Scanning ${session.data.owned.reduce((n, w) => n + w.ids.length, 0)} tokens for individual offers...`);

    const [rawOffers, perToken] = await Promise.all([
      osoffers.listCollectionOffers(session.data.slug, OPENSEA_API_KEY).catch(() => []),
      Promise.all(
        session.data.owned.flatMap((w) => w.ids.map(async (id) => {
          const offers = await osoffers.listOffers(session.data.slug, id, OPENSEA_API_KEY).catch(() => []);
          const best = offers[0] || null; // sorted desc by raw value already
          return {
            wallet: w.wallet,
            tokenId: String(id),
            bestHash: best ? best.hash : null,
            bestValuePerUnit: best ? Number(best.price.value) / 10 ** best.price.decimals : 0,
            bestCurrency: best ? best.price.currency : null,
          };
        })),
      ),
    ]);

    if (rawOffers.length === 0) {
      return endAndReturnToMenu(chatId, 'No active collection offer.');
    }

    // a token's "own best offer" from listOffers() is often just the top collection-wide offer
    // (valid for every token) — that's not a hidden better opportunity, it's literally one of the
    // rows in this same checklist. Only flag exclusion for offers that AREN'T in the general
    // collection-offer list at all (true item/trait-specific orders), so skipping a checked-off
    // offer on purpose (e.g. choosing $4 over $5) never gets silently overridden as "excluded".
    const rawHashSet = new Set(rawOffers.map((o) => o.hash));
    for (const t of perToken) t.ownIsCollectionWide = rawHashSet.has(t.bestHash);

    session.data.bulkOffer = { perToken, rawOffers, enriched: {}, revealed: 0, selected: new Set(), pickerMsgId: loading.message_id };
    session.step = 'bulk_offer_pick';
    await revealMoreOffers(session, OF_PAGE);
    sessionStore.setSession(chatId, session, bot);
    return renderOfferPicker(chatId, session, loading.message_id, true);
  }

  async function revealMoreOffers(session, n) {
    const b = session.data.bulkOffer;
    const slice = b.rawOffers.slice(b.revealed, b.revealed + n);
    await Promise.all(slice.map((o) => osoffers.enrichOffer(o, OPENSEA_API_KEY, session.data.provider).then(() => { b.enriched[o.hash] = o; })));
    b.revealed += slice.length;
  }

  function renderOfferPicker(chatId, session, messageId, isEdit) {
    const b = session.data.bulkOffer;
    const shown = b.rawOffers.slice(0, b.revealed).filter((o) => b.enriched[o.hash] && !o.enrichError);
    const totalTokens = session.data.owned.reduce((n, w) => n + w.ids.length, 0);

    const lines = [`${session.data.collection} — ${totalTokens} token(s) held`, '', 'Select offers to use (tap to toggle):'];
    const rows = shown.map((o, i) => [{
      text: `${b.selected.has(o.hash) ? '[x]' : '[ ]'} ${i + 1}. ${fmtPerUnit(o)} — ${o.nftQty} order`,
      callback_data: `bulkoff_tgl_${i}`,
    }]);
    if (b.revealed < b.rawOffers.length) rows.push([{ text: 'Load more', callback_data: 'bulkoff_more' }]);
    rows.push([{ text: `Continue (${b.selected.size} selected)`, callback_data: 'bulkoff_continue' }, { text: 'Cancel', callback_data: 'bulkoff_cancel' }]);

    const payload = { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: rows } };
    const text = lines.join('\n');
    return isEdit ? bot.editMessageText(text, payload) : bot.editMessageText(text, payload).catch(() => bot.sendMessage(chatId, text, { reply_markup: payload.reply_markup }));
  }

  async function toggleOffer(chatId, session, idx) {
    const b = session.data.bulkOffer;
    const shown = b.rawOffers.slice(0, b.revealed).filter((o) => b.enriched[o.hash] && !o.enrichError);
    const o = shown[idx];
    if (!o) return;
    if (b.selected.has(o.hash)) b.selected.delete(o.hash); else b.selected.add(o.hash);
    sessionStore.setSession(chatId, session, bot);
    return renderOfferPicker(chatId, session, b.pickerMsgId, true);
  }

  async function loadMoreOffers(chatId, session) {
    await revealMoreOffers(session, OF_PAGE);
    sessionStore.setSession(chatId, session, bot);
    return renderOfferPicker(chatId, session, session.data.bulkOffer.pickerMsgId, true);
  }

  // Greedily allocate eligible tokens to checked offers (highest per-unit price first), capped by
  // each offer's live on-chain remaining capacity. A token whose OWN best offer beats every checked
  // offer of the same currency is excluded (nothing here can safely compare across currencies, so
  // those are left eligible rather than guessed at).
  async function computeAllocation(chatId, session) {
    const b = session.data.bulkOffer;
    const chosen = [...b.selected].map((h) => b.enriched[h]).sort((x, y) => y.pricePerUnit - x.pricePerUnit);

    const remainings = await Promise.all(chosen.map((o) =>
      osoffers.getOrderRemaining(session.data.provider, o.chain, o.hash).catch(() => null)));
    chosen.forEach((o, i) => { o.capNow = remainings[i] == null ? Number(o.nftQty) : Math.min(Number(remainings[i]), Number(o.nftQty)); });

    const eligible = [];
    const excluded = [];
    for (const t of b.perToken) {
      if (!t.bestHash || t.ownIsCollectionWide || chosen.some((o) => o.hash === t.bestHash)) { eligible.push(t); continue; }
      const sameCurrency = chosen.filter((o) => o.price.currency === t.bestCurrency);
      if (sameCurrency.length === 0) { eligible.push(t); continue; }
      const maxChosen = Math.max(...sameCurrency.map((o) => o.pricePerUnit));
      if (t.bestValuePerUnit > maxChosen) excluded.push(t); else eligible.push(t);
    }

    const groups = chosen.map((o) => ({ offer: o, tokens: [] }));
    let pool = eligible.slice();
    for (const g of groups) {
      const take = pool.splice(0, g.offer.capNow);
      g.tokens.push(...take);
    }
    const leftover = pool; // eligible but no checked offer had capacity left

    session.data.bulkOffer.allocation = { groups, leftover, excluded };
    session.step = 'bulk_offer_alloc';
    sessionStore.setSession(chatId, session, bot);
    return renderAllocation(chatId, session);
  }

  function renderAllocation(chatId, session) {
    const { groups, leftover, excluded } = session.data.bulkOffer.allocation;
    const lines = ['Allocation preview:'];
    for (const g of groups) lines.push(`${g.tokens.length} token${g.tokens.length === 1 ? '' : 's'} -> ${fmtPerUnit(g.offer)}`);
    lines.push('');
    const totalAlloc = groups.reduce((n, g) => n + g.tokens.length, 0);
    lines.push(leftover.length === 0 ? `All ${totalAlloc} tokens covered.` : `${leftover.length} token(s) left over (no checked offer has capacity): ${leftover.map((t) => `#${t.tokenId}`).join(', ')}`);
    lines.push('');
    lines.push(`Excluded (better own offer elsewhere): ${excluded.length} tokens`);

    const buttons = [];
    if (excluded.length > 0) buttons.push([{ text: 'Show excluded', callback_data: 'bulkoff_excl' }]);
    if (totalAlloc > 0) buttons.push([{ text: 'Confirm', callback_data: 'bulkoff_confirm' }, { text: 'Back to offers', callback_data: 'bulkoff_back' }, { text: 'Cancel', callback_data: 'bulkoff_cancel' }]);
    else buttons.push([{ text: 'Back to offers', callback_data: 'bulkoff_back' }, { text: 'Cancel', callback_data: 'bulkoff_cancel' }]);

    bot.sendMessage(chatId, lines.join('\n'), { reply_markup: { inline_keyboard: buttons } });
  }

  function renderBulkExcluded(chatId, session) {
    const { excluded } = session.data.bulkOffer.allocation;
    const lines = excluded.map((t) => `#${t.tokenId} — ${rate && (t.bestCurrency === 'ETH' || t.bestCurrency === 'WETH') ? usdStr(t.bestValuePerUnit, rate) : `${t.bestValuePerUnit} ${t.bestCurrency}`} available`);
    bot.sendMessage(chatId, `Excluded from bulk (better own offer):\n${lines.join('\n')}\n\nThese aren't touched. Accept them individually via Separate accept offer if you want.`);
  }

  async function fireBulkOffer(chatId, session) {
    const { groups, leftover, excluded } = session.data.bulkOffer.allocation;
    session.step = 'executing';
    sessionStore.setSession(chatId, session, bot);
    const totalAlloc = groups.reduce((n, g) => n + g.tokens.length, 0);
    const wallets = new Set(groups.flatMap((g) => g.tokens.map((t) => t.wallet.address)));
    bot.sendMessage(chatId, `Accepting offer on ${totalAlloc} tokens across ${wallets.size} wallet(s)...`);

    const byWallet = new Map();
    for (const g of groups) for (const t of g.tokens) if (!byWallet.has(t.wallet.address)) byWallet.set(t.wallet.address, t.wallet);
    const prepByWallet = new Map();
    await Promise.all([...byWallet.values()].map(async (w) => {
      const [bearer] = await Promise.all([
        osauth.walletJwt(w, ['write:orders']),
        opensea.ensureApproval(w, session.data.contractAddress, session.data.provider, session.data.chain),
      ]).catch(() => [null]);
      prepByWallet.set(w.address, bearer);
    }));

    const groupResults = await Promise.all(groups.map(async (g) => {
      const results = await Promise.all(g.tokens.map(async (t) => {
        const bearer = prepByWallet.get(t.wallet.address);
        if (!bearer) return { tokenId: t.tokenId, wallet: t.wallet.address, status: 'failed', error: 'auth/approval failed' };
        try {
          const out = await osoffers.acceptOffer(t.wallet, g.offer, session.data.contractAddress, t.tokenId, bearer, OPENSEA_API_KEY, session.data.provider);
          if (!out.receipt || out.receipt.status !== 1) {
            return { tokenId: t.tokenId, wallet: t.wallet.address, status: 'failed', error: out.receipt ? 'reverted (order exhausted mid-batch?)' : 'pending', hash: out.hash };
          }
          return { tokenId: t.tokenId, wallet: t.wallet.address, status: 'ok', hash: out.hash };
        } catch (err) {
          return { tokenId: t.tokenId, wallet: t.wallet.address, status: 'failed', error: err.message.slice(0, 120) };
        }
      }));
      return { offer: g.offer, results };
    }));

    let text = `Bulk accept done — ${session.data.collection}\n`;
    for (const gr of groupResults) {
      const ok = gr.results.filter((r) => r.status === 'ok').length;
      const failed = gr.results.filter((r) => r.status === 'failed').length;
      text += `${fmtPerUnit(gr.offer)}: success ${ok}, failed ${failed}\n`;
    }
    text += `Excluded: ${excluded.length}. Left over: ${leftover.length}.\n\n`;
    for (const gr of groupResults) {
      text += gr.results.map((r) => `${shortAddr(r.wallet)}: ${r.status} #${r.tokenId}${r.hash ? ` ${r.hash}` : ''}${r.error ? ` (${r.error})` : ''}`).join('\n') + '\n';
    }
    endAndReturnToMenu(chatId, text.slice(0, 3900));
  }

  return { startBulkOffer, toggleOffer, loadMoreOffers, computeAllocation, renderBulkExcluded, fireBulkOffer, renderOfferPicker };
};
