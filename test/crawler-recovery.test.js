const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

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
