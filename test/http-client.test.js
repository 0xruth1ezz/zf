const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { ZfHttpClient } = require('../zfrontier-http');

const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
const success = (data = {}) => json({ ok: 0, data });
function fixture(t, handler = () => success()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-http-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = Date.parse('2026-09-21T02:00:00Z');
  let logins = 0;
  const requests = [];
  const options = { account: { id: 'a', phone: 'test', password: 'secret' }, sessionFile: path.join(dir, 'a.json'),
    now: () => clock, dayKey: (date) => date.toISOString().slice(0, 10),
    login: async () => ({ headers: { 'user-agent': 'Browser UA', 'sec-ch-ua': 'Browser hints', authorization: 'must not copy' },
      cookies: [{ name: 'session', value: `token-${++logins}`, domain: '.zfrontier.com', path: '/', secure: true, expires: -1 }] }),
    fetchImpl: async (url, init) => {
      const request = { url, ...init };
      requests.push(request);
      if (new URL(url).pathname === '/app/') return new Response('csrf_token = "csrf-token";', { headers: { 'set-cookie': 'refreshed=yes; Path=/; Secure' } });
      return handler(request);
    } };
  return { options, client: new ZfHttpClient(options), requests, logins: () => logins,
    advance: (ms) => { clock += ms; } };
}

test('browser cookies survive restarts, Set-Cookie persists, and every form signs the current CSRF token', async (t) => {
  const f = fixture(t);
  await f.client.api('/v2/flow/detail', { id: 'post' });
  const request = f.requests.at(-1);
  assert.equal(request.headers['user-agent'], 'Browser UA');
  assert.equal(request.headers.authorization, undefined);
  assert.match(request.headers.cookie, /session=token-1/);
  assert.match(request.headers.cookie, /refreshed=yes/);
  assert.equal(request.headers.origin, 'https://www.zfrontier.com');
  assert.equal(request.body.get('t'), createHash('md5').update(request.body.get('time') + request.headers['x-csrf-token']).digest('hex'));
  assert.equal(fs.statSync(f.options.sessionFile).mode & 0o777, 0o600);
  const restarted = new ZfHttpClient(f.options);
  await restarted.api('/v2/flow/detail', { id: 'post' });
  assert.equal(f.logins(), 1);
  assert.match(f.requests.at(-1).headers.cookie, /refreshed=yes/);
});

test('concurrent requests share authentication, validate again next day without browser login', async (t) => {
  const f = fixture(t);
  await Promise.all([f.client.api('/first'), f.client.api('/second')]);
  assert.equal(f.logins(), 1);
  assert.equal(f.requests.filter((r) => r.url.endsWith('/app/')).length, 1);
  f.advance(86400000);
  await Promise.all([f.client.api('/third'), f.client.api('/fourth')]);
  assert.equal(f.logins(), 1);
  assert.equal(f.requests.filter((r) => r.url.endsWith('/app/')).length, 2);
});

test('expired authentication recovers once for concurrent requests and does not mix account cookies', async (t) => {
  let expired = false;
  const f = fixture(t, (r) => expired && r.headers.cookie.includes('token-1') ? json({}, 401) : success());
  await f.client.api('/first');
  expired = true;
  await Promise.all([f.client.api('/second'), f.client.api('/third')]);
  assert.equal(f.logins(), 2);
  const other = new ZfHttpClient({ ...f.options, account: { ...f.options.account, id: 'b' }, sessionFile: path.join(path.dirname(f.options.sessionFile), 'b.json') });
  await other.api('/fourth');
  assert.match(f.requests.at(-1).headers.cookie, /token-3/);
  await f.client.api('/fifth');
  assert.match(f.requests.at(-1).headers.cookie, /token-2/);
});

test('changed credentials discard the old jar and force login', async (t) => {
  const f = fixture(t);
  await f.client.api('/first');
  let forced;
  const client = new ZfHttpClient({ ...f.options, account: { ...f.options.account, password: 'changed' },
    login: (account, options) => { forced = options.forceLogin; return f.options.login(account); } });
  await client.api('/second');
  assert.equal(forced, true);
  assert.match(f.requests.at(-1).headers.cookie, /token-2/);
});

test('HTTP 200 rate errors are rejected and block further requests without retrying', async (t) => {
  const f = fixture(t, (r) => r.url.endsWith('/v2/signInfo') ? success() : json({ ok: 20001 }));
  await assert.rejects(f.client.api('/v2/flow/reply'), (error) => error.code === 20001 && error.rejected);
  const count = f.requests.length;
  await assert.rejects(f.client.api('/v2/flow/reply'), /waiting before retrying/);
  assert.equal(f.requests.length, count);
});

test('uncertain POST delivery and redirects are not replayed or forwarded to another origin', async (t) => {
  let action = 'timeout';
  const f = fixture(t, (r) => {
    if (r.url.endsWith('/v2/signInfo')) return success();
    if (action === 'timeout') throw new Error('socket closed after sending');
    return new Response('', { status: 302, headers: { location: 'https://other.test/steal' } });
  });
  await assert.rejects(f.client.api('/v2/flow/reply'), /socket closed/);
  assert.equal(f.requests.filter((r) => r.url.endsWith('/v2/flow/reply')).length, 1);
  action = 'redirect';
  await assert.rejects(f.client.api('/v2/flow/reply'), /Unexpected redirect/);
  assert.equal(f.requests.filter((r) => r.url.endsWith('/v2/flow/reply')).length, 2);
  const count = f.requests.length;
  await assert.rejects(f.client.html('https://other.test/steal'), /outside zFrontier/);
  assert.equal(f.requests.length, count);
  assert.ok(f.requests.every((r) => r.redirect === 'manual'));
});

test('cooldown expiry refreshes CSRF over HTTP before another attempt', async (t) => {
  let reject = true;
  const f = fixture(t, (r) => r.url.endsWith('/v2/signInfo') || !reject ? success() : json({ ok: 20001 }));
  await assert.rejects(f.client.api('/v2/flow/reply'));
  f.advance(15 * 60000);
  reject = false;
  await f.client.api('/v2/flow/reply');
  assert.equal(f.requests.filter((r) => r.url.endsWith('/app/')).length, 2);
  assert.equal(f.logins(), 1);
});
