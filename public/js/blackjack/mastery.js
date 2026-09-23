// ==========================================
// mastery.js — per-section mastery, checkouts, and rust.
//
// DOM-free and Node-requireable, same discipline as count.js /
// strategy-engine.js / certification.js: everything here reads and writes
// through BJ.Storage and returns plain data. That is what lets the whole
// threshold model be driven against literal numbers in a test instead of
// against a running game — and the threshold model is the part that must not
// be wrong, because it decides whether somebody is told they are ready.
//
// ---------------------------------------------------------------------------
// WHY THIS REPLACES THE OLD FIVE-RUNG LADDER
//
// The previous model mastered "Basic Strategy" at 90% accuracy over 30 pooled
// decisions. Two things were wrong with that, and they are independent:
//
//   1. THE BAR WAS BELOW THE LINE WHERE THE SKILL PAYS. The published figure
//      is that one repeated basic-strategy error per twenty hands is enough to
//      erase a counter's edge. One error in twenty is 95%. Certifying mastery
//      at 90% was certifying at double the error rate that wipes out the
//      advantage — the app was congratulating a player at a standard where
//      counting loses money. The counting schools state the requirement as
//      100% on basic strategy, and treat it as the PREREQUISITE you arrive
//      with rather than an achievement you earn on the way.
//
//   2. THE SECTIONS WERE POOLED. Accuracy was computed over
//      ['hard','soft','pairs','certify'] as a single bucket, so thirty hard
//      totals and no soft hand and no pair still read as "Basic Strategy
//      Master". You could be certified on a chart you had never once been
//      shown. Sections are independent here for exactly that reason: a player
//      who is strong on hard totals and blind on pairs is not 90% of a basic
//      strategy player, they are a player with a hole, and pooling is what
//      hides it.
//
// ---------------------------------------------------------------------------
// MASTERY IS VOLUME **PLUS** A CHECKOUT, AND THE TWO MEASURE DIFFERENT THINGS
//
// Volume alone certifies exposure, not skill. A flawless run alone can be
// luck — fifty decisions is a sample a lucky guesser clears sometimes. So a
// section is mastered only when BOTH are satisfied: enough logged decisions
// to have met the chart, and then a bounded, flawless checkout run.
//
// The checkout is deliberately BOUNDED AND RETRYABLE, and that is the only
// reading of "100%" that is actually attainable. Requiring lifetime 100%
// would mean one mistake in your first ever session poisons a section
// permanently, which is not a standard, it is a trap. A checkout is a gate
// you can walk back up to.
//
// ---------------------------------------------------------------------------
// CHECKOUTS COME IN THREE KINDS, BECAUSE THE SKILLS DO
//
//   'decisions' — N graded decisions with zero errors. The basic-strategy and
//                 deviation sections; the thing being tested is chart recall.
//   'countdown' — five clean deck countdowns in a row (accurate AND inside the
//                 pace bar). Counting speed is a rate, not a lookup, so a
//                 decision count cannot express it. Tracked by count-drills.js.
//   'shoes'     — the final gate: eight six-deck shoes played near error-free,
//                 the form the MIT team used before anyone touched team money.
//
// Forcing all three into one shape would have meant either grading the
// countdown on something it does not measure, or dropping the pace
// requirement, and the pace requirement is most of what the drill is for.
//
// ---------------------------------------------------------------------------
// MASTERY IS NEVER REVOKED. RUST IS REPORTED BESIDE IT.
//
// A rolling window of recent results per section gives "current form", which
// is a different fact from "was certified". Taking a badge away for a bad
// session punishes the practice that surfaced the problem, and a player who
// learns that drilling can cost them a rank stops drilling the things they
// are worst at — which is the exact opposite of what this file exists to
// cause. So `mastered` is permanent once earned and `rusty` is a separate
// flag on top of it, with the section pushed back into the recommendation
// queue. The threshold is the same 95% edge-erasure line, because a mastered
// section running below it has stopped being worth money.
// ==========================================

(function (root) {
    'use strict';

    var BJ = (typeof window !== 'undefined')
        ? (window.BJ = window.BJ || {})
        : (root.BJ = root.BJ || {});

    var Storage = BJ.Storage || (typeof module !== 'undefined' ? require('./persistence.js') : undefined);

    // --- the thresholds --------------------------------------------------
    //
    // 95 is not a round number picked for feel. It is one error in twenty,
    // the published rate at which a repeated basic-strategy mistake cancels
    // out a counter's edge, and it is used in exactly two places: the floor a
    // section must be above to be offered a checkout, and the line below
    // which a mastered section is called rusty. Above that line the skill
    // pays; below it, it does not.
    var EDGE_LINE_PCT = 95;

    // A checkout is flawless. See the header for why this is a bounded run
    // rather than a lifetime figure.
    var CHECKOUT_REQUIRED_PCT = 100;

    // The final 8-shoe gate is "near error-free" rather than perfect: it is
    // several hundred decisions long, and demanding literal perfection over
    // that span tests stamina against variance rather than skill. One error
    // per hundred decisions is the budget.
    var FINAL_REQUIRED_PCT = 99;
    var FINAL_SHOES = 8;

    // Current form is read over this many recent decisions in a section's own
    // modes. A full window is required before rust is declared — otherwise a
    // mastered section you have barely touched since would flap in and out of
    // rusty on two or three results.
    //
    // Read FROM the storage layer's buffer cap rather than declared beside it.
    // These two numbers have to stay compatible and they live in different
    // files: if the buffer were ever shortened below the window, a
    // single-mode section could never report a full window, rust would
    // silently never fire again, and nothing would fail — the flag would just
    // quietly stop existing. Deriving it makes that impossible instead of
    // documenting it and hoping.
    var RUST_WINDOW = (Storage && Storage.ROLLING_FORM_CAP) || 100;

    // ------------------------------------------------------------------
    // the sections
    // ------------------------------------------------------------------
    //
    // `volume` is the logged-decision count that makes a checkout available.
    // The basic-strategy figures are sized against the charts themselves —
    // hard totals is a hundred live cells, surrender is four — and together
    // they come to roughly 1,450 decisions before a single checkout is
    // attempted. That is a few hours of honest drilling at a real thinking
    // pace, against the ~20 hours the counting schools put on mastering basic
    // strategy. It is a floor, not an estimate of how long this takes.
    //
    // `modes` are the stats buckets the section reads. They are the SAME
    // strings game-manager.js records against, so a section can never drift
    // from the drill that feeds it.

    var TIERS = [
        { id: 'basic', title: 'Basic Strategy', blurb: 'The chart, cold. Everything else is built on this.' },
        { id: 'counting', title: 'Counting', blurb: 'Track the shoe — accurately, and at dealt speed.' },
        { id: 'advantage', title: 'Advantage Play', blurb: 'Put them together and play for money.' }
    ];

    var SECTIONS = [
        {
            id: 'hard', tier: 'basic', order: 1,
            title: 'Hard Totals', tagline: 'The biggest chart',
            icon: 'fa-hashtag',
            modes: ['hard'], volume: 500,
            checkout: { kind: 'decisions', size: 50 },
            drill: 'hard'
        },
        {
            id: 'soft', tier: 'basic', order: 2,
            title: 'Soft Totals', tagline: 'Where most leaks live',
            icon: 'fa-feather',
            modes: ['soft'], volume: 400,
            checkout: { kind: 'decisions', size: 50 },
            drill: 'soft'
        },
        {
            id: 'pairs', tier: 'basic', order: 3,
            title: 'Pairs', tagline: 'Split or not — 100 cells',
            icon: 'fa-clone',
            modes: ['pairs'], volume: 400,
            checkout: { kind: 'decisions', size: 50 },
            drill: 'pairs'
        },
        {
            id: 'surrender', tier: 'basic', order: 4,
            // A short chart gets a short requirement. Holding a four-cell
            // table to the same volume as hard totals would not make anyone
            // better at it, it would just make the ladder feel arbitrary.
            title: 'Surrender', tagline: 'Four cells you cannot miss',
            icon: 'fa-flag',
            modes: ['surrender'], volume: 150,
            checkout: { kind: 'decisions', size: 25 },
            drill: 'surrender'
        },
        {
            id: 'running-count', tier: 'counting', order: 5,
            title: 'Running Count', tagline: 'A deck under 30s, five times',
            icon: 'fa-bolt',
            modes: ['count-running', 'count-speed'], volume: 300,
            checkout: { kind: 'countdown', size: 5 },
            drill: 'manual'
        },
        {
            id: 'estimation', tier: 'counting', order: 6,
            title: 'Deck Estimation', tagline: 'The tray, to half a deck',
            icon: 'fa-ruler-vertical',
            modes: ['estimation'], volume: 120,
            checkout: { kind: 'decisions', size: 15 },
            drill: 'estimation'
        },
        {
            id: 'true-count', tier: 'counting', order: 7,
            title: 'True Count', tagline: 'Running count ÷ decks left',
            icon: 'fa-divide',
            modes: ['count-true'], volume: 200,
            checkout: { kind: 'decisions', size: 25 },
            drill: 'truecount'
        },
        {
            id: 'deviations', tier: 'advantage', order: 8,
            title: 'Deviations', tagline: 'The Illustrious 18 and Fab 4',
            icon: 'fa-code-branch',
            modes: ['deviations'], volume: 300,
            checkout: { kind: 'decisions', size: 40 },
            drill: 'deviations'
        },
        {
            id: 'full-game', tier: 'advantage', order: 9,
            title: 'The Checkout', tagline: 'Eight shoes, near error-free',
            icon: 'fa-crown',
            modes: ['testout'], volume: 500,
            checkout: { kind: 'shoes', size: FINAL_SHOES },
            drill: 'testout'
        }
    ];

    /**
     * Checkouts are gated in tier order; PRACTICE never is.
     *
     * This is how the counting schools actually work and the distinction
     * matters both ways. You may drill anything you like at any time —
     * blocking a player from a screen they are curious about teaches them
     * nothing and reads as the app being broken. But you may not CERTIFY out
     * of order, because the whole complaint this file answers is being told
     * you have mastered something you have barely met. Basic strategy is the
     * stated prerequisite for counting, not a parallel track.
     */
    function tierUnlocked(tierId, sections) {
        if (tierId === 'basic') return true;
        var needed = tierId === 'counting' ? 'basic' : 'counting';
        var prereqs = sections.filter(function (s) { return s.tier === needed; });
        return prereqs.length > 0 && prereqs.every(function (s) { return s.mastered; });
    }

    // ------------------------------------------------------------------
    // stored state
    // ------------------------------------------------------------------

    /**
     * `{ sections: { <id>: { passedAt, attempts, bestRun } }, active: <checkout|null> }`
     */
    function getRecord() {
        var raw = (Storage && Storage.get('mastery', null)) || {};
        return {
            sections: raw.sections || {},
            active: raw.active || null
        };
    }

    function setRecord(rec) {
        if (Storage) Storage.set('mastery', rec);
        return rec;
    }

    function sectionRecord(rec, id) {
        if (!rec.sections[id]) rec.sections[id] = { passedAt: null, attempts: 0, bestRun: 0 };
        return rec.sections[id];
    }

    // ------------------------------------------------------------------
    // reading the numbers
    // ------------------------------------------------------------------

    /** Lifetime total/correct summed across a section's modes. */
    function lifetimeFor(lifetime, modes) {
        var total = 0, correct = 0;
        var byMode = (lifetime && lifetime.byMode) || {};
        modes.forEach(function (m) {
            var b = byMode[m];
            if (b) { total += b.total || 0; correct += b.correct || 0; }
        });
        return { total: total, correct: correct, pct: total > 0 ? (correct / total) * 100 : null };
    }

    /**
     * Current form: accuracy over the most recent RUST_WINDOW results in this
     * section's modes, read from the per-mode rolling buffers.
     *
     * Returns `{ pct, samples, full }`. `full` says whether a whole window was
     * available — callers must not call a section rusty on a partial one, and
     * making that explicit here is what stops each caller inventing its own
     * (differing) idea of "enough".
     */
    function formFor(form, modes) {
        var total = 0, correct = 0;
        modes.forEach(function (m) {
            var s = (form && form[m]) || '';
            for (var i = 0; i < s.length; i++) {
                total++;
                if (s.charAt(i) === '1') correct++;
            }
        });
        return {
            pct: total > 0 ? (correct / total) * 100 : null,
            samples: total,
            full: total >= RUST_WINDOW
        };
    }

    // ------------------------------------------------------------------
    // the public picture
    // ------------------------------------------------------------------

    /**
     * Every section resolved to a status. Statuses, in the order they are
     * decided:
     *
     *   'mastered'  — checkout passed. Permanent.
     *   'rusty'     — mastered, but current form has fallen below the edge
     *                 line over a full window. Still mastered; flagged.
     *   'ready'     — volume met and accuracy above the edge line: the
     *                 checkout is available (if the tier is unlocked).
     *   'in-progress'
     *   'not-started'
     *
     * `blocked` is separate from status on purpose: a section can be ready on
     * its own numbers and still not be sittable because an earlier tier is
     * unfinished, and collapsing those into one value would leave the UI
     * unable to say WHICH of the two is in the way.
     */
    function getStatus() {
        var lifetime = Storage.getLifetimeStats();
        var form = Storage.getRollingForm();
        var rec = getRecord();
        var countdown = Storage.get('countdown_record', null) || { streak: 0, best: 0 };

        var sections = SECTIONS.map(function (def) {
            var life = lifetimeFor(lifetime, def.modes);
            var cur = formFor(form, def.modes);
            var sr = rec.sections[def.id] || { passedAt: null, attempts: 0, bestRun: 0 };

            var mastered = !!sr.passedAt;
            var volumeMet = life.total >= def.volume;
            var aboveLine = life.pct !== null && life.pct >= EDGE_LINE_PCT;
            var rusty = mastered && cur.full && cur.pct < EDGE_LINE_PCT;

            var status;
            if (mastered) status = rusty ? 'rusty' : 'mastered';
            else if (volumeMet && aboveLine) status = 'ready';
            else if (life.total > 0) status = 'in-progress';
            else status = 'not-started';

            // The countdown checkout's progress lives in count-drills.js's own
            // streak record rather than in an attempt object — it is earned
            // across separate runs, not inside one sitting.
            var checkoutProgress = def.checkout.kind === 'countdown'
                ? Math.min(countdown.streak, def.checkout.size)
                : 0;

            return {
                id: def.id, tier: def.tier, order: def.order,
                title: def.title, tagline: def.tagline, icon: def.icon, drill: def.drill,
                modes: def.modes,

                decisions: life.total,
                volume: def.volume,
                volumePct: Math.min(100, Math.round((life.total / def.volume) * 100)),
                lifetimePct: life.pct === null ? null : Math.round(life.pct * 10) / 10,

                formPct: cur.pct === null ? null : Math.round(cur.pct * 10) / 10,
                formSamples: cur.samples,
                formWindow: RUST_WINDOW,

                checkout: {
                    kind: def.checkout.kind,
                    size: def.checkout.size,
                    progress: checkoutProgress,
                    requiredPct: def.checkout.kind === 'shoes' ? FINAL_REQUIRED_PCT : CHECKOUT_REQUIRED_PCT
                },
                attempts: sr.attempts || 0,
                bestRun: sr.bestRun || 0,
                passedAt: sr.passedAt || null,

                mastered: mastered,
                rusty: rusty,
                volumeMet: volumeMet,
                aboveLine: aboveLine,
                status: status
            };
        });

        // Tier gating reads the resolved sections, so it must run after the
        // map rather than inside it.
        var tiers = TIERS.map(function (t) {
            var unlocked = tierUnlocked(t.id, sections);
            var own = sections.filter(function (s) { return s.tier === t.id; });
            return {
                id: t.id, title: t.title, blurb: t.blurb,
                unlocked: unlocked,
                mastered: own.filter(function (s) { return s.mastered; }).length,
                total: own.length
            };
        });
        var unlockedById = {};
        tiers.forEach(function (t) { unlockedById[t.id] = t.unlocked; });

        sections.forEach(function (s) {
            s.tierUnlocked = !!unlockedById[s.tier];
            s.checkoutAvailable = !s.mastered && s.status === 'ready' && s.tierUnlocked;
            s.blocked = !s.mastered && s.status === 'ready' && !s.tierUnlocked;
            s.reason = describeGap(s);
        });

        var masteredCount = sections.filter(function (s) { return s.mastered; }).length;
        // "What next" prefers a rusty section over an untouched one: a hole
        // that has opened in something you already certified is more urgent
        // than ground you have not covered yet.
        var next = sections.filter(function (s) { return s.rusty; })[0]
            || sections.filter(function (s) { return s.checkoutAvailable; })[0]
            || sections.filter(function (s) { return !s.mastered && s.tierUnlocked; })[0]
            || sections.filter(function (s) { return !s.mastered; })[0]
            || sections[sections.length - 1];

        return {
            sections: sections,
            tiers: tiers,
            masteredCount: masteredCount,
            totalSections: sections.length,
            currentSectionId: next ? next.id : null,
            active: rec.active,
            rankTitle: rankFor(masteredCount, sections.length)
        };
    }

    /** One sentence saying what is actually standing between here and mastered. */
    function describeGap(s) {
        // KEPT UNDER ~32 CHARACTERS, deliberately. The Path card gives this
        // line about 211px beside the action buttons; every string here was
        // once a full sentence, every one of them wrapped to two lines, and
        // four cards' worth of that second line was exactly what pushed the
        // Basic Strategy column past the bottom of the screen. Terse because
        // the card has a width, not because the detail does not matter.
        if (s.mastered && s.rusty) {
            return 'Form ' + s.formPct + '% — under the ' + EDGE_LINE_PCT + '% line';
        }
        if (s.mastered) return 'Checkout passed';
        if (s.blocked) return 'Locked — finish Basic Strategy';
        if (s.checkoutAvailable) {
            return s.checkout.kind === 'countdown'
                ? 'Ready — ' + s.checkout.progress + '/' + s.checkout.size + ' clean runs'
                : 'Ready — ' + s.checkout.size + ' flawless decisions';
        }
        if (!s.volumeMet) return (s.volume - s.decisions) + ' more decisions to unlock';
        if (!s.aboveLine) {
            return (s.lifetimePct === null ? '—' : s.lifetimePct + '%')
                + ' — checkout opens at ' + EDGE_LINE_PCT + '%';
        }
        return '';
    }

    var RANKS = ['Novice', 'Student', 'Strategist', 'Counter', 'Advantage Player', 'Card Sharp', 'Master Counter'];
    function rankFor(mastered, total) {
        if (!total) return RANKS[0];
        var idx = Math.round((mastered / total) * (RANKS.length - 1));
        return RANKS[Math.max(0, Math.min(RANKS.length - 1, idx))];
    }

    // ------------------------------------------------------------------
    // checkouts
    // ------------------------------------------------------------------

    function definitionFor(id) {
        for (var i = 0; i < SECTIONS.length; i++) if (SECTIONS[i].id === id) return SECTIONS[i];
        return null;
    }

    /**
     * Opens a checkout attempt for `sectionId`. Returns the attempt, or null
     * if the section is not eligible — the caller is expected to have checked
     * `checkoutAvailable`, and this is the backstop that makes it impossible
     * to start one by calling the API directly.
     */
    function startCheckout(sectionId, now) {
        var def = definitionFor(sectionId);
        if (!def) return null;

        var status = getStatus();
        var s = status.sections.filter(function (x) { return x.id === sectionId; })[0];
        if (!s || !s.checkoutAvailable) return null;
        // The countdown checkout is not a sitting — it accumulates across
        // separate runs of the Deck Countdown drill, so there is no attempt
        // object to open. count-drills.js owns its progress.
        if (def.checkout.kind === 'countdown') return null;

        var rec = getRecord();
        var sr = sectionRecord(rec, sectionId);
        sr.attempts = (sr.attempts || 0) + 1;

        rec.active = {
            sectionId: sectionId,
            kind: def.checkout.kind,
            size: def.checkout.size,
            requiredPct: def.checkout.kind === 'shoes' ? FINAL_REQUIRED_PCT : CHECKOUT_REQUIRED_PCT,
            decisions: 0,
            correct: 0,
            shoesDone: 0,
            startedAt: now || Date.now(),
            verdict: 'active',
            brokenBy: null,
            finishedAt: null
        };
        setRecord(rec);
        return rec.active;
    }

    /**
     * Records one graded decision into the live checkout. `mistake` is the
     * structured mistake-log entry when wrong, kept so a failed checkout can
     * say exactly which hand broke it — "you failed" with no hand attached
     * teaches nothing and is the single most useful thing a gate can report.
     *
     * A 'decisions' checkout fails on the FIRST error, because flawless is
     * what it is testing and continuing would only spend the player's time
     * proving a verdict that is already decided. A 'shoes' checkout carries
     * an error budget and so must play on.
     */
    function recordDecision(mode, correct, now) {
        var rec = getRecord();
        var a = rec.active;
        if (!a || a.verdict !== 'active') return null;

        // A checkout only consumes decisions from its OWN section's modes.
        // Without this, any graded decision anywhere in the app would count
        // toward a live attempt — a player could open a Hard Totals checkout,
        // wander into the Pairs drill, and pass the hard-totals gate on
        // fifty pair decisions.
        var def = definitionFor(a.sectionId);
        if (!def || def.modes.indexOf(mode) === -1) return a;

        a.decisions++;
        if (correct) a.correct++;

        if (!correct && a.kind === 'decisions') {
            a.verdict = 'failed';
            a.finishedAt = now || Date.now();
            noteBestRun(rec, a.sectionId, a.decisions - 1);
            setRecord(rec);
            return a;
        }

        if (a.kind === 'decisions' && a.decisions >= a.size) {
            a.verdict = 'passed';
            a.finishedAt = now || Date.now();
            noteBestRun(rec, a.sectionId, a.decisions);
            sectionRecord(rec, a.sectionId).passedAt = a.finishedAt;
            setRecord(rec);
            return a;
        }

        if (a.kind === 'shoes') {
            // Budget check runs continuously so a doomed final attempt is
            // reported the moment it is doomed, rather than several hundred
            // decisions later.
            var pct = (a.correct / a.decisions) * 100;
            var bestPossible = ((a.correct + Math.max(0, expectedDecisions(a) - a.decisions)) / Math.max(a.decisions, expectedDecisions(a))) * 100;
            a.stillAchievable = bestPossible >= a.requiredPct;
            if (pct < a.requiredPct && !a.stillAchievable) {
                a.verdict = 'failed';
                a.finishedAt = now || Date.now();
                setRecord(rec);
                return a;
            }
        }

        setRecord(rec);
        return a;
    }

    /** A rough decision count for a full 8-shoe run, used only for the live "still achievable" bound. */
    function expectedDecisions(a) { return a.size * 60; }

    /**
     * Marks one shoe of the final checkout complete. Persisted per shoe so the
     * gate is a campaign rather than a single unbroken sitting — eight
     * six-deck shoes is several hours, and a gate that punishes closing the
     * laptop is a gate nobody ever walks through. Same argument the
     * certification attempt already makes for being resumable.
     */
    function recordShoe(now) {
        var rec = getRecord();
        var a = rec.active;
        if (!a || a.verdict !== 'active' || a.kind !== 'shoes') return null;

        a.shoesDone++;
        if (a.shoesDone >= a.size) {
            var pct = a.decisions > 0 ? (a.correct / a.decisions) * 100 : 0;
            a.verdict = pct >= a.requiredPct ? 'passed' : 'failed';
            a.finishedAt = now || Date.now();
            if (a.verdict === 'passed') sectionRecord(rec, a.sectionId).passedAt = a.finishedAt;
        }
        setRecord(rec);
        return a;
    }

    /**
     * Attaches the structured mistake entry that ended a checkout. Separate
     * from `recordDecision` because game-manager.js grades and records the
     * decision BEFORE it builds the mistake entry — the same ordering
     * `Certification.noteMistake` already works around. A gate that says "you
     * failed" without naming the hand teaches nothing, and the hand is the
     * only part of a failed checkout worth reading.
     */
    function noteMistake(entry) {
        var rec = getRecord();
        var a = rec.active;
        if (!a || a.verdict !== 'failed' || a.brokenBy || !entry) return null;
        a.brokenBy = entry;
        setRecord(rec);
        return a;
    }

    function noteBestRun(rec, sectionId, run) {
        var sr = sectionRecord(rec, sectionId);
        if (run > (sr.bestRun || 0)) sr.bestRun = run;
    }

    /** Abandons the live attempt without a verdict. */
    function abortCheckout() {
        var rec = getRecord();
        if (rec.active && rec.active.verdict === 'active') {
            noteBestRun(rec, rec.active.sectionId, rec.active.decisions);
        }
        rec.active = null;
        setRecord(rec);
        return null;
    }

    /** Clears a finished attempt so the UI stops showing its verdict. */
    function clearCheckout() {
        var rec = getRecord();
        rec.active = null;
        setRecord(rec);
    }

    function getActiveCheckout() { return getRecord().active; }

    /**
     * Called by count-drills.js whenever the clean-countdown streak moves, so
     * the countdown checkout can settle without an attempt object. Idempotent:
     * re-passing an already-passed section is a no-op rather than a second
     * unlock event.
     */
    function syncCountdownCheckout(streak, now) {
        var def = definitionFor('running-count');
        if (!def || def.checkout.kind !== 'countdown') return false;
        if (streak < def.checkout.size) return false;

        var status = getStatus();
        var s = status.sections.filter(function (x) { return x.id === 'running-count'; })[0];
        if (!s || s.mastered || !s.volumeMet || !s.tierUnlocked) return false;

        var rec = getRecord();
        sectionRecord(rec, 'running-count').passedAt = now || Date.now();
        setRecord(rec);
        return true;
    }

    var Mastery = {
        EDGE_LINE_PCT: EDGE_LINE_PCT,
        CHECKOUT_REQUIRED_PCT: CHECKOUT_REQUIRED_PCT,
        FINAL_REQUIRED_PCT: FINAL_REQUIRED_PCT,
        FINAL_SHOES: FINAL_SHOES,
        RUST_WINDOW: RUST_WINDOW,
        SECTIONS: SECTIONS,
        TIERS: TIERS,

        getStatus: getStatus,
        definitionFor: definitionFor,

        startCheckout: startCheckout,
        recordDecision: recordDecision,
        noteMistake: noteMistake,
        recordShoe: recordShoe,
        abortCheckout: abortCheckout,
        clearCheckout: clearCheckout,
        getActiveCheckout: getActiveCheckout,
        syncCountdownCheckout: syncCountdownCheckout,

        // exposed for verification
        _formFor: formFor,
        _lifetimeFor: lifetimeFor
    };

    BJ.Mastery = Mastery;

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = Mastery;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
