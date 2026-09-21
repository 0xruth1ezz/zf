#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { default: log } = require('@apify/log');
const {
  getEngagement,
  getLotterySchedule,
  listAccounts,
  listTrackedLotteries,
  openEngagedStore,
  saveLotterySchedule,
} = require('./engaged-store');

const ROOT_DIR = __dirname;
dotenv.config({ path: process.env.ENV_FILE || path.join(ROOT_DIR, '.env'), quiet: true });

const START_URL = process.env.ZF_START_URL || 'https://www.zfrontier.com/app/#info';
const LOGIN_URL = process.env.ZF_LOGIN_URL || 'https://www.zfrontier.com/app/login';
const PROFILE_DIR = process.env.ZF_PROFILE_DIR || path.join(ROOT_DIR, '.browser-profile');
const ENGAGED_DB = process.env.ZF_ENGAGED_DB || path.join(ROOT_DIR, 'engaged-lotteries.sqlite');
const ENGAGED_HTML = process.env.ZF_ENGAGED_HTML || path.join(ROOT_DIR, 'engaged-lotteries.html');

const CONFIG = {
  publishWindowDays: numberFromEnv('ZF_DAYS', 7),
  signInTimeZone: process.env.ZF_SIGN_IN_TZ || 'Asia/Shanghai',
  maxScrolls: numberFromEnv('MAX_SCROLLS', 80),
  maxPosts: numberFromEnv('MAX_POSTS', 0),
  manualTimeoutMs: numberFromEnv('MANUAL_TIMEOUT_MS', 10 * 60 * 1000),
  viewportWidth: Math.max(960, numberFromEnv('VIEWPORT_WIDTH', 1920)),
  viewportHeight: Math.max(720, numberFromEnv('VIEWPORT_HEIGHT', 1080)),
  dryRun: hasFlag('--dry-run') || process.env.DRY_RUN === '1',
  trackedOnly: hasFlag('--tracked-only'),
  messagesOnly: hasFlag('--messages-only'),
  headless: hasFlag('--headless') || process.env.HEADLESS === '1',
  useChrome: process.env.USE_CHROME !== '0',
  proxyUrl: process.env.PROXY_URL || '',
};

const LOTTERY_PREPARE_SECONDS = 30;
const LOTTERY_LATE_SECONDS = 15;
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
  if (record?.attemptedHours?.includes(hourStart)) return true;
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
    schedule.attemptedHours = store.db.prepare(`
      SELECT hour_start FROM lottery_attempts WHERE account_id = ? AND post_id = ?
        AND hour_start >= ?
    `).all(record.accountId, record.postId, Math.floor(secondValueForTimeZone(now) / 86400) * 86400)
      .map((row) => row.hour_start);
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

function isDrawTimeCompleted(drawAt, now = new Date()) {
  const normalized = normalizeChineseDateText(drawAt);
  return Boolean(normalized && normalized <= dateTimeMinuteKeyForTimeZone(now));
}

function saveExistingEngagementMetadata(store, existingEngagement, updates) {
  // Discovery must not overwrite an engagement concurrently saved by the worker.
  store.db.prepare(`
    UPDATE engaged_lotteries SET title = ?, url = ?, draw_at = ?
    WHERE account_id = ? AND post_id = ?
  `).run(updates.title || existingEngagement.title, updates.url || existingEngagement.url,
    updates.drawAt || existingEngagement.drawAt, existingEngagement.accountId, existingEngagement.postId);
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

module.exports = {
  CONFIG, START_URL, ENGAGED_DB, ENGAGED_HTML, PROFILE_DIR,
  loadAccounts, dateKeyForTimeZone, dateTimeMinuteValue, secondValueForTimeZone,
  navigateTo, profileDirForAccount,
  blockPageMedia,
  crawlerBrowserPoolOptions,
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
  refreshLotterySchedules,
  rescheduleLotteryRequest,
  saveExistingEngagementMetadata,
  trackedActiveLotteryRequests,
};

if (require.main === module) {
  if (hasFlag('--next-hourly-delay')) {
    try {
      printNextHourlyDelay();
    } catch (error) {
      log.exception(error, 'Failed to calculate the next hourly run');
      process.exitCode = 1;
    }
  } else {
    require('./http-worker').run().then(() => finishCrawlerProcess(0), (error) => {
      log.exception(error, 'Crawler failed');
      finishCrawlerProcess(1);
    });
  }
}
