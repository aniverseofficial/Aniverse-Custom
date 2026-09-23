import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import dotenv from 'dotenv';

dotenv.config({ path: path.join(process.cwd(), '.env') });

const ROOT = process.cwd();
const BASE = (process.env.TEST_BASE_URL || `http://localhost:${process.env.PORT || 4000}`).replace(/\/$/, '');
const TIMEOUT = Number(process.env.TEST_TIMEOUT_MS || 10000);
const START_LOCAL = process.env.TEST_NO_START !== '1';
const RUN_EXTERNAL = process.env.TEST_EXTERNAL === '1';
const RUN_MUTATIONS = process.env.TEST_MUTATIONS !== '0';
const RUN_BROWSER = process.env.TEST_BROWSER === '1' || process.env.TEST_RUN_ALL === '1';
const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL || process.env.ADMIN_EMAIL || '';
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || '';
const REPORT_PATH = process.env.TEST_REPORT || path.join(ROOT, 'DEPLOYMENT-TEST-REPORT.md');

const results = [];
let child = null;
let adminToken = '';
let testProductId = '';
let testCategoryId = '';
let testDiscountId = '';
let testDraftId = '';
let testStaffId = '';

function now() { return new Date().toISOString(); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function scoreFor(status) { return status === 'PASS' ? 10 : status === 'WARN' ? 6 : status === 'SKIP' ? 5 : 0; }
function add(category, name, status, detail = '', critical = false) {
  results.push({ category, name, status, detail, critical, score: scoreFor(status) });
  const icon = status === 'PASS' ? 'PASS' : status === 'WARN' ? 'WARN' : status === 'SKIP' ? 'SKIP' : 'FAIL';
  console.log(`[${icon}] ${category} :: ${name}${detail ? ` — ${detail}` : ''}`);
}
function envPresent(name) { return Boolean(process.env[name] && String(process.env[name]).trim()); }

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const r = await fetch(url, { redirect: 'manual', ...options, signal: controller.signal });
    const text = await r.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { r, body, text };
  } finally { clearTimeout(timer); }
}
async function expect(name, category, fn, opts = {}) {
  try {
    const value = await fn();
    add(category, name, 'PASS', opts.detail || '', opts.critical);
    return value;
  } catch (e) {
    add(category, name, opts.warn ? 'WARN' : 'FAIL', e?.message || String(e), opts.critical);
    return null;
  }
}
function assert(condition, message) { if (!condition) throw new Error(message); }
function authHeaders(extra = {}) { return { Authorization: `Bearer ${adminToken}`, ...extra }; }

async function serverReachable() {
  try { const { r } = await fetchJson(`${BASE}/api/health`); return r.status < 600; } catch { return false; }
}
async function startServerIfNeeded() {
  if (await serverReachable()) return true;
  if (!START_LOCAL) return false;
  const url = new URL(BASE);
  const port = url.port || '4000';
  console.log(`Server not running. Starting local server on port ${port}...`);
  child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: port },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', d => process.stdout.write(`[server] ${d}`));
  child.stderr.on('data', d => process.stderr.write(`[server] ${d}`));
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    if (await serverReachable()) return true;
    await sleep(400);
  }
  return false;
}

async function publicTests() {
  await expect('Health endpoint', 'Public/API', async () => {
    const { r, body } = await fetchJson(`${BASE}/api/health`);
    assert(r.ok, `HTTP ${r.status}`); assert(body && typeof body === 'object', 'Health response is not JSON');
  }, { critical: true });

  for (const [name, url] of [
    ['Storefront HTML', '/'], ['Admin HTML', '/admin/'], ['Contact page', '/contact.html'],
    ['FAQ page', '/faq.html'], ['Shipping policy', '/shipping-policy.html'],
    ['Returns/refunds policy', '/returns-refunds.html'], ['Cancellation policy', '/cancellation-policy.html'],
    ['Privacy policy', '/privacy-policy.html'], ['Terms page', '/terms.html'], ['Robots', '/robots.txt'], ['Sitemap', '/sitemap.xml']
  ]) {
    await expect(name, 'Public/Pages', async () => {
      const { r, text } = await fetchJson(`${BASE}${url}`);
      assert(r.ok || r.status === 304, `HTTP ${r.status}`);
      assert(text && text.length > 20, 'Empty response');
    });
  }

  for (const [name, url, validator] of [
    ['Products API', '/api/products?limit=5', b => Array.isArray(b)],
    ['Categories API', '/api/categories', b => Array.isArray(b)],
    ['Hero API', '/api/hero', b => Array.isArray(b)],
    ['Store settings API', '/api/store/settings', b => b && typeof b === 'object']
  ]) {
    await expect(name, 'Public/API', async () => {
      const { r, body } = await fetchJson(`${BASE}${url}`); assert(r.ok, `HTTP ${r.status}`); assert(validator(body), 'Unexpected response shape');
    });
  }
}

async function authTests() {
  await expect('Unauthenticated admin API blocked', 'Security', async () => {
    const { r } = await fetchJson(`${BASE}/api/dashboard`); assert(r.status === 401, `Expected 401, got ${r.status}`);
  }, { critical: true });
  await expect('Invalid admin credentials rejected', 'Security', async () => {
    const { r } = await fetchJson(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: ADMIN_EMAIL || 'invalid@example.com', password: '__invalid_test_password__' }) });
    assert(r.status === 401 || r.status === 403, `Expected 401/403, got ${r.status}`);
  }, { critical: true });

  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    add('Security', 'Admin login test', 'SKIP', 'Set TEST_ADMIN_EMAIL/TEST_ADMIN_PASSWORD or ADMIN_EMAIL/ADMIN_PASSWORD to run authenticated tests.');
    return false;
  }
  const login = await expect('Admin login', 'Authentication', async () => {
    const { r, body } = await fetchJson(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }) });
    assert(r.ok, `HTTP ${r.status}: ${body?.error || ''}`); assert(body?.token, 'No admin token returned'); adminToken = body.token;
  }, { critical: true });
  if (!login && !adminToken) return false;

  await expect('Admin dashboard', 'Admin/API', async () => {
    const { r, body } = await fetchJson(`${BASE}/api/dashboard`, { headers: authHeaders() }); assert(r.ok, `HTTP ${r.status}`); assert(body && typeof body === 'object', 'Invalid dashboard response');
  }, { critical: true });

  for (const [name, url] of [
    ['Admin products', '/api/admin/products'], ['Orders', '/api/orders'], ['Customers', '/api/users'],
    ['Inventory', '/api/admin/inventory'], ['Analytics', '/api/admin/analytics'], ['Discounts', '/api/discounts'],
    ['Draft orders', '/api/draft-orders'], ['Settings', '/api/admin/settings'], ['Activity log', '/api/admin/activity'],
    ['Staff', '/api/admin/staff']
  ]) {
    await expect(name, 'Admin/API', async () => {
      const { r } = await fetchJson(`${BASE}${url}`, { headers: authHeaders() }); assert(r.ok, `HTTP ${r.status}`);
    });
  }
  return true;
}

async function mutationTests() {
  if (!adminToken || !RUN_MUTATIONS) { add('CRUD', 'Safe mutation tests', 'SKIP', 'Disabled or no admin token. Set TEST_MUTATIONS=1 to enable.'); return; }
  const marker = `DEPLOYMENT_TEST_${Date.now()}_${randomBytes(2).toString('hex')}`;

  await expect('Create test category', 'Products/Catalog', async () => {
    const { r, body } = await fetchJson(`${BASE}/api/categories`, { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ name: marker, slug: marker.toLowerCase().replace(/[^a-z0-9]+/g, '-'), showInDirectory: false, heroEnabled: false }) });
    assert(r.status === 201 || r.ok, `HTTP ${r.status}: ${body?.error || ''}`); testCategoryId = body?._id || body?.id; assert(testCategoryId, 'No category id returned');
  });

  await expect('Create test product', 'Products/Catalog', async () => {
    const { r, body } = await fetchJson(`${BASE}/api/products`, { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ name: marker, slug: marker.toLowerCase(), price: 99, stock: 7, sku: marker, categories: [testCategoryId], active: true, isPreorder: false, featured: false, requiresShipping: true, hsnCode: '95030090', gstRate: 5, weight: 0.1, seoTitle: marker, seoDescription: 'Deployment test product' }) });
    assert(r.status === 201 || r.ok, `HTTP ${r.status}: ${body?.error || ''}`); testProductId = body?._id || body?.id; assert(testProductId, 'No product id returned');
  });

  if (testProductId) {
    await expect('Update product', 'Products/Catalog', async () => {
      const { r, body } = await fetchJson(`${BASE}/api/products/${testProductId}`, { method: 'PUT', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ name: `${marker}_UPDATED`, price: 109, stock: 8, active: true, categories: [testCategoryId], requiresShipping: true }) });
      assert(r.ok, `HTTP ${r.status}: ${body?.error || ''}`);
    });
    await expect('Inventory adjustment + history', 'Inventory', async () => {
      const { r, body } = await fetchJson(`${BASE}/api/products/${testProductId}/inventory`, { method: 'PATCH', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ stock: 6, reason: 'deployment test' }) });
      assert(r.ok, `HTTP ${r.status}: ${body?.error || ''}`);
      const h = await fetchJson(`${BASE}/api/admin/inventory/${testProductId}/history`, { headers: authHeaders() });
      assert(h.r.ok, `History HTTP ${h.r.status}`); assert(Array.isArray(h.body), 'History is not an array');
    });
  }

  await expect('Create test discount', 'Discounts', async () => {
    const { r, body } = await fetchJson(`${BASE}/api/discounts`, { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ code: marker.slice(0, 18), type: 'percentage', value: 10, minimumAmount: 100, usageLimit: 1, active: true }) });
    assert(r.status === 201 || r.ok, `HTTP ${r.status}: ${body?.error || ''}`); testDiscountId = body?._id || body?.id;
  });

  await expect('Validate discount', 'Discounts', async () => {
    const code = marker.slice(0, 18).toUpperCase();
    const { r, body } = await fetchJson(`${BASE}/api/discounts/validate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, subtotal: 200 }) });
    assert(r.ok, `HTTP ${r.status}: ${body?.error || ''}`); assert(body.valid === true, 'Discount was not valid');
  });

  if (testProductId) {
    await expect('Create test draft order', 'Draft Orders', async () => {
      const { r, body } = await fetchJson(`${BASE}/api/draft-orders`, { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ customer: { name: 'Deployment Test', email: `deployment-${Date.now()}@example.com`, phone: '9999999999' }, items: [{ productId: testProductId, quantity: 1 }], discount: 0, shipping: 0 }) });
      assert(r.status === 201 || r.ok, `HTTP ${r.status}: ${body?.error || ''}`); testDraftId = body?._id || body?.id;
    });
  }

  await expect('Export products CSV', 'Exports', async () => {
    const { r, text } = await fetchJson(`${BASE}/api/admin/export/products`, { headers: authHeaders() }); assert(r.ok, `HTTP ${r.status}`); assert(text.includes('name') && text.includes('price'), 'CSV headers missing');
  });
  await expect('Export customers CSV', 'Exports', async () => { const { r } = await fetchJson(`${BASE}/api/admin/export/customers`, { headers: authHeaders() }); assert(r.ok, `HTTP ${r.status}`); });
  await expect('Export orders CSV', 'Exports', async () => { const { r } = await fetchJson(`${BASE}/api/admin/export/orders`, { headers: authHeaders() }); assert(r.ok, `HTTP ${r.status}`); });
}

async function integrationTests() {
  if (!RUN_EXTERNAL) {
    add('Integrations', 'Razorpay live/test API', 'SKIP', 'Set TEST_EXTERNAL=1. This performs external API calls; use test credentials first.');
    add('Integrations', 'Shiprocket API', 'SKIP', 'Set TEST_EXTERNAL=1. This performs external API calls and requires configured credentials.');
  } else {
    await expect('Razorpay configuration', 'Integrations', async () => { assert(envPresent('RAZORPAY_KEY_ID') && envPresent('RAZORPAY_KEY_SECRET'), 'Razorpay credentials are missing'); });
    if (envPresent('SHIPROCKET_EMAIL') && envPresent('SHIPROCKET_PASSWORD')) { await expect('Shiprocket configuration', 'Integrations', async () => { assert(true); }); } else { add('Integrations', 'Shiprocket configuration', 'SKIP', 'Shipping integration intentionally deferred; configure SHIPROCKET_EMAIL/SHIPROCKET_PASSWORD when shipping is integrated.'); }
  }
  await expect('ImageKit configuration', 'Integrations', async () => {
    const { r, body } = await fetchJson(`${BASE}/api/admin/imagekit-usage`, { headers: authHeaders() });
    if (r.status === 503) throw new Error('ImageKit is not configured');
    assert(r.ok, `HTTP ${r.status}: ${body?.error || ''}`);
  }, { warn: true });
}

async function securityTests() {
  await expect('Malformed JWT rejected', 'Security', async () => {
    const { r } = await fetchJson(`${BASE}/api/dashboard`, { headers: { Authorization: 'Bearer definitely-not-a-token' } }); assert(r.status === 401, `Expected 401, got ${r.status}`);
  }, { critical: true });
  await expect('Protected product write rejected without token', 'Security', async () => {
    const { r } = await fetchJson(`${BASE}/api/products`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'should-not-create' }) }); assert(r.status === 401, `Expected 401, got ${r.status}`);
  }, { critical: true });
  await expect('Webhook secret configuration', 'Security', async () => {
    assert(envPresent('RAZORPAY_WEBHOOK_SECRET'), 'RAZORPAY_WEBHOOK_SECRET is not configured');
  }, { warn: true });
  await expect('Production secrets are not defaults', 'Security', async () => {
    const jwt = String(process.env.JWT_SECRET || '');
    assert(jwt.length >= 32 && !/replace|change-this|secret/i.test(jwt), 'JWT_SECRET looks like a placeholder or is too short');
    assert(process.env.NODE_ENV === 'production' || process.env.ALLOW_TEST_SECRETS === '1', 'NODE_ENV is not production; use ALLOW_TEST_SECRETS=1 only for local testing');
  }, { warn: true });
}

async function browserTests() {
  if (!RUN_BROWSER) {
    add('Browser/UI', 'Interactive storefront/admin test', 'SKIP', 'Browser tests disabled. Set TEST_BROWSER=1 in .env or use TEST_RUN_ALL=1.');
    return;
  }
  let chromium;
  try { ({ chromium } = await import('playwright')); }
  catch {
    add('Browser/UI', 'Interactive storefront/admin test', 'SKIP', 'Playwright is not installed. Run npm i -D playwright and then npm run test:deploy.');
    return;
  }

  const chromePath = process.env.CHROME_EXECUTABLE_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const browser = await chromium.launch({ headless: true, executablePath: chromePath });
  const context = await browser.newContext();
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => consoleErrors.push(e.message));

  await expect('Storefront UI', 'Browser/UI', async () => {
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: 20000 });
    const body = await page.locator('body').innerText();
    assert(body.length > 100, 'Storefront body is unexpectedly empty');
    assert(/shop|anime|product/i.test(body), 'Expected storefront content not visible');
  });

  await expect('Admin login UI', 'Browser/UI', async () => {
    assert(ADMIN_EMAIL && ADMIN_PASSWORD, 'Admin credentials are not loaded from .env');
    await page.goto(`${BASE}/admin/`, { waitUntil: 'networkidle', timeout: 20000 });
    const bodyBefore = await page.locator('body').innerText();
    assert(bodyBefore.length > 50, 'Admin page is empty');

    const passwordInput = page.locator('input[type="password"]').first();
    const emailInput = page.locator('input[type="email"], input[name="email"], input[placeholder*="email" i]').first();
    if (await passwordInput.count()) {
      if (await emailInput.count()) await emailInput.fill(ADMIN_EMAIL);
      await passwordInput.fill(ADMIN_PASSWORD);
      const submit = page.locator('form#loginForm button[type="submit"], #loginForm button, button[type="submit"]').first();
      assert(await submit.count(), 'Admin login submit button not found');
      assert(await submit.isVisible().catch(() => false), 'Admin login submit button is not visible');
      await submit.click();
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(700);
    }

    const body = await page.locator('body').innerText();
    assert(/orders|products|dashboard|inventory/i.test(body), 'Authenticated admin content was not visible');
  }, { critical: true });

  if (consoleErrors.length) {
    add('Browser/UI', 'Console error audit', 'WARN', `${consoleErrors.length} browser errors observed. First: ${consoleErrors[0].slice(0, 180)}`);
  } else {
    add('Browser/UI', 'Console error audit', 'PASS');
  }

  await browser.close();
}

async function cleanup() {
  if (!adminToken) return;
  const del = async (url) => { try { await fetchJson(`${BASE}${url}`, { method: 'DELETE', headers: authHeaders() }); } catch {} };
  if (testDraftId) await del(`/api/draft-orders/${testDraftId}`);
  if (testDiscountId) await del(`/api/discounts/${testDiscountId}`);
  if (testProductId) await del(`/api/products/${testProductId}`);
  if (testCategoryId) await del(`/api/categories/${testCategoryId}`);
  if (testStaffId) await del(`/api/admin/staff/${testStaffId}`);
}

function buildReport() {
  const by = {};
  for (const r of results) (by[r.category] ||= []).push(r);
  const lines = [];
  lines.push('# Aniverse Deployment Test Report');
  lines.push('');
  lines.push(`Generated: ${now()}`);
  lines.push(`Base URL: ${BASE}`);
  lines.push(`External integrations: ${RUN_EXTERNAL ? 'enabled' : 'skipped'}`);
  lines.push('');
  const total = results.length;
  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  const warns = results.filter(r => r.status === 'WARN').length;
  const skipped = results.filter(r => r.status === 'SKIP').length;
  const weighted = total ? results.reduce((a, r) => a + r.score, 0) / total : 0;
  const rating = weighted / 10;
  const criticalFails = results.filter(r => r.critical && r.status === 'FAIL');
  const gate = criticalFails.length === 0 && failed === 0 ? (warns ? 'CONDITIONAL PASS' : 'PASS') : 'FAIL';
  lines.push(`## Final deployment gate: **${gate}**`);
  lines.push(`**Overall rating: ${rating.toFixed(1)}/10 (${Math.round(weighted * 10)}/100)**`);
  lines.push(`PASS: ${passed} · WARN: ${warns} · FAIL: ${failed} · SKIP: ${skipped}`);
  lines.push('');
  lines.push('| Category | Rating | Pass | Warn | Fail | Skip |');
  lines.push('|---|---:|---:|---:|---:|---:|');
  for (const [cat, rows] of Object.entries(by)) {
    const s = rows.reduce((a, r) => a + r.score, 0) / rows.length / 10;
    lines.push(`| ${cat} | ${s.toFixed(1)}/10 | ${rows.filter(r=>r.status==='PASS').length} | ${rows.filter(r=>r.status==='WARN').length} | ${rows.filter(r=>r.status==='FAIL').length} | ${rows.filter(r=>r.status==='SKIP').length} |`);
  }
  lines.push('');
  lines.push('## Detailed results');
  for (const [cat, rows] of Object.entries(by)) {
    lines.push(`### ${cat}`);
    for (const r of rows) lines.push(`- **${r.status}** — ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
    lines.push('');
  }
  lines.push('## Interpretation');
  if (gate === 'PASS') lines.push('All automated checks passed. Complete a real customer payment and real shipping test before switching production credentials/live mode.');
  else if (gate === 'CONDITIONAL PASS') lines.push('No automated failure blocked deployment, but warnings/skipped checks remain. Complete those checks before treating the deployment as fully verified.');
  else lines.push('Deployment should not proceed until failed critical checks are fixed and the suite is rerun.');
  lines.push('');
  lines.push('> Note: Automated API tests cannot prove real Razorpay settlement, courier pickup, physical delivery, DNS, TLS, or human visual quality unless the corresponding external/browser tests are enabled and credentials are valid.');
  fs.writeFileSync(REPORT_PATH, lines.join('\n'), 'utf8');
}

async function main() {
  console.log(`\nAniverse deployment test — ${BASE}\n`);
  const started = await startServerIfNeeded();
  if (!started) {
    add('Availability', 'Server reachable', 'FAIL', `Could not reach ${BASE}`, true);
    buildReport();
    process.exitCode = 1;
    return;
  }
  await publicTests();
  const authenticated = await authTests();
  if (authenticated) {
    await securityTests();
    await mutationTests();
    await integrationTests();
  }
  await browserTests();
  await cleanup();
  buildReport();
  const fails = results.filter(r => r.status === 'FAIL');
  const critical = results.filter(r => r.status === 'FAIL' && r.critical);
  console.log(`\nReport written to: ${REPORT_PATH}`);
  console.log(`Final: ${critical.length ? 'FAIL — critical failures present' : fails.length ? 'FAIL — failures present' : results.some(r => r.status === 'WARN' || r.status === 'SKIP') ? 'CONDITIONAL PASS — warnings/skips remain' : 'PASS'}`);
  if (child) child.kill();
  process.exitCode = critical.length || fails.length ? 1 : 0;
}

process.on('SIGINT', async () => { await cleanup(); if (child) child.kill(); process.exit(130); });
main().catch(async e => { console.error(e); await cleanup(); if (child) child.kill(); process.exit(1); });
