// ============================================================================
// verify-mcp.js - speaks real JSON-RPC over stdio to the MCP server, against a
// fixture data dir. An MCP server that fails to start is silent until someone
// tries to use it in a conversation, which is the worst possible moment.
// ============================================================================

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bjmcp-'));

fs.writeFileSync(path.join(scratch, 'snapshot.json'), JSON.stringify({
    version: 1, writtenAt: '2026-09-16T12:00:00.000Z',
    player: { level: 12, xp: 1650, rank: 'Counter', currentStreak: 4, bestStreak: 31 },
    ladder: [{ id: 'basic', status: 'mastered', pct: 97 }],
    stats: { lifetime: { decisions: 1650, correct: 1560, accuracy: 95, byMode: { hard: { total: 900, correct: 870 } } } },
    trends: { decisions: [{ t: 1, correct: true, mode: 'hard' }, { t: 2, correct: false, mode: 'soft' }] },
    achievements: [{ id: 'century', title: 'Century', unlockedAt: 1 }],
    mistakes: [{ mode: 'hard', handDescription: 'Hard 16', dealerUpcard: 10, playerAction: 'Hit', correctAction: 'Stand' }],
    challenge: { title: 'Sharp Start', completed: true }
}), 'utf8');

let failures = 0;
const ok = (m) => console.log('  OK   ' + m);
const fail = (m) => { console.log('  FAIL ' + m); failures++; };
const eq = (a, b, m) => (a === b ? ok(`${m} (${JSON.stringify(a)})`) : fail(`${m} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`));

const child = spawn(process.execPath, [path.join(__dirname, '../mcp/server.js')], {
    env: { ...process.env, BJ_DATA_DIR: scratch },
    stdio: ['pipe', 'pipe', 'pipe']
});

let buf = '';
const pending = new Map();
child.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
            const msg = JSON.parse(line);
            if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
        } catch { /* not a JSON-RPC line */ }
    }
});
child.stderr.on('data', (d) => { const s = d.toString().trim(); if (s) console.log('       [server] ' + s); });

let nextId = 1;
function rpc(method, params) {
    return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, resolve);
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), 10000);
    });
}
function notify(method, params) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

console.log('-- MCP server over real stdio --');
try {
    const init = await rpc('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'verify-mcp', version: '1.0.0' }
    });
    eq(init.result?.serverInfo?.name, 'blackjack-pro', 'server identifies itself on initialize');
    notify('notifications/initialized');

    const list = await rpc('tools/list', {});
    const names = (list.result?.tools || []).map((t) => t.name).sort();
    eq(names.join(','), 'get_achievements,get_mistakes,get_player,get_snapshot,get_stats,get_trends', 'all six read tools are exposed');
    // The single most important property of this server.
    eq(names.some((n) => /write|set|update|delete|propose/i.test(n)), false, 'NO tool can write — the app stays the only writer');

    const player = await rpc('tools/call', { name: 'get_player', arguments: {} });
    const parsed = JSON.parse(player.result.content[0].text);
    eq(parsed.player.level, 12, 'get_player reads the snapshot the app wrote');
    eq(parsed.player.rank, 'Counter', 'rank comes through');

    const trends = await rpc('tools/call', { name: 'get_trends', arguments: { mode: 'hard' } });
    const t = JSON.parse(trends.result.content[0].text);
    eq(t.count, 1, 'get_trends filters by mode');

    const mistakes = await rpc('tools/call', { name: 'get_mistakes', arguments: { limit: 1 } });
    const m = JSON.parse(mistakes.result.content[0].text);
    eq(m.mistakes[0].correctAction, 'Stand', 'get_mistakes returns the leak data');
} catch (err) {
    fail(String(err.message || err));
}

// A machine with no data must say so plainly rather than returning an empty
// object a coach would read as "this player has never got anything right".
const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'bjmcp-empty-'));
const child2 = spawn(process.execPath, [path.join(__dirname, '../mcp/server.js')], {
    env: { ...process.env, BJ_DATA_DIR: empty }, stdio: ['pipe', 'pipe', 'ignore']
});
let buf2 = '';
const got = await new Promise((resolve) => {
    child2.stdout.on('data', (c) => {
        buf2 += c.toString();
        for (const line of buf2.split('\n')) {
            try { const msg = JSON.parse(line); if (msg.id === 2) resolve(msg); } catch { /* keep reading */ }
        }
    });
    child2.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'v', version: '1' } } }) + '\n');
    setTimeout(() => {
        child2.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
        child2.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_player', arguments: {} } }) + '\n');
    }, 300);
    setTimeout(() => resolve(null), 10000);
});
eq(/No Blackjack Pro data found/.test(got?.result?.content?.[0]?.text || ''), true, 'an empty data dir is reported in words, not as empty data');

child.kill(); child2.kill();
fs.rmSync(scratch, { recursive: true, force: true });
fs.rmSync(empty, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
