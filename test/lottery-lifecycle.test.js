const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  loadTrackedActiveLotteryRequests,
  mergePostRequests,
  trackedActiveLotteryRequests,
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
