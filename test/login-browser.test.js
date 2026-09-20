const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { ensureLoggedIn } = require('../zfrontier-lottery-crawler');

for (const authenticated of [true, false]) {
  test(`phone login without redirect ${authenticated ? 'resumes the requested page' : 'rejects an unauthenticated session'}`, async (t) => {
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage();
    let submitted = false;
    await page.route('https://www.zfrontier.com/**', async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/api/login/mobile') {
        submitted = true;
        return route.fulfill({ json: { msg: '已登录' } });
      }
      const body = pathname === '/app/login' ? `
        <button onclick="document.querySelector('form').hidden = false">手机号注册登录</button>
        <form hidden onsubmit="event.preventDefault(); fetch('/api/login/mobile', {method: 'POST'}).then(() => this.hidden = true)">
          <input type="tel" placeholder="输入手机号">
          <input type="password" placeholder="输入登录密码">
          <button type="button">密码登录</button>
          <button type="submit">登录</button>
        </form>` : submitted && authenticated ? '<main>Account feed</main>' : '<a>登录/注册</a>';
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body });
    });
    const destination = 'https://www.zfrontier.com/app/#info';
    await page.goto(destination);
    const login = ensureLoggedIn(page, { id: 'new-account', phone: 'test-phone', password: 'test-password' }, destination);
    if (authenticated) {
      await login;
      assert.equal(await page.locator('main').innerText(), 'Account feed');
    } else {
      await assert.rejects(login, /Login did not authenticate the account/);
    }
    assert.ok(submitted);
    assert.equal(page.url(), destination);
  });
}
