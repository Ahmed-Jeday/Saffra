// Polyfills Node pour le navigateur (Web3Auth / WalletConnect / libs crypto)
import { Buffer } from 'buffer';

globalThis.Buffer = globalThis.Buffer ?? Buffer;
globalThis.global = globalThis.global ?? globalThis;

if (!globalThis.process) {
  globalThis.process = {
    env: {},
    nextTick: (fn: (...args: unknown[]) => void, ...args: unknown[]) =>
      queueMicrotask(() => fn(...args)),
    browser: true,
    version: 'v22.0.0',
  } as unknown as NodeJS.Process;
}
