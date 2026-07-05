# New Tabs Always Open Right of Current

This extension does one thing: it opens new tabs immediately to the right of the current tab in Chromium browsers.

The Chrome Web Store version was accepted as-is. After release, we explored whether the extension should also respect Chrome/Brave's native tab-strip command when a user right-clicks a non-current tab and chooses `New tab to the right`.

## Decision

Leave the extension as shipped.

The name and behavior are literal: new tabs open right of the current tab. If a user wants a new tab beside some other tab, they can first click that tab to make it current.

Trying to support every native tab-strip context-menu edge case would either add awkward UI, add fragile heuristics, or break the desired `+` / `Ctrl+T` behavior.

## What We Tested

### Native menu on a non-current middle tab

Scenario:

```text
1 2 3 4 5
```

Tab `2` is current. The user right-clicks tab `4` and chooses Chrome/Brave's native `New tab to the right`.

Observed:

```text
1 2 3 4 6 5
```

The browser initially creates tab `6` in the correct place, but it may report `openerTabId` as the current tab, not the right-clicked tab. A heuristic can detect this because the new tab appears in the middle of the strip away from the reported opener.

This was technically fixable, but it would make the extension less literal: the new tab would no longer always be placed right of current.

### Native menu on a non-current last tab

Scenario:

```text
1 2 3 4 5
```

Tab `2` is current. The user right-clicks tab `5` and chooses native `New tab to the right`.

Observed by the extension:

```text
1 2 3 4 5 6
```

This looks the same as clicking the toolbar `+` button or pressing `Ctrl+T`: a blank new tab appears at the far right.

That is the core unsolved case. Chromium does not expose a creation reason like `native tab context menu`, and it does not expose which tab was right-clicked for native browser menu items.

### Grouped last tab

Chromium's native `New tab to the right` can inherit the clicked tab's tab group. Chrome exposes `tab.groupId`, so grouped tabs provide a partial signal.

This could fix the last-tab edge case only when the clicked last tab is in a group. It does not solve the normal ungrouped case.

### Focus-change inference

We tested whether opening the native tab-strip menu produces a usable `chrome.windows.onFocusChanged` event, such as a temporary `WINDOW_ID_NONE` blip.

The diagnostic log showed no `windows.onFocusChanged` events around the native tab menu. So there is no reliable focus signal to infer that a native menu was used.

### Custom tab context menu

A custom extension context-menu item works because Chrome tells extensions which tab was clicked for extension-created menu items.

But it adds a second menu item and requires the user to choose the extension's item instead of Chrome/Brave's native `New tab to the right`. That is awkward and not worth shipping for this extension.

### Manifest V2

Manifest V2 would not meaningfully change this.

MV2 had persistent background pages instead of MV3 service workers, but the missing piece is not background lifetime. The missing piece is an API signal. `chrome.tabs.onCreated` still reports the new tab, not why it was created or which tab was targeted by a native browser menu command.

## What Did Not Work

- Trusting `openerTabId`: it can point at the current tab even when the native menu was opened on a different tab.
- Delayed snapshots: useful for diagnostics, but they do not distinguish an ungrouped last-tab native menu action from `+` / `Ctrl+T`.
- `chrome.windows.onFocusChanged`: no usable event appeared during the native tab-strip menu test.
- `groupId`: useful only for grouped tabs, not the common ungrouped last-tab case.
- Content-script blur/focus: would need broader permissions, would fail on browser pages, and would still be noisy.
- Mouse-position heuristics: too fragile across DPI, pinned tabs, tab groups, themes, vertical tabs, and browser variants.
- Native messaging / OS accessibility helper: technically possible, but far too heavy for a lightweight Web Store extension.

## Conclusion

There is no clean way to distinguish this specific case:

```text
Right-click ungrouped last tab -> native New tab to the right
```

from this desired behavior:

```text
Click + or press Ctrl+T -> move new tab right of current
```

without either adding a custom context-menu item or breaking the extension's core `+` / `Ctrl+T` behavior.

So the best product choice is to keep the shipped behavior: new tabs always open right of the current tab.

## Local Development

Run the automated Brave smoke test:

```powershell
npm test
```

Build the Chrome Web Store upload zip:

```powershell
npm run package
```

## Links

- Project homepage: https://andkon.dev/new-tabs-right/
- Repository: https://github.com/andkondev/new-tabs-right
- Issues: https://github.com/andkondev/new-tabs-right/issues
- Email/PayPal/tips: andkon@andkon.com
- Developer site: https://andkon.dev
