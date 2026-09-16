// ============================================================================
// preload.cjs - the whole surface the page can reach the filesystem through.
//
// CommonJS on purpose: an ESM preload requires sandbox:false, and the sandbox
// is worth more than the import syntax.
//
// The renderer names an INTENT and hands over plain data. It never sees a path,
// never picks a filename, and cannot ask for an arbitrary file to be read or
// written - the main process owns all three. A bug in the page therefore
// cannot widen what this app touches on disk.
// ============================================================================

const { contextBridge, ipcRenderer } = require('electron');

const PREFIX = 'junto_blackjack_';

/**
 * Restore-before-boot. This runs at document-start, before a single engine
 * script has parsed, and that timing is the entire point: the engine reads
 * localStorage synchronously as it constructs, so an async restore would hand
 * the game an empty store and the first mirror flush would then overwrite the
 * real file with that emptiness.
 *
 * It only ever fills a store that is EMPTY. Merging into a populated one would
 * mean resurrecting stats the player had deliberately cleared.
 */
function restoreIfEmpty() {
    let mirrored = null;
    try {
        mirrored = ipcRenderer.sendSync('bj:load-store-sync');
    } catch { return; }
    if (!mirrored || typeof mirrored !== 'object') return;

    try {
        for (let i = 0; i < window.localStorage.length; i++) {
            const k = window.localStorage.key(i);
            if (k && k.startsWith(PREFIX)) return; // already has data - leave it alone
        }
        Object.keys(mirrored).forEach((k) => {
            if (k.startsWith(PREFIX) && typeof mirrored[k] === 'string') {
                window.localStorage.setItem(k, mirrored[k]);
            }
        });
    } catch { /* blocked storage - the app still runs, it just will not restore */ }
}

restoreIfEmpty();

contextBridge.exposeInMainWorld('bjDesktop', {
    isDesktop: true,
    version: () => ipcRenderer.invoke('bj:version'),
    save: (payload) => ipcRenderer.invoke('bj:save', payload),
    dataDir: () => ipcRenderer.invoke('bj:data-dir'),
    openDataDir: () => ipcRenderer.invoke('bj:open-data-dir')
});
