# Rockvel extension

The browser extension of [Rockvel](https://rockvel.store), a peer-to-peer market for CS2 skins. It reads your CS2 inventory in your own browser for the site, sends the Steam trade offers for your sales and follows them on Steam. It works in Chrome, Edge and Firefox, on Manifest V3.

[Русская версия](README.ru.md)

This repository holds the code of every released version, so anyone can check what the extension does with their Steam account. Rockvel's servers never sign in to Steam: everything that needs your Steam account happens here, in your browser.

## What leaves your browser

- **Your inventory:** the fields `success`, `assets`, `descriptions`, `asset_properties` and `total_inventory_count` of Steam's answer, and nothing else of it, go to the site.
- **Your sales:** the id of each trade offer the extension made, and for the deals you sell on Rockvel only, what Steam shows of their offers and trades: states, item ids, the other side's Steam ID and times. The rest of your trade history stays here.
- **Nothing else.** Steam's cookies, your session id and your Web API token stay in the browser. The extension has no `cookies` permission and never sees the cookies: the browser adds them to requests to Steam itself. The token is read from Steam's page, kept in memory only and sent to Steam's own API only.

## Build

```bash
npm install
npm run build
npm test
```

The build makes two folders from one code: `dist` for Chrome and Edge and `dist-firefox` for Firefox. `build.mjs` derives Firefox's manifest from `manifest.json`.

## Load it in Chrome or Edge

1. Build as above.
2. Open `chrome://extensions` (`edge://extensions` in Edge) and turn on developer mode.
3. Click "Load unpacked" and pick the `dist` folder.
4. Open the site and sign in through Steam.

After a rebuild, click "Reload" on the extension's card and reload the site's page.

## Load it in Firefox and browsers built on it

Tested in Zen 1.24b (Gecko 159).

1. Build as above.
2. Open `about:debugging#/runtime/this-firefox`.
3. Click "Load Temporary Add-on" and pick `dist-firefox/manifest.json`.
4. Open the site and sign in through Steam. Each browser has its own cookies, so sign in to both the site and Steam there.

A temporary add-on is gone once the browser restarts. Firefox keeps only signed add-ons, and `addons.mozilla.org` signs them. Where a browser lets you turn the check off (Zen does, regular Firefox ignores the setting), set `xpinstall.signatures.required` to `false` in `about:config`, zip the contents of `dist-firefox` and install the file from the gear menu of `about:addons`. The setting lets in any unsigned add-on, not only this one.

## How it works

**Inventory.**

1. The site's inventory page gives the extension the Steam ID of the person signed in.
2. The extension reads `steamcommunity.com/inventory/<steam_id>/730/2` page by page, and the browser adds your Steam cookies to these requests.
3. The page gets only the fields listed above and passes them to the site.

**Trades.**

1. On the trades page the seller clicks "Send". The site gives the extension the order's id and the Steam ID of the person signed in.
2. The extension reads `steamcommunity.com` to learn who is signed in to Steam and their `sessionid`. Another Steam account is refused.
3. It makes one offer with all the sales waiting for that buyer, as Steam keeps no more than 5 open offers to one person. It keeps the offer in `chrome.storage` and records it on the site. The buyer sees the offer only after the seller's Steam Guard, so the site refuses an offer for a deal called off meanwhile, and the extension cancels it before anyone can accept it. An offer counts as recorded only once the site says so, and until then the seller is asked not to confirm it. The offer's message names its orders' numbers as both sides see them on the site, for example `Rockvel #1a2b3c4d #5e6f7a8b`. Numbers that do not fit in Steam's 128 characters become "+N".
4. Every 3 minutes, and every half minute while an offer waits for Steam Guard or the buyer, the extension looks at Steam once, however many tabs ask it to. It first records the offers the site has not heard of, then asks the site which of your sales to follow. With something to follow, it reads `GetTradeOffers` and `GetTradeHistory` with the Web API token, page by page back to the oldest sale and no more than 5 pages, and reports only what concerns those sales. With nothing to follow, it asks Steam nothing.
5. A report goes out even when it is empty, or when Steam could not be read, with the reason: that is how the site tells "nothing happened" from "nobody is watching".
6. It notifies you of a new sale and of an offer the buyer has not accepted in 24 hours.

The site asks for the extension's version first and turns away a copy older than the lowest version it trades with. The site cannot update the copies in people's browsers, so this is the only way to switch off a version with a bug.

The rule in `rules.json` sets the `Referer` header on the request that makes an offer: Steam refuses it without one, and code cannot set that header. The rule applies to this extension's own requests only. In Firefox the same rule is made before each offer, for the browser's session (`allowReferer` in `src/trades.ts`).

Only the pages listed under `externally_connectable` can reach the extension: `rockvel.store`, and `localhost:4000` for development. Other extensions cannot.

| Permission | Why |
|---|---|
| `steamcommunity.com` | Your inventory, your Steam session, making and cancelling offers |
| `api.steampowered.com` | Your offers and your trade history |
| `rockvel.store`, `localhost:4000` | Your sales and the reports on them: requests from the background carry the site's session cookie |
| `alarms` | A look every 3 minutes, and every half minute while an offer waits |
| `storage` | The site's address, offers not yet recorded, what you were already told |
| `notifications` | New sales and unanswered offers |
| `declarativeNetRequestWithHostAccess` | The `Referer` header of the request that makes an offer |

## What differs in Firefox

- A background script works instead of a service worker.
- Firefox has no `externally_connectable` ([bug 1319168](https://bugzil.la/1319168)), so a page cannot reach an extension directly. `src/content.ts` does it instead: it marks `<html>` with `data-rockvel-extension` and the extension's version, takes the page's requests through `window.postMessage`, passes them to the background script and returns each answer by its request's id.
- The content script needs access to the site's pages, so Firefox lists them among the permissions.
- Firefox's match patterns cannot name a port ([bug 1362809](https://bugzil.la/1362809)). `matches` and the host permission say `http://localhost/*`, and `include_globs` keeps the content script to `localhost:4000`.
- Each install has an address of its own, `moz-extension://<uuid>`, rather than an id from the key. The `Referer` rule is made for that address, and the site takes the extension's reports from any `moz-extension://` origin: no website can send such an origin, and an extension without the site's permission gets no session cookie with it.
- `onMessageExternal` is open to other extensions in Firefox, so the extension answers only the site and its own content script.

## Extension id

In Chrome and Edge the id follows from `key` in `manifest.json`, so it is the same for everyone who loads the folder, and the site reaches the extension by it. No private key is kept: an unpacked extension needs none, and the Chrome Web Store gives a key and an id of its own on publication. In Firefox the id is `extension@rockvel.store`, set in `build.mjs`.

## Releases

Rockvel develops the extension together with the site and puts every version here as one commit, tagged `v<version>`.

## Credits

How the extension talks to the site, the `postMessage` bridge for Firefox, reading with the seller's own cookies, the form that makes an offer, the `Referer` rule and reading trades through the Web API token follow [csfloat/extension](https://github.com/csfloat/extension) (MIT, © CSFloat Inc.). No code was copied.

## License

[MIT](LICENSE)
