#!/usr/bin/env node
// ============================================================================
// server.js - the MCP surface over Blackjack Pro's training data (stdio).
//
// READ-ONLY, STRUCTURALLY. There is deliberately no tool here that writes
// anything. The app is the only writer of ~/.blackjack-pro/, which is what
// makes it safe for this process to have no locking and no merge logic - and
// it means a coaching conversation can never corrupt a training history by
// accident. If a write tool is ever wanted, it belongs in a separate file that
// writes a separate inbox file, never into store.json or snapshot.json.
//
// It reads the SNAPSHOT rather than recomputing anything from the raw store.
// The snapshot is built in the renderer by the same gamification.js the screens
// render from, so what a coach reads here and what the player is looking at
// cannot disagree. Recomputing accuracy or ladder status in this process would
// be a second implementation, and second implementations drift.
//
// Register with:  claude mcp add blackjack -- node <abs path to this file>
// ============================================================================

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Must match desktop/src/main/dataStore.js resolveDataDir() exactly.
function dataDir() {
    const override = process.env.BJ_DATA_DIR;
    if (override && override.trim()) return path.resolve(override.trim());
    return path.join(os.homedir(), '.blackjack-pro');
}

function readSnapshot() {
    try {
        return JSON.parse(fs.readFileSync(path.join(dataDir(), 'snapshot.json'), 'utf8'));
    } catch {
        return null;
    }
}

/** Every tool answers through this, so "no data yet" is one sentence, not five. */
function respond(build) {
    const snap = readSnapshot();
    if (!snap) {
        return {
            content: [{
                type: 'text',
                text: `No Blackjack Pro data found in ${dataDir()}. The desktop app writes it a few seconds after it opens — if it has never been run on this machine, there is nothing to read yet.`
            }]
        };
    }
    return { content: [{ type: 'text', text: JSON.stringify(build(snap), null, 2) }] };
}

const server = new McpServer({ name: 'blackjack-pro', version: '1.0.0' });

server.tool(
    'get_player',
    'Rank, level, XP, streaks and Skill Ladder position for the Blackjack Pro player.',
    {},
    async () => respond((s) => ({ player: s.player, ladder: s.ladder, writtenAt: s.writtenAt }))
);

server.tool(
    'get_stats',
    'Lifetime and current-session accuracy, overall and broken down by training mode.',
    {},
    async () => respond((s) => ({ stats: s.stats, writtenAt: s.writtenAt }))
);

server.tool(
    'get_trends',
    'Raw per-decision history (newest last) for accuracy-over-time analysis. Optionally limited to the most recent N decisions and/or one mode.',
    { limit: z.number().int().positive().max(2000).optional(), mode: z.string().optional() },
    async ({ limit, mode }) => respond((s) => {
        let rows = Array.isArray(s.trends?.decisions) ? s.trends.decisions : [];
        if (mode) rows = rows.filter((r) => r.mode === mode);
        if (limit) rows = rows.slice(-limit);
        return { count: rows.length, decisions: rows, writtenAt: s.writtenAt };
    })
);

server.tool(
    'get_mistakes',
    'The mistake log - what was played, what was correct, and the hand it happened on. This is the raw material for a leak report.',
    { limit: z.number().int().positive().max(500).optional(), mode: z.string().optional() },
    async ({ limit, mode }) => respond((s) => {
        let rows = Array.isArray(s.mistakes) ? s.mistakes : [];
        if (mode) rows = rows.filter((r) => r.mode === mode);
        if (limit) rows = rows.slice(-limit);
        return { count: rows.length, mistakes: rows, writtenAt: s.writtenAt };
    })
);

server.tool(
    'get_achievements',
    'Unlocked achievements with their dates, plus the current daily challenge.',
    {},
    async () => respond((s) => ({ achievements: s.achievements, challenge: s.challenge, writtenAt: s.writtenAt }))
);

server.tool(
    'get_snapshot',
    'The entire snapshot in one call - player, ladder, stats, trends, achievements, mistakes, bankroll and settings.',
    {},
    async () => respond((s) => s)
);

await server.connect(new StdioServerTransport());
