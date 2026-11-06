import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, it, mock } from 'node:test';
import { cancelOffer, followTrades, MOST_IN_ONE_OFFER, offerMessage, openTrades, REFERER_RULE, reportFor, sendOffer, type TradeOrder } from './trades.ts';

const SITE = 'http://localhost:4000';
const SELLER = '76561198000000001';
const BUYER_ACCOUNT = 39734274;
const BUYER = '76561198000000002';
const TRADE_URL = `https://steamcommunity.com/tradeoffer/new/?partner=${BUYER_ACCOUNT}&token=abcdefgh`;
const STEAM_PAGE = `<script>g_sessionID = "abc123"; g_steamID = "${SELLER}";</script><div data-loyalty_webapi_token="&quot;tok.en-1&quot;"></div>`;

const ORDER: TradeOrder = {
  id: 'order-1',
  number: '0000abcd',
  status: 'paid',
  asset_id: '100',
  name: 'AK-47 | Redline',
  buyer_steam_id: BUYER,
  trade_url: TRADE_URL,
  paid_at: '2026-11-01T12:00:00Z',
  actions: ['send', 'cancel'],
};

let stored: Record<string, unknown>;
let remembered: Record<string, unknown>;
let steamPage: string;
let opened: string[];
let notified: { id: string; message: string }[];
let manifest: object;
let alarm: { periodInMinutes: number } | undefined;
let sessionRules: unknown[];

/** Who answers what: a test overrides one line of the world. */
let world: Record<string, (init?: RequestInit) => Response>;
let asked: { url: string; init?: RequestInit }[];

const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status });

function askedFor(part: string) {
  return asked.filter(({ url }) => url.includes(part));
}

beforeEach(() => {
  stored = { site: SITE };
  remembered = {};
  steamPage = STEAM_PAGE;
  opened = [];
  notified = [];
  manifest = { declarative_net_request: {} };
  alarm = { periodInMinutes: 3 };
  sessionRules = [];
  asked = [];
  world = {
    '/api/trades/open': json([ORDER]),
    'tradeoffer/new/send': json({ tradeofferid: '555', needs_mobile_confirmation: true }),
    '/offer': json({}),
    '/cancel': json({}),
    GetTradeOffers: json({ response: {} }),
    GetTradeHistory: json({ response: {} }),
    '/api/trades/reports': () => new Response(null, { status: 204 }),
    '/inventory/': json({ success: 1, assets: [{ assetid: '100' }, { assetid: '101' }, { assetid: '102' }] }),
  };
  Object.assign(globalThis, {
    chrome: {
      storage: {
        session: {
          get: async (key: string) => ({ [key]: remembered[key] }),
          set: async (values: object) => Object.assign(remembered, values),
        },
        local: {
          get: async (key: string) => ({ [key]: stored[key] }),
          set: async (values: object) => Object.assign(stored, values),
        },
      },
      notifications: { create: (id: string, options: { message: string }) => notified.push({ id, message: options.message }) },
      i18n: { getUILanguage: () => 'en-US' },
      tabs: { create: async ({ url }: { url: string }) => opened.push(url) },
      runtime: { getManifest: () => manifest, getURL: (path: string) => `moz-extension://f00-uuid${path}` },
      alarms: {
        get: async () => alarm,
        create: async (_name: string, info: { periodInMinutes: number }) => (alarm = info),
      },
      declarativeNetRequest: { updateSessionRules: async (change: unknown) => sessionRules.push(change) },
    },
  });
  mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    asked.push({ url, init });
    if (url === 'https://steamcommunity.com') return new Response(steamPage);
    const answer = Object.entries(world).find(([part]) => url.includes(part));
    assert.ok(answer, `nothing answers ${url}`);
    return answer[1](init);
  });
});

afterEach(() => mock.restoreAll());

it('offers the item to the buyer and writes the offer down on the site', async () => {
  assert.deepEqual(await sendOffer(ORDER.id, SELLER), { offer_id: '555' });

  const [sent] = askedFor('tradeoffer/new/send');
  const form = new URLSearchParams(String(sent.init?.body));
  assert.equal(sent.init?.credentials, 'include');
  assert.equal(form.get('sessionid'), 'abc123');
  assert.equal(form.get('partner'), BUYER);
  assert.deepEqual(JSON.parse(form.get('trade_offer_create_params') ?? ''), { trade_offer_access_token: 'abcdefgh' });

  const offer = JSON.parse(form.get('json_tradeoffer') ?? '');
  assert.deepEqual(offer.me.assets, [{ appid: 730, contextid: '2', amount: 1, assetid: '100' }]);
  assert.deepEqual(offer.them.assets, []);

  assert.equal(form.get('tradeoffermessage'), 'Rockvel #0000abcd');

  const [recorded] = askedFor('/api/offers');
  assert.equal(recorded.url, `${SITE}/api/offers`);
  assert.deepEqual(JSON.parse(String(recorded.init?.body)), { offer_id: '555', order_ids: ['order-1'] });
});

it('puts all the sales waiting to go to the buyer in one offer, and leaves out an item that is gone', async () => {
  const other = '76561198000000003';
  world['/api/trades/open'] = json([
    ORDER,
    { ...ORDER, id: 'order-2', number: '0000ef01', asset_id: '101' },
    { ...ORDER, id: 'order-3', asset_id: '999', trade_url: `${TRADE_URL}2` },
    { ...ORDER, id: 'order-4', asset_id: '102', buyer_steam_id: other },
    { ...ORDER, id: 'order-5', asset_id: '103', offer_id: '444', actions: [] },
  ]);

  assert.deepEqual(await sendOffer(ORDER.id, SELLER), { offer_id: '555', missing: ['order-3'] });

  const form = new URLSearchParams(String(askedFor('tradeoffer/new/send')[0].init?.body));
  const offer = JSON.parse(form.get('json_tradeoffer') ?? '');
  assert.deepEqual(offer.me.assets.map(({ assetid }: { assetid: string }) => assetid), ['100', '101']);
  assert.equal(form.get('tradeoffermessage'), 'Rockvel #0000abcd #0000ef01');
  assert.deepEqual(JSON.parse(form.get('trade_offer_create_params') ?? ''), { trade_offer_access_token: 'abcdefgh2' });
  assert.deepEqual(JSON.parse(String(askedFor('/api/offers')[0].init?.body)).order_ids, ['order-1', 'order-2']);
});

it('makes the offer again without a deal that was called off meanwhile', async () => {
  const second = { ...ORDER, id: 'order-2', asset_id: '101' };
  const lists = [[ORDER, second], [second]];
  world['/api/trades/open'] = () => new Response(JSON.stringify(lists.length > 1 ? lists.shift() : lists[0]));
  const answers = [json({ code: 'order_moved_on' }, 409), json({})];
  world['/offer'] = () => answers.shift()!();
  let offers = 554;
  world['tradeoffer/new/send'] = () => new Response(JSON.stringify({ tradeofferid: String(++offers) }));

  assert.deepEqual(await sendOffer(ORDER.id, SELLER), { offer_id: '556' });

  assert.equal(askedFor('tradeoffer/555/cancel').length, 1);
  assert.deepEqual(JSON.parse(String(askedFor('/api/offers')[1].init?.body)), { offer_id: '556', order_ids: ['order-2'] });
});

it('says when Steam keeps too many offers open', async () => {
  world['tradeoffer/new/send'] = json({ strError: 'There was an error sending your trade offer. Please try again later. (25)' }, 500);
  assert.deepEqual(await sendOffer(ORDER.id, SELLER), { error: 'offer_limit' });
});

it('sends nothing when every item is gone from the inventory', async () => {
  world['/inventory/'] = json({ success: 1, assets: [{ assetid: '7' }] });
  assert.deepEqual(await sendOffer(ORDER.id, SELLER), { error: 'item_gone' });
  assert.equal(askedFor('tradeoffer/new/send').length, 0);
});

it('lets Steam judge when the inventory cannot be read', async () => {
  world['/inventory/'] = json(null, 500);
  assert.deepEqual(await sendOffer(ORDER.id, SELLER), { offer_id: '555' });
});

it('brings an offer that an older copy of the extension left behind to the site', async () => {
  stored['unrecorded'] = [{ order_id: ORDER.id, offer_id: '444' }];
  await followTrades(0);
  assert.deepEqual(JSON.parse(String(askedFor('/api/offers')[0].init?.body)), { offer_id: '444', order_ids: [ORDER.id] });
  assert.deepEqual(stored['unrecorded'], []);
});

it('cancels the offer it just made if the deal was called off meanwhile', async () => {
  world['/offer'] = json({ code: 'order_moved_on' }, 409);

  assert.deepEqual(await sendOffer(ORDER.id, SELLER), { error: 'order_closed' });

  const [cancelled] = askedFor('tradeoffer/555/cancel');
  assert.equal(new URLSearchParams(String(cancelled.init?.body)).get('sessionid'), 'abc123');
});

it('will not send from another Steam account', async () => {
  assert.deepEqual(await sendOffer(ORDER.id, '76561198000000099'), { error: 'wrong_account' });
  assert.equal(askedFor('tradeoffer/new/send').length, 0);
});

it('says when this browser is not signed in to Steam', async () => {
  mock.restoreAll();
  mock.method(globalThis, 'fetch', async (url: string) =>
    url === 'https://steamcommunity.com' ? new Response('<html>') : json([ORDER])(),
  );
  assert.deepEqual(await sendOffer(ORDER.id, SELLER), { error: 'steam_signed_out' });
});

it('passes on why Steam refused', async () => {
  world['tradeoffer/new/send'] = json({ strError: 'There was an error (15)' }, 500);
  assert.deepEqual(await sendOffer(ORDER.id, SELLER), { error: 'steam_refused', detail: 'There was an error (15)' });
  assert.equal(askedFor('/offer').length, 0);
});

it('sends nothing for an order the site does not list', async () => {
  assert.deepEqual(await sendOffer('someone-elses', SELLER), { error: 'no_order' });
  assert.equal(askedFor('tradeoffer/new/send').length, 0);
});

it('sends nothing for a deal that ended or already has its offer', async () => {
  for (const order of [{ ...ORDER, status: 'cancelled', actions: [] }, { ...ORDER, offer_id: '555', actions: [] }]) {
    world['/api/trades/open'] = json([order]);
    assert.deepEqual(await sendOffer(ORDER.id, SELLER), { error: 'no_order' });
  }
  assert.equal(askedFor('tradeoffer/new/send').length, 0);
});

it('cancels an offer and reports at once', async () => {
  world['/api/trades/open'] = json([{ ...ORDER, status: 'sent', offer_id: '555', actions: ['close_offer'] }]);

  assert.deepEqual(await cancelOffer(ORDER.id), { cancelled: true });

  assert.equal(askedFor('tradeoffer/555/cancel').length, 1);
  assert.equal(askedFor('GetTradeOffers').length, 1);
});

it('has nothing to cancel without an offer', async () => {
  assert.deepEqual(await cancelOffer(ORDER.id), { error: 'no_order' });
  assert.equal(askedFor('/cancel').length, 0);
});

it('reports only what concerns the orders', () => {
  const given = (...ids: string[]) => ids.map((assetid) => ({ assetid }));
  const report = reportFor(
    [{ ...ORDER, offer_id: '555' }],
    [
      { tradeofferid: '555', trade_offer_state: 3, accountid_other: BUYER_ACCOUNT, items_to_give: given('100'), time_created: 10 },
      { tradeofferid: '556', trade_offer_state: 2, accountid_other: BUYER_ACCOUNT, items_to_give: given('100'), time_created: 11 },
      { tradeofferid: '777', trade_offer_state: 2, accountid_other: 1, items_to_give: given('999'), time_created: 12 },
    ],
    [
      { tradeid: '9', status: 3, steamid_other: BUYER, assets_given: given('100'), time_init: 20 },
      { tradeid: '8', status: 3, steamid_other: BUYER, assets_given: given('999'), time_init: 21 },
    ],
  );

  assert.deepEqual(report.offers.map(({ offer_id }) => offer_id), ['555', '556']);
  assert.deepEqual(report.offers[0], {
    offer_id: '555', state: 3, given_asset_ids: ['100'], received_asset_ids: [], other_steam_id: BUYER, time_created: 10,
  });
  assert.deepEqual(report.trades, [{ trade_id: '9', status: 3, given_asset_ids: ['100'], other_steam_id: BUYER, time_init: 20 }]);
});

it('never sends the Steam token to the site', async () => {
  world['GetTradeOffers'] = json({
    response: { trade_offers_sent: [{ tradeofferid: '555', trade_offer_state: 2, accountid_other: BUYER_ACCOUNT, items_to_give: [{ assetid: '100' }], time_created: 1 }] },
  });

  await followTrades(0);

  assert.equal(askedFor('GetTradeOffers')[0].url.includes('access_token=tok.en-1'), true);
  const [report] = askedFor('/api/trades/reports');
  assert.ok(report);
  assert.equal(String(report.init?.body).includes('tok.en-1'), false);
  assert.equal(String(report.init?.body).includes('abc123'), false);
});

it('asks Steam for nothing when there is nothing to follow', async () => {
  world['/api/trades/open'] = json([]);
  await followTrades(0);
  assert.equal(askedFor('steampowered').length, 0);
  assert.equal(askedFor('https://steamcommunity.com').length, 0);
});

it('stops quietly when nobody is signed in on the site', async () => {
  world['/api/trades/open'] = json(null, 401);
  await followTrades(0);
  assert.equal(askedFor('steampowered').length, 0);
});

it('reports even when Steam has nothing on the orders, as that says somebody is watching', async () => {
  await followTrades(0);
  const [report] = askedFor('/api/trades/reports');
  assert.deepEqual(JSON.parse(String(report.init?.body)), { offers: [], trades: [] });
});

it('tells the site why it could not look', async () => {
  steamPage = '<html>';
  await followTrades(0);
  assert.equal(JSON.parse(String(askedFor('/api/trades/reports')[0].init?.body)).problem, 'steam_signed_out');

  steamPage = STEAM_PAGE;
  world['GetTradeOffers'] = json(null, 500);
  world['GetTradeHistory'] = json(null, 500);
  await followTrades(0);
  assert.equal(JSON.parse(String(askedFor('/api/trades/reports')[1].init?.body)).problem, 'steam_unavailable');
});

it('looks once however many things ask at once', async () => {
  await Promise.all([followTrades(), followTrades(), followTrades(), followTrades()]);
  assert.equal(askedFor('/api/trades/open').length, 1);
});

it('looks once more when something just changed during a look', async () => {
  await Promise.all([followTrades(), followTrades(0)]);
  await new Promise((done) => setTimeout(done, 50));
  assert.equal(askedFor('/api/trades/open').length, 2);
});

it('reads Steam\'s heavy page once for a send and the look after it', async () => {
  await sendOffer(ORDER.id, SELLER);
  assert.equal(askedFor('https://steamcommunity.com').filter(({ url }) => url === 'https://steamcommunity.com').length, 1);
});

it('keeps the token out of what survives a closed browser', async () => {
  await followTrades(0);
  assert.equal(JSON.stringify(stored).includes('tok.en-1'), false);
});

const PAID = Math.floor(Date.parse(ORDER.paid_at) / 1000);
const fullPage = (time: number) => Array.from({ length: 100 }, (_, index) => ({ tradeid: `${time}-${index}`, status: 3, steamid_other: BUYER, assets_given: [{ assetid: '7' }], time_init: time }));

it('reads the history back to the oldest sale, as a reversal shows nowhere else', async () => {
  const pages = [fullPage(PAID + 500), fullPage(PAID + 400), [{ tradeid: 'old', status: 12, steamid_other: BUYER, assets_given: [{ assetid: '100' }], time_init: PAID + 300 }]];
  world['GetTradeHistory'] = () => new Response(JSON.stringify({ response: { trades: pages.shift() } }));

  await followTrades(0);

  const history = askedFor('GetTradeHistory');
  assert.equal(history.length, 3);
  assert.ok(history[1].url.includes(`start_after_time=${PAID + 500}&start_after_tradeid=${PAID + 500}-99`));
  const report = JSON.parse(String(askedFor('/api/trades/reports')[0].init?.body));
  assert.deepEqual(report.trades.map(({ trade_id }: { trade_id: string }) => trade_id), ['old']);
});

it('stops reading the history once it has gone past the oldest sale', async () => {
  world['GetTradeHistory'] = json({ response: { trades: fullPage(PAID - 500) } });
  await followTrades(0);
  assert.equal(askedFor('GetTradeHistory').length, 1);
});

it('does not read the history without end', async () => {
  world['GetTradeHistory'] = json({ response: { trades: fullPage(PAID + 500) } });
  await followTrades(0);
  assert.equal(askedFor('GetTradeHistory').length, 5);
});

it('keeps what it read when a later page of the history fails', async () => {
  const pages = [fullPage(PAID + 500)];
  world['GetTradeHistory'] = () => (pages.length ? new Response(JSON.stringify({ response: { trades: pages.shift() } })) : new Response(null, { status: 500 }));
  await followTrades(0);
  assert.equal(JSON.parse(String(askedFor('/api/trades/reports')[0].init?.body)).problem, undefined);
});

for (const [name, failure] of Object.entries({
  'the site is down': json({}, 502),
  'the session ran out': json({}, 401),
  'the origin is not trusted': json({}, 403),
  'the network is gone': (): Response => {
    throw new TypeError('failed to fetch');
  },
})) {
  it(`does not call an offer sent when ${name}, and writes it down later`, async () => {
    world['/offer'] = failure;

    assert.deepEqual(await sendOffer(ORDER.id, SELLER), { error: 'not_recorded' });
    assert.deepEqual(stored['unrecorded'], [{ order_ids: [ORDER.id], offer_id: '555' }]);
    assert.equal(askedFor('tradeoffer/555/cancel').length, 0);

    world['/offer'] = json({});
    await followTrades(0);
    assert.deepEqual(stored['unrecorded'], []);
    assert.deepEqual(JSON.parse(String(askedFor('/api/offers').at(-1)?.init?.body)), { offer_id: '555', order_ids: [ORDER.id] });
  });
}

it('remembers an offer before it asks the site about it', async () => {
  let seen: unknown;
  world['/offer'] = () => {
    seen = structuredClone(stored['unrecorded']);
    return new Response('{}');
  };
  await sendOffer(ORDER.id, SELLER);
  assert.deepEqual(seen, [{ order_ids: [ORDER.id], offer_id: '555' }]);
});

it('closes an offer whose deal was called off while the site could not say so', async () => {
  world['/offer'] = json({}, 502);
  await sendOffer(ORDER.id, SELLER);

  world['/offer'] = json({ code: 'order_moved_on' }, 409);
  await followTrades(0);

  assert.equal(askedFor('tradeoffer/555/cancel').length, 1);
  assert.deepEqual(stored['unrecorded'], []);
});

it('says so when an offer of a closed deal would not close, and keeps at it', async () => {
  world['/offer'] = json({ code: 'order_moved_on' }, 409);
  world['/cancel'] = json({}, 500);

  assert.deepEqual(await sendOffer(ORDER.id, SELLER), { error: 'close_failed' });
  assert.deepEqual(stored['unrecorded'], [{ order_ids: [ORDER.id], offer_id: '555', close: true }]);

  world['/cancel'] = json({});
  await followTrades(0);
  assert.deepEqual(stored['unrecorded'], []);
  assert.equal(askedFor('/api/offers').length, 1);
});

for (const [language, want] of [['ru-RU', 'ru'], ['en-US', 'en'], ['de-DE', 'en']]) {
  it(`opens the deals in ${want} for a browser in ${language}, as the site has no address without a language`, async () => {
    Object.assign((globalThis as unknown as { chrome: object }).chrome, { i18n: { getUILanguage: () => language } });
    await openTrades();
    assert.deepEqual(opened, [`${SITE}/${want}/trades`]);
  });
}

it('keeps the rhythm unless asked', async () => {
  await followTrades();
  await followTrades();
  assert.equal(askedFor('/api/trades/open').length, 1);
  await followTrades(0);
  assert.equal(askedFor('/api/trades/open').length, 2);
});

it('tells the seller about a sale once, and about an unanswered offer once', async () => {
  await followTrades(0);
  await followTrades(0);
  assert.deepEqual(notified.map(({ id }) => id), ['sold:order-1']);
  assert.ok(notified[0].message.includes('AK-47 | Redline'));

  world['/api/trades/open'] = json([{ ...ORDER, status: 'sent', offer_id: '555', actions: ['close_offer'] }]);
  await followTrades(0);
  await followTrades(0);
  assert.deepEqual(notified.map(({ id }) => id), ['sold:order-1', 'cancel:order-1']);
});

it('tells of the sales to one buyer together', async () => {
  world['/api/trades/open'] = json([
    ORDER,
    { ...ORDER, id: 'order-2', asset_id: '101' },
    { ...ORDER, id: 'order-3', asset_id: '102', buyer_steam_id: '76561198000000003', name: 'Kilowatt Case' },
  ]);
  await followTrades(0);
  assert.deepEqual(notified.map(({ id }) => id), ['sold:order-1', 'sold:order-3']);
  assert.ok(notified[0].message.includes('2 × AK-47 | Redline'));

  world['/api/trades/open'] = json([ORDER, { ...ORDER, id: 'order-2', asset_id: '101' }, { ...ORDER, id: 'order-4', asset_id: '103' }]);
  await followTrades(0);
  assert.deepEqual(notified.map(({ id }) => id), ['sold:order-1', 'sold:order-3', 'sold:order-4']);
});

it('speaks the browser\'s language', async () => {
  Object.assign((globalThis as unknown as { chrome: object }).chrome, { i18n: { getUILanguage: () => 'ru' } });
  await followTrades(0);
  assert.ok(notified[0].message.startsWith('Продано'));
});

it('sets the Referer only on the request that makes an offer, as Firefox does at run time', () => {
  const [rule] = JSON.parse(readFileSync('rules.json', 'utf8'));
  assert.equal(rule.condition.urlFilter, 'https://steamcommunity.com/tradeoffer/new/send');

  const { initiatorDomains, ...condition } = rule.condition;
  assert.deepEqual({ ...rule, condition }, REFERER_RULE);
});

it('in Firefox, makes the Referer rule for its own host before the offer goes', async () => {
  manifest = {};
  let rulesWhenSent = 0;
  world['tradeoffer/new/send'] = () => {
    rulesWhenSent = sessionRules.length;
    return new Response(JSON.stringify({ tradeofferid: '555' }));
  };

  await sendOffer(ORDER.id, SELLER);

  assert.equal(rulesWhenSent, 1);
  assert.deepEqual(sessionRules[0], {
    removeRuleIds: [1],
    addRules: [{ ...REFERER_RULE, condition: { ...REFERER_RULE.condition, initiatorDomains: ['f00-uuid'] } }],
  });
});

it('leaves the Referer to rules.json in Chrome and Edge', async () => {
  await sendOffer(ORDER.id, SELLER);
  assert.deepEqual(sessionRules, []);
});

it('names the orders in the message, as many as Steam keeps and then how many more', () => {
  const orders = Array.from({ length: 100 }, (_, index) => ({ ...ORDER, number: String(index).padStart(8, '0') }));
  const numbers = (count: number) => orders.slice(0, count).map(({ number }) => `#${number}`).join(' ');

  assert.equal(offerMessage(orders.slice(0, 12)), `Rockvel ${numbers(12)}`);
  assert.equal(offerMessage(orders.slice(0, 13)), `Rockvel ${numbers(11)} +2`);
  assert.equal(offerMessage(orders), `Rockvel ${numbers(11)} +89`);
  assert.ok(offerMessage(orders).length <= 128);
});

it('looks every half a minute while an offer waits on Steam, and every three minutes otherwise', async () => {
  let created = 0;
  const create = (globalThis as unknown as { chrome: { alarms: { create: (name: string, info: object) => unknown } } }).chrome.alarms.create;
  Object.assign((globalThis as unknown as { chrome: { alarms: object } }).chrome.alarms, {
    create: (name: string, info: object) => (created++, create(name, info)),
  });

  for (const status of ['paid', 'sent']) {
    world['/api/trades/open'] = json([{ ...ORDER, status, offer_id: '555', actions: [] }]);
    await followTrades(0);
    assert.equal(alarm?.periodInMinutes, 0.5, status);
  }
  assert.equal(created, 1);

  world['/api/trades/open'] = json([{ ...ORDER, status: 'protected', offer_id: '555', actions: [] }]);
  await followTrades(0);
  assert.equal(alarm?.periodInMinutes, 3);

  world['/api/trades/open'] = json([]);
  await followTrades(0);
  assert.equal(alarm?.periodInMinutes, 3);
  assert.equal(created, 2);
});

it('speaks the words the site and the services use', () => {
  const contract = JSON.parse(readFileSync('src/contract.json', 'utf8'));

  assert.deepEqual(Object.keys({ ...ORDER, offer_id: '555' }).sort(), Object.keys(contract.trade_order).sort());

  const given = [{ assetid: '100' }];
  const report = reportFor(
    [{ ...ORDER, offer_id: '555' }],
    [{ tradeofferid: '555', trade_offer_state: 3, accountid_other: BUYER_ACCOUNT, items_to_give: given, time_created: 10 }],
    [{ tradeid: '9', status: 3, steamid_other: BUYER, assets_given: given, time_init: 20 }],
  );
  assert.deepEqual(Object.keys(report.offers[0]).sort(), Object.keys(contract.seller_report.offers[0]).sort());
  assert.deepEqual(Object.keys(report.trades[0]).sort(), Object.keys(contract.seller_report.trades[0]).sort());

  for (const problem of ['steam_signed_out', 'steam_unavailable']) assert.ok(contract.watch_problems.includes(problem));
  assert.equal(MOST_IN_ONE_OFFER, contract.most_in_one_offer);
});
