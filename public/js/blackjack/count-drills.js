// ==========================================
// count-drills.js — the four standalone counting drills (Count tab):
//
//   'speed'      — flash N cards at a set rate, then ask for the running count.
//   'manual'     — the CLASSIC DECK COUNTDOWN: you advance each card yourself
//                  and a stopwatch runs. Graded on the count AND on pace,
//                  against the published counting-school benchmark (see
//                  PACE_* below). This is the drill the literature actually
//                  specifies, and it is the only one where being slow is a
//                  failure rather than a comfort.
//   'estimation' — bury a random slice of the shoe, show the discard tray,
//                  then ask how many decks remain (graded to ±0.5).
//   'truecount'  — flash N cards (same as 'speed'), but the ask at the end is
//                  the TRUE count: player must combine their own running
//                  count with an eyeballed read of the (still-visible)
//                  discard tray and do the RC÷decks conversion themselves
//                  (graded to ±1 — see TC_TOLERANCE).
//
// These live OUTSIDE the round lifecycle: no dealer, no hands, no bets, no
// GameManager state machine. They own their own Shoe and tally their own
// count via `Count.tagOf()` — deliberately NOT `Count.registerCard()`, which
// mutates the shared `Count.runningCount` singleton and would corrupt the
// live table session's count the moment you opened a drill.
//
// They still feed session/lifetime stats, through the one public hook that
// knows how: `GameManager.recordDrillResult(mode, correct)`.
//
// EVERY RUNNING DRILL CAN BE ABORTED. A timed card feed with no way out is
// not a drill, it is a trap: lose the count on card 9 of 104 and the only
// exits were to sit through 95 meaningless cards or leave the screen
// entirely. `renderRunning()` keeps a Stop control on screen for the whole
// running phase — the panel is never left empty while cards are moving.
//
// DOM: #count-drill-container, shown/hidden by hub.js's tile routing.
// Cards are built with the shared BJ.buildCardEl (render.js) so there's a
// single definition of card markup.
// ==========================================

(function (root) {
    'use strict';

    var BJ = (typeof window !== 'undefined')
        ? (window.BJ = window.BJ || {})
        : (root.BJ = root.BJ || {});

    function byId(id) { return document.getElementById(id); }
    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = text;
        return node;
    }

    var SPEED_SIZES = [26, 52, 104];
    var SPEED_RATES = [
        { label: 'Slow (1/s)', value: 1 },
        { label: 'Steady (2/s)', value: 2 },
        { label: 'Fast (3/s)', value: 3 },
        { label: 'Brutal (5/s)', value: 5 }
    ];

    // Manual countdown sizes. 52 is the default and the only one the published
    // benchmark is stated in — a single deck. The others exist so the drill
    // can be warmed up on half a deck or hardened on two, and pace is always
    // normalised back to seconds-per-deck so the bar means the same thing at
    // every size.
    var MANUAL_SIZES = [26, 52, 104];

    var DECK_TOLERANCE = 0.5; // half-deck accuracy is the real-world standard
    var TC_TOLERANCE = 1;     // true count is a rounded conversion of an eyeballed deck estimate — ±1 is the fair bar

    // --- the deck-countdown benchmark -----------------------------------
    // The pass mark taught by the counting schools is a single deck counted
    // down in under 30 seconds, with 25 as the stretch goal, and the standard
    // is to do it CLEANLY FIVE TIMES IN A ROW before considering the skill
    // held. The streak is the part most self-study skips, and it is the part
    // that separates "I did it once" from "I can do it": one clean run inside
    // five attempts is noise.
    //
    // Both numbers are seconds PER DECK, so a 104-card run is held to 60s and
    // a 26-card run to 15s. Normalising here rather than storing three sets of
    // thresholds is what stops the bar quietly softening when the size changes.
    var PACE_PASS_SEC_PER_DECK = 30;
    var PACE_STRETCH_SEC_PER_DECK = 25;
    var CLEAN_RUN_TARGET = 5;

    var CARDS_PER_DECK = 52;

    var state = {
        drill: null,        // 'speed' | 'manual' | 'estimation' | 'truecount'
        phase: 'setup',     // 'setup' | 'running' | 'answer' | 'result'
        shoe: null,
        localCount: 0,
        dealt: 0,
        target: 0,
        timer: null,
        actualDecks: 0,
        // Manual-countdown timing. `startedAt` is stamped on the FIRST card
        // reveal, never on the Start click — otherwise the drill measures how
        // fast you move your hand off a button, which is not the skill.
        startedAt: 0,
        elapsedMs: 0,
        keyHandler: null
    };

    function gm() { return BJ.instance && BJ.instance.gameManager; }
    function settings() { var g = gm(); return g ? g.getSettings() : {}; }

    function isFlashDrill(d) { return d === 'speed' || d === 'truecount'; }
    /** Every drill that shows cards one at a time and asks for a count at the end. */
    function isCardFeed(d) { return isFlashDrill(d) || d === 'manual'; }

    // ------------------------------------------------------------------
    // shared chrome
    // ------------------------------------------------------------------

    function setTray(frac) {
        var tray = byId('cd-tray');
        if (tray) tray.style.setProperty('--tray-fill', (Math.max(0, Math.min(1, frac)) * 100).toFixed(2) + '%');
    }

    function setProgress(text) {
        var p = byId('cd-progress');
        if (p) p.textContent = text || '';
    }

    function clearStage() {
        var slot = byId('cd-card-slot');
        if (slot) slot.innerHTML = '';
    }

    function panel() { return byId('cd-panel'); }

    function stopTimer() {
        if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    }

    /**
     * Manual mode is driven from the keyboard as well as the mouse, and the
     * listener is on `document` because the thing you are looking at is the
     * card, not a focused button. It MUST be torn down on every exit from the
     * running phase — a surviving handler would keep advancing a drill that
     * is no longer on screen, and the next run would inherit a second copy.
     */
    function unbindKeys() {
        if (state.keyHandler && typeof document !== 'undefined') {
            document.removeEventListener('keydown', state.keyHandler);
        }
        state.keyHandler = null;
    }

    function bindKeys(handler) {
        unbindKeys();
        state.keyHandler = handler;
        if (typeof document !== 'undefined') document.addEventListener('keydown', handler);
    }

    /** Seconds per deck for a run of `cards` cards taking `ms` milliseconds. */
    function paceSecPerDeck(ms, cards) {
        if (!cards) return null;
        return (ms / 1000) * (CARDS_PER_DECK / cards);
    }

    function fmtSec(ms) { return (ms / 1000).toFixed(1) + 's'; }

    // ------------------------------------------------------------------
    // the clean-run streak (manual countdown only)
    // ------------------------------------------------------------------

    /**
     * `{ streak, best, stretchHit, bestPace }` — consecutive runs that were
     * BOTH correct and inside the pass pace. Stored rather than derived
     * because a streak is a fact about a sequence of attempts and the stats
     * buckets only keep totals.
     *
     * `bestPace` is the fastest ACCURATE run's seconds-per-deck. Pace from an
     * inaccurate run is not a personal best — it is the time it took to get a
     * deck wrong — and recording it would let the headline number improve by
     * counting faster and worse.
     */
    function getCountdownRecord() {
        var raw = (BJ.Storage && BJ.Storage.get('countdown_record', null)) || {};
        return {
            streak: raw.streak || 0,
            best: raw.best || 0,
            stretchHit: !!raw.stretchHit,
            bestPace: raw.bestPace == null ? null : raw.bestPace
        };
    }

    function recordCountdownRun(clean, accurate, pace) {
        var rec = getCountdownRecord();
        rec.streak = clean ? rec.streak + 1 : 0;
        if (rec.streak > rec.best) rec.best = rec.streak;
        if (accurate && pace !== null) {
            if (rec.bestPace === null || pace < rec.bestPace) rec.bestPace = Math.round(pace * 10) / 10;
            if (pace <= PACE_STRETCH_SEC_PER_DECK) rec.stretchHit = true;
        }
        if (BJ.Storage) BJ.Storage.set('countdown_record', rec);

        // The Running Count checkout is earned across separate runs rather
        // than inside one attempt, so it settles here rather than through
        // Mastery.startCheckout. Mastery re-checks eligibility itself, so a
        // streak built before the section's volume was met does not sneak a
        // checkout through.
        if (BJ.Mastery && typeof BJ.Mastery.syncCountdownCheckout === 'function') {
            BJ.Mastery.syncCountdownCheckout(rec.streak);
        }
        return rec;
    }

    // ------------------------------------------------------------------
    // setup phase
    // ------------------------------------------------------------------

    function renderSetup() {
        stopTimer();
        unbindKeys();
        state.phase = 'setup';
        clearStage();
        setProgress('');
        setTray(0);

        var p = panel();
        if (!p) return;
        p.innerHTML = '';

        if (state.drill === 'manual') {
            p.appendChild(el('p', 'cd-blurb',
                'You advance each card yourself and the clock runs. Keep the running count, then enter it at the end. '
                + 'The bar is one deck in under ' + PACE_PASS_SEC_PER_DECK + 's (' + PACE_STRETCH_SEC_PER_DECK + 's is the stretch goal), '
                + CLEAN_RUN_TARGET + ' clean runs in a row.'));

            var mrec = getCountdownRecord();
            p.appendChild(el('p', 'cd-hint',
                'Clean runs in a row: ' + mrec.streak + ' / ' + CLEAN_RUN_TARGET
                + (mrec.best ? '  ·  best ' + mrec.best : '')));

            var ms = settings();
            p.appendChild(buildChoiceRow('Cards', MANUAL_SIZES.map(function (n) {
                return { label: String(n), value: n };
            }), ms.manualCountSize || 52, function (v) {
                var g = gm(); if (g) g.updateSettings({ manualCountSize: v });
                renderSetup();
            }));
        } else if (isFlashDrill(state.drill)) {
            p.appendChild(el('p', 'cd-blurb', state.drill === 'truecount'
                ? 'Cards flash one at a time — keep the running count. At the end, use the discard tray to gauge decks remaining and give the TRUE count (running ÷ decks).'
                : 'Cards flash one at a time. Keep the running count, then enter it at the end.'));

            var s = settings();
            p.appendChild(buildChoiceRow('Cards', SPEED_SIZES.map(function (n) {
                return { label: String(n), value: n };
            }), s.speedCountSize || 52, function (v) {
                var g = gm(); if (g) g.updateSettings({ speedCountSize: v });
                renderSetup();
            }));

            p.appendChild(buildChoiceRow('Speed', SPEED_RATES, s.speedCountRate || 2, function (v) {
                var g = gm(); if (g) g.updateSettings({ speedCountRate: v });
                renderSetup();
            }));
        } else {
            p.appendChild(el('p', 'cd-blurb', 'Part of the shoe gets dealt into the discard tray. Estimate how many decks are left — within half a deck counts.'));
        }

        var start = el('button', 'button button--primary cd-start', 'Start');
        start.type = 'button';
        start.addEventListener('click', run);
        p.appendChild(start);
    }

    function buildChoiceRow(label, options, current, onPick) {
        var row = el('div', 'cd-choice');
        row.appendChild(el('span', 'cd-choice__label', label));
        var seg = el('div', 'segmented cd-choice__seg');
        options.forEach(function (opt) {
            var b = el('button', 'seg' + (opt.value === current ? ' active' : ''), opt.label);
            b.type = 'button';
            b.addEventListener('click', function () { onPick(opt.value); });
            seg.appendChild(b);
        });
        row.appendChild(seg);
        return row;
    }

    // ------------------------------------------------------------------
    // running phase
    // ------------------------------------------------------------------

    function freshShoe() {
        var Rules = BJ.Rules || { decks: 6 };
        return new BJ.Shoe(Rules.decks);
    }

    /**
     * The controls that stay on screen for the whole running phase. Before
     * this existed the panel was simply emptied while cards were moving, so a
     * player who lost the count had no control of any kind in front of them.
     */
    function renderRunning() {
        var p = panel();
        if (!p) return;
        p.innerHTML = '';

        if (state.drill === 'manual') {
            var next = el('button', 'button button--primary cd-advance', 'Next card');
            next.type = 'button';
            next.addEventListener('click', advanceManual);
            p.appendChild(next);
            p.appendChild(el('p', 'cd-hint', 'Space or → also advances. Esc stops.'));
        }

        var stop = el('button', 'button cd-secondary cd-stop', 'Stop');
        stop.type = 'button';
        // Abandon, not finish: a run you bailed out of has no count worth
        // grading and must not be written to stats as a miss. Losing the count
        // is a normal event in practice and recording it as a failed attempt
        // would punish the honest exit and reward sitting through dead cards.
        stop.addEventListener('click', abort);
        p.appendChild(stop);
    }

    function run() {
        stopTimer();
        unbindKeys();
        state.shoe = freshShoe();
        state.localCount = 0;
        state.dealt = 0;
        state.startedAt = 0;
        state.elapsedMs = 0;
        state.phase = 'running';

        if (state.drill === 'manual') {
            state.target = settings().manualCountSize || 52;
            renderRunning();
            setProgress('0 / ' + state.target);
            bindKeys(function (e) {
                if (state.phase !== 'running') return;
                if (e.key === ' ' || e.key === 'Spacebar' || e.key === 'ArrowRight' || e.key === 'Enter') {
                    e.preventDefault();
                    advanceManual();
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    abort();
                }
            });
            advanceManual(); // reveal the first card and start the clock
            return;
        }

        if (isFlashDrill(state.drill)) {
            renderRunning();
            var s = settings();
            state.target = s.speedCountSize || 52;
            var rate = s.speedCountRate || 2;
            var interval = Math.max(120, Math.round(1000 / rate));
            bindKeys(function (e) {
                if (state.phase === 'running' && e.key === 'Escape') { e.preventDefault(); abort(); }
            });
            flashNext(interval);
            return;
        }

        // Estimation: bury a random slice (20%–85% penetration), then ask.
        var p = panel();
        if (p) p.innerHTML = '';
        var total = state.shoe.cards.length;
        var frac = 0.2 + Math.random() * 0.65;
        var toBurn = Math.floor(total * frac);
        for (var i = 0; i < toBurn; i++) state.shoe.draw();
        state.dealt = toBurn;
        setTray(toBurn / total);
        setProgress('');
        state.actualDecks = BJ.Count.getDecksRemaining(state.shoe);
        renderAnswer();
    }

    /**
     * Puts one card on the stage and folds it into the local count. Shared by
     * the timed feed and the manual one so there is a single definition of
     * "a card was shown".
     *
     * @returns {boolean} false when the shoe ran dry.
     */
    function showCard() {
        var card = state.shoe.draw();
        if (!card) return false;

        state.localCount += BJ.Count.tagOf(card);
        state.dealt++;

        var slot = byId('cd-card-slot');
        if (slot) {
            slot.innerHTML = '';
            var node = BJ.buildCardEl(card, false);
            // `cd-flash` opts out of the deal-in TRANSITION (a 350ms fade
            // would smear into the next card at 3–5 cards/sec) and opts into
            // a ~110ms keyframe tick instead.
            //
            // The tick is not decoration. A transition needs a "before" state
            // to animate from, and a card replacing an IDENTICAL card has
            // none — same rank, same suit, same pixels — so two 7♦ in a row
            // produced no visual event whatsoever and read as one card. With
            // six decks there are six copies of every card in the shoe, so
            // that is a routine occurrence, and it silently costs the player
            // a point of count with nothing on screen to blame. A keyframe
            // animation on a freshly created element always replays, whatever
            // the card is, which is exactly the property needed here.
            node.classList.add('dealt', 'cd-flash');
            slot.appendChild(node);
        }

        setProgress(state.dealt + ' / ' + state.target);
        setTray(state.dealt / (BJ.Rules ? BJ.Rules.decks * 52 : 312));
        return true;
    }

    function flashNext(interval) {
        if (state.dealt >= state.target) { renderAnswer(); return; }
        if (!showCard()) { renderAnswer(); return; }
        state.timer = setTimeout(function () { flashNext(interval); }, interval);
    }

    function advanceManual() {
        if (state.phase !== 'running') return;

        // Stamped on the first reveal, so the clock measures the countdown and
        // not the player's reaction to the Start button.
        if (!state.startedAt) state.startedAt = Date.now();

        if (!showCard() || state.dealt >= state.target) {
            state.elapsedMs = Date.now() - state.startedAt;
            renderAnswer();
        }
    }

    /**
     * Leaves a running drill without grading it. Returns to setup rather than
     * to the hub: the overwhelmingly likely next action after losing the count
     * is to run it again, possibly a notch slower.
     */
    function abort() {
        stopTimer();
        unbindKeys();
        clearStage();
        setProgress('');
        setTray(0);
        renderSetup();
    }

    // ------------------------------------------------------------------
    // answer phase
    // ------------------------------------------------------------------

    function renderAnswer() {
        stopTimer();
        unbindKeys();
        state.phase = 'answer';
        if (isCardFeed(state.drill)) clearStage();
        // The true-count answer depends on decks remaining, which the card
        // feed never needed to compute (speed only cares about the raw count)
        // — capture it now, once, right as the cards stop.
        if (state.drill === 'truecount') state.actualDecks = BJ.Count.getDecksRemaining(state.shoe);

        var p = panel();
        if (!p) return;
        p.innerHTML = '';

        if (isCardFeed(state.drill)) {
            var isTC = state.drill === 'truecount';
            p.appendChild(el('h3', 'cd-question', isTC ? 'What is the TRUE count?' : 'What is the running count?'));
            if (isTC) p.appendChild(el('p', 'cd-hint', 'Check the discard tray for decks remaining, then divide.'));
            if (state.drill === 'manual') {
                var pace = paceSecPerDeck(state.elapsedMs, state.dealt);
                p.appendChild(el('p', 'cd-hint',
                    fmtSec(state.elapsedMs) + ' for ' + state.dealt + ' cards'
                    + (pace ? '  ·  ' + pace.toFixed(1) + 's per deck' : '')));
            }

            var wrap = el('div', 'cd-answer-row');
            var input = el('input', 'cd-input');
            input.type = 'number';
            input.id = 'cd-input';
            input.setAttribute('inputmode', 'numeric');
            input.setAttribute('aria-label', isTC ? 'True count' : 'Running count');
            wrap.appendChild(input);

            var grade = isTC ? gradeTrueCount : (state.drill === 'manual' ? gradeManual : gradeSpeed);
            var submit = el('button', 'button button--primary', 'Check');
            submit.type = 'button';
            submit.addEventListener('click', function () { grade(input.value); });
            input.addEventListener('keydown', function (e) { if (e.key === 'Enter') grade(input.value); });
            wrap.appendChild(submit);

            p.appendChild(wrap);
            input.focus();
        } else {
            p.appendChild(el('h3', 'cd-question', 'How many decks remain?'));
            var grid = el('div', 'cd-deck-grid');
            for (var d = 0.5; d <= 6; d += 0.5) {
                (function (val) {
                    var b = el('button', 'button cd-deck-btn', String(val));
                    b.type = 'button';
                    b.addEventListener('click', function () { gradeEstimation(val); });
                    grid.appendChild(b);
                })(d);
            }
            p.appendChild(grid);
        }
    }

    // ------------------------------------------------------------------
    // result phase
    // ------------------------------------------------------------------

    function gradeSpeed(raw) {
        var given = Number(String(raw).trim());
        if (!Number.isFinite(given)) return;
        var correct = given === state.localCount;
        var g = gm(); if (g) g.recordDrillResult('count-speed', correct);
        renderResult(correct,
            correct ? 'Correct — the count was ' + state.localCount + '.'
                    : 'The count was ' + state.localCount + '. You said ' + given + '.');
    }

    /**
     * Grades a manual countdown on BOTH axes, and says so separately. A run
     * that was accurate but slow and a run that was fast but wrong are
     * different failures with different fixes, and a single verdict would
     * send the player off to practise the wrong one. Accuracy is the gate:
     * pace is only reported as a pass once the count itself is right, because
     * counting a deck quickly and incorrectly is not a partial success.
     */
    function gradeManual(raw) {
        var given = Number(String(raw).trim());
        if (!Number.isFinite(given)) return;

        var accurate = given === state.localCount;
        var pace = paceSecPerDeck(state.elapsedMs, state.dealt);
        var onPace = pace !== null && pace <= PACE_PASS_SEC_PER_DECK;
        var stretch = pace !== null && pace <= PACE_STRETCH_SEC_PER_DECK;
        var clean = accurate && onPace;

        // Shares the 'count-speed' bucket: this measures the same skill the
        // timed feed does — keep a running count over a stream of cards — and
        // splitting it would halve the sample count on both sides of the
        // ladder's Running Count rung for no analytical gain.
        var g = gm(); if (g) g.recordDrillResult('count-speed', accurate);
        var rec = recordCountdownRun(clean, accurate, pace);

        var lines = [];
        lines.push(accurate
            ? 'Count correct (' + state.localCount + ').'
            : 'Count was ' + state.localCount + '. You said ' + given + '.');
        lines.push(fmtSec(state.elapsedMs) + ' for ' + state.dealt + ' cards — '
            + (pace === null ? 'no pace' : pace.toFixed(1) + 's per deck')
            + (stretch ? ' · stretch pace' : (onPace ? ' · on pace' : ' · over the ' + PACE_PASS_SEC_PER_DECK + 's bar')));
        lines.push(clean
            ? 'Clean runs in a row: ' + rec.streak + ' / ' + CLEAN_RUN_TARGET
                + (rec.streak >= CLEAN_RUN_TARGET ? ' — benchmark held.' : '')
            : 'Clean streak reset' + (rec.best ? ' (best ' + rec.best + ').' : '.'));

        renderResult(clean, lines.join('\n'));
    }

    function gradeEstimation(guess) {
        var actual = state.actualDecks;
        var correct = Math.abs(guess - actual) <= DECK_TOLERANCE;
        var g = gm(); if (g) g.recordDrillResult('estimation', correct);
        renderResult(correct,
            (correct ? 'Close enough — ' : 'Off — ') + actual + ' decks remained. You said ' + guess + '.');
    }

    /**
     * Grades the True Count drill. Reuses the same 'count-true' stats bucket
     * the in-Play TC quiz writes to — both measure the identical skill
     * (RC ÷ decks-remaining conversion), so one shared bucket is correct,
     * not an oversight.
     */
    function gradeTrueCount(raw) {
        var given = Number(String(raw).trim());
        if (!Number.isFinite(given)) return;
        var decksRemaining = state.actualDecks;
        var actualTC = BJ.Count.getTrueCount(state.localCount, decksRemaining);
        var correct = Math.abs(given - actualTC) <= TC_TOLERANCE;
        var g = gm(); if (g) g.recordDrillResult('count-true', correct);
        var rc = state.localCount >= 0 ? ('+' + state.localCount) : String(state.localCount);
        renderResult(correct,
            (correct ? 'Close enough — ' : 'Off — ') + 'RC ' + rc + ' ÷ ' + decksRemaining + ' decks ≈ TC ' + actualTC + '. You said ' + given + '.');
    }

    function renderResult(correct, message) {
        state.phase = 'result';
        unbindKeys();
        var p = panel();
        if (!p) return;
        p.innerHTML = '';

        p.appendChild(el('div', 'cd-verdict ' + (correct ? 'cd-verdict--ok' : 'cd-verdict--bad'), correct ? 'Correct' : 'Missed'));
        // `cd-blurb` is pre-wrapped in CSS so a multi-line verdict (the manual
        // countdown reports accuracy, pace and streak as three separate facts)
        // keeps its line breaks instead of running together.
        p.appendChild(el('p', 'cd-blurb cd-blurb--lines', message));

        var again = el('button', 'button button--primary cd-start', 'Again');
        again.type = 'button';
        again.addEventListener('click', run);
        p.appendChild(again);

        var back = el('button', 'button cd-secondary', 'Change settings');
        back.type = 'button';
        back.addEventListener('click', renderSetup);
        p.appendChild(back);
    }

    // ------------------------------------------------------------------
    // public entry / exit
    // ------------------------------------------------------------------

    var DRILL_TITLES = {
        speed: 'Speed Count',
        manual: 'Deck Countdown',
        estimation: 'Deck Estimation',
        truecount: 'True Count'
    };

    var CountDrills = {
        PACE_PASS_SEC_PER_DECK: PACE_PASS_SEC_PER_DECK,
        PACE_STRETCH_SEC_PER_DECK: PACE_STRETCH_SEC_PER_DECK,
        CLEAN_RUN_TARGET: CLEAN_RUN_TARGET,
        getCountdownRecord: getCountdownRecord,

        /** Opens a drill view. `drill` is 'speed' | 'manual' | 'estimation' | 'truecount'. */
        open(drill) {
            state.drill = drill;
            var container = byId('count-drill-container');
            var menu = byId('main-menu');
            var table = byId('blackjack-container');
            if (table) table.style.display = 'none';
            if (menu) menu.style.display = 'none';
            if (container) container.style.display = 'flex';

            var title = byId('cd-title');
            if (title) title.textContent = DRILL_TITLES[drill] || drill;

            renderSetup();
        },

        /** Closes the drill and hands control back to the hub. */
        close() {
            stopTimer();
            unbindKeys();
            clearStage();
            var container = byId('count-drill-container');
            if (container) container.style.display = 'none';
            // 'count' was folded into 'practice' (Counting section) — see hub.js.
            if (BJ.Hub && typeof BJ.Hub.showHub === 'function') BJ.Hub.showHub('practice');
        },

        _state: state // exposed for verification only
    };

    function init() {
        var back = byId('cd-back');
        if (back) back.addEventListener('click', function () { CountDrills.close(); });
    }

    if (typeof window !== 'undefined') window.addEventListener('load', init);

    BJ.CountDrills = CountDrills;

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = CountDrills;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
