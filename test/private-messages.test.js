const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  openEngagedStore, replacePrivateMessages, listPrivateMessages, listMessageSync, saveMessageSyncError, initializeMessageSync,
} = require('../engaged-store');
const { fetchPrivateMessages, MESSAGE_LIST_URL } = require('../private-messages');

function createStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-messages-'));
  const store = openEngagedStore(path.join(dir, 'test.sqlite'), path.join(dir, 'report.html'));
  t.after(() => { store.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return store;
}

function message(id, unreadCount = 1) {
  return { messageId: id, sender: 'Sender', preview: 'Message preview', sentAt: '2026-09-15',
    url: `https://www.zfrontier.com/my/mail/thread/${id}`, unreadCount };
}

test('all accounts have a status before fetching, without overwriting earlier results', (t) => {
  const store = createStore(t);
  replacePrivateMessages(store, 'existing', [message('1')], '2026-09-15T00:00:00Z');
  saveMessageSyncError(store, 'failed', 'Login expired');
  initializeMessageSync(store, ['existing', 'failed', 'pending']);
  initializeMessageSync(store, ['existing', 'failed', 'pending']);
  assert.deepEqual(listMessageSync(store).map((row) => ({ ...row })), [
    { accountId: 'existing', fetchedAt: '2026-09-15T00:00:00Z', error: '' },
    { accountId: 'failed', fetchedAt: '', error: 'Login expired' },
    { accountId: 'pending', fetchedAt: '', error: '' },
  ]);
});

test('refresh replaces only the account inbox, reconciles unread state, and clears old errors', (t) => {
  const store = createStore(t);
  replacePrivateMessages(store, 'a', [message('1', 3), message('2')]);
  replacePrivateMessages(store, 'b', [message('1', 2)]);
  saveMessageSyncError(store, 'a', 'Login expired');
  replacePrivateMessages(store, 'a', [message('1', 0)], '2026-09-15T01:00:00Z');
  assert.deepEqual(listPrivateMessages(store).map((row) => [row.accountId, row.messageId, row.unreadCount]),
    [['a', '1', 0], ['b', '1', 2]]);
  assert.deepEqual({ ...listMessageSync(store)[0] }, { accountId: 'a', fetchedAt: '2026-09-15T01:00:00Z', error: '' });
});

test('failed refresh preserves the last inbox and successful fetch timestamp', (t) => {
  const store = createStore(t);
  replacePrivateMessages(store, 'a', [message('1')], '2026-09-15T00:00:00Z');
  assert.throws(() => replacePrivateMessages(store, 'a', [message('2'), message('2')]));
  saveMessageSyncError(store, 'a', 'Unavailable');
  assert.equal(listPrivateMessages(store)[0].messageId, '1');
  assert.equal(listMessageSync(store)[0].fetchedAt, '2026-09-15T00:00:00Z');
  assert.equal(listMessageSync(store)[0].error, 'Unavailable');
});

test('fetch follows inbox pagination without opening threads and commits only a complete list', async (t) => {
  const store = createStore(t);
  const visited = [];
  const page = {
    goto: async (url) => { visited.push(url); },
    url: () => visited.at(-1),
    waitForFunction: async () => {},
    evaluate: async () => visited.length === 1
      ? { messages: [message('1')], next: '?page=2' }
      : { messages: [message('2', 0)], next: '' },
  };
  assert.equal(await fetchPrivateMessages(page, store, 'a'), 2);
  assert.deepEqual(visited, [MESSAGE_LIST_URL, `${MESSAGE_LIST_URL}?page=2`]);
  assert.equal(listPrivateMessages(store).length, 2);
  page.evaluate = async () => ({ messages: [message('3')], next: '/my/mail/thread/3' });
  await assert.rejects(fetchPrivateMessages(page, store, 'a'), /pagination link/);
  assert.deepEqual(listPrivateMessages(store).map((row) => row.messageId), ['1', '2']);
});

test('redirects and unrecognized inboxes retain data; a confirmed empty inbox clears it', async (t) => {
  const store = createStore(t);
  replacePrivateMessages(store, 'a', [message('1')]);
  const page = { goto: async () => {}, url: () => 'https://www.zfrontier.com/app/login',
    waitForFunction: async () => {}, evaluate: async () => ({ messages: [], empty: false }) };
  await assert.rejects(fetchPrivateMessages(page, store, 'a'), /signed-in/);
  page.url = () => MESSAGE_LIST_URL;
  await assert.rejects(fetchPrivateMessages(page, store, 'a'), /recognized/);
  assert.equal(listPrivateMessages(store).length, 1);
  page.evaluate = async () => ({ messages: [], empty: true });
  await fetchPrivateMessages(page, store, 'a');
  assert.equal(listPrivateMessages(store).length, 0);
});

const { fetchPrivateMessagesHttp, readMessageHtml } = require('../private-messages');
const htmlMessage = (id, unread = 0) => `<ul><li><a href="/my/mail/thread/${id}"><span class="nickname">Sender</span><span class="content">Message preview</span><span data-unread-count="${unread}"></span></a></li></ul>`;

test('HTTP inbox pagination preserves unread state and commits only after every page succeeds', async (t) => {
  const store = createStore(t);
  const visited = [];
  const client = { html: async (url) => {
    visited.push(url);
    return url.includes('page=2') ? htmlMessage('2') : htmlMessage('1', 3) + '<a rel="next" href="?page=2">Next</a>';
  } };
  assert.equal(await fetchPrivateMessagesHttp(client, store, 'a'), 2);
  assert.deepEqual(visited, [MESSAGE_LIST_URL, `${MESSAGE_LIST_URL}?page=2`]);
  assert.deepEqual(listPrivateMessages(store).map((m) => [m.messageId, m.unreadCount]), [['1', 3], ['2', 0]]);
  client.html = async (url) => {
    if (url.includes('page=2')) throw new Error('network failed');
    return htmlMessage('3') + '<a rel="next" href="?page=2">Next</a>';
  };
  await assert.rejects(fetchPrivateMessagesHttp(client, store, 'a'), /network failed/);
  assert.deepEqual(listPrivateMessages(store).map((m) => m.messageId), ['1', '2']);
  for (const next of ['/my/mail/thread/3', 'https://other.test/my/mail/list', MESSAGE_LIST_URL]) {
    client.html = async () => htmlMessage('3') + `<a rel="next" href="${next}">Next</a>`;
    await assert.rejects(fetchPrivateMessagesHttp(client, store, 'a'), /pagination/);
  }
  client.html = async () => '<body>Please log in</body>';
  await assert.rejects(fetchPrivateMessagesHttp(client, store, 'a'), /recognized/);
  assert.equal(listPrivateMessages(store).length, 2);
  client.html = async () => '<body>长官，您没有新私信</body>';
  await fetchPrivateMessagesHttp(client, store, 'a');
  assert.equal(listPrivateMessages(store).length, 0);
});

test('HTTP HTML parsing repairs nested links and excludes preview actions and external threads', () => {
  const result = readMessageHtml(`<ul><a href="/my/mail/thread/123"><li class="unread"><div class="text-part">
    <div class="row1"><span class="nickname">Alice</span><a class="user-verify-badge">Verified</a>: Message with <a href="/post">a link</a> &amp; details</div>
    <div class="row2">2026/9/15 9:29<a class="text-bt">Delete</a><a class="text-bt" href="/my/mail/thread/123">View</a></div>
    </div></li></a><li><a href="https://other.test/my/mail/thread/456">External</a></li></ul>`);
  assert.deepEqual(result.messages, [{ messageId: '123', sender: 'Alice', preview: 'Message with a link & details',
    sentAt: '2026/9/15 9:29', unreadCount: 1, url: 'https://www.zfrontier.com/my/mail/thread/123' }]);
});
