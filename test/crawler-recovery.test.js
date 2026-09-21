const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const entrypoint = fs.readFileSync(path.join(__dirname, '../docker/entrypoint.sh'), 'utf8');
const functions = entrypoint.slice(entrypoint.indexOf('run_crawler_once()'), entrypoint.indexOf('cleanup()'));

test('completed CLI jobs exit with their result even if a crashed browser leaves a live handle', () => {
  for (const exitCode of [0, 1]) {
    const result = spawnSync(process.execPath, ['-e', `
      const { finishCrawlerProcess } = require('./zfrontier-lottery-crawler');
      setInterval(() => {}, 1000);
      finishCrawlerProcess(${exitCode}, 50);
    `], { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, exitCode, result.stderr);
    assert.match(result.stdout + result.stderr, /shutdown exceeded/);
  }
});

test('failed discovery and message jobs retry instead of sleeping for the successful-run interval', () => {
  for (const loop of ['crawler_loop', 'message_loop']) {
    const result = spawnSync('bash', ['-c', `${functions}
      CRAWL_INTERVAL_SECONDS=900
      MESSAGE_FETCH_INTERVAL_SECONDS=900
      CRAWLER_RESTART_DELAY_SECONDS=60
      run_crawler_once() { return 1; }
      sleep() { echo "RETRY:$1"; exit 0; }
      ${loop}
    `], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'RETRY:60');
  }
});

test('job failures reach the retry loop with their original exit status', () => {
  const result = spawnSync('bash', ['-c', `${functions}
    timeout() { return 7; }
    run_crawler_once hourly
  `], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 7, result.stderr);
});

test('a stuck single-post process is killed before the full-crawl deadline', { skip: process.platform !== 'linux' }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-watchdog-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'node'), '#!/bin/sh\ntrap "" TERM\nwhile :; do sleep 1; done\n', { mode: 0o755 });
  const result = spawnSync('bash', ['-c', `${functions}
    CRAWLER_RUN_TIMEOUT_SECONDS=30
    HOURLY_RUN_TIMEOUT_SECONDS=1
    CRAWLER_KILL_AFTER_SECONDS=1
    run_crawler_once hourly
  `], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 75, result.stderr);
  assert.match(result.stderr, /timed out after 1s/);
});
