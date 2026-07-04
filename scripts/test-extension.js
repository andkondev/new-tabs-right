const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const extensionPath = root;
const browserPath =
  process.env.BRAVE_PATH || "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe";
const userDataDir = path.join(root, "work", `tmp-brave-new-tabs-right-${Date.now()}`);
const remotePort = 14000 + Math.floor(Math.random() * 1000);

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
      this.ws.addEventListener("message", event => {
        const message = JSON.parse(event.data);
        if (!message.id) {
          return;
        }

        const pending = this.pending.get(message.id);
        if (!pending) {
          return;
        }

        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(new Error(`${message.error.message}: ${message.error.data || ""}`));
        } else {
          pending.resolve(message.result || {});
        }
      });
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const message = { id, method, params };
    if (sessionId) {
      message.sessionId = sessionId;
    }

    this.ws.send(JSON.stringify(message));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  close() {
    this.ws?.close();
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(fn, timeoutMs = 10000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const result = await fn();
      if (result) {
        return result;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }

  throw lastError || new Error("Timed out waiting for condition");
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}`);
  }
  return response.json();
}

async function attachToExtensionWorker(client) {
  await client.send("Target.setDiscoverTargets", { discover: true });

  const worker = await waitFor(async () => {
    const { targetInfos } = await client.send("Target.getTargets");
    return targetInfos.find(
      target =>
        target.type === "service_worker" &&
        target.url.startsWith("chrome-extension://") &&
        target.url.endsWith("/background.js"),
    );
  }, 10000);

  const { sessionId } = await client.send("Target.attachToTarget", {
    targetId: worker.targetId,
    flatten: true,
  });
  await client.send("Runtime.enable", {}, sessionId);
  return sessionId;
}

async function evaluate(client, sessionId, expression) {
  const result = await client.send(
    "Runtime.evaluate",
    {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    },
    sessionId,
  );

  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Runtime.evaluate failed");
  }

  return result.result.value;
}

function swScript(body) {
  return `(async () => {
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const orderedTabs = async windowId => {
      const tabs = await chrome.tabs.query({ windowId });
      return tabs
        .sort((a, b) => a.index - b.index)
        .map(tab => ({
          id: tab.id,
          index: tab.index,
          active: tab.active,
          openerTabId: tab.openerTabId
        }));
    };
    const waitFor = async (predicate, timeoutMs = 5000) => {
      const deadline = Date.now() + timeoutMs;
      let last;
      while (Date.now() < deadline) {
        last = await predicate();
        if (last) return last;
        await sleep(50);
      }
      throw new Error("Timed out in service worker waitFor");
    };
    ${body}
  })()`;
}

async function runInServiceWorker(client, sessionId, body) {
  return evaluate(client, sessionId, swScript(body));
}

async function testRepeatedChildren(client, sessionId) {
  const result = await runInServiceWorker(
    client,
    sessionId,
    `
      const win = await chrome.windows.create({
        url: "data:text/html,<title>source-child</title>source",
        focused: true
      });
      const source = win.tabs[0];
      await sleep(250);

      const first = await chrome.tabs.create({
        windowId: win.id,
        url: "data:text/html,<title>child-one</title>child-one",
        openerTabId: source.id,
        active: false
      });
      await waitFor(async () => {
        const tabs = await orderedTabs(win.id);
        return tabs.findIndex(tab => tab.id === first.id) === 1;
      });

      const second = await chrome.tabs.create({
        windowId: win.id,
        url: "data:text/html,<title>child-two</title>child-two",
        openerTabId: source.id,
        active: false
      });

      const order = await waitFor(async () => {
        const tabs = await orderedTabs(win.id);
        const ids = tabs.map(tab => tab.id);
        return ids[0] === source.id && ids[1] === second.id && ids[2] === first.id
          ? tabs
          : false;
      });

      await chrome.windows.remove(win.id);
      return {
        name: "repeated child tabs stay newest-first next to opener",
        order: order.map(tab => tab.id)
      };
    `,
  );

  return result;
}

async function testNewTabButtonShape(client, sessionId) {
  const result = await runInServiceWorker(
    client,
    sessionId,
    `
      const win = await chrome.windows.create({
        url: "data:text/html,<title>current-new-tab</title>current",
        focused: true
      });
      const source = win.tabs[0];
      await sleep(250);

      const filler = await chrome.tabs.create({
        windowId: win.id,
        url: "data:text/html,<title>filler</title>filler",
        active: false
      });
      await waitFor(async () => {
        const tabs = await orderedTabs(win.id);
        return tabs.findIndex(tab => tab.id === filler.id) === 1;
      });

      await chrome.tabs.update(source.id, { active: true });
      await sleep(250);

      const newTab = await chrome.tabs.create({
        windowId: win.id,
        active: true
      });

      const order = await waitFor(async () => {
        const tabs = await orderedTabs(win.id);
        const ids = tabs.map(tab => tab.id);
        return ids[0] === source.id && ids[1] === newTab.id && ids[2] === filler.id
          ? tabs
          : false;
      });

      await chrome.windows.remove(win.id);
      return {
        name: "openerless new tab opens right of current tab",
        order: order.map(tab => tab.id)
      };
    `,
  );

  return result;
}

async function testExternalStyleTab(client, sessionId) {
  const setup = await runInServiceWorker(
    client,
    sessionId,
    `
      const win = await chrome.windows.create({
        url: "data:text/html,<title>external-source</title>external-source",
        focused: true
      });
      const source = win.tabs[0];
      await sleep(250);
      const filler = await chrome.tabs.create({
        windowId: win.id,
        url: "data:text/html,<title>external-filler</title>external-filler",
        active: false
      });
      await waitFor(async () => {
        const tabs = await orderedTabs(win.id);
        return tabs.findIndex(tab => tab.id === filler.id) === 1;
      });
      await chrome.tabs.update(source.id, { active: true });
      await chrome.windows.update(win.id, { focused: true });
      await sleep(250);
      return { windowId: win.id, sourceId: source.id, fillerId: filler.id };
    `,
  );

  await client.send("Target.createTarget", {
    url: `data:text/html,<title>external-style</title>external-style-${Date.now()}`,
  });

  const result = await runInServiceWorker(
    client,
    sessionId,
    `
      const setup = ${JSON.stringify(setup)};
      const order = await waitFor(async () => {
        const tabs = await orderedTabs(setup.windowId);
        const external = tabs.find(tab => tab.id !== setup.sourceId && tab.id !== setup.fillerId);
        if (!external) return false;
        const ids = tabs.map(tab => tab.id);
        return ids[0] === setup.sourceId && ids[1] === external.id && ids[2] === setup.fillerId
          ? tabs
          : false;
      }, 7000);
      await chrome.windows.remove(setup.windowId);
      return {
        name: "openerless external-style tab opens right of last active tab",
        order: order.map(tab => tab.id)
      };
    `,
  );

  return result;
}

async function main() {
  if (!fs.existsSync(browserPath)) {
    throw new Error(`Browser not found: ${browserPath}`);
  }
  if (!fs.existsSync(extensionPath)) {
    throw new Error(`Extension path not found: ${extensionPath}`);
  }

  fs.mkdirSync(userDataDir, { recursive: true });
  const browser = spawn(
    browserPath,
    [
      `--remote-debugging-port=${remotePort}`,
      `--user-data-dir=${userDataDir}`,
      `--load-extension=${extensionPath}`,
      `--disable-extensions-except=${extensionPath}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=BraveRewards",
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  let client;
  try {
    const version = await waitFor(
      () => getJson(`http://127.0.0.1:${remotePort}/json/version`),
      15000,
      150,
    );
    client = new CdpClient(version.webSocketDebuggerUrl);
    await client.connect();

    // Trigger the extension service worker if Brave has not spun it up yet.
    await client.send("Target.createTarget", { url: "about:blank" });
    const sessionId = await attachToExtensionWorker(client);

    const results = [];
    results.push(await testRepeatedChildren(client, sessionId));
    results.push(await testNewTabButtonShape(client, sessionId));
    results.push(await testExternalStyleTab(client, sessionId));

    console.log("All New Tabs Right tests passed:");
    for (const result of results) {
      console.log(`- ${result.name}`);
      console.log(`  ${result.order.join(" | ")}`);
    }

    await client.send("Browser.close").catch(() => {});
  } finally {
    client?.close();
    if (!browser.killed) {
      browser.kill();
    }
    await sleep(500);
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
