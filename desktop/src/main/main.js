// ============================================================================
// main.js - the Electron shell.
//
// THE ENGINE IS NOT COPIED HERE. There is no lib/ under desktop/ and there
// never should be: this window loads the SAME built renderer the web and
// mobile builds ship (`npm run build` at the repo root), served over a custom
// protocol. A rules fix, a strategy-table correction or a gamification change
// lands on every target at once because there is only ever one copy of it.
//
// WHY A CUSTOM PROTOCOL AND NOT file://. index.html references the engine with
// absolute paths (`/js/blackjack/rules.js`, `/css/blackjack.css`). Vite copies
// public/ verbatim and does not rewrite those, so under file:// every one of
// them would resolve against the drive root and the app would load a blank
// page with no scripts. Under app://, `/js/...` resolves inside the renderer
// directory exactly as it does on a web server.
//
// The scheme MUST be registered as standard+secure before app-ready. Not for
// tidiness: localStorage is unavailable on a non-secure, non-standard origin,
// and persistence.js stores every stat the player owns in it - an unprivileged
// scheme would produce an app that runs perfectly and forgets everything.
// ============================================================================

import { app, BrowserWindow, protocol, net, ipcMain, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
    files, readStore, writeStore, writeSnapshot, recoverPending, resolveDataDir
} from './dataStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RENDERER_DIR = app.isPackaged
    ? path.join(process.resourcesPath, 'renderer')
    : path.resolve(__dirname, '../../../dist');

// A packaged build takes its icon from the executable's own resources, but a
// dev run has no executable of ours - so without this, `npm start` shows the
// Electron logo in the taskbar, which is where this app is looked at most
// during development.
const WINDOW_ICON = path.resolve(__dirname, '../../build/icon.ico');

// THE NO-SCROLL CONTRACT IS ABOUT THE CONTENT BOX, AND minWidth/minHeight ARE
// NOT. Electron measures both minimums as WINDOW size, frame included, so a
// minHeight of 800 on Windows leaves the page about 769px - and the desktop
// layout is built to fit 1280x800 of actual pixels. Asking for the window
// minimum and getting a smaller content minimum is how a guarantee quietly
// becomes an aspiration, so the frame is measured once at creation and the
// floor raised by exactly that much.
const MIN_CONTENT = { width: 1280, height: 800 };

protocol.registerSchemesAsPrivileged([{
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, allowServiceWorkers: false }
}]);

let mainWindow = null;

function registerAppProtocol() {
    protocol.handle('app', async (request) => {
        const url = new URL(request.url);
        // Strip the query/hash and normalise, then confirm the result is still
        // inside RENDERER_DIR. `app://host/../../etc/passwd` is a perfectly
        // ordinary string until you join it onto a path.
        const rel = decodeURIComponent(url.pathname);
        const target = path.normalize(path.join(RENDERER_DIR, rel === '/' ? 'index.html' : rel));
        if (!target.startsWith(RENDERER_DIR)) {
            return new Response('Forbidden', { status: 403 });
        }
        return net.fetch(pathToFileURL(target).toString());
    });
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1440,
        height: 900,
        icon: WINDOW_ICON,
        backgroundColor: '#080b0d',
        show: false,
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, '../preload/preload.cjs'),
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false
        }
    });

    // Window size minus content size is the frame; adding it back makes the
    // minimum a genuine 1280x800 of page.
    const [winW, winH] = mainWindow.getSize();
    const [contentW, contentH] = mainWindow.getContentSize();
    mainWindow.setMinimumSize(
        MIN_CONTENT.width + (winW - contentW),
        MIN_CONTENT.height + (winH - contentH)
    );

    mainWindow.once('ready-to-show', () => mainWindow.show());
    mainWindow.loadURL('app://bundle/index.html');

    // Anything that is not this app opens in the real browser, with its own
    // address bar. A window we control is not a place to show someone else's
    // login page.
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//i.test(url)) shell.openExternal(url);
        return { action: 'deny' };
    });
}

function wireIPC() {
    ipcMain.handle('bj:version', () => app.getVersion());
    ipcMain.handle('bj:data-dir', () => resolveDataDir());
    ipcMain.handle('bj:open-data-dir', () => shell.openPath(resolveDataDir()));
    // Synchronous twin, used only by the preload's restore-before-boot path.
    // Sync IPC is a deliberate choice in exactly one place: the alternative is
    // racing the engine's constructor, and losing that race silently mirrors
    // an empty store over a real one.
    ipcMain.on('bj:load-store-sync', (evt) => { evt.returnValue = readStore(); });

    ipcMain.handle('bj:save', (_evt, payload) => {
        payload = payload || {};
        const version = app.getVersion();
        const a = payload.kv ? writeStore(payload.kv, version) : { ok: true };
        const b = payload.snapshot ? writeSnapshot(payload.snapshot, version) : { ok: true };
        const ok = a.ok && b.ok;
        return {
            ok,
            dir: resolveDataDir(),
            error: ok ? null : String((a.error || b.error || '').message || a.error || b.error)
        };
    });
}

app.whenReady().then(() => {
    recoverPending();
    registerAppProtocol();
    wireIPC();
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });

    if (app.isPackaged) {
        // Lazy: pulling the updater in at module scope would make every
        // headless test of this file drag a network-capable dependency along.
        import('electron-updater')
            .then(({ default: pkg }) => pkg.autoUpdater.checkForUpdatesAndNotify())
            .catch(() => { /* an update check is never worth a crash */ });
    }
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

export { RENDERER_DIR, files, MIN_CONTENT, WINDOW_ICON };
