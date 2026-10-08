const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.ZF_SIGN_IN_TZ = 'Asia/Shanghai';
const {
  ensureLotterySchedule,
  isLotteryEngagementDue,
  nextLotteryRequest,
  loadTrackedActiveLotteryRequests,
  nextLotteryDelaySeconds,
  nextLotteryEngagementSecond,
  refreshLotterySchedules,
  rescheduleLotteryRequest,
  saveExistingEngagementMetadata,
} = require('../zfrontier-lottery-crawler');
const {
  getEngagement, getLotterySchedule, listEngagements, openEngagedStore, saveEngagement, saveLotterySchedule,
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
  assert.equal(first.scheduledSecond, localSecond('2026-09-20T07:42:00'));
  assert.equal(otherPost.scheduledSecond, localSecond('2026-09-20T09:18:00'));
  assert.equal(otherAccount.scheduledSecond, localSecond('2026-09-20T08:30:00'));
  assert.equal(listEngagements(store).length, 0);
  assert.equal(loadTrackedActiveLotteryRequests(store, 'primary', now).length, 2);

  store.db.close();
  store.db = openEngagedStore(store.dbPath, store.htmlPath).db;
  const due = localDate('2026-09-20T07:42:05');
  assert.equal(ensureLotterySchedule(store, lottery(), due, () => {
    throw new Error('An existing plan must not be randomized again');
  }).scheduledSecond, first.scheduledSecond);
  assert.equal(nextLotteryRequest(store, new Set(['primary']), due).request.uniqueKey, 'post');
  assert.equal(nextLotteryRequest(store, new Set(['secondary']), due), null);
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

test('every lottery independently draws a new random time in each successive two-hour window', (t) => {
  const store = createStore(t);
  const records = [lottery('one'), lottery('two'), lottery('one', 'secondary')];
  let previousOffsets;
  for (let window = 0; window < 3; window += 1) {
    const start = localSecond('2026-09-20T07:30:00') + window * 7200;
    const now = dateForSecond(start - 60);
    let randomCalls = 0;
    const schedules = records.map((record, index) => ensureLotterySchedule(store, record, now, () => {
      randomCalls += 1;
      return [0.1, 0.5, 0.9][(window + index) % 3];
    }));
    assert.equal(randomCalls, records.length, 'each lottery must draw its own new time');
    const offsets = schedules.map((record) => record.scheduledSecond - start);
    assert.ok(offsets.every((offset) => offset >= 0 && offset < 7200));
    assert.equal(new Set(offsets).size, records.length);
    if (previousOffsets) offsets.forEach((offset, index) => assert.notEqual(offset, previousOffsets[index]));
    previousOffsets = offsets;
    for (const schedule of schedules.sort((a, b) => a.scheduledSecond - b.scheduledSecond)) {
      const due = dateForSecond(schedule.scheduledSecond);
      assert.equal(isLotteryEngagementDue(schedule, due), true);
      saveEngagement(store, { ...schedule, engagedAt: due.toISOString(),
        lastEngagedDate: '2026-09-20', dailyEngagementCount: window + 1 });
      assert.equal(isLotteryEngagementDue({ ...schedule,
        ...getEngagement(store, schedule.accountId, schedule.postId) }, due), false);
      for (const other of schedules) {
        assert.equal(getLotterySchedule(store, other.accountId, other.postId).scheduledSecond, other.scheduledSecond);
      }
    }
  }
  assert.ok(listEngagements(store).every((record) => record.dailyEngagementCount === 3));
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
  assert.equal(refreshed.filter((record) => isLotteryEngagementDue(record, afterScan)).length, 0);
  assert.equal(nextLotteryRequest(store, new Set(['primary']), afterScan), null);
  assert.equal(new Set(refreshed.map((record) => record.scheduledSecond)).size, 6);
});

test('dispatch selects only the nearest post across accounts and requeues a failed attempt into the future', (t) => {
  const store = createStore(t);
  const now = localDate('2026-09-20T06:00:00');
  const first = ensureLotterySchedule(store, lottery('first', 'secondary'), now, () => 0.2);
  const second = ensureLotterySchedule(store, lottery('second'), now, () => 0.8);
  const accountIds = new Set(['primary', 'secondary']);
  assert.equal(nextLotteryRequest(store, accountIds, dateForSecond(first.scheduledSecond - 31)), null);
  const selected = nextLotteryRequest(store, accountIds, dateForSecond(first.scheduledSecond - 30));
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
  assert.equal(isLotteryEngagementDue(schedule, localDate('2026-09-20T10:05:15')), true);
  assert.equal(isLotteryEngagementDue(schedule, localDate('2026-09-20T10:05:15.001')), false);
  assert.equal(isLotteryEngagementDue(schedule, localDate('2026-09-20T10:10:00')), false);
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

test('a full day allows one success per two-hour window, then waits until next morning', (t) => {
  const store = createStore(t);
  let now = localDate('2026-09-20T06:00:00');
  const times = ['08:30', '10:30', '12:30', '14:30', '16:30', '18:30', '20:30', '22:30', '23:45'];
  for (const [index, time] of times.entries()) {
    const schedule = ensureLotterySchedule(store, lottery(), now, () => 0.5);
    const expected = `2026-09-20T${time}:00`;
    assert.equal(schedule.scheduledSecond, localSecond(expected));
    now = dateForSecond(schedule.scheduledSecond);
    assert.equal(isLotteryEngagementDue(schedule, new Date(now.getTime() - 1)), false);
    assert.equal(isLotteryEngagementDue(schedule, now), true);
    saveEngagement(store, { ...lottery(), engagedAt: now.toISOString(),
      lastEngagedDate: '2026-09-20', dailyEngagementCount: index + 1 });
    assert.equal(isLotteryEngagementDue({ ...schedule, ...getEngagement(store, 'primary', 'post') }, now), false);
  }
  assert.equal(getEngagement(store, 'primary', 'post').dailyEngagementCount, 9);
  const next = ensureLotterySchedule(store, lottery(), now, () => 0.5);
  assert.equal(next.scheduledSecond, localSecond('2026-09-21T08:30:00'));
  assert.equal(isLotteryEngagementDue(next, localDate('2026-09-21T00:00:00')), false);
  assert.equal(isLotteryEngagementDue(next, localDate('2026-09-21T08:30:00')), true);
});

test('late discovery uses the remaining window; missed windows are not replayed', () => {
  const now = localDate('2026-09-20T10:40:00');
  const expected = localSecond('2026-09-20T11:05:15');
  assert.equal(nextLotteryEngagementSecond(lottery(), now, () => 0.5), expected);
  const missed = { ...lottery(), scheduledSecond: localSecond('2026-09-20T08:30:00') };
  assert.equal(isLotteryEngagementDue(missed, now), false);
  assert.equal(nextLotteryEngagementSecond(missed, now, () => 0.5), expected);
});

test('opening, midnight, and draw boundaries are exclusive at the end', () => {
  const opening = { ...lottery(), scheduledSecond: localSecond('2026-09-20T07:30:00') };
  assert.equal(isLotteryEngagementDue(opening, localDate('2026-09-20T07:29:59.999')), false);
  assert.equal(isLotteryEngagementDue(opening, localDate('2026-09-20T07:30:00')), true);
  assert.equal(isLotteryEngagementDue(opening, localDate('2026-09-20T08:00:00')), false);
  const windowEnd = { ...lottery(), scheduledSecond: localSecond('2026-09-20T09:29:50') };
  assert.equal(isLotteryEngagementDue(windowEnd, localDate('2026-09-20T09:29:59.999')), true);
  assert.equal(isLotteryEngagementDue(windowEnd, localDate('2026-09-20T09:30:00')), false);
  const hourEnd = { ...lottery(), scheduledSecond: localSecond('2026-09-20T10:59:50') };
  assert.equal(isLotteryEngagementDue(hourEnd, localDate('2026-09-20T11:00:00')), true);
  const closing = { ...lottery(), scheduledSecond: localSecond('2026-09-20T23:59:50') };
  assert.equal(isLotteryEngagementDue(closing, localDate('2026-09-20T23:59:59.999')), true);
  assert.equal(isLotteryEngagementDue(closing, localDate('2026-09-21T00:00:00')), false);
  const drawing = { ...opening, drawAt: '2026-09-20 07:40', scheduledSecond: localSecond('2026-09-20T07:39:50') };
  assert.equal(isLotteryEngagementDue(drawing, localDate('2026-09-20T07:39:59.999')), true);
  assert.equal(isLotteryEngagementDue(drawing, localDate('2026-09-20T07:40:00')), false);
});

test('draw deadlines truncate random windows without an extra pre-draw participation', () => {
  const record = lottery('post', 'primary', '2026-09-20 10:25');
  const now = localDate('2026-09-20T10:00:00');
  assert.equal(nextLotteryEngagementSecond(record, now, () => 0.5), localSecond('2026-09-20T10:12:45'));
  assert.equal(nextLotteryEngagementSecond({ ...record, engagedAt: now.toISOString() }, now), null);
  assert.equal(nextLotteryEngagementSecond(record, localDate('2026-09-20T10:25:00')), null);
  assert.equal(nextLotteryEngagementSecond({ ...record, drawAt: '' }, now), null);
  assert.equal(nextLotteryEngagementSecond({ ...record, drawAt: '2026-09-21 07:30' },
    localDate('2026-09-21T00:00:00')), null);
});

test('random endpoints span both hours and stay inside the shortened last window', () => {
  assert.equal(nextLotteryEngagementSecond(lottery(), localDate('2026-09-20T06:00:00'), () => 0),
    localSecond('2026-09-20T07:30:00'));
  assert.equal(nextLotteryEngagementSecond(lottery(), localDate('2026-09-20T06:00:00'), () => 1 - Number.EPSILON),
    localSecond('2026-09-20T09:29:59'));
  assert.equal(nextLotteryEngagementSecond(lottery(), localDate('2026-09-20T09:30:00'), () => 1 - Number.EPSILON),
    localSecond('2026-09-20T11:29:59'));
  assert.equal(nextLotteryEngagementSecond(lottery(), localDate('2026-09-20T23:30:00'), () => 1 - Number.EPSILON),
    localSecond('2026-09-20T23:59:59'));
  assert.equal(nextLotteryEngagementSecond(lottery(), localDate('2026-09-20T23:00:00'), () => 1 - Number.EPSILON),
    localSecond('2026-09-20T23:29:59'));
});

test('legacy hourly schedules skip the whole two-hour window after a success', (t) => {
  const store = createStore(t);
  const now = localDate('2026-09-20T10:00:00');
  saveEngagement(store, { ...lottery(), engagedAt: localDate('2026-09-20T09:40:00').toISOString(),
    lastEngagedDate: '2026-09-20', dailyEngagementCount: 2 });
  saveLotterySchedule(store, { ...lottery(), scheduledSecond: localSecond('2026-09-20T10:20:00') });
  const schedules = refreshLotterySchedules(store, now);
  assert.equal(schedules.length, 1);
  assert.ok(schedules[0].scheduledSecond >= localSecond('2026-09-20T11:30:00'));
  assert.ok(schedules[0].scheduledSecond < localSecond('2026-09-20T13:30:00'));
  assert.equal(getLotterySchedule(store, 'primary', 'post').scheduledSecond, schedules[0].scheduledSecond);
  assert.equal(nextLotteryRequest(store, new Set(['primary']), now), null);
});

test('a success in the first hour suppresses the second hour but not the next window', () => {
  const record = { ...lottery(), engagedAt: localDate('2026-09-20T07:45:00').toISOString(),
    scheduledSecond: localSecond('2026-09-20T08:45:00') };
  assert.equal(isLotteryEngagementDue(record, localDate('2026-09-20T08:45:00')), false);
  assert.equal(nextLotteryEngagementSecond(record, localDate('2026-09-20T08:45:00'), () => 0),
    localSecond('2026-09-20T09:30:00'));
  const next = { ...record, scheduledSecond: localSecond('2026-09-20T09:30:00') };
  assert.equal(isLotteryEngagementDue(next, localDate('2026-09-20T09:30:00')), true);
});

test('scheduler wakes early to prepare only the next post', (t) => {
  const store = createStore(t);
  const now = localDate('2026-09-20T09:00:30.500');
  const first = ensureLotterySchedule(store, lottery(), now, () => 0.1);
  const second = ensureLotterySchedule(store, lottery('other'), now, () => 0.9);
  assert.equal(nextLotteryDelaySeconds([second, first], now), Math.ceil(first.scheduledSecond - localSecond('2026-09-20T09:00:30.500') - 30));
  assert.equal(nextLotteryDelaySeconds([first], dateForSecond(first.scheduledSecond + 1)), 0);
  assert.equal(nextLotteryDelaySeconds([]), null);
  const afterDraw = localDate('2026-09-22T12:00:00');
  assert.equal(nextLotteryDelaySeconds(refreshLotterySchedules(store, afterDraw), afterDraw), null);
});
