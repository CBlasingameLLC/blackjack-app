// ==========================================
// gamification.js — Phase 4c: the Skill Ladder's mastery math, XP/streak,
// achievements, and the daily challenge. Local-only, no accounts/backend.
//
// DOM-free / requireable from Node (same discipline as count.js and
// strategy-engine.js) — everything here reads/writes through BJ.Storage,
// never `document`, so scripts/*.js-style headless verification works.
//
// ARCHITECTURE: game-manager.js's `_recordDecision` is already the single
// choke point EVERY graded decision flows through (Play, every strategy
// drill, every count check, and count-drills.js's standalone runs all
// funnel into it via `recordDrillResult`). So this file exposes exactly
// ONE hook for decisions (`onDecision(mode, correct)`) plus one for
// Test-Out hands (`recordHandPlayed()`, since "play N hands" isn't a
// per-decision event) — game-manager.js calls both, nothing else needs to.
//
// THE LADDER's Stage 3 ("Count + Strategy") mastery is a documented
// APPROXIMATION: individual decisions aren't tagged with whether a running-
// count check was active alongside them, so there's no direct "accuracy
// while counting" bucket to read. Stage 3's meter is instead the MINIMUM of
// Stage 1's (Basic Strategy) and Stage 2's (Running Count) accuracy — i.e.
// "you're only as good at combining them as your worse individual skill."
// Honest and simple; see LADDER_STAGES below.
//
// path-render.js reads `getLadderStatus()` for the ladder view;
// profile-render.js reads `ACHIEVEMENTS`/`getAchievements()` (via Storage)
// and the XP/level/challenge accessors. Both are pure display — all the
// actual unlock/progress logic lives here, once.
// ==========================================

(function (root) {
    'use strict';

    var BJ = (typeof window !== 'undefined')
        ? (window.BJ = window.BJ || {})
        : (root.BJ = root.BJ || {});

    var Storage = BJ.Storage || (typeof module !== 'undefined' ? require('./persistence.js') : undefined);

    var MASTERY_THRESHOLD_PCT = 90;
    var XP_PER_LEVEL = 100;
    var CHALLENGE_XP_REWARD = 10;
    var STAGE_XP_BONUS = 25;
    var LADDER_COMPLETE_XP_BONUS = 100;

    var RANK_TITLES = ['Novice', 'Strategist', 'Counter', 'Advantage Player', 'Card Sharp', 'Master Counter'];

    var STRATEGY_DRILL_MODES = { hard: 1, soft: 1, pairs: 1, deviations: 1, surrender: 1, targeted: 1 };

    // ------------------------------------------------------------------
    // the skill ladder
    // ------------------------------------------------------------------

    /** Sums total/correct across `modes` from a lifetime-stats bucket. */
    function combinedAccuracy(lifetime, modes) {
        var total = 0, correct = 0;
        var byMode = lifetime.byMode || {};
        modes.forEach(function (m) {
            var bucket = byMode[m];
            if (bucket) { total += bucket.total || 0; correct += bucket.correct || 0; }
        });
        return { pct: total > 0 ? Math.round((correct / total) * 100) : null, samples: total };
    }

    var LADDER_STAGES = [
        {
            id: 'basic', order: 1, title: 'Basic Strategy',
            tagline: 'Hard, Soft & Pairs — the foundation',
            icon: 'fa-hashtag', minSamples: 30,
            compute: function (lifetime) { return combinedAccuracy(lifetime, ['hard', 'soft', 'pairs']); }
        },
        {
            id: 'running-count', order: 2, title: 'Running Count',
            tagline: 'Track the count — Speed Count & running checks',
            icon: 'fa-bolt', minSamples: 15,
            compute: function (lifetime) { return combinedAccuracy(lifetime, ['count-speed', 'count-running']); }
        },
        {
            id: 'count-strategy', order: 3, title: 'Count + Strategy',
            tagline: 'Play full hands while keeping the count',
            icon: 'fa-object-group', minSamples: 20,
            // See file header: approximated as min(basic %, running-count %).
            compute: function (lifetime) {
                var basic = combinedAccuracy(lifetime, ['hard', 'soft', 'pairs']);
                var count = combinedAccuracy(lifetime, ['count-running']);
                var samples = Math.min(basic.samples, count.samples);
                if (basic.pct === null || count.pct === null) return { pct: null, samples: samples };
                return { pct: Math.min(basic.pct, count.pct), samples: samples };
            }
        },
        {
            id: 'true-count', order: 4, title: 'True Count',
            tagline: 'Convert running count into true count',
            icon: 'fa-divide', minSamples: 10,
            compute: function (lifetime) { return combinedAccuracy(lifetime, ['count-true']); }
        },
        {
            id: 'deviations', order: 5, title: 'Deviations',
            tagline: 'Full Test Out — strategy, true count & Illustrious 18',
            icon: 'fa-crown', minSamples: 20,
            compute: function (lifetime) { return combinedAccuracy(lifetime, ['testout']); }
        }
    ];

    /**
     * The full ladder, each stage resolved to a status:
     *   'not-started' (0 samples) | 'in-progress' (samples but not mastered
     *   or below minSamples) | 'mastered' (>= minSamples AND pct >= 90).
     * `currentStageId` is the first non-mastered stage — the "what's next"
     * recommendation — or the last stage once everything is mastered.
     */
    function getLadderStatus() {
        var lifetime = Storage.getLifetimeStats();
        var stages = LADDER_STAGES.map(function (stage) {
            var result = stage.compute(lifetime);
            var eligible = result.samples >= stage.minSamples;
            var status = (result.pct !== null && eligible && result.pct >= MASTERY_THRESHOLD_PCT)
                ? 'mastered'
                : (result.samples > 0 ? 'in-progress' : 'not-started');
            return {
                id: stage.id, order: stage.order, title: stage.title, tagline: stage.tagline, icon: stage.icon,
                pct: result.pct, samples: result.samples, minSamples: stage.minSamples, status: status
            };
        });
        var masteredCount = stages.filter(function (s) { return s.status === 'mastered'; }).length;
        var current = stages.filter(function (s) { return s.status !== 'mastered'; })[0] || stages[stages.length - 1];
        return {
            stages: stages,
            masteredCount: masteredCount,
            currentStageId: current.id,
            rankTitle: RANK_TITLES[Math.max(0, Math.min(RANK_TITLES.length - 1, masteredCount))]
        };
    }

    // ------------------------------------------------------------------
    // achievements
    // ------------------------------------------------------------------

    /**
     * `check(ctx)` receives `{ lifetime, progression, ladder }` (all fresh
     * reads). `stageBonus`, if present, is extra XP awarded ONLY the moment
     * this achievement is newly unlocked — ladder-stage milestones are
     * bigger deals than a single correct decision, so they pay out more
     * than the steady +1-XP-per-correct-decision trickle.
     */
    var ACHIEVEMENTS = [
        { id: 'first-steps', title: 'First Steps', description: 'Complete your first graded decision.', icon: 'fa-shoe-prints',
            check: function (ctx) { return ctx.lifetime.decisionsTotal >= 1; } },
        { id: 'century', title: 'Century', description: '100 lifetime decisions.', icon: 'fa-medal',
            check: function (ctx) { return ctx.lifetime.decisionsTotal >= 100; } },
        { id: 'millennium', title: 'Millennium', description: '1,000 lifetime decisions.', icon: 'fa-trophy',
            check: function (ctx) { return ctx.lifetime.decisionsTotal >= 1000; } },
        { id: 'hot-streak', title: 'Hot Streak', description: '10 correct decisions in a row.', icon: 'fa-fire',
            check: function (ctx) { return ctx.progression.bestStreak >= 10; } },
        { id: 'iron-focus', title: 'Iron Focus', description: '25 correct decisions in a row.', icon: 'fa-bullseye',
            check: function (ctx) { return ctx.progression.bestStreak >= 25; } },
        { id: 'sharp-eyes', title: 'Sharp Eyes', description: 'First correct Deck Estimation.', icon: 'fa-ruler-vertical',
            check: function (ctx) { return ((ctx.lifetime.byMode || {}).estimation || {}).correct >= 1; } },
        { id: 'quick-count', title: 'Quick Count', description: 'First correct Speed Count.', icon: 'fa-bolt',
            check: function (ctx) { return ((ctx.lifetime.byMode || {})['count-speed'] || {}).correct >= 1; } },
        { id: 'true-believer', title: 'True Believer', description: 'First correct True Count check.', icon: 'fa-divide',
            check: function (ctx) { return ((ctx.lifetime.byMode || {})['count-true'] || {}).correct >= 1; } },
        { id: 'steady-hand', title: 'Steady Hand', description: 'First correct running-count check.', icon: 'fa-hand-paper',
            check: function (ctx) { return ((ctx.lifetime.byMode || {})['count-running'] || {}).correct >= 1; } },
        { id: 'stage-basic', title: 'Basic Strategy Master', description: 'Mastered the Basic Strategy stage.', icon: 'fa-hashtag', stageBonus: STAGE_XP_BONUS,
            check: function (ctx) { return ctx.ladder.stages[0].status === 'mastered'; } },
        { id: 'stage-count', title: 'Counter', description: 'Mastered the Running Count stage.', icon: 'fa-bolt', stageBonus: STAGE_XP_BONUS,
            check: function (ctx) { return ctx.ladder.stages[1].status === 'mastered'; } },
        { id: 'stage-combo', title: 'Advantage Player', description: 'Mastered Count + Strategy.', icon: 'fa-object-group', stageBonus: STAGE_XP_BONUS,
            check: function (ctx) { return ctx.ladder.stages[2].status === 'mastered'; } },
        { id: 'stage-truecount', title: 'Card Sharp', description: 'Mastered True Count.', icon: 'fa-divide', stageBonus: STAGE_XP_BONUS,
            check: function (ctx) { return ctx.ladder.stages[3].status === 'mastered'; } },
        { id: 'stage-deviations', title: 'Master Counter', description: 'Mastered every stage of the ladder.', icon: 'fa-crown', stageBonus: LADDER_COMPLETE_XP_BONUS,
            check: function (ctx) { return ctx.ladder.masteredCount === 5; } }
    ];

    function addXP(amount) {
        var p = Storage.getProgression();
        p.xp += amount;
        Storage.setProgression(p);
    }

    /** Runs every achievement check; unlocks (idempotently) whatever newly qualifies. */
    function checkAchievements() {
        var lifetime = Storage.getLifetimeStats();
        var progression = Storage.getProgression();
        var ladder = getLadderStatus();
        var ctx = { lifetime: lifetime, progression: progression, ladder: ladder };
        var unlocked = [];
        ACHIEVEMENTS.forEach(function (def) {
            var qualifies = false;
            try { qualifies = !!def.check(ctx); } catch (err) { qualifies = false; } // a malformed bucket must never crash the game loop
            if (!qualifies) return;
            var entry = Storage.unlockAchievement(def.id);
            if (entry) {
                unlocked.push(Object.assign({ title: def.title, description: def.description, icon: def.icon }, entry));
                if (def.stageBonus) addXP(def.stageBonus);
            }
        });
        return unlocked;
    }

    // ------------------------------------------------------------------
    // daily challenge
    // ------------------------------------------------------------------

    var CHALLENGE_TEMPLATES = [
        { id: 'ten-correct', title: 'Sharp Start', description: 'Get 10 correct decisions today (any mode).', target: 10, event: 'correct-decision' },
        { id: 'five-streak', title: 'Streak Seeker', description: 'Reach a 5-correct streak today.', target: 5, event: 'streak' },
        { id: 'count-check', title: 'Count Practice', description: 'Nail 1 count check today (running or true).', target: 1, event: 'count-check-correct' },
        { id: 'drill-fifteen', title: 'Drill Sergeant', description: 'Complete 15 strategy-drill decisions today.', target: 15, event: 'drill-decision' },
        { id: 'speed-run', title: 'Speed Demon', description: 'Finish a correct Speed Count run today.', target: 1, event: 'speed-count-correct' },
        { id: 'five-hands', title: 'Full Table', description: 'Play 5 hands in Test Out today.', target: 5, event: 'hand-played' }
    ];

    /** Player-local calendar day (never UTC — "today" means the player's own clock). */
    function todayStr() {
        var d = new Date();
        var pad = function (n) { return n < 10 ? '0' + n : String(n); };
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    }

    /** Small deterministic hash so the same date always picks the same template — no RNG needed. */
    function hashStr(s) {
        var h = 0;
        for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
        return Math.abs(h);
    }

    function pickTemplateForDate(dateStr) {
        return CHALLENGE_TEMPLATES[hashStr(dateStr) % CHALLENGE_TEMPLATES.length];
    }

    function templateById(id) {
        for (var i = 0; i < CHALLENGE_TEMPLATES.length; i++) if (CHALLENGE_TEMPLATES[i].id === id) return CHALLENGE_TEMPLATES[i];
        return null;
    }

    /** Returns today's challenge, rolling a fresh deterministic one if the stored one is from a prior day (or missing). */
    function getTodayChallenge() {
        var today = todayStr();
        var existing = Storage.getChallenge();
        if (existing && existing.date === today) return existing;
        var tpl = pickTemplateForDate(today);
        var fresh = { date: today, templateId: tpl.id, progress: 0, target: tpl.target, completed: false, completedAt: null };
        Storage.setChallenge(fresh);
        return fresh;
    }

    /**
     * Feeds one gameplay event into today's challenge, if it's the type
     * today's challenge cares about. No-ops harmlessly for every other
     * event type/an already-completed challenge, so callers can fire every
     * event type unconditionally without checking what's active.
     */
    function recordChallengeEvent(eventType, amount) {
        amount = amount == null ? 1 : amount;
        var challenge = getTodayChallenge();
        if (challenge.completed) return { completedNow: false, challenge: challenge };
        var tpl = templateById(challenge.templateId);
        if (!tpl || tpl.event !== eventType) return { completedNow: false, challenge: challenge };

        // 'streak' tracks the PEAK value reached today, not a running sum —
        // every other event type accumulates.
        challenge.progress = eventType === 'streak' ? Math.max(challenge.progress, amount) : challenge.progress + amount;

        var completedNow = false;
        if (challenge.progress >= challenge.target) {
            challenge.completed = true;
            challenge.completedAt = Date.now();
            completedNow = true;
            addXP(CHALLENGE_XP_REWARD);
        }
        Storage.setChallenge(challenge);
        return { completedNow: completedNow, challenge: challenge };
    }

    // ------------------------------------------------------------------
    // public API
    // ------------------------------------------------------------------

    var Gamification = {
        MASTERY_THRESHOLD_PCT: MASTERY_THRESHOLD_PCT,
        LADDER_STAGES: LADDER_STAGES,
        ACHIEVEMENTS: ACHIEVEMENTS,
        CHALLENGE_TEMPLATES: CHALLENGE_TEMPLATES,

        getLadderStatus: getLadderStatus,
        getTodayChallenge: getTodayChallenge,

        /**
         * Plain display data for a challenge object — shared by path-render.js
         * (compact) and profile-render.js (full), so the template-lookup
         * logic lives once instead of being duplicated in two render files.
         */
        describeChallenge: function (challenge) {
            var tpl = templateById(challenge.templateId) || { title: 'Challenge', description: '' };
            return {
                title: tpl.title,
                description: tpl.description,
                progress: Math.min(challenge.progress, challenge.target),
                target: challenge.target,
                pct: challenge.target > 0 ? Math.round((Math.min(challenge.progress, challenge.target) / challenge.target) * 100) : 0,
                completed: !!challenge.completed
            };
        },

        getLevel: function (xp) { return 1 + Math.floor((xp || 0) / XP_PER_LEVEL); },
        getXPIntoLevel: function (xp) { return (xp || 0) % XP_PER_LEVEL; },
        getXPPerLevel: function () { return XP_PER_LEVEL; },

        /**
         * THE hook — call once per graded decision, from
         * GameManager._recordDecision, AFTER the lifetime stats bucket for
         * this decision has already been persisted (so the achievement/
         * ladder checks below see the up-to-date numbers).
         *
         * @returns {{achievements: Array, challengeCompletions: Array}}
         */
        onDecision: function (mode, correct) {
            var p = Storage.getProgression();
            if (correct) {
                p.xp += 1;
                p.currentStreak += 1;
                if (p.currentStreak > p.bestStreak) p.bestStreak = p.currentStreak;
            } else {
                p.currentStreak = 0;
            }
            Storage.setProgression(p);

            var completions = [];
            var note = function (r) { if (r.completedNow) completions.push(r.challenge); };

            if (correct) note(recordChallengeEvent('correct-decision'));
            note(recordChallengeEvent('streak', p.currentStreak));
            if (STRATEGY_DRILL_MODES[mode]) note(recordChallengeEvent('drill-decision'));
            if (correct && (mode === 'count-running' || mode === 'count-true')) note(recordChallengeEvent('count-check-correct'));
            if (correct && mode === 'count-speed') note(recordChallengeEvent('speed-count-correct'));

            return { achievements: checkAchievements(), challengeCompletions: completions };
        },

        /** Call once per resolved Test-Out hand (game-manager.js's round-resolution paths). */
        recordHandPlayed: function () {
            var r = recordChallengeEvent('hand-played');
            return r.completedNow ? [r.challenge] : [];
        }
    };

    BJ.Gamification = Gamification;

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = Gamification;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
