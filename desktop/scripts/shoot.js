// ============================================================================
// shoot.js - boots the app on a SEEDED scratch profile and screenshots every
// screen at the 1280x800 contract size.
//
//   npx electron scripts/shoot.js        -> %TEMP%/bjshots-*/  (path printed)
//
// A layout test proves nothing overflows. It cannot tell you the ladder is
// unreadable or that a card is 90% empty, and both of those are the actual
// point of a reskin. This is for looking.
//
// IT SEEDS THROUGH THE REAL ENGINE, not by writing localStorage. Empty panels
// are the one state a design review must not be done in - every card looks
// balanced with nothing in it - and hand-written fixtures drift from whatever
// the engine actually stores. Playing hands produces genuine lifetime stats, a
// genuine mistake log, real XP and real achievements.
// ============================================================================

import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bjshots-'));
process.env.BJ_DATA_DIR = scratch;
const profileDir = path.join(scratch, 'profile');
fs.mkdirSync(profileDir, { recursive: true });
app.setPath('userData', profileDir);

await import('../src/main/main.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Deliberately imperfect: a 100% player has an empty mistake log and an empty
// heatmap, which are two of the four panels on the Stats screen.
const SEED = `(function () {
    const gm = window.BJ.instance.gameManager;
    // Instant pace, or 144 rounds at the default 800ms deal animation takes
    // longer than anyone will wait for a screenshot.
    gm.updateSettings({ gameSpeed: 0, drillStyle: 'flash', casualMode: false });
    const drill = (mode, rounds, missEvery) => {
        gm.setGameMode(mode);
        for (let i = 0; i < rounds; i++) {
            gm.startRound();
            // Alternating hit/stand against a real shoe gets a realistic mix
            // of right and wrong without the test deciding which is which.
            if (i % missEvery === 0) { try { gm.playerHit(); } catch (e) {} }
            try { gm.playerStand(); } catch (e) {}
        }
    };
    drill('hard', 60, 4);
    drill('soft', 30, 3);
    drill('pairs', 24, 5);
    drill('deviations', 18, 3);
    drill('surrender', 12, 4);
    return true;
})()`;

app.whenReady().then(async () => {
    await wait(600);
    const win = BrowserWindow.getAllWindows()[0];
    if (win.webContents.isLoading()) {
        await new Promise((r) => win.webContents.once('did-finish-load', r));
    }
    await wait(1500);

    win.setContentSize(1280, 800);
    await wait(400);

    await win.webContents.executeJavaScript(SEED);
    await wait(500);

    const shoot = async (name) => {
        const img = await win.webContents.capturePage();
        const file = path.join(scratch, name + '.png');
        fs.writeFileSync(file, img.toPNG());
        console.log('  ' + file);
    };

    for (const tab of ['path', 'practice', 'charts', 'edge', 'stats', 'profile']) {
        await win.webContents.executeJavaScript(`window.BJ.Hub.showHub('${tab}')`);
        await wait(450);
        await shoot(tab);
    }

    // The table, mid-hand, so cards and the dashboard are both on screen.
    await win.webContents.executeJavaScript(`(function () {
        const gm = window.BJ.instance.gameManager;
        gm.setGameMode('testout');
        gm.setBet(25, { replace: true });
        gm.startRound();
    })()`);
    await wait(700);
    await shoot('table');

    console.log('\nshots: ' + scratch);
    app.exit(0);
});
