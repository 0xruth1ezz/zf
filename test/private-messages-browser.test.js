const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { readMessageList, fetchPrivateMessages } = require('../private-messages');
const { openEngagedStore, saveMessageSyncError, listMessageSync } = require('../engaged-store');

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
  await page.getByText('First check pending', { exact: true }).first().waitFor();
  const content = await page.locator('main').innerText();
  assert.match(content, /150/);
  assert.match(content, /191/);
  assert.match(content, /Could not check inbox/);
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByRole('option', { name: '191', exact: true }).click();
  await page.getByText('Page 1 of 2', { exact: true }).waitFor();
  const list = page.getByRole('list', { name: 'Private messages', exact: true });
  assert.equal(await list.locator('li').count(), 20);
  assert.match(await list.innerText(), /Latest message 21/);
  assert.doesNotMatch(await list.innerText(), /Latest message 0\b/);
  assert.equal(await page.getByText('Could not check inbox. Will retry automatically.', { exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByRole('option', { name: 'empty', exact: true }).click();
  await page.getByRole('heading', { name: 'Waiting for inbox checks', exact: true }).waitFor();
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
  await page.getByText('1 inbox could not be checked', { exact: true }).waitFor();
});

test('ZF empty inbox completes the fetch and clears the previous error', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-empty-inbox-'));
  const store = openEngagedStore(path.join(dir, 'test.sqlite'), path.join(dir, 'report.html'));
  t.after(() => { store.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  saveMessageSyncError(store, '189', 'Could not fetch private messages.');
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const visited = [];
  await page.route('https://www.zfrontier.com/**', async (route) => {
    visited.push(new URL(route.request().url()).pathname);
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `
      <h1>私信列表</h1><ul class="mail-user-list">
        <div class="post-list empty">&lt;(▰˘◡˘▰)&gt; 长官，您没有新私信</div>
      </ul>` });
  });
  assert.equal(await fetchPrivateMessages(page, store, '189'), 0);
  assert.deepEqual(visited, ['/my/mail/list']);
  const [status] = listMessageSync(store);
  assert.ok(status.fetchedAt);
  assert.equal(status.error, '');

  await openMessages(page, { accounts: [{ id: '189', enabled: true }], messages: [], messageSync: [status] });
  await page.getByRole('heading', { name: 'No private messages yet', exact: true }).waitFor();
  const sync = page.getByRole('list', { name: 'Inbox status', exact: true });
  assert.match(await sync.innerText(), /Last checked:/);
  assert.match(await sync.innerText(), /No private messages yet/);
  assert.doesNotMatch(await page.locator('main').innerText(), /could not|failed|pending|No successful check/i);
});

test('a failed inbox remains distinguishable from a successfully checked empty inbox', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await openMessages(page, { accounts: [{ id: 'empty', enabled: true }, { id: 'failed', enabled: true }], messages: [],
    messageSync: [{ accountId: 'empty', fetchedAt: '2026-09-20T03:00:00Z', error: '' },
      { accountId: 'failed', fetchedAt: '', error: 'Network unavailable' }] });
  await page.getByRole('heading', { name: 'Some inboxes could not be checked', exact: true }).waitFor();
  const sync = page.getByRole('list', { name: 'Inbox status', exact: true });
  assert.match(await sync.locator('li').filter({ has: page.getByText('empty', { exact: true }) }).innerText(), /No private messages yet/);
  assert.match(await sync.locator('li').filter({ has: page.getByText('failed', { exact: true }) }).innerText(), /Could not check inbox/);
});

test('account colors stay distinct and readable across filters, pages, and newly added accounts', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const data = {
    accounts: ['191', '150', '189', 'ab', 'ba', 'account-with-a-long-name'].map((id, index) => ({
      id, enabled: true, createdAt: `2026-09-${String(index + 1).padStart(2, '0')}T00:00:00Z`,
    })),
    messages: [{ accountId: '189', messageId: '1', sender: 'Sender', preview: 'Preview', unreadCount: 0,
      url: 'https://www.zfrontier.com/my/mail/thread/1' }],
    messageSync: [],
  };
  data.messageSync = data.accounts.map(({ id }) => ({ accountId: id, fetchedAt: '2026-09-20T00:00:00Z', error: '' }));
  await openMessages(page, data);
  const colors = () => page.locator('[data-kind="account"]').evaluateAll((badges) => Object.fromEntries(
    badges.map((badge) => [badge.textContent, getComputedStyle(badge).backgroundColor])));
  const initial = await colors();
  assert.equal(new Set(Object.values(initial)).size, data.accounts.length);
  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByRole('option', { name: '189', exact: true }).click();
  assert.equal((await colors())['189'], initial['189']);
  assert.match(await page.getByRole('list', { name: 'Inbox status', exact: true }).innerText(), /1 conversation/);
  await page.getByRole('link', { name: 'Accounts', exact: true }).click();
  await page.getByRole('heading', { name: 'Accounts', exact: true }).waitFor();
  assert.deepEqual(await colors(), initial);
  data.accounts.push({ id: '001', enabled: true, createdAt: '2026-09-21T00:00:00Z' });
  await page.reload();
  await page.getByText('001', { exact: true }).waitFor();
  const afterAdding = await colors();
  for (const [id, color] of Object.entries(initial)) assert.equal(afterAdding[id], color);
  assert.equal(new Set(Object.values(afterAdding)).size, data.accounts.length);

  for (const dark of [false, true]) {
    await page.evaluate((enabled) => document.documentElement.classList.toggle('dark', enabled), dark);
    const contrast = await page.locator('[data-kind="account"]').evaluateAll((badges) => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      const luminance = (color) => {
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        const rgb = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map((value) => {
          const channel = value / 255;
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
        return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
      };
      return badges.map((badge) => {
        const style = getComputedStyle(badge);
        const foreground = luminance(style.color);
        const background = luminance(style.backgroundColor);
        return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
      });
    });
    assert.ok(contrast.every((ratio) => ratio >= 4.5), `${dark ? 'dark' : 'light'} contrast: ${contrast}`);
  }
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
