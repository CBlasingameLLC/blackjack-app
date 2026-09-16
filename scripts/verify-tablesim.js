// ============================================================================
// verify-tablesim.js — the Table Simulation counting mode.
//
// The load-bearing property is COUNT INTEGRITY: this mode exists so a player
// can practise keeping the running count, so if the engine's own count is
// wrong — or a card is registered twice, or the hole card is counted before it
// is turned over — the mode does not merely misbehave, it teaches the wrong
// number. So the count is tallied here INDEPENDENTLY, from the dealt-card
// events, and compared against what the engine is about to grade the player on.
//
// Run: node scripts/verify-tablesim.js
// ============================================================================

const path = require('path');
const BASE = path.join(__dirname, '../public/js/blackjack');

require(path.join(BASE, 'rules.js'));
require(path.join(BASE, 'shoe.js'));
require(path.join(BASE, 'hand.js'));
require(path.join(BASE, 'strategy-data.js'));
const Count = require(path.join(BASE, 'count.js'));
require(path.join(BASE, 'strategy-engine.js'));
const Storage = require(path.join(BASE, 'persistence.js'));
const GameManager = require(path.join(BASE, 'game-manager.js'));

let failures = 0;
const ok = (m) => console.log('  OK   ' + m);
const fail = (m) => { console.log('  FAIL ' + m); failures++; };
const eq = (a, b, m) => (a === b ? ok(`${m} (${JSON.stringify(a)})`) : fail(`${m} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`));

// Hi-Lo, transcribed here on purpose rather than imported: a tally that shares
// count.js's implementation would agree with it even if both were wrong.
function hiLo(card) {
    if (card.value >= 2 && card.value <= 6) return 1;
    if (card.value >= 7 && card.value <= 9) return 0;
    return -1; // 10, J, Q, K (value 10) and Ace (value 11)
}

function makeManager(settings) {
    const gm = new GameManager();
    gm.updateSettings(Object.assign({
        tableSimSpeed: 0,          // no pacing delay; the loop still yields
        tableSimSpots: 3,
        tableSimInterval: 2,
        casualMode: false
    }, settings || {}));

    const seen = { tally: 0, cards: 0, ids: new Set(), doubleCounted: 0 };
    const note = (card) => {
        seen.tally += hiLo(card);
        seen.cards++;
        if (seen.ids.has(card)) seen.doubleCounted++;
        seen.ids.add(card);
    };

    gm.setCallback('onCardDealt', (card) => note(card));
    gm.setCallback('onDealerCardDealt', (card, hand) => {
        // The first dealer card is the hole card — face down, and not visible
        // to a counter until it is turned over.
        if (hand.cards.length > 1) note(card);
    });
    gm.setCallback('onHoleCardRevealed', (card) => note(card));
    gm.setCallback('onShuffle', () => { seen.tally = 0; seen.ids.clear(); });

    return { gm, seen };
}

/** Resolves with the prompt payload the first time the sim asks for the count. */
function firstPrompt(gm, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no count prompt within ' + timeoutMs + 'ms')), timeoutMs);
        gm.setCallback('onCountPrompt', (info) => {
            clearTimeout(timer);
            resolve(info);
        });
    });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async function run() {
    console.log('-- Table Simulation --');

    // ---------------------------------------------------------------- deal
    {
        const { gm } = makeManager({ tableSimSpots: 5, tableSimInterval: 99 });
        // Capture the table at ROUND RESOLUTION. Asserting after a fixed sleep
        // races the loop: this mode deals continuously, so a wall-clock wait
        // lands wherever it lands — mid-deal of a later round, with a dealer
        // holding one card — and the failure looks like a dealing bug rather
        // than a test that asked at the wrong moment.
        const settled = new Promise((resolve) => {
            gm.setCallback('onRoundResolved', (hands) => resolve({
                spots: hands.length,
                everySpotDealt: hands.every((h) => h.cards.length >= 2),
                dealerCards: gm.dealerHand.cards.length,
                allResolved: hands.every((h) => h.resolved)
            }));
        });
        gm.startTableSim();
        eq(gm.gameMode, 'tablesim', 'starting the sim enters tablesim mode');
        eq(gm.isTableSimRunning(), true, 'the sim reports itself running');

        const table = await settled;
        eq(table.spots >= 5, true, `all 5 spots were dealt (${table.spots}, splits can add more)`);
        eq(table.dealerCards >= 2, true, 'the dealer was dealt too');
        eq(table.everySpotDealt, true, 'every spot got at least two cards');
        eq(table.allResolved, true, 'every spot was played out to resolution, with no input');
        gm.stopTableSim();
        eq(gm.isTableSimRunning(), false, 'stopTableSim halts it');
    }

    // -------------------------------------------------------- spot clamping
    {
        const { gm } = makeManager({ tableSimSpots: 99 });
        eq(gm._tableSimSpots(), 7, 'a silly spot count clamps to a real table of 7');
        gm.updateSettings({ tableSimSpots: 0 });
        eq(gm._tableSimSpots(), 1, 'zero spots clamps up to 1 — a table with no boxes deals nothing');
        gm.stopTableSim();
    }

    // ------------------------------------------------- COUNT INTEGRITY + quiz
    {
        const { gm, seen } = makeManager({ tableSimSpots: 4, tableSimInterval: 2 });
        const promptSeen = firstPrompt(gm);
        gm.startTableSim();
        const info = await promptSeen;

        eq(info.type, 'running', 'the sim asks for the RUNNING count, never the true count');
        eq(gm.state, 'count-check', 'the table parks on the prompt instead of dealing on');

        const expected = gm._pendingCountPrompt.expected;
        eq(expected, seen.tally, 'the count the player is graded against matches an INDEPENDENT Hi-Lo tally');
        eq(seen.doubleCounted, 0, `no card was registered twice (${seen.cards} cards seen)`);
        eq(expected, Count.runningCount, 'the graded count is the engine live count');
        eq(seen.cards > 10, true, `a real volume of cards went past (${seen.cards})`);

        // A correct answer resumes dealing.
        const good = gm.submitCountAnswer(expected);
        eq(good.correct, true, 'a correct answer is graded correct');
        eq(good.reanchored, false, 'a correct answer does NOT reshuffle');
        await wait(600);
        eq(gm.isTableSimRunning(), true, 'the sim is still running after a correct answer');
        eq(gm.state !== 'count-check', true, 'and it resumed dealing rather than staying parked');
        gm.stopTableSim();
    }

    // ------------------------------------------------------- the re-anchor
    {
        const { gm } = makeManager({ tableSimSpots: 3, tableSimInterval: 1 });
        const promptSeen = firstPrompt(gm);
        gm.startTableSim();
        await promptSeen;

        const expected = gm._pendingCountPrompt.expected;
        const bad = gm.submitCountAnswer(expected + 7);
        eq(bad.correct, false, 'a wrong answer is graded wrong');
        // The whole point of the safeguard: a missed count cannot compound,
        // because the player gets a verifiably-zero shoe to resync on.
        eq(bad.reanchored, true, 'a missed running count RE-ANCHORS');
        eq(Count.runningCount, 0, 'the re-anchor left a fresh shoe at a count of zero');
        gm.stopTableSim();
    }

    // ------------------------------------------ it is a drill, not a game
    {
        Storage.setBankroll(10000);
        const { gm } = makeManager({ tableSimSpots: 3, tableSimInterval: 99 });
        const historyBefore = Storage.getHandHistory().length;
        const bankrollBefore = gm.getBankroll();
        gm.startTableSim();
        await wait(900);
        gm.stopTableSim();

        eq(gm.getBankroll(), bankrollBefore, 'no money moves in a counting drill');
        eq(gm.currentBet, 0, 'nothing is ever wagered');
        eq(Storage.getHandHistory().length, historyBefore, 'hand history is NOT polluted with simulated hands');
        eq(gm.playerHands.every((h) => h.payout === 0), true, 'every simulated hand pays exactly 0');
    }

    // ------------------------------------------- basic strategy, no deviations
    {
        const { gm } = makeManager({ tableSimSpots: 6, tableSimInterval: 99 });
        gm.startTableSim();
        await wait(1200);
        gm.stopTableSim();
        // Nothing may have surrendered: surrender removes cards a real
        // basic-strategy table would have dealt, which changes the count.
        eq(gm.playerHands.some((h) => h.surrendered), false, 'the simulated table never surrenders');
        eq(gm.playerHands.every((h) => h.score.total <= 21 || h.score.isBust), true, 'every hand ended in a legal state');
    }

    console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll checks passed.');
    process.exit(failures ? 1 : 0);
})().catch((err) => {
    console.log('  FAIL ' + (err && err.message ? err.message : String(err)));
    process.exit(1);
});
