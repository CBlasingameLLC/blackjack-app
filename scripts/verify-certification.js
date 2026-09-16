// ============================================================================
// verify-certification.js — the Basic Strategy Certification.
//
// The threshold model is the part that must not be wrong: it decides whether
// somebody passed a 500-hand exam. So it is tested against literal numbers
// here rather than against a running game, and the two denominators (hands
// dealt vs decisions graded) are pinned apart explicitly, because conflating
// them is the one mistake that would silently change the pass mark.
//
// Run: node scripts/verify-certification.js
// ============================================================================

const path = require('path');
const BASE = path.join(__dirname, '../public/js/blackjack');
const C = require(path.join(BASE, 'certification.js'));

let failures = 0;
const ok = (m) => console.log('  OK   ' + m);
const fail = (m) => { console.log('  FAIL ' + m); failures++; };
const eq = (a, b, m) => (a === b ? ok(`${m} (${JSON.stringify(a)})`) : fail(`${m} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`));

/** Plays `hands` hands with `decisionsPerHand` gradings each, missing `misses`. */
function simulate(hands, decisionsPerHand, misses) {
    const a = C.newAttempt(1000);
    let left = misses;
    for (let h = 0; h < hands; h++) {
        for (let d = 0; d < decisionsPerHand; d++) {
            const wrong = left > 0;
            if (wrong) left--;
            C.recordDecision(a, !wrong, wrong ? { handDescription: 'Hard 16', dealerUpcard: 10, playerAction: 'Hit', correctAction: 'Stand' } : null);
        }
        C.recordHand(a, 2000);
    }
    return a;
}

console.log('-- shape --');
{
    const a = C.newAttempt(1000);
    eq(C.TARGET_HANDS, 500, 'the exam is 500 hands');
    eq(C.REQUIRED_PCT, 98, 'the bar is 98%');
    eq(a.verdict, 'active', 'a new attempt starts active');
    const s = C.status(a);
    eq(s.handsLeft, 500, 'a fresh attempt has all 500 hands left');
    eq(s.accuracy, null, 'accuracy is null, NOT 0, before a single decision');
    eq(s.stillAchievable, true, 'a fresh attempt can still pass');
}

console.log('\n-- hands and decisions are DIFFERENT denominators --');
{
    // 10 hands, 3 gradings each = 30 decisions. Reading 98% off the hand count
    // instead of the decision count would be a completely different exam.
    const a = simulate(10, 3, 0);
    eq(a.handsPlayed, 10, 'hands counts deals');
    eq(a.decisions, 30, 'decisions counts gradings, not deals');
    eq(C.status(a).accuracy, 100, 'all correct reads as 100%');
}

console.log('\n-- the pass mark --');
{
    // 500 hands x 1 decision, 10 misses -> 490/500 = 98.0% exactly.
    const exact = simulate(500, 1, 10);
    eq(exact.decisions, 500, '500 decisions');
    eq(C.status(exact).accuracy, 98, 'exactly 98.0%');
    // The float-safety case: 98.0% must not fail on a representation error.
    eq(exact.verdict, 'passed', 'EXACTLY 98% passes (the boundary is inclusive)');

    const justUnder = simulate(500, 1, 11);
    eq(Math.round(C.status(justUnder).accuracy * 10) / 10, 97.8, 'one more miss drops below the bar');
    eq(justUnder.verdict, 'failed', 'just under 98% fails');

    const clean = simulate(500, 1, 0);
    eq(clean.verdict, 'passed', 'a clean run passes');
}

console.log('\n-- it ALWAYS finishes, even once the bar is out of reach --');
{
    // 100 hands in, 40 misses: nothing in the remaining 400 hands can rescue
    // 98%, but the attempt must keep dealing.
    const a = C.newAttempt(1000);
    for (let h = 0; h < 100; h++) {
        C.recordDecision(a, h >= 40);  // first 40 wrong
        C.recordHand(a, 2000);
    }
    const s = C.status(a);
    eq(s.stillAchievable, false, 'the model reports the bar is unreachable');
    eq(s.verdict, 'active', 'but the attempt is STILL ACTIVE — it is not ended early');
    eq(s.handsLeft, 400, 'and all 400 remaining hands are still to be dealt');

    // Keep going; it finishes and fails honestly.
    for (let h = 0; h < 400; h++) { C.recordDecision(a, true); C.recordHand(a, 3000); }
    eq(a.verdict, 'failed', 'it finishes with an honest verdict rather than an early exit');
    eq(a.handsPlayed, 500, 'all 500 hands were actually played');
}

console.log('\n-- the achievability bound is a real bound, not a guess --');
{
    // 499 hands, 1 decision each, 10 misses -> 489/499. One hand left, so the
    // best possible finish is 490/500 = 98.0%: still exactly achievable.
    const a = simulate(499, 1, 10);
    const s = C.status(a);
    eq(s.handsLeft, 1, 'one hand left');
    eq(Math.round(s.bestPossible * 100) / 100, 98, 'best possible finish is exactly 98%');
    eq(s.stillAchievable, true, 'so it is still achievable — the bound does not round the player out');

    const b = simulate(499, 1, 11);
    eq(C.status(b).stillAchievable, false, 'one more miss and even a perfect last hand cannot reach it');
}

console.log('\n-- the live miss budget --');
{
    const a = simulate(100, 1, 0);
    eq(C.status(a).missBudget, 2, '100 clean decisions can absorb 2 misses and still finish at 98%');
    const b = simulate(100, 1, 2);
    eq(C.status(b).missBudget, 0, 'after 2 misses the budget at that decision count is spent');
}

console.log('\n-- resumability --');
{
    // The record is a plain object, so "resume" is just: do not throw it away.
    // Round-tripping through JSON is what actually happens between sessions.
    const a = simulate(120, 2, 3);
    const revived = JSON.parse(JSON.stringify(a));
    const s1 = C.status(a), s2 = C.status(revived);
    eq(s2.handsPlayed, s1.handsPlayed, 'hands survive a serialize/deserialize round trip');
    eq(s2.decisions, s1.decisions, 'decisions survive too');
    eq(s2.accuracy, s1.accuracy, 'and the accuracy is identical after reviving');
    C.recordHand(revived, 4000);
    eq(revived.handsPlayed, s1.handsPlayed + 1, 'a revived attempt keeps accumulating');
}

console.log('\n-- the leak report --');
{
    const a = C.newAttempt(1000);
    const mk = (hand, dealer) => ({ handDescription: hand, dealerUpcard: dealer, playerAction: 'Hit', correctAction: 'Stand' });
    C.noteMistake(a, mk('Hard 16', 10));
    C.noteMistake(a, mk('Hard 16', 10));
    C.noteMistake(a, mk('Hard 16', 10));
    C.noteMistake(a, mk('Soft 18', 9));
    const leaks = C.leakReport(a);
    eq(leaks[0].key, 'Hard 16 vs 10', 'the worst leak is reported first');
    eq(leaks[0].count, 3, 'and carries how often it cost you');
    eq(leaks.length, 2, 'distinct situations stay distinct');

    const ace = C.newAttempt(1000);
    C.noteMistake(ace, mk('Hard 16', 11));
    eq(C.leakReport(ace)[0].key, 'Hard 16 vs A', 'an ace upcard reads as A, not 11');
}

console.log('\n-- a finished attempt is closed --');
{
    const a = simulate(500, 1, 0);
    const handsAtFinish = a.handsPlayed;
    C.recordHand(a, 5000);
    C.recordDecision(a, false);
    eq(a.handsPlayed, handsAtFinish, 'a finished attempt does not accept more hands');
    eq(a.verdict, 'passed', 'and its verdict cannot be rewritten after the fact');
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
