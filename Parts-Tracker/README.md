# Parts Tracker

A desktop app for tracking the parts of a vehicle build — photos, prices, retailer
links, order status and running totals — with optional AI-powered UK price
searching.

Built for a specific car project, but nothing is hard-coded: you set your own
vehicle, app name, logo and currency in Settings.

## Download (no Node.js or Git needed)

Grab a ready-to-run Windows build from the
[Releases page](../../releases) — nothing else to install:

- **Parts Tracker Setup 1.0.0.exe** — normal installer. Adds Start Menu and
  desktop shortcuts, and uninstalls from Add/Remove Programs.
- **Parts-Tracker-1.0.0-portable.exe** — a single file, no installation. Run it
  from anywhere and delete it when you are done.

> **Windows will warn you the first time.** These builds are not code-signed, so
> SmartScreen shows "Windows protected your PC". Click **More info**, then
> **Run anyway**. This is normal for small independent apps.

Your products are stored in `%APPDATA%\parts-tracker\data`, separate from the app
itself, so they survive reinstalling or updating.

## Requirements

- [Node.js](https://nodejs.org) 18 or newer
- Git

Built and tested on Windows 11. Electron is cross-platform, so macOS and Linux
should work, but they are untested.

## Install

```bash
git clone <your-repo-url>
cd parts-tracker
npm install
npm start
```

`npm install` downloads Electron (~230MB) plus dependencies, so the first run
takes a few minutes.

**If it starts and says "Electron failed to install correctly"**, the binary
download was skipped. Run it once by hand, then start again:

```bash
node node_modules/electron/install.js
npm start
```

### Making the installers

```bash
npm run dist
```

Writes the installer and portable `.exe` into `dist/`. That folder is not
committed — attach the files to a GitHub Release instead.

### Optional: a desktop shortcut

To launch without a terminal, make a shortcut to
`node_modules\electron\dist\electron.exe` and set its *target* to that path
followed by the project folder in quotes, e.g.

```
"C:\path\to\parts-tracker\node_modules\electron\dist\electron.exe" "C:\path\to\parts-tracker"
```

## AI price search (optional)

The app checks the prices of links you save **for free, with no account**. To
also have it search the web for UK retailers, add an API key in **Settings → AI
price search**:

- **Google Gemini** — free tier available at
  [aistudio.google.com](https://aistudio.google.com). Grounded web search needs
  billing enabled, then costs roughly 1–3p per search.
- **Anthropic Claude** — [console.anthropic.com](https://console.anthropic.com),
  roughly 15–40p per search.

Each search reports what it actually cost. Keys are stored only on your own
machine in `data/settings.json`, which is excluded from the repository and never
committed.

## Features

- **Products tab** — parts as image cards, with a status glow:
  orange = Ordered, light blue = Received, green = Part Fitted, none = Not purchased.
- Click a card for details: description, price, status, order/received dates, and
  website links that open in your default browser.
- Label each part with a type (Engine, Suspension, Tuning, Maintenance, Style).
- **Filter**, **Type** and **Sort** dropdowns narrow by status and/or type, or order
  by name, status or order date. On **Manual order** (with no filter) you can drag
  cards into any order you like; that order is saved and used by the Price Tracker.
- **Price Tracker tab** — Running Total (Ordered + Received + Part Fitted) and
  Final Total (everything).
- **Find cheapest current price in the UK** — checks the product's saved links, and
  with an API key also scans UK retailers by AI web search (exact product only,
  fitment checked against your vehicle, UK sellers only). Every candidate page is
  fetched and verified before it is trusted; the cheapest replaces the price (with
  an Undo) and the three cheapest retailers are saved as links.
- **Quick price check** — re-prices just the saved links. No AI, no cost.
- **Find alternatives from other manufacturers** — finds the equivalent part from
  other brands that still fits and keeps the same characteristics. You pick which
  manufacturers are worth pricing, then it verifies the three cheapest UK retailers
  for each. Differences from your part (e.g. *22mm — yours is 27mm*) are flagged,
  and **Use this part** swaps an alternative in, moving your current part into the
  alternatives list so the change is reversible.
- **Settings tab** — app name and logo, dark/light theme, custom glow colours,
  currency, and *Reset app data* (wipes all products and images after typing
  DELETE to confirm).

## Your data

Everything you enter is stored in the `data` folder, created automatically on
first run:

- `data/products.json` — all product details
- `data/images/` — your uploaded images
- `data/settings.json` — appearance, currency and API keys

**To back up, copy the `data` folder somewhere safe.** To restore, copy it back.

`data/` and `node_modules/` are deliberately excluded from the repository — the
first is personal (and holds your API keys), the second is rebuilt by
`npm install`.

## Licence

MIT
