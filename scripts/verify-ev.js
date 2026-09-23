// ============================================================================
// verify-ev.js — the bet-spread EV model.
//
// Every figure this model produces is one a player might size a bankroll
// against, so the parts that could be quietly wrong are pinned here: the
// true-count distribution (which must sum to one and must match published
// Hi-Lo frequencies), the direction each input moves the result in, and the
// three places where a plausible-looking implementation gives a confidently
// wrong answer — dividing EV by the wrong denominator, treating multiple
// hands as independent, and reporting a comforting risk of ruin for a game
// with no edge.
//
// Run: node scripts/verify-ev.js
// ============================================================================

const path = require('path');
const EV = require(path.join(__dirname, '../public/js/blackjack/ev.js'));

let failures = 0;
const ok = (m) => console.log('  OK   ' + m);
const fail = (m) => { console.log('  FAIL ' + m); failures++; };
const eq = (a, b, m) => (a === b ? ok(`${m} (${JSON.stringify(a)})`) : fail(`${m} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`));
const near = (a, b, tol, m) => (Math.abs(a - b) <= tol ? ok(`${m} (${a.toFixed(4)})`) : fail(`${m} — expected ~${b}, got ${a}`));
const truthy = (v, m) => (v ? ok(m) : fail(m));

const sum = (d, pred) => d.filter(pred).reduce((s, b) => s + b.freq, 0);

console.log('-- the true-count distribution --');
{
    const d = EV.tcDistribution(6, 0.75);
    near(sum(d, () => true), 1, 1e-9, 'frequencies sum to exactly 1 after renormalising the discarded tails');

    // Published Hi-Lo frequencies for a 6-deck shoe: the count sits at or
    // near zero most of the time and the profitable counts are rare. A model
    // that got this wrong would be internally consistent and useless.
    truthy(sum(d, (b) => b.tc >= 2) > 0.10 && sum(d, (b) => b.tc >= 2) < 0.22,
        'TC >= +2 lands in the published 10-22% band');
    truthy(sum(d, (b) => b.tc >= 5) > 0.005 && sum(d, (b) => b.tc >= 5) < 0.04,
        'TC >= +5 is rare, under 4%');
    truthy(d.find((b) => b.tc === 0).freq > sum(d, (b) => b.tc >= 4),
        'a neutral count is more common than every count at or above +4 combined');

    // Symmetry: the shoe is as likely to run cold as hot.
    near(sum(d, (b) => b.tc >= 3), sum(d, (b) => b.tc <= -3), 1e-6,
        'the distribution is symmetric — good counts are exactly as rare as bad ones');
}

console.log('\n-- penetration is the lever it is supposed to be --');
{
    const shallow = EV.tcDistribution(6, 0.60);
    const deep = EV.tcDistribution(6, 0.88);
    truthy(sum(deep, (b) => b.tc >= 4) > sum(shallow, (b) => b.tc >= 4),
        'deeper penetration produces more high counts');

    const a = EV.evaluate({ bankroll: 50000, unit: 25, rules: { penetration: 0.60 } });
    const b = EV.evaluate({ bankroll: 50000, unit: 25, rules: { penetration: 0.88 } });
    truthy(b.evPerHour > a.evPerHour, 'and therefore more money per hour');
    truthy(b.riskOfRuin < a.riskOfRuin, 'and a lower risk of ruin at the same bankroll');
}

console.log('\n-- the edge is per unit WAGERED, not per unit --');
{
    const r = EV.evaluate({ bankroll: 60000, unit: 25, roundsPerHour: 100 });
    // A 1-20 spread with a $25 unit has an average bet several times the
    // unit. Dividing EV by the unit instead of by the average bet would
    // report an edge several times too large — a number that looks like a
    // spectacular game and is an arithmetic error.
    truthy(r.avgBet > 25, 'the average bet exceeds the unit on a ramped spread');
    near(r.playerEdge, r.evPerHand / r.avgBet, 1e-12, 'player edge is EV over average bet');
    truthy(r.playerEdge > 0.002 && r.playerEdge < 0.02,
        'and lands in the believable 0.2%-2% band for a counted shoe game');
}

console.log('\n-- multiple hands are correlated, not independent --');
{
    const one = EV.evaluate({ bankroll: 50000, unit: 25, ramp: [{ tc: -99, bet: 4, hands: 1 }] });
    const two = EV.evaluate({ bankroll: 50000, unit: 25, ramp: [{ tc: -99, bet: 2, hands: 2 }] });

    near(two.avgBet, one.avgBet, 1e-9, 'two hands of 2 units puts the same money out as one hand of 4');
    truthy(two.variancePerHand < one.variancePerHand,
        'but carries LESS variance — which is the whole reason to do it');
    // Independence would make two hands of 2 units exactly half the variance
    // of one hand of 4 (2 * 2^2 = 8 vs 4^2 = 16). Correlation means it is
    // more than half. Getting this backwards would understate real risk.
    truthy(two.variancePerHand > one.variancePerHand * 0.5,
        'and more than the half that treating them as independent would predict');
}

console.log('\n-- risk of ruin refuses to be comforting --');
{
    // A flat bettor has no edge, so ruin is certain given enough rounds. A
    // model that returned a small number here would be telling somebody their
    // losing game was survivable.
    const flat = EV.evaluate({ bankroll: 100000, unit: 25, ramp: [{ tc: -99, bet: 1, hands: 1 }] });
    truthy(flat.evPerHand < 0, 'a flat bet has negative EV');
    eq(flat.riskOfRuin, 1, 'so risk of ruin is reported as certain, not as a small percentage');
    eq(flat.n0Hours, Infinity, 'and N0 is infinite — there is no edge to become visible');

    const broke = EV.evaluate({ bankroll: 0, unit: 25 });
    eq(broke.riskOfRuin, 1, 'no bankroll is also certain ruin');
}

console.log('\n-- bankroll and spread move risk the way they must --');
{
    const small = EV.evaluate({ bankroll: 10000, unit: 25 });
    const large = EV.evaluate({ bankroll: 100000, unit: 25 });
    truthy(large.riskOfRuin < small.riskOfRuin, 'a bigger bankroll is safer at the same stakes');
    near(large.evPerHour, small.evPerHour, 1e-9, 'and does not change the hourly rate');

    const tame = EV.evaluate({ bankroll: 50000, unit: 25, ramp: [{ tc: -99, bet: 1 }, { tc: 2, bet: 4 }] });
    const wild = EV.evaluate({ bankroll: 50000, unit: 25, ramp: [{ tc: -99, bet: 1 }, { tc: 2, bet: 40 }] });
    truthy(wild.evPerHour > tame.evPerHour, 'a wider spread earns more');
    truthy(wild.riskOfRuin > tame.riskOfRuin, 'and risks more — both, never just the first');
}

console.log('\n-- an unnamed count never becomes a free zero bet --');
{
    // The ramp names only the points where the bet changes. If a count below
    // the lowest entry fell through to "no bet", the model would silently
    // skip every negative count — sitting out all the bad hands for free and
    // reporting an edge no real player can get.
    const ramp = [{ tc: 1, bet: 1 }, { tc: 3, bet: 8 }];
    eq(EV.betAt(-5, ramp).bet, 1, 'a count below the ramp takes the lowest named bet');
    eq(EV.betAt(2, ramp).bet, 1, 'a count between entries holds the lower one');
    eq(EV.betAt(99, ramp).bet, 8, 'a count above the ramp takes the highest');

    const r = EV.evaluate({ bankroll: 50000, unit: 25, ramp });
    truthy(r.rows.filter((x) => x.tc < 0).every((x) => x.bet > 0),
        'so every negative count is still played and still costs money');
}

console.log('\n-- rules move the base edge in the right direction --');
{
    const base = EV.baseEdgeFor({ decks: 6 });
    truthy(base < 0, 'the house has it at a neutral count');
    truthy(EV.baseEdgeFor({ decks: 6, h17: true }) < base, 'H17 is worse for the player');
    truthy(EV.baseEdgeFor({ decks: 6, das: false }) < base, 'no DAS is worse');
    truthy(EV.baseEdgeFor({ decks: 2 }) > base, 'fewer decks is better');
    // 6:5 is the single most expensive rule on a modern floor and must dwarf
    // the others, or the calculator will not warn anyone off those tables.
    const sixFive = base - EV.baseEdgeFor({ decks: 6, blackjackPays: 1.2 });
    truthy(sixFive > 0.01, '6:5 blackjack costs more than a full percent — more than every other rule combined');
}

console.log('\n-- the bankroll a spread actually needs --');
{
    const r = EV.evaluate({ bankroll: 20000, unit: 25, roundsPerHour: 100 });
    const need = r.bankrollForRisk(0.05);
    truthy(need > 20000, 'an under-rolled spread reports needing more than it has');

    // The inverse must round-trip: funding exactly what it asks for has to
    // produce the risk it was asked about. A formula derived by rearranging
    // the wrong equation would still return a plausible-looking number.
    const funded = EV.evaluate({ bankroll: need, unit: 25, roundsPerHour: 100 });
    near(funded.riskOfRuin, 0.05, 1e-6, 'and funding exactly that lands on exactly 5% risk');

    truthy(r.bankrollForRisk(0.01) > r.bankrollForRisk(0.05), 'a stricter risk target needs more money');
    const flat = EV.evaluate({ bankroll: 20000, unit: 25, ramp: [{ tc: -99, bet: 1 }] });
    eq(flat.bankrollForRisk(0.05), Infinity, 'and a game with no edge needs an infinite bankroll — correctly');
}

console.log('\n-- the edge is linear in the true count --');
{
    eq(EV.EDGE_PER_TC, 0.005, 'half a percent per true count');
    const b = EV.baseEdgeFor({ decks: 6 });
    near(EV.edgeAt(0, b), b, 1e-12, 'TC 0 is the base edge');
    near(EV.edgeAt(2, b) - EV.edgeAt(1, b), 0.005, 1e-12, 'each step is worth the same');
    truthy(EV.edgeAt(1, b) > 0, 'and the player is ahead by TC +1');
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} CHECK(S) FAILED.`);
process.exitCode = failures === 0 ? 0 : 1;
