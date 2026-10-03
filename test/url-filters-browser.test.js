const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

function fixture() {
  const ids = ['a', 'b'];
  return {
    accounts: ids.map((id) => ({ id, enabled: true })),
    records: ids.flatMap((accountId) => Array.from({ length: 46 }, (_, index) => ({
      accountId, postId: `${accountId}-${index}`, title: `common thread ${accountId} ${index}`,
      url: `https://www.zfrontier.com/app/flow/${accountId}-${index}`,
      drawAt: index === 44 ? '2000-01-01 12:00' : index === 45 ? '' : `2099-01-${String(index % 28 + 1).padStart(2, '0')} 12:00`,
      engagedAt: `2026-09-${String(index % 28 + 1).padStart(2, '0')}T00:00:00Z`,
      dailyEngagementCount: 1, lastEngagedDate: '2026-09-01',
    }))),
    signIns: ids.flatMap((accountId) => Array.from({ length: 25 }, (_, index) => ({
      accountId, signInDate: `2026-09-${String(index + 1).padStart(2, '0')}`,
      signedAt: '2026-09-01T00:00:00Z', status: 'signed', message: 'common sign-in',
    }))),
    messages: ids.flatMap((accountId) => Array.from({ length: 44 }, (_, index) => ({
      accountId, messageId: `${accountId}-${index}`, sender: `Sender ${accountId} ${index}`,
      preview: 'common 中文 + & update', unreadCount: index % 2, sentAt: '2026/9/1 09:00',
      url: `https://www.zfrontier.com/my/mail/thread/${accountId}-${index}`,
    }))),
    messageSync: ids.map((accountId) => ({ accountId, fetchedAt: '2026-09-01T00:00:00Z', error: '' })),
    generatedAt: '2026-10-03T00:00:00Z', isSnapshot: false,
  };
}

async function openReport(t, target = '/#activity', data = fixture()) {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  context.setDefaultTimeout(10_000);
  await context.route('https://filters.test/**', (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/dashboard') return route.fulfill({ json: data });
    const file = pathname.startsWith('/assets/') ? pathname.slice(1) : 'index.html';
    const contentType = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
    return route.fulfill({ body: fs.readFileSync(path.join(__dirname, '../dist', file)), contentType });
  });
  const page = await context.newPage();
  await page.goto('https://filters.test' + target);
  await page.getByRole('navigation', { name: 'Primary', exact: true }).waitFor();
  return { page, context, data };
}

const params = (page) => new URL(page.url()).searchParams;
const accountButton = (page) => page.getByRole('button', { name: 'Account' });
const conversations = (page) => page.getByRole('list', { name: 'Private messages', exact: true });

async function selectAccount(page, account) {
  await accountButton(page).click();
  await page.getByRole('option', { name: account, exact: true }).click();
}

async function toggle(page, label) {
  await page.getByRole('switch', { name: label, exact: true }).focus();
  await page.keyboard.press('Space');
}

async function navigate(page, name) {
  await page.getByRole('navigation', { name: 'Primary', exact: true })
    .getByRole('link', { name: new RegExp(`^${name}\\b`) }).click();
  await page.getByRole('heading', { name: name === 'Messages' ? 'Private messages' : name, exact: true }).waitFor();
}

test('activity deep links restore filters, sorting, both pages, and the selected tab after reload or sharing', async (t) => {
  const target = '/?account=a&activitySearch=common&includeDrawn=1&includeUnknown=1&sort=drawAt&direction=ascending&activityTab=sign-ins&lotteryPage=2&signInPage=2#activity';
  const { page, context } = await openReport(t, target);
  for (const current of [page, await context.newPage()]) {
    if (current !== page) await current.goto(page.url());
    await current.getByRole('grid', { name: 'Daily sign-ins', exact: true }).waitFor();
    assert.equal(await current.getByRole('textbox', { name: 'Search activity' }).inputValue(), 'common');
    assert.match(await accountButton(current).innerText(), /^a\b/);
    assert.equal(await current.getByRole('switch', { name: 'Include drawn' }).isChecked(), true);
    assert.equal(await current.getByRole('switch', { name: 'Unknown draw times' }).isChecked(), true);
    assert.equal(await current.getByRole('tab', { name: /Daily sign-ins/ }).getAttribute('aria-selected'), 'true');
    await current.getByText('Page 2 of 2', { exact: true }).waitFor();
    assert.deepEqual(await current.getByRole('grid').locator('[data-kind="account"]').allTextContents(), Array(5).fill('a'));
  }
  await page.reload();
  await page.getByText('Page 2 of 2', { exact: true }).waitFor();
  await page.getByRole('tab', { name: /Lottery threads/ }).click();
  await page.getByText('Page 2 of 3', { exact: true }).waitFor();
  assert.equal(await page.getByRole('columnheader', { name: /Draw time/ }).getAttribute('aria-sort'), 'ascending');
  assert.equal(params(page).has('activityTab'), false);
  assert.equal(params(page).get('signInPage'), '2');
});

test('account selection is shared across pages while page-specific filters survive navigation and reset', async (t) => {
  const { page } = await openReport(t);
  await selectAccount(page, 'a');
  await page.getByRole('textbox', { name: 'Search activity' }).fill('common');
  await toggle(page, 'Unknown draw times');
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  assert.equal(params(page).get('lotteryPage'), '2');
  await navigate(page, 'Messages');
  assert.match(await accountButton(page).innerText(), /^a\b/);
  assert.deepEqual(await conversations(page).locator('[data-kind="account"]').allTextContents(), Array(20).fill('a'));
  assert.deepEqual(await page.getByRole('list', { name: 'Inbox status' }).locator('[data-kind="account"]').allTextContents(), ['a']);
  await page.getByRole('textbox', { name: 'Search messages' }).fill('common');
  await toggle(page, 'Unread only');
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  assert.equal(params(page).get('messagesPage'), '2');
  await selectAccount(page, 'b');
  assert.equal(params(page).get('account'), 'b');
  assert.equal(params(page).has('messagesPage'), false);
  assert.equal(params(page).has('lotteryPage'), false);
  await navigate(page, 'Activity');
  assert.match(await accountButton(page).innerText(), /^b\b/);
  assert.equal(await page.getByRole('textbox', { name: 'Search activity' }).inputValue(), 'common');
  assert.equal(await page.getByRole('switch', { name: 'Unknown draw times' }).isChecked(), true);
  assert.deepEqual(await page.getByRole('grid').locator('[data-kind="account"]').allTextContents(), Array(20).fill('b'));
  assert.equal(await page.locator('dl').getByText('46', { exact: true }).count(), 1);
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  assert.equal(params(page).has('account'), false);
  assert.equal(params(page).has('activitySearch'), false);
  assert.equal(params(page).has('includeUnknown'), false);
  assert.equal(params(page).get('messagesSearch'), 'common');
  assert.equal(params(page).get('unreadOnly'), '1');
  await navigate(page, 'Messages');
  assert.match(await accountButton(page).innerText(), /All accounts/);
  assert.equal(await page.getByRole('switch', { name: 'Unread only' }).isChecked(), true);
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  assert.equal(new URL(page.url()).search, '');
});

test('browser back and forward restore account and page filter selections', async (t) => {
  const { page } = await openReport(t);
  await selectAccount(page, 'a');
  await toggle(page, 'Unknown draw times');
  await navigate(page, 'Messages');
  await toggle(page, 'Unread only');
  await page.goBack();
  assert.equal(await page.getByRole('switch', { name: 'Unread only' }).isChecked(), false);
  assert.match(await accountButton(page).innerText(), /^a\b/);
  await page.goBack();
  await page.getByRole('heading', { name: 'Activity', exact: true }).waitFor();
  assert.equal(await page.getByRole('switch', { name: 'Unknown draw times' }).isChecked(), true);
  await page.goBack();
  assert.equal(await page.getByRole('switch', { name: 'Unknown draw times' }).isChecked(), false);
  await page.goBack();
  assert.match(await accountButton(page).innerText(), /All accounts/);
  await page.goForward();
  assert.match(await accountButton(page).innerText(), /^a\b/);
});

test('message filters and pagination round-trip through the URL with special characters and unrelated parameters', async (t) => {
  const { page, context } = await openReport(t, '/?source=bookmark#messages');
  await selectAccount(page, 'b');
  const search = page.getByRole('textbox', { name: 'Search messages' });
  const historyLength = await page.evaluate(() => history.length);
  await search.pressSequentially('中文 + &');
  assert.equal(params(page).get('messagesSearch'), '中文 + &');
  assert.equal(await page.evaluate(() => history.length), historyLength, 'typing must not add a history entry per character');
  await toggle(page, 'Unread only');
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  assert.equal(params(page).get('messagesPage'), '2');
  const copy = await context.newPage();
  await copy.goto(page.url());
  await copy.getByText('Page 2 of 2', { exact: true }).waitFor();
  assert.equal(await copy.getByRole('textbox', { name: 'Search messages' }).inputValue(), '中文 + &');
  assert.equal(await copy.getByRole('switch', { name: 'Unread only' }).isChecked(), true);
  assert.equal(await conversations(copy).locator('li').count(), 2);
  await page.reload();
  await page.getByText('Page 2 of 2', { exact: true }).waitFor();
  await search.fill('Sender b 1');
  assert.equal(params(page).has('messagesPage'), false);
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  assert.equal(new URL(page.url()).search, '?source=bookmark');
});

test('activity sorting and draw switches update the URL and reset lottery pagination', async (t) => {
  const { page } = await openReport(t, '/?lotteryPage=2#activity');
  await page.getByText('Page 2 of 5', { exact: true }).waitFor();
  await page.getByRole('columnheader', { name: /Draw time/ }).click();
  assert.equal(params(page).get('sort'), 'drawAt');
  assert.equal(params(page).get('direction'), 'ascending');
  assert.equal(params(page).has('lotteryPage'), false);
  await page.getByRole('columnheader', { name: /Draw time/ }).click();
  assert.equal(params(page).has('direction'), false);
  await toggle(page, 'Include drawn');
  assert.equal(params(page).get('includeDrawn'), '1');
  await toggle(page, 'Unknown draw times');
  assert.equal(params(page).get('includeUnknown'), '1');
  await page.getByRole('tab', { name: /Daily sign-ins/ }).click();
  assert.equal(params(page).get('activityTab'), 'sign-ins');
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  assert.equal(params(page).get('signInPage'), '2');
  await page.getByRole('textbox', { name: 'Search activity' }).fill('signed');
  assert.equal(params(page).has('signInPage'), false);
});

test('invalid URL values fall back safely and pages beyond the available results are clamped', async (t) => {
  const { page } = await openReport(t, '/?source=bookmark&lotteryPage=-2&signInPage=1.5&sort=invalid&direction=sideways&activityTab=missing&includeDrawn=garbage#activity');
  await page.getByRole('grid', { name: 'Lottery threads', exact: true }).waitFor();
  await page.getByText('Page 1 of 5', { exact: true }).waitFor();
  assert.equal(await page.getByRole('switch', { name: 'Include drawn' }).isChecked(), false);
  assert.equal(await page.getByRole('columnheader', { name: /Last engaged/ }).getAttribute('aria-sort'), 'descending');
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  assert.equal(new URL(page.url()).search, '?source=bookmark');
  await page.goto('https://filters.test/?account=a&messagesPage=999#messages');
  await page.getByText('Page 3 of 3', { exact: true }).waitFor();
  assert.equal(params(page).get('messagesPage'), '3');
  assert.equal(await conversations(page).locator('li').count(), 4);
  await page.goto('https://filters.test/?messagesPage=9007199254740992#messages');
  await page.getByText('Page 1 of 5', { exact: true }).waitFor();
});

test('the shared account selector includes historical accounts from either page', async (t) => {
  const data = fixture();
  data.messages.push({ ...data.messages[0], accountId: 'message-only', messageId: 'historical' });
  data.records.push({ ...data.records[0], accountId: 'activity-only', postId: 'historical' });
  const { page } = await openReport(t, '/#activity', data);
  await selectAccount(page, 'message-only');
  await page.getByRole('heading', { name: 'No matching lottery threads' }).waitFor();
  await navigate(page, 'Messages');
  assert.equal(await conversations(page).locator('li').count(), 1);
  await selectAccount(page, 'activity-only');
  await navigate(page, 'Activity');
  assert.equal(await page.getByRole('grid').locator('[data-kind="account"]').count(), 1);
  await page.goto('https://filters.test/?account=removed#messages');
  await page.getByRole('heading', { name: 'No private messages yet', exact: true }).waitFor();
  assert.match(await accountButton(page).innerText(), /removed/);
  assert.equal(await conversations(page).count(), 0);
});

test('saved HTML snapshots keep URL filters and the shared account when opened locally', async (t) => {
  const { openEngagedStore, replacePrivateMessages, renderEngagementHtml } = require('../engaged-store');
  const root = path.resolve(__dirname, '../target');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'url-filter-snapshot-'));
  const file = path.join(dir, 'report.html');
  t.after(() => {
    assert.ok(path.resolve(dir).startsWith(root + path.sep));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const store = openEngagedStore(path.join(dir, 'data.sqlite'), file);
  try {
    const data = fixture();
    for (const id of ['a', 'b']) {
      replacePrivateMessages(store, id, data.messages.filter((message) => message.accountId === id));
    }
    renderEngagementHtml(store);
  } finally {
    store.db.close();
  }
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(file).href + '#activity');
    await selectAccount(page, 'a');
    assert.equal(params(page).get('account'), 'a');
    await navigate(page, 'Messages');
    await page.getByRole('textbox', { name: 'Search messages' }).fill('中文 + &');
    await toggle(page, 'Unread only');
    await page.reload();
    await page.getByText('Page 1 of 2', { exact: true }).waitFor();
    assert.match(await accountButton(page).innerText(), /^a\b/);
    assert.equal(await page.getByRole('textbox', { name: 'Search messages' }).inputValue(), '中文 + &');
    assert.equal(await page.getByRole('switch', { name: 'Unread only' }).isChecked(), true);
  } finally {
    await browser.close();
  }
});
