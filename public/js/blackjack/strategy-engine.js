// ==========================================
// strategy-engine.js — pure, DOM-free lookup for the optimal play.
//
// Fixes bug #2 (deviation key collision): the old code built a bare
// `"${pTotal}_${dCard}"` key (blackjack.js:1051) which collided pair total
// 16 (8,8) with hard-total 16, and any soft total with a same-numbered
// hard total. This engine resolves in strict order — pair, then soft
// (2-card only), then hard — and every deviation lookup uses the
// hand-type-qualified keys from strategy-data.js (`pair_`, `soft_`,
// `hard_`, `surrender_`), so a pair of 8s can never accidentally match a
// hard-16 deviation.
//
// Also fixes the multi-card-soft fragility (research finding #10): the
// `soft` table in strategy-data.js is only valid for genuine 2-card soft
// hands (A + one other card). A 3+ card soft hand (e.g. A,3,4 = soft 18
// after a hit) no longer has a clean "is this really an A,x starting
// hand" mapping — trying to double a 3-card hand makes no sense anyway —
// so this engine falls through to the HARD-total table (using the same
// current total) for any soft hand with more than 2 cards, exactly the
// real-strategy convention (once you've hit past the two-card deal, you
// play remaining soft totals by their hard-strategy equivalents since
// doubling/surrender are usually already off the table).
//
// No `document`/`window` UI access anywhere in this file — safe to
// `require()` from plain Node for the Phase C verification scripts.
//
// Phase E verification fix: the base-strategy `surrender` table in
// strategy-data.js is transcribed for HARD totals only (its own header
// comment says so), but the original surrender branch here keyed off raw
// `total` without checking `isSoft` — so a soft hand sharing a numeric
// total with a hard-surrender cell (e.g. soft 16 = A,5 vs dealer 10, same
// total as hard 16 vs 10) incorrectly returned 'R'. This is the same
// collision class as bug #2, just against the surrender table instead of
// the deviations table. Fixed by adding `!isSoft` to the surrender gate
// in both `getOptimalPlay` and `getSurrenderRecommendation` — caught by
// scripts/verify-strategy-chart.js's soft-16-vs-10 collision test.
// ==========================================

(function (root) {
    'use strict';

    var BJ = (typeof window !== 'undefined')
        ? (window.BJ = window.BJ || {})
        : (root.BJ = root.BJ || {});

    var StrategyData = BJ.StrategyData || (typeof module !== 'undefined' ? require('./strategy-data.js') : undefined);

    // Dealer card VALUE (2-10, 11 for Ace) -> 0-9 array index used by the
    // hard/soft/pair tables: [2,3,4,5,6,7,8,9,10,A].
    function dealerIndex(dealerValue) {
        return dealerValue === 11 ? 9 : dealerValue - 2;
    }

    // Looks up a hand-type-qualified deviation entry, e.g. "hard_16_10".
    // Returns the resolved play string ('H'/'S'/'D'/'P'/'R') if a deviation
    // entry exists for this exact cell, else null (meaning: use the base
    // table instead).
    function resolveDeviation(prefix, total, dealerValue, trueCount) {
        const key = `${prefix}_${total}_${dealerValue}`;
        const entry = StrategyData.deviations[key];
        if (!entry) return null;
        return trueCount >= entry.tc ? entry.dev : entry.base;
    }

    // Converts a raw table play into what's actually legal right now
    // (mirrors blackjack.js:1074-1076's downgrade logic, generalized).
    function resolveAvailability(play, { isSoft, total, canDouble, canSplit }) {
        if (play === 'D') {
            if (canDouble) return 'D';
            // Can't double — fall back to the underlying hit/stand choice.
            return (isSoft && total >= 18) ? 'S' : 'H';
        }
        if (play === 'Ds') {
            // Double if allowed, else stand (distinct from plain 'D', which
            // falls back to Hit on totals that need the extra card).
            return canDouble ? 'D' : 'S';
        }
        if (play === 'P' && !canSplit) {
            // Can't actually split (e.g. table cap on hands, no bankroll) —
            // caller is expected to have already excluded the pair branch in
            // that case; this is a defensive fallback only.
            return (isSoft && total >= 18) ? 'S' : 'H';
        }
        return play;
    }

    const StrategyEngine = {
        /**
         * @param {Hand} hand - a BJ.Hand instance (or any object exposing
         *   `.cards`, `.isPair`, `.isSoft`, `.score.total`).
         * @param {number} dealerUpcard - dealer's up card VALUE (2-10, 11=Ace).
         * @param {number} trueCount - current true count.
         * @param {boolean} canDouble - whether doubling is currently legal.
         * @param {boolean} canSplit - whether splitting is currently legal.
         * @param {boolean} canSurrender - whether surrender is currently legal
         *   (first decision, 2 cards, no prior hit/split/double this hand).
         * @returns {string} one of 'H','S','D','P','R'
         */
        getOptimalPlay(hand, dealerUpcard, trueCount, canDouble, canSplit, canSurrender) {
            const score = hand.score;
            const total = score.total;
            const dIdx = dealerIndex(dealerUpcard);
            const isPair = hand.isPair;
            const isSoft = score.isSoft;

            // --- 1. PAIRS (highest priority when actually splittable) ---
            if (isPair && canSplit) {
                const pairVal = hand.cards[0].rank === 'A' ? 11 : hand.cards[0].value;
                const dev = resolveDeviation('pair', pairVal, dealerUpcard, trueCount);
                const play = dev !== null ? dev : StrategyData.pair[pairVal][dIdx];
                return resolveAvailability(play, { isSoft, total, canDouble, canSplit });
            }

            // --- 2. SURRENDER (only ever a first-decision, 2-card, non-pair,
            // HARD-total option — StrategyData.surrender is transcribed for
            // hard totals only; a soft hand with the same numeric total,
            // e.g. soft 16 = A,5, must never surrender off this table, or
            // the hard/soft total collision bug (#2) resurfaces here too) ---
            if (!isPair && !isSoft && hand.cards.length === 2 && canSurrender) {
                const surrDev = resolveDeviation('surrender', total, dealerUpcard, trueCount);
                if (surrDev === 'R') return 'R';
                if (surrDev === null) {
                    const base = StrategyData.surrender[total];
                    if (base && base[dealerUpcard]) return 'R';
                }
                // else: deviation explicitly says don't surrender (base play) —
                // fall through to normal strategy below.
            }

            // --- 3. SOFT TOTALS (2-card hands only; 3+ card soft hands fall
            // through to the hard-total branch below, per the file header) ---
            if (isSoft && hand.cards.length === 2) {
                const dev = resolveDeviation('soft', total, dealerUpcard, trueCount);
                const play = dev !== null ? dev : StrategyData.soft[total][dIdx];
                return resolveAvailability(play, { isSoft, total, canDouble, canSplit });
            }

            // --- 4. HARD TOTALS (also the fallback for 3+ card soft hands
            // and for pairs that can't currently be split) ---
            const lookupTotal = Math.max(5, Math.min(21, total));
            const dev = resolveDeviation('hard', lookupTotal, dealerUpcard, trueCount);
            const play = dev !== null ? dev : StrategyData.hard[lookupTotal][dIdx];
            return resolveAvailability(play, { isSoft: false, total, canDouble, canSplit });
        },

        /**
         * Convenience wrapper for the surrender drill mode: returns true if
         * surrender is the recommended play for this exact hand/dealer/count,
         * without needing to unpack getOptimalPlay's full resolution order.
         * Never returns true for a pair (pairs always resolve via the pair
         * table and never surrender, per plan §3.1).
         */
        getSurrenderRecommendation(hand, dealerUpcard, trueCount) {
            if (hand.isPair || hand.isSoft || hand.cards.length !== 2) return false;
            const total = hand.score.total;
            const dev = resolveDeviation('surrender', total, dealerUpcard, trueCount);
            if (dev === 'R') return true;
            if (dev === null) {
                const base = StrategyData.surrender[total];
                return !!(base && base[dealerUpcard]);
            }
            return false;
        },

        /**
         * Insurance is a special non-hand deviation: take insurance at
         * TC >= +3 (StrategyData.deviations.insurance).
         */
        getInsuranceRecommendation(trueCount) {
            const entry = StrategyData.deviations.insurance;
            return trueCount >= entry.tc;
        }
    };

    BJ.StrategyEngine = StrategyEngine;

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = StrategyEngine;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
