// ==========================================
// ui-bindings.js — DOM lookups + event wiring only, NO game logic
// (Phase C, plan §1's `ui-bindings.js` row + bug fixes #10/#12)
//
// DIVISION OF LABOR (see render.js's header for the other half):
//   ui-bindings.js  -> element lookups (`BJ.UI`), button/checkbox wiring,
//                       panel show/hide driven by state, disabled-attribute
//                       wiring, plain numeric/text display (bankroll/bet/
//                       true count/session stats), the single fullscreen
//                       handler, accessibility aria-labels, and GameManager
//                       -> AudioEngine sound-cue wiring.
//   render.js       -> everything animated (cards, flips, pulses, chip
//                       toss visuals, banner fade).
//
// Every lookup in `UI` degrades to `null` for elements that don't exist yet
// (this file is written against blackjack.html BEFORE the HTML phase adds
// `#btn-surrender`, `#stats-modal`, `#btn-mode-hard`, `#btn-mode-surrender`,
// etc — see the inventory comment at the bottom). Every single usage below
// is `if (el) ...` guarded so this file never throws against the current,
// not-yet-updated markup.
//
// Bug #10 fix: exactly ONE fullscreen listener lives here (the old
// monolith had a duplicate inline <script> copy in blackjack.html AND this
// one — the HTML phase deletes the inline copy, this is the sole survivor,
// ported with its cross-vendor fallback intact).
// Bug #12 fix: buttons are gated via the native `disabled` attribute here,
// never `style.opacity`/`style.pointerEvents` (the old monolith's
// `updateButtons()` at blackjack.js:750-765).
// ==========================================

(function (root) {
    'use strict';

    var BJ = (typeof window !== 'undefined')
        ? (window.BJ = window.BJ || {})
        : (root.BJ = root.BJ || {});

    function byId(id) {
        return (typeof document !== 'undefined') ? document.getElementById(id) : null;
    }

    // ------------------------------------------------------------------
    // BJ.UI — element lookup map. Ported list from the old monolith
    // (blackjack.js:217-268), plus new ids assumed by the plan (surrender
    // button, stats modal, hard/surrender mode buttons — see bottom
    // inventory). `chipBtns` stays a live NodeList via querySelectorAll,
    // same as before.
    // ------------------------------------------------------------------
    var UI = {
        // shell / menu
        chipContainer: byId('chip-container'),
        mainMenu: byId('main-menu'),
        blackjackContainer: byId('blackjack-container'),
        btnReturnMenu: byId('btn-return-menu'),

        // settings — individual toggles are no longer looked up by id; every
        // settings control now carries [data-setting] and is wired by the
        // generic binder below (so the in-game overlay and the hub Settings
        // tab share state without duplicate ids).
        btnSettings: byId('btn-settings'),
        settingsMenu: byId('settings-menu'),
        btnCloseSettings: byId('btn-close-settings'),

        // fullscreen
        btnFullscreen: byId('btn-fullscreen'),

        // mode buttons
        btnModeTestout: byId('btn-mode-testout'),
        btnModePairs: byId('btn-mode-pairs'),
        btnModeSoft: byId('btn-mode-soft'),
        btnModeDeviations: byId('btn-mode-deviations'),
        btnModeHard: byId('btn-mode-hard'),           // NEW — drill mode §3.3
        btnModeSurrender: byId('btn-mode-surrender'), // NEW — drill mode §3.3
        btnModeTargeted: byId('btn-mode-targeted'),   // NEW — Phase 3, drills your logged misses

        // reference modal (bug #11 — content rendered by reference-render.js)
        referenceModal: byId('reference-modal'),
        referenceModalBody: byId('reference-modal-body'), // NEW — data-driven container
        btnOpenReference: byId('btn-open-reference'),
        btnCloseReference: byId('btn-close-reference'),

        // stats modal (NEW — plan §3.4, rendered by stats-render.js)
        statsModal: byId('stats-modal'),
        statsModalBody: byId('stats-modal-body'),
        btnOpenStats: byId('btn-open-stats'),
        btnCloseStats: byId('btn-close-stats'),

        // insurance
        insuranceControls: byId('insurance-controls'),
        btnBuyInsurance: byId('btn-buy-insurance'),
        btnPassInsurance: byId('btn-pass-insurance'),
        insuranceArea: byId('insurance-bet-area'),
        insuranceStack: byId('insurance-chip-stack'),

        // table
        dealerCards: byId('dealer-cards'),
        playerCards: byId('player-cards'),
        dealerScore: byId('dealer-score'),
        playerScore: byId('player-score'),
        discardTray: byId('discard-tray'),          // NEW — deck-estimation aid

        // count quiz overlay (NEW — settings.countPrompt)
        countPrompt: byId('count-prompt'),
        countPromptTitle: byId('count-prompt-title'),
        countPromptInput: byId('count-prompt-input'),
        countPromptSubmit: byId('count-prompt-submit'),

        // action dashboard
        btnDeal: byId('btn-deal'),
        btnHit: byId('btn-hit'),
        btnStand: byId('btn-stand'),
        btnDouble: byId('btn-double'),
        btnSplit: byId('btn-split'),
        btnSurrender: byId('btn-surrender'), // NEW — plan §3.1

        // betting
        betControls: byId('bet-controls'),
        gameControls: byId('game-controls'),
        tableBetArea: byId('table-bet-area'),
        chipStack: byId('chip-stack'),
        tableBetBubble: byId('table-bet-bubble'),
        chipBtns: (typeof document !== 'undefined') ? document.querySelectorAll('.chip') : [],

        // feedback / status
        gameMessage: byId('game-message'),
        apFeedback: byId('ap-feedback'),
        correctCue: byId('correct-cue'),            // NEW — right-answer pop
        sessionStats: byId('session-stats'),

        // top bar readouts
        uiBankroll: byId('ui-bankroll'),
        uiBet: byId('ui-bet'),
        uiTrueCount: byId('ui-truecount')
    };

    BJ.UI = UI;

    // ------------------------------------------------------------------
    // small display helpers (plain text — not animation, so they live
    // here rather than in render.js)
    // ------------------------------------------------------------------
    function fmtMoney(n) { return '$' + Number(n || 0).toLocaleString(); }

    function renderFinance(gm) {
        var settings = gm.getSettings();
        if (UI.uiBankroll) UI.uiBankroll.textContent = settings.freeplay ? 'FREEPLAY' : fmtMoney(gm.getBankroll());
        if (UI.uiBet) UI.uiBet.textContent = settings.freeplay ? 'FREEPLAY' : fmtMoney(gm.getSnapshot().currentBet);
    }

    function renderBetBubble(currentBet) {
        if (!UI.tableBetArea) return;
        if (currentBet > 0) {
            if (UI.tableBetBubble) UI.tableBetBubble.textContent = fmtMoney(currentBet);
            UI.tableBetArea.style.display = 'flex';
        } else {
            UI.tableBetArea.style.display = 'none';
        }
    }

    // Last count payload, kept so the readout can be re-rendered when the
    // settings change (e.g. toggling the TC quiz on/off) without waiting for
    // the next card.
    var lastCountInfo = { runningCount: 0, trueCount: 0, decksRemaining: 6 };

    /**
     * `settings.countPrompt === 'true'` means the player is being quizzed on
     * the TRUE count — so showing it here would hand them the answer, and
     * would also remove any need to estimate the decks remaining. Mask it.
     */
    function renderCount(countInfo, settings) {
        if (countInfo) lastCountInfo = countInfo;
        if (!UI.uiTrueCount) return;

        if (settings && settings.countPrompt === 'true') {
            UI.uiTrueCount.textContent = '??';
            UI.uiTrueCount.style.color = 'var(--text-lo)';
            return;
        }

        var tc = lastCountInfo.trueCount;
        UI.uiTrueCount.textContent = tc > 0 ? ('+' + tc) : String(tc);
        UI.uiTrueCount.style.color = tc >= 2 ? '#2ecc71' : (tc <= -1 ? '#e74c3c' : '#f1c40f');
    }

    function renderSessionStats(payload) {
        if (!UI.sessionStats || !payload) return;
        var accuracy = payload.sessionAccuracy;
        if (accuracy === null || accuracy === undefined) {
            UI.sessionStats.textContent = 'Accuracy: --';
            UI.sessionStats.style.color = 'var(--accent-color)';
            return;
        }
        UI.sessionStats.textContent = 'Accuracy: ' + accuracy + '%';
        UI.sessionStats.style.color = accuracy === 100 ? '#2ecc71' : (accuracy > 85 ? '#f1c40f' : '#e74c3c');
    }

    // ------------------------------------------------------------------
    // panel show/hide + disabled-attribute wiring, driven by state
    // ------------------------------------------------------------------
    function showPanel(el, show) {
        if (!el) return;
        el.style.display = show ? (el.dataset && el.dataset.displayMode ? el.dataset.displayMode : 'flex') : 'none';
    }

    function setDisabled(el, disabled) {
        if (!el) return;
        if (disabled) el.setAttribute('disabled', 'disabled');
        else el.removeAttribute('disabled');
    }

    /**
     * Recomputes which action buttons should be enabled for the currently
     * active hand. Mirrors game-manager.js's internal `_canSurrender`/
     * `_evaluatePlay` eligibility checks (cards.length, isPair, bankroll,
     * gameMode) closely enough for UI purposes — GameManager's own guards
     * inside playerDouble/playerSplit/playerSurrender remain the source of
     * truth and no-op safely (with an onFeedback toast) if this ever drifts,
     * so duplicating the check here is a low-risk, presentation-only call.
     */
    function refreshActionButtons(gm) {
        var snapshot = gm.getSnapshot();
        var hand = snapshot.playerHands[snapshot.activeHandIndex];
        var inPlayerTurn = snapshot.state === 'player-turn';

        setDisabled(UI.btnHit, !inPlayerTurn || !hand);
        setDisabled(UI.btnStand, !inPlayerTurn || !hand);

        if (!hand || !inPlayerTurn) {
            setDisabled(UI.btnDouble, true);
            setDisabled(UI.btnSplit, true);
            setDisabled(UI.btnSurrender, true);
            return;
        }

        var settings = gm.getSettings();
        var isDrill = snapshot.gameMode !== 'testout' || settings.freeplay;
        var hasFunds = isDrill || gm.getBankroll() >= hand.bet;

        var canDouble = hand.cards.length === 2 && hasFunds;
        setDisabled(UI.btnDouble, !canDouble);

        var canSplit = hand.cards.length === 2 && hand.isPair && snapshot.playerHands.length < 4 && hasFunds;
        setDisabled(UI.btnSplit, !canSplit);

        var Rules = BJ.Rules || {};
        var canSurrender = !!Rules.lateSurrender && hand.cards.length === 2 && !hand.surrendered
            && snapshot.playerHands.length === 1
            && (snapshot.gameMode === 'testout' || snapshot.gameMode === 'hard' || snapshot.gameMode === 'surrender');
        setDisabled(UI.btnSurrender, !canSurrender);
    }

    /**
     * Wires every [data-setting] control (in the in-game overlay AND the hub
     * Settings tab) to gm settings. Checkboxes map to booleans, selects to
     * their value (numeric-coerced when the value is all digits). soundEnabled
     * additionally drives the Web Audio engine. onSettingsChange re-syncs all
     * instances so they never disagree.
     */
    function bindSettingControls(gm, Audio) {
        if (typeof document === 'undefined') return;
        var controls = Array.prototype.slice.call(document.querySelectorAll('[data-setting]'));
        if (!controls.length) return;

        function readControl(el) {
            if (el.type === 'checkbox') return el.checked;
            var v = el.value;
            return /^-?\d+$/.test(v) ? parseInt(v, 10) : v;
        }
        function writeControl(el, settings) {
            var val = settings[el.dataset.setting];
            if (el.type === 'checkbox') el.checked = !!val;
            else if (val !== undefined && val !== null) el.value = String(val);
        }

        function applyAudio(enabled) {
            if (!Audio) return;
            Audio.enabled = !!enabled;
            if (enabled && typeof Audio.init === 'function') Audio.init();
        }

        controls.forEach(function (el) {
            writeControl(el, gm.getSettings());
            el.addEventListener('change', function () {
                var name = el.dataset.setting;
                var value = readControl(el);
                var patch = {}; patch[name] = value;
                gm.updateSettings(patch);
                if (name === 'soundEnabled') applyAudio(value);
                if (name === 'freeplay') renderFinance(gm);
            });
        });

        // Keep every instance in lockstep whenever settings change anywhere.
        gm.setCallback('onSettingsChange', function (settings) {
            controls.forEach(function (el) { writeControl(el, settings); });
        });

        // Apply persisted sound preference to the engine at boot.
        applyAudio(gm.getSettings().soundEnabled);
    }

    function applyStatePanels(state) {
        // 'count-check' parks the game between hands to ask for the count —
        // no betting or actions until it's answered.
        showPanel(UI.betControls, state === 'betting' || state === 'idle');
        showPanel(UI.gameControls, state === 'player-turn');
        showPanel(UI.insuranceControls, state === 'insurance');
        showPanel(UI.countPrompt, state === 'count-check');
    }

    // ------------------------------------------------------------------
    // bindEvents(gameManager, renderer, audioEngine)
    // ------------------------------------------------------------------
    function bindEvents(gameManager, renderer, audioEngine) {
        var gm = gameManager;
        var R = renderer;
        var Audio = audioEngine;

        // ---------------- GameManager -> plain display / panel wiring ----------------
        gm.setCallback('onBankrollChange', function () { renderFinance(gm); });
        gm.setCallback('onBetChange', function (bet) { renderFinance(gm); renderBetBubble(bet); });
        gm.setCallback('onCountChange', function (info) { renderCount(info, gm.getSettings()); });
        gm.setCallback('onStatsUpdate', function (payload) { renderSessionStats(payload); });
        // Re-mask/unmask the TC readout the moment the quiz setting changes,
        // rather than leaving a stale value until the next card is dealt.
        gm.setCallback('onSettingsChange', function (settings) { renderCount(null, settings); });
        gm.setCallback('onStateChange', function (state) {
            applyStatePanels(state);
            refreshActionButtons(gm);
        });
        gm.setCallback('onHandsUpdate', function () { refreshActionButtons(gm); });
        gm.setCallback('onGameModeChange', function (mode) {
            if (UI.mainMenu) UI.mainMenu.style.display = 'none';
            if (UI.blackjackContainer) UI.blackjackContainer.style.display = 'flex';
            if (UI.chipContainer) UI.chipContainer.style.display = (mode === 'testout') ? 'flex' : 'none';
            if (UI.sessionStats) UI.sessionStats.style.display = (mode === 'testout') ? 'none' : 'block';
            // Only the real-money game shows the bankroll/bet/TC readouts and
            // the discard tray. Trainer modes hide them (CSS keys off this
            // class) so the screen stays focused on the decision, not chrome.
            if (UI.blackjackContainer) UI.blackjackContainer.classList.toggle('is-testout', mode === 'testout');
            renderSessionStats({ sessionAccuracy: null });
            renderFinance(gm);
        });

        // ---------------- GameManager -> audio cue wiring ----------------
        if (Audio) {
            gm.setCallback('onCardDealt', function () { Audio.play('card'); });
            gm.setCallback('onDealerCardDealt', function () { Audio.play('card'); });
            gm.setCallback('onShuffle', function () { Audio.play('shuffle'); });
            gm.setCallback('onRoundResolved', function (hands) {
                var anyWin = (hands || []).some(function (h) { return h.outcome === 'win' || h.outcome === 'blackjack'; });
                var anyLoss = (hands || []).some(function (h) { return h.outcome === 'loss'; });
                if (anyWin) Audio.play('win');
                else if (anyLoss) Audio.play('loss');
            });
        }

        // ---------------- mode routing ----------------
        function goToMode(mode) { gm.setGameMode(mode); }
        if (UI.btnModeTestout) UI.btnModeTestout.addEventListener('click', function () { goToMode('testout'); });
        if (UI.btnModePairs) UI.btnModePairs.addEventListener('click', function () { goToMode('pairs'); });
        if (UI.btnModeSoft) UI.btnModeSoft.addEventListener('click', function () { goToMode('soft'); });
        if (UI.btnModeDeviations) UI.btnModeDeviations.addEventListener('click', function () { goToMode('deviations'); });
        if (UI.btnModeHard) UI.btnModeHard.addEventListener('click', function () { goToMode('hard'); });
        if (UI.btnModeSurrender) UI.btnModeSurrender.addEventListener('click', function () { goToMode('surrender'); });
        if (UI.btnModeTargeted) UI.btnModeTargeted.addEventListener('click', function () { goToMode('targeted'); });

        if (UI.btnReturnMenu) {
            UI.btnReturnMenu.addEventListener('click', function () {
                if (UI.blackjackContainer) UI.blackjackContainer.style.display = 'none';
                if (UI.mainMenu) UI.mainMenu.style.display = 'flex';
            });
        }

        // ---------------- SINGLE fullscreen handler (bug #10) ----------------
        if (UI.btnFullscreen) {
            UI.btnFullscreen.addEventListener('click', function () {
                var doc = window.document;
                var docEl = doc.documentElement;
                var requestFS = docEl.requestFullscreen || docEl.webkitRequestFullScreen;
                var cancelFS = doc.exitFullscreen || doc.webkitExitFullscreen;
                var isFullscreen = !!(doc.fullscreenElement || doc.webkitFullscreenElement);

                if (!isFullscreen && requestFS) {
                    requestFS.call(docEl).catch(function (err) {
                        if (typeof console !== 'undefined') console.log('Fullscreen denied by browser.', err);
                    });
                    UI.btnFullscreen.innerHTML = '<i class="icon solid fa-compress"></i>';
                } else if (isFullscreen && cancelFS) {
                    cancelFS.call(doc);
                    UI.btnFullscreen.innerHTML = '<i class="icon solid fa-expand"></i>';
                }
            });
            UI.btnFullscreen.setAttribute('aria-label', 'Toggle fullscreen');
        }

        // ---------------- in-game settings overlay open/close ----------------
        // The gear opens an overlay ON the table — it does NOT route back to
        // the hub's Settings tab (that forced-redirect was removed in hub.js).
        function closeSettings() { if (UI.settingsMenu) UI.settingsMenu.style.display = 'none'; }
        if (UI.btnSettings && UI.settingsMenu) {
            UI.btnSettings.setAttribute('aria-label', 'Settings');
            UI.btnSettings.addEventListener('click', function (e) {
                e.stopPropagation();
                var isHidden = window.getComputedStyle(UI.settingsMenu).display === 'none';
                UI.settingsMenu.style.display = isHidden ? 'flex' : 'none';
            });
            document.addEventListener('click', function (e) {
                if (UI.settingsMenu.style.display !== 'none'
                    && !UI.settingsMenu.contains(e.target) && e.target !== UI.btnSettings) {
                    closeSettings();
                }
            });
        }
        if (UI.btnCloseSettings) UI.btnCloseSettings.addEventListener('click', closeSettings);

        // ---------------- [data-setting] binder ----------------
        // Every settings control (checkbox/select) carries data-setting=<key>.
        // One binder wires them all, coerces values, writes gm.updateSettings,
        // drives the Audio engine for soundEnabled, and — via onSettingsChange
        // (a multi-subscriber event) — keeps EVERY instance (in-game overlay +
        // hub Settings tab) visually in sync no matter which one was changed.
        bindSettingControls(gm, Audio);

        // ---------------- reference modal ----------------
        // 'flex' (not 'block'): the strategy charts size themselves to FILL
        // the sheet so neither axis scrolls, which needs a flex column
        // context — see reference-render.js's layout contract.
        if (UI.btnOpenReference && UI.referenceModal) {
            UI.btnOpenReference.addEventListener('click', function () { UI.referenceModal.style.display = 'flex'; });
        }
        if (UI.btnCloseReference && UI.referenceModal) {
            UI.btnCloseReference.addEventListener('click', function () { UI.referenceModal.style.display = 'none'; });
        }

        // ---------------- stats modal (NEW) ----------------
        if (UI.btnOpenStats && UI.statsModal) {
            UI.btnOpenStats.addEventListener('click', function () {
                UI.statsModal.style.display = 'block';
                if (BJ.StatsRender && typeof BJ.StatsRender.render === 'function') BJ.StatsRender.render();
            });
        }
        if (UI.btnCloseStats && UI.statsModal) {
            UI.btnCloseStats.addEventListener('click', function () { UI.statsModal.style.display = 'none'; });
        }

        // ---------------- action dashboard ----------------
        if (UI.btnDeal) UI.btnDeal.addEventListener('click', function () { gm.startRound(); });
        if (UI.btnHit) UI.btnHit.addEventListener('click', function () { gm.playerHit(); });
        if (UI.btnStand) UI.btnStand.addEventListener('click', function () { gm.playerStand(); });
        if (UI.btnDouble) UI.btnDouble.addEventListener('click', function () { gm.playerDouble(); });
        if (UI.btnSplit) UI.btnSplit.addEventListener('click', function () { gm.playerSplit(); });
        if (UI.btnSurrender) UI.btnSurrender.addEventListener('click', function () { gm.playerSurrender(); });

        // after any player action that ends the active hand and moves to
        // dealer-turn, GameManager needs an explicit kick to actually run
        // the dealer's draws (its own `_advanceHand` already calls
        // `this.dealerPlay()` internally, so no extra call is needed here
        // — this comment documents that it's NOT forgotten, just already
        // handled inside GameManager).

        // ---------------- insurance ----------------
        if (UI.btnBuyInsurance) UI.btnBuyInsurance.addEventListener('click', function () { gm.handleInsurance(true); });
        if (UI.btnPassInsurance) UI.btnPassInsurance.addEventListener('click', function () { gm.handleInsurance(false); });

        // ---------------- periodic count quiz ----------------
        gm.setCallback('onCountPrompt', function (info) {
            if (UI.countPromptTitle) {
                UI.countPromptTitle.textContent = info.type === 'true'
                    ? 'What is the TRUE count?'
                    : 'What is the RUNNING count?';
            }
            if (UI.countPromptInput) {
                UI.countPromptInput.value = '';
                UI.countPromptInput.focus();
            }
        });

        function submitCount() {
            if (!UI.countPromptInput) return;
            var raw = UI.countPromptInput.value.trim();
            if (raw === '' || !Number.isFinite(Number(raw))) return; // ignore empty/garbage
            gm.submitCountAnswer(Number(raw));
        }
        if (UI.countPromptSubmit) UI.countPromptSubmit.addEventListener('click', submitCount);
        if (UI.countPromptInput) {
            UI.countPromptInput.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') submitCount();
            });
        }

        // ---------------- betting chips ----------------
        if (UI.chipBtns && UI.chipBtns.forEach) {
            UI.chipBtns.forEach(function (btn) {
                btn.addEventListener('click', function (e) {
                    var amount = parseInt(e.target.textContent.replace('$', ''), 10);
                    if (!amount) return;
                    var before = gm.getSnapshot().currentBet;
                    gm.setBet(amount);
                    var after = gm.getSnapshot().currentBet;
                    if (after > before && R && UI.chipStack) {
                        var chipClass = e.target.classList[1];
                        R.tossChip(e.target.textContent, chipClass, UI.chipStack);
                    }
                    if (Audio) Audio.play('chip');
                });
            });
        }

        // secret "clear bet" tap targets (stack + bet readout). Only wipe the
        // chip visual if the bet was ACTUALLY refunded — a mid-round tap must
        // not blank the stack while the wager still stands (clearBet no-ops
        // once cards are out), which used to desync visuals from the money.
        function clearBetAndChips() {
            var before = gm.getSnapshot().currentBet;
            gm.clearBet();
            var after = gm.getSnapshot().currentBet;
            if (before > 0 && after === 0 && R && UI.chipStack) R.clearChips(UI.chipStack);
        }
        if (UI.tableBetArea) UI.tableBetArea.addEventListener('click', clearBetAndChips);
        if (UI.uiBet && UI.uiBet.parentElement) {
            UI.uiBet.parentElement.addEventListener('click', clearBetAndChips);
            UI.uiBet.parentElement.style.cursor = 'pointer';
        }

        // ---------------- new-shoe (if a control for it exists) ----------------
        var btnNewShoe = byId('btn-new-shoe');
        if (btnNewShoe) btnNewShoe.addEventListener('click', function () { gm.newShoe(); });

        // ---------------- initial paint ----------------
        renderFinance(gm);
        renderBetBubble(gm.getSnapshot().currentBet);
        applyStatePanels(gm.getState());
        refreshActionButtons(gm);
    }

    BJ.bindEvents = bindEvents;

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { UI: UI, bindEvents: bindEvents };
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);

// ==========================================
// NEW ELEMENT IDS this file requires (none of these exist in the current
// blackjack.html — guarded, so their absence today is harmless):
//   #btn-surrender
//   #btn-mode-hard
//   #btn-mode-surrender
//   #stats-modal, #stats-modal-body, #btn-open-stats, #btn-close-stats
//   #reference-modal-body   (replaces hand-authored HTML inside #reference-modal)
//   #btn-new-shoe            (optional — only wired if present)
//
// REMOVED from the old lookup list (bug #5 — ruleset is frozen):
//   #config-decks, #config-penetration, #pen-value
// ==========================================
