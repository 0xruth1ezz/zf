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
    if (messages.has(match[1])) continue;
    const row = link.closest('li, tr, .mail-item, .message-item, .mail-thread') || link;
    if (row === link && !compact(link.textContent)) continue;
    const sender = compact(row.querySelector('.nickname, .user-name, .username, .sender')?.textContent
      || row.querySelector('a[href*="/user/"]')?.textContent
      || row.querySelector('img[alt]')?.getAttribute('alt'));
    // ZF's nested links are repaired by the browser into several anchors per row.
    const latestMessage = row.querySelector('.text-part .row1')?.cloneNode(true);
    latestMessage?.querySelectorAll('.nickname, .user-verify-badge, .unread-count, .red-dot').forEach((element) => element.remove());
    const preview = latestMessage
      ? compact(latestMessage.textContent).replace(/^[:：]\s*/, '')
      : compact(row.querySelector('.mail-content, .message-content, .content, .summary')?.textContent || link.textContent);
    const unread = row.querySelector('[data-unread-count], .unread-count, .badge, .red-dot, .unread')
      || (row.matches('.unread, [data-unread="1"], [data-unread="true"]') ? row : null);
    const countText = unread?.getAttribute('data-unread-count') ?? unread?.textContent;
    const count = Number(compact(countText));
    const unreadCount = unread ? (Number.isSafeInteger(count) && count >= 0 && compact(countText) !== '' ? count : 1) : 0;
    const time = row.querySelector('time, .time, .date, .created-at');
    const metadata = row.querySelector('.text-part .row2')?.cloneNode(true);
    metadata?.querySelectorAll('.text-bt').forEach((element) => element.remove());
    url.hash = '';
    url.search = '';
    messages.set(match[1], {
      messageId: match[1],
      sender: sender || `User ${match[1]}`,
      preview,
      url: url.href,
      sentAt: compact(time?.getAttribute('datetime') || time?.textContent || metadata?.textContent),
      unreadCount,
    });
  }
  const body = compact(document.body?.textContent);
  const empty = /暂无私信|暂无消息|没有(?:新)?私信|还没有.*私信|No (?:private )?messages/i.test(body);
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
        || /暂无私信|暂无消息|没有(?:新)?私信|还没有.*私信|No (?:private )?messages/i.test(text);
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

function readMessageHtml(html) {
  const $ = require('cheerio').load(html);
  const compact = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const messages = new Map();
  $('a[href*="/my/mail/thread/"]').each((_, element) => {
    const link = $(element);
    const url = new URL(link.attr('href'), MESSAGE_LIST_URL);
    const match = url.pathname.match(/^\/my\/mail\/thread\/([^/]+)\/?$/);
    if (url.origin !== new URL(MESSAGE_LIST_URL).origin || !match) return;
    const closest = link.closest('li, tr, .mail-item, .message-item, .mail-thread');
    const row = closest.length ? closest : link;
    const sender = compact(row.find('.nickname, .user-name, .username, .sender').first().text()
      || row.find('a[href*="/user/"]').first().text() || row.find('img[alt]').first().attr('alt'));
    const latest = row.find('.text-part .row1').first().clone();
    latest.find('.nickname, .user-verify-badge, .unread-count, .red-dot').remove();
    const preview = latest.length ? compact(latest.text()).replace(/^[:：]\s*/, '')
      : compact(row.find('.mail-content, .message-content, .content, .summary').first().text() || link.text());
    let unread = row.find('[data-unread-count], .unread-count, .badge, .red-dot, .unread').first();
    if (!unread.length && row.is('.unread, [data-unread="1"], [data-unread="true"]')) unread = row;
    const countText = compact(unread.attr('data-unread-count') ?? unread.text());
    const count = Number(countText);
    const time = row.find('time, .time, .date, .created-at').first();
    const metadata = row.find('.text-part .row2').first().clone();
    metadata.find('.text-bt').remove();
    url.hash = ''; url.search = '';
    messages.set(match[1], { messageId: match[1], sender: sender || `User ${match[1]}`, preview, url: url.href,
      sentAt: compact(time.attr('datetime') || time.text() || metadata.text()),
      unreadCount: unread.length ? (Number.isSafeInteger(count) && count >= 0 && countText !== '' ? count : 1) : 0 });
  });
  const empty = /暂无私信|暂无消息|没有(?:新)?私信|还没有.*私信|No (?:private )?messages/i.test(compact($('body').text()));
  const next = $('a[rel="next"], .pagination a, .pager a').toArray()
    .find((element) => $(element).attr('rel') === 'next' || /^(下一页|下页|Next|›|»)$/i.test(compact($(element).text())));
  return { messages: [...messages.values()], empty, next: next ? $(next).attr('href') : '' };
}

async function fetchPrivateMessagesHttp(client, store, accountId) {
  const messages = new Map();
  const visited = new Set();
  let url = MESSAGE_LIST_URL;
  while (url) {
    if (visited.has(url) || visited.size >= 100) throw new Error('Private message pagination did not finish.');
    visited.add(url);
    const result = readMessageHtml(await client.html(url));
    if (!result.messages.length && !result.empty) throw new Error('ZF private message list could not be recognized.');
    result.messages.forEach((message) => messages.set(message.messageId, message));
    if (!result.next || result.next === '#') break;
    const next = new URL(result.next, url);
    if (next.origin !== new URL(MESSAGE_LIST_URL).origin || !/^\/my\/mail\/list\/?$/.test(next.pathname)) {
      throw new Error('Unexpected private message pagination link.');
    }
    next.hash = '';
    url = next.href;
  }
  replacePrivateMessages(store, accountId, [...messages.values()]);
  return messages.size;
}
module.exports.readMessageHtml = readMessageHtml;
module.exports.fetchPrivateMessagesHttp = fetchPrivateMessagesHttp;
