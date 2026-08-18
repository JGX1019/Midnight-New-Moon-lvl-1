/**
 * wallet.ts — builds a WalletFacade (shielded + unshielded + dust) from a
 * hex seed, waits for it to sync and receive testnet funds, registers NIGHT
 * UTXOs for DUST generation, and exposes a WalletProvider + MidnightProvider
 * pair that midnight-js-contracts can use to balance and submit transactions.
 *
 * This mirrors the pattern used by Midnight's official example-counter CLI
 * (midnightntwrk/example-counter) — the HD key derivation, wallet
 * construction, and dust-registration flow here are drawn directly from
 * that reference implementation to match the installed SDK versions.
 */
import { Buffer } from 'node:buffer';
import * as ledger from '@midnight-ntwrk/ledger-v8';
import { unshieldedToken } from '@midnight-ntwrk/ledger-v8';
import { WalletEntrySchema, WalletFacade } from '@midnight-ntwrk/wallet-sdk-facade';
import { DustWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet';
import { HDWallet, Roles, generateRandomSeed } from '@midnight-ntwrk/wallet-sdk-hd';
import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk-shielded';
import {
  createKeystore,
  PublicKey,
  UnshieldedWallet,
  type UnshieldedKeystore,
} from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import { InMemoryTransactionHistoryStorage } from '@midnight-ntwrk/wallet-sdk-abstractions';
import { getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import type { MidnightProvider, WalletProvider } from '@midnight-ntwrk/midnight-js-types';
import { WebSocket } from 'ws';
import * as Rx from 'rxjs';
import type { NetworkConfig } from './network.js';

// GraphQL subscriptions (wallet sync) require a global WebSocket in Node.js.
globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;

export interface WalletContext {
  wallet: WalletFacade;
  shieldedSecretKeys: ledger.ZswapSecretKeys;
  dustSecretKey: ledger.DustSecretKey;
  unshieldedKeystore: UnshieldedKeystore;
}

const DIVIDER = '──────────────────────────────────────────────────────────────';

const formatBalance = (balance: bigint): string => balance.toLocaleString();

/**
 * Derive HD wallet keys for all three roles (Zswap, NightExternal, Dust)
 * from a hex-encoded seed using BIP-44 style derivation at account 0, index 0.
 */
function deriveKeysFromSeed(seed: string) {
  const hdWallet = HDWallet.fromSeed(Buffer.from(seed, 'hex'));
  if (hdWallet.type !== 'seedOk') {
    throw new Error('Failed to initialize HDWallet from seed');
  }

  const derivationResult = hdWallet.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);

  if (derivationResult.type !== 'keysDerived') {
    throw new Error('Failed to derive keys');
  }

  hdWallet.hdWallet.clear();
  return derivationResult.keys;
}

function buildShieldedConfig(net: NetworkConfig) {
  return {
    networkId: getNetworkId(),
    indexerClientConnection: {
      indexerHttpUrl: net.indexer,
      indexerWsUrl: net.indexerWS,
    },
    provingServerUrl: new URL(net.proofServer),
    relayURL: new URL(net.node.replace(/^http/, 'ws')),
  };
}

function buildUnshieldedConfig(net: NetworkConfig) {
  return {
    networkId: getNetworkId(),
    indexerClientConnection: {
      indexerHttpUrl: net.indexer,
      indexerWsUrl: net.indexerWS,
    },
    txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema),
  };
}

function buildDustConfig(net: NetworkConfig) {
  return {
    networkId: getNetworkId(),
    costParameters: {
      additionalFeeOverhead: 300_000_000_000_000n,
      feeBlocksMargin: 5,
    },
    indexerClientConnection: {
      indexerHttpUrl: net.indexer,
      indexerWsUrl: net.indexerWS,
    },
    provingServerUrl: new URL(net.proofServer),
    relayURL: new URL(net.node.replace(/^http/, 'ws')),
  };
}

/** Wait until the wallet has fully synced with the network. */
export const waitForSync = (wallet: WalletFacade) =>
  Rx.firstValueFrom(
    wallet.state().pipe(
      Rx.throttleTime(5_000),
      Rx.filter((state) => state.isSynced),
    ),
  );

/** Wait until the wallet has a non-zero unshielded (tNight) balance. */
export const waitForFunds = (wallet: WalletFacade): Promise<bigint> =>
  Rx.firstValueFrom(
    wallet.state().pipe(
      Rx.throttleTime(10_000),
      Rx.filter((state) => state.isSynced),
      Rx.map((s) => s.unshielded.balances[unshieldedToken().raw] ?? 0n),
      Rx.filter((balance) => balance > 0n),
    ),
  );

/**
 * Register unshielded NIGHT UTXOs for dust generation. On Preview/Preprod,
 * NIGHT generates DUST over time, but only after the UTXOs have been
 * explicitly designated for dust generation via an on-chain transaction.
 */
async function registerForDustGeneration(wallet: WalletFacade, unshieldedKeystore: UnshieldedKeystore): Promise<void> {
  const state = await Rx.firstValueFrom(wallet.state().pipe(Rx.filter((s) => s.isSynced)));

  if (state.dust.availableCoins.length > 0) {
    console.log(`  Dust tokens already available (${formatBalance(state.dust.balance(new Date()))} DUST)`);
    return;
  }

  const nightUtxos = state.unshielded.availableCoins.filter(
    (coin: any) => coin.meta?.registeredForDustGeneration !== true,
  );

  if (nightUtxos.length === 0) {
    console.log('  Waiting for dust tokens to generate...');
    await Rx.firstValueFrom(
      wallet.state().pipe(
        Rx.throttleTime(5_000),
        Rx.filter((s) => s.isSynced),
        Rx.filter((s) => s.dust.balance(new Date()) > 0n),
      ),
    );
    return;
  }

  console.log(`  Registering ${nightUtxos.length} NIGHT UTXO(s) for dust generation...`);
  const recipe = await wallet.registerNightUtxosForDustGeneration(
    nightUtxos,
    unshieldedKeystore.getPublicKey(),
    (payload) => unshieldedKeystore.signData(payload),
  );
  const finalized = await wallet.finalizeRecipe(recipe);
  await wallet.submitTransaction(finalized);

  console.log('  Waiting for dust tokens to generate...');
  await Rx.firstValueFrom(
    wallet.state().pipe(
      Rx.throttleTime(5_000),
      Rx.filter((s) => s.isSynced),
      Rx.filter((s) => s.dust.balance(new Date()) > 0n),
    ),
  );
}

/**
 * Build (or restore) a wallet from a hex seed, wait for it to sync, print
 * the wallet's addresses, and — unless FUNDED=1 is set — wait for the
 * wallet to receive testnet tokens from the network faucet.
 */
export async function buildWalletAndWaitForFunds(net: NetworkConfig, seed: string): Promise<WalletContext> {
  const keys = deriveKeysFromSeed(seed);
  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(keys[Roles.Dust]);
  const unshieldedKeystore = createKeystore(keys[Roles.NightExternal], getNetworkId());

  const walletConfig = {
    ...buildShieldedConfig(net),
    ...buildUnshieldedConfig(net),
    ...buildDustConfig(net),
  };

  const wallet = await WalletFacade.init({
    configuration: walletConfig,
    shielded: (cfg) => ShieldedWallet(cfg).startWithSecretKeys(shieldedSecretKeys),
    unshielded: (cfg) => UnshieldedWallet(cfg).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore)),
    dust: (cfg) => DustWallet(cfg).startWithSecretKey(dustSecretKey, ledger.LedgerParameters.initialParameters().dust),
  });
  await wallet.start(shieldedSecretKeys, dustSecretKey);

  console.log(`
${DIVIDER}
  Wallet Address (fund this with tNight)
${DIVIDER}
  ${unshieldedKeystore.getBech32Address()}
${DIVIDER}
`);

  console.log('Syncing with network...');
  await waitForSync(wallet);
  console.log('Synced.');

  const syncedState = await Rx.firstValueFrom(wallet.state().pipe(Rx.filter((s) => s.isSynced)));
  const balance = syncedState.unshielded.balances[unshieldedToken().raw] ?? 0n;

  if (balance === 0n && process.env.FUNDED !== '1') {
    console.log('Waiting for incoming tokens from faucet...');
    const fundedBalance = await waitForFunds(wallet);
    console.log(`  Balance: ${formatBalance(fundedBalance)} tNight`);
  }

  await registerForDustGeneration(wallet, unshieldedKeystore);

  return { wallet, shieldedSecretKeys, dustSecretKey, unshieldedKeystore };
}

/** Generate a fresh random hex seed for a brand-new wallet. */
export function generateSeedHex(): string {
  return Buffer.from(generateRandomSeed()).toString('hex');
}

/**
 * Build the unified WalletProvider & MidnightProvider for midnight-js.
 * This bridges the wallet-sdk-facade to the midnight-js contract API by
 * implementing balance, sign, finalize, and submit operations.
 */
export async function createWalletAndMidnightProvider(ctx: WalletContext): Promise<WalletProvider & MidnightProvider> {
  const state = await Rx.firstValueFrom(ctx.wallet.state().pipe(Rx.filter((s) => s.isSynced)));
  return {
    getCoinPublicKey() {
      return state.shielded.coinPublicKey.toHexString();
    },
    getEncryptionPublicKey() {
      return state.shielded.encryptionPublicKey.toHexString();
    },
    async balanceTx(tx, ttl?) {
      const recipe = await ctx.wallet.balanceUnboundTransaction(
        tx,
        { shieldedSecretKeys: ctx.shieldedSecretKeys, dustSecretKey: ctx.dustSecretKey },
        { ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000) },
      );
      const signed = await ctx.wallet.signRecipe(recipe, (payload) => ctx.unshieldedKeystore.signData(payload));
      return ctx.wallet.finalizeRecipe(signed);
    },
    submitTx(tx) {
      return ctx.wallet.submitTransaction(tx) as any;
    },
  };
}
