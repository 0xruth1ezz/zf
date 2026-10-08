const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { loginWithBrowser } = require('../browser-session');

test('browser session recovery reaches the site through an authenticated proxy', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-session-proxy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const requests = [];
  const authorization = `Basic ${Buffer.from('proxy-user:proxy-password').toString('base64')}`;
  const proxy = http.createServer((request, response) => {
    if (request.headers['proxy-authorization'] !== authorization) {
      response.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="fixture"' });
      response.end();
      return;
    }
    requests.push(request.url);
    if (request.url === 'http://zf-session.invalid/app/') {
      response.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'zf-session=proxy-session; Path=/' });
      response.end('<html><body><main>Account feed</main></body></html>');
      return;
    }
    response.writeHead(404);
    response.end();
  });
  // Browser background traffic cannot leave the local fixture.
  proxy.on('connect', (_, socket) => socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  t.after(() => { proxy.closeAllConnections(); proxy.close(); });
  const environment = {
    ENV_FILE: path.join(dir, 'no-env'),
    PROXY_URL: `http://proxy-user:proxy-password@127.0.0.1:${proxy.address().port}`,
    ZF_START_URL: 'http://zf-session.invalid/app/',
    ZF_PROFILE_DIR: path.join(dir, 'profile'),
    CRAWLEE_STORAGE_DIR: path.join(dir, 'storage'),
    HEADLESS: '1', USE_CHROME: '0',
  };
  for (const [key, value] of Object.entries(environment)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  const session = await loginWithBrowser({ id: 'proxy-test' }, { signal: AbortSignal.timeout(60000) });
  assert.ok(requests.includes('http://zf-session.invalid/app/'));
  assert.ok(session.cookies.some((cookie) => cookie.name === 'zf-session' && cookie.value === 'proxy-session'));
  assert.ok(session.headers['user-agent']);
  assert.equal(session.headers['proxy-authorization'], undefined);
});
