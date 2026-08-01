// ==========================================
// render.js — BJ.Renderer: the animation state machine (Phase C, plan §4.2)
//
// PURELY VISUAL. This file never calls BJ.Count.registerCard() or any
// strategy/grading logic — it only consumes already-computed state handed
// to it by BJ.GameManager's callbacks (game-manager.js is the single place
// that mutates count/bankroll/stats). Re-touching old card DOM nodes on
// every hit was the root cause of the Hi-Lo double-count bug (plan §2.1);
// this renderer's rule is: EVERY existing card element, once appended, is
// appended once and never removed/rebuilt except at the start of a fresh
// deal (`_teardownTable()`, called only on the 'dealing' state transition,
// i.e. right before `game-manager.js` deals a brand new set of cards for a
// brand new round — never mid-hand).
//
// DIVISION OF LABOR vs ui-bindings.js (read that file's header too):
//   render.js  -> state classes, card DOM + deal-in/flip/pulse animation,
//                 split hand-column enter animation, message banner fade,
//                 chip-toss visual helpers (exposed as public methods,
//                 actually invoked by ui-bindings.js's chip click handler
//                 since only the click handler knows which chip/denom was
//                 clicked).
//   ui-bindings.js -> element lookups, button wiring, panel show/hide,
//                 plain numeric/text display (bankroll/bet/true count/
//                 stats), disabled-attribute wiring, settings checkboxes,
//                 fullscreen handler, accessibility wiring.
//
// Instantiate with a DOM element map (the same shape BJ.UI exposes — see
// ui-bindings.js), then wire it to a GameManager instance with `attach()`,
// which subscribes every callback this class implements.
//
// Only `transform`/`opacity` are animated by design (iOS Safari
// GPU-compositing requirement, plan §4.2) — this file only ever toggles
// classes / sets `--deal-index`/`--x`/`--y`/`--rot` custom properties; the
// actual `transition`/`@keyframes` rules using them live in the CSS phase
// that comes after this one. See the bottom of this file for the full
// inventory of classes/attributes/ids this file assumes will be styled.
// ==========================================

(function (root) {
    'use strict';

    var BJ = (typeof window !== 'undefined')
        ? (window.BJ = window.BJ || {})
        : (root.BJ = root.BJ || {});

    var STATE_TOKENS = ['idle', 'betting', 'dealing', 'player-turn', 'insurance', 'dealer-turn', 'resolving', 'count-check'];

    var RANK_NAMES = { A: 'Ace', J: 'Jack', Q: 'Queen', K: 'King' };
    var SUIT_NAMES = { '♠': 'Spades', '♥': 'Hearts', '♣': 'Clubs', '♦': 'Diamonds' };

    function rankName(rank) { return RANK_NAMES[rank] || rank; }
    function suitName(suit) { return SUIT_NAMES[suit] || suit; }

    // Bug #12 fix: accessible name for a rendered card, e.g. "King of Hearts".
    function cardLabel(card) {
        return rankName(card.rank) + ' of ' + suitName(card.suit);
    }

    /**
     * Builds one card element: `.playing-card > .card-inner > (.card-front +
     * .card-back)`. The two-sided structure is what lets CSS rotateY the
     * dealer hole card; `hidden` starts it flipped to the back face.
     *
     * Module-level (and exposed as BJ.buildCardEl) so the standalone count
     * drills can render real cards without duplicating this markup — the
     * Renderer method below just delegates here.
     */
    function buildCardEl(card, hidden) {
        var el = document.createElement('div');
        el.className = 'playing-card ' + (card.color || '') + (hidden ? ' face-down' : '');
        el.setAttribute('role', 'group');
        el.setAttribute('aria-label', hidden ? 'Hidden card' : cardLabel(card));

        var inner = document.createElement('div');
        inner.className = 'card-inner';

        var front = document.createElement('div');
        front.className = 'card-face card-front';
        front.innerHTML =
            '<div class="card-top">' + card.rank + '<br>' + card.suit + '</div>' +
            '<div class="card-middle">' + card.suit + '</div>' +
            '<div class="card-bottom">' + card.rank + '<br>' + card.suit + '</div>';

        var back = document.createElement('div');
        back.className = 'card-face card-back';

        inner.appendChild(front);
        inner.appendChild(back);
        el.appendChild(inner);
        return el;
    }

    // Two rAFs (not one): a single requestAnimationFrame sometimes lands in
    // the SAME frame as the DOM insertion (the browser hasn't committed a
    // style/layout pass yet), which coalesces the "no .dealt" and "has
    // .dealt" states into one and the CSS transition never fires because
    // there was nothing to transition FROM. Waiting a full extra frame
    // guarantees a computed-style flush happened first.
    function nextPaint(fn) {
        if (typeof requestAnimationFrame === 'undefined') { fn(); return; }
        requestAnimationFrame(function () {
            requestAnimationFrame(fn);
        });
    }

    class Renderer {
        /**
         * @param {Object} ui - element lookup map, same shape as BJ.UI
         *   (see ui-bindings.js). Every lookup is used defensively — a
         *   missing element just means that particular visual is skipped,
         *   never a thrown error (the HTML phase hasn't landed yet).
         */
        constructor(ui) {
            this.ui = ui || {};
            this.state = 'idle';
            this.hideTotals = false;
            this.disableBanner = false;

            // Hand (BJ.Hand instance) -> { column, cardsEl, scoreEl, cardEls[] }
            this.handColumns = new Map();
            this.dealerHoleEl = null; // the dealer's hole-card DOM node, for the flip

            this._feedbackTimer = null;
            this._bannerTimer = null;
        }

        /**
         * Convenience wiring: subscribes every callback this class
         * implements to `gameManager`. Equivalent to manually calling
         * `gm.setCallback('onStateChange', renderer.onStateChange.bind(renderer))`
         * for each name below, just without the boilerplate in boot.js.
         */
        attach(gameManager) {
            var self = this;
            var names = [
                'onStateChange', 'onGameModeChange', 'onCardDealt', 'onDealerCardDealt',
                'onHoleCardRevealed', 'onHandsUpdate', 'onRoundResolved', 'onFeedback',
                'onInsuranceResolved', 'onSettingsChange', 'onShuffle', 'onCountChange',
                'onCorrectPlay'
            ];
            names.forEach(function (name) {
                if (typeof self[name] === 'function') {
                    gameManager.setCallback(name, function () {
                        return self[name].apply(self, arguments);
                    });
                }
            });
            return this;
        }

        // ============================================================
        // STATE MACHINE
        // ============================================================

        /**
         * `state` is one of GameManager's states: 'idle'|'betting'|
         * 'dealing'|'player-turn'|'insurance'|'dealer-turn'|'resolving'.
         * Applied as both a class token (`state-<x>`) and a `data-state`
         * attribute on the container, so the CSS phase can key off either.
         */
        onStateChange(state) {
            this.state = state;
            var container = this.ui.blackjackContainer;
            if (container) {
                STATE_TOKENS.forEach(function (s) { container.classList.remove('state-' + s); });
                container.classList.add('state-' + state);
                container.setAttribute('data-state', state);
            }

            // A fresh 'dealing' transition always immediately precedes
            // game-manager.js's `_dealInitialCards()` for a brand new round
            // — tear down the previous round's card DOM right before the
            // new cards land (mirrors the old monolith's `startRound()`,
            // which cleared `dealerCards`/`playerCards` innerHTML at the
            // very top, before dealing). This is the ONLY place old card
            // nodes are ever discarded.
            if (state === 'dealing') {
                this._teardownTable();
            }
        }

        onGameModeChange() {
            // Switching drill/testout modes always lands back in 'betting'
            // right after (see GameManager.setGameMode), but clear
            // immediately too so a stale table never flashes under the
            // new mode's UI.
            this._teardownTable();
        }

        _teardownTable() {
            if (this.ui.dealerCards) this.ui.dealerCards.innerHTML = '';
            if (this.ui.playerCards) this.ui.playerCards.innerHTML = '';
            if (this.ui.chipStack) this.ui.chipStack.innerHTML = '';
            if (this.ui.insuranceStack) this.ui.insuranceStack.innerHTML = '';

            // The per-hand `.hand-score-badge`s die with the innerHTML wipe
            // above (they live inside .hand-column), but #dealer-score and
            // #player-score are STANDALONE siblings outside those containers
            // — nothing else ever resets them, so a stale total stayed on
            // screen across mode switches. Hide + blank them explicitly.
            [this.ui.dealerScore, this.ui.playerScore].forEach(function (el) {
                if (!el) return;
                el.textContent = '';
                el.style.opacity = 0;
            });

            this.handColumns.clear();
            this.dealerHoleEl = null;
            this._hideBanner();
        }

        // ============================================================
        // CARD DOM CONSTRUCTION
        // ============================================================

        /**
         * Builds one card element with a front/back face structure
         * (`.card-inner` > `.card-face.card-front` + `.card-face.card-back`)
         * so a CSS `rotateY(180deg)` transition on `.card-inner` can do the
         * dealer hole-card 3D flip. `hidden` cards start with the
         * `.face-down` class (CSS should rotate `.face-down .card-inner` to
         * show the back face); removing `.face-down` on reveal triggers the
         * flip transition.
         *
         * Accessibility (bug #12): `role="group"` + an `aria-label`
         * announcing rank/suit, e.g. "King of Hearts" — hidden cards get a
         * neutral "Hidden card" label instead of leaking the value to
         * screen readers before the reveal.
         */
        _buildCardEl(card, hidden) {
            return buildCardEl(card, hidden);
        }

        /**
         * Appends `el` to `rowEl` and stages the deal-in transition:
         * `--deal-index` is set BEFORE insertion (so the CSS custom
         * property is available on first paint), the element starts
         * without `.dealt`, then `.dealt` is added a full paint later (see
         * `nextPaint`) so the CSS transition actually has a "before" state
         * to animate away from. `dealIndex` is the 0-based position of
         * this card within its own hand/dealer row (not a global counter)
         * — a simple, deterministic stagger value with no batching state
         * to track across async card-dealt events.
         */
        _dealCardIn(el, rowEl, dealIndex) {
            if (!rowEl) return;
            el.style.setProperty('--deal-index', String(dealIndex));
            rowEl.appendChild(el);
            nextPaint(function () { el.classList.add('dealt'); });
        }

        // ============================================================
        // PLAYER CARDS / HAND COLUMNS
        // ============================================================

        /**
         * Every player hand — even the lone hand in a non-split round —
         * gets its own `.hand-column` wrapper (score badge + card row).
         * This uniform structure means a split never has to rebuild hand
         * #1's existing column; it just adds hand #2's column alongside it,
         * which is also what lets a new hand-column animate in on its own
         * (`.entering` -> `.entered`) without touching any prior DOM.
         */
        _getOrCreateHandColumn(hand) {
            var existing = this.handColumns.get(hand);
            if (existing) return existing;

            var container = this.ui.playerCards;
            var isSplitEntrance = this.handColumns.size > 0; // hand #2+ = a split just happened
            var column = null, cardsEl = null, scoreEl = null;

            if (container) {
                column = document.createElement('div');
                column.className = 'hand-column' + (isSplitEntrance ? ' entering' : '');

                scoreEl = document.createElement('div');
                scoreEl.className = 'hand-score-badge';

                cardsEl = document.createElement('div');
                cardsEl.className = 'hand-cards';

                column.appendChild(scoreEl);
                column.appendChild(cardsEl);
                container.appendChild(column);

                if (isSplitEntrance) {
                    nextPaint(function () {
                        column.classList.remove('entering');
                        column.classList.add('entered');
                    });
                }
            }

            var rec = { column: column, cardsEl: cardsEl, scoreEl: scoreEl, cardEls: [] };
            this.handColumns.set(hand, rec);
            return rec;
        }

        /**
         * `onCardDealt(card, hand, {isPlayer, hidden})` — player cards
         * only, per GameManager's doc comment. `hidden` is always false
         * here in practice (only dealer cards are ever dealt hidden), but
         * the flag is accepted defensively in case that ever changes.
         */
        onCardDealt(card, hand, opts) {
            opts = opts || {};
            var rec = this._getOrCreateHandColumn(hand);
            var el = this._buildCardEl(card, !!opts.hidden);

            // Sideways third card on a double, mirroring the old
            // renderTable()'s `cardEl.classList.add('sideways')` — by the
            // time this fires, game-manager.js has already set
            // `hand.hasDoubled = true` and pushed this card as cards[2].
            if (hand.hasDoubled && hand.cards.length === 3 && hand.cards[2] === card) {
                el.classList.add('sideways');
            }

            var dealIndex = hand.cards.length - 1; // 0-based position within this hand
            rec.cardEls.push(el);
            this._dealCardIn(el, rec.cardsEl, dealIndex);
            this._refreshHandBadge(hand, rec);
        }

        // ============================================================
        // DEALER CARDS
        // ============================================================

        /**
         * `onDealerCardDealt(card, hand)` fires for EVERY dealer card
         * (initial deal's hole card + upcard, and every dealer-turn hit) —
         * unlike the player callback, GameManager does not forward a
         * `hidden` flag here (see game-manager.js's doc comment: the
         * signature is `(card, hand)`, no opts). We infer "is this the
         * hole card" from position: it's always dealt first
         * (`hand.cards.length === 1` at the moment this fires, since
         * `_addCardToHand` pushes before emitting), and every later dealer
         * card is dealt face-up.
         */
        onDealerCardDealt(card, hand) {
            var container = this.ui.dealerCards;
            var isHoleCard = hand.cards.length === 1;
            var el = this._buildCardEl(card, isHoleCard);
            if (isHoleCard) this.dealerHoleEl = el;

            var dealIndex = hand.cards.length - 1;
            this._dealCardIn(el, container, dealIndex);
            this._refreshDealerBadge(hand);
        }

        /**
         * `onHoleCardRevealed(card, hand)` — fires once, distinct from
         * `onDealerCardDealt`, exactly so this 3D flip has its own hook.
         * Removing `.face-down` is what the CSS transition keys off of.
         */
        onHoleCardRevealed(card, hand) {
            if (this.dealerHoleEl) {
                this.dealerHoleEl.classList.remove('face-down');
                this.dealerHoleEl.setAttribute('aria-label', cardLabel(card));
            }
            this._refreshDealerBadge(hand);
        }

        // ============================================================
        // SCORE BADGES
        // ============================================================

        _refreshHandBadge(hand, rec) {
            if (!rec || !rec.scoreEl) return;
            if (this.hideTotals) { rec.scoreEl.style.opacity = 0; return; }
            rec.scoreEl.style.opacity = 1;
            var score = hand.score;
            if (hand.surrendered) {
                rec.scoreEl.textContent = 'SURRENDERED';
            } else if (score.isBust) {
                rec.scoreEl.textContent = 'BUST';
            } else {
                rec.scoreEl.textContent = score.isSoft ? ('Soft ' + score.total) : String(score.total);
            }
            // The per-hand `.hand-score-badge` (rec.scoreEl) is now the ONLY
            // player total shown — the standalone #player-score badge was
            // removed (it double-rendered on top of this one for single
            // hands). This badge already handles splits correctly.
        }

        _refreshDealerBadge(dealerHand) {
            var el = this.ui.dealerScore;
            if (!el || !dealerHand) return;
            if (this.hideTotals) { el.style.opacity = 0; return; }

            var holeHidden = this.dealerHoleEl && this.dealerHoleEl.classList.contains('face-down');
            if (holeHidden) {
                var upCard = dealerHand.cards[1];
                if (!upCard) { el.style.opacity = 0; return; }
                el.textContent = upCard.value === 11 ? '11 (A)' : String(upCard.value);
                el.style.opacity = 1;
                return;
            }

            if (!dealerHand.cards.length) { el.style.opacity = 0; return; }
            var score = dealerHand.score;
            el.textContent = score.isSoft ? ('Soft ' + score.total) : String(score.total);
            el.style.opacity = 1;
        }

        /**
         * `onHandsUpdate(snapshot)` — fires after any state-affecting
         * action (hit that doesn't bust, split, advancing to the next
         * split hand, dealer draws, etc). Used here to: (1) refresh every
         * hand's score badge in case a hit changed its total without a
         * fresh onCardDealt-only refresh being enough (defensive
         * idempotent re-render of TEXT ONLY, never card DOM), and (2)
         * toggle `.active`/`.inactive` on hand columns so the CSS phase
         * can dim the hand that isn't currently being played.
         */
        onHandsUpdate(snapshot) {
            var self = this;
            (snapshot.playerHands || []).forEach(function (hand, idx) {
                var rec = self._getOrCreateHandColumn(hand);
                self._refreshHandBadge(hand, rec);
                if (rec.column) {
                    var isActive = idx === snapshot.activeHandIndex;
                    rec.column.classList.toggle('active', isActive);
                    rec.column.classList.toggle('inactive', !isActive && !hand.resolved);
                }
            });
            this._refreshDealerBadge(snapshot.dealerHand);
        }

        // ============================================================
        // ROUND RESOLUTION — win/loss/push pulse + outcome banner
        // ============================================================

        /**
         * `onRoundResolved(hands, summary)` — `hands` are the live
         * BJ.Hand[] with `.outcome`/`.payout` already set by
         * game-manager.js (bug #7 fix); this only reads them for a visual
         * pulse, never recomputes anything financial.
         */
        onRoundResolved(hands, summary) {
            var self = this;
            (hands || []).forEach(function (hand) {
                var rec = self.handColumns.get(hand);
                if (!rec || !rec.scoreEl) return;
                var cls = (hand.outcome === 'win' || hand.outcome === 'blackjack') ? 'winner'
                    : (hand.outcome === 'push') ? 'push'
                        : 'loser'; // 'loss' or 'surrender'
                self._pulse(rec.scoreEl, cls);
            });

            if (this.ui.dealerScore) {
                if (summary && summary.dealerBust) this._pulse(this.ui.dealerScore, 'loser');
                else if (summary && summary.dealerBlackjack) this._pulse(this.ui.dealerScore, 'winner');
            }

            var text = this._describeOutcome(hands || [], summary || {});
            if (this.disableBanner) {
                this.onFeedback(text, 1800);
            } else {
                this._showBanner(text);
            }
        }

        /**
         * Adds `cls`, and removes it on `animationend` (the CSS phase is
         * expected to define an actual @keyframes pulse for
         * `.winner`/`.loser`/`.push` per plan §4.2's "orchestrate via
         * transitionend/animationend, not setTimeout"). A timeout backstop
         * is also set so a class can never get stuck forever if the CSS
         * phase hasn't landed yet or a keyframe name gets typo'd later —
         * this is a safety net, not the primary sequencing mechanism.
         */
        _pulse(el, cls) {
            el.classList.add(cls);
            var cleared = false;
            var clear = function () {
                if (cleared) return;
                cleared = true;
                el.classList.remove(cls);
                el.removeEventListener('animationend', onEnd);
            };
            var onEnd = function () { clear(); };
            el.addEventListener('animationend', onEnd);
            setTimeout(clear, 1800); // backstop only
        }

        _describeOutcome(hands, summary) {
            if (summary.dealerBlackjack) {
                return summary.insurancePayout > 0 ? 'Dealer Blackjack. Insurance Pays!' : 'Dealer Blackjack.';
            }
            if (hands.length === 1) {
                var h = hands[0];
                if (h.outcome === 'surrender') return 'Surrendered.';
                if (h.outcome === 'blackjack') return 'Blackjack!';
                if (h.outcome === 'win') return 'You Win!';
                if (h.outcome === 'loss') return 'Dealer Wins.';
                return 'Push.';
            }
            // Split hands can have mixed outcomes — summarize net direction.
            var wins = hands.filter(function (h) { return h.outcome === 'win' || h.outcome === 'blackjack'; }).length;
            var losses = hands.filter(function (h) { return h.outcome === 'loss' || h.outcome === 'surrender'; }).length;
            if (wins > losses) return 'You Win!';
            if (losses > wins) return 'Dealer Wins.';
            return 'Push.';
        }

        // ============================================================
        // MESSAGE BANNER — fade via class toggle, not display swap
        // ============================================================

        _showBanner(text) {
            var el = this.ui.gameMessage;
            if (!el) return;
            el.textContent = text;
            el.classList.remove('hidden');
            el.classList.add('visible');
            var self = this;
            if (this._bannerTimer) clearTimeout(this._bannerTimer);
            this._bannerTimer = setTimeout(function () { self._hideBanner(); }, 2200);
        }

        _hideBanner() {
            var el = this.ui.gameMessage;
            if (!el) return;
            el.classList.remove('visible');
            el.classList.add('hidden');
        }

        /**
         * `onFeedback(message, durationMs)` — the small AP-grader toast
         * (`#ap-feedback` in the old markup), NOT the big round-outcome
         * banner. Every GameManager call site that fires this
         * ("PLACE A BET", "Not enough Bankroll!", "Error: Optimal play is
         * X", etc) corresponds 1:1 to the old monolith's `showFeedback()`
         * calls, which only ever targeted the small toast.
         */
        onFeedback(message, durationMs) {
            var el = this.ui.apFeedback;
            if (!el) return;
            el.textContent = message;
            el.classList.add('show');
            if (this._feedbackTimer) clearTimeout(this._feedbackTimer);
            this._feedbackTimer = setTimeout(function () { el.classList.remove('show'); }, durationMs || 2500);
        }

        // ============================================================
        // INSURANCE + BET CHIP TOSS
        // ============================================================

        /**
         * `onInsuranceResolved({bought, cost?})` — tosses (or clears) the
         * insurance chip visual. This is the one chip-toss path driven
         * directly by a GameManager callback (there's no per-click
         * denomination info needed, unlike a regular bet chip).
         */
        onInsuranceResolved(result) {
            var stack = this.ui.insuranceStack;
            if (!stack) return;
            stack.innerHTML = '';
            if (result && result.bought) {
                this.tossChip('$' + result.cost, 'purple', stack);
            }
        }

        /**
         * Public helper for ui-bindings.js's chip-button click handler
         * (which is the only place that actually knows which denomination/
         * color chip was clicked — GameManager.setBet only reports the new
         * total). Anticipates a later CSS phase styling `.thrown-chip`
         * with the `thrownChip` keyframe concept from the old CSS, driven
         * by the `--x`/`--y`/`--rot` custom properties set here.
         */
        tossChip(label, chipClass, targetEl) {
            if (!targetEl) return null;
            var chip = document.createElement('div');
            chip.className = 'chip ' + (chipClass || '') + ' thrown-chip';
            chip.textContent = label;
            var xOffset = Math.floor(Math.random() * 30) - 15;
            var yOffset = Math.floor(Math.random() * 30) - 15;
            var rot = Math.floor(Math.random() * 360);
            chip.style.setProperty('--x', xOffset + 'px');
            chip.style.setProperty('--y', yOffset + 'px');
            chip.style.setProperty('--rot', rot + 'deg');
            targetEl.appendChild(chip);
            return chip;
        }

        clearChips(targetEl) {
            if (targetEl) targetEl.innerHTML = '';
        }

        // ============================================================
        // MISC CALLBACKS
        // ============================================================

        onSettingsChange(settings) {
            settings = settings || {};
            this.hideTotals = !!settings.hideTotals;
            this.disableBanner = !!settings.disableBanner;
        }

        onShuffle() {
            this.onFeedback('Shuffling Shoe...', 1500);
        }

        /**
         * `onCorrectPlay()` — a fast, non-blocking positive cue (green ✓ pop)
         * on a correct graded decision. Reuses a single #correct-cue element,
         * re-triggering the CSS animation by toggling the class across a
         * reflow; a timeout backstop removes it even if the animation never
         * fires (throttled compositor), so it can never get stuck on screen.
         */
        onCorrectPlay() {
            var el = this.ui.correctCue;
            if (!el) return;
            el.classList.remove('show');
            void el.offsetWidth; // force reflow so re-adding restarts the pop
            el.classList.add('show');
            if (this._correctTimer) clearTimeout(this._correctTimer);
            var self = this;
            this._correctTimer = setTimeout(function () {
                if (self.ui.correctCue) self.ui.correctCue.classList.remove('show');
            }, 700);
        }

        /**
         * Grows the discard tray as the shoe depletes. Driven off the RAW
         * card counts, not the half-deck-rounded `decksRemaining` — the
         * whole point of the tray is to be eyeballed and estimated, so it
         * must move smoothly rather than snap in half-deck steps (which
         * would turn it into a readout and defeat the exercise).
         */
        onCountChange(info) {
            var tray = this.ui.discardTray;
            if (!tray || !info || !info.cardsTotal) return;
            var dealt = Math.max(0, info.cardsTotal - info.cardsRemaining);
            var frac = Math.max(0, Math.min(1, dealt / info.cardsTotal));
            tray.style.setProperty('--tray-fill', (frac * 100).toFixed(2) + '%');
        }
    }

    BJ.Renderer = Renderer;
    BJ.buildCardEl = buildCardEl;   // shared with count-drills.js

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = Renderer;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);

// ==========================================
// INVENTORY — every NEW class/attribute this file assumes will be styled
// by the later CSS phase (existing ids reused from the old markup are not
// relisted here; see ui-bindings.js's header for the full existing-id list
// and boot.js's final report for the complete cross-file inventory):
//
//   Container state:
//     [data-state="idle|betting|dealing|player-turn|insurance|dealer-turn|resolving"]
//     .state-idle / .state-betting / .state-dealing / .state-player-turn /
//       .state-insurance / .state-dealer-turn / .state-resolving
//       (all on #blackjack-container)
//
//   Card DOM (new structure — old .playing-card had no face wrapper):
//     .playing-card[role=group][aria-label]
//     .playing-card.face-down          (starts flipped to show the back)
//     .playing-card.dealt              (added a frame after insertion — the
//                                        deal-in transition trigger)
//     .playing-card.sideways           (existing class, doubled 3rd card)
//     .card-inner                      (the element CSS should rotateY on)
//     .card-face / .card-front / .card-back
//     --deal-index                     (custom property, per-card stagger)
//
//   Hand columns (used even for a single non-split hand now):
//     .hand-column / .hand-column.active / .hand-column.inactive
//     .hand-column.entering -> .hand-column.entered  (split enter animation)
//     .hand-score-badge
//     .hand-score-badge.winner / .loser / .push       (transient pulse)
//
//   Message banner (fade via class, not display):
//     #game-message.visible / #game-message.hidden
//
//   Chip toss (reuses existing --x/--y/--rot + .thrown-chip concept):
//     .thrown-chip (existing), --x / --y / --rot (existing custom props)
// ==========================================
