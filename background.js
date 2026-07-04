"use strict";

const STATE_KEY = "newTabsRightState";
const TAB_SOURCE_TTL_MS = 8000;
const MOVE_RETRY_DELAYS_MS = [0, 25, 75, 150, 300, 600];

let initialized = false;
let activeByWindow = {};
let lastActiveByWindow = {};
let sourceByNewTab = {};
let movingTabs = new Set();

function now() {
  return Date.now();
}

function key(id) {
  return String(id);
}

async function loadSessionState() {
  try {
    const data = await chrome.storage.session.get(STATE_KEY);
    const state = data[STATE_KEY] || {};
    activeByWindow = state.activeByWindow || {};
    lastActiveByWindow = state.lastActiveByWindow || {};
    sourceByNewTab = pruneSourceMap(state.sourceByNewTab || {});
  } catch (_) {
    activeByWindow = {};
    lastActiveByWindow = {};
    sourceByNewTab = {};
  }
}

async function saveSessionState() {
  try {
    await chrome.storage.session.set({
      [STATE_KEY]: {
        activeByWindow,
        lastActiveByWindow,
        sourceByNewTab: pruneSourceMap(sourceByNewTab)
      }
    });
  } catch (_) {
    // Session storage is best-effort. Live in-memory state still covers normal use.
  }
}

function pruneSourceMap(map) {
  const cutoff = now();
  const pruned = {};
  for (const [tabId, entry] of Object.entries(map)) {
    if (entry && entry.expiresAt > cutoff) {
      pruned[tabId] = entry;
    }
  }
  return pruned;
}

async function initialize() {
  if (initialized) {
    return;
  }

  initialized = true;
  await loadSessionState();

  try {
    const windows = await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] });
    for (const win of windows) {
      const activeTab = win.tabs?.find(tab => tab.active && tab.id !== undefined);
      if (!activeTab || win.id === undefined) {
        continue;
      }

      const winKey = key(win.id);
      if (activeByWindow[winKey] === undefined) {
        activeByWindow[winKey] = activeTab.id;
      }
    }
  } catch (_) {
    // Some startup paths can race normal-window availability. Event handlers will fill state.
  }

  await saveSessionState();
}

function rememberSource(newTabId, sourceTabId) {
  if (newTabId === undefined || sourceTabId === undefined || newTabId === sourceTabId) {
    return;
  }

  sourceByNewTab[key(newTabId)] = {
    sourceTabId,
    expiresAt: now() + TAB_SOURCE_TTL_MS
  };
}

function consumeRememberedSource(tabId) {
  const tabKey = key(tabId);
  const entry = sourceByNewTab[tabKey];
  delete sourceByNewTab[tabKey];

  if (!entry || entry.expiresAt <= now()) {
    return null;
  }

  return entry.sourceTabId;
}

function getFallbackSourceForTab(tab) {
  const winKey = key(tab.windowId);

  if (tab.active) {
    const previous = lastActiveByWindow[winKey];
    if (previous !== undefined && previous !== tab.id) {
      return previous;
    }
  }

  const current = activeByWindow[winKey];
  if (current !== undefined && current !== tab.id) {
    return current;
  }

  return null;
}

async function getSourceTab(tab, explicitSourceTabId) {
  const candidates = [
    explicitSourceTabId,
    tab.openerTabId,
    tab.id !== undefined ? consumeRememberedSource(tab.id) : null,
    getFallbackSourceForTab(tab)
  ];

  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null || candidate === tab.id) {
      continue;
    }

    try {
      const sourceTab = await chrome.tabs.get(candidate);
      if (sourceTab.windowId === tab.windowId) {
        return sourceTab;
      }
    } catch (_) {
      // Source tab disappeared or lives outside this normal window.
    }
  }

  return null;
}

async function getTargetIndex(sourceTab, movingTab) {
  if (sourceTab.pinned && !movingTab.pinned) {
    try {
      const tabs = await chrome.tabs.query({ windowId: sourceTab.windowId });
      const firstUnpinned = tabs
        .filter(tab => tab.id !== movingTab.id)
        .sort((a, b) => a.index - b.index)
        .find(tab => !tab.pinned);
      return firstUnpinned ? firstUnpinned.index : sourceTab.index + 1;
    } catch (_) {
      return sourceTab.index + 1;
    }
  }

  return sourceTab.index + 1;
}

async function moveTabNextToSource(tabId, explicitSourceTabId, attempt = 0) {
  await initialize();

  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.id === undefined || tab.windowId === undefined) {
      return;
    }

    const sourceTab = await getSourceTab(tab, explicitSourceTabId);
    if (!sourceTab || sourceTab.id === undefined) {
      return;
    }

    const targetIndex = await getTargetIndex(sourceTab, tab);
    if (targetIndex === tab.index) {
      return;
    }

    movingTabs.add(tab.id);
    await chrome.tabs.move(tab.id, { index: targetIndex });
  } catch (_) {
    if (attempt + 1 < MOVE_RETRY_DELAYS_MS.length) {
      setTimeout(() => {
        void moveTabNextToSource(tabId, explicitSourceTabId, attempt + 1);
      }, MOVE_RETRY_DELAYS_MS[attempt + 1]);
    }
  } finally {
    movingTabs.delete(tabId);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void initialize();
});

chrome.runtime.onStartup.addListener(() => {
  void initialize();
});

chrome.tabs.onActivated.addListener(activeInfo => {
  void (async () => {
    await initialize();

    const winKey = key(activeInfo.windowId);
    const previousActiveTabId = activeByWindow[winKey];

    if (previousActiveTabId !== undefined && previousActiveTabId !== activeInfo.tabId) {
      lastActiveByWindow[winKey] = previousActiveTabId;
      rememberSource(activeInfo.tabId, previousActiveTabId);
    }

    activeByWindow[winKey] = activeInfo.tabId;
    await saveSessionState();
  })();
});

chrome.tabs.onCreated.addListener(tab => {
  void (async () => {
    await initialize();

    const explicitSource = tab.openerTabId ?? consumeRememberedSource(tab.id);
    if (explicitSource !== null && explicitSource !== undefined && tab.id !== undefined) {
      rememberSource(tab.id, explicitSource);
    }

    if (tab.id !== undefined) {
      await moveTabNextToSource(tab.id, explicitSource);
      await saveSessionState();
    }
  })();
});

chrome.webNavigation.onCreatedNavigationTarget.addListener(details => {
  void (async () => {
    await initialize();

    rememberSource(details.tabId, details.sourceTabId);
    await saveSessionState();
    await moveTabNextToSource(details.tabId, details.sourceTabId);
  })();
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  void (async () => {
    await initialize();

    delete sourceByNewTab[key(tabId)];
    const winKey = key(removeInfo.windowId);

    if (activeByWindow[winKey] === tabId) {
      delete activeByWindow[winKey];
    }

    if (lastActiveByWindow[winKey] === tabId) {
      delete lastActiveByWindow[winKey];
    }

    await saveSessionState();
  })();
});

chrome.tabs.onMoved.addListener((tabId, moveInfo) => {
  if (movingTabs.has(tabId)) {
    return;
  }

  void (async () => {
    await initialize();
    await saveSessionState();
  })();
});

void initialize();
