'use strict';
// Price finding: scrapes the product's saved links for current prices, and
// (when an Anthropic API key is configured) asks Claude with web search to
// find UK retailers stocking the exact same part.

const { net } = require('electron');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36';

function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return net.fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/json;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-GB,en;q=0.9' },
    signal: controller.signal
  }).finally(() => clearTimeout(timer));
}

function parseNumber(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = parseFloat(v.replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// Walk parsed JSON-LD looking for a Product with offers
function productFromJsonLd(node) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = productFromJsonLd(item);
      if (found) return found;
    }
    return null;
  }
  const types = [].concat(node['@type'] || []);
  if (types.includes('Product') && node.offers) {
    const offers = [].concat(node.offers);
    for (const offer of offers) {
      const price = parseNumber(offer.price != null ? offer.price : offer.lowPrice);
      if (price != null) {
        return { price, currency: offer.priceCurrency || null, title: node.name || null };
      }
    }
  }
  if (node['@graph']) return productFromJsonLd(node['@graph']);
  return null;
}

function extractFromHtml(html) {
  // 1. JSON-LD structured data
  const ldMatches = html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const m of ldMatches) {
    try {
      const found = productFromJsonLd(JSON.parse(m[1].trim()));
      if (found) return { ...found, method: 'structured data' };
    } catch (err) { /* malformed block; try the next */ }
  }

  // 2. Open Graph / product meta tags
  const metaAmount = html.match(/<meta[^>]*property=["'](?:og|product):price:amount["'][^>]*content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["'](?:og|product):price:amount["']/i);
  if (metaAmount) {
    const price = parseNumber(metaAmount[1]);
    if (price != null) {
      const metaCur = html.match(/<meta[^>]*property=["'](?:og|product):price:currency["'][^>]*content=["']([^"']+)["']/i)
        || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["'](?:og|product):price:currency["']/i);
      const title = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i);
      return { price, currency: metaCur ? metaCur[1] : null, title: title ? title[1] : null, method: 'meta tags' };
    }
  }

  // 3. itemprop microdata
  const itemProp = html.match(/itemprop=["']price["'][^>]*content=["']([^"']+)["']/i);
  if (itemProp) {
    const price = parseNumber(itemProp[1]);
    if (price != null) {
      const cur = html.match(/itemprop=["']priceCurrency["'][^>]*content=["']([^"']+)["']/i);
      return { price, currency: cur ? cur[1] : null, title: null, method: 'microdata' };
    }
  }

  // 4. Last resort: first £-amount on the page
  const pound = html.match(/£\s?(\d[\d,]*(?:\.\d{1,2})?)/);
  if (pound) {
    const price = parseNumber(pound[1]);
    if (price != null) return { price, currency: 'GBP', title: null, method: 'page text (approximate)' };
  }
  return null;
}

// Server said no to the request itself, rather than the page not existing
const BLOCKED_STATUSES = new Set([401, 403, 405, 406, 409, 429, 451, 503]);

// Some retailers (and Whiteline's own shop) sit behind a WAF that rejects any
// plain HTTP request no matter what headers it carries, but serves a real
// browser fine. Falling back to a hidden window gets those prices without
// pretending to be something we're not.
function fetchPageViaBrowser(url, timeoutMs) {
  const { BrowserWindow } = require('electron');
  return new Promise((resolve) => {
    let win = null;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { if (win && !win.isDestroyed()) win.destroy(); } catch (err) { /* already gone */ }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs || 25000);

    try {
      win = new BrowserWindow({
        show: false,
        webPreferences: {
          offscreen: true,
          images: false,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          partition: 'scrape-temp'   // in-memory: no cookies kept
        }
      });
      // Never let a scraped page open windows or wander off
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

      win.webContents.on('did-finish-load', async () => {
        try {
          const html = await win.webContents.executeJavaScript('document.documentElement.outerHTML');
          finish({ html, finalUrl: win.webContents.getURL() });
        } catch (err) {
          finish(null);
        }
      });
      win.webContents.on('did-fail-load', (e, code, desc, failedUrl, isMainFrame) => {
        if (isMainFrame) finish(null);
      });
      win.loadURL(url).catch(() => { /* did-fail-load reports it */ });
    } catch (err) {
      finish(null);
    }
  });
}

// Does the page warn that THIS buyer pays import duty? Shops routinely carry a
// footnote about duty on *international* orders, which says nothing about a UK
// customer - only unscoped duty language counts as a warning.
function buyerPaysImportDuty(html) {
  const re = /import dut|customs (charge|fee|duty)|ships? from (the )?(usa|united states|us\b)|duties and taxes/gi;
  for (const m of html.matchAll(re)) {
    const around = html.slice(Math.max(0, m.index - 160), m.index + 160).toLowerCase();
    const scopedAbroad = /international|overseas|outside (the )?(uk|united kingdom)|export|non-uk|rest of world/.test(around);
    if (!scopedAbroad) return true;
  }
  return false;
}

async function scrapeLinkPrice(url, matchTokens) {
  try {
    let html = null;
    let finalUrl = url;
    let viaBrowser = false;

    const res = await fetchWithTimeout(url, 20000);
    if (res.ok) {
      finalUrl = res.url || url;
      html = await res.text();
    } else if (BLOCKED_STATUSES.has(res.status)) {
      // Blocked, not missing - a real browser usually gets through
      const page = await fetchPageViaBrowser(url, 25000);
      if (!page) return { url, ok: false, error: 'HTTP ' + res.status + ' (site blocks automated checks)' };
      html = page.html;
      finalUrl = page.finalUrl || url;
      viaBrowser = true;
    } else {
      return { url, ok: false, error: 'HTTP ' + res.status };
    }
    // Electron doesn't always report the post-redirect URL (e.g. Google's
    // grounding redirects) - recover the real page URL from the page itself.
    let host = '';
    try { host = new URL(finalUrl).hostname; } catch (err) { /* keep empty */ }
    if (!host || /google|vertexaisearch/.test(host)) {
      const canon = html.match(/<link[^>]*rel=["']canonical["'][^>]*href=["'](https?:\/\/[^"']+)["']/i)
        || html.match(/<link[^>]*href=["'](https?:\/\/[^"']+)["'][^>]*rel=["']canonical["']/i)
        || html.match(/<meta[^>]*property=["']og:url["'][^>]*content=["'](https?:\/\/[^"']+)["']/i);
      if (canon) finalUrl = canon[1];
    }
    const htmlLower = html.toLowerCase();
    const matched = (matchTokens || []).filter((t) => htmlLower.includes(t.toLowerCase()));
    let found = extractFromHtml(html);

    // Shopify stores expose a JSON endpoint for the product
    if (!found) {
      try {
        const u = new URL(url);
        if (u.pathname.includes('/products/')) {
          const jsRes = await fetchWithTimeout(u.origin + u.pathname.replace(/\/$/, '') + '.js', 15000);
          if (jsRes.ok) {
            const pj = await jsRes.json();
            if (pj && typeof pj.price === 'number') {
              const assumeGbp = u.hostname.endsWith('.uk') || u.hostname.endsWith('.co.uk');
              found = { price: pj.price / 100, currency: assumeGbp ? 'GBP' : null, title: pj.title || null, method: 'shop data' };
            }
          }
        }
      } catch (err) { /* not a Shopify store */ }
    }

    if (!found) return { url, ok: false, error: 'No price found on page' };

    // What the page says it is ABOUT (title/heading), as opposed to anything
    // anywhere in its markup - nav menus and "related products" name plenty of
    // parts the page isn't actually selling.
    const strip = (s) => s.replace(/<[^>]*>/g, ' ');
    const titleTag = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
    const h1Tag = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || '';
    const identity = [found.title || '', strip(titleTag), strip(h1Tag)].join(' ').toLowerCase();
    const matchedIdentity = (matchTokens || []).filter((t) => identity.includes(t.toLowerCase()));

    // Is this actually a UK shop? A GBP price alone isn't proof - plenty of
    // overseas sites show £ to UK visitors and then add duty at checkout.
    let finalHost = '';
    try { finalHost = new URL(finalUrl).hostname.toLowerCase(); } catch (err) { /* keep empty */ }
    const ukTld = /\.uk$/.test(finalHost);
    // A UK storefront path or subdomain (whitelineperformance.com/uk/, uk.example.com)
    const ukStore = /(^|\.)uk\./.test(finalHost) || /\/uk(\/|$|\?)/.test(finalUrl);
    const vatMention = /\bvat\b|inc\.? vat|incl\. vat/i.test(html);
    const vatIncluded = /prices?[^.]{0,60}includ\w*\s+vat|inc\.? vat|incl\. vat|including vat/i.test(html);
    const importWarning = buyerPaysImportDuty(html);
    const ukLikely = ukTld || ukStore || vatIncluded || (vatMention && !importWarning);

    // A product photo, so a swapped-in part can carry its own image
    const ogImage = (html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i) || [])[1] || null;

    const result = { url, finalUrl, ok: true, matched, matchedIdentity, ukLikely, importWarning, imageUrl: ogImage, ...found };
    if (viaBrowser) result.method = (result.method || 'page') + ' · via browser';
    return result;
  } catch (err) {
    return { url, ok: false, error: err.name === 'AbortError' ? 'Timed out' : (err.message || 'Fetch failed') };
  }
}

// Fetch many pages at once, but never two at a time from the same retailer -
// concurrent hits on one host are what look like scraping.
async function scrapeMany(urls, matchTokens, onEach) {
  const byHost = new Map();
  for (const url of urls) {
    let host = url;
    try { host = new URL(url).hostname.replace(/^www\./, ''); } catch (err) { /* group by raw url */ }
    if (!byHost.has(host)) byHost.set(host, []);
    byHost.get(host).push(url);
  }

  const results = new Map();
  await Promise.all([...byHost.values()].map(async (group) => {
    for (const url of group) {
      const r = await scrapeLinkPrice(url, matchTokens);
      results.set(url, r);
      if (onEach) onEach(r);
    }
  }));
  return urls.map((u) => results.get(u));
}

function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch (err) { return null; }
}

function buildPrompts({ product, vehicle, currency, linkResults }) {
  const system = [
    'You are a meticulous price researcher for car parts. The user owns: ' + vehicle + '.',
    'Find UK retailers currently selling the EXACT product described, brand new, priced in ' + currency + '.',
    'STRICT RULES:',
    '- Only the exact same product (same brand, same part, same part number where available). Never a similar or equivalent part.',
    '- The part must fit the user\'s vehicle. If fitment for that exact vehicle cannot be confirmed, exclude the result.',
    '- Only UK-based companies/websites (UK retailers with UK operations). Exclude marketplaces listings shipped from abroad, used items, and non-UK sites.',
    '- Prefer in-stock items. Prices must include VAT.',
    '- Only include URLs that appeared in your search results. NEVER construct, guess, or adapt a URL — every URL will be fetched and checked, and invented ones are discarded.',
    'When done, reply with ONLY a JSON object, no other text, in this exact shape:',
    '{"candidates":[{"retailer":"name","url":"https://...","price":123.45,"currency":"' + currency + '","note":"short note e.g. in stock, part no. match"}],"summary":"one sentence about what you found"}',
    'List every verified candidate you found (cheapest first). If you find nothing that meets ALL the rules, return {"candidates":[],"summary":"why"}.'
  ].join('\n');

  const linkInfo = linkResults.length
    ? 'The user\'s own saved links were already checked directly:\n' + linkResults.map((r) =>
        '- ' + r.url + ': ' + (r.ok ? r.price + ' ' + (r.currency || '?') : 'failed (' + r.error + ')')).join('\n')
    : 'The user has no saved links for this product.';

  const prompt = [
    'Product to research:',
    'Name: ' + product.name,
    product.description ? 'Description: ' + product.description : '',
    product.partType ? 'Category: ' + product.partType : '',
    'Price currently recorded by the user: ' + product.price + ' ' + currency,
    '',
    linkInfo,
    '',
    'Search UK retailers for this exact product and report current prices.'
  ].filter(Boolean).join('\n');

  return { system, prompt };
}

async function anthropicSearch({ apiKey, system, prompt, onProgress }) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });

  const tools = [{
    type: 'web_search_20260209',
    name: 'web_search',
    max_uses: 8,
    user_location: { type: 'approximate', country: 'GB' }
  }];

  const messages = [{ role: 'user', content: prompt }];
  let response = null;

  // Server tool turns can pause; resume until the answer is complete
  for (let i = 0; i < 6; i++) {
    onProgress(i === 0 ? 'Searching UK retailers with AI…' : 'Still searching (step ' + (i + 1) + ')…');
    const stream = client.beta.messages.stream({
      model: 'claude-opus-5',
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system,
      tools,
      messages
    });
    response = await stream.finalMessage();
    if (response.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: response.content });
  }

  if (response.stop_reason === 'refusal') {
    throw new Error('The AI declined this search.');
  }

  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

  // Real URLs from the search tool's own results, where the SDK exposes them
  const sources = [];
  for (const block of response.content) {
    if (block.type !== 'web_search_tool_result' || !Array.isArray(block.content)) continue;
    for (const r of block.content) {
      if (r && typeof r.url === 'string') sources.push({ uri: r.url, domain: r.url });
    }
  }
  const u = response.usage || {};
  return {
    text,
    sources,
    usage: { inputTokens: u.input_tokens || 0, outputTokens: u.output_tokens || 0, calls: 1 }
  };
}

// Google renames Gemini models over time; try these first, then fall back to
// asking the API which models the key can actually use.
const GEMINI_PREFERRED = ['gemini-flash-latest', 'gemini-3.6-flash', 'gemini-2.5-flash'];
let geminiWorkingModel = null; // remembered for the rest of the app session

async function geminiRequest(apiKey, model, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 300000);
  try {
    return await net.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (err) {
    throw new Error(err.name === 'AbortError' ? 'Gemini search timed out.' : ('Could not reach the Gemini API: ' + (err.message || 'network error')));
  } finally {
    clearTimeout(timer);
  }
}

async function geminiListFlashModels(apiKey) {
  try {
    const res = await net.fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', {
      headers: { 'x-goog-api-key': apiKey }
    });
    if (!res.ok) return [];
    const json = await res.json();
    const names = (json.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => String(m.name || '').replace(/^models\//, ''));
    // Plain flash models only - no lite/preview/experimental/special variants
    const version = (n) => { const m = n.match(/^gemini-(\d+(?:\.\d+)?)-flash$/); return m ? parseFloat(m[1]) : null; };
    return names
      .filter((n) => version(n) !== null)
      .sort((a, b) => version(b) - version(a));
  } catch (err) {
    return [];
  }
}

async function geminiErrorMessage(res) {
  let msg = 'Gemini API error ' + res.status;
  try {
    const errJson = await res.json();
    const em = (errJson.error && errJson.error.message) || '';
    if (res.status === 400 && /api key/i.test(em)) msg = 'Gemini API key was rejected — check it in Settings.';
    else if (res.status === 403) msg = 'Gemini API key was rejected or lacks access — check it in Settings.';
    else if (res.status === 429) msg = 'Gemini web-search quota used up. Google\'s free tier tightly limits search-grounded requests — it usually resets daily (midnight US Pacific), or enabling billing on your Google AI account raises it. Usage: ai.dev/rate-limit';
    else if (res.status === 503) msg = 'Gemini is overloaded right now (tried multiple models) — try again in a few minutes.';
    else if (em) msg += ': ' + em.slice(0, 200);
  } catch (err) { /* body not JSON */ }
  return msg;
}

async function geminiSearch({ apiKey, system, prompt, onProgress }) {
  const body = {
    system_instruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    tools: [{ google_search: {} }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 8192 }
  };

  const tried = new Set();
  const queue = geminiWorkingModel
    ? [geminiWorkingModel, ...GEMINI_PREFERRED]
    : GEMINI_PREFERRED.slice();

  let lastModelError = null;
  let discovered = false;
  let timedOutOnce = false;

  while (true) {
    const model = queue.find((m) => !tried.has(m));
    if (!model) {
      if (discovered) break;
      // All known names failed with "model not found" - ask the API what exists
      discovered = true;
      onProgress('Finding an available Gemini model…');
      const available = await geminiListFlashModels(apiKey);
      const fresh = available.filter((m) => !tried.has(m));
      if (!fresh.length) break;
      queue.push(...fresh.slice(0, 3));
      continue;
    }
    tried.add(model);

    let res;
    try {
      res = await geminiRequest(apiKey, model, body);
    } catch (err) {
      // One timed-out model gets a second chance on a different model
      if (/timed out/i.test(err.message || '') && !timedOutOnce) {
        timedOutOnce = true;
        lastModelError = 'Gemini search timed out.';
        geminiWorkingModel = null;
        continue;
      }
      throw err;
    }
    if (res.status === 404 || res.status === 503) {
      // 404: model retired or renamed. 503: model overloaded right now.
      // Either way, try the next model.
      lastModelError = await geminiErrorMessage(res);
      geminiWorkingModel = null;
      continue;
    }
    if (!res.ok) {
      throw new Error(await geminiErrorMessage(res));
    }

    const json = await res.json();
    const cand = json.candidates && json.candidates[0];
    const parts = (cand && cand.content && cand.content.parts) || [];
    const text = parts.filter((p) => typeof p.text === 'string').map((p) => p.text).join('\n');
    if (!text) throw new Error('Gemini returned an empty answer' + (cand && cand.finishReason ? ' (' + cand.finishReason + ')' : '') + '.');
    geminiWorkingModel = model;

    // The pages Google actually retrieved. Unlike URLs the model types out,
    // these cannot be invented - used to rescue candidates whose URL is wrong.
    const chunks = (cand && cand.groundingMetadata && cand.groundingMetadata.groundingChunks) || [];
    const sources = [];
    for (const ch of chunks) {
      const web = ch && ch.web;
      if (web && web.uri) sources.push({ uri: web.uri, domain: String(web.title || '') });
    }

    // Thinking tokens are billed at the output rate
    const um = json.usageMetadata || {};
    const usage = {
      inputTokens: um.promptTokenCount || 0,
      outputTokens: (um.candidatesTokenCount || 0) + (um.thoughtsTokenCount || 0),
      calls: 1
    };
    return { text, sources, usage };
  }

  throw new Error(lastModelError || 'No usable Gemini model found for this API key.');
}

async function aiSearch({ provider, apiKey, product, vehicle, currency, linkResults, onProgress }) {
  const { system, prompt } = buildPrompts({ product, vehicle, currency, linkResults });

  let out;
  if (provider === 'gemini') {
    onProgress('Searching UK retailers with Gemini AI…');
    out = await geminiSearch({ apiKey, system, prompt, onProgress });
  } else {
    out = await anthropicSearch({ apiKey, system, prompt, onProgress });
  }
  const text = out.text;
  const sources = out.sources || [];

  const parsed = extractJson(text);
  if (!parsed || !Array.isArray(parsed.candidates)) {
    return { ok: false, error: 'Could not read the AI search results.', raw: text.slice(0, 400) };
  }

  const candidates = parsed.candidates
    .filter((c) => c && typeof c.url === 'string' && /^https?:\/\//.test(c.url))
    .map((c) => ({
      retailer: String(c.retailer || new URL(c.url).hostname),
      url: c.url,
      price: parseNumber(c.price),
      currency: c.currency || null,
      note: c.note ? String(c.note) : ''
    }))
    .filter((c) => c.price != null && c.price > 0);

  return {
    ok: true,
    candidates,
    sources,
    usage: out.usage || null,
    summary: parsed.summary ? String(parsed.summary) : ''
  };
}

// "demon-tweeks.com" / "Demon Tweeks" / "www.demon-tweeks.com" -> "demontweeks"
function retailerCore(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]
    .replace(/\.(co\.uk|org\.uk|ltd\.uk|com|net|org|uk|shop|store)$/g, '')
    .replace(/[^a-z0-9]/g, '');
}

// Find the real retrieved URL for a candidate whose own URL didn't work
function matchSourceUrl(candidate, sources, used) {
  const hostCore = retailerCore(candidate.url);
  const nameCore = retailerCore(candidate.retailer);
  for (const s of sources) {
    if (!s.uri || used.has(s.uri)) continue;
    const srcCore = retailerCore(s.domain);
    if (srcCore.length < 4) continue;
    const hit = [hostCore, nameCore].some((c) =>
      c && c.length >= 4 && (c === srcCore || c.includes(srcCore) || srcCore.includes(c)));
    if (hit) return s.uri;
  }
  return null;
}

// _aiSearch is a seam for tests: it lets the pipeline run against a canned AI
// response instead of calling (and paying for) the live API.
/* ---------------- Alternatives from other manufacturers ---------------- */

function slugId(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

// Stage 1: which other manufacturers make an equivalent part? No page
// verification here - prices are indicative only and labelled as such.
async function findAlternatives({ product, settings, onProgress, _runSearch }) {
  const currency = settings.currency || 'GBP';
  const vehicle = settings.vehicle || 'the car (model not specified)';
  const provider = settings.aiProvider === 'anthropic' ? 'anthropic' : 'gemini';
  const apiKey = provider === 'gemini' ? settings.geminiApiKey : settings.anthropicApiKey;
  if (!apiKey && !_runSearch) return { ok: false, error: 'No API key set — add one in Settings.' };

  const system = [
    'You identify equivalent car parts made by DIFFERENT manufacturers. The user owns: ' + vehicle + '.',
    'STRICT RULES:',
    '- The alternative must be made by a DIFFERENT manufacturer from the original part.',
    '- It must do the same job AND keep the same key characteristics as the original (if the original is adjustable the alternative must be adjustable; front stays front, rear stays rear; same size/rate class where stated).',
    '- It must be confirmed to fit the user\'s exact vehicle. If fitment cannot be confirmed, leave it out.',
    '- The manufacturer itself may be from any country, but the part must be stocked by UK retailers shipping from the UK (so the buyer pays no import duty).',
    '- Give the manufacturer\'s own part number wherever you can find it — it is used later to verify retailer pages.',
    '- Give an approximate ' + currency + ' price if one is visible in your search results, otherwise null. This is only a rough guide, so do not guess wildly.',
    '- State the key measurable specs of the alternative (diameter in mm, rate, length, adjustment range) in the specs field. Never omit a size the original states.',
    '- In differences, list EVERY way it differs from the original in plain English (e.g. "22mm vs original 27mm"). Return an empty array ONLY if it is genuinely like-for-like on every stated spec.',
    'Return at most 5 manufacturers. Reply with ONLY a JSON object:',
    '{"manufacturers":[{"manufacturer":"Hardrace","partName":"Rear Adjustable Sway Bar","partNo":"7740","specs":"22mm, 2-point adjustable","differences":["22mm vs original 27mm"],"indicativePrice":95.00,"note":"fits BK MPS"}],"summary":"one sentence"}',
    'If you find no genuine alternatives, return {"manufacturers":[],"summary":"why"}.'
  ].join('\n');

  const prompt = [
    'Original part the user already has:',
    'Name: ' + product.name,
    product.description ? 'Description: ' + product.description : '',
    product.partType ? 'Category: ' + product.partType : '',
    'Price paid/recorded: ' + product.price + ' ' + currency,
    '',
    'Find equivalent parts for this vehicle from other manufacturers.'
  ].filter(Boolean).join('\n');

  onProgress('Looking for alternative manufacturers…');
  let out;
  try {
    out = _runSearch
      ? await _runSearch({ system, prompt })
      : (provider === 'gemini'
        ? await geminiSearch({ apiKey, system, prompt, onProgress })
        : await anthropicSearch({ apiKey, system, prompt, onProgress }));
  } catch (err) {
    return { ok: false, error: aiErrorMessage(err) };
  }

  const parsed = extractJson(out.text);
  if (!parsed || !Array.isArray(parsed.manufacturers)) {
    return { ok: false, error: 'Could not read the AI results.', raw: (out.text || '').slice(0, 300) };
  }

  const seen = new Set([slugId(product.name.split(' ')[0])]);
  const manufacturers = [];
  for (const m of parsed.manufacturers) {
    if (!m || !m.manufacturer) continue;
    const id = slugId(m.manufacturer + '-' + (m.partNo || m.partName || ''));
    if (!id || seen.has(id)) continue;
    seen.add(id);
    manufacturers.push({
      id,
      manufacturer: String(m.manufacturer),
      partName: String(m.partName || ''),
      partNo: m.partNo ? String(m.partNo) : '',
      indicativePrice: parseNumber(m.indicativePrice),
      note: m.note ? String(m.note) : '',
      specs: m.specs ? String(m.specs) : '',
      differences: Array.isArray(m.differences) ? m.differences.map(String).filter(Boolean) : [],
      selected: false,
      pricedAt: null,
      options: []
    });
  }

  return {
    ok: true,
    manufacturers,
    summary: parsed.summary ? String(parsed.summary) : '',
    usage: out.usage || null
  };
}

// Stage 2: for each chosen manufacturer, find and verify the cheapest UK
// retailers for that specific part.
async function priceAlternatives({ product, manufacturers, settings, onProgress, _runSearch }) {
  const currency = settings.currency || 'GBP';
  const vehicle = settings.vehicle || 'the car (model not specified)';
  const provider = settings.aiProvider === 'anthropic' ? 'anthropic' : 'gemini';
  const apiKey = provider === 'gemini' ? settings.geminiApiKey : settings.anthropicApiKey;
  if (!apiKey && !_runSearch) return { ok: false, error: 'No API key set — add one in Settings.' };

  const priced = [];
  const usages = [];

  for (let i = 0; i < manufacturers.length; i++) {
    const alt = manufacturers[i];
    const label = alt.manufacturer + (alt.partNo ? ' ' + alt.partNo : '');
    onProgress('Pricing ' + label + ' (' + (i + 1) + ' of ' + manufacturers.length + ')…');

    const system = [
      'You find UK retailers selling one specific car part. The user owns: ' + vehicle + '.',
      'STRICT RULES:',
      '- Only the exact part named below, from that exact manufacturer. Never a different brand or a different variant.',
      '- The MANUFACTURER may be based anywhere in the world, but the RETAILER must be a UK company shipping from UK stock.',
      '- Exclude overseas sellers even if they quote ' + currency + ', and exclude anything where the buyer would pay import duty, customs or international shipping.',
      '- Only UK-based retailers, prices in ' + currency + ' including VAT, new items only.',
      '- Only include URLs that appeared in your search results. NEVER construct or guess a URL — every URL is fetched and checked.',
      'Reply with ONLY a JSON object:',
      '{"candidates":[{"retailer":"name","url":"https://...","price":123.45,"currency":"' + currency + '","note":"in stock"}],"summary":"one sentence"}',
      'If you find none, return {"candidates":[],"summary":"why"}.'
    ].join('\n');

    const prompt = [
      'Part to price:',
      'Manufacturer: ' + alt.manufacturer,
      alt.partName ? 'Part: ' + alt.partName : '',
      alt.partNo ? 'Part number: ' + alt.partNo : '',
      'It must fit: ' + vehicle,
      '',
      'Find UK retailers currently selling this exact part, cheapest first.'
    ].filter(Boolean).join('\n');

    let out;
    try {
      out = _runSearch
        ? await _runSearch({ system, prompt, alt })
        : (provider === 'gemini'
          ? await geminiSearch({ apiKey, system, prompt, onProgress })
          : await anthropicSearch({ apiKey, system, prompt, onProgress }));
    } catch (err) {
      priced.push({ ...alt, pricedAt: new Date().toISOString(), options: [], error: aiErrorMessage(err) });
      continue;
    }
    if (out.usage) usages.push(out.usage);

    const parsed = extractJson(out.text);
    const rawCandidates = (parsed && Array.isArray(parsed.candidates)) ? parsed.candidates : [];
    const candidates = rawCandidates
      .filter((c) => c && typeof c.url === 'string' && /^https?:\/\//.test(c.url))
      .map((c) => ({
        retailer: String(c.retailer || ''),
        url: c.url,
        price: parseNumber(c.price),
        currency: c.currency || null,
        note: c.note ? String(c.note) : ''
      }))
      .filter((c) => c.price != null && c.price > 0);

    // Verified against the ALTERNATIVE part's identity, not the original's
    const ctx = {
      ...buildTokens(alt.manufacturer + ' ' + alt.partName, alt.partNo),
      currency
    };
    const verified = await verifyCandidates({
      candidates,
      sources: out.sources || [],
      ctx,
      covered: new Set(),
      onProgress,
      noun: 'result for ' + alt.manufacturer
    });

    const options = verified.options
      .filter((o) => o.currency === currency)
      .sort((a, b) => a.price - b.price)
      .slice(0, 3);

    priced.push({
      ...alt,
      pricedAt: new Date().toISOString(),
      options,
      rejected: verified.rejected,
      error: options.length ? null : 'No UK retailer could be verified for this part.'
    });
  }

  return { ok: true, manufacturers: priced, usage: mergeUsage(usages) };
}

function aiErrorMessage(err) {
  let msg = (err && err.message) || 'AI search failed';
  if (err && err.status === 401) msg = 'API key was rejected — check it in Settings.';
  else if (err && err.status === 429) msg = 'API rate limit hit — try again in a minute.';
  else if (err && err.status) msg = 'API error ' + err.status + ': ' + msg;
  return msg;
}

function mergeUsage(list) {
  const valid = (list || []).filter(Boolean);
  if (!valid.length) return null;
  return valid.reduce((acc, u) => ({
    inputTokens: acc.inputTokens + (u.inputTokens || 0),
    outputTokens: acc.outputTokens + (u.outputTokens || 0),
    calls: acc.calls + (u.calls || 1)
  }), { inputTokens: 0, outputTokens: 0, calls: 0 });
}

// Same retailer page, ignoring tracking params and trailing slashes
function seenPage(u) {
  try {
    const x = new URL(u);
    return x.hostname.replace(/^www\./, '') + x.pathname.replace(/\/$/, '');
  } catch (err) {
    return u;
  }
}

// The words and part codes a retailer's page must mention to be believable
function buildTokens(name, citedText) {
  const nameTokens = [...new Set((String(name || '').toLowerCase().match(/[a-z0-9]{4,}/g) || []))];
  const citedPartNos = (String(citedText || '').match(/\b[A-Z]{2,}-?\d{2,}[A-Z0-9-]*\b/g) || []);
  // A token from the part's own name that looks like a part code counts too
  const namePartNos = nameTokens.filter((t) => /\d/.test(t) && t.length >= 5);
  const partNos = [...new Set([...citedPartNos, ...namePartNos])];
  return { nameTokens, partNos, tokens: [...nameTokens, ...partNos] };
}

// The one place a fetched page becomes a price we trust. Used by both the
// exact-product search and the alternative-manufacturer search, so neither can
// drift into a weaker standard.
function evaluatePage(scraped, meta, ctx) {
  const { tokens, nameTokens, partNos, currency } = ctx;

  if (!scraped.ok) {
    return { reason: 'could not verify page (' + scraped.error + ')' + (meta.triedAlt ? ', search link also failed' : '') + ' — excluded' };
  }
  const realUrl = scraped.finalUrl || meta.url;
  let host = '';
  try { host = new URL(realUrl).hostname; } catch (err) { /* keep empty */ }
  if (/google|vertexaisearch/.test(host)) {
    return { url: realUrl, reason: 'could not resolve to a real retailer page — excluded' };
  }
  if (!(scraped.currency === currency || (!scraped.currency && currency === 'GBP'))) {
    return { url: realUrl, reason: 'price on page is not in ' + currency + ' — excluded' };
  }
  if (tokens.length >= 2 && scraped.matched.length < 2) {
    return { url: realUrl, reason: 'page does not mention this product — excluded' };
  }
  // Pages found by search alone carry no fitment reasoning from the AI, so they
  // must identify the part far more strongly: the exact part number when one is
  // known, otherwise most of the product name in the page's own title.
  if (meta.strict) {
    const hasPartNo = partNos.length > 0
      && partNos.some((p) => scraped.matched.some((m) => m.toLowerCase() === p.toLowerCase()));
    const needed = Math.max(2, Math.ceil(nameTokens.length * 0.6));
    const nameHits = (scraped.matchedIdentity || [])
      .filter((m) => nameTokens.includes(m.toLowerCase())).length;
    if (!hasPartNo && nameHits < needed) {
      return { url: realUrl, reason: 'search result did not clearly match this exact part — excluded' };
    }
  }
  if (meta.claimedPrice > 0 && Math.abs(scraped.price - meta.claimedPrice) / meta.claimedPrice > 0.2) {
    return { url: realUrl, reason: 'page price (' + scraped.price.toFixed(2) + ') does not match the claimed ' + meta.claimedPrice.toFixed(2) + ' — excluded' };
  }
  // Not excluded - plenty of genuine UK shops sit on .com domains - but the
  // user must be able to see which ones might add duty or overseas shipping.
  const ukWarn = scraped.ukLikely === false || scraped.importWarning === true;
  const note = meta.note + (ukWarn ? ' · ⚠ may not be a UK seller — check shipping/duty' : '');

  return {
    option: {
      source: 'ai',
      retailer: meta.retailer,
      url: realUrl,
      price: scraped.price,
      currency,
      note,
      ukLikely: scraped.ukLikely !== false && !scraped.importWarning,
      imageUrl: scraped.imageUrl || null
    }
  };
}

// Verify AI-named retailers, then price the pages the search engine itself
// returned. Shared by the exact-product and alternative-manufacturer searches.
async function verifyCandidates({ candidates, sources, ctx, covered, onProgress, noun }) {
  const options = [];
  const rejected = [];
  const usedSources = new Set();
  const label = noun || 'AI result';

  /* --- Pass 1: the retailers the AI named --- */
  const toVerify = candidates.filter((c) => !covered.has(seenPage(c.url))).slice(0, 5);
  let scrapedAll = [];
  const retryAt = [];

  if (toVerify.length) {
    let done = 0;
    onProgress('Verifying ' + toVerify.length + ' ' + label + (toVerify.length === 1 ? '' : 's') + '…');
    scrapedAll = await scrapeMany(toVerify.map((c) => c.url), ctx.tokens, () => {
      done++;
      onProgress('Verified ' + done + ' of ' + toVerify.length + ' ' + label + (toVerify.length === 1 ? '' : 's') + '…');
    });

    // A dead URL usually means the model typed it from memory. Retry using the
    // page the search engine actually returned for that retailer.
    const retryUrls = [];
    for (let i = 0; i < toVerify.length; i++) {
      if (scrapedAll[i].ok) continue;
      const alt = matchSourceUrl(toVerify[i], sources, usedSources);
      if (!alt) continue;
      usedSources.add(alt);
      retryAt.push(i);
      retryUrls.push(alt);
    }
    if (retryUrls.length) {
      onProgress('Retrying ' + retryUrls.length + ' result' + (retryUrls.length === 1 ? '' : 's') + ' via the real search link…');
      const retried = await scrapeMany(retryUrls, ctx.tokens, null);
      for (let k = 0; k < retryAt.length; k++) {
        if (retried[k].ok) scrapedAll[retryAt[k]] = retried[k];
      }
    }

    for (let i = 0; i < toVerify.length; i++) {
      const c = toVerify[i];
      const res = evaluatePage(scrapedAll[i], {
        retailer: c.retailer,
        url: c.url,
        claimedPrice: c.price,
        triedAlt: retryAt.includes(i),
        note: 'verified on page' + (c.note ? ' · ' + c.note : '')
      }, ctx);
      if (res.option) {
        options.push(res.option);
        covered.add(seenPage(res.option.url));
      } else {
        rejected.push({ retailer: c.retailer, url: res.url || c.url, reason: res.reason });
      }
    }
  }

  /* --- Pass 2: pages the search engine returned that the AI didn't cite ---
     These URLs come from Google, not from the model, so they always exist.
     Free to check (just page fetches) and they catch retailers the model named
     with a made-up link, or forgot to mention entirely. */
  const known = new Set(options.map((o) => retailerCore(o.url)));
  const extras = (sources || [])
    .filter((s) => s.uri && !usedSources.has(s.uri))
    .filter((s) => {
      const core = retailerCore(s.domain);
      return core.length >= 3 && !known.has(core);
    })
    .slice(0, 6);

  if (extras.length) {
    onProgress('Checking ' + extras.length + ' more page' + (extras.length === 1 ? '' : 's') + ' from the search results…');
    const extraScraped = await scrapeMany(extras.map((s) => s.uri), ctx.tokens, null);
    for (let i = 0; i < extras.length; i++) {
      const res = evaluatePage(extraScraped[i], {
        retailer: extras[i].domain || 'search result',
        url: extras[i].uri,
        claimedPrice: 0,
        strict: true,
        note: 'found in search results'
      }, ctx);
      // These were leads, not price claims - a miss is not worth reporting
      if (res.option && !covered.has(seenPage(res.option.url))) {
        options.push(res.option);
        covered.add(seenPage(res.option.url));
      }
    }
  }

  return { options, rejected };
}

async function findCheapest({ product, settings, onProgress, mode, _aiSearch }) {
  const linksOnly = mode === 'links';
  const currency = settings.currency || 'GBP';
  const links = (product.links || []).map((l) => l.url);

  let linkDone = 0;
  if (links.length) onProgress('Checking your ' + links.length + ' saved link' + (links.length === 1 ? '' : 's') + '…');
  const linkResults = await scrapeMany(links, null, () => {
    linkDone++;
    onProgress('Checked ' + linkDone + ' of ' + links.length + ' saved link' + (links.length === 1 ? '' : 's') + '…');
  });

  const provider = settings.aiProvider === 'anthropic' ? 'anthropic' : 'gemini';
  const apiKey = linksOnly ? null : (provider === 'gemini' ? settings.geminiApiKey : settings.anthropicApiKey);

  let ai = null;
  if (apiKey || _aiSearch) {
    const search = _aiSearch || aiSearch;
    try {
      ai = await search({
        provider,
        apiKey,
        product,
        vehicle: settings.vehicle || 'the car (model not specified)',
        currency,
        linkResults,
        onProgress
      });
    } catch (err) {
      let msg = err.message || 'AI search failed';
      if (err.status === 401) msg = 'API key was rejected — check it in Settings.';
      else if (err.status === 429) msg = 'API rate limit hit — try again in a minute.';
      else if (err.status) msg = 'API error ' + err.status + ': ' + msg;
      ai = { ok: false, error: msg };
    }
  }

  // Build the comparable set: prices in the app currency only
  const options = [];
  let rejected = [];
  const covered = new Set();

  for (const r of linkResults) {
    if (r.ok && (r.currency === currency || (!r.currency && currency === 'GBP'))) {
      options.push({ source: 'link', retailer: new URL(r.url).hostname.replace(/^www\./, ''), url: r.url, price: r.price, currency, note: r.method });
      covered.add(seenPage(r.url));
    }
  }

  // Never trust an AI-claimed price or URL: fetch each page and read the real
  // price. Dead pages and prices we cannot confirm are excluded from the
  // comparison entirely.
  if (ai && ai.ok) {
    const ctx = {
      ...buildTokens(product.name, ai.candidates.map((c) => c.note || '').join(' ')),
      currency
    };
    const verified = await verifyCandidates({
      candidates: ai.candidates,
      sources: ai.sources || [],
      ctx,
      covered,
      onProgress,
      noun: 'AI result'
    });
    options.push(...verified.options);
    rejected = rejected.concat(verified.rejected);
  }
  options.sort((a, b) => a.price - b.price);
  return {
    linkResults,
    ai,
    rejected,
    options,
    cheapest: options.length ? options[0] : null,
    aiUsed: Boolean(apiKey || _aiSearch),
    linksOnly
  };
}

// Gemini 3.x Flash rates; grounded searches are free under the monthly
// allowance, so tokens are the only real cost. USD per million tokens.
const RATE_IN = 0.75;
const RATE_OUT = 3.75;
const USD_TO_GBP = 0.78;

function usageCostText(usage) {
  if (!usage || (!usage.inputTokens && !usage.outputTokens)) return '';
  const usd = (usage.inputTokens / 1e6) * RATE_IN + (usage.outputTokens / 1e6) * RATE_OUT;
  const pence = usd * USD_TO_GBP * 100;
  const shown = pence < 0.1 ? '<0.1p' : '~' + pence.toFixed(pence < 10 ? 1 : 0) + 'p';
  return 'cost ' + shown + (usage.calls > 1 ? ' (' + usage.calls + ' searches)' : '');
}

module.exports = {
  findCheapest,
  findAlternatives,
  priceAlternatives,
  scrapeLinkPrice,
  scrapeMany,
  usageCostText,
  // exposed for tests
  _retailerCore: retailerCore,
  _matchSourceUrl: matchSourceUrl,
  _buildTokens: buildTokens,
  _evaluatePage: evaluatePage
};
