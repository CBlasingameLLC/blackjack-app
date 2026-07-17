// ==========================================
// hub.js — the front-page hub: bottom-nav tab state + routing ONLY.
//
// Deliberately owns NO game logic. Mode tiles are static markup in
// index.html carrying the existing #btn-mode-* ids, so ui-bindings.js's
// BJ.UI map (built by id at ITS module-load time) still wires them to
// gm.setGameMode(...) exactly as before — generating those buttons here
// would have silently broken every drill. The Play CTA is likewise just
// #btn-mode-testout wearing a different hat.
//
// LOAD ORDER: this file must come AFTER boot.js. Both init on window
// 'load' and listeners fire in registration order, so loading last is what
// guarantees BJ.instance already exists when init() reads settings.
//
// What this file does own:
//   - which hub tab is active (.hub-tab / .hub-panel)
//   - lazily rendering the Charts + Stats panels via the existing
//     BJ.ReferenceRender / BJ.StatsRender renderers
//   - the Graded|Casual segmented control (writes settings.casualMode)
//   - the table screen's gear -> back to the hub's Settings tab
// ==========================================

(function (root) {
    'use strict';

    var BJ = (typeof window !== 'undefined')
        ? (window.BJ = window.BJ || {})
        : (root.BJ = root.BJ || {});

    function byId(id) { return document.getElementById(id); }
    function all(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

    var state = { tab: 'drills', chartsRendered: false };

    function gm() { return BJ.instance && BJ.instance.gameManager; }

    // --- tabs ---------------------------------------------------------

    function selectTab(name) {
        state.tab = name;

        all('.hub-tab').forEach(function (t) {
            var on = t.dataset.tab === name;
            t.classList.toggle('active', on);
            t.setAttribute('aria-current', on ? 'page' : 'false');
        });
        all('.hub-panel').forEach(function (p) {
            p.classList.toggle('active', p.dataset.panel === name);
        });

        // Reflects the live mistake log, which any drill/session can grow.
        if (name === 'drills') syncTargetedTile();

        // Charts are static once built — render once and keep.
        if (name === 'charts' && !state.chartsRendered) {
            if (BJ.ReferenceRender && typeof BJ.ReferenceRender.render === 'function') {
                state.chartsRendered = !!BJ.ReferenceRender.render(byId('hub-charts-body'));
            }
        }
        // Stats reflect live persisted state — always re-render on open.
        if (name === 'stats') {
            if (BJ.StatsRender && typeof BJ.StatsRender.render === 'function') {
                BJ.StatsRender.render(byId('hub-stats-body'));
            }
        }
    }

    /** Leaves the table and returns to the hub, optionally on a given tab. */
    function showHub(tab) {
        var container = byId('blackjack-container');
        var drills = byId('count-drill-container');
        var menu = byId('main-menu');
        if (container) container.style.display = 'none';
        if (drills) drills.style.display = 'none';
        if (menu) menu.style.display = 'flex';
        if (tab) selectTab(tab);
    }

    // --- Graded | Casual ----------------------------------------------

    function syncPlayMode(isCasual) {
        all('#play-mode-toggle .seg').forEach(function (s) {
            s.classList.toggle('active', (s.dataset.casual === 'true') === !!isCasual);
        });
    }

    function setCasual(isCasual) {
        var g = gm();
        if (g) g.updateSettings({ casualMode: !!isCasual });
        syncPlayMode(isCasual);
    }

    // --- training options (drill style / count checks) -----------------

    function syncSegmented(selector, attr, value) {
        all(selector + ' .seg').forEach(function (s) {
            s.classList.toggle('active', s.dataset[attr] === String(value));
        });
    }

    function syncTrainingOptions() {
        var g = gm();
        var s = g ? g.getSettings() : {};
        syncSegmented('#drill-style-toggle', 'style', s.drillStyle || 'flash');
        syncSegmented('#count-prompt-toggle', 'prompt', s.countPrompt || 'off');
        var interval = byId('count-interval');
        if (interval && s.countPromptInterval) interval.value = String(s.countPromptInterval);
    }

    /**
     * Targeted Practice has nothing to serve until you've actually missed
     * something, so the tile reports its own readiness rather than quietly
     * dealing random hands (which is what the engine falls back to).
     */
    function syncTargetedTile() {
        var tile = byId('btn-mode-targeted');
        if (!tile || !BJ.Storage) return;
        var eligible = BJ.Storage.getMistakeLog().filter(function (e) {
            return e && e.handType && e.handTotal != null && e.dealerUpcard != null;
        }).length;

        tile.disabled = eligible === 0;
        tile.classList.toggle('tile--soon', eligible === 0);
        var sub = tile.querySelector('.tile__sub');
        if (sub) {
            sub.textContent = eligible === 0
                ? 'No misses logged yet'
                : eligible + ' logged miss' + (eligible === 1 ? '' : 'es');
        }
    }

    // --- init ---------------------------------------------------------

    function init() {
        all('.hub-tab').forEach(function (t) {
            t.addEventListener('click', function () { selectTab(t.dataset.tab); });
        });

        all('#play-mode-toggle .seg').forEach(function (s) {
            s.addEventListener('click', function () { setCasual(s.dataset.casual === 'true'); });
        });

        // Drill style: flash cards vs. playing hands out to completion.
        all('#drill-style-toggle .seg').forEach(function (s) {
            s.addEventListener('click', function () {
                var g = gm();
                if (g) g.updateSettings({ drillStyle: s.dataset.style });
                syncTrainingOptions();
            });
        });

        // Count checks during Play.
        all('#count-prompt-toggle .seg').forEach(function (s) {
            s.addEventListener('click', function () {
                var g = gm();
                if (g) g.updateSettings({ countPrompt: s.dataset.prompt });
                syncTrainingOptions();
            });
        });
        var interval = byId('count-interval');
        if (interval) {
            interval.addEventListener('change', function () {
                var g = gm();
                if (g) g.updateSettings({ countPromptInterval: parseInt(interval.value, 10) || 3 });
            });
        }

        // Standalone count drills — their own screen, not a game mode.
        var speed = byId('btn-drill-speed');
        if (speed) speed.addEventListener('click', function () { if (BJ.CountDrills) BJ.CountDrills.open('speed'); });
        var estim = byId('btn-drill-estimation');
        if (estim) estim.addEventListener('click', function () { if (BJ.CountDrills) BJ.CountDrills.open('estimation'); });

        // The settings dropdown that used to live on the table screen is now
        // the hub's Settings tab (one set of control ids, no duplicates), so
        // the gear routes there instead. ui-bindings.js's own gear handler is
        // guarded on #settings-menu existing, which it no longer does — so
        // this is the only listener on it.
        var gear = byId('btn-settings');
        if (gear) gear.addEventListener('click', function () { showHub('settings'); });

        var g = gm();
        syncPlayMode(g ? !!g.getSettings().casualMode : false);
        syncTrainingOptions();

        selectTab('drills');
    }

    if (typeof window !== 'undefined') window.addEventListener('load', init);

    BJ.Hub = { selectTab: selectTab, showHub: showHub };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = BJ.Hub;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
