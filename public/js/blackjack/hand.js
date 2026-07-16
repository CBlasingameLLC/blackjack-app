// ==========================================
// hand.js — the hand evaluator
// Ported from blackjack.js:113-144, plus:
//   - a new `surrendered` flag (plan §3.1 late surrender)
//   - an `isPair` getter (previously duplicated inline at multiple call
//     sites: blackjack.js:762, 828, 1045 — centralized here so
//     strategy-engine.js and game-manager.js share one definition)
//   - an `isSoft` convenience getter mirroring `score.isSoft`
// ==========================================

(function (root) {
    'use strict';

    var BJ = (typeof window !== 'undefined')
        ? (window.BJ = window.BJ || {})
        : (root.BJ = root.BJ || {});

    class Hand {
        constructor(betAmount = 0) {
            this.cards = [];
            this.bet = betAmount;       // tracks per-hand bet for splits/doubles
            this.resolved = false;      // true once this hand is done playing
            this.hasDoubled = false;    // flags sideways-card rendering for a double
            this.surrendered = false;   // NEW: true once the player has surrendered
            this.outcome = null;        // 'win' | 'loss' | 'push' | 'blackjack' | 'surrender' | null
            this.payout = 0;            // net bankroll delta once resolved (fix #7: per-hand payout)
        }

        add(card) {
            this.cards.push(card);
        }

        get score() {
            let total = 0;
            let aces = 0;
            for (let card of this.cards) {
                total += card.value;
                if (card.rank === 'A') aces++;
            }
            while (total > 21 && aces > 0) {
                total -= 10;
                aces--;
            }
            return {
                total: total,
                isSoft: aces > 0,
                isBlackjack: total === 21 && this.cards.length === 2,
                isBust: total > 21
            };
        }

        // Two-card hand of identical rank VALUE (mirrors the original
        // inline checks — e.g. 10/J/Q/K all compare equal for split
        // eligibility, matching the existing game's house rule as-is; not a
        // behavior change from the monolith, just centralized).
        get isPair() {
            return this.cards.length === 2 && this.cards[0].value === this.cards[1].value;
        }

        get isSoft() {
            return this.score.isSoft;
        }
    }

    BJ.Hand = Hand;

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = Hand;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
