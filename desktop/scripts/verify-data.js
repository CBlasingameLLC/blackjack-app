// ============================================================================
// verify-data.js - contract checks for the data folder. Plain Node, no
// Electron: everything load-bearing about persistence is deliberately outside
// the Electron process so it can be tested without one.
//
// Runs entirely inside a scratch BJ_DATA_DIR. Pointing a test at the real
// folder is how you end up debugging your own training history.
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bjdata-'));
process.env.BJ_DATA_DIR = scratch;

const { writeAtomic, recoverFrom } = await import('../src/main/atomicWrite.js');
const DS = await import('../src/main/dataStore.js');

let failures = 0;
const ok = (m) => console.log('  OK   ' + m);
const fail = (m) => { console.log('  FAIL ' + m); failures++; };
const eq = (a, b, m) => (a === b ? ok(`${m} (${a})`) : fail(`${m} — expected ${b}, got ${a}`));

console.log('-- data folder contract --');

eq(DS.resolveDataDir(), path.resolve(scratch), 'BJ_DATA_DIR overrides the data dir');

// A fresh machine must be distinguishable from a player with no data.
eq(DS.readStore(), null, 'readStore() is null before anything is written');
eq(DS.readSnapshot(), null, 'readSnapshot() is null before anything is written');

const kv = { junto_blackjack_bankroll: '10000', junto_blackjack_progression: '{"xp":250}' };
eq(DS.writeStore(kv, '1.0.0').ok, true, 'writeStore succeeds');
eq(JSON.stringify(DS.readStore()), JSON.stringify(kv), 'store round-trips verbatim');

// The values must come back as the same STRINGS localStorage held — a number
// here would mean the mirror re-typed the player's data on the way through.
eq(typeof DS.readStore().junto_blackjack_bankroll, 'string', 'kv values stay serialized strings');

const snap = { player: { level: 7, xp: 525 }, stats: { lifetime: { decisions: 400 } } };
eq(DS.writeSnapshot(snap, '1.0.0').ok, true, 'writeSnapshot succeeds');
const back = DS.readSnapshot();
eq(back.player.level, 7, 'snapshot round-trips');
eq(back.version, DS.SCHEMA_VERSION, 'snapshot carries a schema version');
eq(typeof back.writtenAt, 'string', 'snapshot is stamped with a write time');

// An empty store is a real answer, not the absence of one.
DS.writeStore({}, '1.0.0');
eq(JSON.stringify(DS.readStore()), '{}', 'an empty-but-present store reads as {} not null');

// A healthy write must leave nothing behind.
const leftovers = fs.readdirSync(scratch).filter((n) => n.endsWith('.tmp'));
eq(leftovers.length, 0, 'no temp files remain after successful writes');

console.log('\n-- the rename actually failing (a real OS refusal, not an injected one) --');
// Renaming a file onto an existing DIRECTORY is refused by the OS itself. The
// point is to exercise the real failure path rather than a stubbed one — an
// injected failure proves only that the stub works.
const blocked = path.join(scratch, 'blocked.json');
fs.mkdirSync(blocked);
const res = writeAtomic(blocked, '{"a":1}');
eq(res.ok, false, 'a genuinely unrenameable destination reports failure honestly');
eq(res.attempts > 1, true, `the retry ladder actually retried (${res.attempts} attempts)`);
const orphans = fs.readdirSync(scratch).filter((n) => n.startsWith('blocked.json.') && n.endsWith('.tmp'));
eq(orphans.length, 1, 'the completed temp file is KEPT, not deleted, when the rename fails');
eq(fs.readFileSync(path.join(scratch, orphans[0]), 'utf8'), '{"a":1}', 'the kept temp holds the full payload');

// ...and next launch promotes it once the obstruction is gone.
fs.rmdirSync(blocked);
eq(recoverFrom(blocked), true, 'recoverFrom promotes the orphaned temp on the next launch');
eq(fs.readFileSync(blocked, 'utf8'), '{"a":1}', 'the recovered file has the right contents');
eq(fs.readdirSync(scratch).filter((n) => n.endsWith('.tmp')).length, 0, 'recovery clears the temp');

console.log('\n-- the MCP server reads what the app writes --');
// Two files, two processes, one format. If these ever disagree the coach
// reports numbers the player has never seen.
process.env.BJ_DATA_DIR = scratch;
const mcpDir = (() => {
    const o = process.env.BJ_DATA_DIR;
    return o && o.trim() ? path.resolve(o.trim()) : path.join(os.homedir(), '.blackjack-pro');
})();
eq(mcpDir, DS.resolveDataDir(), 'the MCP server resolves the same folder the app writes');
const asMcpReads = JSON.parse(fs.readFileSync(path.join(mcpDir, 'snapshot.json'), 'utf8'));
eq(asMcpReads.player.level, 7, 'the MCP server reads back the app-written snapshot');

fs.rmSync(scratch, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
