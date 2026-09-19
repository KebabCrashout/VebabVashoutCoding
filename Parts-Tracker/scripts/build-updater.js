// Builds dist/Parts-Tracker-Updater-<version>.exe from build/updater.nsi.
// Run after `electron-builder --win` (npm run dist does both): the updater bundles
// the Setup exe that build produced and runs it silently in upgrade mode.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { UUID } = require('builder-util-runtime');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const productName = pkg.build.productName;
const version = pkg.version;
const dist = path.join(root, pkg.build.directories.output);

// Same GUID electron-builder derives for the install's registry keys
const ELECTRON_BUILDER_NS_UUID = UUID.parse('50e065bc-3134-11e6-9bab-38c9862bdaf3');
const guid = (pkg.build.nsis && pkg.build.nsis.guid) || UUID.v5(pkg.build.appId, ELECTRON_BUILDER_NS_UUID);

function fail(msg) {
  console.error('build-updater: ' + msg);
  process.exit(1);
}

// makensis ships in electron-builder's download cache
function findMakensis() {
  const cache = process.env.ELECTRON_BUILDER_CACHE ||
    path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'electron-builder', 'Cache');
  if (!fs.existsSync(cache)) return null;
  const found = [];
  for (const d of fs.readdirSync(cache).filter((n) => /^nsis-\d/.test(n))) {
    const dir = path.join(cache, d);
    for (const sub of fs.readdirSync(dir)) {
      const exe = path.join(dir, sub, 'makensis.exe');
      if (fs.existsSync(exe)) found.push(exe);
    }
  }
  return found.sort().pop() || null;
}

const setupExe = path.join(dist, `${productName} Setup ${version}.exe`);
if (!fs.existsSync(setupExe)) fail(`${setupExe} not found - run electron-builder --win first.`);

const icon = path.join(dist, '.icon-ico', 'icon.ico');
if (!fs.existsSync(icon)) fail(`${icon} not found - run electron-builder --win first.`);

const makensis = findMakensis();
if (!makensis) fail('makensis.exe not found in the electron-builder cache - run electron-builder --win first.');

const outFile = path.join(dist, `${productName.replace(/\s+/g, '-')}-Updater-${version}.exe`);
const defines = {
  PRODUCT_NAME: productName,
  VERSION: version,
  APP_GUID: guid,
  APP_EXE: `${productName}.exe`,
  SETUP_EXE: setupExe,
  OUT_FILE: outFile,
  ICON: icon
};

const args = ['-V2', '-INPUTCHARSET', 'UTF8',
  ...Object.entries(defines).map(([k, v]) => `-D${k}=${v}`),
  path.join(root, 'build', 'updater.nsi')];

const r = spawnSync(makensis, args, { stdio: 'inherit' });
if (r.status !== 0) fail(`makensis exited with code ${r.status}`);
console.log(`build-updater: wrote ${path.relative(root, outFile)}`);
