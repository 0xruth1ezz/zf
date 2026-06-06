#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { PlaywrightCrawler, RequestQueue, log, purgeDefaultStorages } = require('crawlee');
const { chromium } = require('playwright');
const {
  countEngagements,
  countSignIns,
  hasEngagement,
  hasSignIn,
  listAccounts,
  openEngagedStore,
  renderEngagementHtml,
  saveEngagement,
  saveSignIn,
} = require('./engaged-store');

const ROOT_DIR = __dirname;
dotenv.config({ path: process.env.ENV_FILE || path.join(ROOT_DIR, '.env'), quiet: true });

const START_URL = process.env.ZF_START_URL || 'https://www.zfrontier.com/app/#info';
const SIGN_IN_URL = process.env.ZF_SIGN_IN_URL || 'https://www.zfrontier.com/app/achievement#score';
const PROFILE_DIR = process.env.ZF_PROFILE_DIR || path.join(ROOT_DIR, '.browser-profile');
const ENGAGED_DB = process.env.ZF_ENGAGED_DB || path.join(ROOT_DIR, 'engaged-lotteries.sqlite');
const ENGAGED_HTML = process.env.ZF_ENGAGED_HTML || path.join(ROOT_DIR, 'engaged-lotteries.html');

const CONFIG = {
  publishWindowDays: numberFromEnv('ZF_DAYS', 7),
  signInTimeZone: process.env.ZF_SIGN_IN_TZ || 'Asia/Shanghai',
  maxScrolls: numberFromEnv('MAX_SCROLLS', 80),
  maxPosts: numberFromEnv('MAX_POSTS', 0),
  scrollWaitMs: numberFromEnv('SCROLL_WAIT_MS', 1200),
  manualTimeoutMs: numberFromEnv('MANUAL_TIMEOUT_MS', 10 * 60 * 1000),
  requestTimeoutSecs: numberFromEnv('REQUEST_TIMEOUT_SECS', 6 * 60 * 60),
  viewportWidth: Math.max(960, numberFromEnv('VIEWPORT_WIDTH', 1600)),
  viewportHeight: Math.max(720, numberFromEnv('VIEWPORT_HEIGHT', 1200)),
  dryRun: hasFlag('--dry-run') || process.env.DRY_RUN === '1',
  headless: hasFlag('--headless') || process.env.HEADLESS === '1',
  useChrome: process.env.USE_CHROME !== '0',
  proxyUrl: process.env.PROXY_URL || '',
};

const LOTTERY_TEXT = '点击抽奖';
const RUSH_TEXT = '一键冲冲冲';
const PUBLISH_WINDOW_MS = CONFIG.publishWindowDays * 24 * 60 * 60 * 1000;

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function normalizePostUrl(rawUrl) {
  const url = new URL(rawUrl, START_URL);
  if (!url.pathname.startsWith('/app/flow/')) return null;
  url.hash = '';
  url.search = '';
  return url.toString();
}

function postIdFromUrl(rawUrl) {
  const url = new URL(rawUrl);
  return url.pathname.split('/').filter(Boolean).pop();
}

function compactText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function loadAccounts(store) {
  const storedAccounts = loadStoredAccounts(store);
  const configuredAccounts = storedAccounts.length > 0
    ? storedAccounts
    : loadNumberedAccounts();
  const rawAccounts = configuredAccounts.length > 0
    ? configuredAccounts
    : loadJsonAccounts();
  const accounts = rawAccounts.length > 0
    ? rawAccounts
    : [{
      id: process.env.ZF_ACCOUNT_ID || 'default',
      phone: process.env.ZF_PHONE || '',
      password: process.env.ZF_PASSWORD || '',
    }];

  const ids = new Set();
  return accounts.map((rawAccount, index) => {
    const account = normalizeAccount(rawAccount, index);
    if (ids.has(account.id)) {
      throw new Error(`Duplicate account id "${account.id}" in zFrontier account configuration.`);
    }
    ids.add(account.id);
    return account;
  });
}

function loadStoredAccounts(store) {
  return listAccounts(store, { enabledOnly: true }).map((account) => ({
    id: account.id,
    phone: account.phone,
    password: account.password,
  }));
}

function loadNumberedAccounts() {
  return Object.keys(process.env)
    .map((key) => key.match(/^ZF_ACCOUNT(\d+)$/)?.[1])
    .filter(Boolean)
    .sort((left, right) => Number(left) - Number(right))
    .map((number) => ({
      id: process.env[`ZF_ACCOUNT_ID${number}`] || `account-${number}`,
      phone: process.env[`ZF_ACCOUNT${number}`] || '',
      password: process.env[`ZF_PASSWORD${number}`] || '',
    }));
}

function loadJsonAccounts() {
  const raw = process.env.ZF_ACCOUNTS_FILE
    ? fs.readFileSync(process.env.ZF_ACCOUNTS_FILE, 'utf8')
    : process.env.ZF_ACCOUNTS;
  if (!raw) return [];

  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.accounts)) return parsed.accounts;
  throw new Error('ZF_ACCOUNTS must be a JSON array, or an object with an accounts array.');
}

function normalizeAccount(rawAccount, index) {
  const requestedId = rawAccount.id || rawAccount.accountId || rawAccount.name || (index === 0 ? 'default' : `account-${index + 1}`);
  const id = normalizeAccountId(requestedId);
  const phone = String(rawAccount.phone || rawAccount.mobile || rawAccount.username || rawAccount.ZF_PHONE || '').trim();
  const password = String(rawAccount.password || rawAccount.pass || rawAccount.ZF_PASSWORD || '').trim();
  return { id, phone, password };
}

function normalizeAccountId(value) {
  return compactText(value)
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'default';
}

function profileDirForAccount(account, accountCount) {
  if (accountCount === 1 && account.id === 'default') {
    return PROFILE_DIR;
  }
  return path.join(PROFILE_DIR, account.id);
}

function dateKeyForTimeZone(date = new Date(), timeZone = CONFIG.signInTimeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const valueByType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${valueByType.year}-${valueByType.month}-${valueByType.day}`;
}

async function isVisible(locator, timeout = 500) {
  try {
    await locator.first().waitFor({ state: 'visible', timeout });
    return true;
  } catch {
    return false;
  }
}

async function clickFirstVisible(page, selectorsOrLocators, timeout = 600) {
  for (const item of selectorsOrLocators) {
    const locator = typeof item === 'string' ? page.locator(item) : item;
    if (await isVisible(locator, timeout)) {
      await locator.first().click();
      return true;
    }
  }
  return false;
}

async function hasCaptcha(page) {
  return page.evaluate(() => {
    const text = document.body?.innerText || '';
    return Boolean(
      document.querySelector('.capthcah-overlay, .captcha, #captcha')
      || /请完成安全验证|向右滑动完成拼图|滑动完成拼图/.test(text),
    );
  }).catch(() => false);
}

async function waitForManualCheckpoint(page, reason) {
  if (!(await hasCaptcha(page))) return;
  log.warning(`${reason}: zFrontier is showing a slider verification. Complete it in the opened browser; waiting up to ${Math.round(CONFIG.manualTimeoutMs / 1000)}s.`);
  await page.bringToFront().catch(() => {});
  await page.waitForFunction(() => {
    const text = document.body?.innerText || '';
    return !document.querySelector('.capthcah-overlay, .captcha, #captcha')
      && !/请完成安全验证|向右滑动完成拼图|滑动完成拼图/.test(text);
  }, null, { timeout: CONFIG.manualTimeoutMs });
}

async function navigateTo(page, url, reason) {
  const target = new URL(url).toString();
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      log.info(`${reason}: navigating to ${target} (attempt ${attempt}/3).`);
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await waitForManualCheckpoint(page, reason);
      await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
      return;
    } catch (error) {
      lastError = error;
      log.warning(`${reason}: navigation attempt ${attempt} failed: ${error.message}`);
      await page.waitForTimeout(3000 * attempt).catch(() => {});

      if (attempt === 1) {
        await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      }
    }
  }

  throw lastError;
}

async function isLoggedIn(page) {
  await waitForManualCheckpoint(page, 'Login check');
  const loginEntry = page.getByText('登录/注册', { exact: true });
  return !(await isVisible(loginEntry, 800));
}

async function openLoginModal(page) {
  const clicked = await clickFirstVisible(page, [
    page.locator('header').getByText('登录/注册', { exact: true }),
    page.locator('.toolbar').getByText('登录/注册', { exact: true }),
    page.locator('span.pointer').filter({ hasText: /^登录\/注册$/ }),
    page.getByText('登录/注册', { exact: true }),
  ], 3000);

  if (!clicked) {
    return false;
  }

  await waitForManualCheckpoint(page, 'Opening login prompt');
  await page.waitForTimeout(1000);
  return true;
}

async function fillLoginFormIfPossible(page, account) {
  if (!account.phone || !account.password) return false;

  const clickedPhoneLogin = await clickFirstVisible(page, [
    page.getByText('手机号注册登录', { exact: true }),
    page.locator('a,button,div,span').filter({ hasText: /^手机号注册登录$/ }),
  ], 1500).catch(() => false);
  if (!clickedPhoneLogin) {
    log.warning('Could not find 手机号注册登录 after opening the login modal.');
    return false;
  }

  await waitForManualCheckpoint(page, 'Selecting phone login');
  await page.waitForTimeout(800);

  await clickFirstVisible(page, [
    page.getByText('密码登录', { exact: true }),
    page.getByText('账号密码登录', { exact: true }),
    page.getByText('使用密码登录', { exact: true }),
  ], 500).catch(() => false);

  const phoneInput = page.locator([
    'input[type="tel"]',
    'input[name*="phone" i]',
    'input[name*="mobile" i]',
    'input[placeholder*="手机号"]',
    'input[placeholder*="手机"]',
    'input[placeholder*="账号"]',
    'input[placeholder*="用户名"]',
    'input[placeholder*="请输入"]',
  ].join(', ')).first();
  const passwordInput = page.locator('input[type="password"]').first();

  if (!(await isVisible(phoneInput, 1200)) || !(await isVisible(passwordInput, 1200))) {
    return false;
  }

  await phoneInput.fill(account.phone);
  await passwordInput.fill(account.password);

  const clickedSubmit = await clickFirstVisible(page, [
    page.locator('button').filter({ hasText: /^登录$/ }),
    page.locator('a').filter({ hasText: /^登录$/ }),
    page.locator('.submit').filter({ hasText: /^登录$/ }),
    page.getByText('登录', { exact: true }),
  ], 800);

  if (!clickedSubmit) {
    await passwordInput.press('Enter');
  }

  await waitForManualCheckpoint(page, 'Login submit');
  return true;
}

async function ensureLoggedIn(page, account) {
  if (await isLoggedIn(page)) return;

  log.info(`[${account.id}] Not logged in. Opening login prompt.`);
  const openedLogin = await openLoginModal(page);
  if (!openedLogin) {
    log.warning(`[${account.id}] Could not click 登录/注册. Complete login manually in the opened browser.`);
  }

  const filled = await fillLoginFormIfPossible(page, account);
  if (filled) {
    try {
      await page.waitForFunction(() => !(document.body?.innerText || '').includes('登录/注册'), null, { timeout: 20000 });
    } catch {
      log.warning(`[${account.id}] Automatic login did not finish within 20s. Please complete any remaining login step in the browser.`);
    }
  } else {
    log.warning(`[${account.id}] Could not fill the login form automatically. Complete login manually in the opened browser.`);
  }

  await page.bringToFront().catch(() => {});
  await page.waitForFunction(() => !(document.body?.innerText || '').includes('登录/注册'), null, { timeout: CONFIG.manualTimeoutMs });
}

async function ensureInfoTab(page) {
  await waitForManualCheckpoint(page, 'Selecting info tab');
  const clicked = await clickFirstVisible(page, [
    page.getByText('情报', { exact: true }),
    page.locator('a,button,div,span').filter({ hasText: /^情报$/ }),
  ], 1200).catch(() => false);

  if (clicked) {
    await page.waitForTimeout(1200);
  }

  await page.evaluate(() => {
    if (window.location.hash !== '#info') {
      window.location.hash = 'info';
    }
  }).catch(() => {});
  await page.waitForTimeout(800);
}

async function collectPostRequests(page) {
  const links = new Map();
  let roundsWithoutNewLinks = 0;

  await ensureInfoTab(page);
  await waitForManualCheckpoint(page, 'Collecting posts');
  await page.waitForSelector('a[href*="/app/flow/"]', { timeout: 30000 }).catch(() => {});

  for (let scroll = 0; scroll <= CONFIG.maxScrolls; scroll += 1) {
    await waitForManualCheckpoint(page, `Collecting posts, scroll ${scroll}`);
    await ensureInfoTab(page);

    const batch = await page.evaluate(() => {
      const exactText = (element) => (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const infoTab = [...document.querySelectorAll('a,button,div,span')]
        .find((element) => exactText(element) === '情报' && visible(element));
      const infoTabRect = infoTab?.getBoundingClientRect();
      const infoTabDocBottom = infoTabRect ? infoTabRect.bottom + window.scrollY : 0;
      const desktopMainRight = Math.min(window.innerWidth * 0.68, 930);
      const mainRight = window.innerWidth >= 900 ? desktopMainRight : window.innerWidth;
      const mainLeft = window.innerWidth >= 900 && infoTabRect ? Math.max(0, infoTabRect.left - 260) : 0;

      return [...document.querySelectorAll('a[href*="/app/flow/"]')]
        .filter((anchor) => {
          const rect = anchor.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return false;

          const docTop = rect.top + window.scrollY;
          if (docTop < infoTabDocBottom - 10) return false;
          if (window.innerWidth >= 900 && (rect.left < mainLeft || rect.left > mainRight)) return false;

          const classText = `${anchor.className || ''} ${anchor.parentElement?.className || ''}`;
          if (/banner|swiper|timeline-item|customer-service/.test(classText)) return false;

          return true;
        })
        .map((anchor) => ({
          url: anchor.href,
          text: exactText(anchor),
          className: anchor.className || '',
          parentClassName: anchor.parentElement?.className || '',
        }));
    });

    let addedThisRound = 0;
    for (const item of batch) {
      const url = normalizePostUrl(item.url);
      if (!url || links.has(url)) continue;
      links.set(url, {
        url,
        uniqueKey: postIdFromUrl(url),
        skipNavigation: true,
        userData: {
          label: 'POST',
          listText: item.text,
          className: item.className,
          parentClassName: item.parentClassName,
        },
      });
      addedThisRound += 1;
    }

    if (addedThisRound === 0) {
      roundsWithoutNewLinks += 1;
    } else {
      roundsWithoutNewLinks = 0;
      log.info(`Discovered ${links.size} unique post links so far.`);
    }

    if (roundsWithoutNewLinks >= 6) {
      log.info('Stopping list scroll after 6 rounds without new post links.');
      break;
    }

    if (CONFIG.maxPosts > 0 && links.size >= CONFIG.maxPosts) {
      log.info(`Stopping list scroll at MAX_POSTS=${CONFIG.maxPosts}.`);
      break;
    }

    await page.evaluate(() => window.scrollBy(0, Math.max(window.innerHeight * 0.9, 800)));
    await page.waitForTimeout(CONFIG.scrollWaitMs);
  }

  const requests = [...links.values()];
  return CONFIG.maxPosts > 0 ? requests.slice(0, CONFIG.maxPosts) : requests;
}

function parsePublishedAtFromText(text, now = new Date()) {
  const normalized = compactText(text);
  const directMatch = normalized.match(/((?:20\d{2})[.\-/年]\s*\d{1,2}[.\-/月]\s*\d{1,2}(?:[日号])?(?:\s+\d{1,2}:\d{2})?)/);
  if (directMatch) {
    const parsed = parseChineseDate(directMatch[1]);
    if (parsed) return { publishedAt: parsed, publishedText: directMatch[1] };
  }

  const yesterdayMatch = normalized.match(/(前天|昨天)\s*(\d{1,2}):(\d{2})/);
  if (yesterdayMatch) {
    const date = new Date(now);
    date.setDate(date.getDate() - (yesterdayMatch[1] === '前天' ? 2 : 1));
    date.setHours(Number(yesterdayMatch[2]), Number(yesterdayMatch[3]), 0, 0);
    return { publishedAt: date, publishedText: yesterdayMatch[0] };
  }

  const relativeMatch = normalized.match(/(\d+)\s*(秒|分钟|小时|天)前/);
  if (relativeMatch) {
    const amount = Number(relativeMatch[1]);
    const unit = relativeMatch[2];
    const multipliers = {
      秒: 1000,
      分钟: 60 * 1000,
      小时: 60 * 60 * 1000,
      天: 24 * 60 * 60 * 1000,
    };
    return {
      publishedAt: new Date(now.getTime() - amount * multipliers[unit]),
      publishedText: relativeMatch[0],
    };
  }

  return { publishedAt: null, publishedText: '' };
}

function parseChineseDate(rawText) {
  const cleaned = rawText
    .replace(/[年月]/g, '-')
    .replace(/[日号]/g, '')
    .replace(/\//g, '-')
    .replace(/\./g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  const match = cleaned.match(/^(20\d{2})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (!match) return null;
  return new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4] || 0),
    Number(match[5] || 0),
    0,
    0,
  );
}

async function extractPostMeta(page, request) {
  const text = await page.locator('body').innerText({ timeout: 30000 });
  const title = await page.title().then((value) => value.replace(/\s+-\s+zFrontier.*$/i, '').trim()).catch(() => '');

  const publishLineMatch = text.match(/([^\n]*(?:秒|分钟|小时|天)前\s+从\s+[^\n]+发布|[^\n]*(?:昨天|前天)\s+\d{1,2}:\d{2}\s+从\s+[^\n]+发布|[^\n]*20\d{2}[.\-/年]\s*\d{1,2}[.\-/月]\s*\d{1,2}[日号]?(?:\s+\d{1,2}:\d{2})?\s+从\s+[^\n]+发布)/);
  const publishSource = publishLineMatch ? publishLineMatch[1] : `${request.userData.listText || ''} ${text.slice(0, 3000)}`;
  const parsed = parsePublishedAtFromText(publishSource);

  return {
    title,
    bodyText: text,
    publishedAt: parsed.publishedAt,
    publishedText: parsed.publishedText,
    publishSource: compactText(publishSource),
  };
}

function isWithinPublishWindow(publishedAt) {
  if (!publishedAt) return false;
  const now = Date.now();
  const time = publishedAt.getTime();
  return time <= now + 5 * 60 * 1000 && now - time <= PUBLISH_WINDOW_MS;
}

async function visibleLotteryButton(page) {
  const locator = page.locator('a,button,.plugin-btn,.submit').filter({ hasText: LOTTERY_TEXT });
  return (await isVisible(locator, 1000)) ? locator.first() : null;
}

async function clickConfirmIfVisible(page) {
  await clickFirstVisible(page, [
    page.getByText('确定', { exact: true }),
    page.getByText('确认', { exact: true }),
    page.getByText(RUSH_TEXT, { exact: true }),
    page.locator('a,button,.submit').filter({ hasText: RUSH_TEXT }),
  ], 1500).catch(() => false);
}

async function clickSignInConfirmIfVisible(page) {
  await clickFirstVisible(page, [
    page.getByText('确定', { exact: true }),
    page.getByText('确认', { exact: true }),
  ], 1200).catch(() => false);
}

async function visibleSignInButton(page) {
  const locator = page.locator('a,button,[role="button"],.btn,.button,.submit,.plugin-btn,div,span')
    .filter({ hasText: /^签到$/ });
  return (await isVisible(locator, 1500)) ? locator.first() : null;
}

async function performDailySignIn(page, store, account) {
  const signInDate = dateKeyForTimeZone();
  if (hasSignIn(store, account.id, signInDate)) {
    log.info(`[${account.id}] Skipping daily sign-in: ${signInDate} is already recorded.`);
    return;
  }

  await navigateTo(page, SIGN_IN_URL, 'Opening daily sign-in page');
  await waitForManualCheckpoint(page, 'Opening daily sign-in page');
  await ensureLoggedIn(page, account);
  await page.waitForSelector('body', { timeout: 30000 }).catch(() => {});

  const bodyText = await page.locator('body').innerText({ timeout: 10000 }).catch(() => '');
  let button = await visibleSignInButton(page);
  if (!button && /已签到|今日已签到|明日再来/.test(bodyText)) {
    const signedAt = new Date().toISOString();
    saveSignIn(store, {
      accountId: account.id,
      signInDate,
      signedAt,
      url: SIGN_IN_URL,
      status: 'already_signed',
      message: 'Page already showed today as signed in.',
    });
    renderEngagementHtml(store);
    log.info(`[${account.id}] Recorded daily sign-in ${signInDate}: page already showed signed in.`);
    return;
  }

  if (!button) {
    log.warning(`[${account.id}] Daily sign-in skipped for ${signInDate}: no visible 签到 button found.`);
    return;
  }

  if (CONFIG.dryRun) {
    log.warning(`[${account.id}] Dry run: would click daily 签到 for ${signInDate}.`);
    return;
  }

  await button.scrollIntoViewIfNeeded().catch(() => {});
  await button.click();
  await waitForManualCheckpoint(page, 'After clicking daily sign-in');
  await page.waitForTimeout(1500);
  await clickSignInConfirmIfVisible(page);
  await waitForManualCheckpoint(page, 'After confirming daily sign-in');
  await page.waitForTimeout(1200);

  button = await visibleSignInButton(page);
  const afterText = await page.locator('body').innerText({ timeout: 10000 }).catch(() => '');
  const signedAt = new Date().toISOString();
  saveSignIn(store, {
    accountId: account.id,
    signInDate,
    signedAt,
    url: SIGN_IN_URL,
    status: /已签到|今日已签到|签到成功/.test(afterText) || !button ? 'signed' : 'clicked',
    message: 'Clicked daily 签到.',
  });
  renderEngagementHtml(store);
  log.info(`[${account.id}] Recorded daily sign-in ${signInDate}.`);
}

async function clickThumbUpIfPossible(page) {
  if (CONFIG.dryRun) {
    return { clicked: false, reason: 'Dry run: would click thumb-up button' };
  }

  const result = await page.evaluate(() => {
    const textOf = (element) => (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const classOf = (element) => String(element.className || '');
    const attrsOf = (element) => [
      classOf(element),
      element.getAttribute('title') || '',
      element.getAttribute('aria-label') || '',
      element.getAttribute('data-title') || '',
    ].join(' ');
    const actionableFor = (element) => element.closest('a,button,[role="button"],.pointer,.plugin-btn') || element;
    const lottery = [...document.querySelectorAll('a,button,div,span')]
      .find((element) => textOf(element) === '点击抽奖' && visible(element));
    const lotteryRect = lottery?.getBoundingClientRect();

    const scored = [...document.querySelectorAll('a,button,div,span,i')]
      .filter(visible)
      .map((element) => {
        const text = textOf(element);
        const attrs = attrsOf(element);
        const attrsLower = attrs.toLowerCase();
        const isThumb = /thumb|like|zan|praise|vote|dianzan|icon-good|icon-like|icon-thumb|icon-zan/.test(attrsLower)
          || /^(赞|点赞)$/.test(text);
        if (!isThumb) return null;

        const actionable = actionableFor(element);
        const actionableAttrs = attrsOf(actionable);
        const actionableLower = actionableAttrs.toLowerCase();
        const ancestry = `${attrs} ${actionableAttrs} ${classOf(actionable.parentElement || {})}`.toLowerCase();
        if (/active|liked|selected|checked|disabled|disable/.test(ancestry)) {
          return null;
        }

        const rect = actionable.getBoundingClientRect();
        let score = 1;
        if (/pointer|plugin-btn/.test(actionableLower)) score += 8;
        if (/^(赞|点赞)$/.test(text) || /zan|like|thumb|praise|dianzan/.test(actionableLower)) score += 8;
        if (lotteryRect) {
          const distance = Math.abs((rect.top + rect.bottom) / 2 - (lotteryRect.top + lotteryRect.bottom) / 2);
          if (distance < 450) score += 10;
        }
        if (rect.left > window.innerWidth * 0.8) score -= 6;

        return { element: actionable, score, text, className: classOf(actionable) };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);

    const chosen = scored[0];
    if (!chosen) {
      return { clicked: false, reason: 'No unliked thumb-up candidate found' };
    }

    chosen.element.click();
    return {
      clicked: true,
      reason: `Clicked thumb-up candidate "${chosen.text || chosen.className || chosen.element.tagName}"`,
    };
  }).catch((error) => ({ clicked: false, reason: `Thumb-up click failed: ${error.message}` }));

  await waitForManualCheckpoint(page, 'After clicking thumb-up');
  await page.waitForTimeout(800);
  return result;
}

async function engageLottery(page) {
  const button = await visibleLotteryButton(page);
  if (!button) return { engaged: false, reason: `No visible "${LOTTERY_TEXT}" button` };

  if (CONFIG.dryRun) {
    return { engaged: false, reason: `Dry run: would click "${LOTTERY_TEXT}"` };
  }

  await button.scrollIntoViewIfNeeded().catch(() => {});
  await button.click();
  await waitForManualCheckpoint(page, 'After clicking lottery');
  await page.waitForTimeout(1000);
  await clickConfirmIfVisible(page);
  await waitForManualCheckpoint(page, 'After confirming lottery');
  await page.waitForTimeout(2000);

  const text = await page.locator('body').innerText().catch(() => '');
  if (/已(参与|参加|抽奖|报名)|参与成功|回复成功|提交成功|冲冲冲/.test(text)) {
    return { engaged: true, reason: 'Clicked lottery action and detected a success/participation hint' };
  }

  return { engaged: true, reason: 'Clicked lottery action; no explicit failure was detected' };
}

async function processPost(page, postRequest, engagedStore, account) {
  const postUrl = normalizePostUrl(postRequest.url);
  const postId = postIdFromUrl(postUrl);
  if (hasEngagement(engagedStore, account.id, postId)) {
    log.info(`[${account.id}] Skipping ${postId}: already recorded in ${path.basename(ENGAGED_DB)}.`);
    return;
  }

  await navigateTo(page, postUrl, `Opening post ${postId}`);
  await waitForManualCheckpoint(page, `Opening post ${postId}`);
  await ensureLoggedIn(page, account);
  const meta = await extractPostMeta(page, postRequest);
  const hasLottery = meta.bodyText.includes('抽奖');

  if (!hasLottery) {
    log.info(`[${account.id}] Skipping ${postId}: no lottery text found.`);
    return;
  }

  if (!isWithinPublishWindow(meta.publishedAt)) {
    const dateText = meta.publishedAt ? meta.publishedAt.toISOString() : 'unknown date';
    log.info(`[${account.id}] Skipping ${postId}: published ${dateText}, outside the last ${CONFIG.publishWindowDays} days.`);
    return;
  }

  if (/已(参与|参加|抽奖|报名)/.test(meta.bodyText) && !(await visibleLotteryButton(page))) {
    log.info(`[${account.id}] Skipping ${postId}: page appears to already be participated.`);
    return;
  }

  const thumbResult = await clickThumbUpIfPossible(page);
  log.info(`[${account.id}] ${postId}: ${thumbResult.reason}.`);

  const result = await engageLottery(page);
  if (!result.engaged) {
    log.info(`[${account.id}] Skipping ${postId}: ${result.reason}.`);
    return;
  }

  const engagedAt = new Date().toISOString();
  saveEngagement(engagedStore, {
    accountId: account.id,
    postId,
    url: postUrl,
    title: meta.title,
    engagedAt,
  });
  renderEngagementHtml(engagedStore);
  log.info(`[${account.id}] Recorded engaged lottery post ${postId}: ${meta.title || postUrl}`);
}

async function main() {
  log.setLevel(log.LEVELS.INFO);

  const engagedStore = openEngagedStore(ENGAGED_DB, ENGAGED_HTML);
  renderEngagementHtml(engagedStore);
  const accounts = loadAccounts(engagedStore);

  accounts
    .filter((account) => !account.phone || !account.password)
    .forEach((account) => {
      log.warning(`[${account.id}] Phone/password are not fully configured. Complete login manually in the browser if needed.`);
    });
  if (CONFIG.dryRun) {
    log.warning('Dry run is enabled. The crawler will not click lottery buttons.');
  }

  for (const account of accounts) {
    await runAccount(account, engagedStore, accounts.length);
  }

  renderEngagementHtml(engagedStore);
  log.info(`Done. Recorded ${countEngagements(engagedStore)} engaged lottery posts and ${countSignIns(engagedStore)} daily sign-ins in ${ENGAGED_DB}.`);
  log.info(`View records at ${ENGAGED_HTML}.`);
  engagedStore.db.close();
}

async function runAccount(account, engagedStore, accountCount) {
  await purgeDefaultStorages();
  const requestQueue = await RequestQueue.open(`zfrontier-${account.id}-${Date.now()}`);
  await requestQueue.addRequest({
    url: START_URL,
    uniqueKey: `zfrontier-info-list-${account.id}`,
    skipNavigation: true,
    userData: { label: 'LIST' },
  });

  let listPageFailed = false;
  const userDataDir = profileDirForAccount(account, accountCount);
  log.info(`[${account.id}] Starting crawler with profile ${userDataDir}.`);

  const crawler = new PlaywrightCrawler({
    requestQueue,
    maxConcurrency: 1,
    maxRequestRetries: 1,
    navigationTimeoutSecs: 60,
    requestHandlerTimeoutSecs: CONFIG.requestTimeoutSecs,
    launchContext: {
      launcher: chromium,
      useChrome: CONFIG.useChrome,
      proxyUrl: CONFIG.proxyUrl || undefined,
      userDataDir,
      useIncognitoPages: false,
      launchOptions: {
        headless: CONFIG.headless,
        viewport: { width: CONFIG.viewportWidth, height: CONFIG.viewportHeight },
      },
    },
    preNavigationHooks: [
      async (_crawlingContext, gotoOptions) => {
        gotoOptions.waitUntil = 'domcontentloaded';
        gotoOptions.timeout = 60000;
      },
    ],
    requestHandler: async ({ page, request }) => {
      if (request.userData.label === 'LIST') {
        await navigateTo(page, START_URL, 'Opening list page');
        await waitForManualCheckpoint(page, 'Opening list page');
        await ensureLoggedIn(page, account);
        await performDailySignIn(page, engagedStore, account);
        await navigateTo(page, START_URL, 'Reloading list page after login and daily sign-in');

        const postRequests = await collectPostRequests(page);
        log.info(`[${account.id}] Processing ${postRequests.length} post pages from the 情报 tab in one browser page.`);

        for (const postRequest of postRequests) {
          try {
            await processPost(page, postRequest, engagedStore, account);
          } catch (error) {
            log.error(`[${account.id}] Failed while processing ${postRequest.url}: ${error.message}`);
          }
        }
      }
    },
    failedRequestHandler: async ({ request }, error) => {
      if (request.userData.label === 'LIST') {
        listPageFailed = true;
      }
      log.error(`Failed ${request.url}: ${error?.message || 'unknown error'}`);
    },
  });

  await crawler.run();
  if (listPageFailed) {
    throw new Error(`[${account.id}] Failed to crawl the start page: ${START_URL}`);
  }
}

main().catch((error) => {
  log.exception(error, 'Crawler failed');
  process.exitCode = 1;
});
