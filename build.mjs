// Both builds share the code, and only the manifest differs. Firefox runs background scripts instead of service workers,
// has no externally_connectable, so the page reaches the extension through src/content.ts, and gives each install a host
// of its own, so the Referer rule is made at run time there instead of from rules.json (src/trades.ts, allowReferer).
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

copyFileSync('manifest.json', 'dist/manifest.json');
for (const file of ['rules.json', 'icon.png']) copyFileSync(file, `dist/${file}`);
copyFileSync('icon.png', 'dist-firefox/icon.png');

const { key, externally_connectable, background, declarative_net_request, host_permissions, ...shared } = JSON.parse(
  readFileSync('manifest.json', 'utf8'),
);
const sites = externally_connectable.matches;
// Firefox's match patterns cannot name a port. The globs can, and keep the rest of localhost out of the pages it enters.
const portless = (pattern) => pattern.replace(/:\d+\//, '/');
const firefox = {
  ...shared,
  host_permissions: host_permissions.map(portless),
  background: { scripts: ['background.js'], type: 'module' },
  content_scripts: [{ matches: sites.map(portless), include_globs: sites, js: ['content.js'], run_at: 'document_start' }],
  browser_specific_settings: { gecko: { id: 'extension@rockvel.store', strict_min_version: '127.0' } },
};
writeFileSync('dist-firefox/manifest.json', JSON.stringify(firefox, null, 2));
