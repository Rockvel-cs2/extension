import assert from 'node:assert/strict';
import { beforeEach, it } from 'node:test';

type Listener = (event: { source: unknown; data?: unknown }) => void;

const ORIGIN = 'http://localhost:4000';

const listeners: Listener[] = [];
const attributes: [string, string][] = [];
let posted: unknown[][] = [];
let asked: unknown[] = [];
let background: unknown;

const page = {
  addEventListener: (_type: string, listener: Listener) => listeners.push(listener),
  postMessage: (...message: unknown[]) => posted.push(message),
};
Object.assign(globalThis, {
  window: page,
  location: { origin: ORIGIN },
  document: { documentElement: { setAttribute: (name: string, value: string) => attributes.push([name, value]) } },
  chrome: {
    runtime: {
      getManifest: () => ({ version: '9.9.9' }),
      sendMessage: (message: unknown, respond: (answer: unknown) => void) => {
        asked.push(message);
        respond(background);
      },
    },
  },
});
await import('./content.ts');

const fromPage = (data: unknown, source: unknown = page) => listeners[0]({ source, data });

beforeEach(() => {
  posted = [];
  asked = [];
  background = { pages: [] };
});

it('tells the page the extension is there, and its version', () => {
  assert.deepEqual(attributes, [['data-rockvel-extension', '9.9.9']]);
});

it('carries the request to the background and the answer back to this page only, by its id', () => {
  fromPage({ rockvel: 'ask', id: 7, action: 'send', order_id: 'order', steam_id: '1', extra: 'dropped' });

  assert.deepEqual(asked, [{ action: 'send', order_id: 'order', steam_id: '1' }]);
  assert.deepEqual(posted, [[{ rockvel: 'answer', id: 7, answer: { pages: [] } }, ORIGIN]]);
});

it('passes on that the background is gone, for the page to say so', () => {
  background = undefined;
  fromPage({ rockvel: 'ask', id: 1, steam_id: '1' });

  assert.deepEqual(posted, [[{ rockvel: 'answer', id: 1, answer: undefined }, ORIGIN]]);
});

it('ignores other windows and other messages', () => {
  fromPage({ rockvel: 'ask', id: 1, steam_id: '1' }, { another: 'window' });
  fromPage({ rockvel: 'answer', id: 1 });
  fromPage({ rockvel: 'read', steam_id: '1' });
  fromPage('text');
  fromPage(undefined);

  assert.deepEqual(asked, []);
});
