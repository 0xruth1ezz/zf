const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { readMessageList } = require('../private-messages');

async function openMessages(page, data) {
  await page.route('https://zf.test/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/dashboard') {
      return route.fulfill({ json: { records: [], signIns: [], generatedAt: '2026-09-15T00:00:00Z', ...data } });
    }
    const file = pathname === '/' ? 'index.html' : pathname.slice(1);
    const contentType = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
    return route.fulfill({ body: fs.readFileSync(path.join(__dirname, '../dist', file)), contentType });
  });
  await page.goto('https://zf.test/#messages');
  await page.getByRole('heading', { name: 'Private messages', exact: true }).waitFor();
}

test('message account switcher includes pending accounts, filters previews and status, and resets pagination', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await openMessages(page, {
    messages: Array.from({ length: 42 }, (_, index) => ({
      messageId: String(index), accountId: index < 21 ? '150' : '191', sender: `Sender ${index}`,
      preview: `Latest message ${index}`, unreadCount: 0, sentAt: '2026/9/15 9:29',
      url: `https://www.zfrontier.com/my/mail/thread/${index}`,
    })),
    accounts: [{ id: '150', enabled: true }, { id: '191', enabled: true }, { id: 'empty', enabled: true }],
    messageSync: [{ accountId: '150', fetchedAt: '', error: 'Login failed' }],
  });
  await page.getByText('Waiting for first fetch', { exact: true }).first().waitFor();
  const content = await page.locator('main').innerText();
  assert.match(content, /150/);
  assert.match(content, /191/);
  assert.match(content, /Fetch failed/);
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByRole('option', { name: '191', exact: true }).click();
  await page.getByText('Page 1 of 2', { exact: true }).waitFor();
  const list = page.getByRole('list', { name: 'Private messages', exact: true });
  assert.equal(await list.locator('li').count(), 20);
  assert.match(await list.innerText(), /Latest message 21/);
  assert.doesNotMatch(await list.innerText(), /Latest message 0\b/);
  assert.equal(await page.getByText('Fetch failed. Retrying on the next check.', { exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByRole('option', { name: 'empty', exact: true }).click();
  await page.getByRole('heading', { name: 'Waiting for the first message fetch', exact: true }).waitFor();
  assert.equal(await list.count(), 0);
  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByRole('option', { name: 'All accounts', exact: true }).click();
  await page.getByText('Page 1 of 3', { exact: true }).waitFor();
  await page.getByRole('listbox').waitFor({ state: 'hidden' });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.setViewportSize({ width: 1440, height: 1000 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
});

test('message search and unread filters compose with account selection and reset pagination', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await openMessages(page, {
    accounts: [{ id: '150', enabled: true }, { id: '191', enabled: true }],
    messageSync: [{ accountId: '150', fetchedAt: '2026-09-15T00:00:00Z', error: 'Login failed' }],
    messages: Array.from({ length: 42 }, (_, index) => ({
      messageId: String(index), accountId: index < 21 ? '150' : '191', sender: `Sender ${index}`,
      preview: index % 2 ? 'Your giveaway entry is confirmed' : 'Community update',
      unreadCount: index % 2 ? 2 : 0, sentAt: '2026/9/15 9:29',
      url: `https://www.zfrontier.com/my/mail/thread/${index}`,
    })),
  });
  const list = page.getByRole('list', { name: 'Private messages', exact: true });
  const search = page.getByRole('textbox', { name: 'Search messages' });
  const unread = page.getByRole('switch', { name: 'Unread only' });
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await search.fill('  GIVEAWAY  ');
  await page.getByText('Page 1 of 2', { exact: true }).waitFor();
  assert.match(await list.innerText(), /Sender 1\b/);
  assert.doesNotMatch(await list.innerText(), /Community update/);
  await search.fill('');
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await unread.focus();
  await page.keyboard.press('Space');
  assert.equal(await unread.isChecked(), true);
  await page.getByText('Page 1 of 2', { exact: true }).waitFor();
  assert.equal(await list.locator('li').count(), 20);
  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByRole('option', { name: '191', exact: true }).click();
  assert.equal(await list.locator('li').count(), 11);
  assert.equal(await page.getByRole('navigation', { name: 'Private messages pagination' }).count(), 0);
  await search.fill('sender 21');
  assert.equal(await list.locator('li').count(), 1);
  assert.equal(await list.getByRole('link').getAttribute('href'), 'https://www.zfrontier.com/my/mail/thread/21');
  assert.equal(await list.getByRole('link').getAttribute('target'), '_blank');
  await search.fill('sender 22');
  await page.getByRole('heading', { name: 'No matching conversations' }).waitFor();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await page.getByText('Page 1 of 3', { exact: true }).waitFor();
  assert.equal(await search.inputValue(), '');
  assert.equal(await unread.isChecked(), false);
  assert.match(await list.innerText(), /Sender 0\b/);
  await page.getByText('1 account needs attention', { exact: true }).waitFor();
});

test('inbox extraction preserves unread counts and only accepts ZF thread links', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <ul>
      <li><a href="/my/mail/thread/123?from=inbox">
        <span class="username">Alice</span><span class="content">Hello &amp; welcome</span>
        <span class="unread-count">3</span><time datetime="2026-09-15T00:00:00Z">Today</time>
      </a></li>
      <li class="unread"><a href="/my/mail/thread/456"><span class="sender">Bob</span>New message</a></li>
      <li><a href="/my/mail/thread/789"><span class="sender">Carol</span>Read message</a></li>
      <li><a href="https://example.com/my/mail/thread/evil">Untrusted destination</a></li>
    </ul><nav class="pagination"><a rel="next" href="?page=2">Next</a></nav>
  `);
  const result = await page.evaluate(readMessageList);
  assert.deepEqual(result.messages.map((row) => [row.sender, row.unreadCount]), [['Alice', 3], ['Bob', 1], ['Carol', 0]]);
  assert.equal(result.messages[0].preview, 'Hello & welcome');
  assert.equal(result.messages[0].sentAt, '2026-09-15T00:00:00Z');
  assert.equal(result.messages[0].url, 'https://www.zfrontier.com/my/mail/thread/123');
  assert.equal(result.next, '?page=2');
});

test('ZF inbox preview excludes sender, verification badge and action links after browser HTML repair', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <ul class="mail-user-list">
      <a href="/my/mail/thread/123"><li class="clearfix unread">
        <img class="avatar" alt="Avatar">
        <div class="text-part">
          <div class="row1"><span class="nickname">Alice</span>
            <a class="user-verify-badge">Verified</a>: Latest message with <a href="/app/flow/example">a linked post</a> &amp; details.
          </div>
          <div class="row2">2026/9/15 9:29
            <a class="text-bt bt-del-chat">Delete</a><a class="text-bt" href="/my/mail/thread/123">View</a>
          </div>
        </div>
      </li></a>
    </ul>
  `);
  const { messages } = await page.evaluate(readMessageList);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].sender, 'Alice');
  assert.equal(messages[0].preview, 'Latest message with a linked post & details.');
  assert.equal(messages[0].sentAt, '2026/9/15 9:29');
  assert.equal(messages[0].unreadCount, 1);
});
