// ==========================================
// count.js — Hi-Lo running/true count
//
// Fixes bug #1 (double-counting on re-render): the old monolith called
// `updateCount(card)` from inside `renderCard()`, which ran again every
// time `renderTable()` rebuilt the DOM (e.g. every hit) — so a card
// already counted got re-tagged into the running count each rebuild.
// Fix: `registerCard()` is idempotent via a `counted` flag set directly on
// the card object (shoe.js seeds every card with `counted: false`);
// calling it twice on the same card is a no-op the second time. Rendering
// code must never touch the count directly — only `registerCard()` may.
//
// Fixes bug #8 (floor asymmetry on negative counts): the old code used
// `Math.floor(runningCount / decksRemaining)` at four different call
// sites. `Math.floor` rounds negative results AWAY from zero (e.g.
// floor(-1.4) = -2), which understates true count magnitude asymmetrically
// vs positive counts (e.g. floor(1.4) = 1). `Math.trunc` rounds toward
// zero symmetrically (trunc(-1.4) = -1, trunc(1.4) = 1), which is the
// standard, correct true-count convention. Centralized here as the only
// place true count is computed.
// ==========================================

(function (root) {
    'use strict';

    var BJ = (typeof window !== 'undefined')
        ? (window.BJ = window.BJ || {})
        : (root.BJ = root.BJ || {});

    // Hi-Lo tag values.
    function hiLoTag(card) {
        if (card.value >= 2 && card.value <= 6) return 1;
        if (card.value >= 10) return -1; // 10/J/Q/K/A
        return 0; // 7, 8, 9
    }

    const Count = {
        runningCount: 0,

        /**
         * The Hi-Lo tag for a card (+1 / 0 / -1), WITHOUT touching the
         * shared running count. The standalone count drills
         * (count-drills.js) tally their own local count with this — they
         * run on their own shoe, and calling registerCard() there would
         * corrupt the live table session's count, since `runningCount` is
         * a singleton.
         */
        tagOf(card) {
            return card ? hiLoTag(card) : 0;
        },

        // Idempotent: applies the Hi-Lo tag exactly once per card object,
        // ever, regardless of how many times rendering calls this.
        registerCard(card) {
            if (!card || card.counted) return;
            this.runningCount += hiLoTag(card);
            card.counted = true;
        },

        // Standard half-deck rounding for decks remaining, ported unchanged
        // from blackjack.js:499 (already correct in the research pass).
        getDecksRemaining(shoe) {
            const cardsRemaining = shoe ? shoe.cards.length : 0;
            return Math.max(1, Math.round((cardsRemaining / 52) * 2) / 2);
        },

        // Truncate toward zero (NOT Math.floor) — see file header for why.
        getTrueCount(runningCount, decksRemaining) {
            const decks = decksRemaining > 0 ? decksRemaining : 1;
            return Math.trunc(runningCount / decks);
        },

        // Zero the running count — call on every shuffle.
        reset() {
            this.runningCount = 0;
        }
    };

    BJ.Count = Count;

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = Count;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
