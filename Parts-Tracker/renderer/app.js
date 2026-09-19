'use strict';

const DEFAULT_GLOWS = { ordered: '#ff9432', received: '#6fd3ff', fitted: '#3ddc84' };

let settings = {
  theme: 'dark',
  glowColors: { ...DEFAULT_GLOWS },
  currency: 'GBP',
  appName: 'Parts Tracker',
  logo: null
};

let money = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' });

function applySettings() {
  document.body.classList.toggle('light', settings.theme === 'light');

  const root = document.documentElement.style;
  root.setProperty('--glow-ordered', settings.glowColors.ordered);
  root.setProperty('--glow-received', settings.glowColors.received);
  root.setProperty('--glow-fitted', settings.glowColors.fitted);

  try {
    money = new Intl.NumberFormat('en-GB', { style: 'currency', currency: settings.currency });
  } catch (err) {
    money = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' });
  }

  const appName = (settings.appName || '').trim() || 'Parts Tracker';
  document.getElementById('app-title').textContent = appName;
  document.title = appName;
  document.getElementById('app-name-input').value = appName;

  const headerLogo = document.getElementById('app-logo');
  const logoPreview = document.getElementById('logo-preview');
  const removeBtn = document.getElementById('btn-remove-logo');
  if (settings.logo) {
    headerLogo.src = imgSrc(settings.logo);
    logoPreview.src = imgSrc(settings.logo);
    headerLogo.classList.remove('hidden');
    logoPreview.classList.remove('hidden');
    removeBtn.classList.remove('hidden');
  } else {
    headerLogo.classList.add('hidden');
    logoPreview.classList.add('hidden');
    removeBtn.classList.add('hidden');
    headerLogo.removeAttribute('src');
    logoPreview.removeAttribute('src');
  }

  const provider = settings.aiProvider === 'anthropic' ? 'anthropic' : 'gemini';
  document.getElementById('ai-provider-select').value = provider;
  document.getElementById('wrap-gemini-key').classList.toggle('hidden', provider !== 'gemini');
  document.getElementById('wrap-anthropic-key').classList.toggle('hidden', provider !== 'anthropic');
  document.getElementById('api-key-input').value = settings.anthropicApiKey || '';
  document.getElementById('gemini-key-input').value = settings.geminiApiKey || '';

  document.getElementById('theme-dark').classList.toggle('active', settings.theme !== 'light');
  document.getElementById('theme-light').classList.toggle('active', settings.theme === 'light');
  document.getElementById('color-ordered').value = settings.glowColors.ordered;
  document.getElementById('color-received').value = settings.glowColors.received;
  document.getElementById('color-fitted').value = settings.glowColors.fitted;
  document.getElementById('currency-select').value = settings.currency;
}

async function persistSettings() {
  await window.api.saveSettings(settings);
}

const STATUSES = ['Not purchased', 'Ordered', 'Received', 'Part Fitted'];
const STATUS_CLASS = {
  'Ordered': 'ordered',
  'Received': 'received',
  'Part Fitted': 'fitted'
};

// Every car and its parts. The UI always works on the active car, so `data`
// is a live view onto that car's product list rather than a copy.
let store = { cars: [], activeCarId: null };

function activeCar() {
  return store.cars.find((c) => c.id === store.activeCarId) || store.cars[0] || null;
}

const data = {
  get products() { const car = activeCar(); return car ? car.products : []; },
  set products(list) { const car = activeCar(); if (car) car.products = list; }
};
let currentId = null;          // product open in the details modal

// Form modal state
let formMode = 'add';          // 'add' | 'edit'
let formProductId = null;
let originalImage = null;      // image the product had before editing
let pendingImage = null;       // image picked in the form but not yet saved
let formReturnToDetail = false;

const $ = (id) => document.getElementById(id);

// Inline validation errors (no alert(): native popups break window focus on Windows)
function showFieldError(inputId, errorId) {
  $(inputId).classList.add('input-error');
  $(errorId).classList.remove('hidden');
  $(inputId).focus();
}

function clearFieldError(inputId, errorId) {
  $(inputId).classList.remove('input-error');
  $(errorId).classList.add('hidden');
}

$('f-name').addEventListener('input', () => clearFieldError('f-name', 'f-name-error'));
$('d-link-url').addEventListener('input', () => clearFieldError('d-link-url', 'd-link-error'));

function findProduct(id) {
  return data.products.find((p) => p.id === id) || null;
}

// The data folder sits outside the app once installed, so images need an
// absolute file URL rather than a path relative to the page.
function fileUrl(absPath) {
  const parts = String(absPath).replace(/\\/g, '/').split('/');
  return 'file:///' + parts.map((s, i) => (i === 0 ? s : encodeURIComponent(s))).join('/');
}

function imgSrc(rel) {
  return fileUrl(window.api.dataDir + '/' + rel);
}

async function persist() {
  await window.api.saveData(store);
}

/* ---------------- Tabs ---------------- */

$('tab-products').addEventListener('click', () => switchTab('products'));
$('tab-tracker').addEventListener('click', () => switchTab('tracker'));
$('tab-garage').addEventListener('click', () => switchTab('garage'));
$('tab-settings').addEventListener('click', () => switchTab('settings'));

function switchTab(which) {
  for (const t of ['products', 'tracker', 'garage', 'settings']) {
    $('tab-' + t).classList.toggle('active', which === t);
    $('view-' + t).classList.toggle('hidden', which !== t);
  }
  if (which === 'garage') renderGarage();
}

/* ---------------- Products grid ---------------- */

const STATUS_ORDER = { 'Not purchased': 0, 'Ordered': 1, 'Received': 2, 'Part Fitted': 3 };

function visibleProducts() {
  const filter = $('filter-status').value;
  const typeFilter = $('filter-type').value;
  const sort = $('sort-by').value;

  let list = data.products.filter((p) =>
    (!filter || p.status === filter) && (!typeFilter || p.partType === typeFilter));

  // Products without an order date always sort after dated ones
  const dateVal = (p) => (p.orderDate ? p.orderDate : null);
  if (sort === 'name') {
    list = [...list].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  } else if (sort === 'status') {
    list = [...list].sort((a, b) => (STATUS_ORDER[a.status] || 0) - (STATUS_ORDER[b.status] || 0));
  } else if (sort === 'orderDateDesc') {
    list = [...list].sort((a, b) => {
      if (!dateVal(a) && !dateVal(b)) return 0;
      if (!dateVal(a)) return 1;
      if (!dateVal(b)) return -1;
      return dateVal(b).localeCompare(dateVal(a));
    });
  } else if (sort === 'orderDateAsc') {
    list = [...list].sort((a, b) => {
      if (!dateVal(a) && !dateVal(b)) return 0;
      if (!dateVal(a)) return 1;
      if (!dateVal(b)) return -1;
      return dateVal(a).localeCompare(dateVal(b));
    });
  }
  return list;
}

/* Drag-to-reorder (active only in Manual order with no filter) */

let draggingEl = null;

function manualOrderActive() {
  return $('sort-by').value === 'added' && !$('filter-status').value && !$('filter-type').value;
}

function getDragTarget(x, y) {
  const els = [...$('product-grid').querySelectorAll('.card:not(.dragging)')];
  let closest = { dist: Infinity, el: null, before: false };
  for (const el of els) {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const dist = Math.hypot(x - cx, y - cy);
    if (dist < closest.dist) {
      closest = { dist, el, before: y < r.top || (y <= r.bottom && x < cx) };
    }
  }
  return closest;
}

$('product-grid').addEventListener('dragover', (e) => {
  if (!draggingEl) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  const target = getDragTarget(e.clientX, e.clientY);
  if (!target.el || target.el === draggingEl) return;
  const grid = $('product-grid');
  if (target.before) grid.insertBefore(draggingEl, target.el);
  else grid.insertBefore(draggingEl, target.el.nextSibling);
});

$('product-grid').addEventListener('drop', (e) => {
  if (draggingEl) e.preventDefault();
});

function renderGrid() {
  const grid = $('product-grid');
  grid.replaceChildren();

  const list = visibleProducts();
  const draggable = manualOrderActive();
  $('drag-hint').classList.toggle('hidden', !(draggable && list.length > 1));

  $('empty-state').classList.toggle('hidden', data.products.length > 0);
  $('filter-empty').classList.toggle('hidden', !(data.products.length > 0 && list.length === 0));
  $('filter-count').textContent = data.products.length === 0
    ? ''
    : (list.length === data.products.length
        ? data.products.length + ' item' + (data.products.length === 1 ? '' : 's')
        : list.length + ' of ' + data.products.length + ' items');

  for (const p of list) {
    const card = document.createElement('div');
    card.className = 'card';

    const wrap = document.createElement('div');
    wrap.className = 'card-image-wrap';
    const glow = STATUS_CLASS[p.status];
    if (glow) wrap.classList.add('glow-' + glow);

    if (p.image) {
      const img = document.createElement('img');
      img.src = imgSrc(p.image);
      img.alt = p.name;
      img.draggable = false;
      wrap.appendChild(img);
    } else {
      const ph = document.createElement('span');
      ph.className = 'no-img';
      ph.textContent = 'No image';
      wrap.appendChild(ph);
    }

    const name = document.createElement('div');
    name.className = 'card-name';
    name.textContent = p.name;

    const status = document.createElement('div');
    status.className = 'card-status' + (glow ? ' s-' + glow : '');
    status.textContent = p.status;
    if (p.partType) {
      const type = document.createElement('span');
      type.className = 'card-type';
      type.textContent = ' · ' + p.partType;
      status.appendChild(type);
    }

    card.append(wrap, name, status);
    card.addEventListener('click', () => openDetail(p.id));

    card.dataset.id = p.id;
    if (draggable) {
      card.draggable = true;
      card.addEventListener('dragstart', (e) => {
        draggingEl = card;
        card.classList.add('dragging');
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          try { e.dataTransfer.setData('text/plain', p.id); } catch (err) { /* ignore */ }
        }
      });
      card.addEventListener('dragend', async () => {
        card.classList.remove('dragging');
        draggingEl = null;
        const ids = [...grid.querySelectorAll('.card')].map((el) => el.dataset.id);
        data.products.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
        await persist();
        renderTracker();
      });
    }
    grid.appendChild(card);
  }
}

/* ---------------- Price tracker ---------------- */

function renderTracker() {
  const body = $('tracker-body');
  body.replaceChildren();

  let runningTotal = 0;
  let finalTotal = 0;

  for (const p of data.products) {
    const price = Number(p.price) || 0;
    finalTotal += price;
    if (p.status === 'Ordered' || p.status === 'Received' || p.status === 'Part Fitted') {
      runningTotal += price;
    }

    const tr = document.createElement('tr');

    const tdName = document.createElement('td');
    tdName.textContent = p.name;

    const tdType = document.createElement('td');
    tdType.textContent = p.partType || '—';
    if (!p.partType) tdType.className = 'muted';

    const tdStatus = document.createElement('td');
    const chip = document.createElement('span');
    const glow = STATUS_CLASS[p.status];
    chip.className = 'status-chip' + (glow ? ' s-' + glow : '');
    chip.textContent = p.status;
    tdStatus.appendChild(chip);

    const tdPrice = document.createElement('td');
    tdPrice.className = 'col-price';
    tdPrice.textContent = money.format(price);

    tr.append(tdName, tdType, tdStatus, tdPrice);
    body.appendChild(tr);
  }

  $('running-total').textContent = money.format(runningTotal);
  $('final-total').textContent = money.format(finalTotal);
  document.querySelector('.tracker-table').classList.toggle('hidden', data.products.length === 0);
  $('tracker-empty').classList.toggle('hidden', data.products.length > 0);
}

/* ---------------- Add / Edit form modal ---------------- */

$('btn-add').addEventListener('click', () => openForm(null));

function openForm(product) {
  formMode = product ? 'edit' : 'add';
  formProductId = product ? product.id : crypto.randomUUID();
  originalImage = product ? product.image : null;
  pendingImage = null;

  $('form-title').textContent = product ? 'Edit Product' : 'Add Product';
  $('f-name').value = product ? product.name : '';
  $('f-desc').value = product ? product.description : '';
  $('f-price').value = product ? String(product.price) : '';
  $('f-type').value = (product && product.partType) || '';
  setFormPreview(product ? product.image : null);
  clearFieldError('f-name', 'f-name-error');

  $('form-overlay').classList.remove('hidden');
  $('f-name').focus();
}

function setFormPreview(rel) {
  const preview = $('f-preview');
  const noimg = $('f-noimage');
  if (rel) {
    preview.src = imgSrc(rel);
    preview.classList.remove('hidden');
    noimg.classList.add('hidden');
  } else {
    preview.classList.add('hidden');
    noimg.classList.remove('hidden');
  }
}

$('btn-pick-image').addEventListener('click', async () => {
  const rel = await window.api.pickImage(formProductId);
  if (!rel) return;
  // A newly picked image replaces any not-yet-saved pick
  if (pendingImage && pendingImage !== originalImage) {
    await window.api.deleteImage(pendingImage);
  }
  pendingImage = rel;
  setFormPreview(rel);
});

$('btn-save-product').addEventListener('click', async () => {
  const name = $('f-name').value.trim();
  if (!name) {
    showFieldError('f-name', 'f-name-error');
    return;
  }
  const description = $('f-desc').value.trim();
  const price = Math.max(0, parseFloat($('f-price').value) || 0);
  const partType = $('f-type').value || null;

  if (formMode === 'add') {
    data.products.push({
      id: formProductId,
      name,
      description,
      price,
      partType,
      image: pendingImage,
      links: [],
      status: 'Not purchased',
      orderDate: null,
      receivedDate: null
    });
  } else {
    const p = findProduct(formProductId);
    if (p) {
      p.name = name;
      p.description = description;
      p.price = price;
      p.partType = partType;
      if (pendingImage && pendingImage !== p.image) {
        if (p.image) await window.api.deleteImage(p.image);
        p.image = pendingImage;
      }
    }
  }

  pendingImage = null;
  await persist();
  closeForm(false);
  renderGrid();
  renderTracker();
});

async function closeForm(discard = true) {
  if (discard && pendingImage && pendingImage !== originalImage) {
    await window.api.deleteImage(pendingImage);
  }
  pendingImage = null;
  $('form-overlay').classList.add('hidden');
  if (formReturnToDetail) {
    formReturnToDetail = false;
    if (findProduct(currentId)) openDetail(currentId);
  }
}

/* ---------------- Details modal ---------------- */

function openDetail(id) {
  const p = findProduct(id);
  if (!p) return;
  currentId = id;

  $('d-name').textContent = p.name;
  $('d-desc').textContent = p.description || '';
  $('wrap-desc').classList.toggle('hidden', !p.description);
  $('d-price').textContent = money.format(Number(p.price) || 0);
  $('d-type').textContent = p.partType || '';
  $('d-type').classList.toggle('hidden', !p.partType);

  const img = $('d-image');
  const noimg = $('d-noimage');
  if (p.image) {
    img.src = imgSrc(p.image);
    img.classList.remove('hidden');
    noimg.classList.add('hidden');
  } else {
    img.classList.add('hidden');
    noimg.classList.remove('hidden');
  }

  $('d-status').value = p.status;
  $('d-order-date').value = p.orderDate || '';
  $('d-received-date').value = p.receivedDate || '';
  updateDateVisibility(p.status);

  renderLinks(p);
  $('d-link-label').value = '';
  $('d-link-url').value = '';
  clearFieldError('d-link-url', 'd-link-error');
  clearPriceSearchUi();
  clearAltUi();
  renderAlternatives(p);
  updateAltVisibility(p);

  $('detail-overlay').classList.remove('hidden');
}

function updateDateVisibility(status) {
  const showOrder = status === 'Ordered' || status === 'Received' || status === 'Part Fitted';
  const showReceived = status === 'Received' || status === 'Part Fitted';
  $('wrap-order-date').classList.toggle('hidden', !showOrder);
  $('wrap-received-date').classList.toggle('hidden', !showReceived);
}

$('d-status').addEventListener('change', async () => {
  const p = findProduct(currentId);
  if (!p) return;
  p.status = $('d-status').value;
  updateDateVisibility(p.status);
  updateAltVisibility(p);
  await persist();
  renderGrid();
  renderTracker();
});

$('d-order-date').addEventListener('change', async () => {
  const p = findProduct(currentId);
  if (!p) return;
  p.orderDate = $('d-order-date').value || null;
  await persist();
});

$('d-received-date').addEventListener('change', async () => {
  const p = findProduct(currentId);
  if (!p) return;
  p.receivedDate = $('d-received-date').value || null;
  await persist();
});

// Open the native calendar as soon as the date field is clicked
for (const dateId of ['d-order-date', 'd-received-date']) {
  $(dateId).addEventListener('click', (e) => {
    try { e.target.showPicker(); } catch (err) { /* already open */ }
  });
}

/* ---------------- Links ---------------- */

function renderLinks(p) {
  const list = $('d-links');
  list.replaceChildren();

  for (let i = 0; i < p.links.length; i++) {
    const link = p.links[i];
    const li = document.createElement('li');

    const open = document.createElement('button');
    open.className = 'link-open';
    open.textContent = link.label ? link.label : link.url;
    open.title = link.url;
    open.addEventListener('click', () => window.api.openLink(link.url));

    const remove = document.createElement('button');
    remove.className = 'link-remove';
    remove.textContent = '×';
    remove.title = 'Remove link';
    remove.addEventListener('click', async () => {
      p.links.splice(i, 1);
      await persist();
      renderLinks(p);
    });

    li.append(open, remove);
    list.appendChild(li);
  }
}

$('btn-add-link').addEventListener('click', addLink);
$('d-link-url').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addLink();
});

async function addLink() {
  const p = findProduct(currentId);
  if (!p) return;

  let url = $('d-link-url').value.trim();
  const label = $('d-link-label').value.trim();
  if (!url) {
    showFieldError('d-link-url', 'd-link-error');
    return;
  }
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  p.links.push({ label, url });
  await persist();
  renderLinks(p);
  $('d-link-label').value = '';
  $('d-link-url').value = '';
  $('d-link-url').focus();
}

/* ---------------- Edit / Delete from details ---------------- */

$('btn-edit-product').addEventListener('click', () => {
  const p = findProduct(currentId);
  if (!p) return;
  formReturnToDetail = true;
  $('detail-overlay').classList.add('hidden');
  openForm(p);
});

$('btn-delete-product').addEventListener('click', async () => {
  const p = findProduct(currentId);
  if (!p) return;
  const ok = await appConfirm({
    title: 'Delete this product?',
    message: '"' + p.name + '" will be permanently deleted, along with its photo, links and alternatives.\n\nThere is no undo.',
    confirmLabel: 'Delete product',
    danger: true
  });
  if (!ok) return;

  if (p.image) await window.api.deleteImage(p.image);
  data.products = data.products.filter((x) => x.id !== currentId);
  currentId = null;
  await persist();
  $('detail-overlay').classList.add('hidden');
  renderGrid();
  renderTracker();
});

/* ---------------- Products toolbar ---------------- */

$('filter-status').addEventListener('change', renderGrid);
$('filter-type').addEventListener('change', renderGrid);
$('sort-by').addEventListener('change', renderGrid);

/* ---------------- Settings ---------------- */

async function setTheme(theme) {
  settings.theme = theme;
  applySettings();
  await persistSettings();
}

$('theme-dark').addEventListener('click', () => setTheme('dark'));
$('theme-light').addEventListener('click', () => setTheme('light'));

for (const [inputId, key] of [
  ['color-ordered', 'ordered'],
  ['color-received', 'received'],
  ['color-fitted', 'fitted']
]) {
  // Live preview while dragging the picker, save when it settles
  $(inputId).addEventListener('input', () => {
    settings.glowColors[key] = $(inputId).value;
    applySettings();
  });
  $(inputId).addEventListener('change', persistSettings);
}

// Live preview of the app name while typing; saved when the field settles
$('app-name-input').addEventListener('input', () => {
  const v = $('app-name-input').value.trim() || 'Parts Tracker';
  $('app-title').textContent = v;
  document.title = v;
});
$('app-name-input').addEventListener('change', async () => {
  settings.appName = $('app-name-input').value.trim() || 'Parts Tracker';
  applySettings();
  await persistSettings();
});

$('btn-pick-logo').addEventListener('click', async () => {
  const rel = await window.api.pickLogo();
  if (!rel) return;
  settings.logo = rel;
  applySettings();
  await persistSettings();
});

$('btn-remove-logo').addEventListener('click', async () => {
  await window.api.removeLogo();
  settings.logo = null;
  applySettings();
  await persistSettings();
});

$('btn-default-colors').addEventListener('click', async () => {
  settings.glowColors = { ...DEFAULT_GLOWS };
  applySettings();
  await persistSettings();
});

$('currency-select').addEventListener('change', async () => {
  settings.currency = $('currency-select').value;
  applySettings();
  await persistSettings();
  renderTracker();
  renderGarage();
});

$('ai-provider-select').addEventListener('change', async () => {
  settings.aiProvider = $('ai-provider-select').value;
  applySettings();
  await persistSettings();
});

$('api-key-input').addEventListener('change', async () => {
  settings.anthropicApiKey = $('api-key-input').value.trim();
  await persistSettings();
});

$('gemini-key-input').addEventListener('change', async () => {
  settings.geminiApiKey = $('gemini-key-input').value.trim();
  await persistSettings();
});


/* ---------------- Find cheapest price ---------------- */

let priceSearchRunning = false;

window.api.onPriceProgress(({ productId, text, scope }) => {
  if (productId !== currentId) return;
  $(scope === 'alt' ? 'alt-status' : 'price-status').textContent = text;
});

function clearPriceSearchUi() {
  $('price-status').classList.add('hidden');
  $('price-status').classList.remove('done');
  $('price-banner').classList.add('hidden');
  $('price-results').replaceChildren();
  $('btn-find-price').disabled = priceSearchRunning;
  $('btn-quick-price').disabled = priceSearchRunning;
}

function showPriceBanner(text, undoState) {
  const banner = $('price-banner');
  banner.replaceChildren();
  const span = document.createElement('span');
  span.textContent = text;
  banner.appendChild(span);
  if (undoState) {
    const undo = document.createElement('button');
    undo.className = 'btn';
    undo.textContent = 'Undo';
    undo.addEventListener('click', async () => {
      const p = findProduct(undoState.productId);
      if (p) {
        p.price = undoState.oldPrice;
        await persist();
        renderTracker();
        if (currentId === undoState.productId) {
          $('d-price').textContent = money.format(undoState.oldPrice);
        }
        showPriceBanner('Price restored to ' + money.format(undoState.oldPrice) + '.', null);
      }
    });
    banner.appendChild(undo);
  }
  banner.classList.remove('hidden');
}

function renderPriceResults(result) {
  const list = $('price-results');
  list.replaceChildren();

  for (const opt of result.options) {
    const li = document.createElement('li');
    if (result.cheapest && opt === result.cheapest) li.classList.add('cheapest');

    const retailer = document.createElement('button');
    retailer.className = 'pr-retailer';
    retailer.textContent = opt.retailer;
    retailer.title = opt.url;
    retailer.addEventListener('click', () => window.api.openLink(opt.url));

    const note = document.createElement('span');
    note.className = 'pr-note';
    note.textContent = (opt.source === 'ai' ? 'AI found' : 'your link') + (opt.note ? ' · ' + opt.note : '');

    const price = document.createElement('span');
    price.className = 'pr-price';
    price.textContent = money.format(opt.price);

    li.append(retailer, note, price);
    if (result.cheapest && opt === result.cheapest) {
      const tag = document.createElement('span');
      tag.className = 'pr-tag';
      tag.textContent = 'Cheapest';
      li.appendChild(tag);
    }
    list.appendChild(li);
  }

  // AI results that failed page verification - shown, never trusted
  for (const r of result.rejected || []) {
    const li = document.createElement('li');
    const note = document.createElement('span');
    note.className = 'pr-note';
    note.textContent = r.retailer + ' — ' + r.reason;
    note.title = r.url;
    li.appendChild(note);
    list.appendChild(li);
  }

  // Failed links and AI problems, so nothing fails silently
  for (const r of result.linkResults) {
    if (!r.ok) {
      const li = document.createElement('li');
      const note = document.createElement('span');
      note.className = 'pr-note';
      let host = r.url;
      try { host = new URL(r.url).hostname.replace(/^www\./, ''); } catch (err) { /* keep url */ }
      note.textContent = host + ' — ' + r.error;
      li.appendChild(note);
      list.appendChild(li);
    }
  }
  if (result.ai && !result.ai.ok) {
    const li = document.createElement('li');
    const note = document.createElement('span');
    note.className = 'pr-note';
    note.textContent = 'AI search: ' + result.ai.error;
    li.appendChild(note);
    list.appendChild(li);
  }
}

// Same page on a retailer, ignoring tracking params and trailing slashes
function pageKey(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/$/, '');
  } catch (err) {
    return url;
  }
}

// Save the three cheapest verified retailers as links, so future quick checks
// can price them for free without another AI scan.
function saveTopLinks(product, result) {
  const existing = new Set(product.links.map((l) => pageKey(l.url)));
  const added = [];
  for (const opt of result.options.slice(0, 3)) {
    const key = pageKey(opt.url);
    if (existing.has(key)) continue;
    product.links.push({ label: 'Found: ' + opt.retailer, url: opt.url });
    existing.add(key);
    added.push(opt.retailer);
  }
  return added;
}

async function runPriceSearch(mode) {
  if (priceSearchRunning) return;
  const p = findProduct(currentId);
  if (!p) return;

  const quick = mode === 'links';
  priceSearchRunning = true;
  const searchedId = currentId;
  clearPriceSearchUi();
  $('btn-find-price').disabled = true;
  $('btn-quick-price').disabled = true;
  const status = $('price-status');
  status.textContent = quick ? 'Checking your saved links…' : 'Starting search…';
  status.classList.remove('hidden');

  const result = await window.api.findCheapest(searchedId, mode);

  priceSearchRunning = false;
  $('btn-find-price').disabled = false;
  $('btn-quick-price').disabled = false;
  status.classList.add('done');

  if (result.error) {
    status.textContent = 'Search failed: ' + result.error;
    return;
  }

  const product = findProduct(searchedId);
  if (!product) { status.classList.add('hidden'); return; }

  // Full scans bank the cheapest retailers for future free checks
  let addedLinks = [];
  if (!result.linksOnly && result.options.length) {
    addedLinks = saveTopLinks(product, result);
  }

  if (result.linksOnly) {
    status.textContent = product.links.length
      ? 'Checked your ' + product.links.length + ' saved link' + (product.links.length === 1 ? '' : 's') + '. Run the full search to look for new UK retailers.'
      : 'No saved links yet — run the full search to find UK retailers.';
  } else if (!result.aiUsed) {
    status.textContent = result.options.length
      ? 'Checked your saved links. Add an API key in Settings (Gemini keys are free) to also scan UK retailers.'
      : 'No prices found from your links. Add an API key in Settings (Gemini keys are free) to scan UK retailers, or add product links.';
  } else if (result.ai && result.ai.ok && result.ai.summary) {
    status.textContent = result.ai.summary;
  } else {
    status.textContent = 'Search finished.';
  }

  if (addedLinks.length) {
    status.textContent += ' Saved ' + addedLinks.length + ' link' + (addedLinks.length === 1 ? '' : 's') +
      ' (' + addedLinks.join(', ') + ') for free quick checks.';
  }
  if (result.costText) status.textContent += ' · ' + result.costText;

  if (searchedId === currentId) renderPriceResults(result);

  const cheapest = result.cheapest;
  const priceChanged = cheapest && cheapest.price !== product.price;
  const oldPrice = product.price;
  if (priceChanged) product.price = cheapest.price;

  if (priceChanged || addedLinks.length) {
    await persist();
    renderTracker();
    renderGrid();
    if (searchedId === currentId) {
      $('d-price').textContent = money.format(product.price);
      renderLinks(product);
    }
  }

  if (searchedId === currentId && cheapest) {
    if (priceChanged) {
      showPriceBanner(
        'Price updated ' + money.format(oldPrice) + ' → ' + money.format(product.price) + ' (' + cheapest.retailer + ')',
        { productId: searchedId, oldPrice }
      );
    } else {
      showPriceBanner('Cheapest found matches your current price: ' + money.format(cheapest.price) + ' (' + cheapest.retailer + ')', null);
    }
  }
}

$('btn-find-price').addEventListener('click', () => runPriceSearch('full'));
$('btn-quick-price').addEventListener('click', () => runPriceSearch('links'));

/* ---------------- Alternatives from other manufacturers ---------------- */

let altSearchRunning = false;

function setAltButtons(disabled) {
  $('btn-find-alts').disabled = disabled;
  $('btn-price-alts').disabled = disabled;
}

function clearAltUi() {
  $('alt-status').classList.add('hidden');
  $('alt-status').classList.remove('done');
  $('alt-pick-wrap').classList.add('hidden');
  $('alt-results-wrap').classList.add('hidden');
  $('alt-picklist').replaceChildren();
  $('alt-results').replaceChildren();
  setAltButtons(altSearchRunning);
}

// Draws both the tick list and the grouped results from product.alternatives
// Pull comparable measurements and attributes out of free text, so an
// alternative can be checked against the part it would replace.
function extractSpecs(text) {
  const t = String(text || '').toLowerCase();
  const nums = (re) => [...new Set([...t.matchAll(re)].map((m) => parseFloat(m[1])))];
  // "280-319mm" is an adjustment range, not a different size
  const ranges = [...t.matchAll(/(\d+(?:\.\d+)?)\s*(?:[-–—]|\/|\bto\b)\s*(\d+(?:\.\d+)?)\s*mm\b/g)]
    .map((m) => [parseFloat(m[1]), parseFloat(m[2])].sort((x, y) => x - y));
  const mm = nums(/(\d+(?:\.\d+)?)\s*mm\b/g);
  for (const r of ranges) { if (!mm.includes(r[0])) mm.push(r[0]); }
  return {
    mm,
    mmRanges: ranges,
    inch: nums(/(\d+(?:\.\d+)?)\s*(?:"|inch(?:es)?|in\b)/g),
    rate: nums(/(\d+(?:\.\d+)?)\s*(?:lbs?|kg)\s*\/\s*(?:in|mm)/g),
    adjustable: /\badjustable\b/.test(t) && !/\bnon[- ]adjustable\b/.test(t),
    fixed: /\bnon[- ]adjustable\b|\bfixed\b/.test(t),
    front: /\bfront\b/.test(t),
    rear: /\brear\b/.test(t),
    points: (t.match(/(\d)\s*[- ]?point/) || [])[1] || null
  };
}

// Plain-English differences between the user's part and an alternative. Only
// reports where BOTH sides state a value, so a part that simply doesn't list a
// size stays silent rather than crying wolf.
function specDifferences(originalText, altText) {
  const a = extractSpecs(originalText);
  const b = extractSpecs(altText);
  const out = [];
  const fmt = (arr, unit) => arr.slice(0, 3).map((n) => n + unit).join(' / ');
  const inAnyRange = (v, ranges) => ranges.some((r) => v >= r[0] && v <= r[1]);

  // A value covered by the other side's adjustment range is not a difference
  const mmShared = b.mm.some((n) => a.mm.includes(n) || inAnyRange(n, a.mmRanges))
    || a.mm.some((n) => inAnyRange(n, b.mmRanges));
  if (a.mm.length && b.mm.length && !mmShared) {
    out.push(fmt(b.mm, 'mm') + ' — yours is ' + fmt(a.mm, 'mm'));
  }

  for (const pair of [['inch', '"'], ['rate', 'lb/in']]) {
    const key = pair[0];
    const unit = pair[1];
    if (a[key].length && b[key].length && !b[key].some((n) => a[key].includes(n))) {
      out.push(fmt(b[key], unit) + ' — yours is ' + fmt(a[key], unit));
    }
  }
  if (a.adjustable && b.fixed) out.push('not adjustable — yours is adjustable');
  if (a.front && !a.rear && b.rear && !b.front) out.push('rear fitment — yours is front');
  if (a.rear && !a.front && b.front && !b.rear) out.push('front fitment — yours is rear');
  if (a.points && b.points && a.points !== b.points) {
    out.push(b.points + '-point — yours is ' + a.points + '-point');
  }
  return out;
}

// What the app detected, plus anything the AI itself flagged, deduped
function altDifferences(product, alt) {
  const detected = specDifferences(
    product.name + '\n' + (product.description || ''),
    [alt.partName, alt.specs, alt.note, alt.restore && alt.restore.description]
      .filter(Boolean).join(' ')
  );
  const declared = Array.isArray(alt.differences) ? alt.differences.map(String) : [];
  const seen = new Set();
  return [...detected, ...declared].filter((d) => {
    const k = d.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Show what the part actually is, and how it differs from the one it would
// replace. Silence would be ambiguous, so a clean comparison says so.
function appendSpecLines(parent, alt, diffs) {
  const specText = alt.specs || (alt.wasMain ? '' : alt.note) || '';
  if (specText) {
    const el = document.createElement('span');
    el.className = 'alt-specs';
    el.textContent = specText;
    parent.appendChild(el);
  }
  if (diffs.length) {
    const el = document.createElement('span');
    el.className = 'alt-diff';
    el.textContent = '\u26a0 ' + diffs.join(' · ');
    parent.appendChild(el);
  } else if (specText) {
    const el = document.createElement('span');
    el.className = 'alt-match';
    el.textContent = 'matches your spec';
    parent.appendChild(el);
  }
}

function renderAlternatives(p) {
  const alts = (p.alternatives && p.alternatives.manufacturers) || [];
  const picklist = $('alt-picklist');
  const results = $('alt-results');
  picklist.replaceChildren();
  results.replaceChildren();

  $('alt-pick-wrap').classList.toggle('hidden', alts.length === 0);
  const anyPriced = alts.some((a) => a.pricedAt);
  $('alt-results-wrap').classList.toggle('hidden', !anyPriced);
  if (!alts.length) return;

  for (const alt of alts) {
    const diffs = altDifferences(p, alt);

    // --- tick row ---
    const li = document.createElement('li');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!alt.selected;
    cb.id = 'altcb-' + alt.id;
    cb.addEventListener('change', async () => {
      alt.selected = cb.checked;
      await persist();
    });

    const label = document.createElement('label');
    label.htmlFor = cb.id;
    label.className = 'alt-pick-label';
    const nm = document.createElement('span');
    nm.className = 'alt-pick-name';
    nm.textContent = alt.manufacturer;
    const pn = document.createElement('span');
    pn.className = 'alt-pick-part';
    pn.textContent = [alt.partName, alt.partNo].filter(Boolean).join(' · ');
    label.append(nm, pn);

    const pr = document.createElement('span');
    pr.className = 'alt-pick-price';
    pr.textContent = alt.indicativePrice != null
      ? '~' + money.format(alt.indicativePrice) + ' (unverified)'
      : 'price unknown';

    li.append(cb, label, pr);
    appendSpecLines(label, alt, diffs);
    picklist.appendChild(li);

    // --- results group ---
    if (!alt.pricedAt) continue;
    const group = document.createElement('div');
    group.className = 'alt-group';

    const head = document.createElement('div');
    head.className = 'alt-group-head';
    const gname = document.createElement('span');
    gname.className = 'alt-group-name';
    gname.textContent = alt.manufacturer;
    const gpart = document.createElement('span');
    gpart.className = 'alt-group-part';
    gpart.textContent = [alt.partName, alt.partNo].filter(Boolean).join(' · ');
    const use = document.createElement('button');
    use.className = 'btn alt-use';
    use.textContent = 'Use this part';
    use.title = 'Make this the main product';
    use.disabled = swapPrice(alt) == null;
    use.addEventListener('click', () => confirmSwap(p, alt));

    const remove = document.createElement('button');
    remove.className = 'alt-group-remove';
    remove.textContent = '×';
    remove.title = 'Remove this manufacturer';
    remove.addEventListener('click', async () => {
      p.alternatives.manufacturers = p.alternatives.manufacturers.filter((x) => x.id !== alt.id);
      if (alt.image) await window.api.deleteImage(alt.image);
      await persist();
      renderAlternatives(p);
    });
    head.append(gname, gpart, use, remove);
    group.appendChild(head);
    appendSpecLines(group, alt, diffs);

    if (alt.options && alt.options.length) {
      const ul = document.createElement('ul');
      ul.className = 'price-results';
      alt.options.forEach((opt, idx) => {
        const row = document.createElement('li');
        if (idx === 0 && opt.price != null) row.classList.add('cheapest');

        const retailer = document.createElement('button');
        retailer.className = 'pr-retailer';
        retailer.textContent = opt.retailer;
        retailer.title = opt.url;
        retailer.addEventListener('click', () => window.api.openLink(opt.url));

        const note = document.createElement('span');
        note.className = 'pr-note';
        note.textContent = opt.note || '';

        const price = document.createElement('span');
        price.className = 'pr-price';
        price.textContent = opt.price != null ? money.format(opt.price) : '—';

        row.append(retailer, note, price);
        if (idx === 0 && opt.price != null) {
          const tag = document.createElement('span');
          tag.className = 'pr-tag';
          tag.textContent = 'Cheapest';
          row.appendChild(tag);
        }
        ul.appendChild(row);
      });
      group.appendChild(ul);
    } else {
      const none = document.createElement('div');
      none.className = 'alt-empty';
      none.textContent = alt.error || 'No verified UK retailer found.';
      group.appendChild(none);
    }
    results.appendChild(group);
  }
}

// Promote an alternative to be the main product, demoting the current part
// (with its links and photo) into the alternatives list so nothing is lost.
// What this alternative would cost as the main product. A demoted part keeps
// its old price in indicativePrice, because its saved links have no prices.
function swapPrice(alt) {
  if (alt.restore && alt.restore.price != null) return alt.restore.price;
  const cheapest = (alt.options || [])[0];
  if (cheapest && cheapest.price != null) return cheapest.price;
  return alt.indicativePrice != null ? alt.indicativePrice : null;
}

function swapName(alt) {
  if (alt.restore && alt.restore.name) return alt.restore.name;
  return [alt.manufacturer, alt.partName].filter(Boolean).join(' ');
}

async function confirmSwap(product, alt) {
  const price = swapPrice(alt);
  if (price == null) return;
  const newName = swapName(alt);
  const ok = await appConfirm({
    title: 'Use this part instead?',
    message: '"' + newName + '" becomes this product at ' + money.format(price) +
      ', with the retailer links found for it.\n\n' +
      '"' + product.name + '" (' + money.format(product.price) + ') moves into Alternative options, ' +
      'keeping its links and photo, so you can switch back at any time.\n\n' +
      'Status and dates stay as they are - change them if this part has not been ordered yet.',
    confirmLabel: 'Use this part instead',
    warnings: altDifferences(product, alt)
  });
  if (ok) await swapToAlternative(product, alt);
}

async function swapToAlternative(product, alt) {
  const newPrice = swapPrice(alt);
  if (newPrice == null) return;

  const newName = swapName(alt);
  const status = $('alt-status');
  status.classList.remove('hidden');
  status.classList.remove('done');
  status.textContent = 'Swapping in ' + newName + '…';

  // 1. Demote the current product into the alternatives list
  const demoted = {
    id: 'previous-' + Date.now(),
    manufacturer: product.name,
    partName: '',
    partNo: '',
    indicativePrice: product.price,
    note: 'your previous choice',
    selected: false,
    pricedAt: new Date().toISOString(),
    image: product.image || null,
    wasMain: true,
    // Everything needed to put this part back exactly as it is now
    restore: {
      name: product.name,
      description: product.description || '',
      price: product.price,
      image: product.image || null,
      partType: product.partType || null,
      links: (product.links || []).map((l) => ({ label: l.label, url: l.url }))
    },
    options: (product.links || []).map((l) => ({
      retailer: (() => { try { return new URL(l.url).hostname.replace(/^www\./, ''); } catch (e) { return l.url; } })(),
      url: l.url,
      price: null,
      note: l.label || 'saved link'
    }))
  };

  // 2. Promote the alternative
  const oldImage = product.image;
  let newImage = alt.image || null;
  if (!newImage) {
    const src = (alt.options || []).map((o) => o.imageUrl).find(Boolean);
    if (src) {
      status.textContent = 'Fetching product photo…';
      newImage = await window.api.downloadImage(product.id, src);
    }
  }

  if (alt.restore) {
    // Putting back a part that used to be the main product
    product.name = alt.restore.name;
    product.description = alt.restore.description || '';
    product.price = alt.restore.price;
    product.links = (alt.restore.links || []).map((l) => ({ label: l.label || '', url: l.url }));
    if (alt.restore.partType) product.partType = alt.restore.partType;
    product.image = alt.restore.image || newImage || null;
  } else if (alt.wasMain) {
    // Demoted before restore data was recorded - rebuild from what we kept
    product.name = newName;
    product.price = newPrice;
    product.description = '';
    product.links = (alt.options || []).map((o) => ({
      label: (o.note && !/^(saved link|verified on page|found in search results)/i.test(o.note)) ? o.note : '',
      url: o.url
    }));
    product.image = newImage || null;
  } else {
    product.name = newName;
    product.price = newPrice;
    product.description = [alt.partNo ? 'Part number: ' + alt.partNo : '', alt.note || ''].filter(Boolean).join('\n');
    product.links = (alt.options || []).map((o) => ({ label: 'Found: ' + o.retailer, url: o.url }));
    product.image = newImage || null;
  }

  // Only delete the old image once it is safely referenced by the demoted entry
  if (oldImage && demoted.image !== oldImage) await window.api.deleteImage(oldImage);

  // 3. Rebuild the alternatives list: promoted one out, previous one in
  const rest = (product.alternatives.manufacturers || []).filter((m) => m.id !== alt.id);
  product.alternatives.manufacturers = [demoted, ...rest];

  await persist();
  renderGrid();
  renderTracker();

  // Refresh the whole detail view so name, price, photo and links all update
  openDetail(product.id);
  const s = $('alt-status');
  s.classList.remove('hidden');
  s.classList.add('done');
  s.textContent = 'Swapped to ' + newName + '. Your previous part is saved below.' +
    (newImage ? '' : ' No photo was available — add one with Edit details.');
}

$('btn-find-alts').addEventListener('click', async () => {
  if (altSearchRunning) return;
  const p = findProduct(currentId);
  if (!p) return;

  altSearchRunning = true;
  const searchedId = currentId;
  setAltButtons(true);
  const status = $('alt-status');
  status.classList.remove('hidden', 'done');
  status.textContent = 'Looking for alternative manufacturers…';

  const res = await window.api.findAlternatives(searchedId);

  altSearchRunning = false;
  setAltButtons(false);
  status.classList.add('done');

  if (!res.ok) {
    status.textContent = 'Search failed: ' + res.error;
    return;
  }

  const product = findProduct(searchedId);
  if (!product) return;

  // Keep any pricing we already did for manufacturers that came back again
  const previous = (product.alternatives && product.alternatives.manufacturers) || [];
  const merged = res.manufacturers.map((m) => {
    const old = previous.find((o) => o.id === m.id);
    return old && old.pricedAt ? { ...m, selected: old.selected, pricedAt: old.pricedAt, options: old.options, error: old.error } : m;
  });
  product.alternatives = { searchedAt: new Date().toISOString(), manufacturers: merged };
  await persist();

  status.textContent = merged.length
    ? (res.summary || ('Found ' + merged.length + ' alternative manufacturer' + (merged.length === 1 ? '' : 's') + '.'))
    : (res.summary || 'No genuine alternatives found for this part.');
  if (res.costText) status.textContent += ' · ' + res.costText;

  if (searchedId === currentId) renderAlternatives(product);
});

$('btn-price-alts').addEventListener('click', async () => {
  if (altSearchRunning) return;
  const p = findProduct(currentId);
  if (!p || !p.alternatives) return;

  const chosen = p.alternatives.manufacturers.filter((m) => m.selected);
  const status = $('alt-status');
  status.classList.remove('hidden', 'done');
  if (!chosen.length) {
    status.classList.add('done');
    status.textContent = 'Tick at least one manufacturer first.';
    return;
  }

  altSearchRunning = true;
  const searchedId = currentId;
  setAltButtons(true);
  status.textContent = 'Pricing ' + chosen.length + ' manufacturer' + (chosen.length === 1 ? '' : 's') + '…';

  const res = await window.api.priceAlternatives(searchedId, chosen);

  altSearchRunning = false;
  setAltButtons(false);
  status.classList.add('done');

  if (!res.ok) {
    status.textContent = 'Pricing failed: ' + res.error;
    return;
  }

  const product = findProduct(searchedId);
  if (!product || !product.alternatives) return;

  product.alternatives.manufacturers = product.alternatives.manufacturers.map((m) => {
    const updated = res.manufacturers.find((x) => x.id === m.id);
    return updated ? { ...m, ...updated } : m;
  });
  await persist();

  const found = res.manufacturers.reduce((n, m) => n + ((m.options && m.options.length) || 0), 0);
  status.textContent = found
    ? 'Found ' + found + ' verified UK option' + (found === 1 ? '' : 's') + ' across ' + res.manufacturers.length + ' manufacturer' + (res.manufacturers.length === 1 ? '' : 's') + '.'
    : 'No UK retailers could be verified for the selected manufacturers.';
  if (res.costText) status.textContent += ' · ' + res.costText;

  if (searchedId === currentId) renderAlternatives(product);
});

/* ---------------- Reset app data ---------------- */

$('btn-reset-data').addEventListener('click', () => {
  $('reset-confirm-text').value = '';
  $('btn-reset-confirm').disabled = true;
  $('reset-overlay').classList.remove('hidden');
  $('reset-confirm-text').focus();
});

$('reset-confirm-text').addEventListener('input', () => {
  $('btn-reset-confirm').disabled = $('reset-confirm-text').value.trim() !== 'DELETE';
});

$('btn-reset-confirm').addEventListener('click', async () => {
  if ($('reset-confirm-text').value.trim() !== 'DELETE') return;
  await window.api.resetData();
  store = await window.api.loadData();
  renderCarSwitch();
  renderGarage();
  currentId = null;
  $('filter-status').value = '';
  $('filter-type').value = '';
  $('sort-by').value = 'added';
  $('reset-overlay').classList.add('hidden');
  renderGrid();
  renderTracker();
  switchTab('products');
});

for (const btn of document.querySelectorAll('[data-close="reset"]')) {
  btn.addEventListener('click', () => $('reset-overlay').classList.add('hidden'));
}

/* ---------------- In-app confirmation ---------------- */

// Replaces the operating-system dialog: it matches the app's theme, makes no
// error sound, and labels its button with the action it performs.
let confirmResolve = null;

function appConfirm({ title, message, confirmLabel, danger, warnings }) {
  if (confirmResolve) settleConfirm(false); // never leave an older prompt hanging
  $('confirm-title').textContent = title || 'Are you sure?';

  const msg = $('confirm-message');
  msg.replaceChildren();
  for (const para of String(message || '').split('\n\n')) {
    if (!para.trim()) continue;
    const el = document.createElement('p');
    el.textContent = para;
    msg.appendChild(el);
  }

  const list = $('confirm-warning-list');
  list.replaceChildren();
  for (const w of warnings || []) {
    const li = document.createElement('li');
    li.textContent = w;
    list.appendChild(li);
  }
  $('confirm-warning').classList.toggle('hidden', !(warnings && warnings.length));

  const ok = $('confirm-ok');
  ok.textContent = confirmLabel || 'OK';
  ok.className = 'btn ' + (danger ? 'btn-danger' : 'btn-primary');

  $('confirm-overlay').classList.remove('hidden');
  // Destructive actions start on Cancel, so Enter can't delete by accident
  (danger ? $('confirm-cancel') : ok).focus();

  return new Promise((resolve) => { confirmResolve = resolve; });
}

function settleConfirm(result) {
  $('confirm-overlay').classList.add('hidden');
  const resolve = confirmResolve;
  confirmResolve = null;
  if (resolve) resolve(result);
}

$('confirm-ok').addEventListener('click', () => settleConfirm(true));
$('confirm-cancel').addEventListener('click', () => settleConfirm(false));
$('confirm-x').addEventListener('click', () => settleConfirm(false));

/* ---------------- Cars ---------------- */

function renderCarSwitch() {
  const sel = $('car-select');
  sel.replaceChildren();
  for (const car of store.cars) {
    const opt = document.createElement('option');
    opt.value = car.id;
    opt.textContent = car.name;
    sel.appendChild(opt);
  }
  const add = document.createElement('option');
  add.value = '__add__';
  add.textContent = '+ Add car…';
  sel.appendChild(add);
  sel.value = store.activeCarId;
  const car = activeCar();
  $('tracker-car-name').textContent = car ? car.name : '';
}

async function switchCar(carId) {
  if (!store.cars.some((c) => c.id === carId)) return;
  store.activeCarId = carId;
  currentId = null;
  // Filters and sort belonged to the car being left
  $('filter-status').value = '';
  $('filter-type').value = '';
  $('sort-by').value = 'added';
  for (const id of ['detail-overlay', 'form-overlay']) $(id).classList.add('hidden');
  await persist();
  renderCarSwitch();
  renderGrid();
  renderTracker();
  renderGarage();
}

$('car-select').addEventListener('change', () => {
  const value = $('car-select').value;
  if (value === '__add__') {
    $('car-select').value = store.activeCarId; // don't leave "+ Add car" showing
    openCarForm();
    return;
  }
  switchCar(value);
});

function carTotals(car) {
  let spent = 0;
  let planned = 0;
  for (const p of car.products) {
    const price = Number(p.price) || 0;
    planned += price;
    if (p.status && p.status !== 'Not purchased') spent += price;
  }
  return { spent, planned, count: car.products.length };
}

function renderGarage() {
  const list = $('garage-list');
  list.replaceChildren();

  for (const car of store.cars) {
    const active = car.id === store.activeCarId;
    const totals = carTotals(car);

    const card = document.createElement('div');
    card.className = 'garage-card' + (active ? ' active' : '');

    const top = document.createElement('div');
    top.className = 'garage-card-top';
    const name = document.createElement('input');
    name.className = 'garage-name';
    name.value = car.name;
    name.maxLength = 40;
    name.setAttribute('aria-label', 'Car name');
    name.addEventListener('change', async () => {
      car.name = name.value.trim() || car.name;
      name.value = car.name;
      await persist();
      renderCarSwitch();
    });
    top.appendChild(name);

    if (active) {
      const badge = document.createElement('span');
      badge.className = 'garage-badge';
      badge.textContent = 'Current';
      top.appendChild(badge);
    } else {
      const go = document.createElement('button');
      go.className = 'btn';
      go.textContent = 'Switch to';
      go.addEventListener('click', async () => {
        await switchCar(car.id);
        switchTab('products');
      });
      top.appendChild(go);
    }
    card.appendChild(top);

    const field = document.createElement('label');
    field.className = 'field garage-vehicle';
    const caption = document.createElement('span');
    caption.textContent = 'Vehicle (AI searches check parts fit against this)';
    const vehicle = document.createElement('input');
    vehicle.type = 'text';
    vehicle.maxLength = 100;
    vehicle.placeholder = 'e.g. 2014 Toyota GT86 (ZN6, UK model)';
    vehicle.value = car.vehicle || '';
    vehicle.addEventListener('change', async () => {
      car.vehicle = vehicle.value.trim();
      await persist();
      renderGarage();
    });
    field.append(caption, vehicle);
    card.appendChild(field);

    if (!car.vehicle) {
      const warn = document.createElement('p');
      warn.className = 'garage-warn';
      warn.textContent = 'No vehicle set - AI searches are turned off for this car until you add one.';
      card.appendChild(warn);
    }

    const stats = document.createElement('div');
    stats.className = 'garage-stats';
    stats.textContent = totals.count + ' part' + (totals.count === 1 ? '' : 's') +
      ' · ' + money.format(totals.spent) + ' spent · ' + money.format(totals.planned) + ' planned';
    card.appendChild(stats);

    const del = document.createElement('button');
    del.className = 'btn btn-danger garage-delete';
    del.textContent = 'Delete car';
    del.disabled = store.cars.length === 1;
    del.title = del.disabled ? 'You need at least one car' : 'Delete this car and all of its parts';
    del.addEventListener('click', () => deleteCar(car));
    card.appendChild(del);

    list.appendChild(card);
  }
}

async function deleteCar(car) {
  if (store.cars.length === 1) return;
  const count = car.products.length;
  const ok = await appConfirm({
    title: 'Delete ' + car.name + '?',
    message: 'This permanently deletes ' + car.name + ' and its ' + count + ' part' + (count === 1 ? '' : 's') +
      ', including their photos, links and alternatives.\n\nThere is no undo.',
    confirmLabel: 'Delete car',
    danger: true
  });
  if (!ok) return;

  // These photos belong only to this car's parts, so they go with it
  for (const p of car.products) {
    if (p.image) await window.api.deleteImage(p.image);
    for (const a of (p.alternatives && p.alternatives.manufacturers) || []) {
      if (a.image) await window.api.deleteImage(a.image);
    }
  }
  store.cars = store.cars.filter((c) => c.id !== car.id);
  if (store.activeCarId === car.id) store.activeCarId = store.cars[0].id;
  await switchCar(store.activeCarId);
}

function openCarForm() {
  $('car-name').value = '';
  $('car-vehicle').value = '';
  clearFieldError('car-name', 'car-name-error');
  $('car-overlay').classList.remove('hidden');
  $('car-name').focus();
}

async function saveNewCar() {
  const name = $('car-name').value.trim();
  if (!name) { showFieldError('car-name', 'car-name-error'); return; }
  const car = { id: crypto.randomUUID(), name, vehicle: $('car-vehicle').value.trim(), products: [] };
  store.cars.push(car);
  $('car-overlay').classList.add('hidden');
  await switchCar(car.id);
  switchTab('products');
}

$('car-name').addEventListener('input', () => clearFieldError('car-name', 'car-name-error'));
$('btn-add-car').addEventListener('click', openCarForm);
$('btn-save-car').addEventListener('click', saveNewCar);
for (const id of ['car-name', 'car-vehicle']) {
  $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') saveNewCar(); });
}
for (const btn of document.querySelectorAll('[data-close="car"]')) {
  btn.addEventListener('click', () => $('car-overlay').classList.add('hidden'));
}

/* ---------------- Movable popups ---------------- */

// Every popup can be dragged by its title bar, so it can be moved off whatever
// it is covering. Each time a popup opens it starts centred again.
let suppressBackdropClick = false;

function makeDraggable(overlay) {
  const modal = overlay.querySelector('.modal');
  const handle = modal && modal.querySelector('.modal-head');
  if (!handle) return;

  const pos = () => [Number(modal.dataset.x) || 0, Number(modal.dataset.y) || 0];
  const place = (x, y) => {
    modal.dataset.x = x;
    modal.dataset.y = y;
    modal.style.transform = (x || y) ? 'translate(' + x + 'px, ' + y + 'px)' : '';
  };

  let dragging = false;
  let moved = false;
  let startX = 0;
  let startY = 0;
  let baseX = 0;
  let baseY = 0;

  handle.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.closest('button, input, select, textarea')) return;
    [baseX, baseY] = pos();
    startX = e.clientX;
    startY = e.clientY;
    dragging = true;
    moved = false;
    modal.classList.add('dragging');
    e.preventDefault(); // no text selection while dragging
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    if (Math.abs(e.clientX - startX) + Math.abs(e.clientY - startY) > 3) moved = true;

    // Where the popup would sit with no offset, so the limits can be worked out
    const [curX, curY] = pos();
    const r = modal.getBoundingClientRect();
    const homeLeft = r.left - curX;
    const homeTop = r.top - curY;

    // Always leave the title bar reachable, so it can be grabbed again
    const keep = 80;
    const x = Math.min(window.innerWidth - keep - homeLeft,
      Math.max(keep - r.width - homeLeft, baseX + e.clientX - startX));
    const y = Math.min(window.innerHeight - handle.offsetHeight - homeTop,
      Math.max(-homeTop, baseY + e.clientY - startY));
    place(x, y);
  });

  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    modal.classList.remove('dragging');
    // Letting go over the dimmed backdrop must not count as clicking it
    if (moved) {
      suppressBackdropClick = true;
      setTimeout(() => { suppressBackdropClick = false; }, 0);
    }
  });

  // Recentre only on a real hidden -> shown change, not on re-renders
  let wasHidden = overlay.classList.contains('hidden');
  new MutationObserver(() => {
    const hidden = overlay.classList.contains('hidden');
    if (wasHidden && !hidden) place(0, 0);
    wasHidden = hidden;
  }).observe(overlay, { attributes: true, attributeFilter: ['class'] });
}

document.addEventListener('click', (e) => {
  if (suppressBackdropClick) {
    e.stopPropagation();
    e.preventDefault();
  }
}, true);

for (const overlay of document.querySelectorAll('.overlay')) makeDraggable(overlay);

/* ---------------- Alternatives vs purchased parts ---------------- */

// Once a part is bought, alternatives are just clutter. They're hidden rather
// than deleted, so setting it back to "Not purchased" brings them back.
function updateAltVisibility(p) {
  const bought = !!p && (p.status || 'Not purchased') !== 'Not purchased';
  $('wrap-alts').classList.toggle('hidden', bought);
}

/* ---------------- Modal close wiring ---------------- */

for (const btn of document.querySelectorAll('[data-close="form"]')) {
  btn.addEventListener('click', () => closeForm(true));
}
for (const btn of document.querySelectorAll('[data-close="detail"]')) {
  btn.addEventListener('click', () => $('detail-overlay').classList.add('hidden'));
}

// Click on the dark backdrop closes the details modal (all its edits save live)
$('detail-overlay').addEventListener('click', (e) => {
  if (e.target === $('detail-overlay')) $('detail-overlay').classList.add('hidden');
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('confirm-overlay').classList.contains('hidden')) settleConfirm(false);
  else if (!$('car-overlay').classList.contains('hidden')) $('car-overlay').classList.add('hidden');
  else if (!$('reset-overlay').classList.contains('hidden')) $('reset-overlay').classList.add('hidden');
  else if (!$('form-overlay').classList.contains('hidden')) closeForm(true);
  else $('detail-overlay').classList.add('hidden');
});

/* ---------------- Init ---------------- */

(async function init() {
  $('app-version').textContent = 'Version ' + window.api.appVersion;
  settings = await window.api.loadSettings();
  applySettings();
  store = await window.api.loadData();
  renderCarSwitch();
  renderGrid();
  renderTracker();
  renderGarage();
})();
