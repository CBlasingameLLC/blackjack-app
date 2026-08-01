// ==========================================
// reference-render.js — Strategy Library, rendered FROM BJ.StrategyData
//
// Every cell is built from `BJ.StrategyData` — the same object
// strategy-engine.js grades against — so the charts are provably in sync
// with what the game actually enforces. Never hand-author cells.
//
// LAYOUT CONTRACT (the "charts must fit the screen" requirement): only ONE
// chart is on screen at a time, behind a segmented switcher, and each table
// is sized to FILL its container rather than overflow it —
// `table-layout: fixed; width:100%; height:100%` lets the browser
// distribute the 10 dealer columns and the N rows into whatever box it's
// given, so neither axis ever scrolls. Labels are therefore kept terse on
// purpose (e.g. '≥ +3', 'Surr') — long strings would force wrapping that a
// height-distributed row can't afford. See blackjack.css §7.
//
// `render(container)` is reusable: the hub's Charts tab and the in-game
// #reference-modal both call it with their own container, each getting an
// independent switcher (state is per-container, held in closures — no
// shared globals, no duplicate ids).
// ==========================================

(function (root) {
    'use strict';

    var BJ = (typeof window !== 'undefined')
        ? (window.BJ = window.BJ || {})
        : (root.BJ = root.BJ || {});

    var StrategyData = BJ.StrategyData || (typeof module !== 'undefined' ? require('./strategy-data.js') : undefined);

    var DEALER_HEADERS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'A'];

    // Full names (tooltips / legend). Kept separate from the terse cell text.
    var PLAY_LABELS = {
        H: 'Hit', S: 'Stand', D: 'Double (else Hit)', Ds: 'Double (else Stand)',
        P: 'Split', R: 'Surrender (else Hit)', buy: 'Buy Insurance'
    };

    // Terse labels for the deviations "Play" column — must fit a narrow
    // fixed-width cell on a 375px phone without wrapping.
    var PLAY_SHORT = {
        H: 'Hit', S: 'Stand', D: 'Double', Ds: 'Dbl/St', P: 'Split', R: 'Surr', buy: 'Buy Ins'
    };

    var LEGEND = [
        { code: 'H', label: 'Hit' },
        { code: 'S', label: 'Stand' },
        { code: 'D', label: 'Double' },
        { code: 'Ds', label: 'Dbl/Stand' },
        { code: 'P', label: 'Split' },
        { code: 'R', label: 'Surrender' }
    ];

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = text;
        return node;
    }

    function actionClass(code) {
        return 'action-' + (code || '').replace(/[^A-Za-z]/g, '');
    }

    /**
     * Builds one 10-wide strategy grid. `rows` is [{ key, label }] indexing
     * into `dataTable` (StrategyData.hard/soft/pair), each value a 10-length
     * array aligned to DEALER_HEADERS.
     */
    function buildGridTable(dataTable, rows) {
        var table = el('table', 'reference-table reference-table-grid');

        var thead = el('thead');
        var headRow = el('tr');
        headRow.appendChild(el('th', 'reference-row-label', ''));
        DEALER_HEADERS.forEach(function (h) { headRow.appendChild(el('th', null, h)); });
        thead.appendChild(headRow);
        table.appendChild(thead);

        var tbody = el('tbody');
        rows.forEach(function (row) {
            var tr = el('tr');
            tr.appendChild(el('th', 'reference-row-label', row.label));
            var plays = dataTable[row.key];
            DEALER_HEADERS.forEach(function (_, idx) {
                var code = plays ? plays[idx] : '';
                var td = el('td', actionClass(code), code);
                if (PLAY_LABELS[code]) td.title = PLAY_LABELS[code];
                tr.appendChild(td);
            });
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        return table;
    }

    function sortedNumericKeys(obj) {
        return Object.keys(obj).map(Number).sort(function (a, b) { return a - b; });
    }

    function buildHardTable() {
        // Trim the trivial rows: hard totals below 8 are always Hit and above
        // 17 are always Stand, so they carry no decision and just make the
        // chart bigger. Show 8–17 (the rows where the dealer upcard matters).
        var rows = sortedNumericKeys(StrategyData.hard)
            .filter(function (t) { return t >= 8 && t <= 17; })
            .map(function (t) { return { key: t, label: String(t) }; });
        return buildGridTable(StrategyData.hard, rows);
    }

    function buildSoftTable() {
        var rows = sortedNumericKeys(StrategyData.soft).map(function (t) { return { key: t, label: 'A,' + (t - 11) }; });
        return buildGridTable(StrategyData.soft, rows);
    }

    function buildPairTable() {
        var rows = sortedNumericKeys(StrategyData.pair).map(function (v) {
            return { key: v, label: v === 11 ? 'A,A' : (v + ',' + v) };
        });
        return buildGridTable(StrategyData.pair, rows);
    }

    /**
     * Surrender is a tiny sparse map ({ total: { dealerValue: true } }) — far
     * too small to justify its own full-height chart tab. Rendered as a
     * compact one-line-per-hand block folded into the Rules panel instead.
     */
    function buildSurrenderBlock() {
        var block = el('div', 'chart-rules__block');
        block.appendChild(el('h4', null, 'Late Surrender (hard totals)'));
        var list = el('div', 'surrender-lines');
        sortedNumericKeys(StrategyData.surrender).forEach(function (total) {
            var dealerVals = sortedNumericKeys(StrategyData.surrender[total])
                .map(function (v) { return v === 11 ? 'A' : String(v); });
            var line = el('div', 'surrender-line');
            line.appendChild(el('span', 'surrender-line__hand', 'Hard ' + total));
            line.appendChild(el('span', 'surrender-line__vs', 'surrender vs ' + dealerVals.join(', ')));
            list.appendChild(line);
        });
        block.appendChild(list);
        return block;
    }

    /**
     * Deviation keys are `<type>_<total>_<dealerValue>` (plus the special
     * `insurance` key). Labels stay terse — the Play column already states
     * the deviated action, so e.g. the surrender indices don't repeat
     * "(surrender index)" in the Hand column.
     */
    function describeDeviationKey(key) {
        if (key === 'insurance') return { hand: 'Insurance', dealer: 'A' };
        var parts = key.split('_');
        var type = parts[0], total = parts[1], dealerValue = Number(parts[2]);
        var dealerLabel = dealerValue === 11 ? 'A' : String(dealerValue);
        var handLabel;
        if (type === 'hard' || type === 'surrender') handLabel = 'Hard ' + total;
        else if (type === 'soft') handLabel = 'Soft ' + total;
        else if (type === 'pair') handLabel = (Number(total) === 11 ? 'A,A' : total + ',' + total);
        else handLabel = key;
        return { hand: handLabel, dealer: dealerLabel };
    }

    function buildDeviationsTable() {
        var table = el('table', 'reference-table reference-table-deviations');
        var thead = el('thead');
        var headRow = el('tr');
        ['Hand', 'Dlr', 'True Count', 'Play'].forEach(function (h) { headRow.appendChild(el('th', null, h)); });
        thead.appendChild(headRow);
        table.appendChild(thead);

        var tbody = el('tbody');
        Object.keys(StrategyData.deviations).forEach(function (key) {
            var entry = StrategyData.deviations[key];
            var d = describeDeviationKey(key);
            var tr = el('tr');
            tr.appendChild(el('td', 'reference-row-label', d.hand));
            tr.appendChild(el('td', null, d.dealer));
            tr.appendChild(el('td', null, '≥ ' + (entry.tc >= 0 ? '+' : '') + entry.tc));
            var playTd = el('td', actionClass(entry.dev), PLAY_SHORT[entry.dev] || entry.dev);
            if (PLAY_LABELS[entry.dev]) playTd.title = PLAY_LABELS[entry.dev];
            tr.appendChild(playTd);
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        return table;
    }

    /** Static reference: the frozen ruleset + the Hi-Lo tag values. */
    function buildRulesPanel() {
        var wrap = el('div', 'chart-rules');

        var rules = el('div', 'chart-rules__block');
        rules.appendChild(el('h4', null, 'The Rules of the Table'));
        var ul = el('ul');
        [
            ['Decks', '6'],
            ['Dealer', 'Stands on Soft 17 (S17)'],
            ['Double After Split', 'Allowed (DAS)'],
            ['Late Surrender', 'Allowed'],
            ['Blackjack Pays', '3:2'],
            ['Penetration', '75%']
        ].forEach(function (pair) {
            var li = el('li');
            li.appendChild(el('strong', null, pair[0] + ': '));
            li.appendChild(document.createTextNode(pair[1]));
            ul.appendChild(li);
        });
        rules.appendChild(ul);
        wrap.appendChild(rules);

        var hilo = el('div', 'chart-rules__block');
        hilo.appendChild(el('h4', null, 'Hi-Lo Counting System'));
        var tags = el('div', 'hilo-tags');
        [
            { v: '+1', cards: '2 3 4 5 6', cls: 'hilo-plus' },
            { v: '0', cards: '7 8 9', cls: 'hilo-zero' },
            { v: '−1', cards: '10 J Q K A', cls: 'hilo-minus' }
        ].forEach(function (t) {
            var row = el('div', 'hilo-row');
            row.appendChild(el('span', 'hilo-val ' + t.cls, t.v));
            row.appendChild(el('span', 'hilo-cards', t.cards));
            tags.appendChild(row);
        });
        hilo.appendChild(tags);
        hilo.appendChild(el('p', 'chart-rules__note', 'True Count = Running Count ÷ Decks Remaining'));
        wrap.appendChild(hilo);

        // Surrender folded in here (was its own oversized tab).
        wrap.appendChild(buildSurrenderBlock());

        return wrap;
    }

    function buildLegend() {
        var legend = el('div', 'chart-legend');
        LEGEND.forEach(function (item) {
            var chip = el('span', 'chart-legend__item');
            chip.appendChild(el('span', 'chart-legend__code ' + actionClass(item.code), item.code));
            chip.appendChild(el('span', 'chart-legend__label', item.label));
            legend.appendChild(chip);
        });
        return legend;
    }

    var CHARTS = [
        { id: 'hard', label: 'Hard', build: buildHardTable, legend: true },
        { id: 'soft', label: 'Soft', build: buildSoftTable, legend: true },
        { id: 'pairs', label: 'Pairs', build: buildPairTable, legend: true },
        { id: 'deviations', label: 'Dev', build: buildDeviationsTable, legend: false },
        // Surrender lives inside the Rules panel now (buildSurrenderBlock).
        { id: 'rules', label: 'Rules', build: buildRulesPanel, legend: false }
    ];

    var ReferenceRender = {
        /**
         * Clears and rebuilds the strategy library inside `container`
         * (defaults to `#reference-modal-body`). Returns false if the
         * container doesn't exist. Idempotent full rebuild — this is a
         * reference view, not a hot render path.
         */
        render(container) {
            if (typeof document === 'undefined') return false;
            container = container || document.getElementById('reference-modal-body');
            if (!container) return false;

            container.innerHTML = '';
            container.classList.add('chart-view');

            var tabs = el('div', 'chart-tabs');
            tabs.setAttribute('role', 'tablist');
            var panels = el('div', 'chart-panels');

            var tabEls = [];
            var panelEls = [];

            function activate(idx) {
                tabEls.forEach(function (t, i) {
                    var on = i === idx;
                    t.classList.toggle('active', on);
                    t.setAttribute('aria-selected', on ? 'true' : 'false');
                });
                panelEls.forEach(function (p, i) {
                    p.classList.toggle('active', i === idx);
                });
            }

            CHARTS.forEach(function (chart, idx) {
                var tab = el('button', 'chart-tab', chart.label);
                tab.setAttribute('role', 'tab');
                tab.setAttribute('aria-label', chart.label + ' chart');
                tab.addEventListener('click', function () { activate(idx); });
                tabs.appendChild(tab);
                tabEls.push(tab);

                var panel = el('div', 'chart-panel');
                panel.setAttribute('role', 'tabpanel');
                panel.appendChild(chart.build());
                if (chart.legend) panel.appendChild(buildLegend());
                panels.appendChild(panel);
                panelEls.push(panel);
            });

            container.appendChild(tabs);
            container.appendChild(panels);
            activate(0);
            return true;
        }
    };

    BJ.ReferenceRender = ReferenceRender;

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = ReferenceRender;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
