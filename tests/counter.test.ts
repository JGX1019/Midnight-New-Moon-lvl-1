/**
 * counter.test.ts — Tests for the Privacy-Preserving Counter contract
 *
 * Tests cover:
 *  1. Circuit logic  — increment and reset circuits behave correctly
 *  2. State transitions — counter accumulates across multiple calls
 *  3. Privacy model — increment_by (private input) never appears in ledger
 */

import {
  createConstructorContext,
  createCircuitContext,
  emptyZswapLocalState,
} from '@midnight-ntwrk/compact-runtime';
import { Contract, ledger } from '../managed/counter/contract/index.js';

const DUMMY_ADDRESS = '0'.repeat(64);
const DUMMY_KEY = '0'.repeat(64);

function freshState() {
  const contract = new Contract({});
  const ctx = createConstructorContext({}, DUMMY_ADDRESS);
  const init = contract.initialState(ctx);
  return { contract, contractState: init.currentContractState, privateState: init.currentPrivateState };
}

function getCount(contractState: any): bigint {
  return ledger(contractState.data ?? contractState).count;
}

function callIncrement(contract: Contract<any>, contractState: any, privateState: any, amount: bigint) {
  const ctx = createCircuitContext(DUMMY_ADDRESS, emptyZswapLocalState(DUMMY_KEY), contractState, privateState);
  const result = contract.circuits.increment(ctx, amount);
  return { chargedState: result.context.currentQueryContext.state, privateState: result.context.currentPrivateState };
}

function callReset(contract: Contract<any>, contractState: any, privateState: any) {
  const ctx = createCircuitContext(DUMMY_ADDRESS, emptyZswapLocalState(DUMMY_KEY), contractState, privateState);
  const result = contract.circuits.reset(ctx);
  return { chargedState: result.context.currentQueryContext.state, privateState: result.context.currentPrivateState };
}

describe('Counter Contract', () => {
  describe('Circuit logic', () => {
    it('starts at zero after initialisation', () => {
      const { contractState } = freshState();
      expect(getCount(contractState)).toBe(0n);
    });

    it('increment circuit increases count by the given amount', () => {
      const { contract, contractState, privateState } = freshState();
      const r1 = callIncrement(contract, contractState, privateState, 5n);
      expect(ledger(r1.chargedState).count).toBe(5n);
    });

    it('reset circuit brings count back to zero', () => {
      const { contract, contractState, privateState } = freshState();
      const r1 = callIncrement(contract, contractState, privateState, 10n);
      const r2 = callReset(contract, r1.chargedState, r1.privateState);
      expect(ledger(r2.chargedState).count).toBe(0n);
    });

    it('assert rejects a zero increment_by', () => {
      const { contract, contractState, privateState } = freshState();
      expect(() => callIncrement(contract, contractState, privateState, 0n)).toThrow();
    });
  });

  describe('State transitions', () => {
    it('multiple increments accumulate correctly', () => {
      const { contract, contractState, privateState } = freshState();
      const r1 = callIncrement(contract, contractState, privateState, 3n);
      const r2 = callIncrement(contract, r1.chargedState, r1.privateState, 7n);
      const r3 = callIncrement(contract, r2.chargedState, r2.privateState, 1n);
      expect(ledger(r3.chargedState).count).toBe(11n);
    });

    it('reset after multiple increments returns to zero', () => {
      const { contract, contractState, privateState } = freshState();
      const r1 = callIncrement(contract, contractState, privateState, 100n);
      const r2 = callIncrement(contract, r1.chargedState, r1.privateState, 200n);
      const r3 = callReset(contract, r2.chargedState, r2.privateState);
      expect(ledger(r3.chargedState).count).toBe(0n);
    });

    it('counter after reset can be incremented again', () => {
      const { contract, contractState, privateState } = freshState();
      const r1 = callIncrement(contract, contractState, privateState, 50n);
      const r2 = callReset(contract, r1.chargedState, r1.privateState);
      const r3 = callIncrement(contract, r2.chargedState, r2.privateState, 42n);
      expect(ledger(r3.chargedState).count).toBe(42n);
    });
  });

  describe('Privacy model — private inputs never exposed', () => {
    it('ledger only exposes count, not increment_by', () => {
      const { contractState } = freshState();
      const publicState = ledger(contractState.data);
      expect(Object.keys(publicState)).toEqual(['count']);
      expect((publicState as any).increment_by).toBeUndefined();
    });

    it('different private increments are indistinguishable on the public ledger', () => {
      const { contract, contractState, privateState } = freshState();
      const pathA_r1 = callIncrement(contract, contractState, privateState, 2n);
      const pathA_r2 = callIncrement(contract, pathA_r1.chargedState, pathA_r1.privateState, 8n);
      const pathB_r1 = callIncrement(contract, contractState, privateState, 5n);
      const pathB_r2 = callIncrement(contract, pathB_r1.chargedState, pathB_r1.privateState, 5n);
      expect(ledger(pathA_r2.chargedState).count).toBe(10n);
      expect(ledger(pathB_r2.chargedState).count).toBe(10n);
    });

    it('increment_by is not serialised into the contract state', () => {
      const { contract, contractState, privateState } = freshState();
      const r1 = callIncrement(contract, contractState, privateState, 99n);
      const stateStr = r1.chargedState?.toString() ?? '';
      expect(stateStr).not.toContain('increment_by');
    });
  });
});
