const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

async function openReport(t, viewport = { width: 390, height: 844 }) {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport });
  const requests = { logins: [], dashboards: 0, authenticated: false };
  await page.route('https://report.test/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/login') {
      const values = new URLSearchParams(route.request().postData());
      requests.logins.push(Object.fromEntries(values));
      if (values.get('username') !== 'operator' || values.get('password') !== ' p+&=密碼 ') {
        return route.fulfill({ status: 401, json: { error: 'Incorrect username or password.' } });
      }
      requests.authenticated = true;
      return route.fulfill({ json: { ok: true } });
    }
    if (pathname === '/api/dashboard') {
      requests.dashboards += 1;
      if (!requests.authenticated) {
        return route.fulfill({ status: 401, json: { error: 'Please sign in to continue.' } });
      }
      return route.fulfill({ json: {
        records: [], signIns: [], accounts: [], messages: [], messageSync: [],
        generatedAt: '2026-10-02T00:00:00Z', isSnapshot: false,
      } });
    }
    const file = pathname.startsWith('/assets/') ? pathname.slice(1) : 'index.html';
    const contentType = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
    return route.fulfill({ body: fs.readFileSync(path.join(__dirname, '../dist', file)), contentType });
  });
  return { page, requests };
}

async function signIn(page, password = ' p+&=密碼 ') {
  await page.getByRole('textbox', { name: 'Username', exact: true }).fill('operator');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

test('report login validates credentials inline, preserves passwords, and returns to the requested page', async (t) => {
  const { page, requests } = await openReport(t);
  await page.goto('https://report.test/login?next=%2Faccounts');
  await page.getByRole('heading', { name: 'Sign in', exact: true }).waitFor();
  assert.equal(requests.dashboards, 0, 'login must not request protected dashboard data');
  assert.equal(await page.getByLabel('Username', { exact: true }).getAttribute('autocomplete'), 'username');
  assert.equal(await page.getByLabel('Password', { exact: true }).getAttribute('autocomplete'), 'current-password');
  assert.equal(await page.getByLabel('Password', { exact: true }).getAttribute('type'), 'password');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.setViewportSize({ width: 1440, height: 1000 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

  await signIn(page, 'wrong');
  await page.getByRole('alert').waitFor();
  assert.equal(await page.getByRole('alert').innerText(), 'Incorrect username or password.');
  assert.equal(await page.getByRole('button', { name: 'Sign in', exact: true }).isEnabled(), true);
  assert.equal(requests.dashboards, 0);

  await signIn(page);
  await page.waitForURL('https://report.test/accounts');
  await page.getByRole('navigation', { name: 'Primary' }).waitFor();
  assert.deepEqual(requests.logins, [
    { username: 'operator', password: 'wrong' },
    { username: 'operator', password: ' p+&=密碼 ' },
  ]);
});

test('an expired report API session opens the login form and preserves the hash route', async (t) => {
  const { page } = await openReport(t);
  await page.goto('https://report.test/#messages');
  await page.getByRole('heading', { name: 'Sign in', exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('next'), '/#messages');
  await signIn(page);
  await page.waitForURL('https://report.test/#messages');
  await page.getByRole('heading', { name: 'Private messages', exact: true }).waitFor();
});

test('report login rejects external, malformed, and recursive return URLs', async (t) => {
  const { page } = await openReport(t);
  for (const next of ['https://outside.test/', '//outside.test/', 'http://[', '/login?next=/login']) {
    await page.goto(`https://report.test/login?next=${encodeURIComponent(next)}`);
    await signIn(page);
    await page.waitForURL('https://report.test/');
    await page.getByRole('navigation', { name: 'Primary' }).waitFor();
  }
});

test('a server login redirect preserves a browser hash fragment', async (t) => {
  const { page } = await openReport(t);
  await page.goto('https://report.test/login?next=%2F#accounts');
  await signIn(page);
  await page.waitForURL('https://report.test/#accounts');
  await page.getByRole('navigation', { name: 'Primary' }).waitFor();
});
