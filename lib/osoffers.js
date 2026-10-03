// Accept offer via OS API v2 (mirrors @opensea/sdk FulfillmentManager.fulfillOrder).
// List: GET /api/v2/offers/collection/{slug}/nfts/{id} -> offers[{order_hash, chain, protocol_address, price{value,decimals,currency}, status}]
// Accept: POST /api/v2/offers/fulfillment_data {offer:{hash,chain,protocolAddress}, fulfiller:{address}, consideration:{assetContractAddress,tokenId}}
//   -> {fulfillment_data:{transaction:{to,value,inputData,function,calldataSuffix}, orders:[...]}}
// Then re-encode inputData with SeaportABI, re-attach calldataSuffix, send raw tx from the seller wallet.
const { ethers } = require('ethers');
const { SeaportABI } = require('@opensea/seaport-js/lib/abi/Seaport');

const API = 'https://api.opensea.io';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const FULFILL_BASIC_ORDER_ALIAS = 'fulfillBasicOrder_efficient_6GL6yc';
const NULL_CONDUIT = '0x0000000000000000000000000000000000000000000000000000000000000000';
const NULL_ADDRESS = '0x0000000000000000000000000000000000000000';
const SEAPORT_BY_CHAIN = { robinhood: '0x0000000000000068f116a894984e2db1123eb395' };

function fmtOffer(o) {
  const v = Number(o.price.value) / 10 ** o.price.decimals;
  const s = v >= 1 ? v.toFixed(3).replace(/\.?0+$/, '') : v.toFixed(v < 0.01 ? 5 : 4).replace(/\.?0+$/, '');
  return `${s} ${o.price.currency}`;
}

// priceStr shows PER-NFT price (batch criteria orders ask for many NFTs; OS UI shows per-unit too)
function fmtOfferPerUnit(o, nftQty) {
  const total = Number(o.price.value) / 10 ** o.price.decimals;
  const per = nftQty && nftQty > 1n ? total / Number(nftQty) : total;
  const s = per >= 1 ? per.toFixed(3).replace(/\.?0+$/, '') : per.toFixed(per < 0.01 ? 5 : 4).replace(/\.?0+$/, '');
  const totalS = total >= 1 ? total.toFixed(3).replace(/\.?0+$/, '') : total.toFixed(4).replace(/\.?0+$/, '');
  return nftQty && nftQty > 1n ? `${s} ${o.price.currency} (batch ${totalS} × ${nftQty} NFTs)` : `${s} ${o.price.currency}`;
}

// active offers on one token, sorted desc by raw value
async function listOffers(slug, tokenId, apiKey) {
  const j = await fetch(`${API}/api/v2/offers/collection/${slug}/nfts/${tokenId}?limit=50`, {
    headers: { 'x-api-key': apiKey, 'user-agent': UA },
  });
  if (!j.ok) throw new Error(`offers ${j.status}`);
  const res = await j.json();
  return (res.offers || [])
    .filter((o) => o.status === 'ACTIVE' && o.order_hash)
    .map((o) => ({ hash: o.order_hash, chain: o.chain, protocol: o.protocol_address, price: o.price, priceStr: fmtOffer(o) }))
    .sort((a, b) => Number(b.price.value) - Number(a.price.value));
}

// raw collection-wide offers (no /nfts/{id}), sorted desc by raw order value as OS returns them.
// Cheap: one call, no per-offer detail fetch — caller enriches only what it actually shows (lazy).
async function listCollectionOffers(slug, apiKey, limit = 50) {
  const j = await fetch(`${API}/api/v2/offers/collection/${slug}?limit=${limit}`, {
    headers: { 'x-api-key': apiKey, 'user-agent': UA },
  });
  if (!j.ok) throw new Error(`collection offers ${j.status}`);
  const res = await j.json();
  return (res.offers || [])
    .filter((o) => o.status === 'ACTIVE' && o.order_hash)
    .map((o) => ({ hash: o.order_hash, chain: o.chain, protocol: o.protocol_address, price: o.price, priceStr: fmtOffer(o) }))
    .sort((a, b) => Number(b.price.value) - Number(a.price.value));
}

// on-chain sanity: offerer must have an allowance to the Seaport exchange >= offer amount, else the
// accept will revert. Returns true when the offer looks executable.
async function offerLooksFundable(provider, offer) {
  const erc20 = new ethers.Contract(offer.token, ['function allowance(address,address) view returns (uint256)'], provider);
  const params = offer.parameters;
  const need = BigInt(params.offer[0].startAmount);
  const offerer = params.offerer;
  const seaport = SEAPORT_BY_CHAIN[offer.chain] || NULL_ADDRESS;
  const allow = await erc20.allowance(offerer, seaport);
  return allow >= need;
}

// mutate one raw offer {hash,chain,protocol,price} in place with order detail: nftQty (total
// order capacity, not remaining — see getOrderRemaining for live remaining), per-unit priceStr,
// pricePerUnit (raw units, for sorting/comparison), and fundable. Shared by item + collection offers.
async function enrichOffer(o, apiKey, provider) {
  try {
    const r = await fetch(`${API}/api/v2/orders/chain/${o.chain}/protocol/${o.protocol}/${o.hash}`, { headers: { 'x-api-key': apiKey, 'user-agent': UA } });
    const { order } = await r.json();
    const params = order.protocol_data.parameters;
    o.parameters = params;
    o.token = params.offer[0].token;
    o.nftQty = BigInt(params.consideration[0].startAmount);
    o.priceStr = fmtOfferPerUnit(o, o.nftQty);
    o.pricePerUnit = Number(o.price.value) / 10 ** o.price.decimals / Number(o.nftQty);
    o.fundable = provider ? await offerLooksFundable(provider, o).catch(() => null) : null;
  } catch (err) {
    o.enrichError = err.message;
  }
  return o;
}

// enriched offer list: signed order (for offerer + token) + fundable flag
async function listOffersWithOrders(slug, tokenId, apiKey, provider) {
  const offers = await listOffers(slug, tokenId, apiKey);
  await Promise.all(offers.map((o) => enrichOffer(o, apiKey, provider)));
  // Sort by highest PER-UNIT price (not raw volume:A $10 qty 1 must rank above B $5 qty 5..
  offers.sort((a,b) => (b.pricePerUnit ?? -1) - (a.pricePerUnit ?? -1));
  return offers;
}

const SEAPORT_ABI = ['function getOrderStatus(bytes32 orderHash) view returns (bool isValidated, bool isCancelled, uint256 totalFilled, uint256 totalSize)'];

// live remaining capacity on an order — totalSize/totalFilled are numerator/denominator over the
// order's fill fraction; for a straight per-NFT partial order these line up 1:1 with unit counts.
async function getOrderRemaining(provider, chain, orderHash) {
  const seaport = SEAPORT_BY_CHAIN[chain];
  if (!seaport) return null; // unknown chain, caller should treat as "can't verify"
  const c = new ethers.Contract(seaport, SEAPORT_ABI, provider);
  const [, isCancelled, totalFilled, totalSize] = await c.getOrderStatus(orderHash);
  if (isCancelled) return 0;
  if (totalSize === 0n) return null; // order never touched on-chain yet — full capacity, unknown here
  return totalSize - totalFilled;
}

// build fulfillment payload for accepting the offer (seller = fulfiller)
async function fulfillData(orderHash, chain, protocol, seller, ca, tokenId, bearer, apiKey) {
  const r = await fetch(`${API}/api/v2/offers/fulfillment_data`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, authorization: `Bearer ${bearer}`, 'content-type': 'application/json', 'user-agent': UA },
    body: JSON.stringify({
      offer: { hash: orderHash, chain, protocol_address: protocol },
      fulfiller: { address: seller },
      consideration: { asset_contract_address: ca, token_id: String(tokenId) },
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`fulfillment_data ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
  const fd = j.fulfillment_data || j.fulfillmentData;
  if (!fd || !fd.transaction) throw new Error('no fulfillment_data in response');
  return fd;
}

// encode the API's inputData into Seaport calldata + attribution suffix (sdk parity)
function encodeFulfillment(fd) {
  const tx = fd.transaction;
  if (!tx) throw new Error(`fulfillment_data has no transaction field (keys: ${Object.keys(fd).join(',')})`);
  const raw = (tx.function || '').split('(')[0];
  const fn = raw === FULFILL_BASIC_ORDER_ALIAS ? 'fulfillBasicOrder' : raw;
  if (!fn) throw new Error(`fulfillment_data.transaction has no 'function' field (keys: ${Object.keys(tx).join(',')}) — API response shape may have changed`);
  const input = tx.inputData || tx.input_data;
  if (!input) throw new Error(`fulfillment_data.transaction has no inputData/input_data (fn=${fn}, keys: ${Object.keys(tx).join(',')})`);
  let params;
  if (fn === 'fulfillAdvancedOrder' && input.advancedOrder) {
    params = [input.advancedOrder, input.criteriaResolvers || [], input.fulfillerConduitKey || NULL_CONDUIT, input.recipient];
  } else if ((fn === 'fulfillBasicOrder' || raw === FULFILL_BASIC_ORDER_ALIAS) && input.parameters) {
    params = [input.parameters];
  } else if (fn === 'fulfillOrder' && input.order) {
    params = [input.order, input.fulfillerConduitKey || NULL_CONDUIT];
  } else {
    params = Object.values(input);
  }
  const iface = new ethers.Interface(SeaportABI);
  let data;
  try {
    data = iface.encodeFunctionData(fn, params);
  } catch (err) {
    throw new Error(`encodeFunctionData(${fn}) failed: ${err.message} — input keys: ${Object.keys(input).join(',')}`);
  }
  const suffix = tx.calldataSuffix || tx.calldata_suffix;
  if (suffix && /^0x[0-9a-f]{8}$/i.test(suffix)) data += suffix.slice(2);
  if (!tx.to || !ethers.isAddress(tx.to)) throw new Error(`fulfillment_data.transaction.to is not a valid address: ${JSON.stringify(tx.to)}`);
  if (!data || data.length < 10) throw new Error(`encoded calldata is empty/too short (${data ? data.length : 0} chars) — refusing to send`);
  return { to: tx.to, value: BigInt(tx.value || 0), data };
}

// full accept: fulfillData -> encode -> sign -> broadcast -> wait
async function acceptOffer(wallet, offer, ca, tokenId, bearer, apiKey, provider) {
  const fd = await fulfillData(offer.hash, offer.chain, offer.protocol, wallet.address, ca, tokenId, bearer, apiKey);
  const built = encodeFulfillment(fd);
  const [feeData, nonce] = await Promise.all([provider.getFeeData(), provider.getTransactionCount(wallet.address, 'pending')]);
  const tx = { to: built.to, data: built.data, value: built.value, nonce, gasLimit: 500000n, chainId: (await provider.getNetwork()).chainId };
  if (feeData.maxFeePerGas) {
    tx.type = 2;
    tx.maxFeePerGas = feeData.maxFeePerGas;
    tx.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;
  } else {
    tx.gasPrice = feeData.gasPrice;
  }
  const signed = await wallet.signTransaction(tx);
  const sent = await provider.broadcastTransaction(signed);
  const receipt = await Promise.race([sent.wait(), new Promise((resolve) => setTimeout(() => resolve(null), 60000))]);
  return { hash: sent.hash, receipt, gasLimit: built.value === 0n ? 'offer pays seller' : 'value>0' };
}

module.exports = {
  listOffers, listOffersWithOrders, offerLooksFundable, fulfillData, encodeFulfillment, acceptOffer,
  fmtOffer, fmtOfferPerUnit, listCollectionOffers, enrichOffer, getOrderRemaining,
};
