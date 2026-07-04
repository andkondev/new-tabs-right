# New Tabs Always Open Right of Current

Browser extension for Chromium browsers that keeps new tabs beside the tab you were using.

## Behavior

- The new tab button and `Ctrl+T` open to the right of the current tab.
- Links opened from a page stay beside their source tab.
- Repeated links from the same source tab use newest-first ordering.
- Links opened from external apps land beside the last active tab in the target browser window.

## Local Testing

Load this folder as an unpacked extension, or run the automated Brave smoke test:

```powershell
npm test
```

The test can use a custom browser path:

```powershell
$env:BRAVE_PATH = "C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe"
npm test
```

## Packaging

Build the Chrome Web Store upload zip:

```powershell
npm run package
```

The package script writes an extension-only zip under `dist/`.

## Links

- Project homepage: https://andkon.dev/new-tabs-right/
- Repository: https://github.com/andkondev/new-tabs-right
- Issues: https://github.com/andkondev/new-tabs-right/issues
- Email/PayPal/tips: andkon@andkon.com
- Developer site: https://andkon.dev
