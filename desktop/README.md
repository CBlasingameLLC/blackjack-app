# Blackjack Pro — Desktop (Windows)

An Electron shell around **the same trainer the web and mobile builds run**,
plus the two things only a desktop build can offer: a data folder outside
programs can read, and a read-only MCP server so Claude can coach against real
numbers.

## The rule that shapes everything here

**There is no engine in this folder and there must never be one.**

`desktop/` contains a window, a data layer and an MCP server. It contains no
copy of `game-manager.js`, no copy of `strategy-data.js`, no copy of
`gamification.js`. The window loads `dist/` — the output of `npm run build` at
the **repo root** — over a custom `app://` protocol. A strategy-table
correction or a scoring change therefore lands on web, iOS, Android and Windows
at once, because there is only ever one copy of it to change.

The sibling project (Dial) was forced into a `lib/` copy by a Vercel
root-directory constraint and pays for it in every fix. Nothing forces that
here. Do not introduce it.

## Commands

```bash
npm install
npm start           # build the shared renderer, then launch
npm run verify      # data contract + MCP over real stdio + a real Electron boot
npm run dist        # build the NSIS installer into release/
```

Individually:

| command | what it proves |
|---|---|
| `npm run verify:data` | the data folder round-trips, and a *real* failed rename keeps its temp file and recovers next launch |
| `npm run verify:mcp` | the MCP server answers real JSON-RPC over stdio, exposes six read tools and **no writer** |
| `npm run verify:smoke` | a real Electron boot: `app://` serves the shared engine, localStorage works, the mirror reaches disk |

## The data folder

```
~/.blackjack-pro/
  store.json      raw key/value store, verbatim. The durable copy and the
                  restore source — Electron's localStorage lives in the app
                  profile and does NOT survive a reinstall, so without this a
                  reinstall would cost the player every stat they own.
  snapshot.json   everything derived: level, rank, ladder, accuracy by mode,
                  trends, achievements, mistakes. THIS is the file outside
                  programs should read.
```

**Single writer.** The app writes both files. The MCP server and every outside
program only read them. That is what makes it safe to have no locking and no
merge logic anywhere in this project. Do not add a second writer.

**`snapshot.json` is computed in the renderer**, by the same `gamification.js`
the screens render from — never recomputed in the main process or in the MCP
server. A second implementation of "what is this player's accuracy" would drift
from the first, and then a coach would quote numbers the player has never seen.

**Why not `app.getPath('userData')`.** Outside programs need a path that does
not move when the packaging format changes — and anything reading under
`%APPDATA%` from inside an MSIX container (which is where Claude's own desktop
app runs) is served a copy-on-write *snapshot* rather than the real file. An
MCP server reading that would report stale data while the app's own window
showed the truth.

**`BJ_DATA_DIR` overrides the location, and tests MUST set it** — along with
`app.setPath('userData', …)`, because the live store is localStorage and lives
somewhere `BJ_DATA_DIR` does not reach. Isolating only one of the two is how
three smoke runs silently accumulated into each other before anyone noticed.

## Hooking Claude up

```bash
claude mcp add blackjack -- node "C:/Users/19035/Documents/blackjack-app/desktop/mcp/server.js"
```

Tools: `get_player`, `get_stats`, `get_trends`, `get_mistakes`,
`get_achievements`, `get_snapshot`. All read-only, by construction.

## Known gaps

- **Sound has never worked, on any platform.** `audio.js` fetches five `.wav`
  files from `/assets/sounds/`; `public/assets/` does not exist and never has,
  so the sound setting is a switch wired to nothing. Pre-existing, not
  introduced here. Either ship the files or synthesise the cues with the Web
  Audio API (no assets, works offline).
- **Font Awesome loads from a CDN**, so icons are missing with no internet —
  which for an offline desktop trainer is the wrong default. Self-host a subset.
- **The installer is unsigned**, so first run shows a SmartScreen "unknown
  publisher" prompt once. Signing is a certificate purchase, not a config change.
