// Toolbar button: toggle the panel on YouTube Music, or open YouTube Music's
// playlist library (and the panel) from any other tab.
const LIBRARY_URL = 'https://music.youtube.com/library/playlists';
const pendingOpen = new Set();

function isMusic(url) {
  return typeof url === 'string' && url.startsWith('https://music.youtube.com/');
}

async function send(tabId, type) {
  try {
    await chrome.tabs.sendMessage(tabId, { type });
    return true;
  } catch {
    return false;
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  if (isMusic(tab.url)) {
    // If the tab was open before the extension was installed, the content
    // scripts aren't there yet, so reload it once and open the panel after.
    if (!(await send(tab.id, 'playlist-tidy:toggle'))) {
      pendingOpen.add(tab.id);
      chrome.tabs.reload(tab.id);
    }
    return;
  }
  const created = await chrome.tabs.create({ url: LIBRARY_URL });
  pendingOpen.add(created.id);
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (!pendingOpen.has(tabId) || info.status !== 'complete' || !isMusic(tab.url)) return;
  pendingOpen.delete(tabId);
  for (let i = 0; i < 10; i++) {
    if (await send(tabId, 'playlist-tidy:open')) return;
    await new Promise((r) => setTimeout(r, 500));
  }
});

chrome.tabs.onRemoved.addListener((tabId) => pendingOpen.delete(tabId));
