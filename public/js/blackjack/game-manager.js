// ==========================================
// game-manager.js — round lifecycle / state machine / betting (Phase B)
//
// Ports the old monolith's `GameManager` (blackjack.js:271-1104), stripped
// of every direct DOM read/write. This file is intentionally DOM-free: it
// never touches `document`/`UI.*`. A later render/ui-bindings phase drives
// the DOM by subscribing to the callbacks documented below and by calling
// the public methods in response to user input.
//
// CALLBACK-DRIVEN, NOT EVENT-EMITTER: callbacks are plain function slots on
// `this.callbacks`, set via the constructor or `setCallback(s)`. Every slot
// is optional (missing callback = no-op). See the big comment block above
// the constructor for the full list and payload shapes.
//
// BUG FIXES PORTED FROM THE PLAN (§2):
//   #1 Hi-Lo double-count-on-re-render — this file is the ONLY place that
//      calls `BJ.Count.registerCard()`, and only ever once per physical
//      card, at the moment it's dealt/flipped (`_addCardToHand`,
//      `_flipHoleCard`). There is no rendering path here to double-fire it.
//   #2 Deviation key collisions — delegated entirely to
//      `BJ.StrategyEngine.getOptimalPlay`, which already resolves in
//      pair -> surrender -> soft -> hard order using type-qualified keys.
//      This file never builds a raw `"${total}_${dealerCard}"` key itself.
//   #3 DAS dead flag — doubling is gated only on `hand.cards.length === 2`
//      (see `playerDouble`/`_evaluatePlay`'s `canDouble`), matching the
//      locked "DAS always on" ruleset; no `Rules.das` check anywhere.
//   #4 No surrender — `playerSurrender()` below.
//   #5 Deck/penetration reconfiguration — there is no method here that
//      mutates deck count or penetration; `_reshuffle()`/`newShoe()` always
//      rebuild from the frozen `BJ.Rules` values.
//   #6 Bankroll-only persistence — bankroll, settings, session/lifetime
//      stats, mistake log, and hand history are all read at construction
//      and written through `BJ.Storage` at every relevant mutation point.
//   #7 Two divergent payout paths — every `Hand` gets `.outcome`/`.payout`
//      set once, per hand, in `_resolveRound`/`_resolveImmediateBlackjack`;
//      the bankroll delta is `hands.reduce((s,h) => s + h.payout, 0)`. No
//      string sentinel ("blackjack") branch exists anywhere in this file.
//   #8 True-count floor asymmetry — never recomputed here; every read goes
//      through `BJ.Count.getTrueCount()` (which uses `Math.trunc`).
//  #10 Duplicate fullscreen listeners — not applicable to this file (DOM
//      concern, lives in ui-bindings.js in a later phase).
//
// NEW FEATURES (plan §3):
//   §3.1 Late surrender — `playerSurrender()`, gated by `_canSurrender()`.
//   §3.2 Persistence — constructor loads bankroll/settings/stats/mistake
//        log via `BJ.Storage`; every graded decision and round resolution
//        writes back through it.
//   §3.3 Drill modes — `_dealInitialCards()` fabricates `pairs`/`soft`/
//        `deviations`/`testout` (ported) plus new `hard`/`surrender` modes.
//
// Safe to `require()` from plain Node (Phase C verification scripts) — no
// `window`/`document` access anywhere in this file.
// ==========================================

(function (root) {
    'use strict';

    var BJ = (typeof window !== 'undefined')
        ? (window.BJ = window.BJ || {})
        : (root.BJ = root.BJ || {});

    var Rules = BJ.Rules || (typeof module !== 'undefined' ? require('./rules.js') : undefined);
    var Shoe = BJ.Shoe || (typeof module !== 'undefined' ? require('./shoe.js') : undefined);
    var Hand = BJ.Hand || (typeof module !== 'undefined' ? require('./hand.js') : undefined);
    var StrategyData = BJ.StrategyData || (typeof module !== 'undefined' ? require('./strategy-data.js') : undefined);
    var Count = BJ.Count || (typeof module !== 'undefined' ? require('./count.js') : undefined);
    var StrategyEngine = BJ.StrategyEngine || (typeof module !== 'undefined' ? require('./strategy-engine.js') : undefined);
    var Storage = BJ.Storage || (typeof module !== 'undefined' ? require('./persistence.js') : undefined);

    var SUITS = ['♠', '♥', '♣', '♦'];

    // Action code -> human label, used in feedback toasts and mistake-log
    // entries. 'N' is a virtual code (not a real player action) meaning
    // "Play On" — only produced/consumed by the `surrender` drill mode's
    // grading, which reduces every decision to a binary Surrender-or-not
    // question (see `_evaluatePlay`'s `gameMode === 'surrender'` branch).
    var ACTION_LABELS = {
        H: 'Hit', S: 'Stand', D: 'Double', P: 'Split', R: 'Surrender', N: 'Play On',
        Buy: 'Buy Insurance', Pass: 'Pass Insurance'
    };

    // Illustrious-18 hard-total scenarios used by the `deviations` drill —
    // every non-insurance, non-surrender key in StrategyData.deviations is
    // currently a `hard_<total>_<dealerValue>` entry, so this drill only
    // ever needs to fabricate 2-card non-pair, non-soft hard totals.
    function hardDeviationKeys() {
        return Object.keys(StrategyData.deviations).filter(function (k) {
            return k.indexOf('hard_') === 0;
        });
    }

    // `surrender` drill scenarios (plan §3.3 / item 8): half real surrender
    // situations, half look-alike hands that are NOT surrender situations,
    // so the player has to genuinely discriminate rather than pattern-match
    // "stiff hand = surrender". The look-alike list is exactly the trio
    // named in the plan (16v7, 15v9, 17v10); real scenarios are the full
    // basic-strategy surrender chart (15v10, 16v9/10/A).
    var SURRENDER_TRUE_SCENARIOS = [
        { total: 15, dealer: 10 },
        { total: 16, dealer: 9 },
        { total: 16, dealer: 10 },
        { total: 16, dealer: 11 }
    ];
    var SURRENDER_LOOKALIKE_SCENARIOS = [
        { total: 16, dealer: 7 },
        { total: 15, dealer: 9 },
        { total: 17, dealer: 10 }
    ];

    class GameManager {
        /**
         * @param {Object} [callbacks] - see the full list below. Every key
         *   is optional; missing callbacks are simply not invoked. Can also
         *   be supplied/replaced later via `setCallback`/`setCallbacks`.
         *
         * --- CALLBACK REFERENCE (all optional) ---
         *   onStateChange(state)                 - 'idle'|'betting'|'dealing'|
         *                                           'player-turn'|'insurance'|
         *                                           'dealer-turn'|'resolving'
         *   onGameModeChange(mode)
         *   onBankrollChange(bankroll)
         *   onBetChange(currentBet)
         *   onCountChange({runningCount, trueCount, decksRemaining})
         *   onCardDealt(card, hand, {isPlayer, hidden})   - player cards only
         *   onDealerCardDealt(card, hand)                 - every dealer card,
         *                                                    initial deal AND
         *                                                    dealer-turn draws
         *   onHoleCardRevealed(card, hand)                - hole-card flip,
         *                                                    fires once, distinct
         *                                                    from onDealerCardDealt
         *                                                    so render.js can key
         *                                                    a 3D flip off it
         *   onHandsUpdate(snapshot)               - fires after any state-affecting
         *                                            action; snapshot shape below
         *   onRoundResolved(hands, summary)        - hands = live BJ.Hand[] (each
         *                                            has .outcome/.payout set);
         *                                            summary is a plain-object recap
         *   onFeedback(message, durationMs)        - AP-grader errors, "place a
         *                                            bet", "not enough bankroll", etc.
         *   onInsuranceOffered()
         *   onInsuranceResolved({bought, cost?})
         *   onStatsUpdate({session, lifetime, sessionAccuracy, mode})
         *   onMistakeLogged(entry)
         *   onSettingsChange(settings)
         *   onShuffle()
         *
         * Snapshot shape (`onHandsUpdate` / `getSnapshot()`):
         *   { playerHands, activeHandIndex, dealerHand, bankroll,
         *     currentBet, insuranceBet, state, gameMode }
         */
        constructor(callbacks) {
            this.callbacks = Object.assign({
                onStateChange: null, onGameModeChange: null, onBankrollChange: null,
                onBetChange: null, onCountChange: null, onCardDealt: null,
                onDealerCardDealt: null, onHoleCardRevealed: null, onHandsUpdate: null,
                onRoundResolved: null, onFeedback: null, onInsuranceOffered: null,
                onInsuranceResolved: null, onStatsUpdate: null, onMistakeLogged: null,
                onSettingsChange: null, onShuffle: null
            }, callbacks || {});

            Storage.migrate();

            this.shoe = new Shoe(Rules.decks);
            this.dealerHand = new Hand();
            this.playerHands = [];
            this.activeHandIndex = 0;

            this.bankroll = Storage.getBankroll();
            this.settings = Storage.getSettings();

            // Session stats are scoped to this GameManager instance (a fresh
            // page load = a fresh session) — start from a clean bucket every
            // construction, distinct from `stats_lifetime` which accumulates
            // forever. Immediately persisted so a mid-session reload doesn't
            // silently resurrect a stale session bucket.
            this.sessionStats = this._freshStatsBucket();
            Storage.setSessionStats(this.sessionStats);
            this.lifetimeStats = Storage.getLifetimeStats();

            this.gameMode = 'testout';
            this.currentBet = 0;
            this.insuranceBet = 0;
            this.state = 'idle';
        }

        // --- callback wiring -------------------------------------------------

        setCallback(name, fn) {
            this.callbacks[name] = fn;
        }

        setCallbacks(map) {
            Object.assign(this.callbacks, map || {});
        }

        _emit(name) {
            const fn = this.callbacks[name];
            if (typeof fn !== 'function') return;
            const args = Array.prototype.slice.call(arguments, 1);
            try {
                fn.apply(null, args);
            } catch (err) {
                if (typeof console !== 'undefined') console.error('BJ.GameManager callback "' + name + '" threw:', err);
            }
        }

        // --- public read accessors -------------------------------------------

        getState() { return this.state; }
        getBankroll() { return this.bankroll; }
        getSettings() { return this.settings; }
        getSnapshot() { return this._snapshot(); }

        _snapshot() {
            return {
                playerHands: this.playerHands,
                activeHandIndex: this.activeHandIndex,
                dealerHand: this.dealerHand,
                bankroll: this.bankroll,
                currentBet: this.currentBet,
                insuranceBet: this.insuranceBet,
                state: this.state,
                gameMode: this.gameMode
            };
        }

        _countSnapshot() {
            const decksRemaining = Count.getDecksRemaining(this.shoe);
            const trueCount = Count.getTrueCount(Count.runningCount, decksRemaining);
            return { runningCount: Count.runningCount, trueCount, decksRemaining };
        }

        // --- settings / mode / betting ----------------------------------------

        updateSettings(partial) {
            this.settings = Object.assign({}, this.settings, partial || {});
            Storage.setSettings(this.settings);
            this._emit('onSettingsChange', this.settings);
        }

        setGameMode(mode) {
            this.gameMode = mode;
            this.currentBet = 0;
            this.insuranceBet = 0;
            this.state = 'betting';
            this._emit('onGameModeChange', mode);
            this._emit('onBetChange', this.currentBet);
            this._emit('onStateChange', this.state);
        }

        /**
         * Adds `amount` to the current bet (testout mode only — drills never
         * bet). Deducts from bankroll immediately, mirroring the old "chip
         * throw" behavior, unless freeplay is on. Pass `{replace: true}` to
         * set the bet to an absolute value instead (bypasses the bankroll
         * deduction — useful for scripted/automated play).
         */
        setBet(amount, options) {
            options = options || {};
            if (this.gameMode !== 'testout') return this.currentBet;

            if (options.replace) {
                this.currentBet = Math.max(0, amount);
                this._emit('onBetChange', this.currentBet);
                return this.currentBet;
            }

            if (!this.settings.freeplay && this.bankroll < amount) {
                this._emit('onFeedback', 'Not enough Bankroll!', 1500);
                return this.currentBet;
            }
            if (!this.settings.freeplay) {
                this.bankroll -= amount;
                this._persistBankroll();
            }
            this.currentBet += amount;
            this._emit('onBetChange', this.currentBet);
            return this.currentBet;
        }

        /** Pulls the current bet back to the bankroll (pre-deal only). */
        clearBet() {
            if (this.currentBet > 0 && this.state === 'betting') {
                if (!this.settings.freeplay) {
                    this.bankroll += this.currentBet;
                    this._persistBankroll();
                }
                this.currentBet = 0;
                this._emit('onBetChange', 0);
            }
            return this.currentBet;
        }

        // --- shoe / count -------------------------------------------------------

        /** Manual "New Shoe" action — always rebuilds from frozen BJ.Rules. */
        newShoe() {
            this.shoe = new Shoe(Rules.decks);
            Count.reset();
            this._emit('onShuffle');
            this._emit('onCountChange', this._countSnapshot());
        }

        _reshuffle() {
            this.shoe.buildAndShuffle();
            Count.reset();
            this._emit('onShuffle');
            this._emit('onCountChange', this._countSnapshot());
        }

        _drawFromShoe() {
            return this.shoe.draw();
        }

        // --- card fabrication helpers --------------------------------------------

        _randomInt(min, max) {
            return Math.floor(Math.random() * (max - min + 1)) + min;
        }

        _card(value, suitIdx) {
            const suit = SUITS[suitIdx != null ? suitIdx : this._randomInt(0, 3)];
            const rank = value === 11 ? 'A' : String(value);
            const color = (suit === '♥' || suit === '♦') ? 'red' : 'black';
            return { suit, rank, value, color, counted: false };
        }

        _fabricatePair() {
            const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'A'];
            const rank = ranks[this._randomInt(0, ranks.length - 1)];
            const value = rank === 'A' ? 11 : parseInt(rank, 10);
            return [this._card(value, 0), this._card(value, 1)];
        }

        _fabricateSoft() {
            const ranks = ['2', '3', '4', '5', '6', '7', '8', '9'];
            const rank = ranks[this._randomInt(0, ranks.length - 1)];
            const value = parseInt(rank, 10);
            return [this._card(11, 0), this._card(value, 1)];
        }

        /**
         * Two non-pair, non-ace-involved cards (values 2-10 each) summing to
         * `target`. Judgment call: the plan asks for hard totals "in range
         * 5-20", but 20 is only reachable via 10+10, which is a pair by
         * definition — so a requested 20 (or any target with no valid
         * non-pair decomposition) resamples down into 5-19 instead of ever
         * returning a pair.
         */
        _fabricateHardTotal(target) {
            let t = target;
            for (let attempt = 0; attempt < 3; attempt++) {
                const candidates = [];
                for (let v1 = 2; v1 <= 10; v1++) {
                    const v2 = t - v1;
                    if (v2 >= 2 && v2 <= 10 && v2 !== v1) candidates.push([v1, v2]);
                }
                if (candidates.length) {
                    const pick = candidates[this._randomInt(0, candidates.length - 1)];
                    return [this._card(pick[0], 0), this._card(pick[1], 1)];
                }
                t = this._randomInt(5, 19);
            }
            return [this._card(7, 0), this._card(5, 1)]; // defensive fallback, should be unreachable
        }

        _fabricateDealerUpcard(fixedValue) {
            const value = fixedValue != null ? fixedValue : this._randomInt(2, 11);
            return this._card(value, 2);
        }

        // --- dealing --------------------------------------------------------------

        _addCardToHand(hand, card, opts) {
            opts = opts || {};
            hand.add(card);
            if (!opts.hidden) {
                Count.registerCard(card); // idempotent — no-op if card.counted already true
                this._emit('onCountChange', this._countSnapshot());
            }
            if (opts.isPlayer) {
                this._emit('onCardDealt', card, hand, { isPlayer: true, hidden: !!opts.hidden });
            } else {
                this._emit('onDealerCardDealt', card, hand);
            }
        }

        _flipHoleCard() {
            const hole = this.dealerHand.cards[0];
            if (!hole) return;
            Count.registerCard(hole); // no-op if it was somehow already counted
            this._emit('onCountChange', this._countSnapshot());
            this._emit('onHoleCardRevealed', hole, this.dealerHand);
        }

        /**
         * Fabricates/draws the opening 4 cards for the current game mode and
         * deals them in the same interleave order as the old monolith
         * (player card, dealer hidden hole card, player card, dealer
         * upcard) so shoe consumption pacing matches the original engine.
         *
         * Per-mode dealer-upcard handling (all deliberate, see report):
         *   testout / pairs / soft / hard  -> a genuinely random shoe draw
         *     (already drawn as `dUp` below) — "hard" mode's spec calls for
         *     "a random dealer upcard 2-11", which the natural shoe draw
         *     already satisfies without wasting a card.
         *   deviations / surrender -> the natural `dUp` draw is discarded
         *     and replaced with a dealer upcard fixed to the scenario
         *     (matches the old monolith's `deviations` branch exactly).
         */
        _dealInitialCards() {
            let p1, p2;
            let dUp = this._drawFromShoe(); // default random upcard candidate

            if (this.gameMode === 'testout') {
                p1 = this._drawFromShoe();
                p2 = this._drawFromShoe();
            } else if (this.gameMode === 'pairs') {
                [p1, p2] = this._fabricatePair();
            } else if (this.gameMode === 'soft') {
                [p1, p2] = this._fabricateSoft();
            } else if (this.gameMode === 'hard') {
                [p1, p2] = this._fabricateHardTotal(this._randomInt(5, 20));
                // dUp intentionally left as the natural random shoe draw.
            } else if (this.gameMode === 'deviations') {
                const devKeys = hardDeviationKeys();
                const key = devKeys[this._randomInt(0, devKeys.length - 1)];
                const parts = key.split('_'); // ['hard', total, dealerValue]
                const total = Number(parts[1]);
                const dealerValue = Number(parts[2]);
                const entry = StrategyData.deviations[key];

                [p1, p2] = this._fabricateHardTotal(total);
                dUp = this._fabricateDealerUpcard(dealerValue);
                // Pre-flag as counted so the normal dealing pipeline's
                // registerCard() calls below are no-ops — otherwise the
                // freshly forced true count would immediately drift by
                // these 3 cards' own Hi-Lo tags before the player even acts.
                p1.counted = true; p2.counted = true; dUp.counted = true;

                const decksRemaining = Count.getDecksRemaining(this.shoe);
                const offset = this._randomInt(-1, 2); // -1..+2 around the threshold, forces genuine judgment
                Count.runningCount = Math.trunc((entry.tc + offset) * decksRemaining);
                this._emit('onCountChange', this._countSnapshot());
            } else if (this.gameMode === 'surrender') {
                const pool = Math.random() < 0.5 ? SURRENDER_TRUE_SCENARIOS : SURRENDER_LOOKALIKE_SCENARIOS;
                const scenario = pool[this._randomInt(0, pool.length - 1)];
                [p1, p2] = this._fabricateHardTotal(scenario.total);
                dUp = this._fabricateDealerUpcard(scenario.dealer);
            }

            this._addCardToHand(this.playerHands[0], p1, { isPlayer: true });
            const holeCard = this._drawFromShoe();
            this._addCardToHand(this.dealerHand, holeCard, { isPlayer: false, hidden: true });
            this._addCardToHand(this.playerHands[0], p2, { isPlayer: true });
            this._addCardToHand(this.dealerHand, dUp, { isPlayer: false, hidden: false });
        }

        // --- round lifecycle --------------------------------------------------------

        /**
         * @param {number} [betAmount] - if provided, sets the bet directly
         *   (absolute, like `setBet(amount, {replace:true})`) before
         *   starting — convenient for scripted/automated play. If omitted,
         *   uses whatever bet is already staged via `setBet()`.
         * @returns {boolean} true if a round actually started.
         */
        startRound(betAmount) {
            if (this.gameMode === 'testout') {
                if (typeof betAmount === 'number') this.setBet(betAmount, { replace: true });

                if (this.bankroll <= 0 && this.currentBet === 0 && !this.settings.freeplay) {
                    this.bankroll = 10000;
                    this._persistBankroll();
                    this._emit('onFeedback', 'Bankroll Reloaded to $10,000', 3000);
                    return false;
                }
                if (this.currentBet === 0 && !this.settings.freeplay) {
                    this._emit('onFeedback', 'PLACE A BET', 1500);
                    return false;
                }
            } else {
                this.currentBet = 0; // drills never bet
                this._emit('onBetChange', 0);
            }

            this.state = 'dealing';
            this._emit('onStateChange', this.state);

            this.dealerHand = new Hand();
            this.playerHands = [new Hand(this.currentBet)];
            this.activeHandIndex = 0;
            this.insuranceBet = 0;

            if (this.shoe.needsShuffle) this._reshuffle();

            this._dealInitialCards();

            this.state = 'player-turn';
            this._emit('onStateChange', this.state);
            this._emit('onHandsUpdate', this._snapshot());

            if (this.gameMode === 'testout' && this.dealerHand.cards[1].rank === 'A') {
                this.state = 'insurance';
                this._emit('onStateChange', this.state);
                this._emit('onInsuranceOffered');
            } else if (this.gameMode === 'testout' && this.playerHands[0].score.isBlackjack) {
                this._resolveImmediateBlackjack();
            }

            return true;
        }

        /**
         * Dealer peeks for blackjack behind an Ace upcard. `bought` is
         * whether the player took insurance; grading always runs (unless
         * casual mode), matching the old monolith's AP-deviation check
         * (take insurance at TC >= +3, via BJ.StrategyEngine).
         */
        handleInsurance(bought) {
            const trueCount = Count.getTrueCount(Count.runningCount, Count.getDecksRemaining(this.shoe));
            const optimal = StrategyEngine.getInsuranceRecommendation(trueCount);
            const correct = bought === optimal;

            if (!this.settings.casualMode) {
                this._recordDecision('testout', correct);
                if (!correct) {
                    const msg = optimal
                        ? 'Deviation Error: Take Insurance at TC +3 or higher'
                        : 'Deviation Error: Never take Insurance below TC +3';
                    this._emit('onFeedback', msg, 3500);
                    this._logMistake({
                        hand: this.playerHands[0],
                        dealerUpcard: this.dealerHand.cards[1].value,
                        trueCount,
                        playerAction: bought ? 'Buy' : 'Pass',
                        optimalPlay: optimal ? 'Buy' : 'Pass',
                        mode: 'testout',
                        descriptionOverride: 'Insurance decision'
                    });
                }
            }

            let boughtFinal = bought;
            if (bought) {
                const insCost = this.currentBet / 2;
                if (this.settings.freeplay || this.bankroll >= insCost) {
                    if (!this.settings.freeplay) {
                        this.bankroll -= insCost;
                        this._persistBankroll();
                    }
                    this.insuranceBet = insCost;
                    this._emit('onInsuranceResolved', { bought: true, cost: insCost });
                } else {
                    this._emit('onFeedback', 'Not enough bankroll for Insurance', 2000);
                    boughtFinal = false;
                }
            } else {
                this._emit('onInsuranceResolved', { bought: false });
            }

            if (this.dealerHand.score.isBlackjack) {
                this._resolveRound();
            } else {
                if (boughtFinal) {
                    this._emit('onFeedback', 'Nobody home. Insurance lost.', 2000);
                    this.insuranceBet = 0; // dealer sweeps it; already deducted from bankroll above
                }
                this.state = 'player-turn';
                this._emit('onStateChange', this.state);
                this._emit('onHandsUpdate', this._snapshot());

                if (this.playerHands[0].score.isBlackjack) {
                    this._resolveImmediateBlackjack();
                }
            }
        }

        // --- player decisions --------------------------------------------------------

        _activeHand() {
            return this.playerHands[this.activeHandIndex];
        }

        _hasFunds(bet) {
            // Drills and freeplay always bypass the bankroll check, matching
            // the old monolith's `isDrill = gameMode !== 'testout' || toggleBankroll.checked`.
            if (this.gameMode !== 'testout' || this.settings.freeplay) return true;
            return this.bankroll >= bet;
        }

        _canSurrender(hand) {
            return Rules.lateSurrender
                && !!hand && hand.cards.length === 2 && !hand.surrendered && !hand.resolved
                && this.playerHands.length === 1 // never after a split
                && (this.gameMode === 'testout' || this.gameMode === 'hard' || this.gameMode === 'surrender');
        }

        _resetForNextDrill() {
            this.state = 'betting';
            if (this.shoe.needsShuffle) this._reshuffle();
            this._emit('onStateChange', this.state);
            this._emit('onHandsUpdate', this._snapshot());
        }

        /**
         * Grades `actionCode` against BJ.StrategyEngine (or, for the
         * `surrender` drill, against the dedicated surrender-only helper —
         * see class header). No-ops under casual mode, when the hand is
         * already resolved/bust, or outside 'player-turn'. Updates session +
         * lifetime stats and the mistake log through BJ.Storage.
         *
         * @returns {{correct:boolean, optimalPlay:string}|null}
         */
        _evaluatePlay(actionCode, hand) {
            if (this.settings.casualMode) return null;
            if (!hand || hand.resolved || hand.score.isBust) return null;
            if (this.state !== 'player-turn') return null;

            const dealerUpcard = this.dealerHand.cards[1].value;
            const trueCount = Count.getTrueCount(Count.runningCount, Count.getDecksRemaining(this.shoe));
            const canDouble = hand.cards.length === 2 && this._hasFunds(hand.bet);
            const canSplit = hand.isPair && this.playerHands.length < 4 && this._hasFunds(hand.bet);
            const canSurrender = this._canSurrender(hand);

            let optimalPlay, correct;

            if (this.gameMode === 'surrender') {
                // Binary Surrender-vs-Play-On discrimination (plan item 8):
                // grade strictly against the surrender chart/Fab-4 indices,
                // not the full H/S/D/P decision tree.
                const shouldSurrender = StrategyEngine.getSurrenderRecommendation(hand, dealerUpcard, trueCount);
                const chosesSurrender = actionCode === 'R';
                optimalPlay = shouldSurrender ? 'R' : 'N';
                correct = chosesSurrender === shouldSurrender;
            } else {
                optimalPlay = StrategyEngine.getOptimalPlay(hand, dealerUpcard, trueCount, canDouble, canSplit, canSurrender);
                correct = actionCode === optimalPlay;
            }

            this._recordDecision(this.gameMode, correct);

            if (!correct) {
                this._logMistake({ hand, dealerUpcard, trueCount, playerAction: actionCode, optimalPlay, mode: this.gameMode });
                this._emit('onFeedback', 'Error: Optimal play is ' + (ACTION_LABELS[optimalPlay] || optimalPlay), 2500);
            }

            return { correct, optimalPlay };
        }

        _recordDecision(mode, correct) {
            const bump = (bucket) => {
                bucket.decisionsTotal = (bucket.decisionsTotal || 0) + 1;
                if (correct) bucket.decisionsCorrect = (bucket.decisionsCorrect || 0) + 1;
                if (!bucket.byMode) bucket.byMode = {};
                if (!bucket.byMode[mode]) bucket.byMode[mode] = { total: 0, correct: 0 };
                bucket.byMode[mode].total++;
                if (correct) bucket.byMode[mode].correct++;
            };
            bump(this.sessionStats);
            bump(this.lifetimeStats);
            Storage.setSessionStats(this.sessionStats);
            Storage.setLifetimeStats(this.lifetimeStats);

            const modeStats = this.sessionStats.byMode[mode];
            const sessionAccuracy = modeStats.total > 0 ? Math.round((modeStats.correct / modeStats.total) * 100) : null;
            this._emit('onStatsUpdate', { session: this.sessionStats, lifetime: this.lifetimeStats, sessionAccuracy, mode });
        }

        _describeHand(hand) {
            if (hand.isPair) {
                const r = hand.cards[0].rank === 'A' ? 'A' : hand.cards[0].rank;
                return 'Pair of ' + r + 's';
            }
            if (hand.isSoft && hand.cards.length === 2) return 'Soft ' + hand.score.total;
            return 'Hard ' + hand.score.total;
        }

        _logMistake(details) {
            const entry = {
                timestamp: Date.now(),
                mode: details.mode,
                handDescription: details.descriptionOverride || this._describeHand(details.hand),
                dealerUpcard: details.dealerUpcard,
                // True count is only meaningful to log for modes where it
                // actually drives the correct answer (index plays / the
                // surrender Fab-4 / insurance); recording it elsewhere would
                // just be noise attached to a basic-strategy-only decision.
                trueCount: (details.mode === 'deviations' || details.mode === 'surrender' || details.descriptionOverride === 'Insurance decision')
                    ? details.trueCount
                    : null,
                playerAction: ACTION_LABELS[details.playerAction] || details.playerAction,
                correctAction: ACTION_LABELS[details.optimalPlay] || details.optimalPlay
            };
            Storage.pushMistake(entry);
            this._emit('onMistakeLogged', entry);
        }

        playerHit() {
            const hand = this._activeHand();
            if (!hand || hand.resolved) return null;
            const grade = this._evaluatePlay('H', hand);

            if (this.gameMode === 'testout') {
                const card = this._drawFromShoe();
                this._addCardToHand(hand, card, { isPlayer: true });
                if (hand.score.isBust) {
                    hand.resolved = true;
                    this._advanceHand();
                } else {
                    this._emit('onHandsUpdate', this._snapshot());
                }
            } else {
                this._resetForNextDrill();
            }
            return grade;
        }

        playerStand() {
            const hand = this._activeHand();
            if (!hand || hand.resolved) return null;
            const grade = this._evaluatePlay('S', hand);

            if (this.gameMode === 'testout') {
                hand.resolved = true;
                this._advanceHand();
            } else {
                this._resetForNextDrill();
            }
            return grade;
        }

        playerDouble() {
            const hand = this._activeHand();
            if (!hand || hand.resolved) return null;
            const grade = this._evaluatePlay('D', hand);

            if (this.gameMode === 'testout') {
                if (hand.cards.length === 2 && this._hasFunds(hand.bet)) {
                    if (!this.settings.freeplay) {
                        this.bankroll -= hand.bet;
                        this._persistBankroll();
                    }
                    hand.bet *= 2;
                    hand.hasDoubled = true;
                    if (this.playerHands.length === 1) {
                        this.currentBet = hand.bet;
                        this._emit('onBetChange', this.currentBet);
                    }
                    const card = this._drawFromShoe();
                    this._addCardToHand(hand, card, { isPlayer: true });
                    hand.resolved = true;
                    this._advanceHand();
                } else {
                    this._emit('onFeedback', 'Cannot double right now', 1500);
                }
            } else {
                this._resetForNextDrill();
            }
            return grade;
        }

        playerSplit() {
            const hand = this._activeHand();
            if (!hand || hand.resolved) return null;
            const grade = this._evaluatePlay('P', hand);

            if (this.gameMode === 'testout') {
                const canSplit = hand.cards.length === 2 && hand.isPair
                    && this.playerHands.length < 4 && this._hasFunds(hand.bet);

                if (canSplit) {
                    if (!this.settings.freeplay) {
                        this.bankroll -= hand.bet;
                        this._persistBankroll();
                    }
                    const newHand = new Hand(hand.bet);
                    newHand.add(hand.cards.pop());

                    const card1 = this._drawFromShoe();
                    this._addCardToHand(hand, card1, { isPlayer: true });

                    const card2 = this._drawFromShoe();
                    this._addCardToHand(newHand, card2, { isPlayer: true });

                    this.playerHands.splice(this.activeHandIndex + 1, 0, newHand);

                    // Split aces: one card each, resolved immediately (no
                    // further hit/double offered), matching the old engine —
                    // resplitAces is false (BJ.Rules), so this never recurses.
                    if (hand.cards[0].rank === 'A') {
                        hand.resolved = true;
                        newHand.resolved = true;
                        this._advanceHand();
                    } else {
                        this._emit('onHandsUpdate', this._snapshot());
                    }
                } else {
                    this._emit('onFeedback', 'Cannot split right now', 1500);
                }
            } else {
                this._resetForNextDrill();
            }
            return grade;
        }

        /**
         * Late surrender (plan §3.1 / bug #4). Only valid as a first
         * decision on a 2-card, non-split, non-doubled hand. Sets
         * `hand.surrendered`/`.outcome`/`.payout` directly (net loss of half
         * the bet) rather than drawing further cards, then advances/resolves
         * exactly like a stand would.
         */
        playerSurrender() {
            const hand = this._activeHand();
            if (!hand || hand.resolved) return null;
            const grade = this._evaluatePlay('R', hand);

            if (!this._canSurrender(hand)) {
                this._emit('onFeedback', 'Surrender not available', 1500);
                if (this.gameMode !== 'testout') this._resetForNextDrill();
                return grade;
            }

            hand.surrendered = true;
            hand.outcome = 'surrender';
            hand.payout = -hand.bet / 2;
            hand.resolved = true;

            if (this.gameMode === 'testout') {
                this._advanceHand();
            } else {
                this._resetForNextDrill();
            }
            return grade;
        }

        _advanceHand() {
            this.activeHandIndex++;
            if (this.activeHandIndex >= this.playerHands.length) {
                const allDone = this.playerHands.every((h) => h.score.isBust || h.surrendered);
                if (allDone) {
                    this._resolveRound();
                } else {
                    this.state = 'dealer-turn';
                    this._emit('onStateChange', this.state);
                    this._flipHoleCard();
                    this.dealerPlay();
                }
            } else {
                this._emit('onHandsUpdate', this._snapshot());
            }
        }

        /**
         * Plays out the dealer's hand at the pace of `settings.gameSpeed` ms
         * per card (0 = instant), calling `onDealerCardDealt` for each draw
         * so a render layer can pace deal-in animations — port of the old
         * `dealerTurn()`'s timing shape, minus all DOM/audio calls. Resolves
         * the round itself once the dealer is done (mirrors the old
         * `dealerTurn -> resolveWinner` chain) and returns a Promise so
         * callers/tests can await round completion instead of polling state.
         *
         * @returns {Promise<Object>} resolves with the post-round snapshot.
         */
        dealerPlay() {
            return new Promise((resolve) => {
                const step = () => {
                    const dScore = this.dealerHand.score;
                    const mustHit = dScore.total < 17 || (dScore.isSoft && dScore.total === 17 && Rules.h17);

                    if (mustHit) {
                        const delay = this.settings.gameSpeed || 0;
                        setTimeout(() => {
                            const card = this._drawFromShoe();
                            this._addCardToHand(this.dealerHand, card, { isPlayer: false });
                            this._emit('onHandsUpdate', this._snapshot());
                            step();
                        }, delay);
                    } else {
                        this._resolveRound();
                        resolve(this._snapshot());
                    }
                };
                step();
            });
        }

        /**
         * Immediate resolution for a player natural blackjack when the
         * dealer's upcard didn't trigger insurance (no dealer peek is
         * performed here — ported as-is from the old monolith, which never
         * peeked a ten-up dealer hand for blackjack either; not a Phase B
         * scope item to fix).
         */
        _resolveImmediateBlackjack() {
            this.state = 'resolving';
            this._emit('onStateChange', this.state);
            this._flipHoleCard();

            const hand = this.playerHands[0];
            hand.outcome = 'blackjack';
            hand.payout = hand.bet * Rules.blackjackPayout;
            hand.resolved = true;

            if (!this.settings.freeplay) {
                this.bankroll += hand.payout;
                this._persistBankroll();
            }

            const summary = this._buildSummary({ dealerBlackjack: false, dealerBust: false, insurancePayout: 0 });
            this._pushHandHistory(summary);

            this.state = 'idle';
            this._emit('onRoundResolved', this.playerHands.slice(), summary);
            this._emit('onStateChange', this.state);

            this.currentBet = 0;
            this.insuranceBet = 0;
            this._emit('onBetChange', 0);

            if (this.shoe.needsShuffle) this._reshuffle();
        }

        /**
         * Per-hand payout resolution (bug #7 fix). Every hand gets its own
         * `.outcome`/`.payout`; the bankroll delta is the sum across all
         * hands, so split hands with independent bets/outcomes resolve
         * correctly (the old string-sentinel path couldn't do this at all).
         */
        _resolveRound() {
            this.state = 'resolving';
            this._emit('onStateChange', this.state);

            const dScore = this.dealerHand.score;
            const dBust = dScore.isBust;
            const dBlackjack = dScore.isBlackjack;

            let insurancePayout = 0;
            if (dBlackjack && this.insuranceBet > 0) {
                insurancePayout = this.insuranceBet * 2; // net profit at 2:1
                if (!this.settings.freeplay) {
                    this.bankroll += this.insuranceBet * 3; // original bet back + 2x profit
                }
            }

            this.playerHands.forEach((hand) => {
                if (hand.surrendered) return; // outcome/payout already set at surrender time

                const pScore = hand.score;
                if (pScore.isBust) {
                    hand.outcome = 'loss'; hand.payout = -hand.bet;
                } else if (dBlackjack) {
                    if (pScore.isBlackjack) { hand.outcome = 'push'; hand.payout = 0; }
                    else { hand.outcome = 'loss'; hand.payout = -hand.bet; }
                } else if (pScore.isBlackjack) {
                    hand.outcome = 'blackjack'; hand.payout = hand.bet * Rules.blackjackPayout;
                } else if (dBust || pScore.total > dScore.total) {
                    hand.outcome = 'win'; hand.payout = hand.bet;
                } else if (dScore.total > pScore.total) {
                    hand.outcome = 'loss'; hand.payout = -hand.bet;
                } else {
                    hand.outcome = 'push'; hand.payout = 0;
                }
            });

            const bankrollDelta = this.playerHands.reduce((sum, h) => sum + h.payout, 0);
            if (!this.settings.freeplay) {
                this.bankroll += bankrollDelta;
                this._persistBankroll();
            }

            const summary = this._buildSummary({ dealerBlackjack: dBlackjack, dealerBust: dBust, insurancePayout, bankrollDelta });
            this._pushHandHistory(summary);

            this.state = 'idle';
            this._emit('onRoundResolved', this.playerHands.slice(), summary);
            this._emit('onStateChange', this.state);

            this.currentBet = 0;
            this.insuranceBet = 0;
            this._emit('onBetChange', 0);

            if (this.shoe.needsShuffle) this._reshuffle();
        }

        _buildSummary(extra) {
            return Object.assign({
                hands: this.playerHands.map((h) => ({ outcome: h.outcome, payout: h.payout, bet: h.bet, total: h.score.total, surrendered: h.surrendered })),
                dealerTotal: this.dealerHand.score.total,
                bankroll: this.bankroll
            }, extra);
        }

        _pushHandHistory(summary) {
            Storage.pushHandHistory(Object.assign({ timestamp: Date.now(), mode: this.gameMode }, summary));
        }

        _persistBankroll() {
            Storage.setBankroll(this.bankroll);
            this._emit('onBankrollChange', this.bankroll);
        }

        _freshStatsBucket() {
            return {
                decisionsTotal: 0,
                decisionsCorrect: 0,
                byMode: {
                    testout: { total: 0, correct: 0 },
                    hard: { total: 0, correct: 0 },
                    pairs: { total: 0, correct: 0 },
                    soft: { total: 0, correct: 0 },
                    deviations: { total: 0, correct: 0 },
                    surrender: { total: 0, correct: 0 }
                }
            };
        }
    }

    BJ.GameManager = GameManager;

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = GameManager;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
