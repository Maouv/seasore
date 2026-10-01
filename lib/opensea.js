const { ethers } = require('ethers');
const { OpenSeaSDK, Chain, getDefaultConduit, getSeaportAddress } = require('@opensea/sdk');
const { createOpenSeaTransport } = require('./limiter');

// One shared limiter for ALL OpenSea calls (the limit is per API key). Tune with OPENSEA_RPS:
// raise it step by step until the summary starts reporting "rate limited".
const OPENSEA_RPS = Number(process.env.OPENSEA_RPS) > 0 ? Number(process.env.OPENSEA_RPS) : 2;
const transport = createOpenSeaTransport({ rps: OPENSEA_RPS });

const CHAIN_MAP = {
  ethereum: Chain.Mainnet,
  polygon: Chain.Polygon,
  base: Chain.Base,
  robinhood: Chain.Robinhood,
  arc: Chain.Arc,
};

const TWO_DECIMAL_CHAINS = [Chain.Arc, Chain.StableChain, Chain.Robinhood];

const ERC721_ABI = [
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
  'function setApprovalForAll(address operator, bool approved)',
  'function ownerOf(uint256 tokenId) view returns (address)',
];

// authToken: pass the scoped wallet JWT for endpoints that need one (e.g. offchainCancelOrder
// needs write:orders). Omit it for read-only/unauthenticated calls.
function makeSdk(signerOrProvider, chain, apiKey, authToken = undefined) {
  return new OpenSeaSDK(signerOrProvider, { chain, apiKey, authToken, fetch: transport.fetch });
}

function parsePriceInput(input, floorPrice) {
  const trimmed = (input || '').trim();
  // 'd' (default) = floor -10%. Telegram cannot send an empty message, so blank is not usable.
  if (trimmed === '' || trimmed.toLowerCase() === 'd') {
    return floorPrice * 0.9;
  }
  if (trimmed.endsWith('%')) {
    const percent = parseFloat(trimmed);
    return floorPrice * (1 + percent / 100);
  }
  return parseFloat(trimmed);
}

function roundPriceForChain(price, chain) {
  // 1) buang noise floating point (0.000056999999999999996 -> 0.000057),
  //    berbasis significant digits jadi aman di semua skala harga
  let rounded = Number(price.toPrecision(12));
  // 2) hard cap 18 desimal (batas parseUnits SDK untuk semua chain di bot ini)
  rounded = Number(rounded.toFixed(18));
  // 3) aturan khusus chain
  if (TWO_DECIMAL_CHAINS.includes(chain)) {
    rounded = Math.round(rounded * 100) / 100;
  }
  return rounded;
}

async function getCollectionSlug(chainName, contractAddress, apiKey) {
  const res = await transport.fetch(`https://api.opensea.io/api/v2/chain/${chainName}/contract/${contractAddress}`, {
    headers: { 'x-api-key': apiKey, Accept: 'application/json' },
  });
  const data = await res.json();
  return data.collection;
}

async function getFloorPrice(readOnlySdk, slug) {
  const stats = await readOnlySdk.api.getCollectionStats(slug);
  return stats.total.floorPrice;
}

// Candidates from OpenSea's indexer only. It lags in both directions, so callers must verify the
// result on-chain (see lib/holdings.js). The account endpoint returns ALL collections of the wallet,
// so it is paginated and filtered by contract; stopAt ends the paging early once enough were found.
async function getOwnedTokenIds(sdk, accountAddress, contractAddress, { stopAt = Infinity, pageSize = 50, maxPages = 40 } = {}) {
  const wanted = contractAddress.toLowerCase();
  const ids = [];
  let next;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await sdk.api.getNFTsByAccount(accountAddress, pageSize, next);
    for (const nft of result.nfts) {
      if (nft.contract.toLowerCase() === wanted) ids.push(nft.identifier);
    }
    next = result.next;
    if (!next || ids.length >= stopAt) break;
  }
  return ids;
}

async function getOpenListings(sdk, walletAddress, slug, contractAddress, chain) {
  const response = await sdk.api.accounts.getProfileListings(walletAddress, { collectionSlugs: [slug] });
  return response.listings
    .filter((listing) => listing.status === 'ACTIVE' && listing.asset && listing.asset.contract.toLowerCase() === contractAddress.toLowerCase())
    .map((listing) => ({
      orderHash: listing.orderHash,
      protocolAddress: listing.protocolAddress || getSeaportAddress(chain),
      tokenId: listing.asset.identifier,
      priceValue: listing.price.current.value,
      priceDecimals: listing.price.current.decimals,
      priceCurrency: listing.price.current.currency,
      priceDisplay: Number(listing.price.current.value) / 10 ** listing.price.current.decimals,
    }));
}

async function estimateApprovalGas(wallet, contractAddress, provider, chain) {
  const conduitAddress = getDefaultConduit(chain).address;
  const contract = new ethers.Contract(contractAddress, ERC721_ABI, wallet);
  const alreadyApproved = await contract.isApprovedForAll(wallet.address, conduitAddress);

  if (alreadyApproved) {
    return { needed: false, costEth: 0 };
  }

  const gasEstimate = await contract.setApprovalForAll.estimateGas(conduitAddress, true);
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.maxFeePerGas || feeData.gasPrice;
  const costWei = gasEstimate * gasPrice;

  return { needed: true, costEth: parseFloat(ethers.formatEther(costWei)) };
}

// createListing() (SDK) sends this approval tx internally when needed — but accept-offer builds
// its own raw fulfillment tx (bypasses the SDK), so nothing ever approved the Seaport conduit to
// move the NFT out on the seller's behalf. Missing this causes TransferCallerNotOwnerNorApproved()
// on fulfillment. Call once per wallet+contract; setApprovalForAll persists on-chain after that.
async function ensureApproval(wallet, contractAddress, provider, chain) {
  const conduitAddress = getDefaultConduit(chain).address;
  const contract = new ethers.Contract(contractAddress, ERC721_ABI, wallet);
  if (await contract.isApprovedForAll(wallet.address, conduitAddress)) return { sent: false };
  const tx = await contract.setApprovalForAll(conduitAddress, true);
  const receipt = await tx.wait();
  if (receipt.status !== 1) throw new Error(`setApprovalForAll reverted (tx ${tx.hash})`);
  return { sent: true, hash: tx.hash };
}

async function checkStillOwned(contractAddress, tokenId, expectedOwner, provider) {
  const contract = new ethers.Contract(contractAddress, ERC721_ABI, provider);
  try {
    const currentOwner = await contract.ownerOf(tokenId);
    return currentOwner.toLowerCase() === expectedOwner.toLowerCase();
  } catch (err) {
    // Only "call reverted / no ownerOf" means not owned. A network or RPC rate limit error must
    // NOT be reported as "sold", so let it bubble up as a real failure.
    if (err.code === 'CALL_EXCEPTION' || err.code === 'BAD_DATA') return false;
    throw err;
  }
}

module.exports = {
  CHAIN_MAP,
  Chain,
  makeSdk,
  parsePriceInput,
  roundPriceForChain,
  getCollectionSlug,
  getFloorPrice,
  getOwnedTokenIds,
  getOpenListings,
  estimateApprovalGas,
  ensureApproval,
  checkStillOwned,
  getTransportStats: transport.getStats,
};

