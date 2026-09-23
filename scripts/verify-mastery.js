// ============================================================================
// verify-mastery.js — per-section mastery, checkouts, and rust.
//
// The threshold model is the part that must not be wrong: it decides whether
// somebody is told they are ready to sit at a table for money. The previous
// model certified "Basic Strategy" at 90% over 30 POOLED decisions, which is
// below the published rate at which a repeated basic-strategy error cancels a
// counter's edge (one in twenty, i.e. 95%) — and which could be reached
// without ever being shown a soft hand or a pair. Both of those are pinned
// here explicitly, because both were silent.
//
// Run: node scripts/verify-mastery.js
// ============================================================================

const path = require('path');
const BASE = path.join(__dirname, '../public/js/blackjack');

// persistence.js is a localStorage wrapper and degrades to "return the
// fallback, write nothing" without one — which would make every assertion
// below pass vacuously against a store that never remembers anything. An
// in-memory shim is installed BEFORE it is required so the real read/write
// path is the one under test.
const mem = new Map();
globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
    clear: () => mem.clear()
};

const Storage = require(path.join(BASE, 'persistence.js'));
globalThis.BJ = { Storage };
const M = require(path.join(BASE, 'mastery.js'));

let failures = 0;
const ok = (m) => console.log('  OK   ' + m);
const fail = (m) => { console.log('  FAIL ' + m); failures++; };
const eq = (a, b, m) => (a === b ? ok(`${m} (${JSON.stringify(a)})`) : fail(`${m} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`));

function reset() { mem.clear(); }

/** Writes `total` decisions with `correct` of them right into a lifetime mode bucket. */
function seed(mode, total, correct) {
    const lt = Storage.getLifetimeStats();
    lt.byMode[mode] = { total, correct };
    lt.decisionsTotal = (lt.decisionsTotal || 0) + total;
    lt.decisionsCorrect = (lt.decisionsCorrect || 0) + correct;
    Storage.setLifetimeStats(lt);
}

/** Fills a mode's rolling-form buffer with `n` results, `wrong` of them misses. */
function seedForm(mode, n, wrong) {
    for (let i = 0; i < n; i++) Storage.pushRollingResult(mode, i >= wrong);
}

const sec = (status, id) => status.sections.filter((s) => s.id === id)[0];

console.log('-- the sections are independent --');
{
    reset();
    // The exact shape of the old bug: plenty of hard totals, nothing else.
    seed('hard', 600, 600);
    const st = M.getStatus();
    eq(sec(st, 'hard').status, 'ready', 'hard totals reaches ready on its own volume');
    eq(sec(st, 'soft').status, 'not-started', 'soft totals is untouched by hard-total volume');
    eq(sec(st, 'pairs').status, 'not-started', 'pairs is untouched too');
    eq(sec(st, 'soft').decisions, 0, 'and soft has genuinely zero decisions, not a share of hard');
    eq(st.masteredCount, 0, 'nothing is mastered on volume alone — a checkout is still owed');
}

console.log('\n-- the bar is above the edge-erasure line --');
{
    eq(M.EDGE_LINE_PCT, 95, 'the floor is 95% — one error in twenty, where the counting edge dies');
    eq(M.CHECKOUT_REQUIRED_PCT, 100, 'a checkout is flawless');

    reset();
    // 90% was the OLD mastery bar. It must not even open a checkout now.
    seed('hard', 600, 540);
    eq(sec(M.getStatus(), 'hard').status, 'in-progress', '90% accuracy does not open the checkout');
    eq(sec(M.getStatus(), 'hard').aboveLine, false, 'and is explicitly reported as below the line');

    reset();
    seed('hard', 600, 570);
    eq(sec(M.getStatus(), 'hard').status, 'ready', 'exactly 95% does open it');
}

console.log('\n-- volume and accuracy are both required, and the gap says which is missing --');
{
    reset();
    seed('hard', 100, 100);
    const s = sec(M.getStatus(), 'hard');
    eq(s.status, 'in-progress', 'perfect accuracy on too few decisions is not ready');
    eq(s.reason, '400 more decisions to unlock', 'the gap names the volume shortfall');

    reset();
    seed('hard', 600, 500);
    eq(sec(M.getStatus(), 'hard').reason.indexOf('checkout opens at 95%') > -1, true,
        'and names the accuracy shortfall when volume is met');

    // EVERY reason must fit the Path card's one line — about 32 characters
    // beside the action buttons. They were full sentences once; all of them
    // wrapped, and four cards' worth of that second line pushed the Basic
    // Strategy column off the bottom of the screen. Asserted rather than
    // remembered, because the next person to add a state will write a
    // sentence and nothing on screen will obviously break.
    const LIMIT = 34;
    const seen = [];
    [
        () => { reset(); },                                             // not started
        () => { reset(); seed('hard', 100, 100); },                     // volume short
        () => { reset(); seed('hard', 600, 500); },                     // accuracy short
        () => { reset(); seed('hard', 600, 600); },                     // ready
        () => { reset(); seed('count-speed', 400, 400); }               // blocked (locked tier)
    ].forEach((setup) => {
        setup();
        M.getStatus().sections.forEach((x) => { if (x.reason) seen.push(x.reason); });
    });
    // mastered + rusty, the two longest remaining states
    reset();
    seed('hard', 600, 600);
    M.startCheckout('hard', 1000);
    for (let i = 0; i < 50; i++) M.recordDecision('hard', true, 2000);
    seen.push(sec(M.getStatus(), 'hard').reason);
    seedForm('hard', M.RUST_WINDOW, 12);
    seen.push(sec(M.getStatus(), 'hard').reason);

    const tooLong = seen.filter((r) => r.length > LIMIT);
    eq(tooLong.length, 0, `every gap reason fits one line (<= ${LIMIT} chars); checked ${seen.length}`);
    if (tooLong.length) tooLong.forEach((r) => console.log('         too long: ' + JSON.stringify(r)));

    // The taglines share that line's width budget and wrapped for the same
    // reason.
    const longTags = M.SECTIONS.filter((x) => x.tagline.length > LIMIT);
    eq(longTags.length, 0, 'and every section tagline does too');
}

console.log('\n-- checkouts are gated in tier order, practice never is --');
{
    reset();
    seed('count-speed', 400, 400);
    const s = sec(M.getStatus(), 'running-count');
    eq(s.status, 'ready', 'a counting section can reach ready on its own numbers');
    eq(s.tierUnlocked, false, 'but its tier is locked while basic strategy is unfinished');
    eq(s.checkoutAvailable, false, 'so no checkout is offered');
    eq(s.blocked, true, 'and blocked is reported separately from status, so the UI can say which');
    eq(M.startCheckout('running-count'), null, 'and the API refuses to open one behind the gate');
}

console.log('\n-- a checkout is flawless, bounded, and names the hand that broke it --');
{
    reset();
    seed('hard', 600, 600);
    const a = M.startCheckout('hard', 1000);
    eq(!!a, true, 'a checkout opens once the section is ready');
    eq(a.size, 50, 'hard totals is a 50-decision checkout');

    for (let i = 0; i < 49; i++) M.recordDecision('hard', true);
    eq(M.getActiveCheckout().verdict, 'active', '49 clean decisions is not yet a pass');
    M.recordDecision('hard', true, 2000);
    eq(M.getActiveCheckout().verdict, 'passed', 'the 50th closes it');
    eq(sec(M.getStatus(), 'hard').mastered, true, 'and the section is mastered');
    eq(sec(M.getStatus(), 'hard').status, 'mastered', 'with the status to match');
}
{
    reset();
    seed('soft', 500, 500);
    M.startCheckout('soft', 1000);
    for (let i = 0; i < 20; i++) M.recordDecision('soft', true);
    M.recordDecision('soft', false, 2000);
    const a = M.getActiveCheckout();
    eq(a.verdict, 'failed', 'one mistake ends it immediately');
    eq(a.decisions, 21, 'at the decision it happened on');
    eq(sec(M.getStatus(), 'soft').mastered, false, 'and nothing is certified');

    M.noteMistake({ handDescription: 'Soft 18', dealerUpcard: 9, playerAction: 'Stand', correctAction: 'Hit' });
    eq(M.getActiveCheckout().brokenBy.handDescription, 'Soft 18', 'the hand that broke it is attached');
    eq(sec(M.getStatus(), 'soft').bestRun, 20, 'and the clean run before it is kept as a best');
}

console.log('\n-- a checkout only consumes its OWN section --');
{
    reset();
    seed('hard', 600, 600);
    seed('pairs', 600, 600);
    M.startCheckout('hard', 1000);
    // The exact cheat this guard exists for: open a hard-totals checkout and
    // then go and answer fifty pair questions.
    for (let i = 0; i < 50; i++) M.recordDecision('pairs', true);
    eq(M.getActiveCheckout().decisions, 0, 'pair decisions do not advance a hard-totals checkout');
    eq(M.getActiveCheckout().verdict, 'active', 'so it cannot be passed on the wrong drill');
    eq(sec(M.getStatus(), 'hard').mastered, false, 'and hard totals stays uncertified');
}

console.log('\n-- mastery is permanent; rust is reported beside it --');
{
    reset();
    seed('hard', 600, 600);
    M.startCheckout('hard', 1000);
    for (let i = 0; i < 50; i++) M.recordDecision('hard', true, 2000);
    eq(sec(M.getStatus(), 'hard').mastered, true, 'certified');

    // A full window of recent form, 10 of it wrong — 90%, below the line.
    seedForm('hard', M.RUST_WINDOW, 10);
    const s = sec(M.getStatus(), 'hard');
    eq(s.rusty, true, 'a full window below 95% is rust');
    eq(s.status, 'rusty', 'and the status says so');
    eq(s.mastered, true, 'but the certification is NOT revoked');
    eq(M.getStatus().currentSectionId, 'hard', 'and a rusty section is what gets recommended next');
}
{
    reset();
    seed('soft', 500, 500);
    M.startCheckout('soft', 1000);
    for (let i = 0; i < 50; i++) M.recordDecision('soft', true, 2000);
    // Half a window, all of it bad. Not enough to call it.
    seedForm('soft', 20, 20);
    const s = sec(M.getStatus(), 'soft');
    eq(s.formSamples, 20, 'a partial window is reported');
    eq(s.rusty, false, 'but does not trigger rust — it would flap on two or three results');
    eq(s.status, 'mastered', 'so the section still reads as mastered');
}

console.log('\n-- the rolling window cannot silently outgrow its buffer --');
{
    // These two constants live in different files and must stay compatible.
    // If the buffer were ever shortened below the window, a single-mode
    // section could never report a full window and rust would quietly stop
    // existing — with nothing failing to say so.
    eq(M.RUST_WINDOW <= Storage.ROLLING_FORM_CAP, true,
        'the rust window fits inside the stored buffer');
    reset();
    seedForm('hard', Storage.ROLLING_FORM_CAP + 50, 0);
    const form = Storage.getRollingForm();
    eq(form.hard.length, Storage.ROLLING_FORM_CAP, 'the buffer is capped, oldest dropped first');
}

console.log('\n-- the countdown checkout accrues across runs --');
{
    reset();
    // Every basic-strategy section mastered, so the counting tier is open.
    for (const [id, mode, vol, size] of [
        ['hard', 'hard', 600, 50], ['soft', 'soft', 500, 50],
        ['pairs', 'pairs', 500, 50], ['surrender', 'surrender', 200, 25]
    ]) {
        seed(mode, vol, vol);
        M.startCheckout(id, 1000);
        for (let i = 0; i < size; i++) M.recordDecision(mode, true, 2000);
    }
    eq(M.getStatus().masteredCount, 4, 'all four basic-strategy sections are mastered');
    M.clearCheckout();

    seed('count-speed', 400, 400);
    eq(sec(M.getStatus(), 'running-count').tierUnlocked, true, 'which unlocks the counting tier');
    eq(M.startCheckout('running-count'), null, 'the countdown checkout has no attempt object to open');

    eq(M.syncCountdownCheckout(4), false, 'four clean runs is not the bar');
    eq(M.syncCountdownCheckout(5, 3000), true, 'five clean runs in a row is');
    eq(sec(M.getStatus(), 'running-count').mastered, true, 'and certifies the section');
    eq(M.syncCountdownCheckout(6, 4000), false, 'a sixth is idempotent, not a second unlock');
}

console.log('\n-- the final gate is eight shoes, near error-free, resumable --');
{
    reset();
    const def = M.definitionFor('full-game');
    eq(def.checkout.kind, 'shoes', 'the final checkout is counted in shoes');
    eq(def.checkout.size, 8, 'eight of them');
    eq(M.FINAL_REQUIRED_PCT, 99, 'held to 99%, not 100 — several hundred decisions is stamina, not recall');
}

console.log('\n-- abandoning keeps the best run and clears the attempt --');
{
    reset();
    seed('pairs', 500, 500);
    M.startCheckout('pairs', 1000);
    for (let i = 0; i < 12; i++) M.recordDecision('pairs', true);
    M.abortCheckout();
    eq(M.getActiveCheckout(), null, 'the attempt is gone');
    eq(sec(M.getStatus(), 'pairs').bestRun, 12, 'the clean run it reached is kept');
    eq(sec(M.getStatus(), 'pairs').attempts, 1, 'and the attempt is counted');
}

console.log('\n-- volume totals are a real grind --');
{
    const basic = M.SECTIONS.filter((s) => s.tier === 'basic');
    const total = basic.reduce((n, s) => n + s.volume, 0);
    eq(total, 1450, 'basic strategy asks for 1,450 decisions before a single checkout opens');
    eq(total > 30 * 40, true, 'which is more than forty times the old 30-decision bar');
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} CHECK(S) FAILED.`);
process.exitCode = failures === 0 ? 0 : 1;
