const { fork } = require('node:child_process');

// Keep Chromium/Crawlee in a short-lived process so the HTTP service retains no
// browser handles or browser-stack memory between authentication renewals.
let loginQueue = Promise.resolve();
function loginWithBrowser(account, { forceLogin = false, signal } = {}) {
  const job = loginQueue.catch(() => {}).then(() => new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = fork(__filename, [], { detached: process.platform !== 'win32', stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    let result;
    const stop = () => {
      try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
    };
    const timeout = setTimeout(() => { stop(); reject(new Error('Browser authentication exceeded 120 seconds.')); }, 120000);
    const abort = () => { stop(); reject(new Error('Browser authentication stopped.')); };
    signal?.addEventListener('abort', abort, { once: true });
    child.on('message', (message) => { result = message; });
    child.once('error', reject);
    child.once('exit', () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      // Also clean up descendants if Chromium crashed during teardown.
      stop();
      if (result?.session) resolve(result.session);
      else reject(new Error(result?.error || 'Browser authentication failed.'));
    });
    child.send({ account, forceLogin });
  }));
  loginQueue = job;
  return job;
}

async function exportBrowserSession(account, forceLogin) {
  const { PlaywrightCrawler } = require('crawlee');
  const { chromium } = require('playwright');
  const { CONFIG, START_URL, profileDirForAccount, crawlerBrowserPoolOptions, navigateTo, ensureLoggedIn } = require('./zfrontier-lottery-crawler');
  let session;
  const crawler = new PlaywrightCrawler({
    maxConcurrency: 1, maxRequestRetries: 0, requestHandlerTimeoutSecs: 110,
    useSessionPool: false,
    launchContext: { launcher: chromium, useChrome: CONFIG.useChrome,
      proxyUrl: CONFIG.proxyUrl || undefined, userDataDir: profileDirForAccount(account, account.id === 'default' ? 1 : 2),
      useIncognitoPages: false, launchOptions: { headless: CONFIG.headless, serviceWorkers: 'block',
        viewport: { width: CONFIG.viewportWidth, height: CONFIG.viewportHeight } } },
    browserPoolOptions: crawlerBrowserPoolOptions(),
    requestHandler: async ({ page }) => {
      const headers = {};
      const captures = [];
      page.on('request', (request) => {
        if (new URL(request.url()).origin !== new URL(START_URL).origin) return;
        captures.push(request.allHeaders().then((value) => {
          for (const key of ['user-agent', 'accept-language', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'x-client-locale']) {
            if (value[key]) headers[key] = value[key];
          }
        }).catch(() => {}));
      });
      if (forceLogin) await page.context().clearCookies();
      await navigateTo(page, START_URL, 'Restoring browser session');
      await ensureLoggedIn(page, account, START_URL);
      await Promise.all(captures);
      headers['user-agent'] ||= await page.evaluate(() => navigator.userAgent);
      session = { headers, cookies: await page.context().cookies() };
    },
    failedRequestHandler: () => {},
  });
  await crawler.run([{ url: START_URL, skipNavigation: true, uniqueKey: `login-${account.id}-${Date.now()}` }]);
  if (!session) throw new Error('Account login or verification could not be completed.');
  return session;
}

if (require.main === module) {
  process.once('message', async ({ account, forceLogin }) => {
    try {
      const session = await exportBrowserSession(account, forceLogin);
      process.send({ session }, () => process.exit(0));
    } catch {
      process.send({ error: 'Account login or verification could not be completed.' }, () => process.exit(1));
    }
  });
}
module.exports = { loginWithBrowser };
