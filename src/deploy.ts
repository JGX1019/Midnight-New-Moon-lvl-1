/**
 * deploy.ts — deploys the counter.compact contract to the selected
 * network (--network preview | preprod | undeployed).
 *
 * Flow:
 *   1. Resolve network + wallet seed (persisted in .midnight-state.json).
 *   2. Build the wallet, wait for sync + funds (skip funds wait with FUNDED=1).
 *   3. Configure midnight-js providers (proof server, indexer, private state).
 *   4. Deploy the contract, retrying on transient "Not enough Dust" /
 *      "Failed to connect to Proof Server" errors.
 *   5. Record the deployed address to .midnight-state.json and print it.
 */
import path from 'node:path';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { Buffer } from 'node:buffer';

import { NETWORK_CONFIGS, getOrCreateSeed, recordDeployment, resolveNetwork } from './network.js';
import { buildWalletAndWaitForFunds, createWalletAndMidnightProvider } from './wallet.js';

const network = resolveNetwork();
setNetworkId(network);
const net = NETWORK_CONFIGS[network];

const currentDir = path.resolve(new URL(import.meta.url).pathname, '..');
const zkConfigPath = path.resolve(currentDir, '..', 'managed', 'counter');

async function loadContractModule() {
  const modPath = path.resolve(zkConfigPath, 'contract', 'index.js');
  return import(modPath);
}

/** Retries an async operation, ignoring known-transient error messages. */
async function withRetry<T>(fn: () => Promise<T>, attempts = 50, delayMs = 5_000): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      const msg = e instanceof Error ? e.message : String(e);
      const transient = /not enough dust|failed to connect to proof server/i.test(msg);
      if (!transient) throw e;
      console.log(`  Retry ${i + 1}/${attempts} after transient error: ${msg}`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastError;
}

/** Polls the proof server until it responds, so the first deploy attempt isn't wasted on a cold server. */
async function waitForProofServer(url: string, attempts = 30, delayMs = 2_000): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  console.log('  Warning: proof server did not respond in time, attempting deploy anyway.');
}

async function main() {
  console.log(`\nDeploying counter contract to: ${network}\n`);

  if (network !== 'undeployed' && net.faucet) {
    console.log(`If your wallet needs funds, use the faucet: ${net.faucet}\n`);
  }

  const seed = getOrCreateSeed(network);
  const walletCtx = await buildWalletAndWaitForFunds(net, seed);

  console.log('\nWaiting for proof server...');
  await waitForProofServer(net.proofServer);

  const { Contract } = await loadContractModule();

  const walletAndMidnightProvider = await createWalletAndMidnightProvider(walletCtx);
  const zkConfigProvider = new NodeZkConfigProvider(zkConfigPath);
  const accountId = walletAndMidnightProvider.getCoinPublicKey();
  const storagePassword = `${Buffer.from(accountId, 'hex').toString('base64')}!`;

  const providers = {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: 'counter-private-state',
      accountId,
      privateStoragePasswordProvider: () => storagePassword,
    }),
    publicDataProvider: indexerPublicDataProvider(net.indexer, net.indexerWS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(net.proofServer, zkConfigProvider),
    walletProvider: walletAndMidnightProvider,
    midnightProvider: walletAndMidnightProvider,
  };

  const compiledContract = CompiledContract.make('counter', Contract).pipe(
    CompiledContract.withVacantWitnesses,
    CompiledContract.withCompiledFileAssets(zkConfigPath),
  );

  console.log('\nDeploying contract...');
  const deployed = await withRetry(() =>
    deployContract(providers as any, {
      compiledContract: compiledContract as any,
      args: [],
    } as any),
  );

  const contractAddress = deployed.deployTxData.public.contractAddress;
  recordDeployment(network, contractAddress);

  console.log(`
${'='.repeat(66)}
  Deployed successfully!
  Network:  ${network}
  Address:  ${contractAddress}
${'='.repeat(66)}
`);

  await walletCtx.wallet.stop();
}

main().catch((e) => {
  console.error('Deploy failed:', e);
  process.exit(1);
});
