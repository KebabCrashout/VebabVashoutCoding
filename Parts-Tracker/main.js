const { app, BrowserWindow, ipcMain, dialog, shell, net } = require('electron');
const path = require('path');
const fs = require('fs');

// An installed app lives in Program Files inside a read-only asar archive, so
// it must keep user data in the per-user AppData folder. In development we
// keep it beside the source, which is handier and leaves existing data alone.
const DATA_DIR = app.isPackaged
  ? path.join(app.getPath('userData'), 'data')
  : path.join(__dirname, 'data');
const IMAGES_DIR = path.join(DATA_DIR, 'images');
const DATA_FILE = path.join(DATA_DIR, 'products.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const DEFAULT_SETTINGS = {
  theme: 'dark',
  glowColors: { ordered: '#ff9432', received: '#6fd3ff', fitted: '#3ddc84' },
  currency: 'GBP',
  appName: 'Parts Tracker',
  logo: null,
  anthropicApiKey: '',
  geminiApiKey: '',
  aiProvider: 'gemini',
  vehicle: ''
};

// Logo files live in data/ (not data/images) so "Reset app data" keeps them
function removeLogoFiles() {
  for (const f of fs.readdirSync(DATA_DIR)) {
    if (/^logo_\d+\./.test(f)) {
      try { fs.unlinkSync(path.join(DATA_DIR, f)); } catch (err) { /* ignore */ }
    }
  }
}

function ensureDataDirs() {
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ products: [] }, null, 2), 'utf8');
  }
}

function readRawData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8').replace(new RegExp('^\\uFEFF'), '');
    const data = JSON.parse(raw);
    return data;
  } catch (err) {
    return null;
  }
}

function newId() {
  return require('crypto').randomUUID();
}

// "2007 Mazda 3 MPS (BK chassis, UK model)" -> "2007 Mazda 3 MPS"
function carNameFromVehicle(vehicle) {
  return String(vehicle || '').replace(/\s*\([^)]*\)\s*/g, ' ').trim() || 'My car';
}

// Every product belongs to a car. Older data files held one flat product list;
// that becomes the first car, using the vehicle previously set in Settings.
function normaliseStore(raw) {
  if (raw && Array.isArray(raw.cars) && raw.cars.length) {
    for (const car of raw.cars) {
      if (!Array.isArray(car.products)) car.products = [];
      if (typeof car.vehicle !== 'string') car.vehicle = '';
    }
    if (!raw.cars.some((c) => c.id === raw.activeCarId)) raw.activeCarId = raw.cars[0].id;
    return { store: raw, migrated: false };
  }
  const vehicle = loadSettings().vehicle || '';
  const car = {
    id: newId(),
    name: carNameFromVehicle(vehicle),
    vehicle,
    products: raw && Array.isArray(raw.products) ? raw.products : []
  };
  return { store: { cars: [car], activeCarId: car.id }, migrated: true };
}

function loadData() {
  const raw = readRawData();
  const { store, migrated } = normaliseStore(raw);
  if (migrated) {
    // Keep the pre-migration file once, so the old format can always be recovered
    const backup = path.join(DATA_DIR, 'products.before-multi-car.json');
    if (raw && Array.isArray(raw.products) && raw.products.length && !fs.existsSync(backup)) {
      fs.copyFileSync(DATA_FILE, backup);
    }
    saveData(store);
  }
  return store;
}

// A product and the car it belongs to, wherever it lives
function locateProduct(productId) {
  for (const car of loadData().cars) {
    const product = car.products.find((p) => p.id === productId);
    if (product) return { car, product };
  }
  return null;
}

// AI searches check fitment against the car the part belongs to
function settingsForCar(car) {
  return { ...loadSettings(), vehicle: (car && car.vehicle) || '' };
}

function vehicleMissingMessage(car) {
  return 'Set the vehicle for "' + car.name + '" in the Garage tab first - the AI uses it to check parts fit.';
}

function aiKeyConfigured(settings) {
  return Boolean(settings.aiProvider === 'anthropic' ? settings.anthropicApiKey : settings.geminiApiKey);
}

function saveData(data) {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, DATA_FILE);
  return true;
}

function loadSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8').replace(new RegExp('^\\uFEFF'), ''));
    return {
      ...DEFAULT_SETTINGS,
      ...saved,
      glowColors: { ...DEFAULT_SETTINGS.glowColors, ...(saved.glowColors || {}) }
    };
  } catch (err) {
    return { ...DEFAULT_SETTINGS, glowColors: { ...DEFAULT_SETTINGS.glowColors } };
  }
}

function saveSettings(settings) {
  const tmp = SETTINGS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8');
  fs.renameSync(tmp, SETTINGS_FILE);
  return true;
}

// Only allow deleting files that really live inside data/images
function resolveImagePath(relPath) {
  if (typeof relPath !== 'string') return null;
  const abs = path.resolve(DATA_DIR, relPath);
  if (!abs.startsWith(IMAGES_DIR + path.sep)) return null;
  return abs;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1240,
    height: 860,
    minWidth: 760,
    minHeight: 520,
    autoHideMenuBar: true,
    backgroundColor: '#12151c',
    title: 'Parts Tracker',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Keep the app window on the app; anything external goes to the default browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      if (url.startsWith('http://') || url.startsWith('https://')) shell.openExternal(url);
    }
  });
}

// Only one copy of the app at a time; a second launch focuses the existing window
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

// Synchronous so the preload can hand the path to the renderer immediately
ipcMain.on('get-data-dir', (event) => { event.returnValue = DATA_DIR; });

app.whenReady().then(() => {
  ensureDataDirs();

  ipcMain.handle('load-data', () => loadData());
  ipcMain.handle('save-data', (event, data) => saveData(data));
  ipcMain.handle('load-settings', () => loadSettings());
  ipcMain.handle('save-settings', (event, settings) => saveSettings(settings));

  // Permanently deletes every product and uploaded image (settings are kept)
  ipcMain.handle('reset-data', () => {
    const store = loadData();
    for (const car of store.cars) car.products = [];
    saveData(store);
    for (const f of fs.readdirSync(IMAGES_DIR)) {
      try { fs.unlinkSync(path.join(IMAGES_DIR, f)); } catch (err) { /* ignore */ }
    }
    return true;
  });

  ipcMain.handle('open-link', (event, url) => {
    if (typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'))) {
      shell.openExternal(url);
      return true;
    }
    return false;
  });

  ipcMain.handle('pick-image', async (event, productId) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win, {
      title: 'Choose a product image',
      properties: ['openFile'],
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }
      ]
    });
    if (result.canceled || result.filePaths.length === 0) return null;

    const src = result.filePaths[0];
    const ext = path.extname(src).toLowerCase() || '.png';
    const safeId = String(productId).replace(/[^a-zA-Z0-9-]/g, '');
    const fileName = `${safeId}_${Date.now()}${ext}`;
    fs.copyFileSync(src, path.join(IMAGES_DIR, fileName));
    return `images/${fileName}`;
  });

  ipcMain.handle('find-cheapest', async (event, productId, mode) => {
    const { findCheapest, usageCostText } = require('./pricefinder');
    const found = locateProduct(productId);
    if (!found) return { error: 'Product not found' };
    const { product, car } = found;
    const settings = settingsForCar(car);
    if (mode !== 'links' && aiKeyConfigured(settings) && !car.vehicle) {
      return { error: vehicleMissingMessage(car) };
    }
    const sender = event.sender;
    try {
      const res = await findCheapest({
        product,
        settings,
        mode,
        onProgress: (text) => {
          if (!sender.isDestroyed()) sender.send('price-progress', { productId, text });
        }
      });
      return { ...res, costText: usageCostText(res.ai && res.ai.usage) };
    } catch (err) {
      return { error: err.message || 'Price search failed' };
    }
  });

  // Save a retailer's product photo so a swapped-in part carries its own image
  ipcMain.handle('download-image', async (event, productId, url) => {
    if (typeof url !== 'string' || !/^https?:\/\//.test(url)) return null;
    try {
      const res = await net.fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) return null;
      const type = (res.headers.get('content-type') || '').toLowerCase();
      if (!type.startsWith('image/')) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length || buf.length > 8 * 1024 * 1024) return null;
      const ext = type.includes('png') ? '.png'
        : type.includes('webp') ? '.webp'
          : type.includes('gif') ? '.gif' : '.jpg';
      const safeId = String(productId).replace(/[^a-zA-Z0-9-]/g, '');
      const fileName = `${safeId}_${Date.now()}${ext}`;
      fs.writeFileSync(path.join(IMAGES_DIR, fileName), buf);
      return `images/${fileName}`;
    } catch (err) {
      return null;
    }
  });

  ipcMain.handle('find-alternatives', async (event, productId) => {
    const { findAlternatives, usageCostText } = require('./pricefinder');
    const found = locateProduct(productId);
    if (!found) return { ok: false, error: 'Product not found' };
    const { product, car } = found;
    if (!car.vehicle) return { ok: false, error: vehicleMissingMessage(car) };
    const sender = event.sender;
    try {
      const res = await findAlternatives({
        product,
        settings: settingsForCar(car),
        onProgress: (text) => {
          if (!sender.isDestroyed()) sender.send('price-progress', { productId, text, scope: 'alt' });
        }
      });
      return { ...res, costText: usageCostText(res.usage) };
    } catch (err) {
      return { ok: false, error: err.message || 'Alternatives search failed' };
    }
  });

  ipcMain.handle('price-alternatives', async (event, productId, manufacturers) => {
    const { priceAlternatives, usageCostText } = require('./pricefinder');
    const found = locateProduct(productId);
    if (!found) return { ok: false, error: 'Product not found' };
    const { product, car } = found;
    if (!car.vehicle) return { ok: false, error: vehicleMissingMessage(car) };
    const sender = event.sender;
    try {
      const res = await priceAlternatives({
        product,
        manufacturers: manufacturers || [],
        settings: settingsForCar(car),
        onProgress: (text) => {
          if (!sender.isDestroyed()) sender.send('price-progress', { productId, text, scope: 'alt' });
        }
      });
      return { ...res, costText: usageCostText(res.usage) };
    } catch (err) {
      return { ok: false, error: err.message || 'Pricing failed' };
    }
  });

  ipcMain.handle('pick-logo', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win, {
      title: 'Choose a logo',
      properties: ['openFile'],
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'] }
      ]
    });
    if (result.canceled || result.filePaths.length === 0) return null;

    const src = result.filePaths[0];
    const ext = path.extname(src).toLowerCase() || '.png';
    removeLogoFiles();
    const fileName = `logo_${Date.now()}${ext}`;
    fs.copyFileSync(src, path.join(DATA_DIR, fileName));
    return fileName;
  });

  ipcMain.handle('remove-logo', () => {
    removeLogoFiles();
    return true;
  });

  ipcMain.handle('delete-image', (event, relPath) => {
    const abs = resolveImagePath(relPath);
    if (abs && fs.existsSync(abs)) {
      try { fs.unlinkSync(abs); } catch (err) { /* file may be locked; ignore */ }
    }
    return true;
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
