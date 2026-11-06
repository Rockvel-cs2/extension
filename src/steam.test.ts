import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { afterEach, it, mock } from 'node:test';
import { answerSite, readInventory } from './steam.ts';

const STEAM_ID = '76561198000000001';

/** Answers each request in turn and keeps what was asked. */
function steamAnswers(...answers: (() => Response)[]): { url: string; init?: RequestInit }[] {
  const asked: { url: string; init?: RequestInit }[] = [];
  mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    asked.push({ url, init });
    return answers[asked.length - 1]();
  });
  return asked;
}

const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status });

afterEach(() => mock.restoreAll());

it('reads every page, then stops', async () => {
  const asked = steamAnswers(
    json({ success: 1, assets: [{ assetid: '1' }], more_items: 1, last_assetid: '1', total_inventory_count: 2 }),
    json({ success: 1, assets: [{ assetid: '2' }], total_inventory_count: 2 }),
  );

  const reading = await readInventory(STEAM_ID);

  assert.ok('pages' in reading && reading.pages.length === 2);
  assert.equal(asked.length, 2);
  assert.equal(asked[0].url, `https://steamcommunity.com/inventory/${STEAM_ID}/730/2?l=english&count=2000`);
  assert.equal(asked[1].url, `${asked[0].url}&start_assetid=1`);
  assert.equal(asked[0].init?.credentials, 'include');
});

it('stops on a loop', async () => {
  const again = json({ success: 1, more_items: 1, last_assetid: '1' });
  const asked = steamAnswers(...Array<() => Response>(50).fill(again));

  await readInventory(STEAM_ID);

  assert.equal(asked.length, 10);
});

it('passes on only the fields the site needs', async () => {
  steamAnswers(json({ success: 1, assets: [], rwgrsn: -2, token: 'secret', total_inventory_count: 0 }));

  const reading = await readInventory(STEAM_ID);

  assert.ok('pages' in reading);
  assert.deepEqual(JSON.parse(JSON.stringify(reading.pages[0])), { success: 1, assets: [], total_inventory_count: 0 });
});

it('tells a private inventory from a refusal', async () => {
  for (const status of [401, 403]) {
    steamAnswers(json(null, status));
    assert.deepEqual(await readInventory(STEAM_ID), { error: 'private' });
    mock.restoreAll();
  }
  for (const answer of [json(null, 429), json(null, 500), json({ success: false }), json(null), () => new Response('<html>')]) {
    steamAnswers(answer);
    assert.deepEqual(await readInventory(STEAM_ID), { error: 'steam' });
    mock.restoreAll();
  }
});

it('survives a network failure', async () => {
  mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('failed to fetch');
  });
  assert.deepEqual(await readInventory(STEAM_ID), { error: 'steam' });
});

it('never builds an address from anything but a Steam ID', async () => {
  const asked = steamAnswers();
  for (const bad of ['../../x', '7656119800000000', `${STEAM_ID}/`, 76561198000000001, undefined]) {
    assert.deepEqual(await readInventory(bad), { error: 'steam' });
  }
  assert.equal(asked.length, 0);
});

it('answers the site and its own content script, but no other extension', async () => {
  Object.assign(globalThis, { chrome: { runtime: { id: 'rockvel' } } });
  const asked = steamAnswers(json({ success: 1 }), json({ success: 1 }));

  for (const sender of [{}, { id: 'rockvel' }]) {
    const reading = new Promise((respond) => assert.equal(answerSite({ steam_id: STEAM_ID }, sender, respond), true));
    assert.ok('pages' in ((await reading) as object));
  }

  assert.equal(answerSite({ steam_id: STEAM_ID }, { id: 'another' }, assert.fail), false);
  assert.equal(asked.length, 2);
});

it('tells the site its version, and turns down what it does not know', async () => {
  Object.assign(globalThis, { chrome: { runtime: { id: 'rockvel', getManifest: () => ({ version: '9.9.9' }) } } });
  const answerTo = (action: string) => new Promise((respond) => answerSite({ action }, {}, respond));

  assert.deepEqual(await answerTo('hello'), { version: '9.9.9' });
  assert.deepEqual(await answerTo('something_new'), { error: 'unknown_action' });
});

/** The id Chrome and Edge give the extension: it follows from the key in the manifest. */
function extensionId(): string {
  const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
  const hash = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32);
  return [...hash].map((digit) => String.fromCharCode(97 + parseInt(digit, 16))).join('');
}

/** The site's side of the id. Only the private rockvel holds it, next to this folder. */
const SITE = '../web/src/app/pages/inventory/extension.ts';

it('sets the Referer rule for its own id', () => {
  const [rule] = JSON.parse(readFileSync('rules.json', 'utf8'));
  assert.deepEqual(rule.condition.initiatorDomains, [extensionId()]);
});

it('has the id the site asks for', { skip: !existsSync(SITE) && 'the site is not next to this folder' }, () => {
  assert.ok(readFileSync(SITE, 'utf8').includes(`'${extensionId()}'`));
});
