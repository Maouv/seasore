'use strict';
// Compile + deploy SeasoreCoordinator & SeasoreExecutor from the VPS.
// No Hardhat/Foundry: only `npm i solc` (ethers is already a dependency).
//
//   node sponsor7702/scripts/deploy.js          (run from the repo root, where .env lives)
//
// .env needs: RPC_URL_ROBINHOOD, S7702_SPONSOR_KEY (dedicated key, funded with a little ETH)

try { require('dotenv').config(); } catch (_) { /* dotenv optional */ }
const fs = require('fs');
const path = require('path');
const solc = require('solc');
const { ethers } = require('ethers');

const { RPC_URL_ROBINHOOD: RPC, S7702_SPONSOR_KEY: KEY } = process.env;
const DIR = path.join(__dirname, '..', 'contracts');
const FILES = ['SeasoreCoordinator.sol', 'SeasoreExecutor.sol'];

function compile() {
  const sources = {};
  for (const f of FILES) sources[f] = { content: fs.readFileSync(path.join(DIR, f), 'utf8') };
  const input = {
    language: 'Solidity',
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'paris', // no PUSH0: safest across L2 / Orbit chains
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors || []).filter((e) => e.severity === 'error');
  if (errors.length) {
    console.error(errors.map((e) => e.formattedMessage).join('\n'));
    throw new Error('compile gagal (kirim pesan error di atas)');
  }
  for (const w of (out.errors || []).filter((e) => e.severity === 'warning')) console.warn(w.formattedMessage);
  const pick = (file, name) => {
    const c = out.contracts[file][name];
    return { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
  };
  return {
    coordinator: pick('SeasoreCoordinator.sol', 'SeasoreCoordinator'),
    executor: pick('SeasoreExecutor.sol', 'SeasoreExecutor'),
  };
}

async function main() {
  if (!RPC) throw new Error('RPC_URL_ROBINHOOD belum diisi');
  if (!KEY) throw new Error('S7702_SPONSOR_KEY belum diisi');

  const { coordinator, executor } = compile();
  console.log('compile OK');

  const provider = new ethers.JsonRpcProvider(RPC);
  const sponsor = new ethers.Wallet(KEY, provider);
  const net = await provider.getNetwork();
  console.log('chainId:', net.chainId.toString());
  console.log('deployer/owner:', sponsor.address, ethers.formatEther(await provider.getBalance(sponsor.address)), 'ETH');

  // 1. coordinator (owner = sponsor)
  const cF = new ethers.ContractFactory(coordinator.abi, coordinator.bytecode, sponsor);
  const c = await cF.deploy(sponsor.address);
  await c.waitForDeployment();
  const cAddr = await c.getAddress();
  console.log('SeasoreCoordinator:', cAddr);

  // 2. executor (pinned to that coordinator)
  const eF = new ethers.ContractFactory(executor.abi, executor.bytecode, sponsor);
  const e = await eF.deploy(cAddr);
  await e.waitForDeployment();
  const eAddr = await e.getAddress();
  console.log('SeasoreExecutor:   ', eAddr);

  // 3. pin the executor in the coordinator (one-time)
  const tx = await c.setExecutor(eAddr);
  await tx.wait();
  console.log('setExecutor OK\n');

  console.log('Tambahkan ke .env:');
  console.log('S7702_COORDINATOR=' + cAddr);
  console.log('S7702_EXECUTOR=' + eAddr);
}

main().catch((e) => { console.error('ERROR:', e.shortMessage || e.message); process.exit(1); });

