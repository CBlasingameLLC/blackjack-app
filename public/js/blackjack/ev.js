// ==========================================
// ev.js — bet-spread EV, variance, risk of ruin and N0.
//
// DOM-free and Node-requireable, same discipline as count.js /
// strategy-engine.js / mastery.js. Nothing here reads storage or renders;
// `evaluate()` takes a plain config and returns plain numbers, which is what
// lets every figure below be checked against a literal in verify-ev.js.
//
// ---------------------------------------------------------------------------
// WHAT THIS IS AND IS NOT
//
// This is the analytic model, not a simulation. It composes three things that
// are each well established on their own:
//
//   1. the distribution of true counts a shoe actually produces,
//   2. the player's edge at each of those counts,
//   3. the bet placed at each of those counts.
//
// Everything else — EV per hand, hourly EV, standard deviation, risk of ruin,
// N0 — falls out of those three. A Monte Carlo would answer the same
// questions by brute force and is deliberately not here; the closed form is
// exact for the model it describes, instant, and testable against numbers a
// reader can check by hand, where a simulation is none of those.
//
// THE MODEL'S ASSUMPTIONS ARE STATED, because a figure like "risk of ruin
// 0.61%" is worthless if you cannot see what it took for granted:
//
//   - Edge is linear in the true count. This is the standard Hi-Lo working
//     approximation and it is good across the counts that matter; it drifts
//     at the extremes, where the frequencies are tiny anyway.
//   - Every round is dealt at a depth drawn uniformly from the penetration
//     range. Real shoes are not quite uniform in depth-per-round, but the
//     error is small next to the choice of penetration itself.
//   - Variance per unit wagered is a constant. It genuinely rises a little at
//     high counts (more doubles and splits), so risk of ruin here is a mild
//     UNDER-estimate at aggressive spreads. Flagged rather than silently
//     absorbed.
//   - A zero bet is a round you sat out but still spent time on. That is the
//     honest reading for back-counting from the table; a true Wong-out who
//     leaves and finds another shoe plays more hands per hour than this says.
// ==========================================

(function (root) {
    'use strict';

    var BJ = (typeof window !== 'undefined')
        ? (window.BJ = window.BJ || {})
        : (root.BJ = root.BJ || {});

    // --- model constants -------------------------------------------------

    // Hi-Lo tags twenty of every fifty-two cards at +/-1 and the rest at 0, so
    // a single card's tag has mean 0 and variance 20/52. This is what drives
    // how far the running count can wander, and therefore the whole true-count
    // distribution.
    var TAG_VARIANCE = 20 / 52;

    // Each +1 of true count is worth about half a percent to the player under
    // Hi-Lo. The single most load-bearing number in the file.
    var EDGE_PER_TC = 0.005;

    // Player edge at a true count of zero, for the app's locked ruleset:
    // 6 decks, S17, DAS, late surrender, blackjack pays 3:2. Negative because
    // at a neutral count the house still has it.
    var BASE_EDGE_6D_S17 = -0.0040;

    // Rule deltas, applied to the base edge. Each is the standard published
    // cost or gain of that rule to a basic-strategy player.
    var RULE_DELTA = {
        h17: -0.0022,          // dealer hits soft 17
        noDAS: -0.0014,
        noSurrender: -0.0008,
        bj6to5: -0.0139        // the single most expensive rule on a modern floor
    };

    // Deck-count deltas off the six-deck baseline.
    var DECK_DELTA = { 1: 0.0048, 2: 0.0019, 4: 0.0006, 6: 0, 8: -0.0002 };

    // Variance of the result of one round, per unit wagered. Blackjack's
    // ~1.32 comes from the payout spread plus doubles and splits.
    var VARIANCE_PER_UNIT = 1.32;

    // Correlation between two hands played in the same round. They share a
    // dealer upcard and draw from the same shoe, so they win and lose
    // together far more often than chance; ~0.5 is the standard working
    // figure.
    var HAND_CORRELATION = 0.5;

    /**
     * Variance of a round of `h` hands of equal size, as a multiple of ONE
     * hand's variance. Derived rather than tabulated, because the tabulated
     * version was wrong and wrong in the direction that matters:
     *
     *   Var(X1 + ... + Xh) = h*Var(X) + h(h-1)*Cov(Xi, Xj)
     *                      = Var(X) * [h + h(h-1)*rho]
     *
     * so two hands is 3x one hand's variance, not the 1.75x a first pass
     * used. Under-counting the covariance makes a multi-hand ramp look safer
     * than it is, and risk of ruin is exactly the figure somebody sizes a
     * bankroll against — an error there is not conservative, it is the one
     * direction an honest model must never lean.
     *
     * The genuine benefit of multiple hands survives this and is what the
     * "two hands at high counts lowers variance" advice actually means: two
     * hands of b carry 3*b^2*V against one hand of 2b's 4*b^2*V, for the same
     * money on the table. Less risk for the same action — a quarter less, not
     * the half that treating the hands as independent would suggest.
     */
    function handsVariance(h) {
        var n = h > 0 ? h : 1;
        return n + n * (n - 1) * HAND_CORRELATION;
    }

    // True counts outside this range are so rare that including them adds
    // nothing but arithmetic on frequencies in the tenth decimal place.
    var TC_MIN = -12, TC_MAX = 12;

    var CARDS_PER_DECK = 52;

    // ------------------------------------------------------------------
    // the true-count distribution
    // ------------------------------------------------------------------

    /** Standard normal CDF (Abramowitz & Stegun 7.1.26 via erf). */
    function normalCdf(z) {
        // erf approximation, max error ~1.5e-7 — far tighter than the model
        // assumptions above, so it is not the limiting factor in any output.
        var sign = z < 0 ? -1 : 1;
        var x = Math.abs(z) / Math.sqrt(2);
        var t = 1 / (1 + 0.3275911 * x);
        var y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
        return 0.5 * (1 + sign * y);
    }

    /**
     * The frequency of each integer true count, averaged over the depths a
     * shoe is actually dealt to.
     *
     * At a depth of `n` cards dealt from `N`, the running count is very close
     * to normal with mean zero and variance n(N-n)/(N-1) * TAG_VARIANCE — the
     * variance of a sample drawn WITHOUT replacement, which is why the
     * (N-n) term is there and why the spread collapses again as the shoe runs
     * out. The true count is that divided by the decks remaining, so its
     * spread GROWS with depth: the same running count means far more with one
     * deck left than with five.
     *
     * Averaging over depth is what turns "the count at this moment" into "the
     * counts this game deals you", which is the thing a bet spread is
     * actually ramped against.
     */
    function tcDistribution(decks, penetration) {
        var N = decks * CARDS_PER_DECK;
        var maxDealt = Math.floor(N * penetration);
        var buckets = {};
        var steps = 0;

        // One sample per half-deck of depth. Finer steps change the result in
        // the third decimal place; coarser ones start to miss the deep-shoe
        // tail, which is exactly where the money is.
        var stepSize = CARDS_PER_DECK / 2;
        for (var n = stepSize; n <= maxDealt; n += stepSize) {
            var cardsLeft = N - n;
            if (cardsLeft < CARDS_PER_DECK * 0.25) break; // below a quarter deck the ratio explodes and no one is still betting
            var decksLeft = cardsLeft / CARDS_PER_DECK;

            var rcVar = (n * cardsLeft / (N - 1)) * TAG_VARIANCE;
            var tcSd = Math.sqrt(rcVar) / decksLeft;
            if (!(tcSd > 0)) continue;

            for (var tc = TC_MIN; tc <= TC_MAX; tc++) {
                // The bucket for integer tc covers [tc-0.5, tc+0.5).
                var lo = (tc - 0.5) / tcSd;
                var hi = (tc + 0.5) / tcSd;
                var p = normalCdf(hi) - normalCdf(lo);
                buckets[tc] = (buckets[tc] || 0) + p;
            }
            steps++;
        }

        if (!steps) return [];

        var out = [];
        var total = 0;
        for (var k = TC_MIN; k <= TC_MAX; k++) {
            var f = (buckets[k] || 0) / steps;
            total += f;
            out.push({ tc: k, freq: f });
        }
        // Renormalise: the tails outside TC_MIN..TC_MAX are discarded, so the
        // raw frequencies sum to slightly under 1. Without this every EV would
        // be quietly scaled down by that missing fraction.
        if (total > 0) out.forEach(function (b) { b.freq /= total; });
        return out;
    }

    // ------------------------------------------------------------------
    // edge and spread
    // ------------------------------------------------------------------

    function baseEdgeFor(rules) {
        rules = rules || {};
        var edge = BASE_EDGE_6D_S17;
        var d = DECK_DELTA[rules.decks];
        edge += (d === undefined ? 0 : d);
        if (rules.h17) edge += RULE_DELTA.h17;
        if (rules.das === false) edge += RULE_DELTA.noDAS;
        if (rules.surrender === false) edge += RULE_DELTA.noSurrender;
        if (rules.blackjackPays === 1.2) edge += RULE_DELTA.bj6to5;
        return edge;
    }

    /** Player edge at a given true count. */
    function edgeAt(tc, baseEdge) {
        return baseEdge + EDGE_PER_TC * tc;
    }

    /**
     * The bet for a true count, read off the ramp. A ramp is a sparse list of
     * `{ tc, bet, hands }`; any count at or above an entry takes that entry's
     * bet, so the table only has to name the points where the bet CHANGES.
     * Below the lowest entry the bet is the lowest entry's — an unnamed count
     * is never treated as a zero bet by accident, because silently sitting out
     * every hand below the ramp would inflate every figure this file produces.
     */
    function betAt(tc, ramp) {
        var chosen = ramp[0];
        for (var i = 0; i < ramp.length; i++) {
            if (tc >= ramp[i].tc) chosen = ramp[i];
        }
        return chosen;
    }

    var DEFAULT_RAMP = [
        { tc: -99, bet: 1, hands: 1 },
        { tc: 1, bet: 2, hands: 1 },
        { tc: 2, bet: 4, hands: 1 },
        { tc: 3, bet: 8, hands: 2 },
        { tc: 4, bet: 12, hands: 2 },
        { tc: 5, bet: 16, hands: 2 },
        { tc: 6, bet: 20, hands: 2 }
    ];

    // ------------------------------------------------------------------
    // the whole picture
    // ------------------------------------------------------------------

    /**
     * @param {Object} cfg
     *   bankroll       total bankroll in currency units
     *   unit           the value of one betting unit
     *   roundsPerHour  rounds dealt to the player per hour
     *   ramp           [{ tc, bet, hands }] — bet in UNITS
     *   rules          { decks, penetration, h17, das, surrender, blackjackPays }
     */
    function evaluate(cfg) {
        cfg = cfg || {};
        var unit = cfg.unit > 0 ? cfg.unit : 25;
        var bankroll = cfg.bankroll > 0 ? cfg.bankroll : 0;
        var rph = cfg.roundsPerHour > 0 ? cfg.roundsPerHour : 100;
        var ramp = (cfg.ramp && cfg.ramp.length) ? cfg.ramp.slice().sort(function (a, b) { return a.tc - b.tc; }) : DEFAULT_RAMP;
        var rules = Object.assign({ decks: 6, penetration: 0.75, h17: false, das: true, surrender: true, blackjackPays: 1.5 }, cfg.rules || {});

        var baseEdge = baseEdgeFor(rules);
        var dist = tcDistribution(rules.decks, rules.penetration);

        var evUnits = 0;        // expected units won per round
        var avgBetUnits = 0;    // units wagered per round
        var varUnits = 0;       // variance in units^2 per round
        var rows = [];

        dist.forEach(function (b) {
            var r = betAt(b.tc, ramp);
            var hands = r.hands || 1;
            var wagered = r.bet * hands;
            var edge = edgeAt(b.tc, baseEdge);

            evUnits += b.freq * wagered * edge;
            avgBetUnits += b.freq * wagered;
            // Variance of the round as a whole, in units^2. `handsVariance`
            // carries the correlation: see HANDS_VARIANCE.
            varUnits += b.freq * (r.bet * r.bet) * VARIANCE_PER_UNIT * handsVariance(hands);

            rows.push({
                tc: b.tc,
                freq: b.freq,
                bet: r.bet * unit,
                betUnits: r.bet,
                hands: hands,
                edge: edge,
                evPerRound: b.freq * wagered * edge * unit
            });
        });

        var evPerHand = evUnits * unit;
        var avgBet = avgBetUnits * unit;
        var variancePerHand = varUnits * unit * unit;
        var sdPerHand = Math.sqrt(variancePerHand);

        var evPerHour = evPerHand * rph;
        var sdPerHour = sdPerHand * Math.sqrt(rph);

        // Risk of ruin for a player who never resizes, playing forever:
        //   RoR = exp(-2 * B * EV / variance), per round.
        // Zero or negative EV means ruin is certain given enough rounds, and
        // saying so plainly beats returning a comforting small number.
        var riskOfRuin;
        if (evPerHand <= 0 || bankroll <= 0) riskOfRuin = 1;
        else riskOfRuin = Math.min(1, Math.exp((-2 * bankroll * evPerHand) / variancePerHand));

        // N0: the number of rounds at which cumulative EV equals one standard
        // deviation — i.e. how long before the edge is visible through the
        // noise. N0 = variance / EV^2.
        var n0Hands = evPerHand > 0 ? variancePerHand / (evPerHand * evPerHand) : Infinity;

        // The inverse of the risk-of-ruin formula: the bankroll this exact
        // spread would need to bring ruin down to `target`. This is the number
        // the calculator exists to produce — "31% risk of ruin" tells you
        // something is wrong and not what to do about it, and the two fixes
        // (more money, or a smaller spread) are a decision you can only make
        // if you know the size of the first one.
        var bankrollForRisk = function (target) {
            if (evPerHand <= 0 || !(target > 0) || target >= 1) return Infinity;
            return (-Math.log(target) * variancePerHand) / (2 * evPerHand);
        };

        return {
            bankrollForRisk: bankrollForRisk,
            evPerHand: evPerHand,
            evPerHour: evPerHour,
            avgBet: avgBet,
            // Player edge is EV over money WAGERED, not over the flat unit:
            // dividing by the unit instead would report a "5% edge" for a
            // spread that is merely large.
            playerEdge: avgBet > 0 ? evPerHand / avgBet : 0,
            sdPerHand: sdPerHand,
            sdPerHour: sdPerHour,
            variancePerHand: variancePerHand,
            riskOfRuin: riskOfRuin,
            n0Hands: n0Hands,
            n0Hours: n0Hands === Infinity ? Infinity : n0Hands / rph,
            baseEdge: baseEdge,
            rows: rows,
            spreadLabel: describeSpread(ramp)
        };
    }

    function describeSpread(ramp) {
        var lo = Infinity, hi = 0;
        ramp.forEach(function (r) {
            var w = r.bet * (r.hands || 1);
            if (r.bet < lo) lo = r.bet;
            if (w > hi) hi = w;
        });
        return lo + '-' + hi;
    }

    var EV = {
        TAG_VARIANCE: TAG_VARIANCE,
        EDGE_PER_TC: EDGE_PER_TC,
        VARIANCE_PER_UNIT: VARIANCE_PER_UNIT,
        BASE_EDGE_6D_S17: BASE_EDGE_6D_S17,
        DEFAULT_RAMP: DEFAULT_RAMP,

        tcDistribution: tcDistribution,
        baseEdgeFor: baseEdgeFor,
        edgeAt: edgeAt,
        betAt: betAt,
        evaluate: evaluate,
        normalCdf: normalCdf
    };

    BJ.EV = EV;

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = EV;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
