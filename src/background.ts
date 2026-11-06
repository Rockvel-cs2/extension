import { answerSite } from './steam.ts';
import { FOLLOW, followTrades, openTrades, ROUTINE_MINUTES, routineGap } from './trades.ts';

// Chrome and Edge: only the pages listed under externally_connectable in the manifest can reach this.
chrome.runtime.onMessageExternal.addListener(answerSite);
// Firefox: content.ts passes the page's request on.
chrome.runtime.onMessage.addListener(answerSite);

// Listeners go on at the top level, so an alarm can wake the service worker. A look sets how often the alarm rings.
chrome.alarms.onAlarm.addListener((alarm) => followTrades(routineGap(alarm.periodInMinutes)));
chrome.notifications.onClicked.addListener(openTrades);
chrome.alarms.get(FOLLOW).then((alarm) => {
  if (!alarm) void chrome.alarms.create(FOLLOW, { periodInMinutes: ROUTINE_MINUTES });
});
// Some sellers open the browser just to send an offer and close it again, so waking up counts as a moment to look.
void followTrades();
