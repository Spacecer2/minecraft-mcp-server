import { AsyncLocalStorage } from 'node:async_hooks';

export const botContext = new AsyncLocalStorage<string | null>();
