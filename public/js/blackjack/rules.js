// ==========================================
// THE JUNTO PRESS - BLACKJACK ENGINE (Phase A)
// rules.js — frozen table ruleset
// ==========================================
//
// NAMESPACING CONVENTION (applies to every file in src/assets/js/blackjack/):
//
//   This site has no bundler (plain <script defer> tags, Eleventy passthrough
//   copy only). Every module in this directory attaches its exports to a
//   single shared global namespace object, `window.BJ`, e.g.:
//
//       window.BJ = window.BJ || {};
//       BJ.Rules = { ... };
//       BJ.Shoe = class Shoe { ... };
//
//   Load order in blackjack.html must be: rules.js, shoe.js, hand.js,
//   strategy-data.js, count.js, strategy-engine.js, persistence.js, then
//   game-manager.js / render.js / audio.js / ui-bindings.js / boot.js
//   (later phases) — each `defer`red so execution order matches script
//   order in the document.
//
//   For the DOM-free modules (this file, shoe.js, hand.js, strategy-data.js,
//   strategy-engine.js, count.js, persistence.js) we ALSO support being
//   `require()`d from plain Node for the Phase C verification scripts —
//   there is no `window` object there. Each file guards its browser-global
//   assignment behind `typeof window !== 'undefined'` and, at the bottom,
//   exports the same objects via `module.exports` when `typeof module !==
//   'undefined' && module.exports`. Both environments end up with the exact
//   same objects, so verification scripts exercise the real production code,
//   not a re-implementation.
//
// This file must load FIRST (every other module reads BJ.Rules).

(function (root) {
    'use strict';

    // Shared namespace — created once, reused by every module.
    var BJ = (typeof window !== 'undefined')
        ? (window.BJ = window.BJ || {})
        : (root.BJ = root.BJ || {});

    // --- FROZEN TABLE RULES ---
    // Locked ruleset (see plan §Confirmed decisions #3): 6-deck, S17 (dealer
    // STANDS on soft 17 — this is the corrected value; the old monolith had
    // `h17: true`, which was wrong for the locked ruleset and made the old
    // Strategy tables' edge cases incorrect), DAS always allowed (no UI
    // toggle — DAS is simply un-gated in game-manager.js, see plan §2.3),
    // late surrender allowed, blackjack pays 3:2.
    //
    // There is intentionally NO deck-count or penetration configurability
    // here (plan §2.5 removes the old Settings sliders that mutated these at
    // runtime) — this object is frozen so any accidental future mutation
    // attempt fails loudly instead of silently drifting from the ruleset
    // strategy-data.js was derived for.
    var Rules = Object.freeze({
        decks: 6,
        penetration: 0.75,       // cut card placed 75% into the shoe
        h17: false,              // dealer STANDS on soft 17 (S17) — locked ruleset
        das: true,               // double after split always allowed, not UI-mutable
        lateSurrender: true,     // late surrender allowed (first decision, no ace peek beaten it)
        blackjackPayout: 1.5,    // pays 3:2
        resplitAces: false       // no re-splitting aces (relevant to strategy-data deviations)
    });

    BJ.Rules = Rules;

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = Rules;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
