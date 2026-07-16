// ==========================================
// scripts/verify-strategy-chart.js
//
// Independent Node-based cross-check for basic strategy correctness
// (plan §6.2). NOT part of the Eleventy build — nothing under scripts/
// is passthrough-copied by .eleventy.js, so this never ships to _site.
//
// The REFERENCE table below is transcribed from memory of the standard
// published S17 / 6-deck / DAS / late-surrender basic strategy chart
// (the commonly-cited Wizard of Odds / Blackjack Apprenticeship chart for
// this exact ruleset) directly into this script — it is NOT copy-pasted
// from strategy-data.js, so a match is a genuine independent cross-check,
// not a tautology.
//
// It diffs every cell against BJ.StrategyData (hard/soft/pair/surrender),
// printing every mismatch rather than stopping at the first, and then
// constructs the specific bug #2 collision-regression cases (pair 8,8 vs
// dealer 10 must never resolve as a hard-16 deviation; soft 16 = A,5 vs
// dealer 10 must never resolve as a hard-16 deviation) via
// StrategyEngine.getOptimalPlay().
// ==========================================

'use strict';

const path = require('path');

const StrategyData = require(path.join(__dirname, '../public/js/blackjack/strategy-data.js'));
const StrategyEngine = require(path.join(__dirname, '../public/js/blackjack/strategy-engine.js'));

let mismatches = 0;
let cellsChecked = 0;

function reportMismatch(table, key, dealerLabel, expected, actual) {
    mismatches++;
    console.error(
        `MISMATCH  [${table}] ${key} vs dealer ${dealerLabel}: ` +
        `reference expects '${expected}', strategy-data.js has '${actual}'`
    );
}

// Dealer upcards in the same order as strategy-data.js's array indexing.
const DEALER_LABELS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'A'];

// --- Independently-transcribed reference tables -----------------------

// HARD TOTALS, 2-card and post-hit totals 5-21, vs dealer [2..A].
const REF_HARD = {
    5:  'H H H H H H H H H H',
    6:  'H H H H H H H H H H',
    7:  'H H H H H H H H H H',
    8:  'H H H H H H H H H H',
    9:  'H D D D D H H H H H',
    10: 'D D D D D D D D H H',
    11: 'D D D D D D D D D H',
    12: 'H H S S S H H H H H',
    13: 'S S S S S H H H H H',
    14: 'S S S S S H H H H H',
    15: 'S S S S S H H H H H',
    16: 'S S S S S H H H H H',
    17: 'S S S S S S S S S S',
    18: 'S S S S S S S S S S',
    19: 'S S S S S S S S S S',
    20: 'S S S S S S S S S S',
    21: 'S S S S S S S S S S'
};

// SOFT TOTALS, 2-card A,2 .. A,9 (totals 13-20), vs dealer [2..A].
const REF_SOFT = {
    13: 'H H H D D H H H H H',
    14: 'H H H D D H H H H H',
    15: 'H H D D D H H H H H',
    16: 'H H D D D H H H H H',
    17: 'H D D D D H H H H H',
    18: 'S D D D D S S H H H',
    19: 'S S S S S S S S S S',
    20: 'S S S S S S S S S S'
};

// PAIRS, keyed by pair value (2-10, 11=A,A), vs dealer [2..A].
const REF_PAIR = {
    2:  'P P P P P P H H H H',
    3:  'P P P P P P H H H H',
    4:  'H H H P P H H H H H',
    5:  'D D D D D D D D H H',
    6:  'P P P P P H H H H H',
    7:  'P P P P P P H H H H',
    8:  'P P P P P P P P P P',
    9:  'P P P P P S P P S S',
    10: 'S S S S S S S S S S',
    11: 'P P P P P P P P P P'
};

// SURRENDER, hard totals only. true = surrender offered vs that dealer
// upcard VALUE (10 or 11 for Ace).
const REF_SURRENDER = {
    15: { 10: true },
    16: { 9: true, 10: true, 11: true }
};

// --- Diff hard table ----------------------------------------------------
console.log('=== verify-strategy-chart.js ===');
console.log('\n-- Diffing HARD totals table --');
for (const total of Object.keys(REF_HARD)) {
    const refRow = REF_HARD[total].split(' ');
    const actualRow = StrategyData.hard[total];
    if (!actualRow) {
        mismatches++;
        console.error(`MISMATCH  [hard] total ${total}: missing from strategy-data.js entirely`);
        continue;
    }
    for (let i = 0; i < 10; i++) {
        cellsChecked++;
        if (refRow[i] !== actualRow[i]) {
            reportMismatch('hard', `total ${total}`, DEALER_LABELS[i], refRow[i], actualRow[i]);
        }
    }
}

console.log('-- Diffing SOFT totals table --');
for (const total of Object.keys(REF_SOFT)) {
    const refRow = REF_SOFT[total].split(' ');
    const actualRow = StrategyData.soft[total];
    if (!actualRow) {
        mismatches++;
        console.error(`MISMATCH  [soft] total ${total}: missing from strategy-data.js entirely`);
        continue;
    }
    for (let i = 0; i < 10; i++) {
        cellsChecked++;
        if (refRow[i] !== actualRow[i]) {
            reportMismatch('soft', `total ${total}`, DEALER_LABELS[i], refRow[i], actualRow[i]);
        }
    }
}

console.log('-- Diffing PAIR table --');
for (const pairVal of Object.keys(REF_PAIR)) {
    const refRow = REF_PAIR[pairVal].split(' ');
    const actualRow = StrategyData.pair[pairVal];
    if (!actualRow) {
        mismatches++;
        console.error(`MISMATCH  [pair] value ${pairVal}: missing from strategy-data.js entirely`);
        continue;
    }
    for (let i = 0; i < 10; i++) {
        cellsChecked++;
        if (refRow[i] !== actualRow[i]) {
            reportMismatch('pair', `pair value ${pairVal}`, DEALER_LABELS[i], refRow[i], actualRow[i]);
        }
    }
}

console.log('-- Diffing SURRENDER table --');
for (const total of Object.keys(REF_SURRENDER)) {
    const refEntry = REF_SURRENDER[total];
    const actualEntry = StrategyData.surrender[total] || {};
    for (const dealerVal of Object.keys(refEntry)) {
        cellsChecked++;
        const expected = true;
        const actual = !!actualEntry[dealerVal];
        if (expected !== actual) {
            reportMismatch('surrender', `total ${total}`, dealerVal, 'R', actual ? 'R' : '(none)');
        }
    }
    // Also check strategy-data.js doesn't offer surrender where reference doesn't.
    for (const dealerVal of Object.keys(actualEntry)) {
        cellsChecked++;
        if (!refEntry[dealerVal]) {
            reportMismatch('surrender', `total ${total}`, dealerVal, '(none)', 'R');
        }
    }
}
// 8,8 must NEVER surrender per the plan — confirm no surrender entry exists
// for a pair-total key (pairs aren't even indexed in the surrender table,
// but double-check strategy-data.js didn't add one under a hard-total-16
// alias for 8,8, which would resurrect the collision bug).
if (StrategyData.surrender[16] && StrategyData.surrender[16].pair) {
    mismatches++;
    console.error('MISMATCH  [surrender] found a stray "pair" sub-key under surrender[16] — 8,8 must never surrender');
}

// --- Bug #2 collision-regression tests via the live engine --------------
console.log('\n-- Collision-regression tests (bug #2: key collisions) --');

const Hand = require(path.join(__dirname, '../public/js/blackjack/hand.js'));

function makeHand(cardSpecs, bet) {
    const h = new Hand(bet || 10);
    for (const [rank, value] of cardSpecs) {
        h.add({ suit: '♠', rank, value, color: 'black', counted: true });
    }
    return h;
}

let collisionFailures = 0;

// Case A: pair 8,8 vs dealer 10 (total = 16). Must resolve to Split (P),
// never to a hard-16 deviation answer (e.g. 'S' from hard_16_10 at TC>=0).
{
    const hand = makeHand([['8', 8], ['8', 8]]);
    // Use a true count that WOULD trigger the hard_16_10 deviation (S at
    // TC>=0) if the engine mistakenly fell through to the hard table —
    // this is exactly the collision bug #2 describes.
    const trueCount = 2;
    const play = StrategyEngine.getOptimalPlay(hand, 10, trueCount, true, true, true);
    if (play === 'P') {
        console.log(`  ok: pair 8,8 vs dealer 10 @ TC=${trueCount} resolves to 'P' (split), not a hard-16 deviation`);
    } else {
        collisionFailures++;
        console.error(`MISMATCH  [collision] pair 8,8 vs dealer 10 @ TC=${trueCount}: expected 'P', got '${play}' (looks like it fell through to the hard-16 table — bug #2 regression!)`);
    }
}

// Case B: soft 16 = A,5 vs dealer 10. Numerically collides with hard total
// 16 (which has a deviation hard_16_10 at TC>=0 -> 'S'). The soft-hand
// table has NO deviation entry for soft_16_10, so the base soft strategy
// play (Hit, since soft[16] vs dealer-10-index has no double) must win —
// it must NOT resolve to the hard-16 deviation's 'S'.
{
    const hand = makeHand([['A', 11], ['5', 5]]); // A,5 = soft 16
    const trueCount = 2; // would trigger hard_16_10 -> 'S' if collision bug present
    const play = StrategyEngine.getOptimalPlay(hand, 10, trueCount, true, false, true);
    const expectedBase = StrategyData.soft[16][DEALER_LABELS.indexOf('10')]; // base soft play vs 10
    // canDouble=true but soft[16] vs 10 is 'H' per chart (index 8 = dealer 10 -> 'H')
    if (play === expectedBase) {
        console.log(`  ok: soft 16 (A,5) vs dealer 10 @ TC=${trueCount} resolves to '${play}' (base soft strategy), not the hard-16 deviation 'S'`);
    } else {
        collisionFailures++;
        console.error(`MISMATCH  [collision] soft 16 (A,5) vs dealer 10 @ TC=${trueCount}: expected base soft play '${expectedBase}', got '${play}' (looks like a hard/soft key collision — bug #2 regression!)`);
    }
}

mismatches += collisionFailures;

// --- Summary --------------------------------------------------------------
console.log('\n=== SUMMARY ===');
console.log(`Cells checked (hard+soft+pair+surrender): ${cellsChecked}`);
console.log(`Collision-regression cases checked: 2`);
console.log(`Mismatches found: ${mismatches}`);

if (mismatches === 0) {
    console.log('PASS: strategy-data.js matches the independently-transcribed S17/6-deck/DAS/LS chart, and bug #2 collision cases resolve correctly.');
    process.exit(0);
} else {
    console.log(`FAIL: ${mismatches} mismatch(es) found — see MISMATCH lines above.`);
    process.exit(1);
}
