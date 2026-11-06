import { readInventory } from './steam.ts';

const STEAM = 'https://steamcommunity.com';
const ECON_SERVICE = 'https://api.steampowered.com/IEconService';
const FORM = 'application/x-www-form-urlencoded; charset=UTF-8';
/** Steam refreshes an expired session only for a request that looks like a page. */
const PAGE = 'text/html,application/xhtml+xml,application/xml;q=0.9;q=0.8';
const HISTORY_SIZE = 100;
/** How far back a look reads the history. A reversal shows only there, so an active seller needs more than one page. */
const HISTORY_PAGES = 5;
/** Steam keeps no more of an offer's message than this. */
const MESSAGE_LENGTH = 128;

export const FOLLOW = 'follow-trades';
/** How often the alarm looks at Steam when no offer is waiting for Steam Guard or for the buyer. */
export const ROUTINE_MINUTES = 3;
/** While one is, both sides watch for it to move. Chrome rings no alarm sooner. */
const WAITING_MINUTES = 0.5;

/** The alarm never rings exactly on time, so a look a little younger than its period counts for it. */
export function routineGap(minutes = ROUTINE_MINUTES): number {
  return minutes * 48_000;
}
export const ROUTINE_GAP_MS = routineGap();
/** An open page asks for a look as it loads, and ten tabs should still make one look. */
export const PAGE_GAP_MS = 30_000;
/** A send and the look after it share Steam's page instead of reading it twice. */
const SESSION_KEPT_MS = 60_000;

/** How many sales one offer carries: contract.MostInOneOffer, held to it by a test. */
export const MOST_IN_ONE_OFFER = 100;

/** The gap between a 64-bit Steam ID and the 32-bit account number in trade links and offers. */
const ACCOUNT_BASE = 76561197960265728n;

const MESSAGES: Record<string, { sold: string; cancel: string; items: string }> = {
  en: { sold: 'Sold: {name}. Open Rockvel to send it.', cancel: 'The buyer has not accepted {name}. Open Rockvel to cancel the trade.', items: '{count} items' },
  ru: { sold: 'Продано: {name}. Откройте Rockvel, чтобы отправить предмет.', cancel: 'Покупатель не принял {name}. Откройте Rockvel, чтобы отменить обмен.', items: '{count} шт.' },
};

/** A sale as the site gives it to this extension. Only the seller gets to see the buyer's trade link. */
export interface TradeOrder {
  id: string;
  /** The order's short number, as both sides see it on the site. */
  number: string;
  status: string;
  asset_id: string;
  name: string;
  buyer_steam_id: string;
  trade_url: string;
  offer_id?: string;
  paid_at: string;
  /** What the seller can do now. The rules live in core: the extension only follows these. */
  actions: string[];
}

interface SteamOffer {
  tradeofferid: string;
  trade_offer_state: number;
  accountid_other: number;
  items_to_give?: { assetid: string }[];
  items_to_receive?: { assetid: string }[];
  time_created: number;
}

interface SteamTrade {
  tradeid: string;
  status: number;
  steamid_other: string;
  assets_given?: { assetid: string }[];
  time_init: number;
}

/** Why an offer could not be sent or cancelled. The site says it in the seller's language. */
export type TradeError =
  | 'no_order'
  | 'steam_signed_out'
  | 'wrong_account'
  | 'steam_refused'
  | 'order_closed'
  /** The deal was called off, and Steam would not close the offer: the seller must not confirm it. */
  | 'close_failed'
  /** The offer exists and the site has not heard of it yet. This extension keeps trying. */
  | 'not_recorded'
  /** Steam keeps 30 open offers, 5 of them to one person: the rest goes once buyers accept. */
  | 'offer_limit'
  /** None of the items is in the inventory any more. */
  | 'item_gone';

/** Missing names the orders whose items are no longer in the inventory: the offer went without them. */
export type SendResult = { offer_id: string; missing?: string[] } | { error: TradeError; detail?: string };
export type CancelResult = { cancelled: true } | { error: TradeError };

/**
 * An offer that Steam has and the site has not. `close` says the site turned it down and it has to go. A copy of this
 * extension before shared offers stored one order_id.
 */
interface Unrecorded {
  order_ids?: string[];
  order_id?: string;
  offer_id: string;
  close?: boolean;
}

interface SteamSession {
  steamId?: string;
  sessionId?: string;
  token?: string;
}

async function siteAddress(): Promise<string | undefined> {
  return (await chrome.storage.local.get('site'))['site'] as string | undefined;
}

/** What this person sold and has to follow, or null if the site does not know them here. */
async function openOrders(site: string): Promise<TradeOrder[] | null> {
  const response = await fetch(`${site}/api/trades/open`, { credentials: 'include' }).catch(() => null);
  return response?.ok ? response.json().catch(() => null) : null;
}

/**
 * Who this browser is on Steam. The page holds the session id that Steam's forms need and a Web API token that works for
 * the signed-in account. Neither leaves this browser: the token goes only to Steam's own API.
 *
 * Reading them from the page follows csfloat/extension (MIT, © CSFloat Inc.). The page is heavy, so what it gave stays for a
 * minute, in the browser's memory only.
 */
async function steamSession(): Promise<SteamSession> {
  const { steam } = (await chrome.storage.session.get('steam')) as { steam?: { read: number; session: SteamSession } };
  if (steam && Date.now() - steam.read < SESSION_KEPT_MS) return steam.session;

  const response = await fetch(STEAM, { credentials: 'include', headers: { Accept: PAGE } }).catch(() => null);
  const page = (await response?.text().catch(() => '')) ?? '';
  const session = {
    steamId: /g_steamID = "(\d+)"/.exec(page)?.[1],
    sessionId: /g_sessionID = "([0-9a-fA-F]+)"/.exec(page)?.[1],
    token: /data-loyalty_webapi_token="&quot;([a-zA-Z0-9_.-]+)&quot;"/.exec(page)?.[1],
  };
  if (session.sessionId) await chrome.storage.session.set({ steam: { read: Date.now(), session } });
  return session;
}

/**
 * What the offer is for: the numbers of its orders, which the buyer finds among their purchases. As many as Steam keeps,
 * and then how many more.
 */
export function offerMessage(orders: TradeOrder[]): string {
  const numbers = orders.map(({ number }) => `#${number}`);
  let message = `Rockvel ${numbers.join(' ')}`;
  for (let shown = numbers.length - 1; message.length > MESSAGE_LENGTH; shown--) {
    message = `Rockvel ${numbers.slice(0, shown).join(' ')} +${numbers.length - shown}`;
  }
  return message;
}

/**
 * Steam turns down an offer without a Referer from its own pages, and code cannot set that header. In Chrome and Edge
 * rules.json sets it on this extension's requests, by the extension's id. Firefox gives each install a host of its own
 * instead, so there the rule is made for that host when an offer is about to go.
 */
export async function allowReferer(): Promise<void> {
  if (chrome.runtime.getManifest().declarative_net_request) return;
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [REFERER_RULE.id],
    addRules: [{ ...REFERER_RULE, condition: { ...REFERER_RULE.condition, initiatorDomains: [new URL(chrome.runtime.getURL('/')).host] } }],
  });
}

/** The rule of rules.json without its initiator, which a test holds to it. */
export const REFERER_RULE = {
  id: 1,
  priority: 1,
  action: {
    type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
    requestHeaders: [{ header: 'referer', operation: 'set' as chrome.declarativeNetRequest.HeaderOperation, value: 'https://steamcommunity.com/tradeoffer/new' }],
  },
  condition: {
    urlFilter: 'https://steamcommunity.com/tradeoffer/new/send',
    resourceTypes: ['xmlhttprequest' as chrome.declarativeNetRequest.ResourceType],
  },
};

/** Creates the offer. The seller still has to confirm it in Steam Guard, and until then the buyer does not see it. */
async function makeOffer(tradeUrl: string, orders: TradeOrder[], sessionId: string): Promise<SendResult> {
  const link = new URL(tradeUrl);
  const partner = link.searchParams.get('partner');
  const token = link.searchParams.get('token');
  if (!partner || !token) return { error: 'steam_refused' };

  const assets = orders.map(({ asset_id }) => ({ appid: 730, contextid: '2', amount: 1, assetid: asset_id }));
  const form = new URLSearchParams({
    sessionid: sessionId,
    serverid: '1',
    partner: String(BigInt(partner) + ACCOUNT_BASE),
    tradeoffermessage: offerMessage(orders),
    json_tradeoffer: JSON.stringify({
      newversion: true,
      version: 2,
      me: { assets, currency: [], ready: false },
      them: { assets: [], currency: [], ready: false },
    }),
    captcha: '',
    trade_offer_create_params: JSON.stringify({ trade_offer_access_token: token }),
  });
  await allowReferer();
  const response = await fetch(`${STEAM}/tradeoffer/new/send`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': FORM },
    body: form,
  }).catch(() => null);
  const answer = await response?.json().catch(() => null);
  if (typeof answer?.tradeofferid === 'string') return { offer_id: answer.tradeofferid };
  // Steam ends its refusal with the number of the reason, and 25 (LimitExceeded) is a limit on open offers: 5 to one person
  // and 30 in all, those waiting for Steam Guard among them.
  if (/\(25\)\s*$/.test(answer?.strError ?? '')) return { error: 'offer_limit' };
  return { error: 'steam_refused', detail: answer?.strError };
}

function closeOffer(offerId: string, sessionId: string): Promise<Response | null> {
  return fetch(`${STEAM}/tradeoffer/${offerId}/cancel`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': FORM },
    body: new URLSearchParams({ sessionid: sessionId }),
  }).catch(() => null);
}

async function unrecordedOffers(): Promise<Unrecorded[]> {
  return ((await chrome.storage.local.get('unrecorded')) as { unrecorded?: Unrecorded[] }).unrecorded ?? [];
}

async function keepUnrecorded(offer: Unrecorded): Promise<void> {
  const others = (await unrecordedOffers()).filter(({ offer_id }) => offer_id !== offer.offer_id);
  await chrome.storage.local.set({ unrecorded: [...others, offer] });
}

async function forgetUnrecorded(offerId: string): Promise<void> {
  const others = (await unrecordedOffers()).filter(({ offer_id }) => offer_id !== offerId);
  await chrome.storage.local.set({ unrecorded: others });
}

/**
 * Takes an offer that Steam has to where the site knows of it, or to its end. Until the site has written it down, the deal
 * looks as if no offer existed: the buyer could call it off and get the money, and still accept the trade. So the offer stays
 * in storage from the moment Steam made it, and only an answer from the site ends that: a lost request, a site that is down
 * or a closed browser only put it off until the next look.
 */
async function bringToSite(site: string, offer: Unrecorded): Promise<'recorded' | TradeError> {
  if (!offer.close) {
    const recorded = await fetch(`${site}/api/offers`, {
      method: 'POST',
      credentials: 'include',
      body: JSON.stringify({ offer_id: offer.offer_id, order_ids: offer.order_ids ?? [offer.order_id] }),
    }).catch(() => null);
    if (recorded?.ok) {
      await forgetUnrecorded(offer.offer_id);
      return 'recorded';
    }
    if (recorded?.status !== 409) return 'not_recorded';
  }

  const { sessionId } = await steamSession();
  if (sessionId && (await closeOffer(offer.offer_id, sessionId))?.ok) {
    await forgetUnrecorded(offer.offer_id);
    return 'order_closed';
  }
  await keepUnrecorded({ ...offer, close: true });
  return 'close_failed';
}

/** The asset ids of the seller's inventory now, or null when Steam did not show it: then Steam itself has the last word. */
async function heldAssets(steamId: string): Promise<Set<string> | null> {
  const reading = await readInventory(steamId);
  if ('error' in reading) return null;
  return new Set(reading.pages.flatMap(({ assets }) => (assets as { assetid: string }[] | undefined)?.map(({ assetid }) => assetid) ?? []));
}

/**
 * Sends the sold items to the buyer: one offer carries all their sales that wait to be sent, as Steam keeps only 5 offers
 * open to one person. An item gone from the inventory would make Steam refuse the whole
 * offer, so it stays out, and the seller is told to cancel its sale. The offer is written down on the site at once,
 * before anyone can accept it. If a deal was called off in the meantime the site turns the whole offer down, and it goes
 * before the seller confirms it, to be made again without that deal. Only an answer from the site counts as written down.
 */
export async function sendOffer(orderId: unknown, sellerSteamId: unknown): Promise<SendResult> {
  const site = await siteAddress();
  const orders = site ? await openOrders(site) : null;
  const order = orders?.find(({ id }) => id === orderId);
  // The list holds deals that ended lately too, as a late reversal can still surface in them.
  if (!site || !orders || !order?.actions.includes('send')) return { error: 'no_order' };

  const { steamId, sessionId } = await steamSession();
  if (!steamId || !sessionId) return { error: 'steam_signed_out' };
  if (steamId !== sellerSteamId) return { error: 'wrong_account' };
  return sendTo(site, order.buyer_steam_id, steamId, sessionId, orders);
}

async function sendTo(site: string, buyer: string, steamId: string, sessionId: string, orders: TradeOrder[], tries = 2): Promise<SendResult> {
  // The site lists sales oldest first, and the newest one has the buyer's trade link as it is now.
  const waiting = orders.filter(({ buyer_steam_id, actions }) => buyer_steam_id === buyer && actions.includes('send'));
  if (waiting.length === 0) return { error: 'no_order' };
  const held = await heldAssets(steamId);
  const missing = held ? waiting.filter(({ asset_id }) => !held.has(asset_id)) : [];
  const going = waiting.filter((sale) => !missing.includes(sale)).slice(0, MOST_IN_ONE_OFFER);
  if (going.length === 0) return { error: 'item_gone' };

  const made = await makeOffer(waiting.at(-1)!.trade_url, going, sessionId);
  if (!('offer_id' in made)) return made;

  const offer = { order_ids: going.map(({ id }) => id), offer_id: made.offer_id };
  await keepUnrecorded(offer);
  const outcome = await bringToSite(site, offer);
  if (outcome === 'order_closed' && tries > 1) {
    const fresh = await openOrders(site);
    if (fresh) return sendTo(site, buyer, steamId, sessionId, fresh, tries - 1);
  }
  if (outcome !== 'recorded') return { error: outcome };
  await followTrades(0);
  return missing.length ? { ...made, missing: missing.map(({ id }) => id) } : made;
}

/** Closes an offer the buyer left unanswered. The site gives the money back once the report says it is closed. */
export async function cancelOffer(orderId: unknown): Promise<CancelResult> {
  const site = await siteAddress();
  const order = site ? (await openOrders(site))?.find(({ id }) => id === orderId) : undefined;
  if (!order?.offer_id || !order.actions.includes('close_offer')) return { error: 'no_order' };

  const { sessionId } = await steamSession();
  if (!sessionId) return { error: 'steam_signed_out' };
  if (!(await closeOffer(order.offer_id, sessionId))?.ok) return { error: 'steam_refused' };

  await followTrades(0);
  return { cancelled: true };
}

async function steamList<Answer>(address: string): Promise<Answer | null> {
  const response = await fetch(address, { credentials: 'include' }).catch(() => null);
  return response?.ok ? response.json().catch(() => null) : null;
}

function assetIds(assets?: { assetid: string }[]): string[] {
  return (assets ?? []).map(({ assetid }) => assetid);
}

/**
 * Reads the trade history page by page, back to the oldest sale being followed, as a reversal shows nowhere else. Valve does
 * not document the end of the list or its order, so what ends this is a page that is not full, or one that went past the sale.
 */
async function tradesSince(token: string, since: number): Promise<SteamTrade[] | null> {
  const found: SteamTrade[] = [];
  let after = '';
  for (let page = 0; page < HISTORY_PAGES; page++) {
    const answer = await steamList<{ response?: { trades?: SteamTrade[] } }>(
      `${ECON_SERVICE}/GetTradeHistory/v1/?access_token=${token}&max_trades=${HISTORY_SIZE}&include_failed=true${after}`,
    );
    if (!answer) return page === 0 ? null : found;
    const trades = answer.response?.trades ?? [];
    found.push(...trades);
    const last = trades.at(-1);
    if (!last || trades.length < HISTORY_SIZE || last.time_init < since) break;
    after = `&start_after_time=${last.time_init}&start_after_tradeid=${last.tradeid}`;
  }
  return found;
}

function sendReport(site: string, report: object): Promise<unknown> {
  return fetch(`${site}/api/trades/reports`, { method: 'POST', credentials: 'include', body: JSON.stringify(report) }).catch(() => null);
}

let looking: Promise<void> | null = null;
let lookAgain = false;

/**
 * Looks at Steam for the seller's deals, one look at a time however many things ask for it: an alarm, a browser waking up,
 * every open tab. Gap is how old the last look can be for this one to be skipped, and only 0 is worth a second look after
 * the one under way, as something just changed.
 */
export function followTrades(gap = ROUTINE_GAP_MS): Promise<void> {
  if (looking) {
    lookAgain ||= gap === 0;
    return looking;
  }
  looking = look(gap).finally(() => {
    looking = null;
    if (lookAgain) {
      lookAgain = false;
      void followTrades(0);
    }
  });
  return looking;
}

/** An offer of the deal waits for the seller's Steam Guard or for the buyer, and both sides watch for it to move. */
function waitsOnSteam({ offer_id, status }: TradeOrder): boolean {
  return !!offer_id && (status === 'paid' || status === 'sent');
}

/** Sets how often the alarm rings. One that already rings so is left be: setting it again would start its count over. */
async function lookEvery(minutes: number): Promise<void> {
  if ((await chrome.alarms.get(FOLLOW))?.periodInMinutes !== minutes) await chrome.alarms.create(FOLLOW, { periodInMinutes: minutes });
}

/**
 * Brings offers the site has not heard of to it, then reads the seller's offers and trades and tells the site what concerns
 * its orders, and only that: the rest of their history is none of Rockvel's business. A report goes out even with nothing in
 * it, or saying what got in the way: that is how the site tells nothing happening from nobody watching. It runs only with
 * something to follow.
 *
 * Reading both through the Web API token follows csfloat/extension (MIT, © CSFloat Inc.).
 */
async function look(gap: number): Promise<void> {
  const { followed } = (await chrome.storage.local.get('followed')) as { followed?: number };
  if (followed && Date.now() - followed < gap) return;
  await chrome.storage.local.set({ followed: Date.now() });

  const site = await siteAddress();
  if (!site) return;
  for (const offer of await unrecordedOffers()) await bringToSite(site, offer);

  const orders = await openOrders(site);
  await lookEvery(orders?.some(waitsOnSteam) ? WAITING_MINUTES : ROUTINE_MINUTES);
  if (!orders?.length) return;
  await tellSeller(orders);

  const { token } = await steamSession();
  if (!token) {
    await sendReport(site, { offers: [], trades: [], problem: 'steam_signed_out' });
    return;
  }
  const since = Math.min(...orders.map(({ paid_at }) => Math.floor(Date.parse(paid_at) / 1000)));
  const offers = await steamList<{ response?: { trade_offers_sent?: SteamOffer[] } }>(
    `${ECON_SERVICE}/GetTradeOffers/v1/?access_token=${token}&get_sent_offers=true&active_only=true&time_historical_cutoff=${since}`,
  );
  const trades = await tradesSince(token, since);
  if (!offers && !trades) {
    await sendReport(site, { offers: [], trades: [], problem: 'steam_unavailable' });
    return;
  }
  await sendReport(site, reportFor(orders, offers?.response?.trade_offers_sent ?? [], trades ?? []));
}

/** Keeps what concerns these orders, in the form the site takes. */
export function reportFor(orders: TradeOrder[], offers: SteamOffer[], trades: SteamTrade[]) {
  const assets = new Set(orders.map(({ asset_id }) => asset_id));
  const known = new Set(orders.flatMap(({ offer_id }) => offer_id ?? []));
  return {
    offers: offers
      .filter((offer) => known.has(offer.tradeofferid) || assetIds(offer.items_to_give).some((id) => assets.has(id)))
      .map((offer) => ({
        offer_id: offer.tradeofferid,
        state: offer.trade_offer_state,
        given_asset_ids: assetIds(offer.items_to_give),
        received_asset_ids: assetIds(offer.items_to_receive),
        other_steam_id: String(BigInt(offer.accountid_other) + ACCOUNT_BASE),
        time_created: offer.time_created,
      })),
    trades: trades
      .filter((trade) => assetIds(trade.assets_given).some((id) => assets.has(id)))
      .map((trade) => ({
        trade_id: trade.tradeid,
        status: trade.status,
        given_asset_ids: assetIds(trade.assets_given),
        other_steam_id: trade.steamid_other,
        time_init: trade.time_init,
      })),
  };
}

/**
 * A seller cannot act on a sale they do not know of, and the site may be closed. Each thing is said once, and what goes in
 * one offer is said together: the sales to one buyer, the offer the buyer left unanswered.
 */
async function tellSeller(orders: TradeOrder[]): Promise<void> {
  const { told = [] } = (await chrome.storage.local.get('told')) as { told?: string[] };
  const messages = MESSAGES[chrome.i18n.getUILanguage().slice(0, 2)] ?? MESSAGES['en'];
  const said = new Set(told);
  const news = [
    { kind: 'sold', text: messages.sold, action: 'send', together: (order: TradeOrder) => order.buyer_steam_id },
    { kind: 'cancel', text: messages.cancel, action: 'close_offer', together: (order: TradeOrder) => order.offer_id ?? order.id },
  ];
  for (const { kind, text, action, together } of news) {
    const groups = new Map<string, TradeOrder[]>();
    for (const order of orders) {
      if (!order.actions.includes(action) || said.has(`${kind}:${order.id}`)) continue;
      said.add(`${kind}:${order.id}`);
      groups.set(together(order), [...(groups.get(together(order)) ?? []), order]);
    }
    for (const group of groups.values()) {
      chrome.notifications.create(`${kind}:${group[0].id}`, {
        type: 'basic',
        iconUrl: 'icon.png',
        title: 'Rockvel',
        message: text.replace('{name}', namesOf(group, messages.items)),
      });
    }
  }
  await chrome.storage.local.set({ told: [...said] });
}

/** The item, so many of one item, or so many items. */
function namesOf(orders: TradeOrder[], items: string): string {
  if (orders.length === 1) return orders[0].name;
  const same = orders.every(({ name }) => name === orders[0].name);
  return same ? `${orders.length} × ${orders[0].name}` : items.replace('{count}', String(orders.length));
}

/** Clicking a notification opens the page where the seller can act on it. Every page of the site lives under its language. */
export async function openTrades(): Promise<void> {
  const site = await siteAddress();
  const language = chrome.i18n.getUILanguage().slice(0, 2);
  if (site) await chrome.tabs.create({ url: `${site}/${language in MESSAGES ? language : 'en'}/trades` });
}
