// ==========================================
// scripts/verify-hilo-count.js
//
// Independent Node-based cross-check for the Hi-Lo counting engine
// (plan §6.1). NOT part of the Eleventy build — nothing under scripts/
// is passthrough-copied by .eleventy.js, so this never ships to _site.
//
// Loads the DOM-free blackjack modules via plain require() (they are
// dual browser/Node loadable — see the `module.exports` guard at the
// bottom of each file) and:
//   1. Seeds a deterministic PRNG in place of Math.random() so the
//      shuffle is reproducible, then restores Math.random() after.
//   2. Draws every card in a fresh 6-deck shoe via Shoe.draw(), registers
//      each with Count.registerCard(), and INDEPENDENTLY tallies Hi-Lo
//      values with a naive parallel loop written directly in this
//      script (not reusing count.js's hiLoTag logic) — asserting the two
//      running totals match after every single card.
//   3. Explicitly regression-tests the old double-count-on-re-render bug
//      by calling registerCard() twice in a row on the same card object
//      and asserting the running count only moved once.
//   4. Verifies getTrueCount() against a hand-computed table, including
//      negative running counts, to confirm Math.trunc (toward-zero)
//      semantics rather than Math.floor.
//   5. Verifies reset() zeroes the running count.
//
// Exit code 0 = full pass, 1 = any failure.
// ==========================================

'use strict';

const path = require('path');

const Rules = require(path.join(__dirname, '../public/js/blackjack/rules.js'));
const Shoe = require(path.join(__dirname, '../public/js/blackjack/shoe.js'));
const Hand = require(path.join(__dirname, '../public/js/blackjack/hand.js')); // eslint-disable-line no-unused-vars
const Count = require(path.join(__dirname, '../public/js/blackjack/count.js'));

let failures = 0;
function fail(msg) {
    failures++;
    console.error('FAIL: ' + msg);
}
function ok(msg) {
    console.log('  ok: ' + msg);
}

// --- 1. Deterministic seeded PRNG (mulberry32), monkey-patched over
// Math.random for reproducibility, restored afterward. ---
function mulberry32(seed) {
    let a = seed;
    return function () {
        a |= 0;
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const originalRandom = Math.random;
Math.random = mulberry32(20260714); // fixed seed

console.log('=== verify-hilo-count.js ===');
console.log('\n-- Test 1: full-shoe draw, independent Hi-Lo tally --');

const shoe = new Shoe(Rules.decks);
Count.reset();

// Independent parallel tally, written fresh (not calling into count.js's
// hiLoTag) so this is a real cross-check, not a tautology.
function independentHiLoTag(card) {
    const v = card.value;
    if (v >= 2 && v <= 6) return 1;
    if (v === 7 || v === 8 || v === 9) return 0;
    return -1; // 10, J, Q, K, A (value 10 or 11)
}

let independentRunningCount = 0;
let cardIndex = 0;
let mismatchFound = false;
const totalCards = Rules.decks * 52;

while (shoe.cards.length > 0) {
    const card = shoe.draw();
    Count.registerCard(card);
    independentRunningCount += independentHiLoTag(card);
    cardIndex++;

    if (Count.runningCount !== independentRunningCount) {
        fail(
            `Mismatch at card index ${cardIndex} (${card.rank}${card.suit}): ` +
            `count.js runningCount=${Count.runningCount}, ` +
            `independent tally=${independentRunningCount}`
        );
        mismatchFound = true;
        break;
    }
}

if (!mismatchFound) {
    if (cardIndex !== totalCards) {
        fail(`Expected to draw ${totalCards} cards, only drew ${cardIndex}`);
    } else {
        ok(`all ${totalCards} cards matched running count at every step (final RC=${Count.runningCount})`);
    }
    // A full 6-deck shoe is Hi-Lo balanced: equal +1 and -1 tags, so the
    // running count must return to exactly 0 after the full shoe.
    if (Count.runningCount !== 0) {
        fail(`Full-shoe running count should be 0 (Hi-Lo is balanced), got ${Count.runningCount}`);
    } else {
        ok('full-shoe running count returned to 0, as a balanced Hi-Lo count must');
    }
}

console.log('\n-- Test 2: regression test for double-count-on-re-render bug --');
{
    Count.reset();
    const dupShoe = new Shoe(Rules.decks);
    const card = dupShoe.draw(); // a fresh card, counted:false
    const before = Count.runningCount;
    Count.registerCard(card); // first registration — should move the count
    const afterFirst = Count.runningCount;
    Count.registerCard(card); // simulated re-render calling registerCard again
    Count.registerCard(card); // and again, for good measure
    const afterSecondThird = Count.runningCount;

    if (afterFirst === afterSecondThird && afterFirst !== before) {
        ok(`registerCard() is idempotent: RC moved once (${before} -> ${afterFirst}) and stayed there after 2 repeat calls`);
    } else if (afterFirst === before) {
        fail(`registerCard() never moved the running count at all (before=${before}, afterFirst=${afterFirst})`);
    } else {
        fail(`registerCard() double-counted on repeat calls: before=${before}, afterFirst=${afterFirst}, afterRepeats=${afterSecondThird}`);
    }
}

console.log('\n-- Test 3: getTrueCount() against hand-computed table (incl. negative RC) --');
{
    // [runningCount, decksRemaining, expectedTrueCount]
    // Math.trunc toward zero, NOT Math.floor.
    const cases = [
        [6, 3, 2],
        [7, 3, 2],      // 7/3 = 2.333 -> trunc 2 (floor would also give 2 here)
        [-6, 3, -2],
        [-7, 3, -2],    // -7/3 = -2.333 -> trunc -2 (floor would give -3)
        [-3, 2, -1],    // -3/2 = -1.5 -> trunc -1 (floor would give -2) -- the key regression case
        [3, 2, 1],      // 3/2 = 1.5 -> trunc 1
        [-1, 4, 0],     // -1/4 = -0.25 -> trunc 0 (floor would give -1)
        [0, 4, 0],
        [10, 1, 10],
        [-10, 1, -10],
        [5, 0, 5]       // decksRemaining <= 0 guarded to 1 deck inside getTrueCount
    ];

    for (const [rc, decks, expected] of cases) {
        const actual = Count.getTrueCount(rc, decks);
        if (actual !== expected) {
            fail(`getTrueCount(${rc}, ${decks}) = ${actual}, expected ${expected} (Math.trunc semantics)`);
        } else {
            ok(`getTrueCount(${rc}, ${decks}) = ${actual} (expected ${expected})`);
        }
    }
}

console.log('\n-- Test 4: reset() zeroes the running count --');
{
    Count.runningCount = 17; // force a nonzero state
    Count.reset();
    if (Count.runningCount === 0) {
        ok('reset() zeroed the running count');
    } else {
        fail(`reset() left runningCount at ${Count.runningCount}, expected 0`);
    }
}

Math.random = originalRandom;

console.log('\n=== SUMMARY ===');
if (failures === 0) {
    console.log('PASS: all Hi-Lo counting checks passed.');
    process.exit(0);
} else {
    console.log(`FAIL: ${failures} check(s) failed.`);
    process.exit(1);
}
