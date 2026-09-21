const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { Configuration, PlaywrightCrawler } = require('crawlee');

const { crawlerBrowserPoolOptions } = require('../zfrontier-lottery-crawler');

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
