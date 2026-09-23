// ==========================================
// edge-render.js — the Edge tab: the bankroll ledger and the EV calculator.
//
// Two views behind one switcher, reusing the same `.chart-tabs` pattern the
// strategy library uses, because they are the same kind of thing: reference
// surfaces you consult rather than drills you run.
//
//   'bankroll' — the real-session ledger, its profit-vs-expectation curve,
//                and the form that adds to it.
//   'ev'       — bet spread, hourly EV, standard deviation, risk of ruin, N0.
//
// All arithmetic lives in ev.js and bankroll.js; this file only builds DOM
// and persists the calculator's inputs. Nothing here recomputes a figure that
// one of those two already defines.
//
// THE CHART DRAWS TWO LINES AND THAT IS THE WHOLE POINT. A profit curve on
// its own is a record of variance for the first several hundred hours of
// anyone's play. The second line — what the game owed you over those same
// hours, from the spread each session was actually played at — is what turns
// the picture from "am I up" into "is my edge real". See bankroll.js.
// ==========================================

(function (root) {
    'use strict';

    var BJ = (typeof window !== 'undefined')
        ? (window.BJ = window.BJ || {})
        : (root.BJ = root.BJ || {});

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = text;
        return node;
    }
    function svgEl(tag, attrs) {
        var node = document.createElementNS('http://www.w3.org/2000/svg', tag);
        Object.keys(attrs || {}).forEach(function (k) { node.setAttribute(k, attrs[k]); });
        return node;
    }
    function Storage() { return BJ.Storage; }

    var state = { view: 'bankroll', container: null };

    // ------------------------------------------------------------------
    // the EV calculator's stored config
    // ------------------------------------------------------------------

    function defaultConfig() {
        return {
            bankroll: 20000,
            unit: 25,
            roundsPerHour: 100,
            decks: 6,
            penetration: 0.75,
            h17: false,
            das: true,
            surrender: true,
            blackjackPays: 1.5,
            // Bet in UNITS, per true count. Mirrors the ramp shape ev.js
            // reads: only the counts where the bet CHANGES need naming.
            ramp: [
                { tc: -99, bet: 1, hands: 1 },
                { tc: 1, bet: 2, hands: 1 },
                { tc: 2, bet: 4, hands: 1 },
                { tc: 3, bet: 6, hands: 2 },
                { tc: 4, bet: 8, hands: 2 },
                { tc: 5, bet: 10, hands: 2 }
            ]
        };
    }

    function getConfig() {
        return Object.assign(defaultConfig(), (Storage() && Storage().get('ev_config', {})) || {});
    }
    function setConfig(cfg) {
        if (Storage()) Storage().set('ev_config', cfg);
        return cfg;
    }

    function evaluate(cfg) {
        return BJ.EV.evaluate({
            bankroll: cfg.bankroll,
            unit: cfg.unit,
            roundsPerHour: cfg.roundsPerHour,
            ramp: cfg.ramp,
            rules: {
                decks: cfg.decks,
                penetration: cfg.penetration,
                h17: cfg.h17,
                das: cfg.das,
                surrender: cfg.surrender,
                blackjackPays: cfg.blackjackPays
            }
        });
    }

    // ------------------------------------------------------------------
    // small shared pieces
    // ------------------------------------------------------------------

    function statTile(label, value, sub, tone) {
        var tile = el('div', 'edge-stat' + (tone ? ' edge-stat--' + tone : ''));
        tile.appendChild(el('span', 'edge-stat__label', label));
        tile.appendChild(el('span', 'edge-stat__value', value));
        if (sub) tile.appendChild(el('span', 'edge-stat__sub', sub));
        return tile;
    }

    function numberRow(label, value, onChange, opts) {
        opts = opts || {};
        var row = el('label', 'edge-row');
        row.appendChild(el('span', 'edge-row__label', label));
        var input = el('input', 'edge-row__input');
        input.type = 'number';
        input.value = String(value);
        if (opts.step) input.step = String(opts.step);
        if (opts.min !== undefined) input.min = String(opts.min);
        input.addEventListener('change', function () {
            var n = Number(input.value);
            // A field left in a state the model cannot use is reverted rather
            // than written: a blank bankroll silently becoming 0 would report
            // certain ruin and look like a bug in the calculator.
            if (!Number.isFinite(n) || (opts.min !== undefined && n < opts.min)) {
                input.value = String(value);
                return;
            }
            onChange(n);
        });
        row.appendChild(input);
        return row;
    }

    function toggleRow(label, options, current, onPick) {
        var row = el('div', 'edge-row');
        row.appendChild(el('span', 'edge-row__label', label));
        var seg = el('div', 'segmented edge-row__seg');
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
    // the EV calculator
    // ------------------------------------------------------------------

    function renderEV(host) {
        var cfg = getConfig();
        var r = evaluate(cfg);
        var money = BJ.Bankroll.formatMoney;
        var redraw = function () { setConfig(cfg); renderEV(host); };

        host.innerHTML = '';

        var tiles = el('div', 'edge-stats');
        tiles.appendChild(statTile('Expected Value', money(Math.round(r.evPerHour * 100), { whole: true, signed: r.evPerHour > 0 }), 'per hour',
            r.evPerHour > 0 ? 'good' : 'bad'));
        tiles.appendChild(statTile('1 Std Deviation', '± ' + money(Math.round(r.sdPerHour * 100), { whole: true }), 'per hour'));
        tiles.appendChild(statTile('Risk of Ruin', (r.riskOfRuin * 100).toFixed(2) + '%', 'this bankroll, forever',
            r.riskOfRuin < 0.05 ? 'good' : (r.riskOfRuin < 0.2 ? '' : 'bad')));
        tiles.appendChild(statTile("Hours 'til N0",
            r.n0Hours === Infinity ? '—' : Math.round(r.n0Hours).toLocaleString('en-US'),
            'before the edge shows'));
        host.appendChild(tiles);

        var cols = el('div', 'edge-cols');

        // --- left: bankroll + rules ---
        var left = el('div', 'edge-col');

        var bankPanel = el('div', 'edge-panel');
        bankPanel.appendChild(el('h4', 'edge-panel__title', 'Bankroll'));
        bankPanel.appendChild(numberRow('Available bankroll', cfg.bankroll, function (v) { cfg.bankroll = v; redraw(); }, { min: 0, step: 500 }));
        bankPanel.appendChild(numberRow('Unit', cfg.unit, function (v) { cfg.unit = v; redraw(); }, { min: 1, step: 5 }));
        bankPanel.appendChild(numberRow('Rounds per hour', cfg.roundsPerHour, function (v) { cfg.roundsPerHour = v; redraw(); }, { min: 1, step: 10 }));
        var spreadRow = el('div', 'edge-row');
        spreadRow.appendChild(el('span', 'edge-row__label', 'Spread'));
        spreadRow.appendChild(el('span', 'edge-row__readout', r.spreadLabel));
        bankPanel.appendChild(spreadRow);
        left.appendChild(bankPanel);

        var rulePanel = el('div', 'edge-panel');
        rulePanel.appendChild(el('h4', 'edge-panel__title', 'Table Rules'));
        rulePanel.appendChild(toggleRow('Decks', [
            { label: '1', value: 1 }, { label: '2', value: 2 }, { label: '6', value: 6 }, { label: '8', value: 8 }
        ], cfg.decks, function (v) { cfg.decks = v; redraw(); }));
        rulePanel.appendChild(toggleRow('Penetration', [
            { label: '60%', value: 0.6 }, { label: '75%', value: 0.75 }, { label: '83%', value: 0.83 }, { label: '90%', value: 0.9 }
        ], cfg.penetration, function (v) { cfg.penetration = v; redraw(); }));
        rulePanel.appendChild(toggleRow('Dealer', [
            { label: 'S17', value: false }, { label: 'H17', value: true }
        ], cfg.h17, function (v) { cfg.h17 = v; redraw(); }));
        rulePanel.appendChild(toggleRow('Blackjack', [
            { label: '3:2', value: 1.5 }, { label: '6:5', value: 1.2 }
        ], cfg.blackjackPays, function (v) { cfg.blackjackPays = v; redraw(); }));
        rulePanel.appendChild(toggleRow('DAS', [
            { label: 'Yes', value: true }, { label: 'No', value: false }
        ], cfg.das, function (v) { cfg.das = v; redraw(); }));
        rulePanel.appendChild(toggleRow('Surrender', [
            { label: 'Yes', value: true }, { label: 'No', value: false }
        ], cfg.surrender, function (v) { cfg.surrender = v; redraw(); }));
        if (cfg.blackjackPays === 1.2) {
            rulePanel.appendChild(el('p', 'edge-panel__warn',
                '6:5 costs about 1.4% — more than every other rule on this panel combined, and more than a Hi-Lo spread usually wins back. This game is not beatable.'));
        }
        left.appendChild(rulePanel);

        // The verdict. Four figures across the top state the situation; this
        // states what to do about it, which is the only part a player can act
        // on. It also fills the foot of this column, which the two panels
        // above leave empty — with the most useful sentence on the screen
        // rather than with air.
        var verdict = el('div', 'edge-panel edge-panel--verdict');
        verdict.appendChild(el('h4', 'edge-panel__title', 'Verdict'));
        var need = r.bankrollForRisk(0.05);
        if (r.evPerHand <= 0) {
            verdict.appendChild(el('p', 'edge-panel__warn',
                'This game has no edge at this spread. No bankroll survives it — ruin is certain given enough rounds. Widen the spread, find better rules, or find deeper penetration.'));
        } else if (r.riskOfRuin <= 0.05) {
            verdict.appendChild(el('p', 'edge-panel__note',
                'Survivable. ' + money(Math.round(cfg.bankroll) * 100, { whole: true })
                + ' against a ' + r.spreadLabel + ' spread puts ruin at ' + (r.riskOfRuin * 100).toFixed(2)
                + '%, and the edge becomes visible after roughly ' + Math.round(r.n0Hours).toLocaleString('en-US') + ' hours.'));
        } else {
            verdict.appendChild(el('p', 'edge-panel__warn',
                'Under-rolled. Ruin sits at ' + (r.riskOfRuin * 100).toFixed(1) + '% at this bankroll.'));
            verdict.appendChild(el('p', 'edge-panel__note',
                'A ' + r.spreadLabel + ' spread at a ' + money(cfg.unit * 100, { whole: true })
                + ' unit needs about ' + money(Math.round(need * 100), { whole: true })
                + ' to bring that under 5%. The other way out is a smaller spread — the bet ramp is the lever, not just the bankroll.'));
        }
        left.appendChild(verdict);
        cols.appendChild(left);

        // --- right: the ramp ---
        var right = el('div', 'edge-col');
        var rampPanel = el('div', 'edge-panel edge-panel--ramp');
        var rampHead = el('div', 'edge-panel__head');
        rampHead.appendChild(el('h4', 'edge-panel__title', 'Bet Spread'));
        rampHead.appendChild(el('span', 'edge-panel__note', 'Bet in units · hands per round'));
        rampPanel.appendChild(rampHead);

        var table = el('table', 'edge-ramp');
        var thead = el('thead');
        var hr = el('tr');
        ['True Count', 'Bet', 'Hands', 'Frequency'].forEach(function (h) { hr.appendChild(el('th', null, h)); });
        thead.appendChild(hr);
        table.appendChild(thead);

        var freqByTc = {};
        r.rows.forEach(function (row) { freqByTc[row.tc] = row.freq; });

        var tbody = el('tbody');
        cfg.ramp.forEach(function (entry, idx) {
            var tr = el('tr');
            var tcLabel = entry.tc <= -99 ? 'Below +1' : (entry.tc >= 0 ? '+' + entry.tc : String(entry.tc));
            var tcTd = el('td', 'edge-ramp__tc' + (entry.tc >= 1 ? ' edge-ramp__tc--hot' : ''), tcLabel);
            tr.appendChild(tcTd);

            var betTd = el('td');
            var betInput = el('input', 'edge-ramp__input');
            betInput.type = 'number';
            betInput.min = '0';
            betInput.value = String(entry.bet);
            betInput.setAttribute('aria-label', 'Bet in units at true count ' + tcLabel);
            betInput.addEventListener('change', function () {
                var n = Number(betInput.value);
                if (!Number.isFinite(n) || n < 0) { betInput.value = String(entry.bet); return; }
                cfg.ramp[idx].bet = n;
                redraw();
            });
            betTd.appendChild(betInput);
            betTd.appendChild(el('span', 'edge-ramp__money', BJ.Bankroll.formatMoney(entry.bet * cfg.unit * 100, { whole: true })));
            tr.appendChild(betTd);

            var handsTd = el('td');
            var seg = el('div', 'segmented edge-ramp__seg');
            [1, 2].forEach(function (h) {
                var b = el('button', 'seg' + ((entry.hands || 1) === h ? ' active' : ''), h + 'x');
                b.type = 'button';
                b.addEventListener('click', function () { cfg.ramp[idx].hands = h; redraw(); });
                seg.appendChild(b);
            });
            handsTd.appendChild(seg);
            tr.appendChild(handsTd);

            // How often this rung of the ramp is actually the one in play —
            // the number that says whether a big top bet is worth anything.
            // A 20-unit bet at a count you see 0.4% of the time is decoration.
            var lo = entry.tc, hi = (cfg.ramp[idx + 1] ? cfg.ramp[idx + 1].tc : 99);
            var freq = 0;
            Object.keys(freqByTc).forEach(function (k) {
                var tc = Number(k);
                if (tc >= lo && tc < hi) freq += freqByTc[k];
            });
            tr.appendChild(el('td', 'edge-ramp__freq', (freq * 100).toFixed(1) + '%'));

            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        rampPanel.appendChild(table);

        rampPanel.appendChild(el('p', 'edge-panel__note',
            'Two hands of a size carry about three quarters the variance of one hand of twice that size, for the same money on the felt.'));
        right.appendChild(rampPanel);

        var sumPanel = el('div', 'edge-panel');
        sumPanel.appendChild(el('h4', 'edge-panel__title', 'Summary'));
        var grid = el('div', 'edge-summary');
        [
            ['Average bet', money(Math.round(r.avgBet * 100))],
            ['Player edge', (r.playerEdge * 100).toFixed(3) + '%'],
            ['EV per hand', money(Math.round(r.evPerHand * 100))],
            ['Base edge (TC 0)', (r.baseEdge * 100).toFixed(2) + '%']
        ].forEach(function (pair) {
            var cell = el('div', 'edge-summary__cell');
            cell.appendChild(el('span', 'edge-summary__label', pair[0]));
            cell.appendChild(el('span', 'edge-summary__value', pair[1]));
            grid.appendChild(cell);
        });
        sumPanel.appendChild(grid);
        right.appendChild(sumPanel);
        cols.appendChild(right);

        host.appendChild(cols);
    }

    // ------------------------------------------------------------------
    // the bankroll ledger
    // ------------------------------------------------------------------

    /**
     * Profit against expectation, plotted on HOURS PLAYED. Drawn as inline
     * SVG with an explicit viewBox so it scales to whatever box the grid
     * gives it without a resize listener or a canvas to keep in sync.
     */
    function buildCurve(points) {
        var W = 640, H = 260, PAD_L = 52, PAD_R = 12, PAD_T = 12, PAD_B = 28;
        var svg = svgEl('svg', {
            class: 'edge-chart', viewBox: '0 0 ' + W + ' ' + H,
            preserveAspectRatio: 'none', role: 'img',
            'aria-label': 'Cumulative profit against expected value, by hours played'
        });

        var maxH = points[points.length - 1].hours || 1;
        var vals = [];
        points.forEach(function (p) { vals.push(p.profitCents, p.expectedCents); });
        var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
        // Always include zero: a chart whose axis starts at the lowest point
        // makes a losing record look like a rising line.
        lo = Math.min(lo, 0); hi = Math.max(hi, 0);
        if (hi === lo) { hi = lo + 10000; }
        var pad = (hi - lo) * 0.08;
        lo -= pad; hi += pad;

        var x = function (h) { return PAD_L + (h / maxH) * (W - PAD_L - PAD_R); };
        var y = function (c) { return PAD_T + (1 - (c - lo) / (hi - lo)) * (H - PAD_T - PAD_B); };

        // zero line
        svg.appendChild(svgEl('line', {
            x1: PAD_L, x2: W - PAD_R, y1: y(0), y2: y(0),
            class: 'edge-chart__zero'
        }));

        var path = function (key, cls) {
            var d = points.map(function (p, i) {
                return (i === 0 ? 'M' : 'L') + x(p.hours).toFixed(2) + ' ' + y(p[key]).toFixed(2);
            }).join(' ');
            return svgEl('path', { d: d, class: cls, fill: 'none' });
        };
        svg.appendChild(path('expectedCents', 'edge-chart__ev'));
        svg.appendChild(path('profitCents', 'edge-chart__profit'));

        // axis labels
        var money = BJ.Bankroll.formatMoney;
        [hi - pad, 0, lo + pad].forEach(function (v) {
            var t = svgEl('text', { x: PAD_L - 6, y: y(v) + 3, class: 'edge-chart__tick', 'text-anchor': 'end' });
            t.textContent = money(Math.round(v), { whole: true });
            svg.appendChild(t);
        });
        var hx = svgEl('text', { x: W - PAD_R, y: H - 8, class: 'edge-chart__tick', 'text-anchor': 'end' });
        hx.textContent = Math.round(maxH) + 'h';
        svg.appendChild(hx);

        return svg;
    }

    function buildSessionForm(onAdded) {
        var form = el('form', 'edge-form');
        var fields = [
            { k: 'date', label: 'Date', type: 'date', value: new Date().toISOString().slice(0, 10) },
            { k: 'venue', label: 'Venue', type: 'text', value: '' },
            { k: 'hours', label: 'Hours', type: 'number', value: '', step: '0.25' },
            { k: 'buyIn', label: 'Buy-in', type: 'text', value: '' },
            { k: 'cashOut', label: 'Cash-out', type: 'text', value: '' },
            { k: 'unit', label: 'Unit', type: 'text', value: '25' },
            { k: 'spread', label: 'Spread', type: 'text', value: '' },
            { k: 'evPerHour', label: 'EV/hr', type: 'text', value: '' }
        ];
        var inputs = {};
        fields.forEach(function (f) {
            var wrap = el('label', 'edge-form__field');
            wrap.appendChild(el('span', 'edge-form__label', f.label));
            var input = el('input', 'edge-form__input');
            input.type = f.type;
            input.value = f.value;
            if (f.step) input.step = f.step;
            inputs[f.k] = input;
            wrap.appendChild(input);
            form.appendChild(wrap);
        });

        // Pre-fills EV/hr from the calculator, because the whole reason the
        // expected line means anything is that it came from the spread the
        // session was played at — and retyping it every time is how it ends
        // up blank and the second line ends up flat.
        var prefill = el('button', 'button edge-form__btn', 'Use calculator EV');
        prefill.type = 'button';
        prefill.addEventListener('click', function () {
            var r = evaluate(getConfig());
            inputs.evPerHour.value = (Math.round(r.evPerHour * 100) / 100).toFixed(2);
            inputs.unit.value = String(getConfig().unit);
            inputs.spread.value = r.spreadLabel;
        });
        form.appendChild(prefill);

        var submit = el('button', 'button button--primary edge-form__btn', 'Log session');
        submit.type = 'submit';
        form.appendChild(submit);

        var err = el('p', 'edge-form__error');
        form.appendChild(err);

        form.addEventListener('submit', function (e) {
            e.preventDefault();
            var input = {};
            Object.keys(inputs).forEach(function (k) { input[k] = inputs[k].value; });
            var res = BJ.Bankroll.addSession(input);
            if (res.error) { err.textContent = res.error; return; }
            err.textContent = '';
            onAdded();
        });
        return form;
    }

    function renderBankroll(host) {
        var B = BJ.Bankroll;
        var money = B.formatMoney;
        var all = B.getSessions();
        var pts = B.curve(all);
        var s = B.summary(all);
        var redraw = function () { renderBankroll(host); };

        host.innerHTML = '';

        var top = el('div', 'edge-bank-top');

        var chartWrap = el('div', 'edge-panel edge-panel--chart');
        var chartHead = el('div', 'edge-panel__head');
        chartHead.appendChild(el('h4', 'edge-panel__title', 'Profit vs Expectation'));
        var key = el('div', 'edge-chart__key');
        var k1 = el('span', 'edge-chart__keyitem edge-chart__keyitem--profit', 'Actual');
        var k2 = el('span', 'edge-chart__keyitem edge-chart__keyitem--ev', 'Expected');
        key.appendChild(k1); key.appendChild(k2);
        chartHead.appendChild(key);
        chartWrap.appendChild(chartHead);

        if (all.length === 0) {
            // Named, not left blank: an empty chart area with no explanation
            // reads as a broken panel rather than as an empty ledger.
            chartWrap.appendChild(el('p', 'edge-empty',
                'No sessions logged. Add one below and the curve starts — actual profit against what the game owed you over the same hours.'));
        } else {
            chartWrap.appendChild(buildCurve(pts));
        }
        top.appendChild(chartWrap);

        var tiles = el('div', 'edge-stats edge-stats--bank');
        tiles.appendChild(statTile('Total Profit', money(s.profitCents, { whole: true, signed: true }),
            s.sessions + ' session' + (s.sessions === 1 ? '' : 's'),
            s.profitCents > 0 ? 'good' : (s.profitCents < 0 ? 'bad' : '')));
        tiles.appendChild(statTile('Hours', s.hours.toLocaleString('en-US'),
            s.perHourCents === null ? 'no hours yet' : money(s.perHourCents, { whole: true, signed: true }) + ' / hour'));
        tiles.appendChild(statTile('Expected', money(s.expectedCents, { whole: true, signed: true }),
            s.expectedPerHourCents === null ? '—' : money(s.expectedPerHourCents, { whole: true, signed: true }) + ' / hour'));
        // Luck is the gap between the two lines, named outright. Over a few
        // hundred hours this is usually the largest number on the screen, and
        // saying so is the most useful thing this panel does.
        tiles.appendChild(statTile('Luck', money(s.luckCents, { whole: true, signed: true }),
            'actual minus expected', s.luckCents > 0 ? 'good' : (s.luckCents < 0 ? 'bad' : '')));
        top.appendChild(tiles);
        host.appendChild(top);

        var bottom = el('div', 'edge-bank-bottom');

        var listPanel = el('div', 'edge-panel edge-panel--list');
        listPanel.appendChild(el('h4', 'edge-panel__title', 'Sessions'));
        if (all.length === 0) {
            listPanel.appendChild(el('p', 'edge-empty', 'Nothing logged yet.'));
        } else {
            var list = el('div', 'edge-sessions');
            all.slice().reverse().forEach(function (sess) {
                var row = el('div', 'edge-session');
                var main = el('div', 'edge-session__main');
                main.appendChild(el('span', 'edge-session__venue', sess.venue));
                main.appendChild(el('span', 'edge-session__meta',
                    sess.date + ' · ' + sess.game + ' · ' + sess.hours + 'h'
                    + (sess.spread ? ' · ' + sess.spread : '')));
                row.appendChild(main);

                var right = el('div', 'edge-session__right');
                right.appendChild(el('span', 'edge-session__profit '
                    + (sess.profitCents >= 0 ? 'is-up' : 'is-down'),
                    money(sess.profitCents, { whole: true, signed: true })));
                right.appendChild(el('span', 'edge-session__ev',
                    'EV ' + money(Math.round((sess.evPerHourCents || 0) * sess.hours), { whole: true, signed: true })));
                row.appendChild(right);

                var del = el('button', 'edge-session__del', '×');
                del.type = 'button';
                del.setAttribute('aria-label', 'Delete session at ' + sess.venue + ' on ' + sess.date);
                del.addEventListener('click', function () {
                    B.deleteSession(sess.id);
                    redraw();
                });
                row.appendChild(del);

                list.appendChild(row);
            });
            listPanel.appendChild(list);
        }
        bottom.appendChild(listPanel);

        var formPanel = el('div', 'edge-panel edge-panel--form');
        formPanel.appendChild(el('h4', 'edge-panel__title', 'Log a session'));
        formPanel.appendChild(buildSessionForm(redraw));
        bottom.appendChild(formPanel);

        host.appendChild(bottom);
    }

    // ------------------------------------------------------------------
    // the switcher
    // ------------------------------------------------------------------

    var VIEWS = [
        { id: 'bankroll', label: 'Bankroll', render: renderBankroll },
        { id: 'ev', label: 'EV Calculator', render: renderEV }
    ];

    var EdgeRender = {
        render(container) {
            if (typeof document === 'undefined') return false;
            container = container || document.getElementById('hub-edge-body');
            if (!container || !BJ.EV || !BJ.Bankroll) return false;
            state.container = container;

            container.innerHTML = '';
            container.classList.add('chart-view', 'edge-view');

            var tabs = el('div', 'chart-tabs');
            tabs.setAttribute('role', 'tablist');
            var body = el('div', 'edge-body');

            var tabEls = [];
            function activate(idx) {
                state.view = VIEWS[idx].id;
                tabEls.forEach(function (t, i) {
                    t.classList.toggle('active', i === idx);
                    t.setAttribute('aria-selected', i === idx ? 'true' : 'false');
                });
                VIEWS[idx].render(body);
            }

            VIEWS.forEach(function (v, idx) {
                var tab = el('button', 'chart-tab', v.label);
                tab.type = 'button';
                tab.setAttribute('role', 'tab');
                tab.addEventListener('click', function () { activate(idx); });
                tabs.appendChild(tab);
                tabEls.push(tab);
            });

            container.appendChild(tabs);
            container.appendChild(body);

            var start = VIEWS.map(function (v) { return v.id; }).indexOf(state.view);
            activate(start > -1 ? start : 0);
            return true;
        }
    };

    BJ.EdgeRender = EdgeRender;

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = EdgeRender;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
