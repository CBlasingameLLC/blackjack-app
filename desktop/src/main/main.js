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
        width: 1280,
        height: 860,
        minWidth: 1024,
        minHeight: 720,
        backgroundColor: '#101013',
        show: false,
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, '../preload/preload.cjs'),
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false
        }
    });

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

export { RENDERER_DIR, files };
