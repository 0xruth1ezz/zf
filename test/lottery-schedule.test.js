const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

process.env.ZF_SIGN_IN_TZ = 'Asia/Shanghai';
const {
  engageLottery,
  ensureLotterySchedule,
  isHourlyEngagementDue,
  loadHourlyLotteryRequests,
  loadTrackedActiveLotteryRequests,
  nextHourlyDelaySeconds,
  nextHourlyEngagementSecond,
  processPost,
  refreshLotterySchedules,
} = require('../zfrontier-lottery-crawler');
const {
  getEngagement, getLotterySchedule, listEngagements, openEngagedStore, saveEngagement,
} = require('../engaged-store');

const localDate = (value) => new Date(`${value}+08:00`);
const localSecond = (value) => Date.parse(`${value}Z`) / 1000;
const dateForSecond = (value) => new Date((value - 8 * 3600) * 1000);
const lottery = (postId = 'post', accountId = 'primary', drawAt = '2026-09-22 12:00') => ({
  accountId, postId, url: `https://www.zfrontier.com/app/flow/${postId}`, title: postId, drawAt,
});

function createStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-schedule-'));
  const store = openEngagedStore(path.join(dir, 'test.sqlite'), path.join(dir, 'report.html'));
  t.after(() => { store.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return store;
}

test('each account/post gets a persisted random time, including never-engaged discoveries', (t) => {
  const store = createStore(t);
  const now = localDate('2026-09-20T06:00:00');
  const first = ensureLotterySchedule(store, lottery(), now, () => 0.1);
  const otherPost = ensureLotterySchedule(store, lottery('other'), now, () => 0.9);
  const otherAccount = ensureLotterySchedule(store, lottery('post', 'secondary'), now, () => 0.5);
  assert.equal(first.scheduledSecond, localSecond('2026-09-20T07:33:00'));
  assert.equal(otherPost.scheduledSecond, localSecond('2026-09-20T07:57:00'));
  assert.equal(otherAccount.scheduledSecond, localSecond('2026-09-20T07:45:00'));
  assert.equal(listEngagements(store).length, 0);
  assert.equal(loadTrackedActiveLotteryRequests(store, 'primary', now).length, 2);

  store.db.close();
  store.db = openEngagedStore(store.dbPath, store.htmlPath).db;
  const due = localDate('2026-09-20T07:34:00');
  assert.equal(ensureLotterySchedule(store, lottery(), due, () => {
    throw new Error('An existing plan must not be randomized again');
  }).scheduledSecond, first.scheduledSecond);
  assert.deepEqual(loadHourlyLotteryRequests(store, 'primary', due).map((r) => r.uniqueKey), ['post']);
  assert.deepEqual(loadHourlyLotteryRequests(store, 'secondary', due), []);
});

test('a full day allows one success in each of 17 slots, then waits until next morning', (t) => {
  const store = createStore(t);
  let now = localDate('2026-09-20T06:00:00');
  for (let hour = 7; hour < 24; hour += 1) {
    const schedule = ensureLotterySchedule(store, lottery(), now, () => 0.5);
    const expected = `2026-09-20T${String(hour).padStart(2, '0')}:${hour === 7 ? '45' : '30'}:00`;
    assert.equal(schedule.scheduledSecond, localSecond(expected));
    now = dateForSecond(schedule.scheduledSecond);
    assert.equal(isHourlyEngagementDue(schedule, new Date(now.getTime() - 1)), false);
    assert.equal(isHourlyEngagementDue(schedule, now), true);
    saveEngagement(store, { ...lottery(), engagedAt: now.toISOString(),
      lastEngagedDate: '2026-09-20', dailyEngagementCount: hour - 6 });
    assert.equal(isHourlyEngagementDue({ ...schedule, ...getEngagement(store, 'primary', 'post') }, now), false);
  }
  assert.equal(getEngagement(store, 'primary', 'post').dailyEngagementCount, 17);
  const next = ensureLotterySchedule(store, lottery(), now, () => 0.5);
  assert.equal(next.scheduledSecond, localSecond('2026-09-21T07:45:00'));
  assert.equal(isHourlyEngagementDue(next, localDate('2026-09-21T00:00:00')), false);
  assert.equal(isHourlyEngagementDue(next, localDate('2026-09-21T07:45:00')), true);
});

test('late discovery uses the remaining hour; missed hours are not replayed', () => {
  const now = localDate('2026-09-20T10:40:00');
  const expected = localSecond('2026-09-20T10:50:00');
  assert.equal(nextHourlyEngagementSecond(lottery(), now, () => 0.5), expected);
  const missed = { ...lottery(), scheduledSecond: localSecond('2026-09-20T08:30:00') };
  assert.equal(isHourlyEngagementDue(missed, now), false);
  assert.equal(nextHourlyEngagementSecond(missed, now, () => 0.5), expected);
});

test('opening, midnight, and draw boundaries are exclusive at the end', () => {
  const opening = { ...lottery(), scheduledSecond: localSecond('2026-09-20T07:30:00') };
  assert.equal(isHourlyEngagementDue(opening, localDate('2026-09-20T07:29:59.999')), false);
  assert.equal(isHourlyEngagementDue(opening, localDate('2026-09-20T07:30:00')), true);
  assert.equal(isHourlyEngagementDue(opening, localDate('2026-09-20T08:00:00')), false);
  const closing = { ...lottery(), scheduledSecond: localSecond('2026-09-20T23:30:00') };
  assert.equal(isHourlyEngagementDue(closing, localDate('2026-09-20T23:59:59.999')), true);
  assert.equal(isHourlyEngagementDue(closing, localDate('2026-09-21T00:00:00')), false);
  const drawing = { ...opening, drawAt: '2026-09-20 07:40' };
  assert.equal(isHourlyEngagementDue(drawing, localDate('2026-09-20T07:39:59.999')), true);
  assert.equal(isHourlyEngagementDue(drawing, localDate('2026-09-20T07:40:00')), false);
});

test('draw deadlines truncate random windows without an extra pre-draw participation', () => {
  const record = lottery('post', 'primary', '2026-09-20 10:25');
  const now = localDate('2026-09-20T10:00:00');
  assert.equal(nextHourlyEngagementSecond(record, now, () => 0.5), localSecond('2026-09-20T10:12:30'));
  assert.equal(nextHourlyEngagementSecond({ ...record, engagedAt: now.toISOString() }, now), null);
  assert.equal(nextHourlyEngagementSecond(record, localDate('2026-09-20T10:25:00')), null);
  assert.equal(nextHourlyEngagementSecond({ ...record, drawAt: '' }, now), null);
  assert.equal(nextHourlyEngagementSecond({ ...record, drawAt: '2026-09-21 07:30' },
    localDate('2026-09-21T00:00:00')), null);
});

test('random endpoints stay inside the first half hour and the last hour', () => {
  assert.equal(nextHourlyEngagementSecond(lottery(), localDate('2026-09-20T06:00:00'), () => 0),
    localSecond('2026-09-20T07:30:00'));
  assert.equal(nextHourlyEngagementSecond(lottery(), localDate('2026-09-20T06:00:00'), () => 1 - Number.EPSILON),
    localSecond('2026-09-20T07:59:59'));
  assert.equal(nextHourlyEngagementSecond(lottery(), localDate('2026-09-20T23:00:00'), () => 1 - Number.EPSILON),
    localSecond('2026-09-20T23:59:59'));
});

test('legacy successful posts enter the schedule without repeating an already-engaged hour', (t) => {
  const store = createStore(t);
  const now = localDate('2026-09-20T09:40:00');
  saveEngagement(store, { ...lottery(), engagedAt: localDate('2026-09-20T09:10:00').toISOString(),
    lastEngagedDate: '2026-09-20', dailyEngagementCount: 2 });
  const schedules = refreshLotterySchedules(store, now);
  assert.equal(schedules.length, 1);
  assert.ok(schedules[0].scheduledSecond >= localSecond('2026-09-20T10:00:00'));
  assert.ok(schedules[0].scheduledSecond < localSecond('2026-09-20T11:00:00'));
  assert.equal(getLotterySchedule(store, 'primary', 'post').scheduledSecond, schedules[0].scheduledSecond);
  assert.deepEqual(loadHourlyLotteryRequests(store, 'primary', now), []);
});

test('scheduler wakes for the earliest persisted time and retries overdue work within its hour', (t) => {
  const store = createStore(t);
  const now = localDate('2026-09-20T09:00:30.500');
  const first = ensureLotterySchedule(store, lottery(), now, () => 0.1);
  const second = ensureLotterySchedule(store, lottery('other'), now, () => 0.9);
  assert.equal(nextHourlyDelaySeconds([second, first], now), Math.ceil(first.scheduledSecond - localSecond('2026-09-20T09:00:30.500')));
  assert.equal(nextHourlyDelaySeconds([first], dateForSecond(first.scheduledSecond + 1)), 0);
  assert.equal(nextHourlyDelaySeconds([]), null);
  const afterDraw = localDate('2026-09-22T12:00:00');
  assert.equal(nextHourlyDelaySeconds(refreshLotterySchedules(store, afterDraw), afterDraw), null);
});

function fakeLotteryPage(onScroll = () => {}) {
  const clicks = [];
  const locator = (kind) => {
    const value = {
      first: () => value, filter: () => value, waitFor: async () => {},
      scrollIntoViewIfNeeded: async () => onScroll(kind),
      click: async () => { clicks.push(kind); },
      innerText: async () => '参与成功',
    };
    return value;
  };
  return { clicks, page: {
    locator: () => locator('lottery'), getByText: () => locator('confirm'),
    evaluate: async () => false, waitForTimeout: async () => {},
  } };
}

test('lottery and confirmation clicks recheck eligibility after browser waits', async () => {
  for (const expiresAt of ['lottery', 'confirm']) {
    let eligible = true;
    const { page, clicks } = fakeLotteryPage((kind) => { if (kind === expiresAt) eligible = false; });
    const result = await engageLottery(page, () => eligible);
    assert.equal(result.engaged, false);
    assert.deepEqual(clicks, expiresAt === 'lottery' ? [] : ['lottery']);
  }
  const { page, clicks } = fakeLotteryPage();
  const result = await engageLottery(page, () => true);
  assert.equal(result.engaged, true);
  assert.ok(Number.isFinite(Date.parse(result.engagedAt)));
  assert.deepEqual(clicks, ['lottery', 'confirm']);
});

test('processing a newly found post waits for its plan, records once per hour, and exceeds the old daily cap', async (t) => {
  const store = createStore(t);
  t.mock.timers.enable({ apis: ['Date'], now: localDate('2026-09-20T06:00:00').getTime() });
  t.mock.method(Math, 'random', () => 0.5);
  const { page, clicks } = fakeLotteryPage();
  const getByText = page.getByText;
  page.getByText = (text) => text === '登录/注册'
    ? { first: () => ({ waitFor: async () => { throw new Error('No login link'); } }) }
    : getByText(text);
  page.goto = async () => {};
  page.waitForLoadState = async () => {};
  page.title = async () => 'Test lottery';
  const locator = page.locator;
  let drawAt = '2026-09-22 12:00';
  page.locator = (selector) => selector === 'body'
    ? { innerText: async () => `1小时前 从 web 发布\n抽奖\n开奖时间：${drawAt}` }
    : locator(selector);
  const request = { url: lottery().url, userData: {} };
  const account = { id: 'primary' };
  await processPost(page, request, store, account);
  assert.equal(clicks.length, 0);
  assert.equal(getEngagement(store, 'primary', 'post'), undefined);
  assert.equal(getLotterySchedule(store, 'primary', 'post').scheduledSecond, localSecond('2026-09-20T07:45:00'));

  for (const [index, time] of ['07:45', '08:30', '09:30'].entries()) {
    const schedule = getLotterySchedule(store, 'primary', 'post');
    t.mock.timers.setTime(localDate(`2026-09-20T${time}:00`).getTime());
    await processPost(page, request, store, account);
    assert.equal(getEngagement(store, 'primary', 'post').dailyEngagementCount, index + 1);
    assert.equal(clicks.length, (index + 1) * 2);
    assert.equal(isHourlyEngagementDue({ ...schedule, ...getEngagement(store, 'primary', 'post') }), false);
    await processPost(page, request, store, account);
    assert.equal(clicks.length, (index + 1) * 2);
  }

  // A corrected draw time must also cancel the saved schedule, not cause retry wakeups.
  drawAt = '2026-09-20 09:00';
  await processPost(page, request, store, account);
  assert.equal(getLotterySchedule(store, 'primary', 'post').scheduledSecond, null);
  assert.equal(nextHourlyDelaySeconds(refreshLotterySchedules(store)), null);
});

test('frequent hourly wakeups do not postpone regular feed discovery', () => {
  const entrypoint = fs.readFileSync(path.join(__dirname, '../docker/entrypoint.sh'), 'utf8');
  const functions = entrypoint.slice(entrypoint.indexOf('run_crawler_once()'), entrypoint.indexOf('cleanup()'));
  const result = spawnSync('bash', ['-c', `${functions}
    CRAWL_INTERVAL_SECONDS=3600
    RUN_ON_START=0
    SECONDS=0
    runs=0
    node() { echo 600; }
    sleep() { SECONDS=$((SECONDS + $1)); }
    run_crawler_once() {
      echo "TEST_RUN:$1"
      runs=$((runs + 1))
      if [ "$runs" -eq 7 ]; then exit 0; fi
    }
    crawler_loop
  `], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  const modes = result.stdout.split('\n').filter((line) => line.startsWith('TEST_RUN:'));
  assert.deepEqual(modes, ['TEST_RUN:hourly', 'TEST_RUN:hourly', 'TEST_RUN:hourly',
    'TEST_RUN:hourly', 'TEST_RUN:hourly', 'TEST_RUN:full', 'TEST_RUN:hourly']);
});
