const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { getLotterySchedule, openEngagedStore, saveLotterySchedule } = require('../engaged-store');

function schedulerFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-scheduler-cli-'));
  const store = openEngagedStore(path.join(dir, 'test.sqlite'), path.join(dir, 'report.html'));
  t.after(() => { store.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  store.db.prepare('INSERT INTO zfrontier_accounts (id,phone,password,enabled) VALUES (?,?,?,?)')
    .run('enabled', '', '', 1);
  store.db.prepare('INSERT INTO zfrontier_accounts (id,phone,password,enabled) VALUES (?,?,?,?)')
    .run('disabled', '', '', 0);

  // A database-only poll must also work when the browser packages cannot load.
  const preload = path.join(dir, 'database-only.cjs');
  fs.writeFileSync(preload, `
    const Module = require('node:module');
    const load = Module._load;
    Module._load = function (name, ...args) {
      if (/^(?:crawlee|@crawlee\\/|playwright)/.test(name)) throw new Error('Browser dependency loaded during scheduler poll: ' + name);
      return load.call(this, name, ...args);
    };
    const RealDate = Date;
    global.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [process.env.TEST_NOW])); }
      static now() { return RealDate.parse(process.env.TEST_NOW); }
    };
  `);

  function poll(now = '2026-09-20T01:00:00.000Z', dbPath = store.dbPath, timeZone = 'Asia/Shanghai') {
    return spawnSync(process.execPath, ['--require', preload,
      path.join(__dirname, '../zfrontier-lottery-crawler.js'), '--next-hourly-delay'], {
      env: { ...process.env, ENV_FILE: path.join(dir, 'no-env'), TEST_NOW: now,
        ZF_SIGN_IN_TZ: timeZone, ZF_ENGAGED_DB: dbPath, ZF_ENGAGED_HTML: store.htmlPath },
      encoding: 'utf8', timeout: 10000,
    });
  }
  function schedule(accountId, second) {
    saveLotterySchedule(store, { accountId, postId: accountId,
      url: `https://www.zfrontier.com/app/flow/${accountId}`, title: accountId,
      drawAt: '2026-09-22 12:00', scheduledSecond: Date.parse(`2026-09-20T${second}Z`) / 1000 });
  }
  return { store, dir, poll, schedule };
}

test('database-only scheduler preserves assigned times, filters disabled accounts, and wakes 30 seconds early', (t) => {
  const { store, poll, schedule } = schedulerFixture(t);
  schedule('enabled', '09:01:00');
  schedule('disabled', '09:00:10');
  const assigned = getLotterySchedule(store, 'enabled', 'enabled').scheduledSecond;
  for (const [now, expected] of [['2026-09-20T01:00:00.000Z', '30\n'], ['2026-09-20T01:00:30.000Z', '0\n']]) {
    const result = poll(now);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, expected);
    assert.equal(getLotterySchedule(store, 'enabled', 'enabled').scheduledSecond, assigned);
  }
});

test('database-only scheduler reports none for empty queues and disabled accounts', (t) => {
  const { store, poll, schedule } = schedulerFixture(t);
  let result = poll();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'none\n');
  store.db.exec('UPDATE zfrontier_accounts SET enabled=0');
  schedule('disabled', '09:01:00');
  result = poll();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'none\n');
});

test('scheduler date formatting respects the configured time zone, including fractional offsets', (t) => {
  const { store, poll, schedule } = schedulerFixture(t);
  schedule('enabled', '09:01:00');
  for (const [zone, now] of [['UTC', '2026-09-20T09:00:00.000Z'], ['Asia/Kolkata', '2026-09-20T03:30:00.000Z']]) {
    const result = poll(now, store.dbPath, zone);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '30\n');
  }
});

test('database-only scheduler reports database errors without loading browser dependencies', (t) => {
  const { dir, poll } = schedulerFixture(t);
  const result = poll(undefined, dir);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Failed to calculate the next hourly run/);
  assert.doesNotMatch(result.stderr, /Browser dependency loaded/);
});
