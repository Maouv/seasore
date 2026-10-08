'use strict';
// Test EIP-7702 sponsored execution on Robinhood chain.
//
//   node scripts/sponsor7702-test.js              delegate TEST wallet + relay 1 wei
//   node scripts/sponsor7702-test.js --undelegate clear the delegation again
//
// .env (use a THROWAWAY test wallet with 0 ETH; sponsor = coordinator owner):
//   RPC_URL_ROBINHOOD=...
//   S7702_SPONSOR_KEY=0x...   pays all gas, must be SeasoreCoordinator.owner()
//   S7702_TEST_KEY=0x...      throwaway wallet, needs 0 ETH
//   S7702_COORDINATOR=0x...
//   S7702_EXECUTOR=0x...

try { require('dotenv').config(); } catch (_) { /* dotenv optional */ }
const { ethers } = require('ethers');

const { RPC_URL_ROBINHOOD: RPC, S7702_SPONSOR_KEY, S7702_TEST_KEY, S7702_COORDINATOR: COORD, S7702_EXECUTOR: EXEC } = process.env;
const UNDELEGATE = process.argv.includes('--undelegate');

const COORD_ABI = [
  'function owner() view returns (address)',
  'function executor() view returns (address)',
  'function relayShared(address[] accounts,uint256 suppliedValue,uint256 gasLimit,bytes data) payable',
  'event CallResult(uint256 indexed index,address indexed account,bool success,bytes returnData)',
];
const EXEC_IFACE = new ethers.Interface(['function execute(address to,uint256 value,bytes data) payable']);

const eq = (a, b) => a.toLowerCase() === b.toLowerCase();
const log = (...a) => console.log(...a);

async function setDelegation(provider, sponsor, test, target) {
  if (typeof test.authorize !== 'function') {
    throw new Error('Wallet.authorize tidak ada: butuh ethers >= 6.14 (npm i ethers@latest)');
  }
  const net = await provider.getNetwork();
  // Sponsor is a different account than the wallet being delegated, so the
  // authorization nonce is the wallet's CURRENT nonce (not +1).
  const nonce = await provider.getTransactionCount(test.address, 'pending');
  const auth = await test.authorize({ address: target, nonce, chainId: net.chainId });
  // ponytail: explicit gasLimit — estimateGas undershoots type-4 intrinsic gas on RH (48258 vs 48018)
  const tx = await sponsor.sendTransaction({ type: 4, to: test.address, value: 0, gasLimit: 500000, authorizationList: [auth] });
  log('  type-4 tx:', tx.hash);
  const rc = await tx.wait();
  log('  status:', rc.status, '| gas used:', rc.gasUsed.toString());
}

async function main() {
  for (const [k, v] of Object.entries({ RPC_URL_ROBINHOOD: RPC, S7702_SPONSOR_KEY, S7702_TEST_KEY, S7702_COORDINATOR: COORD, S7702_EXECUTOR: EXEC })) {
    if (!v) throw new Error('env belum diisi: ' + k);
  }
  const provider = new ethers.JsonRpcProvider(RPC);
  const sponsor = new ethers.Wallet(S7702_SPONSOR_KEY, provider);
  const test = new ethers.Wallet(S7702_TEST_KEY); // no provider needed to sign
  const coord = new ethers.Contract(COORD, COORD_ABI, sponsor);

  const net = await provider.getNetwork();
  log('chainId:', net.chainId.toString());
  log('sponsor:', sponsor.address, ethers.formatEther(await provider.getBalance(sponsor.address)), 'ETH');
  log('test wallet:', test.address, ethers.formatEther(await provider.getBalance(test.address)), 'ETH');

  if (UNDELEGATE) {
    log('\n[undelegate] clearing delegation...');
    await setDelegation(provider, sponsor, test, ethers.ZeroAddress);
    log('code after:', await provider.getCode(test.address), '(harus 0x)');
    return;
  }

  // 1. coordinator sanity
  const owner = await coord.owner();
  const pinned = await coord.executor();
  if (!eq(owner, sponsor.address)) throw new Error(`sponsor bukan owner coordinator (owner=${owner})`);
  if (!eq(pinned, EXEC)) throw new Error(`executor di coordinator beda (${pinned}); jalankan setExecutor dulu`);
  log('\n[1] coordinator OK (owner = sponsor, executor terpasang)');

  // 2. delegate test wallet -> executor (sponsor pays gas)
  const want = ('0xef0100' + EXEC.slice(2)).toLowerCase();
  let code = (await provider.getCode(test.address)).toLowerCase();
  if (code !== want) {
    log('[2] delegating test wallet (EIP-7702 type-4 tx)...');
    await setDelegation(provider, sponsor, test, EXEC);
    code = (await provider.getCode(test.address)).toLowerCase();
  }
  if (code !== want) throw new Error('delegasi gagal: code=' + code + ' (chain mungkin belum mendukung 7702)');
  log('[2] delegation OK, code =', code);

  // 3. relay: sponsor pays value + gas, wallet (0 ETH) sends 1 wei back to sponsor
  log('[3] relayShared (wallet 0 ETH, value dibayar sponsor)...');
  const data = EXEC_IFACE.encodeFunctionData('execute', [sponsor.address, 1n, '0x']);
  // ponytail: per-call gasLimit eksplisit — estimateGas under-budget utk path 7702 (gasLimit 0 → available-GAS_RESERVE kegedean dikit, inner call OOG)
  const tx = await coord.relayShared([test.address], 1n, 300000, data, { value: 1n, gasLimit: 1000000 });
  log('  tx:', tx.hash);
  const rc = await tx.wait();
  let ok = null;
  let ret = null;
  for (const l of rc.logs) {
    try {
      const p = coord.interface.parseLog(l);
      if (p && p.name === 'CallResult') {
        ok = p.args.success;
        ret = p.args.returnData;
      }
    } catch (_) { /* log milik contract lain */ }
  }
  log('  CallResult success:', ok, '| returnData:', ret ? ethers.toUtf8String(ret) : '0x', '| gas used:', rc.gasUsed.toString());
  log('  test wallet balance after:', ethers.formatEther(await provider.getBalance(test.address)), 'ETH (harus 0)');
  log(ok ? '\nBERHASIL: 7702 sponsored execution jalan di chain ini.' : '\nGAGAL: lihat CallResult/tx di explorer.');
  log('Bersihkan: node scripts/sponsor7702-test.js --undelegate');
}

main().catch((e) => { console.error('ERROR:', e.shortMessage || e.message); process.exit(1); });

