// ---- Accept offer (separate/manual token-by-token flow) ----
// Extracted verbatim from bot.js — logic unchanged, only wrapped in this factory.
// bot.js: const offerFlow = require('./lib/offerflow')({ bot, sessionStore, opensea, OPENSEA_API_KEY,
//   providers, rememberCa, mint, holdings, PRIVATE_KEYS, ethers, osauth, osoffers, OF_PAGE,
//   endAndReturnToMenu, shortAddr, detectChainHoldings });

module.exports = ({ bot, sessionStore, opensea, OPENSEA_API_KEY, providers, rememberCa, mint, holdings, PRIVATE_KEYS, ethers, osauth, osoffers, OF_PAGE, endAndReturnToMenu, shortAddr, detectChainHoldings }) => {
  async function startOfferFlow(chatId, session) {
    session.step = 'detecting_chain';
    sessionStore.setSession(chatId, session, bot);
    bot.sendMessage(chatId, 'Scanning chains...');
    const counts = await detectChainHoldings(session.data.contractAddress);
    const withHoldings = counts.filter(([, total]) => total > 0);
    if (withHoldings.length === 1) {
      bot.sendMessage(chatId, `Chain detected: ${withHoldings[0][0]} (${withHoldings[0][1]} NFT)`);
      return offerChainPick(chatId, session, withHoldings[0][0]);
    }
    if (withHoldings.length > 1) {
      session.step = 'awaiting_chain_pick';
      sessionStore.setSession(chatId, session, bot);
      return bot.sendMessage(chatId, 'Holdings on multiple chains, pick one:', {
        reply_markup: { inline_keyboard: [withHoldings.map(([name, total]) => ({ text: `${name} (${total})`, callback_data: `chain_${name}` }))] },
      });
    }
    return endAndReturnToMenu(chatId, 'No holdings found on any configured chain');
  }

  async function offerChainPick(chatId, session, chainInput) {
    const provider = providers[chainInput];
    if (!provider) return endAndReturnToMenu(chatId, `No RPC for ${chainInput}`);
    session.data.chainInput = chainInput;
    session.data.chain = opensea.CHAIN_MAP[chainInput];
    session.data.provider = provider;
    const slug = await opensea.getCollectionSlug(chainInput, session.data.contractAddress, OPENSEA_API_KEY);
    if (!slug) return endAndReturnToMenu(chatId, 'Could not resolve collection, aborting');
    session.data.slug = slug;
    rememberCa({ address: session.data.contractAddress, chain: chainInput, slug });
    session.data.collection = await mint.collectionName(provider, session.data.contractAddress) || slug;

    const owned = await Promise.all(PRIVATE_KEYS.map(async (pk) => {
      const wallet = new ethers.Wallet(pk, provider);
      const sdk = opensea.makeSdk(wallet, session.data.chain, OPENSEA_API_KEY);
      const balance = await holdings.getHoldings({
        provider,
        contractAddress: session.data.contractAddress,
        wallet: wallet.address,
        loadCandidates: (b) => opensea.getOwnedTokenIds(sdk, wallet.address, session.data.contractAddress, { stopAt: b }),
      });
      return { wallet, ids: balance.ids };
    }));
    session.data.owned = owned.filter((w) => w.ids.length > 0);
    if (session.data.owned.length === 0) {
      return endAndReturnToMenu(chatId, `No ${session.data.collection} NFT in any wallet`);
    }
    return renderOfferModePick(chatId, session);
  }

  function renderOfferModePick(chatId, session) {
    const totalTokens = session.data.owned.reduce((n, w) => n + w.ids.length, 0);
    session.step = 'offer_mode_pick';
    sessionStore.setSession(chatId, session, bot);
    bot.sendMessage(
      chatId,
      `${session.data.collection} — ${session.data.owned.length} wallet(s) hold ${totalTokens} token(s) total.\n\nHow do you want to accept offers?`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Bulk accept offer', callback_data: 'offmode_bulk' }],
            [{ text: 'Separate accept offer', callback_data: 'offmode_sep' }],
          ],
        },
      },
    );
  }

  function renderOfferTokens(chatId, session) {
    const lines = session.data.owned.map((w, i) => {
      const ids = w.ids.length > 8 ? `${w.ids.slice(0, 8).join(', ')} +${w.ids.length - 8} more` : w.ids.join(', ');
      return `${i + 1}. ${shortAddr(w.wallet.address)} (${w.ids.length}) — #${ids}`;
    });
    session.step = 'awaiting_offer_token';
    sessionStore.setSession(chatId, session, bot);
    bot.sendMessage(chatId, `${session.data.collection} — held tokens:\n${lines.join('\n')}\n\nWhich token id? (e.g. ${session.data.owned[0].ids[0]})`);
  }

  async function showTokenOffers(chatId, session) {
    const { chainInput, slug, offerTokenId } = session.data;
    const owner = session.data.owned.find((w) => w.ids.includes(offerTokenId) || w.ids.includes(String(offerTokenId)));
    // prefetch bearer (write:orders, for cancel-listing) + open listings + NFT approval NOW, in
    // parallel with the offer list, so tapping "Acc" later is just cancel(if any)+fulfill+sign+
    // broadcast. Approval is the slowest part when missing (its own on-chain tx + wait), so start
    // it here rather than after the user already picked an offer.
    const prefetch = owner
      ? Promise.all([
          osauth.walletJwt(owner.wallet, ['write:orders']),
          (async () => {
            const sdk = opensea.makeSdk(owner.wallet, session.data.chain, OPENSEA_API_KEY);
            return opensea.getOpenListings(sdk, owner.wallet.address, slug, session.data.contractAddress, session.data.chain);
          })(),
          opensea.ensureApproval(owner.wallet, session.data.contractAddress, session.data.provider, session.data.chain),
        ]).catch((err) => {
          console.error(`offer prefetch failed (will redo at accept time):`, err.message);
          return null;
        })
      : Promise.resolve(null);
    const [offers, prefetched] = await Promise.all([
      osoffers.listOffersWithOrders(slug, offerTokenId, OPENSEA_API_KEY, session.data.provider),
      prefetch,
    ]);
    session.data.offers = offers;
    session.data.offerPrefetch = prefetched ? { bearer: prefetched[0], openListings: prefetched[1], at: Date.now() } : null;
    if (offers.length === 0) {
      return bot.sendMessage(chatId, 'No active offers on this token.', {
        reply_markup: { inline_keyboard: [[{ text: 'Back', callback_data: 'off_back_tokens' }]] },
      });
    }
    const lines = offers.slice(0, OF_PAGE).map((o, i) => `${i + 1}. ${o.priceStr}${o.fundable === false ? ' ⚠ no allowance' : ''}`);
    session.step = 'offer_pick';
    sessionStore.setSession(chatId, session, bot);
    bot.sendMessage(
      chatId,
      `Offers on #${offerTokenId} (${offers.length} active, seller ${shortAddr(owner.wallet.address)}):\n${lines.join('\n')}${offers.length > OF_PAGE ? `\n+${offers.length - OF_PAGE} more...` : ''}`,
      {
        reply_markup: {
          inline_keyboard: [
            ...offers.slice(0, OF_PAGE).map((o, i) => [{ text: `Acc #${i + 1} — ${o.priceStr.split(' (')[0]}`, callback_data: `offacc_${i}` }]),
            [{ text: 'Back', callback_data: 'off_back_tokens' }],
          ],
        },
      },
    );
  }

  async function acceptOfferAt(chatId, session, i) {
    const offer = session.data.offers[i];
    if (!offer) return endAndReturnToMenu(chatId, 'Offer gone, refresh');
    const owner = session.data.owned.find((w) => w.ids.includes(String(session.data.offerTokenId)));
    if (!owner) return endAndReturnToMenu(chatId, 'Token not owned anymore');
    if (!(await opensea.checkStillOwned(session.data.contractAddress, session.data.offerTokenId, owner.wallet.address, session.data.provider))) {
      return endAndReturnToMenu(chatId, 'Token not owned anymore (on-chain re-check)');
    }
    // reuse the prefetch from showTokenOffers if it's still fresh (<60s) — bearer, open listings,
    // AND approval were all resolved together, so "fresh" implies approval already went through.
    // Cold fallback re-does all three, including ensureApproval (the actual fix for
    // TransferCallerNotOwnerNorApproved — nothing sent it before this).
    const fresh = session.data.offerPrefetch && Date.now() - session.data.offerPrefetch.at < 60000;
    const [bearer, openListings] = fresh
      ? [session.data.offerPrefetch.bearer, session.data.offerPrefetch.openListings]
      : await Promise.all([
          osauth.walletJwt(owner.wallet, ['write:orders']),
          (async () => {
            const s = opensea.makeSdk(owner.wallet, session.data.chain, OPENSEA_API_KEY);
            return opensea.getOpenListings(s, owner.wallet.address, session.data.slug, session.data.contractAddress, session.data.chain);
          })(),
          opensea.ensureApproval(owner.wallet, session.data.contractAddress, session.data.provider, session.data.chain),
        ]);
    const provider = session.data.provider;
    const sdk = opensea.makeSdk(owner.wallet, session.data.chain, OPENSEA_API_KEY, bearer);
    const mine = openListings.filter((l) => String(l.tokenId) === String(session.data.offerTokenId));
    for (const lst of mine) await opensea.cancelListing(owner.wallet, lst, session.data.chain);
    if (mine.length > 0) bot.sendMessage(chatId, `Cancelled ${mine.length} active listing(s) first (offchain, free)`);
    bot.sendMessage(chatId, `Accepting offer ${offer.priceStr} on #${session.data.offerTokenId} (${shortAddr(owner.wallet.address)})...`);
    const out = await osoffers.acceptOffer(owner.wallet, offer, session.data.contractAddress, session.data.offerTokenId, bearer, OPENSEA_API_KEY, provider);
    if (!out.receipt || out.receipt.status !== 1) {
      return endAndReturnToMenu(chatId, `Accept ${out.receipt ? 'reverted' : 'pending'} — tx ${out.hash}`);
    }
    endAndReturnToMenu(chatId, `Offer accepted ✓ ${offer.priceStr}\ntoken #${session.data.offerTokenId}\ntx ${out.hash}\nblock ${out.receipt.blockNumber}`);
  }

  return { startOfferFlow, offerChainPick, renderOfferModePick, renderOfferTokens, showTokenOffers, acceptOfferAt };
};
