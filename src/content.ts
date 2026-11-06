// Firefox only. It has no externally_connectable, so a page cannot message an extension: this script carries the page's
// requests to the background script and each answer back by the request's id. The attribute tells the page that the
// extension is there and which version it is, so the page can turn away a copy too old to trade without asking it.
document.documentElement.setAttribute('data-rockvel-extension', chrome.runtime.getManifest().version);

window.addEventListener('message', (event) => {
  if (event.source !== window || event.data?.rockvel !== 'ask') return;
  const { id, action, steam_id, order_id } = event.data;
  chrome.runtime.sendMessage({ action, steam_id, order_id }, (answer) => {
    window.postMessage({ rockvel: 'answer', id, answer }, location.origin);
  });
});
