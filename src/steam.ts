import { cancelOffer, followTrades, PAGE_GAP_MS, sendOffer } from './trades.ts';

/** A page holds 2000 items at most. Real inventories fit in one, and the cap only ends a loop on a broken answer. */
const MAX_PAGES = 10;

const STEAM_ID = /^\d{17}$/;

/** All of Steam's answer that leaves this browser. */
interface Page {
  success: 1 | true;
  assets?: unknown[];
  descriptions?: unknown[];
  asset_properties?: unknown[];
  total_inventory_count?: number;
}

export type Reading = { pages: Page[] } | { error: 'private' | 'steam' };

/** What a page can ask of this extension. Without an action it wants the inventory of steam_id. */
interface SiteRequest {
  action?: string;
  steam_id?: unknown;
  order_id?: unknown;
}

/**
 * Firefox ignores externally_connectable and lets any other extension message this one, which would hand it what only
 * this extension's permission can read. A page has no sender id, and content.ts has this extension's.
 */
export function answerSite(
  message: SiteRequest | undefined,
  sender: { id?: string; origin?: string },
  respond: (answer: unknown) => void,
): boolean {
  if (sender.id && sender.id !== chrome.runtime.id) return false;
  answer(message, sender.origin).then(respond);
  return true;
}

/**
 * The manifest lets only the site's pages reach this, so the address they come from is where to report to later. The site
 * asks for the version first: an extension outlives the site's releases, and this is how it turns away an old copy.
 */
async function answer(message: SiteRequest | undefined, origin?: string): Promise<unknown> {
  if (origin) await chrome.storage?.local.set({ site: origin });
  switch (message?.action) {
    case undefined:
      return readInventory(message?.steam_id);
    case 'hello':
      return { version: chrome.runtime.getManifest().version };
    case 'send':
      return sendOffer(message.order_id, message.steam_id);
    case 'cancel':
      return cancelOffer(message.order_id);
    case 'follow':
      return followTrades(PAGE_GAP_MS).then(() => ({}));
  }
  return { error: 'unknown_action' };
}

/**
 * Reads a CS2 inventory page by page, as Steam's own inventory page does: the browser adds the seller's Steam cookies
 * to these requests, this code never sees them, and they go nowhere but to Steam. Signed in, the seller also sees what
 * Steam hides from everyone else.
 *
 * Reading with the seller's own cookies follows csfloat/extension (MIT, © CSFloat Inc.).
 */
export async function readInventory(steamId: unknown): Promise<Reading> {
  if (typeof steamId !== 'string' || !STEAM_ID.test(steamId)) return { error: 'steam' };

  const pages: Page[] = [];
  let start = '';
  for (let page = 0; page < MAX_PAGES; page++) {
    const query = new URLSearchParams({ l: 'english', count: '2000' });
    if (start) query.set('start_assetid', start);

    const response = await fetch(`https://steamcommunity.com/inventory/${steamId}/730/2?${query}`, {
      credentials: 'include',
    }).catch(() => null);
    if (response?.status === 401 || response?.status === 403) return { error: 'private' };
    if (!response?.ok) return { error: 'steam' };

    const answer = await response.json().catch(() => null);
    if (answer?.success !== 1 && answer?.success !== true) return { error: 'steam' };

    const { success, assets, descriptions, asset_properties, total_inventory_count } = answer;
    pages.push({ success, assets, descriptions, asset_properties, total_inventory_count });

    if (!answer.more_items || !answer.last_assetid) break;
    start = answer.last_assetid;
  }
  return { pages };
}
