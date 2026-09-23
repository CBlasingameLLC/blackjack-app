// ==========================================
// bankroll.js — the real-money session ledger and the profit-vs-EV curve.
//
// DOM-free and Node-requireable. Everything here is arithmetic over a list of
// sessions; nothing renders.
//
// ---------------------------------------------------------------------------
// MONEY IS INTEGER CENTS, EVERYWHERE
//
// Floats cannot represent 0.1 + 0.2, and this ledger's whole job is to add up
// dozens of buy-ins and cash-outs and report the total. `parseMoney` converts
// once, at the input boundary, and returns null on garbage rather than 0 — a
// typo must be refused, not silently banked as a zero. Every stored figure
// below is cents; `formatMoney` is the only place they turn back into a
// string with a decimal point in it.
//
// ---------------------------------------------------------------------------
// THE EV LINE IS THE POINT, NOT THE PROFIT LINE
//
// A profit curve on its own says almost nothing over a few hundred hours: the
// standard deviation of a counted shoe game swamps the edge for far longer
// than most players' entire record. What makes the chart worth looking at is
// the SECOND line — what the game says you should have made over those hours.
// Running above it is luck, running below it is luck, and the gap closing
// over time is the only thing that indicates the edge is real.
//
// So `curve()` returns both, and the expected line is computed from the bet
// spread and rules the session was actually played under (ev.js), never from
// the results. A "expected" line fitted to the outcome would agree with the
// profit line by construction and mean nothing.
// ==========================================

(function (root) {
    'use strict';

    var BJ = (typeof window !== 'undefined')
        ? (window.BJ = window.BJ || {})
        : (root.BJ = root.BJ || {});

    var Storage = BJ.Storage || (typeof module !== 'undefined' ? require('./persistence.js') : undefined);

    var GAMES = ['Blackjack', 'Other AP'];

    // ------------------------------------------------------------------
    // money
    // ------------------------------------------------------------------

    /**
     * Parses a typed amount into integer cents. Returns null — never 0 — for
     * anything it cannot read, so a mistyped buy-in is rejected at the input
     * instead of being recorded as a free session.
     */
    function parseMoney(raw) {
        if (raw === null || raw === undefined) return null;
        var s = String(raw).trim().replace(/[$,\s]/g, '');
        if (s === '' || s === '-' || s === '.') return null;
        if (!/^-?\d*\.?\d*$/.test(s)) return null;
        var n = Number(s);
        if (!Number.isFinite(n)) return null;
        // Rounded, not truncated: 19.999 from a float round-trip must land on
        // 2000, not 1999.
        return Math.round(n * 100);
    }

    function formatMoney(cents, opts) {
        opts = opts || {};
        if (cents === null || cents === undefined || !Number.isFinite(cents)) return '—';
        var neg = cents < 0;
        var abs = Math.abs(cents);
        var whole = Math.floor(abs / 100);
        var body = whole.toLocaleString('en-US');
        if (!opts.whole) {
            var frac = abs % 100;
            body += '.' + (frac < 10 ? '0' + frac : String(frac));
        }
        var sign = neg ? '-' : (opts.signed ? '+' : '');
        return sign + '$' + body;
    }

    function parseHours(raw) {
        var n = Number(String(raw === null || raw === undefined ? '' : raw).trim());
        if (!Number.isFinite(n) || n < 0) return null;
        return Math.round(n * 100) / 100;
    }

    // ------------------------------------------------------------------
    // sessions
    // ------------------------------------------------------------------

    function getSessions() {
        var raw = (Storage && Storage.get('sessions', null)) || [];
        return Array.isArray(raw) ? raw : [];
    }

    function setSessions(list) {
        if (Storage) Storage.set('sessions', list);
        return list;
    }

    /**
     * Builds a session record from typed input, or returns `{ error }`.
     * Validation lives here rather than in the view so the same refusals
     * apply however a session arrives.
     */
    function buildSession(input) {
        input = input || {};
        var buyIn = parseMoney(input.buyIn);
        var cashOut = parseMoney(input.cashOut);
        var hours = parseHours(input.hours);

        if (buyIn === null) return { error: 'Buy-in is not a number.' };
        if (cashOut === null) return { error: 'Cash-out is not a number.' };
        if (hours === null) return { error: 'Hours is not a number.' };
        if (hours === 0) return { error: 'A session with no hours cannot be rated.' };
        if (!input.date) return { error: 'A session needs a date.' };

        return {
            session: {
                id: 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
                date: input.date,
                venue: String(input.venue || '').trim() || 'Unnamed',
                game: GAMES.indexOf(input.game) > -1 ? input.game : GAMES[0],
                hours: hours,
                buyInCents: buyIn,
                cashOutCents: cashOut,
                // Profit is DERIVED and stored anyway, because the ledger is
                // read far more often than it is written and re-deriving it on
                // every read of every row is the kind of thing that makes a
                // list of a few hundred rows feel slow for no reason. It is
                // recomputed on every write, never edited on its own.
                profitCents: cashOut - buyIn,
                // What the session was played under. Kept PER SESSION rather
                // than read from current settings: the expected line for a
                // night played at 1-12 on a 6-deck shoe must not silently
                // change because the spread was retuned last week.
                unitCents: parseMoney(input.unit) || 2500,
                spread: String(input.spread || '').trim(),
                evPerHourCents: parseMoney(input.evPerHour) || 0,
                notes: String(input.notes || '').trim()
            }
        };
    }

    function addSession(input) {
        var built = buildSession(input);
        if (built.error) return built;
        var list = getSessions();
        list.push(built.session);
        list.sort(function (a, b) { return String(a.date).localeCompare(String(b.date)); });
        setSessions(list);
        return { session: built.session };
    }

    function deleteSession(id) {
        var list = getSessions().filter(function (s) { return s.id !== id; });
        setSessions(list);
        return list;
    }

    // ------------------------------------------------------------------
    // the numbers
    // ------------------------------------------------------------------

    function filterGame(list, game) {
        if (!game || game === 'All') return list;
        return list.filter(function (s) { return s.game === game; });
    }

    /**
     * Headline figures. `expectedCents` is the sum of each session's own
     * hourly EV over its own hours — never a single rate applied to the
     * total, which would rewrite the history of every session played at a
     * different spread.
     */
    function summary(list) {
        var profit = 0, hours = 0, expected = 0, wins = 0;
        list.forEach(function (s) {
            profit += s.profitCents || 0;
            hours += s.hours || 0;
            expected += Math.round((s.evPerHourCents || 0) * (s.hours || 0));
            if ((s.profitCents || 0) > 0) wins++;
        });
        return {
            sessions: list.length,
            hours: Math.round(hours * 100) / 100,
            profitCents: profit,
            expectedCents: expected,
            // The gap is the interesting number: how far luck has carried you
            // away from what the game owes. Named rather than left for the
            // reader to subtract two figures they are looking at separately.
            luckCents: profit - expected,
            perHourCents: hours > 0 ? Math.round(profit / hours) : null,
            expectedPerHourCents: hours > 0 ? Math.round(expected / hours) : null,
            winningSessions: wins,
            winRate: list.length > 0 ? wins / list.length : null
        };
    }

    /**
     * Cumulative profit and cumulative expectation, plotted against HOURS
     * PLAYED rather than against the calendar.
     *
     * Hours is the right axis because it is the axis variance actually runs
     * on: a month with four sessions in it and a month with one are not
     * comparable lengths of exposure, and a date axis draws them the same
     * width. It is also what makes the two lines directly comparable — the
     * expected line is a straight climb in hours and a lumpy one in dates.
     */
    function curve(list) {
        var pts = [{ hours: 0, profitCents: 0, expectedCents: 0 }];
        var h = 0, p = 0, e = 0;
        list.slice().sort(function (a, b) { return String(a.date).localeCompare(String(b.date)); })
            .forEach(function (s) {
                h += s.hours || 0;
                p += s.profitCents || 0;
                e += Math.round((s.evPerHourCents || 0) * (s.hours || 0));
                pts.push({
                    hours: Math.round(h * 100) / 100,
                    profitCents: p,
                    expectedCents: e,
                    id: s.id,
                    venue: s.venue,
                    date: s.date
                });
            });
        return pts;
    }

    var Bankroll = {
        GAMES: GAMES,
        parseMoney: parseMoney,
        formatMoney: formatMoney,
        parseHours: parseHours,

        getSessions: getSessions,
        buildSession: buildSession,
        addSession: addSession,
        deleteSession: deleteSession,

        filterGame: filterGame,
        summary: summary,
        curve: curve
    };

    BJ.Bankroll = Bankroll;

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = Bankroll;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
