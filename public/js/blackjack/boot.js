// ==========================================
// boot.js — app boot sequence (Phase C, plan §1's `boot.js` row)
//
// Mirrors the old monolith's boot sequence (blackjack.js:1106-1126:
// instantiate the game, init audio on `window.load`, fade out the boot
// splash) but wired to the new modular pieces — GameManager, Renderer, the
// UI bindings, and the reference/stats renderers — instead of one
// monolithic class.
//
// Load order in blackjack.html must put this file LAST (after rules.js,
// shoe.js, hand.js, strategy-data.js, count.js, strategy-engine.js,
// persistence.js, game-manager.js, render.js, audio.js, ui-bindings.js,
// reference-render.js, stats-render.js), all `defer`red.
// ==========================================

(function (root) {
    'use strict';

    var BJ = (typeof window !== 'undefined')
        ? (window.BJ = window.BJ || {})
        : (root.BJ = root.BJ || {});

    function boot() {
        if (typeof document === 'undefined') return; // never runs outside a browser

        // 1. Renderer first — it owns no state until wired to a GameManager,
        //    but it needs the DOM element map (BJ.UI) that ui-bindings.js
        //    already built when it loaded.
        var renderer = new BJ.Renderer(BJ.UI || {});

        // 2. GameManager — DOM-free, loads bankroll/settings/stats from
        //    BJ.Storage in its constructor.
        var gameManager = new BJ.GameManager();

        // 3. Wire GameManager's callbacks to the renderer (cards, flips,
        //    pulses, banner, state classes) …
        renderer.attach(gameManager);

        // 4. … then to plain DOM bindings (buttons, panels, disabled
        //    attributes, numeric displays, audio cues).
        if (typeof BJ.bindEvents === 'function') {
            BJ.bindEvents(gameManager, renderer, BJ.AudioEngine);
        }

        // Expose for debugging / the Phase C manual QA pass (plan §6) —
        // not required by any other module.
        BJ.instance = { gameManager: gameManager, renderer: renderer };

        // 5. Strategy Library modal content is static (derived from
        //    strategy-data.js, not per-session state) — render it once at
        //    boot rather than lazily on open.
        if (BJ.ReferenceRender && typeof BJ.ReferenceRender.render === 'function') {
            BJ.ReferenceRender.render();
        }

        // Stats modal content DOES depend on live session/lifetime state,
        // so it's rendered on-open instead (see ui-bindings.js's
        // `#btn-open-stats` handler) — not repeated here.

        // 6. Initialize the (silent until a user gesture) Web Audio engine
        //    so sounds are pre-loaded and ready the moment `toggle-sound`
        //    is checked.
        if (BJ.AudioEngine && typeof BJ.AudioEngine.init === 'function') {
            BJ.AudioEngine.init();
        }

        // 7. Hide the boot splash smoothly, then remove it — ported as-is.
        var bootSplash = document.getElementById('boot-splash');
        if (bootSplash) {
            setTimeout(function () {
                bootSplash.style.opacity = '0';
                bootSplash.style.visibility = 'hidden';
                setTimeout(function () { bootSplash.remove(); }, 500);
            }, 300);
        }
    }

    if (typeof window !== 'undefined') {
        window.addEventListener('load', boot);
    }

    BJ.boot = boot; // exposed for manual re-invocation during QA if ever needed

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = boot;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
