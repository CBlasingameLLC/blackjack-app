// ==========================================
// strategy-data.js — THE SINGLE SOURCE OF TRUTH for basic strategy +
// Illustrious 18 index plays.
//
// RULESET THIS TABLE IS DERIVED FOR: 6 decks, S17 (dealer STANDS on soft
// 17), DAS allowed, late surrender allowed, no re-split aces, blackjack
// pays 3:2. If the locked ruleset in rules.js ever changes (deck count,
// H17 vs S17, DAS availability, etc.) EVERY table below must be re-derived
// — these numbers are not generically "basic strategy," they are the exact
// numbers for this ruleset. Do not copy cells from an H17 chart (the old
// blackjack.js `Strategy` object had `Rules.h17 = true` and several cells,
// e.g. soft 19 vs 6 and 11 vs A, are DIFFERENT under S17).
//
// DEALER UPCARD INDEXING (hard/soft/pair tables): each array has 10
// entries corresponding to dealer upcards, in order:
//   [2, 3, 4, 5, 6, 7, 8, 9, 10, A]
// i.e. array[0] = vs dealer 2 ... array[8] = vs dealer 10, array[9] = vs
// dealer Ace. strategy-engine.js converts a dealer card value (2-10, Ace
// counted as 11) to this 0-9 index.
//
// PLAY CODES: H = Hit, S = Stand, D = Double (else Hit if double isn't
// available), Ds = Double if allowed, else Stand, P = Split, R = Surrender
// (else fall through to the non-surrender play).
//
// DEVIATION KEY NAMING (fixes bug #2 — collision between pair total 16
// (8,8) and hard total 16, and between soft totals and hard totals sharing
// a raw number): every deviation key is prefixed with the hand TYPE it
// applies to: `hard_<total>_<dealerValue>`, `soft_<total>_<dealerValue>`,
// `pair_<pairValue>_<dealerValue>`, `surrender_<total>_<dealerValue>`, or
// the special non-hand key `"insurance"`. `<dealerValue>` is the raw card
// value (2-10, 11 for Ace) — NOT the 0-9 array index used above.
// ==========================================

(function (root) {
    'use strict';

    var BJ = (typeof window !== 'undefined')
        ? (window.BJ = window.BJ || {})
        : (root.BJ = root.BJ || {});

    const StrategyData = {

        // --- HARD TOTALS (5-21) vs dealer [2,3,4,5,6,7,8,9,10,A] ---
        // Standard 6-deck/S17/DAS basic strategy chart.
        hard: {
            5:  ['H','H','H','H','H','H','H','H','H','H'],
            6:  ['H','H','H','H','H','H','H','H','H','H'],
            7:  ['H','H','H','H','H','H','H','H','H','H'],
            8:  ['H','H','H','H','H','H','H','H','H','H'],
            // 9: double vs 3-6 only under S17 (some H17 charts extend to double vs 2 — not here).
            9:  ['H','D','D','D','D','H','H','H','H','H'],
            10: ['D','D','D','D','D','D','D','D','H','H'],
            // 11 vs A is HIT under S17 basic strategy (this is the well-known S17
            // vs H17 divergence flagged in the plan — H17 charts double here).
            // Doubling 11 vs A only becomes correct as an Illustrious-18 index
            // play at TC >= +1 (see deviations.hard_11_11 below).
            11: ['D','D','D','D','D','D','D','D','D','H'],
            12: ['H','H','S','S','S','H','H','H','H','H'],
            13: ['S','S','S','S','S','H','H','H','H','H'],
            14: ['S','S','S','S','S','H','H','H','H','H'],
            15: ['S','S','S','S','S','H','H','H','H','H'], // surrender vs 10, see `surrender` table
            16: ['S','S','S','S','S','H','H','H','H','H'], // surrender vs 9/10/A, see `surrender` table
            17: ['S','S','S','S','S','S','S','S','S','S'],
            18: ['S','S','S','S','S','S','S','S','S','S'],
            19: ['S','S','S','S','S','S','S','S','S','S'],
            20: ['S','S','S','S','S','S','S','S','S','S'],
            21: ['S','S','S','S','S','S','S','S','S','S']
        },

        // --- SOFT TOTALS (A,2 through A,9 = totals 13-20), 2-card hands only ---
        // strategy-engine.js falls through to the hard-total table for any
        // soft hand with 3+ cards (see engine comment) rather than misapplying
        // this 2-card-only chart.
        soft: {
            13: ['H','H','H','D','D','H','H','H','H','H'], // A,2 — double vs 5,6
            14: ['H','H','H','D','D','H','H','H','H','H'], // A,3 — double vs 5,6
            15: ['H','H','D','D','D','H','H','H','H','H'], // A,4 — double vs 4,5,6
            16: ['H','H','D','D','D','H','H','H','H','H'], // A,5 — double vs 4,5,6
            17: ['H','D','D','D','D','H','H','H','H','H'], // A,6 — double vs 3,4,5,6
            18: ['S','D','D','D','D','S','S','H','H','H'], // A,7 — double vs 3-6, stand vs 2/7/8, hit vs 9/10/A
            // A,8 under S17: stand ALWAYS — no double vs 6 (that cell is an
            // H17-only line; the old blackjack.js table had 'D' at index 4
            // here, which was correct for H17 but wrong for this ruleset).
            19: ['S','S','S','S','S','S','S','S','S','S'], // A,8
            20: ['S','S','S','S','S','S','S','S','S','S']  // A,9
        },

        // --- PAIRS, keyed by pair value (2-10, 11 = A,A) vs dealer [2..A] ---
        // DAS is always allowed under the locked ruleset, so splits below
        // assume the option to double after splitting is available.
        pair: {
            2:  ['P','P','P','P','P','P','H','H','H','H'], // 2,2 — split vs 2-7
            3:  ['P','P','P','P','P','P','H','H','H','H'], // 3,3 — split vs 2-7
            4:  ['H','H','H','P','P','H','H','H','H','H'], // 4,4 — split vs 5,6 only (DAS)
            5:  ['D','D','D','D','D','D','D','D','H','H'], // 5,5 — NEVER split, play as hard 10
            6:  ['P','P','P','P','P','H','H','H','H','H'], // 6,6 — split vs 2-6 (DAS)
            7:  ['P','P','P','P','P','P','H','H','H','H'], // 7,7 — split vs 2-7
            8:  ['P','P','P','P','P','P','P','P','P','P'], // 8,8 — ALWAYS split, never surrender
            9:  ['P','P','P','P','P','S','P','P','S','S'], // 9,9 — split vs 2-6,8,9; stand vs 7,10,A
            10: ['S','S','S','S','S','S','S','S','S','S'], // 10,10 — NEVER split
            11: ['P','P','P','P','P','P','P','P','P','P']  // A,A — ALWAYS split (no re-split of aces, see Rules.resplitAces)
        },

        // --- LATE SURRENDER, hard totals only. Pair 8,8 is NEVER surrendered
        // (it always splits per the pair table above, regardless of count) ---
        surrender: {
            15: { 10: true },                 // 15 vs 10
            16: { 9: true, 10: true, 11: true } // 16 vs 9, 10, or Ace
        },

        // --- ILLUSTRIOUS 18 (+ the "Fab 4" surrender indices), for 6-deck S17 ---
        // Each entry: { tc, dev, base }
        //   tc   = true-count threshold
        //   dev  = play to make when trueCount >= tc
        //   base = play to make when trueCount < tc (i.e. the ruleset's basic-
        //          strategy play for that cell, restated explicitly here so the
        //          engine never has to infer "the other side" of the index)
        //
        // Values below are the commonly-cited Illustrious 18 thresholds
        // (Blackjack Apprenticeship / Wizard of Odds / QFIT lists largely
        // agree on these) — VERIFY AGAINST WIZARD OF ODDS / BLACKJACK
        // APPRENTICESHIP I18 TABLE before treating as gospel, especially the
        // five "low count" reversals (13 vs 2/3, 12 vs 4/5/6) where the
        // listed `dev` play equals the hand's normal basic-strategy play and
        // the real index action is deviating to Hit *below* the threshold —
        // flagged explicitly for the verification phase.
        deviations: {
            // -- insurance is not hand-based; handled as a special case --
            insurance: { tc: 3, dev: 'buy', base: 'decline' },

            // -- standard "high count" deviations (basic play -> better play as count rises) --
            hard_16_10: { tc: 0, dev: 'S', base: 'H' },
            hard_15_10: { tc: 4, dev: 'S', base: 'H' },
            hard_10_10: { tc: 4, dev: 'D', base: 'H' },
            hard_12_3:  { tc: 2, dev: 'S', base: 'H' },
            hard_12_2:  { tc: 3, dev: 'S', base: 'H' },
            hard_11_11: { tc: 1, dev: 'D', base: 'H' }, // 11 vs A
            hard_9_2:   { tc: 1, dev: 'D', base: 'H' },
            hard_10_11: { tc: 4, dev: 'D', base: 'H' }, // 10 vs A
            hard_9_7:   { tc: 3, dev: 'D', base: 'H' },
            hard_16_9:  { tc: 5, dev: 'S', base: 'H' },

            // -- "low count" reversal deviations: basic play is already Stand;
            // VERIFY: the commonly cited semantics is "Stand when TC >= tc
            // (matches basic), deviate to Hit when TC < tc" — flagged for
            // spot-check against Wizard of Odds / Blackjack Apprenticeship. --
            hard_13_2: { tc: -1, dev: 'S', base: 'H' },
            hard_13_3: { tc: -2, dev: 'S', base: 'H' },
            hard_12_4: { tc: 0,  dev: 'S', base: 'H' },
            hard_12_5: { tc: -2, dev: 'S', base: 'H' },
            hard_12_6: { tc: -1, dev: 'S', base: 'H' },

            // -- Fab 4 surrender indices (basic play is Hit; deviate to Surrender) --
            surrender_14_10: { tc: 3, dev: 'R', base: 'H' },
            surrender_15_9:  { tc: 2, dev: 'R', base: 'H' },
            surrender_15_11: { tc: 1, dev: 'R', base: 'H' } // 15 vs A
            // Note: 15 vs 10 surrender is already BASIC strategy (see
            // `surrender` table above), not an index play — intentionally
            // not duplicated here.
        }
    };

    BJ.StrategyData = StrategyData;

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = StrategyData;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
