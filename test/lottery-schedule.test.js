const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.ZF_SIGN_IN_TZ = 'Asia/Shanghai';
const {
  ensureLotterySchedule,
  isHourlyEngagementDue,
  nextHourlyLotteryRequest,
  loadTrackedActiveLotteryRequests,
  nextHourlyDelaySeconds,
  nextHourlyEngagementSecond,
  refreshLotterySchedules,
  rescheduleLotteryRequest,
  saveExistingEngagementMetadata,
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
  const due = localDate('2026-09-20T07:33:05');
  assert.equal(ensureLotterySchedule(store, lottery(), due, () => {
    throw new Error('An existing plan must not be randomized again');
  }).scheduledSecond, first.scheduledSecond);
  assert.equal(nextHourlyLotteryRequest(store, new Set(['primary']), due).request.uniqueKey, 'post');
  assert.equal(nextHourlyLotteryRequest(store, new Set(['secondary']), due), null);
});

test('random collisions still produce different persisted times for every post and account', (t) => {
  const store = createStore(t);
  const now = localDate('2026-09-20T06:00:00');
  const schedules = [lottery('one'), lottery('two'), lottery('one', 'secondary')]
    .map((record) => ensureLotterySchedule(store, record, now, () => 0.5));
  assert.equal(new Set(schedules.map((record) => record.scheduledSecond)).size, 3);
  assert.ok(Math.max(...schedules.map((r) => r.scheduledSecond))
    - Math.min(...schedules.map((r) => r.scheduledSecond)) < 30, 'no fixed minimum interval is imposed');
  store.db.close();
  store.db = openEngagedStore(store.dbPath, store.htmlPath).db;
  for (const original of schedules) {
    assert.equal(ensureLotterySchedule(store, original, now).scheduledSecond, original.scheduledSecond);
  }
});

test('a delayed scan cannot turn a backlog into an immediately executable batch', (t) => {
  const store = createStore(t);
  const beforeScan = localDate('2026-09-20T10:00:00');
  for (let index = 0; index < 6; index += 1) {
    ensureLotterySchedule(store, lottery(`post-${index}`), beforeScan, () => 0.05 + index * 0.01);
  }
  const afterScan = localDate('2026-09-20T10:10:00');
  t.mock.method(Math, 'random', () => 0.5);
  const refreshed = refreshLotterySchedules(store, afterScan);
  assert.ok(refreshed.every((record) => record.scheduledSecond > localSecond('2026-09-20T10:10:30')));
  assert.equal(refreshed.filter((record) => isHourlyEngagementDue(record, afterScan)).length, 0);
  assert.equal(nextHourlyLotteryRequest(store, new Set(['primary']), afterScan), null);
  assert.equal(new Set(refreshed.map((record) => record.scheduledSecond)).size, 6);
});

test('dispatch selects only the nearest post across accounts and requeues a failed attempt into the future', (t) => {
  const store = createStore(t);
  const now = localDate('2026-09-20T06:00:00');
  const first = ensureLotterySchedule(store, lottery('first', 'secondary'), now, () => 0.2);
  const second = ensureLotterySchedule(store, lottery('second'), now, () => 0.8);
  const accountIds = new Set(['primary', 'secondary']);
  assert.equal(nextHourlyLotteryRequest(store, accountIds, dateForSecond(first.scheduledSecond - 31)), null);
  const selected = nextHourlyLotteryRequest(store, accountIds, dateForSecond(first.scheduledSecond - 30));
  assert.equal(selected.accountId, 'secondary');
  assert.equal(selected.request.uniqueKey, 'first');
  assert.equal(selected.request.userData.scheduledSecond, first.scheduledSecond);
  const failedAt = dateForSecond(first.scheduledSecond + 5);
  rescheduleLotteryRequest(store, selected.accountId, selected.request, failedAt);
  const retried = getLotterySchedule(store, 'secondary', 'first');
  assert.ok(retried.scheduledSecond >= first.scheduledSecond + 35);
  assert.equal(getLotterySchedule(store, 'primary', 'second').scheduledSecond, second.scheduledSecond);
  rescheduleLotteryRequest(store, selected.accountId, selected.request, failedAt);
  assert.equal(getLotterySchedule(store, 'secondary', 'first').scheduledSecond, retried.scheduledSecond,
    'an old worker cannot replace a newer plan');
});

test('late jobs stop being executable after their individual deadline', () => {
  const schedule = { ...lottery(), scheduledSecond: localSecond('2026-09-20T10:05:00') };
  assert.equal(isHourlyEngagementDue(schedule, localDate('2026-09-20T10:05:15')), true);
  assert.equal(isHourlyEngagementDue(schedule, localDate('2026-09-20T10:05:15.001')), false);
  assert.equal(isHourlyEngagementDue(schedule, localDate('2026-09-20T10:10:00')), false);
});

test('discovery metadata cannot overwrite a newer worker engagement', (t) => {
  const store = createStore(t);
  const previous = { ...lottery(), engagedAt: localDate('2026-09-20T09:30:00').toISOString(),
    lastEngagedDate: '2026-09-20', dailyEngagementCount: 2 };
  saveEngagement(store, previous);
  const stale = getEngagement(store, 'primary', 'post');
  const recent = { ...previous, engagedAt: localDate('2026-09-20T10:05:00').toISOString(), dailyEngagementCount: 3 };
  saveEngagement(store, recent);
  saveExistingEngagementMetadata(store, stale, { title: 'Updated', drawAt: '2026-09-23 12:00' });
  const saved = getEngagement(store, 'primary', 'post');
  assert.equal(saved.engagedAt, recent.engagedAt);
  assert.equal(saved.dailyEngagementCount, 3);
  assert.equal(saved.drawAt, '2026-09-23 12:00');
  assert.equal(saved.title, 'Updated');
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
  const expected = localSecond('2026-09-20T10:50:15');
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
  const closing = { ...lottery(), scheduledSecond: localSecond('2026-09-20T23:59:50') };
  assert.equal(isHourlyEngagementDue(closing, localDate('2026-09-20T23:59:59.999')), true);
  assert.equal(isHourlyEngagementDue(closing, localDate('2026-09-21T00:00:00')), false);
  const drawing = { ...opening, drawAt: '2026-09-20 07:40', scheduledSecond: localSecond('2026-09-20T07:39:50') };
  assert.equal(isHourlyEngagementDue(drawing, localDate('2026-09-20T07:39:59.999')), true);
  assert.equal(isHourlyEngagementDue(drawing, localDate('2026-09-20T07:40:00')), false);
});

test('draw deadlines truncate random windows without an extra pre-draw participation', () => {
  const record = lottery('post', 'primary', '2026-09-20 10:25');
  const now = localDate('2026-09-20T10:00:00');
  assert.equal(nextHourlyEngagementSecond(record, now, () => 0.5), localSecond('2026-09-20T10:12:45'));
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
  assert.equal(nextHourlyLotteryRequest(store, new Set(['primary']), now), null);
});

test('scheduler wakes early to prepare only the next post', (t) => {
  const store = createStore(t);
  const now = localDate('2026-09-20T09:00:30.500');
  const first = ensureLotterySchedule(store, lottery(), now, () => 0.1);
  const second = ensureLotterySchedule(store, lottery('other'), now, () => 0.9);
  assert.equal(nextHourlyDelaySeconds([second, first], now), Math.ceil(first.scheduledSecond - localSecond('2026-09-20T09:00:30.500') - 30));
  assert.equal(nextHourlyDelaySeconds([first], dateForSecond(first.scheduledSecond + 1)), 0);
  assert.equal(nextHourlyDelaySeconds([]), null);
  const afterDraw = localDate('2026-09-22T12:00:00');
  assert.equal(nextHourlyDelaySeconds(refreshLotterySchedules(store, afterDraw), afterDraw), null);
});
