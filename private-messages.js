const { replacePrivateMessages } = require('./engaged-store');

const MESSAGE_LIST_URL = 'https://www.zfrontier.com/my/mail/list';

// Read only the inbox. Visiting a thread can mark its messages as read on ZF.
function readMessageList(document = globalThis.document) {
  const compact = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const links = [...document.querySelectorAll('a[href*="/my/mail/thread/"]')];
  const messages = new Map();
  for (const link of links) {
    const url = new URL(link.getAttribute('href'), 'https://www.zfrontier.com');
    const match = url.pathname.match(/^\/(?:app\/)?my\/mail\/thread\/([A-Za-z0-9_-]+)\/?$/);
    if (url.origin !== 'https://www.zfrontier.com' || !match) continue;
    const row = link.closest('li, tr, .mail-item, .message-item, .mail-thread') || link;
    const sender = compact(row.querySelector('.nickname, .user-name, .username, .sender')?.textContent
      || row.querySelector('a[href*="/user/"]')?.textContent
      || row.querySelector('img[alt]')?.getAttribute('alt'));
    const preview = compact(row.querySelector('.mail-content, .message-content, .content, .summary')?.textContent
      || link.textContent);
    const unread = row.querySelector('[data-unread-count], .unread-count, .badge, .red-dot, .unread')
      || (row.matches('.unread, [data-unread="1"], [data-unread="true"]') ? row : null);
    const countText = unread?.getAttribute('data-unread-count') ?? unread?.textContent;
    const count = Number(compact(countText));
    const unreadCount = unread ? (Number.isSafeInteger(count) && count >= 0 && compact(countText) !== '' ? count : 1) : 0;
    const time = row.querySelector('time, .time, .date, .created-at');
    url.hash = '';
    url.search = '';
    messages.set(match[1], {
      messageId: match[1],
      sender: sender || `User ${match[1]}`,
      preview,
      url: url.href,
      sentAt: compact(time?.getAttribute('datetime') || time?.textContent),
      unreadCount,
    });
  }
  const body = compact(document.body?.textContent);
  const empty = /暂无私信|暂无消息|没有私信|还没有.*私信|No (?:private )?messages/i.test(body);
  const next = [...document.querySelectorAll('a[rel="next"], .pagination a, .pager a')]
    .find((link) => link.rel === 'next' || /^(下一页|下页|Next|›|»)$/i.test(compact(link.textContent)));
  return { messages: [...messages.values()], empty, next: next?.getAttribute('href') || '' };
}

async function fetchPrivateMessages(page, store, accountId) {
  const messages = new Map();
  const visited = new Set();
  let url = MESSAGE_LIST_URL;
  while (url) {
    if (visited.has(url) || visited.size >= 100) throw new Error('Private message pagination did not finish.');
    visited.add(url);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (!/^\/my\/mail\/list\/?$/.test(new URL(page.url()).pathname)) {
      throw new Error('ZF private messages require a signed-in session.');
    }
    await page.waitForFunction(() => {
      const text = document.body?.textContent || '';
      return document.querySelector('a[href*="/my/mail/thread/"]')
        || /暂无私信|暂无消息|没有私信|还没有.*私信|No (?:private )?messages/i.test(text);
    }, null, { timeout: 30000 });
    const result = await page.evaluate(readMessageList);
    if (!result.messages.length && !result.empty) throw new Error('ZF private message list could not be recognized.');
    result.messages.forEach((message) => messages.set(message.messageId, message));
    url = '';
    if (result.next && result.next !== '#') {
      const next = new URL(result.next, page.url());
      if (next.origin !== new URL(MESSAGE_LIST_URL).origin || !/^\/my\/mail\/list\/?$/.test(next.pathname)) {
        throw new Error('Unexpected private message pagination link.');
      }
      url = next.href;
    }
  }
  replacePrivateMessages(store, accountId, [...messages.values()]);
  return messages.size;
}

module.exports = { MESSAGE_LIST_URL, readMessageList, fetchPrivateMessages };
