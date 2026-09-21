#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { default: log } = require('@apify/log');
const {
  countEngagements,
  countSignIns,
  getEngagement,
  getLotterySchedule,
  hasSignIn,
  listAccounts,
  listTrackedLotteries,
  openEngagedStore,
  renderEngagementHtml,
  saveEngagement,
  saveLotterySchedule,
  saveSignIn,
  saveMessageSyncError,
  initializeMessageSync,
} = require('./engaged-store');
const { fetchPrivateMessages } = require('./private-messages');

const ROOT_DIR = __dirname;
dotenv.config({ path: process.env.ENV_FILE || path.join(ROOT_DIR, '.env'), quiet: true });

const START_URL = process.env.ZF_START_URL || 'https://www.zfrontier.com/app/#info';
const LOGIN_URL = process.env.ZF_LOGIN_URL || 'https://www.zfrontier.com/app/login';
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
  viewportWidth: Math.max(960, numberFromEnv('VIEWPORT_WIDTH', 1920)),
  viewportHeight: Math.max(720, numberFromEnv('VIEWPORT_HEIGHT', 1080)),
  dryRun: hasFlag('--dry-run') || process.env.DRY_RUN === '1',
  trackedOnly: hasFlag('--tracked-only'),
  messagesOnly: hasFlag('--messages-only'),
  headless: hasFlag('--headless') || process.env.HEADLESS === '1',
  useChrome: process.env.USE_CHROME !== '0',
  proxyUrl: process.env.PROXY_URL || '',
};

const LOTTERY_TEXT = '点击抽奖';
const RUSH_TEXT = '一键冲冲冲';
const LOTTERY_PREPARE_SECONDS = 30;
const LOTTERY_LATE_SECONDS = 15;
const PUBLISH_WINDOW_MS = CONFIG.publishWindowDays * 24 * 60 * 60 * 1000;
const FEED_SELECTOR = '.home .main-wrap > .list-wrap';
const FEED_POST_SELECTOR = `${FEED_SELECTOR} .infinite-loading-wrap .list-flow a[href*="/app/flow/"]`;
// Every post uses the same configured time zone; reuse the native ICU formatter.
const DATE_TIME_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: CONFIG.signInTimeZone,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

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
  if (listAccounts(store).length > 0 && storedAccounts.length === 0) return [];
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

function dateKeyForTimeZone(date = new Date()) {
  return dateTimeMinuteKeyForTimeZone(date).slice(0, 10);
}

function dateTimeMinuteKeyForTimeZone(date = new Date()) {
  const parts = DATE_TIME_FORMATTER.formatToParts(date);
  const valueByType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return [
    valueByType.year,
    valueByType.month,
    valueByType.day,
  ].join('-') + ' ' + [
    valueByType.hour,
    valueByType.minute,
  ].join(':');
}

function dateTimeMinuteValue(value) {
  const normalized = normalizeChineseDateText(value);
  const match = normalized.match(/^(20\d{2})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/);
  if (!match) return null;
  return Math.floor(Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
  ) / 60000);
}

function minuteValueForTimeZone(date) {
  return dateTimeMinuteValue(dateTimeMinuteKeyForTimeZone(date));
}

// Schedule seconds are local wall-clock values in ZF_SIGN_IN_TZ, matching draw_at.
function secondValueForTimeZone(date) {
  return minuteValueForTimeZone(date) * 60
    + date.getUTCSeconds() + date.getUTCMilliseconds() / 1000;
}

function wasEngagedInHour(record, hourStart) {
  const engagedAt = new Date(record?.engagedAt || '');
  if (Number.isNaN(engagedAt.getTime())) return false;
  const engagedSecond = secondValueForTimeZone(engagedAt);
  return engagedSecond >= hourStart && engagedSecond < hourStart + 3600;
}

function nextHourlyEngagementSecond(record, now = new Date(), random = Math.random, reserved = new Set()) {
  const drawMinute = dateTimeMinuteValue(record.drawAt);
  if (drawMinute === null) return null;
  const drawSecond = drawMinute * 60;
  const nowSecond = secondValueForTimeZone(now);
  const today = Math.floor(nowSecond / 86400) * 86400;

  for (let day = today; day <= today + 86400; day += 86400) {
    for (let hour = 7; hour < 24; hour += 1) {
      const hourStart = day + hour * 3600;
      const start = hourStart + (hour === 7 ? 1800 : 0);
      const end = Math.min(hourStart + 3600, drawSecond);
      if (nowSecond >= end || wasEngagedInHour(record, hourStart)) continue;

      // Preserve a plan across restarts only while it can still run on time.
      // Overdue posts get a new future time instead of forming a catch-up batch.
      if (record.scheduledSecond >= start && record.scheduledSecond < end
        && nowSecond <= record.scheduledSecond + LOTTERY_LATE_SECONDS
        && !reserved.has(record.scheduledSecond)) {
        return record.scheduledSecond;
      }
      const earliest = Math.max(start, Math.ceil(nowSecond) + LOTTERY_PREPARE_SECONDS);
      if (earliest >= end) continue;
      const occupied = [...reserved].filter((second) => second >= earliest && second < end)
        .sort((left, right) => left - right);
      const available = end - earliest - occupied.length;
      if (available <= 0) continue;
      let selected = earliest + Math.floor(random() * available);
      for (const second of occupied) {
        if (second > selected) break;
        selected += 1;
      }
      return selected;
    }
  }
  return null;
}

function isHourlyEngagementDue(record, now = new Date()) {
  if (!Number.isFinite(record?.scheduledSecond)) return false;
  const nowSecond = secondValueForTimeZone(now);
  const hourStart = Math.floor(record.scheduledSecond / 3600) * 3600;
  const dayStart = Math.floor(hourStart / 86400) * 86400;
  const drawMinute = dateTimeMinuteValue(record.drawAt);
  return record.scheduledSecond >= dayStart + 7.5 * 3600
    && nowSecond >= record.scheduledSecond
    && nowSecond <= record.scheduledSecond + LOTTERY_LATE_SECONDS
    && nowSecond < hourStart + 3600
    && drawMinute !== null && nowSecond < drawMinute * 60
    && !wasEngagedInHour(record, hourStart);
}

function ensureLotterySchedule(store, record, now = new Date(), random = Math.random) {
  // Discovery and the lottery worker share the database. Allocate distinct
  // seconds atomically, and always read fresh engagement and schedule state.
  store.db.exec('BEGIN IMMEDIATE');
  try {
    const existing = getLotterySchedule(store, record.accountId, record.postId);
    const engagement = getEngagement(store, record.accountId, record.postId);
    const schedule = { ...engagement, ...existing, ...record,
      engagedAt: engagement?.engagedAt, scheduledSecond: existing?.scheduledSecond };
    const reserved = new Set(store.db.prepare(`
      SELECT scheduled_second FROM lottery_schedules
      WHERE scheduled_second IS NOT NULL AND NOT (account_id = ? AND post_id = ?)
    `).all(record.accountId, record.postId).map((row) => row.scheduled_second));
    schedule.scheduledSecond = nextHourlyEngagementSecond(schedule, now, random, reserved);
    if (!existing || ['title', 'url', 'drawAt', 'scheduledSecond']
      .some((key) => existing[key] !== schedule[key])) {
      saveLotterySchedule(store, schedule);
    }
    store.db.exec('COMMIT');
    return schedule;
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  }
}

function refreshLotterySchedules(store, now = new Date()) {
  const nowMinute = minuteValueForTimeZone(now);
  return listTrackedLotteries(store)
    .filter((record) => dateTimeMinuteValue(record.drawAt) !== null)
    .map((record) => dateTimeMinuteValue(record.drawAt) <= nowMinute && record.scheduledSecond == null
      ? { ...record, scheduledSecond: null }
      : ensureLotterySchedule(store, { accountId: record.accountId, postId: record.postId }, now));
}

function rescheduleLotteryRequest(store, accountId, request, now = new Date()) {
  const postId = request.uniqueKey;
  const result = store.db.prepare(`
    UPDATE lottery_schedules SET scheduled_second = NULL
    WHERE account_id = ? AND post_id = ? AND scheduled_second = ?
  `).run(accountId, postId, request.userData.scheduledSecond);
  if (result.changes) ensureLotterySchedule(store, { accountId, postId }, now);
}

function nextHourlyDelaySeconds(records, now = new Date()) {
  const nowSecond = secondValueForTimeZone(now);
  const delays = records
    .filter((record) => Number.isFinite(record.scheduledSecond))
    .map((record) => Math.max(0, Math.ceil(record.scheduledSecond - nowSecond - LOTTERY_PREPARE_SECONDS)));
  return delays.length ? Math.min(...delays) : null;
}

async function waitForLotteryTime(page, scheduledSecond) {
  let remaining;
  while ((remaining = scheduledSecond - secondValueForTimeZone(new Date())) > 0) {
    await page.waitForTimeout(Math.min(remaining * 1000, 1000));
  }
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
      if (await clickLocator(locator.first())) return true;
    }
  }
  return false;
}

async function clickLocator(locator) {
  try {
    await locator.click();
    return true;
  } catch (error) {
    log.debug(`Normal click failed, trying fallback click: ${error.message}`);
  }

  try {
    await locator.scrollIntoViewIfNeeded();
    await locator.click({ force: true, timeout: 5000 });
    return true;
  } catch (error) {
    log.debug(`Force click failed, trying DOM click: ${error.message}`);
  }

  return locator.evaluate((element) => {
    element.click();
    return true;
  }).catch((error) => {
    log.warning(`DOM click fallback failed: ${error.message}`);
    return false;
  });
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
      const response = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
      if (response && !response.ok()) {
        throw new Error(`${reason}: HTTP ${response.status()} from ${target}`);
      }
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

async function blockPageMedia(page, loginUrl = LOGIN_URL) {
  const login = new URL(loginUrl);
  const loginPath = login.pathname.replace(/\/+$/, '');
  await page.route('**/*', async (route) => {
    const request = route.request();
    if (!['image', 'media'].includes(request.resourceType())) return route.continue();

    // Login assets can come from a CDN or a nested verification frame. Check
    // the owning document and its ancestors, rather than the asset's URL.
    for (let frame = request.frame(); frame; frame = frame.parentFrame()) {
      const url = new URL(frame.url() || 'about:blank');
      if (url.origin === login.origin && url.pathname.replace(/\/+$/, '') === loginPath) {
        return route.continue();
      }
    }
    return route.abort();
  });
}

async function isLoggedIn(page) {
  await waitForManualCheckpoint(page, 'Login check');
  const loginEntry = page.getByText('登录/注册', { exact: true });
  return !(await isVisible(loginEntry, 800));
}

async function fillLoginFormIfPossible(page, account) {
  if (!account.phone || !account.password) return false;

  const clickedPhoneLogin = await clickFirstVisible(page, [
    page.getByText('手机号注册登录', { exact: true }),
    page.locator('a,button,div,span').filter({ hasText: /^手机号注册登录$/ }),
  ], 1500).catch(() => false);
  if (!clickedPhoneLogin) {
    log.warning('Could not find 手机号注册登录 on the login page.');
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

async function waitForLoginCompletion(page, account) {
  const passwordInput = page.locator('input[type="password"]').first();
  try {
    // Successful phone login closes the form but can leave the login landing
    // page and its login-method labels visible. Verify the session after returning.
    await passwordInput.waitFor({ state: 'hidden', timeout: 20000 });
  } catch {
    log.warning(`[${account.id}] Automatic login did not finish within 20s. Please complete any remaining login step if a browser is visible.`);
    await page.bringToFront().catch(() => {});
    await passwordInput.waitFor({ state: 'hidden', timeout: CONFIG.manualTimeoutMs });
  }
}

async function ensureLoggedIn(page, account, returnUrl = page.url()) {
  if (await isLoggedIn(page)) return;

  log.info(`[${account.id}] Not logged in. Opening login page.`);
  await navigateTo(page, LOGIN_URL, 'Opening login page');
  await waitForManualCheckpoint(page, 'Opening login page');

  const filled = await fillLoginFormIfPossible(page, account);
  if (filled) {
    await waitForLoginCompletion(page, account);
  } else {
    log.warning(`[${account.id}] Could not fill the login form automatically. Complete login manually if a browser is visible.`);
    await page.bringToFront().catch(() => {});
    await page.waitForFunction(() => {
      const text = document.body?.innerText || '';
      return !document.querySelector('input[type="password"]')
        && !/手机号注册登录|登录\/注册/.test(text);
    }, null, { timeout: CONFIG.manualTimeoutMs });
  }

  const destination = returnUrl && new URL(returnUrl).pathname !== new URL(LOGIN_URL).pathname
    ? returnUrl : START_URL;
  await navigateTo(page, destination, 'Returning after login');
  if (!(await isLoggedIn(page))) {
    throw new Error(`[${account.id}] Login did not authenticate the account. Check the account credentials or verification.`);
  }
}

async function ensureInfoTab(page) {
  await waitForManualCheckpoint(page, 'Selecting info tab');
  const tabSelector = `${FEED_SELECTOR} .list-head .tabs-component-tab`;
  const infoTab = page.locator(tabSelector).filter({ hasText: /^\s*情报\s*$/ }).first();
  await infoTab.waitFor({ state: 'visible', timeout: 30000 });
  if (!(await infoTab.evaluate((tab) => tab.classList.contains('active')))) {
    await infoTab.click();
  }
  await page.waitForFunction((selector) => [...document.querySelectorAll(selector)]
    .some((tab) => tab.textContent.trim() === '情报' && tab.classList.contains('active')),
  tabSelector, { timeout: 30000 });
}

async function collectPostRequests(page) {
  const links = new Map();
  let roundsWithoutNewLinks = 0;

  await ensureInfoTab(page);
  await waitForManualCheckpoint(page, 'Collecting posts');
  await page.waitForSelector(FEED_POST_SELECTOR, { timeout: 30000 });

  for (let scroll = 0; scroll <= CONFIG.maxScrolls; scroll += 1) {
    await waitForManualCheckpoint(page, `Collecting posts, scroll ${scroll}`);
    const batch = await page.evaluate((selector) => {
      const exactText = (element) => (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
      return [...document.querySelectorAll(selector)]
        .filter((anchor) => {
          const rect = anchor.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        })
        .map((anchor) => ({
          url: anchor.href,
          text: exactText(anchor),
          publishedText: anchor.closest('.list-flow').querySelector('.user-line')?.innerText || '',
          className: anchor.className || '',
          parentClassName: anchor.parentElement?.className || '',
        }));
    }, FEED_POST_SELECTOR);

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
          publishedText: item.publishedText,
          className: item.className,
          parentClassName: item.parentClassName,
        },
      });
      addedThisRound += 1;
    }

    const atBottom = await page.evaluate(() => window.scrollY + window.innerHeight
      >= document.documentElement.scrollHeight - 5);
    if (addedThisRound === 0 && atBottom) {
      roundsWithoutNewLinks += 1;
    } else {
      roundsWithoutNewLinks = 0;
      if (addedThisRound > 0) log.info(`Discovered ${links.size} unique post links so far.`);
    }

    if (roundsWithoutNewLinks >= 6) {
      log.info('Stopping list scroll after 6 rounds at the bottom without new post links.');
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
  if (requests.length === 0) throw new Error('The info feed did not contain any post links.');
  return CONFIG.maxPosts > 0 ? requests.slice(0, CONFIG.maxPosts) : requests;
}

function crawlerBrowserPoolOptions() {
  return {
    // Crawlee replaces persistent-context viewports with fingerprint dimensions.
    fingerprintOptions: {
      fingerprintGeneratorOptions: {
        browsers: ['chrome'],
        devices: ['desktop'],
        operatingSystems: [{ darwin: 'macos', win32: 'windows' }[process.platform] || 'linux'],
        locales: ['en-US'],
        screen: {
          minWidth: CONFIG.viewportWidth,
          maxWidth: CONFIG.viewportWidth,
          minHeight: CONFIG.viewportHeight,
          maxHeight: CONFIG.viewportHeight,
        },
      },
    },
    // skipNavigation requests also need the resource filter before page.goto().
    postPageCreateHooks: [async (page) => {
      await blockPageMedia(page);
      const { width, height } = page.viewportSize();
      log.info(`Browser viewport: ${width}x${height}.`);
    }],
  };
}

function trackedActiveLotteryRequests(records, accountId, now = new Date()) {
  return records.flatMap((record) => {
    if (record.accountId !== accountId) return [];

    const drawAt = normalizeChineseDateText(record.drawAt || '');
    if (!drawAt || isDrawTimeCompleted(drawAt, now)) return [];

    let url;
    try {
      url = normalizePostUrl(record.url);
    } catch {
      return [];
    }
    if (!url) return [];

    return [{
      url,
      uniqueKey: postIdFromUrl(url),
      skipNavigation: true,
      userData: {
        label: 'POST',
        drawAt,
        listText: record.title || '',
        source: 'tracked-active-lottery',
      },
    }];
  }).sort((left, right) => left.userData.drawAt.localeCompare(right.userData.drawAt));
}

function loadTrackedActiveLotteryRequests(store, accountId, now = new Date()) {
  return trackedActiveLotteryRequests(listTrackedLotteries(store), accountId, now);
}

function nextHourlyLotteryRequest(store, accountIds, now = new Date()) {
  const records = refreshLotterySchedules(store, now)
    .filter((record) => accountIds.has(record.accountId) && Number.isFinite(record.scheduledSecond))
    .sort((left, right) => left.scheduledSecond - right.scheduledSecond);
  for (const record of records) {
    if (nextHourlyDelaySeconds([record], now) > 0) return null;
    const [request] = trackedActiveLotteryRequests([record], record.accountId, now);
    if (!request) continue;
    return { accountId: record.accountId, request: {
      ...request,
      userData: { ...request.userData, scheduledSecond: record.scheduledSecond },
    } };
  }
  return null;
}

function mergePostRequests(...requestGroups) {
  const requestsByPostId = new Map();

  for (const requests of requestGroups) {
    for (const request of requests) {
      let url;
      try {
        url = normalizePostUrl(request.url);
      } catch {
        continue;
      }
      if (!url) continue;

      const postId = postIdFromUrl(url);
      requestsByPostId.set(postId, {
        ...request,
        url,
        uniqueKey: postId,
        skipNavigation: true,
        userData: {
          label: 'POST',
          ...(request.userData || {}),
        },
      });
    }
  }

  return [...requestsByPostId.values()];
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

function normalizeChineseDateText(rawText) {
  const cleaned = rawText
    .replace(/[年月]/g, '-')
    .replace(/[日号]/g, '')
    .replace(/\//g, '-')
    .replace(/\./g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  const match = cleaned.match(/^(20\d{2})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (!match) return '';
  const pad = (value) => String(value).padStart(2, '0');
  const dateText = `${match[1]}-${pad(match[2])}-${pad(match[3])}`;
  return match[4] ? `${dateText} ${pad(match[4])}:${match[5]}` : dateText;
}

function parseChineseDate(rawText) {
  const normalized = normalizeChineseDateText(rawText);
  const match = normalized.match(/^(20\d{2})-(\d{2})-(\d{2})(?:\s+(\d{2}):(\d{2}))?$/);
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

function parseDrawAtFromText(text) {
  const normalized = compactText(text);
  const match = normalized.match(/(?:抽签|抽奖|开奖)\s*时间\s*[：:]?\s*((?:20\d{2})[.\-/年]\s*\d{1,2}[.\-/月]\s*\d{1,2}(?:[日号])?\s+\d{1,2}:\d{2})/);
  if (!match) return { drawAt: '', drawText: '' };

  return {
    drawAt: normalizeChineseDateText(match[1]),
    drawText: match[1],
  };
}

function isDrawTimeCompleted(drawAt, now = new Date()) {
  const normalized = normalizeChineseDateText(drawAt);
  return Boolean(normalized && normalized <= dateTimeMinuteKeyForTimeZone(now));
}

function dailyEngagementCountFor(record, dateKey) {
  if (!record || record.lastEngagedDate !== dateKey) return 0;
  return Math.max(0, Number(record.dailyEngagementCount) || 0);
}

function saveExistingEngagementMetadata(store, existingEngagement, updates) {
  // Discovery must not overwrite an engagement concurrently saved by the worker.
  store.db.prepare(`
    UPDATE engaged_lotteries SET title = ?, url = ?, draw_at = ?
    WHERE account_id = ? AND post_id = ?
  `).run(updates.title || existingEngagement.title, updates.url || existingEngagement.url,
    updates.drawAt || existingEngagement.drawAt, existingEngagement.accountId, existingEngagement.postId);
}

async function extractPostMeta(page, request) {
  const text = await page.locator('body').innerText({ timeout: 30000 });
  const title = await page.title().then((value) => value.replace(/\s+-\s+zFrontier.*$/i, '').trim()).catch(() => '');

  const publishLineMatch = text.match(/([^\n]*(?:秒|分钟|小时|天)前\s+从\s+[^\n]+发布|[^\n]*(?:昨天|前天)\s+\d{1,2}:\d{2}\s+从\s+[^\n]+发布|[^\n]*20\d{2}[.\-/年]\s*\d{1,2}[.\-/月]\s*\d{1,2}[日号]?(?:\s+\d{1,2}:\d{2})?\s+从\s+[^\n]+发布)/);
  const publishSource = publishLineMatch ? publishLineMatch[1] : `${request.userData.listText || ''} ${text.slice(0, 3000)}`;
  const parsed = parsePublishedAtFromText(publishSource);
  const draw = parseDrawAtFromText(text);

  return {
    title,
    bodyText: text,
    drawAt: draw.drawAt,
    drawText: draw.drawText,
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

async function clickConfirmIfVisible(page, canEngage) {
  for (const locator of [
    page.getByText('确定', { exact: true }),
    page.getByText('确认', { exact: true }),
    page.getByText(RUSH_TEXT, { exact: true }),
    page.locator('a,button,.submit').filter({ hasText: RUSH_TEXT }),
  ]) {
    if (!(await isVisible(locator, 1500))) continue;
    await locator.first().scrollIntoViewIfNeeded().catch(() => {});
    if (!canEngage()) return { expired: true };
    const engagedAt = new Date().toISOString();
    await locator.first().click();
    return { engagedAt };
  }
  return {};
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
  await ensureLoggedIn(page, account, SIGN_IN_URL);
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

async function engageLottery(page, canEngage) {
  const button = await visibleLotteryButton(page);
  if (!button) return { engaged: false, reason: `No visible "${LOTTERY_TEXT}" button` };

  if (CONFIG.dryRun) {
    return { engaged: false, reason: `Dry run: would click "${LOTTERY_TEXT}"` };
  }

  await button.scrollIntoViewIfNeeded().catch(() => {});
  if (!canEngage()) return { engaged: false, reason: 'Hourly engagement is no longer due' };
  let engagedAt = new Date().toISOString();
  await button.click();
  await waitForManualCheckpoint(page, 'After clicking lottery');
  await page.waitForTimeout(1000);
  if (!canEngage()) return { engaged: false, reason: 'Hourly engagement window ended before confirmation' };
  const confirmation = await clickConfirmIfVisible(page, canEngage);
  if (confirmation.expired) return { engaged: false, reason: 'Hourly engagement window ended before confirmation' };
  engagedAt = confirmation.engagedAt || engagedAt;
  await waitForManualCheckpoint(page, 'After confirming lottery');
  await page.waitForTimeout(2000);

  const text = await page.locator('body').innerText().catch(() => '');
  if (/已(参与|参加|抽奖|报名)|参与成功|回复成功|提交成功|冲冲冲/.test(text)) {
    return { engaged: true, engagedAt, reason: 'Clicked lottery action and detected a success/participation hint' };
  }

  return { engaged: true, engagedAt, reason: 'Clicked lottery action; no explicit failure was detected' };
}

async function processPost(page, postRequest, engagedStore, account) {
  const postUrl = normalizePostUrl(postRequest.url);
  const postId = postIdFromUrl(postUrl);
  const existingEngagement = getEngagement(engagedStore, account.id, postId);
  const existingSchedule = getLotterySchedule(engagedStore, account.id, postId);
  if (existingEngagement?.drawAt && isDrawTimeCompleted(existingEngagement.drawAt)) {
    log.info(`[${account.id}] Skipping ${postId}: draw time ${existingEngagement.drawAt} has passed.`);
    return;
  }

  await navigateTo(page, postUrl, `Opening post ${postId}`);
  await waitForManualCheckpoint(page, `Opening post ${postId}`);
  await ensureLoggedIn(page, account, postUrl);
  const meta = await extractPostMeta(page, postRequest);
  const drawAt = meta.drawAt || existingSchedule?.drawAt || existingEngagement?.drawAt || postRequest.userData.drawAt || '';

  if (existingEngagement && meta.drawAt && meta.drawAt !== existingEngagement.drawAt) {
    saveExistingEngagementMetadata(engagedStore, existingEngagement, {
      url: postUrl,
      title: meta.title,
      drawAt: meta.drawAt,
    });
    renderEngagementHtml(engagedStore);
    log.info(`[${account.id}] Backfilled draw time for ${postId}: ${meta.drawAt}.`);
  }

  const hasLottery = meta.bodyText.includes('抽奖');

  if (!hasLottery) {
    log.info(`[${account.id}] Skipping ${postId}: no lottery text found.`);
    return;
  }

  if (!drawAt) {
    log.info(`[${account.id}] Skipping ${postId}: draw time is unknown.`);
    return;
  }

  if (isDrawTimeCompleted(drawAt)) {
    if (existingSchedule) {
      saveLotterySchedule(engagedStore, { ...existingSchedule, drawAt, scheduledSecond: null });
    }
    log.info(`[${account.id}] Skipping ${postId}: draw time ${drawAt} has passed.`);
    return;
  }

  if (!existingEngagement && !existingSchedule && !isWithinPublishWindow(meta.publishedAt)) {
    const dateText = meta.publishedAt ? meta.publishedAt.toISOString() : 'unknown date';
    log.info(`[${account.id}] Skipping ${postId}: published ${dateText}, outside the last ${CONFIG.publishWindowDays} days.`);
    return;
  }

  const schedule = ensureLotterySchedule(engagedStore, {
    accountId: account.id, postId, url: postUrl, title: meta.title, drawAt,
  });
  const scheduledSecond = postRequest.userData.scheduledSecond;
  if (!Number.isFinite(scheduledSecond) || schedule.scheduledSecond !== scheduledSecond) {
    log.info(`[${account.id}] Scheduled ${postId} for ${schedule.scheduledSecond === null ? 'no remaining slot' : new Date(schedule.scheduledSecond * 1000).toISOString().replace('T', ' ').replace('.000Z', '') + ' ' + CONFIG.signInTimeZone}.`);
    return;
  }
  log.info(`[${account.id}] ${postId}: waiting for its scheduled time ${new Date(scheduledSecond * 1000).toISOString().slice(0, 19)} ${CONFIG.signInTimeZone}.`);
  await waitForLotteryTime(page, scheduledSecond);
  const canEngage = () => {
    const current = getLotterySchedule(engagedStore, account.id, postId);
    return current?.scheduledSecond === scheduledSecond && isHourlyEngagementDue({
      ...current,
      engagedAt: getEngagement(engagedStore, account.id, postId)?.engagedAt,
    });
  };
  if (!canEngage()) {
    log.info(`[${account.id}] Skipping ${postId}: waiting for its next random hourly engagement (07:30–24:00 ${CONFIG.signInTimeZone}).`);
    return;
  }

  if (/已(参与|参加|抽奖|报名)/.test(meta.bodyText) && !(await visibleLotteryButton(page))) {
    log.info(`[${account.id}] Skipping ${postId}: page appears to already be participated.`);
    return;
  }

  const thumbResult = await clickThumbUpIfPossible(page);
  log.info(`[${account.id}] ${postId}: ${thumbResult.reason}.`);

  const result = await engageLottery(page, canEngage);
  if (!result.engaged) {
    log.info(`[${account.id}] Skipping ${postId}: ${result.reason}.`);
    return;
  }

  const engagedAt = result.engagedAt;
  const today = dateKeyForTimeZone(new Date(engagedAt));
  const dailyCount = dailyEngagementCountFor(getEngagement(engagedStore, account.id, postId), today);
  saveEngagement(engagedStore, {
    accountId: account.id,
    postId,
    url: postUrl,
    title: meta.title,
    drawAt,
    lastEngagedDate: today,
    dailyEngagementCount: dailyCount + 1,
    engagedAt,
  });
  renderEngagementHtml(engagedStore);
  log.info(`[${account.id}] Recorded hourly engagement for lottery post ${postId} (${dailyCount + 1} for ${today}, scheduled ${scheduledSecond}, sent ${engagedAt}): ${meta.title || postUrl}`);
}

async function main() {
  log.setLevel(log.LEVELS.INFO);

  const engagedStore = openEngagedStore(ENGAGED_DB, ENGAGED_HTML);
  const accounts = loadAccounts(engagedStore);
  if (CONFIG.messagesOnly) initializeMessageSync(engagedStore, accounts.map((account) => account.id));
  renderEngagementHtml(engagedStore);

  accounts
    .filter((account) => !account.phone || !account.password)
    .forEach((account) => {
      log.warning(`[${account.id}] Phone/password are not fully configured. Complete login manually in the browser if needed.`);
    });
  if (CONFIG.dryRun) {
    log.warning('Dry run is enabled. The crawler will not click lottery buttons.');
  }

  const selected = CONFIG.trackedOnly
    ? nextHourlyLotteryRequest(engagedStore, new Set(accounts.map((account) => account.id)))
    : null;
  const accountsToRun = CONFIG.trackedOnly
    ? accounts.filter((account) => account.id === selected?.accountId)
    : accounts;
  const failedAccounts = [];
  for (const account of accountsToRun) {
    try {
      await runAccount(account, engagedStore, accounts.length, selected?.request);
    } catch (error) {
      failedAccounts.push(account.id);
      if (CONFIG.messagesOnly) saveMessageSyncError(engagedStore, account.id, 'Could not fetch private messages. Check the account login or ZF verification.');
      log.exception(error, `[${account.id}] Account run failed`);
    } finally {
      if (selected) rescheduleLotteryRequest(engagedStore, account.id, selected.request);
    }
  }

  renderEngagementHtml(engagedStore);
  log.info(`Done. Recorded ${countEngagements(engagedStore)} engaged lottery posts and ${countSignIns(engagedStore)} daily sign-ins in ${ENGAGED_DB}.`);
  if (failedAccounts.length > 0) {
    log.warning(`Failed accounts this run: ${failedAccounts.join(', ')}`);
  }
  log.info(`View records at ${ENGAGED_HTML}.`);
  engagedStore.db.close();

  if (failedAccounts.length > 0) {
    throw new Error(`Failed accounts: ${failedAccounts.join(', ')}.`);
  }
}

async function processPostRequests(page, postRequests, engagedStore, account) {
  for (const postRequest of postRequests) {
    const { publishedAt } = parsePublishedAtFromText(postRequest.userData.publishedText || '');
    const postId = postIdFromUrl(postRequest.url);
    if (publishedAt && Date.now() - publishedAt.getTime() > PUBLISH_WINDOW_MS
      && !getEngagement(engagedStore, account.id, postId)
      && !getLotterySchedule(engagedStore, account.id, postId)) {
      continue;
    }
    try {
      await processPost(page, postRequest, engagedStore, account);
    } catch (error) {
      log.error(`[${account.id}] Failed while processing ${postRequest.url}: ${error.message}`);
    }
  }
}

async function runAccount(account, engagedStore, accountCount, scheduledRequest) {
  // Scheduler polls only need SQLite; load the browser stack for actual jobs.
  const { PlaywrightCrawler, RequestQueue } = require('crawlee');
  const { chromium } = require('playwright');
  const requestQueue = await RequestQueue.open(`zfrontier-${CONFIG.messagesOnly ? 'messages' : scheduledRequest ? 'lottery' : 'discovery'}-${account.id}-${Date.now()}`);
  await requestQueue.addRequest({
    url: START_URL,
    uniqueKey: `zfrontier-info-list-${account.id}`,
    skipNavigation: true,
    userData: { label: 'LIST' },
  });

  let listPageFailed = false;
  const userDataDir = CONFIG.messagesOnly
    ? path.join(PROFILE_DIR, 'private-messages', account.id)
    : scheduledRequest ? profileDirForAccount(account, accountCount)
      : path.join(PROFILE_DIR, 'discovery', account.id);
  log.info(`[${account.id}] Starting crawler with profile ${userDataDir}.`);

  const crawler = new PlaywrightCrawler({
    requestQueue,
    maxConcurrency: 1,
    maxRequestRetries: CONFIG.messagesOnly || scheduledRequest ? 0 : 1,
    navigationTimeoutSecs: 60,
    // A blocked single-post attempt must release the worker for other timers.
    requestHandlerTimeoutSecs: CONFIG.messagesOnly ? 300 : scheduledRequest ? 60 : CONFIG.requestTimeoutSecs,
    launchContext: {
      launcher: chromium,
      useChrome: CONFIG.useChrome,
      proxyUrl: CONFIG.proxyUrl || undefined,
      userDataDir,
      useIncognitoPages: false,
      launchOptions: {
        headless: CONFIG.headless,
        // Service workers can serve resources without passing through page.route().
        serviceWorkers: 'block',
        viewport: { width: CONFIG.viewportWidth, height: CONFIG.viewportHeight },
      },
    },
    browserPoolOptions: crawlerBrowserPoolOptions(),
    preNavigationHooks: [
      async (_crawlingContext, gotoOptions) => {
        gotoOptions.waitUntil = 'domcontentloaded';
        gotoOptions.timeout = 60000;
      },
    ],
    requestHandler: async ({ page, request }) => {
      if (request.userData.label === 'LIST') {
        if (scheduledRequest) {
          await processPost(page, scheduledRequest, engagedStore, account);
          return;
        }
        await navigateTo(page, START_URL, 'Opening list page');
        await waitForManualCheckpoint(page, 'Opening list page');
        await ensureLoggedIn(page, account, START_URL);

        if (CONFIG.messagesOnly) {
          const count = await fetchPrivateMessages(page, engagedStore, account.id);
          log.info(`[${account.id}] Fetched ${count} private message conversations.`);
          return;
        }

        await performDailySignIn(page, engagedStore, account);
        await navigateTo(page, START_URL, 'Reloading list page before feed discovery');

        const discoveredPostRequests = mergePostRequests(await collectPostRequests(page));
        log.info(`[${account.id}] Discovering lottery schedules from ${discoveredPostRequests.length} post pages.`);
        await processPostRequests(page, discoveredPostRequests, engagedStore, account);
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

function printNextHourlyDelay() {
  const engagedStore = openEngagedStore(ENGAGED_DB, ENGAGED_HTML);
  try {
    const enabledAccountIds = new Set(loadAccounts(engagedStore).map((account) => account.id));
    const records = refreshLotterySchedules(engagedStore)
      .filter((record) => enabledAccountIds.has(record.accountId));
    const delay = nextHourlyDelaySeconds(records);
    process.stdout.write(delay === null ? 'none\n' : `${delay}\n`);
  } finally {
    engagedStore.db.close();
  }
}

function finishCrawlerProcess(exitCode, graceMs = 5000) {
  process.exitCode = exitCode;
  // Native browser crashes can leave handles alive after Crawlee has torn down.
  // Let normal shutdown/log flushing finish, but do not hold the worker forever.
  setTimeout(() => {
    log.warning(`Crawler finished, but shutdown exceeded ${graceMs}ms; exiting.`);
    process.exit(exitCode);
  }, graceMs).unref();
}

if (require.main === module) {
  if (hasFlag('--next-hourly-delay')) {
    try {
      printNextHourlyDelay();
    } catch (error) {
      log.exception(error, 'Failed to calculate the next hourly run');
      process.exitCode = 1;
    }
  } else {
    main().then(() => finishCrawlerProcess(0), (error) => {
      log.exception(error, 'Crawler failed');
      finishCrawlerProcess(1);
    });
  }
}

module.exports = {
  blockPageMedia,
  collectPostRequests,
  crawlerBrowserPoolOptions,
  engageLottery,
  ensureLoggedIn,
  ensureLotterySchedule,
  finishCrawlerProcess,
  isDrawTimeCompleted,
  isHourlyEngagementDue,
  nextHourlyLotteryRequest,
  loadTrackedActiveLotteryRequests,
  mergePostRequests,
  nextHourlyDelaySeconds,
  nextHourlyEngagementSecond,
  processPost,
  processPostRequests,
  refreshLotterySchedules,
  rescheduleLotteryRequest,
  saveExistingEngagementMetadata,
  trackedActiveLotteryRequests,
};
