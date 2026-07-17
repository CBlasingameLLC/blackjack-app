// ==========================================
// count-drills.js — the two standalone counting drills (Count tab):
//
//   'speed'      — flash N cards at a set rate, then ask for the running count.
//   'estimation' — bury a random slice of the shoe, show the discard tray,
//                  then ask how many decks remain (graded to ±0.5).
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
    var DECK_TOLERANCE = 0.5; // half-deck accuracy is the real-world standard

    var state = {
        drill: null,        // 'speed' | 'estimation'
        phase: 'setup',     // 'setup' | 'running' | 'answer' | 'result'
        shoe: null,
        localCount: 0,
        dealt: 0,
        target: 0,
        timer: null,
        actualDecks: 0
    };

    function gm() { return BJ.instance && BJ.instance.gameManager; }
    function settings() { var g = gm(); return g ? g.getSettings() : {}; }

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

    // ------------------------------------------------------------------
    // setup phase
    // ------------------------------------------------------------------

    function renderSetup() {
        state.phase = 'setup';
        clearStage();
        setProgress('');
        setTray(0);

        var p = panel();
        if (!p) return;
        p.innerHTML = '';

        if (state.drill === 'speed') {
            p.appendChild(el('p', 'cd-blurb', 'Cards flash one at a time. Keep the running count, then enter it at the end.'));

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

    function run() {
        stopTimer();
        state.shoe = freshShoe();
        state.localCount = 0;
        state.dealt = 0;
        state.phase = 'running';

        var p = panel();
        if (p) p.innerHTML = '';

        if (state.drill === 'speed') {
            var s = settings();
            state.target = s.speedCountSize || 52;
            var rate = s.speedCountRate || 2;
            var interval = Math.max(120, Math.round(1000 / rate));
            flashNext(interval);
        } else {
            // Estimation: bury a random slice (20%–85% penetration), then ask.
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
    }

    function flashNext(interval) {
        if (state.dealt >= state.target) { renderAnswer(); return; }

        var card = state.shoe.draw();
        if (!card) { renderAnswer(); return; }

        state.localCount += BJ.Count.tagOf(card);
        state.dealt++;

        var slot = byId('cd-card-slot');
        if (slot) {
            slot.innerHTML = '';
            var node = BJ.buildCardEl(card, false);
            // `cd-flash` opts out of the deal-in transition: these are flash
            // cards, and a 350ms fade would blur straight into the next one
            // at 3–5 cards/sec (and would never appear at all if rAF is
            // throttled, since .dealt is added on the next frame).
            node.classList.add('dealt', 'cd-flash');
            slot.appendChild(node);
        }

        setProgress(state.dealt + ' / ' + state.target);
        setTray(state.dealt / (BJ.Rules ? BJ.Rules.decks * 52 : 312));

        state.timer = setTimeout(function () { flashNext(interval); }, interval);
    }

    // ------------------------------------------------------------------
    // answer phase
    // ------------------------------------------------------------------

    function renderAnswer() {
        stopTimer();
        state.phase = 'answer';
        if (state.drill === 'speed') clearStage();

        var p = panel();
        if (!p) return;
        p.innerHTML = '';

        if (state.drill === 'speed') {
            p.appendChild(el('h3', 'cd-question', 'What is the running count?'));

            var wrap = el('div', 'cd-answer-row');
            var input = el('input', 'cd-input');
            input.type = 'number';
            input.id = 'cd-input';
            input.setAttribute('inputmode', 'numeric');
            input.setAttribute('aria-label', 'Running count');
            wrap.appendChild(input);

            var submit = el('button', 'button button--primary', 'Check');
            submit.type = 'button';
            submit.addEventListener('click', function () { gradeSpeed(input.value); });
            input.addEventListener('keydown', function (e) { if (e.key === 'Enter') gradeSpeed(input.value); });
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

    function gradeEstimation(guess) {
        var actual = state.actualDecks;
        var correct = Math.abs(guess - actual) <= DECK_TOLERANCE;
        var g = gm(); if (g) g.recordDrillResult('estimation', correct);
        renderResult(correct,
            (correct ? 'Close enough — ' : 'Off — ') + actual + ' decks remained. You said ' + guess + '.');
    }

    function renderResult(correct, message) {
        state.phase = 'result';
        var p = panel();
        if (!p) return;
        p.innerHTML = '';

        p.appendChild(el('div', 'cd-verdict ' + (correct ? 'cd-verdict--ok' : 'cd-verdict--bad'), correct ? 'Correct' : 'Missed'));
        p.appendChild(el('p', 'cd-blurb', message));

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

    var CountDrills = {
        /** Opens a drill view. `drill` is 'speed' | 'estimation'. */
        open(drill) {
            state.drill = drill;
            var container = byId('count-drill-container');
            var menu = byId('main-menu');
            var table = byId('blackjack-container');
            if (table) table.style.display = 'none';
            if (menu) menu.style.display = 'none';
            if (container) container.style.display = 'flex';

            var title = byId('cd-title');
            if (title) title.textContent = drill === 'speed' ? 'Speed Count' : 'Deck Estimation';

            renderSetup();
        },

        /** Closes the drill and hands control back to the hub. */
        close() {
            stopTimer();
            clearStage();
            var container = byId('count-drill-container');
            if (container) container.style.display = 'none';
            if (BJ.Hub && typeof BJ.Hub.showHub === 'function') BJ.Hub.showHub('count');
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
