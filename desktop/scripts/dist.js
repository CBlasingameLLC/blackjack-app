// ============================================================================
// dist.js - runs electron-builder with its output OUTSIDE the repo.
//
// This repo lives under Documents/, which OneDrive syncs, and OneDrive holds
// freshly written files open just long enough that electron-builder's own
// staging rename fails:
//   EPERM: operation not permitted, rename release\win-unpacked.tmp
//                                       -> release\win-unpacked
// That is the same class of transient Windows lock atomicWrite.js retries
// around for our own writes. The difference is electron-builder does not
// retry, so the build does not degrade - it dies outright, on a healthy disk
// with 20GB free, in a way that reads like a permissions problem and is not.
//
// %LOCALAPPDATA% is never sync-backed, so the staging directory is safe there.
// BJ_BUILD_OUT overrides it for anyone whose checkout is not under OneDrive.
// ============================================================================

import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const out = process.env.BJ_BUILD_OUT
    || (process.env.LOCALAPPDATA
        ? path.join(process.env.LOCALAPPDATA, 'blackjack-pro-release')
        : path.join(os.homedir(), '.blackjack-pro-release'));

console.log('electron-builder output -> ' + out);

// shell:true because on Windows spawnSync will not resolve a .cmd shim from
// PATH on its own - without it electron-builder never starts at all and the
// only symptom is a non-zero exit with no output whatsoever, which reads like
// a build failure rather than a launch failure.
const res = spawnSync(
    `npx electron-builder --win --config electron-builder.yml -c.directories.output="${out}" --publish never`,
    { stdio: 'inherit', shell: true, cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') }
);

if (res.error) console.error('\nCould not start electron-builder: ' + res.error.message);
if (res.status !== 0) {
    console.error('\nBuild failed. If this is another EPERM on a rename under a synced\nfolder, set BJ_BUILD_OUT to a path outside OneDrive and retry.');
}
process.exit(res.status ?? 1);
