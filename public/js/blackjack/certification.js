// ==========================================
// certification.js — the Basic Strategy Certification: 500 hands at 98%.
//
// DOM-free and side-effect-free on purpose. Every function here takes an
// attempt record and returns a new value or mutates only that record; nothing
// reads storage, nothing emits, nothing renders. That is what lets the whole
// threshold model be tested against literal numbers instead of against a
// running game — and the threshold model is the part that must not be wrong,
// because it decides whether somebody passed.
//
// THE UNIT IS 500 HANDS, THE BAR IS 98% OF DECISIONS. Those are two different
// denominators and conflating them would silently change the difficulty: a
// hand is one deal, but it can carry several graded decisions (hit, hit,
// stand), and a split or a double adds more. So `handsPlayed` counts deals and
// `decisions`/`correct` count gradings, and the pass mark reads the latter.
//
// IT ALWAYS FINISHES. Once 98% is arithmetically out of reach the attempt does
// NOT end — `stillAchievable` goes false and the UI says so plainly, but the
// remaining hands are still dealt and still graded. An attempt that died at
// hand 140 teaches nothing about hands 140-500, and the leak report is the
// half of this that is useful whether you passed or not.
// ==========================================

(function (root) {
    'use strict';

    var BJ = (typeof window !== 'undefined')
        ? (window.BJ = window.BJ || {})
        : (root.BJ = root.BJ || {});

    var TARGET_HANDS = 500;
    var REQUIRED_PCT = 98;

    // Floating point: 0.98 * 100 does not always land on exactly 98, and a
    // player who got precisely 98.0% must not fail on a representation error.
    var EPS = 1e-9;

    // Keeping every mistake of a 500-hand attempt would be ~600 entries in a
    // store that is read whole on every load. The cap is generous enough for a
    // real leak report and bounded enough not to bloat the file.
    var MISTAKE_CAP = 120;

    function newAttempt(now) {
        var t = now || Date.now();
        return {
            id: 'cert_' + t,
            startedAt: t,
            handsPlayed: 0,
            decisions: 0,
            correct: 0,
            mistakes: [],
            verdict: 'active',      // 'active' | 'passed' | 'failed'
            finishedAt: null
        };
    }

    /**
     * The whole live picture of an attempt. Pure: give it the same record and
     * it gives the same answer.
     */
    function status(attempt) {
        if (!attempt) return null;

        var handsLeft = Math.max(0, TARGET_HANDS - attempt.handsPlayed);
        var accuracy = attempt.decisions > 0
            ? (attempt.correct / attempt.decisions) * 100
            : null;

        // Best case from here: every remaining hand yields AT LEAST one more
        // decision, and every one of them is correct. Using one-per-hand is
        // what makes this a genuine bound rather than a guess — a hand can
        // produce more decisions than that, and more decisions can only ever
        // make the ceiling harder to reach, never easier.
        var bestDecisions = attempt.decisions + handsLeft;
        var bestPossible = bestDecisions > 0
            ? ((attempt.correct + handsLeft) / bestDecisions) * 100
            : 100;

        var misses = attempt.decisions - attempt.correct;
        var complete = attempt.handsPlayed >= TARGET_HANDS;
        var stillAchievable = bestPossible + EPS >= REQUIRED_PCT;

        return {
            handsPlayed: attempt.handsPlayed,
            handsLeft: handsLeft,
            targetHands: TARGET_HANDS,
            requiredPct: REQUIRED_PCT,
            decisions: attempt.decisions,
            correct: attempt.correct,
            misses: misses,
            accuracy: accuracy,
            // How many more misses the CURRENT decision count could absorb and
            // still finish at 98%. Reported as a live budget because "you have
            // 4 misses left" is a sentence a player can act on, where "97.9%"
            // is one they have to do arithmetic on.
            missBudget: Math.max(0, Math.floor(attempt.decisions * (1 - REQUIRED_PCT / 100)) - misses),
            bestPossible: bestPossible,
            stillAchievable: stillAchievable,
            complete: complete,
            verdict: attempt.verdict,
            pct: Math.round((attempt.handsPlayed / TARGET_HANDS) * 100)
        };
    }

    /**
     * Records one graded decision. `mistake` is the structured mistake-log
     * entry when the decision was wrong, and is kept for the leak report.
     */
    function recordDecision(attempt, correct, mistake) {
        if (!attempt || attempt.verdict !== 'active') return attempt;
        attempt.decisions++;
        if (correct) {
            attempt.correct++;
        } else if (mistake) {
            attempt.mistakes.push(mistake);
            while (attempt.mistakes.length > MISTAKE_CAP) attempt.mistakes.shift();
        }
        return attempt;
    }

    /**
     * Records one completed hand, and finalises the attempt on the 500th.
     * Deliberately does NOT end early when the bar becomes unreachable — see
     * the header.
     */
    function recordHand(attempt, now) {
        if (!attempt || attempt.verdict !== 'active') return attempt;
        attempt.handsPlayed++;
        if (attempt.handsPlayed >= TARGET_HANDS) finalize(attempt, now);
        return attempt;
    }

    /** Attaches a structured mistake-log entry to the attempt's leak report. */
    function noteMistake(attempt, entry) {
        if (!attempt || attempt.verdict !== 'active' || !entry) return attempt;
        attempt.mistakes.push(entry);
        while (attempt.mistakes.length > MISTAKE_CAP) attempt.mistakes.shift();
        return attempt;
    }

    function finalize(attempt, now) {
        if (!attempt || attempt.verdict !== 'active') return attempt;
        var accuracy = attempt.decisions > 0 ? (attempt.correct / attempt.decisions) * 100 : 0;
        attempt.verdict = (accuracy + EPS >= REQUIRED_PCT) ? 'passed' : 'failed';
        attempt.finishedAt = now || Date.now();
        return attempt;
    }

    /**
     * Groups an attempt's mistakes into a leak report — which hand types and
     * which dealer upcards actually cost the attempt, worst first. This is the
     * part worth reading whether the attempt passed or not.
     */
    function leakReport(attempt) {
        if (!attempt || !attempt.mistakes || !attempt.mistakes.length) return [];
        var buckets = {};
        attempt.mistakes.forEach(function (m) {
            var key = (m.handDescription || 'Unknown') + ' vs ' + (m.dealerUpcard === 11 ? 'A' : m.dealerUpcard);
            if (!buckets[key]) {
                buckets[key] = { key: key, hand: m.handDescription || 'Unknown', dealer: m.dealerUpcard, count: 0, played: m.playerAction, correct: m.correctAction };
            }
            buckets[key].count++;
        });
        return Object.keys(buckets)
            .map(function (k) { return buckets[k]; })
            .sort(function (a, b) { return b.count - a.count; });
    }

    var Certification = {
        TARGET_HANDS: TARGET_HANDS,
        REQUIRED_PCT: REQUIRED_PCT,
        MISTAKE_CAP: MISTAKE_CAP,
        newAttempt: newAttempt,
        status: status,
        recordDecision: recordDecision,
        noteMistake: noteMistake,
        recordHand: recordHand,
        finalize: finalize,
        leakReport: leakReport
    };

    BJ.Certification = Certification;

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = Certification;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
