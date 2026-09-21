const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openEngagedStore, getEngagement, saveLotterySchedule, saveEngagement, listSignIns, getLotterySchedule } = require('../engaged-store');
const { ensureLotterySchedule, secondValueForTimeZone } = require('../zfrontier-lottery-crawler');
const { dailySignIn, discoverPosts, discoverAccount, engagePost, claimAttempt, acquireLease, ownsLease, JobPool } = require('../http-worker');
const { ZfError } = require('../zfrontier-http');

const local = (time) => new Date(`2026-09-21T${time}+08:00`);
function fixture(t, postId = 'post') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-worker-'));
  const store = openEngagedStore(path.join(dir, 'test.sqlite'), path.join(dir, 'report.html'));
  t.after(() => { store.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const account = { id: 'a' };
  const record = { accountId: 'a', postId, title: 'Post', url: `https://www.zfrontier.com/app/flow/${postId}`, drawAt: '2026-09-22 12:00', scheduledSecond: secondValueForTimeZone(local('10:15:00')) };
  saveLotterySchedule(store, record);
  const requests = [];
  const client = {
    api: async (url, fields) => {
      requests.push({ url, fields });
      if (url === '/v2/flow/detail') return { flow: { id: 12, hash_id: postId, title: 'Post', has_zan: 0, lottery: { status: 1, lottery_at: record.drawAt } } };
      return {};
    },
    signed: async (url, fields) => { requests.push({ url, fields }); return { reply: { id: 123 } }; },
  };
  return { store, account, record, client, requests, dryRun: false };
}

test('first daily check-in confirms completion, already-signed accounts do not submit, failures are not recorded', async (t) => {
  const { store } = fixture(t);
  for (const alreadyDone of [false, true]) {
    const requests = [];
    const client = { api: async (url) => {
      requests.push(url);
      return { sign_info: { hasDone: url === '/v2/sign' || alreadyDone, desc: 'Done' } };
    } };
    const account = { id: String(alreadyDone) };
    await dailySignIn(client, store, account, local('10:00:00'), false);
    await dailySignIn(client, store, account, local('10:00:00'), false);
    assert.deepEqual(requests, alreadyDone ? ['/v2/signInfo'] : ['/v2/signInfo', '/v2/sign']);
  }
  await assert.rejects(dailySignIn({ api: async () => ({ sign_info: { hasDone: false } }) }, store, { id: 'failed' }, local('10:00:00'), false), /not confirmed/);
  assert.equal(listSignIns(store).length, 2);
});

test('HTTP feed pagination deduplicates posts, ignores old publications, and detects cursor loops', async () => {
  const pages = [
    { list: [{ hash_id: 'new', created_at: '2026-09-21 08:00' }, { hash_id: 'old', created_at: '2026-09-01 08:00' }], offset: 'next' },
    { list: [{ hash_id: 'new' }, { hash_id: 'second', created_at: '2026-09-20 08:00' }], offset: 'end' },
    { list: [], offset: '' },
  ];
  const offsets = [];
  const client = { api: async (_, fields) => { offsets.push(fields.offset); return pages.shift(); } };
  assert.deepEqual(await discoverPosts(client, local('10:00:00')), ['new', 'second']);
  assert.deepEqual(offsets, ['', 'next', 'end']);
  await assert.rejects(discoverPosts({ api: async () => ({ list: [{ hash_id: 'a' }], offset: 'loop' }) }), /repeated/);
});

test('discovery retains tracked posts beyond the publish window without entering a lottery', async (t) => {
  const f = fixture(t);
  const calls = [];
  await discoverAccount({ api: async (url, fields) => {
    calls.push(url);
    if (url === '/v2/home/flow/list') return { list: [], offset: '' };
    return f.client.api(url, fields);
  } }, f.store, f.account, () => true, local('10:00:00'));
  assert.ok(calls.includes('/v2/flow/detail'));
  assert.ok(!calls.includes('/v2/flow/reply'));
});

test('independent jobs send at their assigned times; a blocked first job does not hold the next', async (t) => {
  const f = fixture(t);
  let clock = local('10:14:45');
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const pool = new JobPool((e) => { throw e; });
  pool.start('blocked-account', () => blocked);
  pool.start('lottery', () => engagePost({ ...f, now: () => clock, wait: async (ms) => { clock = new Date(clock.getTime() + ms); } }));
  assert.equal(pool.start('lottery', () => assert.fail('duplicate')), false);
  await pool.jobs.get('lottery');
  assert.equal(getEngagement(f.store, 'a', 'post').engagedAt, local('10:15:00').toISOString());
  assert.ok(pool.jobs.has('blocked-account'));
  assert.equal(f.requests.filter((r) => r.url === '/v2/flow/reply').length, 1);
  assert.deepEqual(f.requests.find((r) => r.url === '/api/circle/zanFlow').fields, { id: 12, action: 'add' });
  release(); await pool.drain();
});

test('uncertain delivery is persisted and cannot be retried in the same hour after restarting', async (t) => {
  const f = fixture(t);
  let sends = 0;
  f.client.signed = async () => { sends++; throw new Error('connection closed'); };
  await assert.rejects(engagePost({ ...f, now: () => local('10:15:00') }), /connection closed/);
  assert.equal(getEngagement(f.store, 'a', 'post'), undefined);
  assert.equal(f.store.db.prepare('SELECT state FROM lottery_attempts').get().state, 'uncertain');
  assert.equal(claimAttempt(f.store, f.record, local('10:15:01')), false);
  const next = ensureLotterySchedule(f.store, f.record, local('10:15:01'), () => 0);
  assert.equal(next.scheduledSecond, secondValueForTimeZone(local('11:00:00')));
  await engagePost({ ...f, now: () => local('10:15:01') });
  assert.equal(sends, 1);
});

test('pending crash records also prevent repeats, while confirmed rejections can be rescheduled', async (t) => {
  const f = fixture(t);
  assert.equal(claimAttempt(f.store, f.record, local('10:15:00')), true);
  assert.equal(claimAttempt(f.store, f.record, local('10:15:00')), false);
  assert.ok(ensureLotterySchedule(f.store, f.record, local('10:15:01')).scheduledSecond >= secondValueForTimeZone(local('11:00:00')));
  f.store.db.exec('DELETE FROM lottery_attempts');
  saveLotterySchedule(f.store, f.record);
  f.client.signed = async () => { throw new ZfError('rate limited', { code: 20001, rejected: true }); };
  await assert.rejects(engagePost({ ...f, now: () => local('10:15:00') }), /rate limited/);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM lottery_attempts').get().n, 0);
  assert.equal(getEngagement(f.store, 'a', 'post'), undefined);
});

test('late preparations, disabled accounts, expired draws and dry runs cannot submit', async (t) => {
  for (const mode of ['late', 'disabled', 'expired', 'dry']) {
    const f = fixture(t, mode);
    let clock = local('10:14:59');
    const api = f.client.api;
    f.client.api = async (...args) => {
      const data = await api(...args);
      if (mode === 'late') clock = local('10:15:16');
      if (mode === 'expired' && data.flow) data.flow.lottery.status = 2;
      return data;
    };
    await engagePost({ ...f, now: () => clock, guard: () => mode !== 'disabled', dryRun: mode === 'dry', wait: async () => { clock = local('10:15:00'); } });
    assert.ok(!f.requests.some((r) => r.url === '/v2/flow/reply'), mode);
    assert.equal(getEngagement(f.store, 'a', mode), undefined);
  }
});

test('successful reply and daily count commit together; a second call cannot repeat the hour', async (t) => {
  const f = fixture(t);
  saveEngagement(f.store, { ...f.record, engagedAt: local('09:10:00').toISOString(), lastEngagedDate: '2026-09-21', dailyEngagementCount: 2 });
  await engagePost({ ...f, now: () => local('10:15:00') });
  assert.equal(getEngagement(f.store, 'a', 'post').dailyEngagementCount, 3);
  assert.deepEqual({ ...f.store.db.prepare('SELECT state, reply_id FROM lottery_attempts').get() }, { state: 'confirmed', reply_id: '123' });
  await engagePost({ ...f, now: () => local('10:15:01') });
  assert.equal(f.requests.filter((r) => r.url === '/v2/flow/reply').length, 1);
});

test('a worker lease prevents concurrent processes and permits recovery after expiry', (t) => {
  const { store } = fixture(t);
  assert.equal(acquireLease(store, 'first', 1000), true);
  assert.equal(acquireLease(store, 'second', 1001), false);
  assert.equal(ownsLease(store, 'first', 2000), true);
  assert.equal(acquireLease(store, 'second', 31000), true);
  assert.equal(ownsLease(store, 'first', 31001), false);
  assert.equal(acquireLease(store, 'first', 31001), false);
});
