const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { chromium } = require('playwright');
const { blockPageMedia } = require('../zfrontier-lottery-crawler');

async function startServer(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('media is blocked on crawler pages, allowed throughout login, and blocked again after leaving', async (t) => {
  const received = new Set();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1kAAAAASUVORK5CYII=', 'base64');
  const cdn = await startServer(t, (request, response) => {
    const url = new URL(request.url, 'http://fixture');
    const phase = url.searchParams.get('phase');
    received.add(`${phase}:${url.pathname}`);
    if (url.pathname === '/frame') {
      response.setHeader('Content-Type', 'text/html');
      response.end(`<img src="/frame-image?phase=${phase}">`);
    } else if (url.pathname === '/video') {
      // A browser media request is enough to verify interception, even if the
      // fixture is not a decodable video.
      response.writeHead(200, { 'Content-Type': 'video/mp4' });
      response.end(Buffer.alloc(32));
    } else {
      response.writeHead(200, { 'Content-Type': 'image/png' });
      response.end(png);
    }
  });
  const site = await startServer(t, (request, response) => {
    const url = new URL(request.url, 'http://fixture');
    const phase = url.searchParams.get('phase');
    if (url.pathname === '/redirect-login' || url.pathname === '/redirect-post') {
      const target = url.pathname === '/redirect-login' ? '/app/login/' : '/app/flow/after-login';
      response.writeHead(302, { Location: `${target}?phase=${phase}` });
      response.end();
    } else if (url.pathname === '/script.js') {
      response.setHeader('Content-Type', 'text/javascript');
      response.end('window.scriptLoaded = true; fetch("/data").then(r => r.json()).then(data => window.dataLoaded = data.ok);');
    } else if (url.pathname === '/style.css') {
      response.setHeader('Content-Type', 'text/css');
      response.end(`body { margin: 13px; background-image: url("${cdn}/css-image?phase=${phase}"); }`);
    } else if (url.pathname === '/data') {
      response.setHeader('Content-Type', 'application/json');
      response.end('{"ok":true}');
    } else {
      response.setHeader('Content-Type', 'text/html');
      response.end(`<!doctype html><html><head>
        <link rel="stylesheet" href="/style.css?phase=${phase}">
        <script src="/script.js"></script>
      </head><body>
        <img src="${cdn}/image?phase=${phase}">
        <video src="${cdn}/video?phase=${phase}" preload="auto" muted></video>
        <iframe src="${cdn}/frame?phase=${phase}"></iframe>
      </body></html>`);
    }
  });

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  await blockPageMedia(page, `${site}/app/login?returnTo=feed`);
  const failed = new Set();
  page.on('requestfailed', (request) => {
    const url = new URL(request.url());
    failed.add(`${url.searchParams.get('phase')}:${url.pathname}:${request.resourceType()}`);
  });

  for (const [phase, pathname, allowed] of [
    ['feed', '/app/', false],
    ['post', '/app/flow/test', false],
    ['sign-in', '/app/achievement', false],
    ['messages', '/my/mail/list', false],
    ['login', '/redirect-login', true],
    ['after-login', '/redirect-post', false],
  ]) {
    await page.goto(`${site}${pathname}?phase=${phase}`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.scriptLoaded && window.dataLoaded);
    assert.equal(await page.locator('body').evaluate((body) => getComputedStyle(body).margin), '13px');
    assert.ok(received.has(`${phase}:/frame`), 'iframe documents must load');
    for (const [asset, type] of [['image', 'image'], ['css-image', 'image'], ['frame-image', 'image'], ['video', 'media']]) {
      assert.equal(received.has(`${phase}:/${asset}`), allowed, `${phase}: ${asset}`);
      assert.equal(failed.has(`${phase}:/${asset}:${type}`), !allowed, `${phase}: intercepted ${type}`);
    }
  }

  const customPage = await context.newPage();
  await blockPageMedia(customPage, `${site}/custom/sign-in/`);
  await customPage.goto(`${site}/custom/sign-in?phase=custom-login`, { waitUntil: 'networkidle' });
  assert.ok(received.has('custom-login:/image'));
  assert.ok(received.has('custom-login:/video'));
  assert.ok(received.has('custom-login:/frame-image'));
});
