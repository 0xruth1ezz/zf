const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');
const { default: log } = require('@apify/log');
const {
  CONFIG, ENGAGED_DB, ENGAGED_HTML, PROFILE_DIR, loadAccounts, dateKeyForTimeZone,
  dateTimeMinuteValue, secondValueForTimeZone, ensureLotterySchedule, refreshLotterySchedules,
  isHourlyEngagementDue, rescheduleLotteryRequest, saveExistingEngagementMetadata,
} = require('./zfrontier-lottery-crawler');
const { openEngagedStore, getEngagement, getLotterySchedule, saveLotterySchedule, saveEngagement,
  listTrackedLotteries, hasSignIn, saveSignIn, initializeMessageSync, saveMessageSyncError, renderEngagementHtml } = require('./engaged-store');
const { ZfHttpClient, credentialsKey, ORIGIN } = require('./zfrontier-http');
const { loginWithBrowser } = require('./browser-session');
const { fetchPrivateMessagesHttp } = require('./private-messages');

function interval(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive.`);
  return value * 1000;
}

function acquireLease(store, owner, now = Date.now()) {
  return Boolean(store.db.prepare(`INSERT INTO worker_lease (name, owner, expires_at) VALUES ('http-worker', ?, ?)
    ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
    WHERE worker_lease.owner = excluded.owner OR worker_lease.expires_at <= ?`).run(owner, now + 30000, now).changes);
}
function ownsLease(store, owner, now = Date.now()) {
  return Boolean(store.db.prepare("SELECT 1 FROM worker_lease WHERE name = 'http-worker' AND owner = ? AND expires_at > ?").get(owner, now));
}

async function dailySignIn(client, store, account, now = new Date(), dryRun = CONFIG.dryRun) {
  const date = dateKeyForTimeZone(now);
  if (hasSignIn(store, account.id, date) || dryRun) return;
  const status = await client.api('/v2/signInfo');
  if (typeof status?.sign_info?.hasDone !== 'boolean') throw new Error('Unrecognized check-in status.');
  const alreadyDone = status.sign_info.hasDone;
  const result = alreadyDone ? status : await client.api('/v2/sign');
  if (result?.sign_info?.hasDone !== true) throw new Error('Daily check-in was not confirmed.');
  saveSignIn(store, { accountId: account.id, signInDate: date, signedAt: new Date().toISOString(),
    url: `${ORIGIN}/app/achievement#score`, status: alreadyDone ? 'already_signed' : 'signed',
    message: result.sign_info.desc || 'Daily check-in confirmed.' });
  log.info(`[${account.id}] Daily check-in confirmed (${alreadyDone ? 'already signed' : 'signed'}).`);
}

function publicationIsOld(value, now) {
  if (typeof value === 'number' || /^\d{10,13}$/.test(String(value))) {
    const timestamp = Number(value) * (Number(value) < 1e12 ? 1000 : 1);
    return now.getTime() - timestamp > CONFIG.publishWindowDays * 86400000;
  }
  const minute = dateTimeMinuteValue(String(value || '').replace('T', ' ').slice(0, 16));
  return minute !== null && secondValueForTimeZone(now) - minute * 60 > CONFIG.publishWindowDays * 86400;
}

async function discoverPosts(client, now = new Date()) {
  const posts = new Map();
  const cursors = new Set();
  let offset = '';
  for (let page = 0; page < Math.max(1, CONFIG.maxScrolls); page += 1) {
    if (cursors.has(String(offset))) throw new Error('Feed pagination repeated its cursor.');
    cursors.add(String(offset));
    const data = await client.api('/v2/home/flow/list', { offset, 'tagIds[0]': '2007' });
    if (!Array.isArray(data?.list)) throw new Error('Unrecognized feed response.');
    if (!data.list.length) break;
    for (const flow of data.list) {
      if (!flow.hash_id || publicationIsOld(flow.created_at, now)) continue;
      posts.set(flow.hash_id, flow);
      if (CONFIG.maxPosts && posts.size >= CONFIG.maxPosts) return [...posts.keys()];
    }
    if (data.list.every((flow) => publicationIsOld(flow.created_at, now)) || !data.offset) break;
    offset = data.offset;
  }
  return [...posts.keys()];
}

async function readPost(client, store, account, postId, now = new Date()) {
  const data = await client.api('/v2/flow/detail', { id: postId });
  const flow = data?.flow;
  if (!flow || !Number.isSafeInteger(Number(flow.id)) || flow.hash_id !== postId) throw new Error('Unrecognized post details.');
  const existing = getEngagement(store, account.id, postId);
  const tracked = getLotterySchedule(store, account.id, postId);
  const record = { accountId: account.id, postId, title: flow.title || existing?.title || postId,
    url: `${ORIGIN}/app/flow/${encodeURIComponent(postId)}`, drawAt: String(flow.lottery?.lottery_at || '').slice(0, 16) };
  if (existing) saveExistingEngagementMetadata(store, existing, record);
  if (Number(flow.lottery?.status) !== 1 || dateTimeMinuteValue(record.drawAt) === null) {
    // A closed/cancelled lottery can retain a future draw date. An empty schedule
    // date prevents the historical engagement row from reactivating it.
    if (tracked || existing) saveLotterySchedule(store, { ...record, drawAt: '', scheduledSecond: null });
    return null;
  }
  return { ...ensureLotterySchedule(store, record, now), flow };
}

async function discoverAccount(client, store, account, guard = () => true, now = new Date()) {
  const ids = new Set(await discoverPosts(client, now));
  // Previously discovered lotteries remain eligible beyond the publish window.
  for (const record of listTrackedLotteries(store)) {
    if (record.accountId === account.id && dateTimeMinuteValue(record.drawAt) * 60 > secondValueForTimeZone(now)) ids.add(record.postId);
  }
  for (const postId of ids) {
    if (!guard()) return;
    await readPost(client, store, account, postId, now);
  }
  log.info(`[${account.id}] HTTP discovery checked ${ids.size} posts.`);
}

function claimAttempt(store, record, now = new Date()) {
  const fresh = { ...getEngagement(store, record.accountId, record.postId), ...getLotterySchedule(store, record.accountId, record.postId) };
  if (fresh.scheduledSecond !== record.scheduledSecond || !isHourlyEngagementDue(fresh, now)) return false;
  const hour = Math.floor(record.scheduledSecond / 3600) * 3600;
  return Boolean(store.db.prepare(`INSERT OR IGNORE INTO lottery_attempts (account_id, post_id, hour_start, started_at)
    VALUES (?, ?, ?, ?)`).run(record.accountId, record.postId, hour, now.toISOString()).changes);
}

async function engagePost({ client, store, account, record, guard = () => true, signal, now = () => new Date(), wait = sleep, dryRun = CONFIG.dryRun }) {
  const prepared = await readPost(client, store, account, record.postId, now());
  if (!prepared || prepared.scheduledSecond !== record.scheduledSecond || !guard()) return;
  if (!dryRun && !Number(prepared.flow.has_zan)) {
    await client.api('/api/circle/zanFlow', { id: prepared.flow.id, action: 'add' }, { referer: record.url });
  }
  let remaining;
  while ((remaining = record.scheduledSecond - secondValueForTimeZone(now())) > 0) {
    await wait(Math.min(remaining * 1000, 1000), undefined, { signal });
    if (!guard()) return;
  }
  if (dryRun || !guard() || !claimAttempt(store, prepared, now())) return;
  const hour = Math.floor(record.scheduledSecond / 3600) * 3600;
  const sentAt = now();
  let result;
  try {
    // Authentication happened during preparation. Do not launch login or retry
    // this write after its deadline; an uncertain delivery must not be repeated.
    result = await client.signed('/v2/flow/reply', { id: prepared.flow.id, type: '', reply_id: '', content: '冲冲冲' }, { referer: record.url });
    if (!result?.reply?.id) throw new Error('Lottery response did not confirm a reply ID.');
  } catch (error) {
    if (error.status === 401) client.validatedDay = '';
    if (error.rejected) {
      store.db.prepare('DELETE FROM lottery_attempts WHERE account_id = ? AND post_id = ? AND hour_start = ?').run(account.id, record.postId, hour);
    } else {
      store.db.prepare("UPDATE lottery_attempts SET state = 'uncertain' WHERE account_id = ? AND post_id = ? AND hour_start = ?").run(account.id, record.postId, hour);
      log.warning(`[${account.id}] Delivery is uncertain for ${record.postId}; no repeat will be sent in this hour.`);
    }
    throw error;
  }
  store.db.exec('BEGIN IMMEDIATE');
  try {
    const existing = getEngagement(store, account.id, record.postId);
    const date = dateKeyForTimeZone(sentAt);
    const count = existing?.lastEngagedDate === date ? existing.dailyEngagementCount : 0;
    saveEngagement(store, { ...prepared, lastEngagedDate: date, dailyEngagementCount: count + 1, engagedAt: sentAt.toISOString() });
    store.db.prepare("UPDATE lottery_attempts SET state = 'confirmed', reply_id = ? WHERE account_id = ? AND post_id = ? AND hour_start = ?")
      .run(String(result.reply.id), account.id, record.postId, hour);
    store.db.exec('COMMIT');
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  }
  log.info(`[${account.id}] HTTP lottery confirmed: ${record.postId}, reply ${result.reply.id}, scheduled ${record.scheduledSecond}, sent ${sentAt.toISOString()}, ${now().getTime() - sentAt.getTime()}ms.`);
  renderEngagementHtml(store);
}

// Jobs start independently. A slow account/login/request never holds another
// post's timer, and the same key cannot be dispatched twice concurrently.
class JobPool {
  constructor(onError = (error, key) => log.error(`${key}: ${error.message}`)) { this.jobs = new Map(); this.onError = onError; this.failures = 0; }
  start(key, run) {
    if (this.jobs.has(key)) return false;
    const job = Promise.resolve().then(run).catch((error) => { this.failures += 1; this.onError(error, key); }).finally(() => this.jobs.delete(key));
    this.jobs.set(key, job);
    return true;
  }
  async drain() { await Promise.allSettled(this.jobs.values()); }
}

async function run() {
  const store = openEngagedStore(ENGAGED_DB, ENGAGED_HTML);
  const owner = randomUUID();
  const stop = new AbortController();
  const jobs = new JobPool();
  const clients = new Map();
  const service = process.argv.includes('--service');
  const discoveryInterval = interval('CRAWL_INTERVAL_SECONDS', 3600);
  const messageInterval = interval('MESSAGE_FETCH_INTERVAL_SECONDS', 900);
  const retryInterval = interval('CRAWLER_RESTART_DELAY_SECONDS', 60);
  const onStop = () => stop.abort();
  process.once('SIGTERM', onStop);
  process.once('SIGINT', onStop);
  const valid = (state) => !stop.signal.aborted && clients.get(state.account.id) === state && ownsLease(store, owner);
  let leaseAcquired = false;
  try {
    // A replacement process waits for a crashed owner's short lease to expire.
    for (let attempt = 0; attempt < 35 && !stop.signal.aborted; attempt += 1) {
      if (acquireLease(store, owner)) { leaseAcquired = true; break; }
      if (!service) throw new Error('Another HTTP worker is already running.');
      await sleep(1000, undefined, { signal: stop.signal });
    }
    if (!leaseAcquired) throw new Error('Could not acquire the HTTP worker lease.');
    log.info('HTTP worker started; Playwright is used only to restore authentication.');
    renderEngagementHtml(store);
    let lastAccounts = -Infinity;
    let lastHeartbeat = -Infinity;
    do {
      if (Date.now() - lastHeartbeat >= 5000) {
        if (!acquireLease(store, owner)) throw new Error('HTTP worker lease was lost.');
        lastHeartbeat = Date.now();
      }
      if (Date.now() - lastAccounts >= 5000) {
        const accounts = loadAccounts(store);
        const active = new Set(accounts.map((account) => account.id));
        for (const [id, state] of clients) {
          if (!active.has(id) || credentialsKey(accounts.find((a) => a.id === id)) !== credentialsKey(state.account)) {
            clients.delete(id);
            state.abort.abort();
            await state.client.close();
          }
        }
        for (const account of accounts) {
          if (clients.has(account.id)) continue;
          const abort = new AbortController();
          const signal = AbortSignal.any([stop.signal, abort.signal]);
          const client = new ZfHttpClient({ account, signal, proxyUrl: CONFIG.proxyUrl,
            sessionFile: path.join(PROFILE_DIR, 'http-sessions', `${account.id}.json`),
            login: (value, options) => loginWithBrowser(value, { ...options, signal }), dayKey: dateKeyForTimeZone });
          clients.set(account.id, { account, client, abort,
            discoveryAt: process.env.RUN_ON_START === '0' ? Date.now() + discoveryInterval : 0, messagesAt: 0, signInAt: 0 });
        }
        initializeMessageSync(store, accounts.map((account) => account.id));
        lastAccounts = Date.now();
      }
      for (const state of clients.values()) {
        const { account, client } = state;
        if (client.blockedUntil > Date.now()) continue;
        const routine = (name, duration, action) => {
          if (Date.now() < state[`${name}At`]) return;
          jobs.start(`${account.id}/${name}`, async () => {
            try {
              if (!valid(state)) return;
              await action();
              state[`${name}At`] = Date.now() + duration;
              renderEngagementHtml(store);
            } catch (error) {
              state[`${name}At`] = Date.now() + retryInterval;
              if (name === 'messages') saveMessageSyncError(store, account.id, 'Could not check inbox. Check account login or ZF verification.');
              throw error;
            }
          });
        };
        if (!CONFIG.trackedOnly) {
          if (!CONFIG.messagesOnly) {
            routine('discovery', discoveryInterval, () => discoverAccount(client, store, account, () => valid(state)));
            routine('signIn', 60000, () => dailySignIn(client, store, account));
          }
          routine('messages', messageInterval, async () => {
            const count = await fetchPrivateMessagesHttp(client, store, account.id);
            log.info(`[${account.id}] HTTP inbox checked: ${count} conversations.`);
          });
        }
      }
      if (!CONFIG.messagesOnly && (service || CONFIG.trackedOnly)) {
        const now = new Date();
        for (const record of refreshLotterySchedules(store, now)) {
          const state = clients.get(record.accountId);
          if (!state || state.client.blockedUntil > Date.now() || !Number.isFinite(record.scheduledSecond)
            || record.scheduledSecond - secondValueForTimeZone(now) > 30) continue;
          jobs.start(`${record.accountId}/lottery/${record.postId}`, async () => {
            try {
              await engagePost({ client: state.client, store, account: state.account, record, guard: () => valid(state),
                signal: AbortSignal.any([stop.signal, state.abort.signal]) });
            } finally {
              rescheduleLotteryRequest(store, record.accountId, { uniqueKey: record.postId, userData: record });
            }
          });
        }
      }
      if (!service) {
        // Keep the lease alive while a one-shot command finishes its jobs.
        const heartbeat = setInterval(() => { if (!acquireLease(store, owner)) stop.abort(); }, 5000);
        try { await jobs.drain(); } finally { clearInterval(heartbeat); }
        if (jobs.failures) throw new Error(`${jobs.failures} HTTP jobs failed.`);
        break;
      }
      await sleep(1000, undefined, { signal: stop.signal });
    } while (!stop.signal.aborted);
  } catch (error) {
    if (!stop.signal.aborted) throw error;
  } finally {
    stop.abort();
    await jobs.drain();
    await Promise.allSettled([...clients.values()].map((state) => state.client.close()));
    if (leaseAcquired) store.db.prepare("DELETE FROM worker_lease WHERE name = 'http-worker' AND owner = ?").run(owner);
    store.db.close();
    process.removeListener('SIGTERM', onStop);
    process.removeListener('SIGINT', onStop);
  }
}

module.exports = { run, acquireLease, ownsLease, dailySignIn, discoverPosts, readPost, discoverAccount, claimAttempt, engagePost, JobPool };
