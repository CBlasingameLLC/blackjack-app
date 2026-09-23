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
| `npm run verify:smoke` | a real Electron boot: `app://` serves the shared engine, localStorage works, the mirror reaches disk, **and no screen scrolls at 1280x800** |
| `npm run verify:icon` | `build/icon.ico` is a structurally valid ICO whose every entry lands on a real PNG, and is actually referenced |
| `npm run icon` | regenerates `build/icon.ico` + `icon.png` from the SVG mark in `scripts/make-icon.js` |
| `npm run shoot` | boots on a seeded profile and screenshots every screen at 1280x800 — for looking, not asserting |

The engine's own suites live in the repo root and run with `npm run verify`
from there. Two are new:

| command | what it proves |
|---|---|
| `node scripts/verify-mastery.js` | sections are independent, the bar sits above the 95% edge-erasure line, a checkout is flawless and consumes only its own section, and mastery survives rust |
| `node scripts/verify-ev.js` | the true-count distribution matches published Hi-Lo frequencies, multiple hands are correlated rather than independent, and risk of ruin refuses to be comforting about a game with no edge |

## The desktop skin

**`public/css/desktop.css` is loaded only inside Electron and it is the only
place this build looks different.** There is no second copy of the markup and
no second renderer: an inline script in `index.html` sets
`html.is-desktop-app` and appends the stylesheet when `window.bjDesktop`
exists, and every rule in that file is gated on the class as well, so the two
can never disagree about which layout is in force. The web and mobile builds
download none of it.

**The identity is a token swap.** The phone's `--gold` is remapped to an ice
cyan and gold is kept under `--money`, used only for the bankroll, the bet,
the chips and a push. On a phone one accent doing "important" and "cash" is
fine; on a screen showing a ladder, a heatmap and a bankroll at once it is a
colour that means neither.

**The bottom bar is a left rail**, pinned with absolute positioning rather
than a grid — `hub.js` shows and hides the hub with an inline
`style.display`, and an inline style beats every stylesheet. `display: grid
!important` would win that fight and also win the wrong one, beating the
`display: none` that hides the hub when a game starts.

**Nothing scrolls, and that is asserted rather than hoped.** The floor is
1280x800 of *content*: `minWidth`/`minHeight` are window sizes, so `main.js`
measures the frame at creation and raises the minimum by exactly that much.
`verify:smoke` then walks every screen at that size with two independent
probes — one comparing `scrollHeight` to `clientHeight`, one comparing every
element's bounding box against its panel's — because the first has a real
blind spot: a `<table>` whose rows exceed its box does not report it. **Both
probes are made to fail on purpose first**, against a planted oversized
element, so a green run means the detector still works.

The four places that *may* scroll are listed in §11 of `desktop.css` and
duplicated in `smoke.js`; the two lists must match. Each is a bounded card,
fully on screen, whose content is genuinely unbounded — a mistake log has no
maximum length. Adding a fifth is a deliberate act in two files, not something
that happens to a layout.

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

## Mastery, checkouts and the Edge

**Mastery is per section, and a section is mastered by volume PLUS a flawless
checkout.** The old five-rung ladder certified "Basic Strategy" at 90% over 30
*pooled* decisions, which was wrong twice over. 90% is one error in ten, and
the published figure is that one repeated basic-strategy error per **twenty**
hands is enough to erase a counter's edge — so the app was congratulating a
player at double the error rate at which counting stops paying. And pooling
`hard`/`soft`/`pairs` into one bucket meant thirty hard totals and no pair and
no soft hand still read as mastered: you could be certified on a chart you had
never been shown. `mastery.js` owns all of it; `gamification.js` reads it and
computes none of it.

**"100%" attaches to the checkout run, not to lifetime accuracy.** A lifetime
100% requirement is unreachable by construction — one mistake in your first
session would poison a section forever — so a checkout is a *bounded,
retryable* run that must be flawless. That is what the word means in the
counting schools, and it is the only reading that can actually be passed.

**Checkouts are gated in tier order; practice never is.** You may drill
anything at any time; you may not certify out of order. Basic strategy is the
stated prerequisite for counting, not a parallel track.

**Mastery is never revoked — rust is reported beside it.** A rolling per-mode
window gives "current form" as a separate fact from "was certified". Taking a
badge away for a bad session punishes the practice that surfaced the problem,
and a player who learns that drilling can cost them a rank stops drilling what
they are worst at.

**The numbers, and where they come from.** Counting down a deck in under 30
seconds (25 as the stretch goal), five clean runs in a row; eight six-deck
shoes near error-free for the final gate, the form the MIT team used; ~20
hours to master basic strategy. Basic strategy asks for 1,450 logged decisions
before a single checkout opens — about forty-eight times the old bar.

**The Edge tab is two views.** `ev.js` is the analytic model — the true-count
distribution a shoe actually produces, the edge at each count, the bet at each
count — and everything else (hourly EV, standard deviation, risk of ruin, N0,
and the bankroll a spread *needs*) falls out of those three. `bankroll.js` is
the real-session ledger, in integer cents, plotting actual profit against what
the game owed you over the same hours. The second line is the point: a profit
curve alone is a record of variance for the first several hundred hours of
anyone's play.

## Known gaps

- **Sound has never worked, on any platform.** `audio.js` fetches five `.wav`
  files from `/assets/sounds/`; `public/assets/` does not exist and never has,
  so the sound setting is a switch wired to nothing. Pre-existing, not
  introduced here. Either ship the files or synthesise the cues with the Web
  Audio API (no assets, works offline).
- ~~Font Awesome loads from a CDN~~ — **fixed.** The solid webfont and its
  stylesheet are served from the bundle, so the app now makes **zero** network
  requests and `verify:smoke` asserts that. It had to be fixed here: the rail's
  five destinations are icon-led, and on a plane they would have been blank.
- **The installer is unsigned**, so first run shows a SmartScreen "unknown
  publisher" prompt once. Signing is a certificate purchase, not a config change.
- **The bankroll renders unrounded** — a 3:2 payout on $25 shows as
  `$10,062.5`. Pre-existing and in the shared money formatting, not the skin.
- **The EV model is analytic, not simulated**, and its assumptions are listed
  at the top of `ev.js`. Two are worth repeating: edge is linear in the true
  count (the standard Hi-Lo approximation, which drifts at extremes where the
  frequencies are negligible), and variance per unit is constant, so risk of
  ruin is a mild *under*-estimate at aggressive spreads. Monte Carlo was
  considered and deliberately not built — the closed form is exact for the
  model it describes and can be checked against numbers a reader can verify.
- **The session ledger is typed in by hand.** Nothing reads a casino's system,
  so the expected line is only as good as the EV figure entered with each
  session. "Use calculator EV" fills it from the current spread for exactly
  that reason.
- **The felt is sparse at 1280x800.** One hand on a table built for a full
  window is the honest look of a single-spot game; multi-spot play is the next
  milestone and is what that space is reserved for. The 340px "coming soon"
  companion rail is hidden on desktop until then.
