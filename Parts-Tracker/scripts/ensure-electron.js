'use strict';
// npm postinstall guard.
//
// Electron downloads its ~230MB binary from its own postinstall script. That
// step silently does not run in some npm setups (the installed package can
// arrive with no "scripts" field at all), leaving `npm install` reporting
// success but `npm start` failing with "Electron failed to install correctly".
// This runs the downloader ourselves when, and only when, the binary is absent.
//
// It must never fail the install: `npm install --omit=dev` legitimately skips
// Electron, and a throwing postinstall would break that. Always exits 0.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const MANUAL_HINT = 'node node_modules/electron/install.js';

function electronBinaryPath() {
  // Electron's index.js resolves the platform-correct binary and throws if the
  // install is incomplete - so this covers Windows, macOS and Linux.
  try {
    const p = require('electron');
    return typeof p === 'string' ? p : null;
  } catch (err) {
    return null;
  }
}

function main() {
  const existing = electronBinaryPath();
  if (existing && fs.existsSync(existing)) return; // already good - do nothing

  let electronDir;
  try {
    electronDir = path.dirname(require.resolve('electron/package.json'));
  } catch (err) {
    return; // Electron isn't installed at all (e.g. --omit=dev); nothing to do
  }

  const installer = path.join(electronDir, 'install.js');
  if (!fs.existsSync(installer)) return;

  console.log('[parts-tracker] Electron binary missing - downloading it now...');
  try {
    execFileSync(process.execPath, [installer], { cwd: electronDir, stdio: 'inherit' });
  } catch (err) {
    console.warn('[parts-tracker] Could not download Electron automatically.');
    console.warn('[parts-tracker] Run this once by hand:  ' + MANUAL_HINT);
  }
}

try {
  main();
} catch (err) {
  console.warn('[parts-tracker] Electron check skipped: ' + (err && err.message));
  console.warn('[parts-tracker] If the app will not start, run:  ' + MANUAL_HINT);
}
