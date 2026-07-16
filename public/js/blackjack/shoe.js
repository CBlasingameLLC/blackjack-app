// ==========================================
// shoe.js — the card shoe: build, shuffle, cut card, draw
// Ported faithfully from blackjack.js:65-111 (Fisher-Yates + cut-card math
// were already verified correct in the research pass — logic unchanged,
// just relocated and namespaced per BJ.Shoe).
// ==========================================

(function (root) {
    'use strict';

    var BJ = (typeof window !== 'undefined')
        ? (window.BJ = window.BJ || {})
        : (root.BJ = root.BJ || {});

    var Rules = BJ.Rules || (typeof module !== 'undefined' ? require('./rules.js') : undefined);

    var SUITS = ['♠', '♥', '♣', '♦'];
    var RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

    class Shoe {
        constructor(decks) {
            this.decks = decks || Rules.decks;
            this.cards = [];
            this.cutCardIndex = 0;
            this.needsShuffle = false;
            this.buildAndShuffle();
        }

        buildAndShuffle() {
            this.cards = [];

            // Generate `decks * 52` cards (312 for the locked 6-deck ruleset).
            for (let i = 0; i < this.decks; i++) {
                for (let suit of SUITS) {
                    for (let rank of RANKS) {
                        // Face cards = 10, Aces = 11 (soft-total handling in
                        // Hand.score reduces to 1 as needed).
                        let value = parseInt(rank, 10) || (rank === 'A' ? 11 : 10);
                        let color = (suit === '♥' || suit === '♦') ? 'red' : 'black';
                        // `counted` backs count.js's idempotent Hi-Lo registration
                        // (fix for the double-count-on-re-render bug) — every
                        // fresh card starts unregistered.
                        this.cards.push({ suit, rank, value, color, counted: false });
                    }
                }
            }

            // Fisher-Yates: mathematically unbiased shuffle.
            for (let i = this.cards.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [this.cards[i], this.cards[j]] = [this.cards[j], this.cards[i]];
            }

            // Plastic cut card placed `penetration` of the way into the shoe;
            // `draw()` pops from the end of the array, so the cut card is
            // reached when `cards.length` falls to this index.
            this.cutCardIndex = Math.floor(this.cards.length * (1 - Rules.penetration));
            this.needsShuffle = false;

            if (typeof console !== 'undefined') {
                console.log(`Shoe active. ${this.cards.length} cards shuffled.`);
            }
        }

        draw() {
            // Signal that a shuffle is needed after the current round once we
            // reach the cut card — never mid-round.
            if (this.cards.length <= this.cutCardIndex) {
                this.needsShuffle = true;
            }
            return this.cards.pop();
        }
    }

    BJ.Shoe = Shoe;

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = Shoe;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
