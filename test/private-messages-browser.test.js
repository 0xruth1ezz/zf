const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { readMessageList } = require('../private-messages');

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
