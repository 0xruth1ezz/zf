const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { Configuration, PlaywrightCrawler } = require('crawlee');

process.env.SCROLL_WAIT_MS = '100';
const { collectPostRequests, crawlerBrowserPoolOptions } = require('../zfrontier-lottery-crawler');

const feedFixture = `<!doctype html><style>
  body { margin: 0; } .main-wrap { width: 1100px; margin: auto; }
  .list-head { position: sticky; top: 0; background: white; }
  .tabs-component-tab { display: inline-block; padding: 20px; }
  .list-flow { height: 10000px; } a { display: block; }
</style><div class="home"><div class="main-wrap">
  <div class="list-wrap">
    <div class="list-head"><div class="tabs-component-tab">\n                情报\n                  </div></div>
    <div class="infinite-loading-wrap"><div class="list-flow">
      <a href="/app/flow/first">First post</a><a href="/app/flow/first#comments">Comments</a>
    </div></div>
  </div>
  <aside class="right-side"><a href="/app/flow/sidebar">Sidebar recommendation</a></aside>
</div></div><script>
  window.tabClicks = 0;
  const tab = document.querySelector('.tabs-component-tab');
  tab.onclick = () => { window.tabClicks++; tab.classList.add('active'); scrollTo(0, 0); };
  let appended = false;
  addEventListener('scroll', () => {
    if (!appended && scrollY + innerHeight >= document.documentElement.scrollHeight - 5) {
      appended = true;
      document.querySelector('.infinite-loading-wrap').insertAdjacentHTML('beforeend',
        '<div class="list-flow" style="height:1200px"><a href="/app/flow/second">Next page post</a></div>');
    }
  });
</script>`;

test('discovery follows later feed pages on a wide screen without reclicking the tab or including the sidebar', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 3840, height: 1080 } });
  await page.route('https://www.zfrontier.com/**', (route) => route.fulfill({
    contentType: 'text/html; charset=utf-8', body: feedFixture,
  }));
  await page.goto('https://www.zfrontier.com/app/#info');
  const requests = await collectPostRequests(page);
  assert.deepEqual(requests.map((request) => request.uniqueKey), ['first', 'second']);
  assert.equal(await page.evaluate(() => window.tabClicks), 1);
});

test('an unloaded feed fails even when the sidebar contains post links', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`<div class="home"><div class="main-wrap">
    <div class="list-wrap"><div class="list-head"><div class="tabs-component-tab active">情报</div></div>
    <div class="infinite-loading-wrap"></div></div>
    <aside><a href="https://www.zfrontier.com/app/flow/sidebar">Sidebar</a></aside>
  </div></div>`);
  // Keep the same browser wait/failure behavior with a shorter fixture deadline.
  const waitForSelector = page.waitForSelector.bind(page);
  t.mock.method(page, 'waitForSelector', (selector, options) => waitForSelector(selector, { ...options, timeout: 300 }));
  await assert.rejects(collectPostRequests(page), /Timeout.*exceeded/);
});

test('the persistent Crawlee browser uses 1080p for both its viewport and fingerprint', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-browser-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let dimensions;
  const options = crawlerBrowserPoolOptions();
  const crawler = new PlaywrightCrawler({
    maxConcurrency: 1, maxRequestRetries: 0,
    launchContext: {
      launcher: chromium, useIncognitoPages: false, userDataDir: path.join(dir, 'profile'),
      launchOptions: { headless: true, serviceWorkers: 'block' },
    },
    browserPoolOptions: options,
    requestHandler: async ({ page }) => {
      await page.goto('data:text/html,<body>Viewport check</body>');
      dimensions = await page.evaluate(() => ({
        width: innerWidth, height: innerHeight, screenWidth: screen.width, screenHeight: screen.height,
      }));
    },
    failedRequestHandler: (_, error) => { throw error; },
  }, new Configuration({ persistStorage: false, storageClientOptions: { localDataDirectory: path.join(dir, 'storage') } }));
  await crawler.run([{ url: 'https://www.zfrontier.com/app/', skipNavigation: true }]);
  assert.deepEqual(dimensions, { width: 1920, height: 1080, screenWidth: 1920, screenHeight: 1080 });
});
