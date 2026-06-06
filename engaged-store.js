const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_ACCOUNT_ID = 'default';

function openEngagedStore(dbPath, htmlPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  migrateLegacyEngagements(db);
  migrateLegacySignIns(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS engaged_lotteries (
      account_id TEXT NOT NULL,
      post_id TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      engaged_at TEXT NOT NULL,
      PRIMARY KEY (account_id, post_id),
      UNIQUE (account_id, url)
    );
    CREATE INDEX IF NOT EXISTS idx_engaged_lotteries_account_engaged_at
      ON engaged_lotteries (account_id, engaged_at DESC);

    CREATE TABLE IF NOT EXISTS daily_sign_ins (
      account_id TEXT NOT NULL,
      sign_in_date TEXT NOT NULL,
      signed_at TEXT NOT NULL,
      url TEXT NOT NULL,
      status TEXT NOT NULL,
      message TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (account_id, sign_in_date)
    );
    CREATE INDEX IF NOT EXISTS idx_daily_sign_ins_account_signed_at
      ON daily_sign_ins (account_id, signed_at DESC);

    CREATE TABLE IF NOT EXISTS zfrontier_accounts (
      id TEXT PRIMARY KEY,
      phone TEXT NOT NULL,
      password TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_zfrontier_accounts_enabled
      ON zfrontier_accounts (enabled, id);
  `);

  return { db, dbPath, htmlPath };
}

function migrateLegacyEngagements(db) {
  const columns = tableColumns(db, 'engaged_lotteries');
  if (columns.length === 0 || isCompositePrimaryKey(columns, ['account_id', 'post_id'])) return;

  const legacyTable = 'engaged_lotteries_legacy_migration';
  const accountExpr = columns.some((column) => column.name === 'account_id')
    ? `COALESCE(NULLIF(account_id, ''), '${DEFAULT_ACCOUNT_ID}')`
    : `'${DEFAULT_ACCOUNT_ID}'`;

  db.exec(`
    DROP TABLE IF EXISTS ${legacyTable};
    ALTER TABLE engaged_lotteries RENAME TO ${legacyTable};
    CREATE TABLE engaged_lotteries (
      account_id TEXT NOT NULL,
      post_id TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      engaged_at TEXT NOT NULL,
      PRIMARY KEY (account_id, post_id),
      UNIQUE (account_id, url)
    );
    INSERT OR IGNORE INTO engaged_lotteries (account_id, post_id, title, url, engaged_at)
      SELECT ${accountExpr}, post_id, title, url, engaged_at
      FROM ${legacyTable};
    DROP TABLE ${legacyTable};
  `);
}

function migrateLegacySignIns(db) {
  const columns = tableColumns(db, 'daily_sign_ins');
  if (columns.length === 0 || isCompositePrimaryKey(columns, ['account_id', 'sign_in_date'])) return;

  const legacyTable = 'daily_sign_ins_legacy_migration';
  const accountExpr = columns.some((column) => column.name === 'account_id')
    ? `COALESCE(NULLIF(account_id, ''), '${DEFAULT_ACCOUNT_ID}')`
    : `'${DEFAULT_ACCOUNT_ID}'`;

  db.exec(`
    DROP TABLE IF EXISTS ${legacyTable};
    ALTER TABLE daily_sign_ins RENAME TO ${legacyTable};
    CREATE TABLE daily_sign_ins (
      account_id TEXT NOT NULL,
      sign_in_date TEXT NOT NULL,
      signed_at TEXT NOT NULL,
      url TEXT NOT NULL,
      status TEXT NOT NULL,
      message TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (account_id, sign_in_date)
    );
    INSERT OR IGNORE INTO daily_sign_ins (account_id, sign_in_date, signed_at, url, status, message)
      SELECT ${accountExpr}, sign_in_date, signed_at, url, status, message
      FROM ${legacyTable};
    DROP TABLE ${legacyTable};
  `);
}

function tableColumns(db, tableName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all()
    .map((column) => ({ name: column.name, pk: column.pk }));
}

function isCompositePrimaryKey(columns, names) {
  return names.every((name, index) => {
    const column = columns.find((candidate) => candidate.name === name);
    return column?.pk === index + 1;
  });
}

function hasEngagement(store, accountId, postId) {
  return Boolean(store.db.prepare(`
    SELECT 1 FROM engaged_lotteries WHERE account_id = ? AND post_id = ?
  `).get(accountId, postId));
}

function saveEngagement(store, record) {
  store.db.prepare(`
    INSERT INTO engaged_lotteries (account_id, post_id, title, url, engaged_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(account_id, post_id) DO UPDATE SET
      title = excluded.title,
      url = excluded.url,
      engaged_at = excluded.engaged_at
  `).run(record.accountId, record.postId, record.title || record.url, record.url, record.engagedAt);
}

function hasSignIn(store, accountId, signInDate) {
  return Boolean(store.db.prepare(`
    SELECT 1 FROM daily_sign_ins WHERE account_id = ? AND sign_in_date = ?
  `).get(accountId, signInDate));
}

function saveSignIn(store, record) {
  store.db.prepare(`
    INSERT INTO daily_sign_ins (account_id, sign_in_date, signed_at, url, status, message)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, sign_in_date) DO UPDATE SET
      signed_at = excluded.signed_at,
      url = excluded.url,
      status = excluded.status,
      message = excluded.message
  `).run(
    record.accountId,
    record.signInDate,
    record.signedAt,
    record.url,
    record.status,
    record.message || '',
  );
}

function countEngagements(store) {
  return store.db.prepare('SELECT COUNT(*) AS count FROM engaged_lotteries').get().count;
}

function countSignIns(store) {
  return store.db.prepare('SELECT COUNT(*) AS count FROM daily_sign_ins').get().count;
}

function listEngagements(store) {
  return store.db.prepare(`
    SELECT account_id AS accountId, post_id AS postId, title, url, engaged_at AS engagedAt
    FROM engaged_lotteries
    ORDER BY engaged_at DESC
  `).all();
}

function listSignIns(store) {
  return store.db.prepare(`
    SELECT account_id AS accountId, sign_in_date AS signInDate, signed_at AS signedAt, url, status, message
    FROM daily_sign_ins
    ORDER BY signed_at DESC
  `).all();
}

function listAccounts(store, options = {}) {
  const where = options.enabledOnly ? 'WHERE enabled = 1' : '';
  return store.db.prepare(`
    SELECT id, phone, password, enabled, created_at AS createdAt, updated_at AS updatedAt
    FROM zfrontier_accounts
    ${where}
    ORDER BY id
  `).all().map((row) => ({
    ...row,
    enabled: row.enabled === 1,
  }));
}

function renderEngagementHtml(store) {
  const lotteryRows = listEngagements(store);
  const signInRows = listSignIns(store);
  fs.writeFileSync(store.htmlPath, buildHtml(lotteryRows, signInRows), 'utf8');
}

function buildHtml(lotteryRows, signInRows) {
  const generatedAt = new Date().toISOString();
  const accountCount = countUniqueAccounts(lotteryRows, signInRows);
  const lotteryTableRows = lotteryRows.map((row, index) => `
          <tr>
            <td>${index + 1}</td>
            <td><code>${escapeHtml(row.accountId)}</code></td>
            <td><a href="${escapeAttr(row.url)}" target="_blank" rel="noreferrer">${escapeHtml(row.title)}</a></td>
            <td><time datetime="${escapeAttr(row.engagedAt)}" data-local-datetime>${escapeHtml(formatDate(row.engagedAt))}</time></td>
            <td><code>${escapeHtml(row.postId)}</code></td>
          </tr>`).join('');
  const signInTableRows = signInRows.map((row, index) => `
          <tr>
            <td>${index + 1}</td>
            <td><code>${escapeHtml(row.accountId)}</code></td>
            <td><code>${escapeHtml(row.signInDate)}</code></td>
            <td><time datetime="${escapeAttr(row.signedAt)}" data-local-datetime>${escapeHtml(formatDate(row.signedAt))}</time></td>
            <td>${escapeHtml(row.status)}</td>
            <td>${escapeHtml(row.message)}</td>
          </tr>`).join('');

  const emptyLotteryState = lotteryRows.length === 0
    ? '<p class="empty">No engaged lotteries have been recorded yet.</p>'
    : '';
  const emptySignInState = signInRows.length === 0
    ? '<p class="empty">No daily sign-ins have been recorded yet.</p>'
    : '';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>zFrontier Activity Report</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f6f7f8;
        --fg: #1d252c;
        --muted: #66727d;
        --line: #d9dee3;
        --panel: #ffffff;
        --accent: #008879;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background: var(--bg);
        color: var(--fg);
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      main {
        width: min(1120px, calc(100vw - 32px));
        margin: 32px auto;
      }
      header {
        display: flex;
        align-items: end;
        justify-content: space-between;
        gap: 24px;
        margin-bottom: 18px;
      }
      h1 {
        margin: 0;
        font-size: 26px;
        line-height: 1.2;
      }
      .header-copy {
        display: grid;
        gap: 10px;
      }
      .page-nav {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .page-nav a {
        display: inline-flex;
        align-items: center;
        min-height: 32px;
        padding: 5px 10px;
        border: 1px solid var(--line);
        background: var(--panel);
        color: var(--fg);
        font-size: 14px;
      }
      .page-nav a[aria-current="page"] {
        border-color: var(--accent);
        color: var(--accent);
      }
      section + section {
        margin-top: 28px;
      }
      h2 {
        margin: 0 0 12px;
        font-size: 18px;
        line-height: 1.3;
      }
      .meta {
        color: var(--muted);
        font-size: 14px;
        text-align: right;
      }
      .empty {
        margin: 0;
        padding: 18px;
        border: 1px solid var(--line);
        background: var(--panel);
      }
      [hidden] {
        display: none !important;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        background: var(--panel);
        border: 1px solid var(--line);
      }
      th, td {
        padding: 12px 14px;
        border-bottom: 1px solid var(--line);
        text-align: left;
        vertical-align: top;
      }
      th {
        color: var(--muted);
        font-size: 12px;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        background: #fbfcfd;
      }
      tr:last-child td { border-bottom: 0; }
      a {
        color: var(--accent);
        text-decoration: none;
      }
      a:hover { text-decoration: underline; }
      code {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 12px;
        color: var(--muted);
      }
      .pagination {
        display: flex;
        justify-content: flex-end;
        align-items: center;
        gap: 10px;
        margin-top: 10px;
        color: var(--muted);
        font-size: 14px;
      }
      .pagination button {
        min-width: 72px;
        padding: 6px 10px;
        border: 1px solid var(--line);
        border-radius: 4px;
        background: var(--panel);
        color: var(--fg);
        font: inherit;
        cursor: pointer;
      }
      .pagination button:hover:not(:disabled) {
        border-color: var(--accent);
        color: var(--accent);
      }
      .pagination button:disabled {
        cursor: not-allowed;
        opacity: 0.45;
      }
      @media (max-width: 720px) {
        header {
          display: block;
        }
        .meta {
          margin-top: 8px;
          text-align: left;
        }
        .lottery-table th:nth-child(5), .lottery-table td:nth-child(5) {
          display: none;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <div class="header-copy">
          <h1>zFrontier Activity Report</h1>
          <nav class="page-nav" aria-label="Primary">
            <a href="/" aria-current="page">Report</a>
            <a href="/config">Configuration</a>
          </nav>
        </div>
        <div class="meta">
          <div>${accountCount} accounts</div>
          <div>${lotteryRows.length} lotteries</div>
          <div>${signInRows.length} sign-ins</div>
          <div>Generated <time datetime="${escapeAttr(generatedAt)}" data-local-datetime>${escapeHtml(formatDate(generatedAt))}</time></div>
        </div>
      </header>
      <section>
        <h2>Engaged Lotteries</h2>
        ${emptyLotteryState}
        ${lotteryRows.length > 0 ? `<table class="lottery-table" data-paginated-table data-page-size="20">
          <thead>
            <tr>
              <th>#</th>
              <th>Account</th>
              <th>Title</th>
              <th>Engaged Date</th>
              <th>Post ID</th>
            </tr>
          </thead>
          <tbody>${lotteryTableRows}
          </tbody>
        </table>
        <div class="pagination" data-pagination hidden>
          <button type="button" data-page-prev>Prev</button>
          <span data-page-status></span>
          <button type="button" data-page-next>Next</button>
        </div>` : ''}
      </section>
      <section>
        <h2>Daily Sign-ins</h2>
        ${emptySignInState}
        ${signInRows.length > 0 ? `<table data-paginated-table data-page-size="20">
          <thead>
            <tr>
              <th>#</th>
              <th>Account</th>
              <th>Date</th>
              <th>Signed At</th>
              <th>Status</th>
              <th>Message</th>
            </tr>
          </thead>
          <tbody>${signInTableRows}
          </tbody>
        </table>
        <div class="pagination" data-pagination hidden>
          <button type="button" data-page-prev>Prev</button>
          <span data-page-status></span>
          <button type="button" data-page-next>Next</button>
        </div>` : ''}
      </section>
    </main>
    <script>
      (() => {
        const pad = (value) => String(value).padStart(2, '0');
        const formatLocalDateTime = (date) => (
          date.getFullYear() + '-' +
          pad(date.getMonth() + 1) + '-' +
          pad(date.getDate()) + ' ' +
          pad(date.getHours()) + ':' +
          pad(date.getMinutes()) + ':' +
          pad(date.getSeconds())
        );

        document.querySelectorAll('time[data-local-datetime]').forEach((node) => {
          const value = node.getAttribute('datetime');
          const date = new Date(value);
          if (Number.isNaN(date.getTime())) return;
          node.textContent = formatLocalDateTime(date);
          node.title = value;
        });

        document.querySelectorAll('table[data-paginated-table]').forEach((table) => {
          const rows = Array.from(table.querySelectorAll('tbody tr'));
          const controls = table.nextElementSibling?.matches('[data-pagination]')
            ? table.nextElementSibling
            : null;
          const pageSize = Number(table.dataset.pageSize || 20);
          if (!controls || rows.length === 0 || pageSize <= 0) return;

          let page = 0;
          const pageCount = Math.ceil(rows.length / pageSize);
          const previous = controls.querySelector('[data-page-prev]');
          const next = controls.querySelector('[data-page-next]');
          const status = controls.querySelector('[data-page-status]');

          const renderPage = () => {
            const start = page * pageSize;
            const end = Math.min(start + pageSize, rows.length);
            rows.forEach((row, index) => {
              row.hidden = index < start || index >= end;
            });
            previous.disabled = page === 0;
            next.disabled = page >= pageCount - 1;
            status.textContent = (start + 1) + '-' + end + ' of ' + rows.length;
          };

          previous.addEventListener('click', () => {
            if (page === 0) return;
            page -= 1;
            renderPage();
          });
          next.addEventListener('click', () => {
            if (page >= pageCount - 1) return;
            page += 1;
            renderPage();
          });

          controls.hidden = false;
          renderPage();
        });
      })();
    </script>
  </body>
</html>
`;
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return formatLocalDateTime(date);
}

function formatLocalDateTime(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join('-') + ' ' + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join(':');
}

function countUniqueAccounts(...groups) {
  const accounts = new Set();
  groups.flat().forEach((row) => {
    if (row.accountId) accounts.add(row.accountId);
  });
  return accounts.size;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

module.exports = {
  countEngagements,
  countSignIns,
  hasEngagement,
  hasSignIn,
  listAccounts,
  listEngagements,
  listSignIns,
  openEngagedStore,
  renderEngagementHtml,
  saveEngagement,
  saveSignIn,
};
