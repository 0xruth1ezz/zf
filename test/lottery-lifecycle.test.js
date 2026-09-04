const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  isDailyEngagementLimitBlocking,
  isPreDrawEngagementDue,
  loadTrackedActiveLotteryRequests,
  mergePostRequests,
  nextPreDrawDelaySeconds,
  preDrawLotteryRequests,
  trackedActiveLotteryRequests,
  wasEngagedInPreDrawWindow,
} = require('../zfrontier-lottery-crawler');
const {
  openEngagedStore,
  saveEngagement,
} = require('../engaged-store');

const NOW = new Date('2026-06-17T04:00:00.000Z'); // 12:00 in Asia/Shanghai

test('tracked active lotteries include only known future draw times for the account', () => {
  const records = [
    {
      accountId: 'primary',
      postId: 'future',
      title: 'Future draw',
      url: 'https://www.zfrontier.com/app/flow/future',
      drawAt: '2026-06-18 09:30',
    },
    {
      accountId: 'primary',
      postId: 'unknown',
      title: 'Unknown draw',
      url: 'https://www.zfrontier.com/app/flow/unknown',
      drawAt: '',
    },
    {
      accountId: 'primary',
      postId: 'drawn',
      title: 'Completed draw',
      url: 'https://www.zfrontier.com/app/flow/drawn',
      drawAt: '2026-06-17 11:59',
    },
    {
      accountId: 'secondary',
      postId: 'other-account',
      title: 'Other account draw',
      url: 'https://www.zfrontier.com/app/flow/other-account',
      drawAt: '2026-06-18 09:30',
    },
  ];

  const requests = trackedActiveLotteryRequests(records, 'primary', NOW);

  assert.deepEqual(requests.map((request) => request.uniqueKey), ['future']);
  assert.equal(requests[0].userData.source, 'tracked-active-lottery');
});

test('tracked active lotteries stop at the exact draw minute', () => {
  const records = [{
    accountId: 'primary',
    postId: 'drawing-now',
    title: 'Drawing now',
    url: 'https://www.zfrontier.com/app/flow/drawing-now',
    drawAt: '2026-06-17 12:00',
  }];

  assert.deepEqual(trackedActiveLotteryRequests(records, 'primary', NOW), []);
});

test('active lottery requests are loaded from the SQLite engagement database', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-lottery-lifecycle-'));
  const store = openEngagedStore(
    path.join(tempDir, 'engagements.sqlite'),
    path.join(tempDir, 'engagements.html'),
  );

  try {
    saveEngagement(store, {
      accountId: 'primary',
      postId: 'database-active',
      title: 'Stored active lottery',
      url: 'https://www.zfrontier.com/app/flow/database-active',
      drawAt: '2026-06-18 09:30',
      lastEngagedDate: '2026-06-17',
      dailyEngagementCount: 1,
      engagedAt: '2026-06-17T03:00:00.000Z',
    });
    saveEngagement(store, {
      accountId: 'primary',
      postId: 'database-unknown',
      title: 'Stored unknown lottery',
      url: 'https://www.zfrontier.com/app/flow/database-unknown',
      drawAt: '',
      lastEngagedDate: '2026-06-17',
      dailyEngagementCount: 1,
      engagedAt: '2026-06-17T03:01:00.000Z',
    });

    const requests = loadTrackedActiveLotteryRequests(store, 'primary', NOW);

    assert.deepEqual(requests.map((request) => request.uniqueKey), ['database-active']);
  } finally {
    store.db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('tracked lotteries are processed first and feed metadata wins on duplicates', () => {
  const tracked = [{
    url: 'https://www.zfrontier.com/app/flow/active',
    uniqueKey: 'active',
    userData: { label: 'POST', source: 'tracked-active-lottery', listText: 'Stored title' },
  }];
  const discovered = [
    {
      url: 'https://www.zfrontier.com/app/flow/new',
      uniqueKey: 'new',
      userData: { label: 'POST', listText: 'New lottery' },
    },
    {
      url: 'https://www.zfrontier.com/app/flow/active',
      uniqueKey: 'active',
      userData: { label: 'POST', listText: 'Fresh title' },
    },
  ];

  const requests = mergePostRequests(tracked, discovered);

  assert.deepEqual(requests.map((request) => request.uniqueKey), ['active', 'new']);
  assert.equal(requests[0].userData.listText, 'Fresh title');
});

test('a final engagement becomes due during the five-minute pre-draw window', () => {
  const record = {
    accountId: 'primary',
    postId: 'pre-draw-due',
    url: 'https://www.zfrontier.com/app/flow/pre-draw-due',
    drawAt: '2026-06-17 12:05',
    engagedAt: '2026-06-17T03:45:00.000Z',
  };

  assert.equal(isPreDrawEngagementDue(record, NOW, 5), true);
  assert.deepEqual(
    preDrawLotteryRequests([record], 'primary', NOW).map((request) => request.uniqueKey),
    ['pre-draw-due'],
  );
  assert.equal(isDailyEngagementLimitBlocking({
    ...record,
    lastEngagedDate: '2026-06-17',
    dailyEngagementCount: 2,
  }, '2026-06-17', record.drawAt, NOW, 2), false);
  assert.equal(isDailyEngagementLimitBlocking({
    ...record,
    lastEngagedDate: '2026-06-17',
    dailyEngagementCount: 2,
  }, '2026-06-17', record.drawAt, new Date('2026-06-17T03:59:00.000Z'), 2), true);
});

test('a successful engagement inside the final window is not scheduled twice', () => {
  const record = {
    accountId: 'primary',
    postId: 'pre-draw-complete',
    url: 'https://www.zfrontier.com/app/flow/pre-draw-complete',
    drawAt: '2026-06-17 12:05',
    engagedAt: '2026-06-17T04:01:00.000Z',
  };

  assert.equal(wasEngagedInPreDrawWindow(record, record.drawAt, 5), true);
  assert.equal(isPreDrawEngagementDue(record, NOW, 5), false);
  assert.equal(nextPreDrawDelaySeconds([record], NOW, 5), null);
});

test('the scheduler wakes at the beginning of the five-minute pre-draw window', () => {
  const now = new Date('2026-06-17T04:00:30.000Z'); // 12:00:30 in Asia/Shanghai
  const records = [{
    accountId: 'primary',
    postId: 'scheduled',
    url: 'https://www.zfrontier.com/app/flow/scheduled',
    drawAt: '2026-06-17 12:10',
    engagedAt: '2026-06-17T03:45:00.000Z',
  }];

  assert.equal(nextPreDrawDelaySeconds(records, now, 5), 270);
});
