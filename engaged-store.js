const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_ACCOUNT_ID = 'default';
const APP_CSS = `
      :root {
        color-scheme: light;
        --bg: oklch(0.967 0.006 178);
        --surface: oklch(1 0 0);
        --surface-muted: oklch(0.94 0.008 178);
        --ink: oklch(0.24 0.018 190);
        --ink-muted: oklch(0.44 0.018 190);
        --line: oklch(0.86 0.011 185);
        --line-strong: oklch(0.76 0.017 185);
        --accent: oklch(0.47 0.09 178);
        --accent-strong: oklch(0.39 0.087 178);
        --accent-soft: oklch(0.91 0.038 178);
        --danger: oklch(0.48 0.16 28);
        --danger-soft: oklch(0.94 0.04 28);
        --success: oklch(0.45 0.11 154);
        --success-soft: oklch(0.92 0.04 154);
        --focus: oklch(0.62 0.14 178);
        --radius: 10px;
        --radius-sm: 7px;
      }

      * { box-sizing: border-box; }
      html { min-height: 100%; }
      body {
        min-height: 100%;
        margin: 0;
        background: var(--bg);
        color: var(--ink);
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-size: 14px;
        line-height: 1.45;
      }
      a {
        color: var(--accent-strong);
        text-decoration: none;
      }
      a:hover { text-decoration: underline; }
      :focus-visible {
        outline: 3px solid color-mix(in oklch, var(--focus), transparent 35%);
        outline-offset: 2px;
      }
      button,
      .btn,
      input,
      select {
        border-radius: var(--radius-sm);
        font: inherit;
      }
      button,
      .btn {
        min-height: 34px;
        border: 1px solid var(--line-strong);
        background: var(--surface);
        color: var(--ink);
        cursor: pointer;
        font-weight: 650;
        letter-spacing: 0;
        padding: 0 12px;
        text-decoration: none;
        text-transform: none;
        transition: background-color 160ms ease, border-color 160ms ease, color 160ms ease;
      }
      button:hover,
      .btn:hover {
        border-color: var(--accent);
        background: var(--accent-soft);
        color: var(--accent-strong);
        text-decoration: none;
      }
      button:disabled,
      .btn[aria-disabled="true"] {
        cursor: not-allowed;
        opacity: 0.52;
      }
      input,
      select {
        min-height: 36px;
        border: 1px solid var(--line-strong);
        background: var(--surface);
        color: var(--ink);
        padding: 0 10px;
      }
      input::placeholder { color: var(--ink-muted); opacity: 1; }
      input[readonly] {
        background: var(--surface-muted);
        color: var(--ink-muted);
      }
      code {
        color: var(--ink-muted);
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 12px;
      }
      main {
        width: min(1180px, calc(100vw - 32px));
        margin: 0 auto 48px;
      }
      .app-bar {
        position: sticky;
        top: 0;
        z-index: 20;
        border-bottom: 1px solid var(--line);
        background: color-mix(in oklch, var(--surface), var(--bg) 10%);
      }
      .app-bar__inner {
        width: min(1180px, calc(100vw - 32px));
        min-height: 64px;
        margin: 0 auto;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 18px;
      }
      .brand {
        display: flex;
        align-items: center;
        gap: 11px;
        min-width: 0;
      }
      .brand__mark {
        display: grid;
        place-items: center;
        width: 34px;
        height: 34px;
        border-radius: 8px;
        background: var(--accent);
        color: white;
        font-size: 13px;
        font-weight: 800;
        letter-spacing: 0;
      }
      .brand__text {
        min-width: 0;
      }
      .brand__name {
        margin: 0;
        color: var(--ink);
        font-size: 15px;
        font-weight: 760;
        line-height: 1.1;
      }
      .brand__sub {
        margin: 3px 0 0;
        color: var(--ink-muted);
        font-size: 12px;
        line-height: 1.2;
      }
      .app-nav {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 6px;
      }
      .app-nav a {
        display: inline-flex;
        align-items: center;
        min-height: 34px;
        padding: 0 12px;
        border-radius: 999px;
        color: var(--ink-muted);
        font-weight: 650;
        text-decoration: none;
      }
      .app-nav a:hover {
        background: var(--surface-muted);
        color: var(--ink);
      }
      .app-nav a[aria-current="page"] {
        background: var(--accent);
        color: white;
      }
      .page-header {
        display: flex;
        align-items: end;
        justify-content: space-between;
        gap: 24px;
        padding: 30px 0 22px;
      }
      .page-title {
        margin: 0;
        font-size: 28px;
        line-height: 1.16;
        letter-spacing: -0.015em;
        text-wrap: balance;
      }
      .page-copy {
        max-width: 66ch;
        margin: 8px 0 0;
        color: var(--ink-muted);
      }
      .metric-strip {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        justify-content: flex-end;
      }
      .metric {
        min-width: 112px;
        padding: 9px 11px;
        border: 1px solid var(--line);
        border-radius: var(--radius);
        background: var(--surface);
      }
      .metric__label {
        display: block;
        color: var(--ink-muted);
        font-size: 11px;
        font-weight: 700;
      }
      .metric__value {
        display: block;
        margin-top: 2px;
        color: var(--ink);
        font-size: 16px;
        font-weight: 760;
      }
      .toolbar {
        display: flex;
        align-items: end;
        justify-content: space-between;
        gap: 14px;
        margin-bottom: 22px;
        padding: 12px;
        border: 1px solid var(--line);
        border-radius: var(--radius);
        background: var(--surface);
      }
      .field {
        display: grid;
        gap: 6px;
        min-width: 220px;
      }
      .field span,
      label > span {
        color: var(--ink-muted);
        font-size: 12px;
        font-weight: 700;
      }
      section + section { margin-top: 30px; }
      .section-heading {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        margin-bottom: 12px;
      }
      .section-heading h2 {
        margin: 0;
        font-size: 18px;
        line-height: 1.25;
        letter-spacing: -0.01em;
      }
      .section-note {
        margin: 0;
        color: var(--ink-muted);
        font-size: 13px;
      }
      .panel {
        border: 1px solid var(--line);
        border-radius: var(--radius);
        background: var(--surface);
        overflow: hidden;
      }
      .empty {
        padding: 18px;
        color: var(--ink-muted);
      }
      .empty strong {
        display: block;
        margin-bottom: 4px;
        color: var(--ink);
      }
      [hidden] { display: none !important; }
      .table-container {
        overflow-x: auto;
      }
      table {
        width: 100%;
        border-collapse: collapse;
      }
      .report-table table {
        min-width: 980px;
      }
      th,
      td {
        border-bottom: 1px solid var(--line);
        padding: 11px 13px;
        text-align: left;
        vertical-align: middle;
        white-space: nowrap;
      }
      th {
        background: var(--surface-muted);
        color: var(--ink-muted);
        font-size: 12px;
        font-weight: 760;
      }
      tbody tr:hover {
        background: color-mix(in oklch, var(--accent-soft), white 45%);
      }
      tbody tr:last-child td {
        border-bottom: 0;
      }
      .lottery-table td:nth-child(3) {
        min-width: 300px;
        white-space: normal;
      }
      .pagination {
        display: flex;
        justify-content: flex-end;
        align-items: center;
        gap: 10px;
        margin-top: 10px;
        color: var(--ink-muted);
        font-size: 13px;
      }
      .pagination button {
        min-width: 76px;
      }
      .notice {
        margin: 0 0 18px;
        padding: 12px 14px;
        border: 1px solid color-mix(in oklch, var(--success), white 50%);
        border-radius: var(--radius);
        background: var(--success-soft);
        color: oklch(0.32 0.09 154);
      }
      .form-panel {
        padding: 14px;
      }
      .account-row,
      .new-account {
        border: 1px solid var(--line);
        border-radius: var(--radius);
        background: var(--surface);
        padding: 14px;
      }
      .account-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 12px 16px;
        align-items: start;
      }
      .account-row + .account-row {
        margin-top: 10px;
      }
      .account-form,
      .new-account {
        display: grid;
        grid-template-columns: minmax(150px, 1fr) minmax(180px, 1.2fr) minmax(180px, 1.2fr) auto;
        gap: 12px;
        align-items: end;
      }
      .new-account {
        grid-template-columns: minmax(150px, 1fr) minmax(180px, 1.2fr) minmax(180px, 1.2fr) auto auto;
      }
      label {
        display: grid;
        gap: 6px;
      }
      .check {
        display: flex;
        align-items: center;
        gap: 8px;
        min-height: 36px;
        color: var(--ink);
      }
      .check input {
        width: 18px;
        min-height: 18px;
      }
      .account-actions {
        display: grid;
        gap: 8px;
        min-width: 84px;
        padding-top: 26px;
      }
      .account-actions button,
      .new-account button {
        width: 100%;
      }
      .delete-form {
        margin: 0;
      }
      .danger,
      .btn-danger,
      .action-danger {
        border-color: color-mix(in oklch, var(--danger), white 35%);
        color: var(--danger);
      }
      .danger:hover,
      .btn-danger:hover,
      .action-danger:hover {
        border-color: var(--danger);
        background: var(--danger-soft);
        color: var(--danger);
      }
      .btn-success,
      .action-primary {
        border-color: var(--accent);
        background: var(--accent);
        color: white;
      }
      .btn-success:hover,
      .action-primary:hover {
        border-color: var(--accent-strong);
        background: var(--accent-strong);
        color: white;
      }
      .row-meta {
        grid-column: 1 / -1;
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        margin-top: 2px;
        color: var(--ink-muted);
        font-size: 12px;
      }
      @media (max-width: 860px) {
        .app-bar__inner,
        .page-header {
          align-items: stretch;
          flex-direction: column;
        }
        .app-nav,
        .metric-strip {
          justify-content: flex-start;
        }
        .toolbar {
          align-items: stretch;
          flex-direction: column;
        }
        .field {
          min-width: 0;
        }
        .account-row {
          grid-template-columns: 1fr;
        }
        .account-form,
        .new-account {
          grid-template-columns: 1fr;
        }
        .account-actions {
          grid-template-columns: 1fr 1fr;
          padding-top: 0;
        }
      }
      @media (max-width: 720px) {
        main,
        .app-bar__inner {
          width: min(100vw - 20px, 1180px);
        }
        .page-header {
          padding-top: 22px;
        }
        .page-title {
          font-size: 24px;
        }
        .section-heading {
          align-items: flex-start;
          flex-direction: column;
        }
        .metric {
          min-width: calc(50% - 4px);
        }
        .lottery-table th:nth-child(7),
        .lottery-table td:nth-child(7) {
          display: none;
        }
      }
      @media (prefers-reduced-motion: reduce) {
        *,
        *::before,
        *::after {
          scroll-behavior: auto !important;
          transition-duration: 0.01ms !important;
          animation-duration: 0.01ms !important;
          animation-iteration-count: 1 !important;
        }
      }`;

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
      draw_at TEXT NOT NULL DEFAULT '',
      last_engaged_date TEXT NOT NULL DEFAULT '',
      daily_engagement_count INTEGER NOT NULL DEFAULT 0,
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
  addColumnIfMissing(db, 'engaged_lotteries', 'draw_at', "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, 'engaged_lotteries', 'last_engaged_date', "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, 'engaged_lotteries', 'daily_engagement_count', 'INTEGER NOT NULL DEFAULT 0');
  backfillEngagementDailyState(db);

  return { db, dbPath, htmlPath };
}

function migrateLegacyEngagements(db) {
  const columns = tableColumns(db, 'engaged_lotteries');
  if (columns.length === 0 || isCompositePrimaryKey(columns, ['account_id', 'post_id'])) return;

  const legacyTable = 'engaged_lotteries_legacy_migration';
  const accountExpr = columns.some((column) => column.name === 'account_id')
    ? `COALESCE(NULLIF(account_id, ''), '${DEFAULT_ACCOUNT_ID}')`
    : `'${DEFAULT_ACCOUNT_ID}'`;
  const drawAtExpr = legacyColumnExpr(columns, 'draw_at', "''");
  const lastEngagedDateExpr = legacyColumnExpr(columns, 'last_engaged_date', "substr(engaged_at, 1, 10)");
  const dailyEngagementCountExpr = legacyColumnExpr(columns, 'daily_engagement_count', '1');

  db.exec(`
    DROP TABLE IF EXISTS ${legacyTable};
    ALTER TABLE engaged_lotteries RENAME TO ${legacyTable};
    CREATE TABLE engaged_lotteries (
      account_id TEXT NOT NULL,
      post_id TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      draw_at TEXT NOT NULL DEFAULT '',
      last_engaged_date TEXT NOT NULL DEFAULT '',
      daily_engagement_count INTEGER NOT NULL DEFAULT 0,
      engaged_at TEXT NOT NULL,
      PRIMARY KEY (account_id, post_id),
      UNIQUE (account_id, url)
    );
    INSERT OR IGNORE INTO engaged_lotteries (account_id, post_id, title, url, draw_at, last_engaged_date, daily_engagement_count, engaged_at)
      SELECT ${accountExpr}, post_id, title, url, ${drawAtExpr}, ${lastEngagedDateExpr}, ${dailyEngagementCountExpr}, engaged_at
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

function addColumnIfMissing(db, tableName, columnName, definition) {
  const columns = tableColumns(db, tableName);
  if (columns.some((column) => column.name === columnName)) return;
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}

function legacyColumnExpr(columns, columnName, fallback) {
  return columns.some((column) => column.name === columnName)
    ? `COALESCE(${columnName}, ${fallback})`
    : fallback;
}

function backfillEngagementDailyState(db) {
  db.exec(`
    UPDATE engaged_lotteries
    SET
      last_engaged_date = CASE
        WHEN last_engaged_date = '' THEN substr(engaged_at, 1, 10)
        ELSE last_engaged_date
      END,
      daily_engagement_count = CASE
        WHEN daily_engagement_count <= 0 THEN 1
        ELSE daily_engagement_count
      END
    WHERE engaged_at != ''
      AND (last_engaged_date = '' OR daily_engagement_count <= 0)
  `);
}

function getEngagement(store, accountId, postId) {
  return store.db.prepare(`
    SELECT
      account_id AS accountId,
      post_id AS postId,
      title,
      url,
      draw_at AS drawAt,
      last_engaged_date AS lastEngagedDate,
      daily_engagement_count AS dailyEngagementCount,
      engaged_at AS engagedAt
    FROM engaged_lotteries
    WHERE account_id = ? AND post_id = ?
  `).get(accountId, postId);
}

function hasEngagement(store, accountId, postId) {
  return Boolean(getEngagement(store, accountId, postId));
}

function saveEngagement(store, record) {
  const dailyEngagementCount = Number(record.dailyEngagementCount);
  store.db.prepare(`
    INSERT INTO engaged_lotteries (
      account_id,
      post_id,
      title,
      url,
      draw_at,
      last_engaged_date,
      daily_engagement_count,
      engaged_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, post_id) DO UPDATE SET
      title = excluded.title,
      url = excluded.url,
      draw_at = CASE
        WHEN excluded.draw_at != '' THEN excluded.draw_at
        ELSE engaged_lotteries.draw_at
      END,
      last_engaged_date = CASE
        WHEN excluded.last_engaged_date != '' THEN excluded.last_engaged_date
        ELSE engaged_lotteries.last_engaged_date
      END,
      daily_engagement_count = CASE
        WHEN excluded.last_engaged_date != '' THEN excluded.daily_engagement_count
        ELSE engaged_lotteries.daily_engagement_count
      END,
      engaged_at = excluded.engaged_at
  `).run(
    record.accountId,
    record.postId,
    record.title || record.url,
    record.url,
    record.drawAt || '',
    record.lastEngagedDate || record.dailyEngagementDate || '',
    Number.isFinite(dailyEngagementCount) && dailyEngagementCount > 0 ? dailyEngagementCount : 1,
    record.engagedAt,
  );
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
    SELECT
      account_id AS accountId,
      post_id AS postId,
      title,
      url,
      draw_at AS drawAt,
      last_engaged_date AS lastEngagedDate,
      daily_engagement_count AS dailyEngagementCount,
      engaged_at AS engagedAt
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
  const accountRows = listAccounts(store);
  fs.writeFileSync(store.htmlPath, buildHtml(lotteryRows, signInRows, accountRows), 'utf8');
}

function renderAppBar(activePage) {
  const navItems = [
    { id: 'report', label: 'Report', href: '/' },
    { id: 'config', label: 'Configuration', href: '/config' },
  ];
  const nav = navItems.map((item) => {
    const current = item.id === activePage ? ' aria-current="page"' : '';
    return `<a href="${item.href}"${current}>${item.label}</a>`;
  }).join('');

  return `
    <div class="app-bar">
      <div class="app-bar__inner">
        <div class="brand">
          <div class="brand__mark" aria-hidden="true">ZF</div>
          <div class="brand__text">
            <p class="brand__name">zFrontier Crawler</p>
            <p class="brand__sub">Lottery and sign-in operations</p>
          </div>
        </div>
        <nav class="app-nav" aria-label="Primary">${nav}</nav>
      </div>
    </div>`;
}

function renderMetricStrip(metrics) {
  return `
          <div class="metric-strip">
            ${metrics.map((metric) => `
            <div class="metric">
              <span class="metric__label">${escapeHtml(metric.label)}</span>
              <span class="metric__value">${escapeHtml(metric.value)}</span>
            </div>`).join('')}
          </div>`;
}

function buildHtml(lotteryRows, signInRows, accountRows = []) {
  const generatedAt = new Date().toISOString();
  const accountCount = countUniqueAccounts(lotteryRows, signInRows, accountRows);
  const accountFilterOptions = renderAccountFilterOptions(accountRows, lotteryRows, signInRows);
  const metrics = renderMetricStrip([
    { label: 'Accounts', value: String(accountCount) },
    { label: 'Lotteries', value: String(lotteryRows.length) },
    { label: 'Sign-ins', value: String(signInRows.length) },
    { label: 'Generated', value: formatDate(generatedAt) },
  ]);
  const lotteryTableRows = lotteryRows.map((row, index) => `
          <tr data-account-id="${escapeAttr(row.accountId)}">
            <td>${index + 1}</td>
            <td><code>${escapeHtml(row.accountId)}</code></td>
            <td><a href="${escapeAttr(row.url)}" target="_blank" rel="noreferrer">${escapeHtml(row.title)}</a></td>
            <td>${renderDrawTime(row.drawAt)}</td>
            <td>${renderDailyEngagementCount(row)}</td>
            <td><time datetime="${escapeAttr(row.engagedAt)}" data-local-datetime>${escapeHtml(formatDate(row.engagedAt))}</time></td>
            <td><code>${escapeHtml(row.postId)}</code></td>
          </tr>`).join('');
  const signInTableRows = signInRows.map((row, index) => `
          <tr data-account-id="${escapeAttr(row.accountId)}">
            <td>${index + 1}</td>
            <td><code>${escapeHtml(row.accountId)}</code></td>
            <td><code>${escapeHtml(row.signInDate)}</code></td>
            <td><time datetime="${escapeAttr(row.signedAt)}" data-local-datetime>${escapeHtml(formatDate(row.signedAt))}</time></td>
            <td>${escapeHtml(row.status)}</td>
            <td>${escapeHtml(row.message)}</td>
          </tr>`).join('');

  const emptyLotteryState = lotteryRows.length === 0
    ? '<div class="empty panel"><strong>No engaged lotteries yet</strong><span>The crawler has not recorded any lottery engagement rows for the selected account.</span></div>'
    : '';
  const emptySignInState = signInRows.length === 0
    ? '<div class="empty panel"><strong>No daily sign-ins yet</strong><span>Daily sign-in attempts will appear here after the crawler records them.</span></div>'
    : '';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>zFrontier Activity Report</title>
    <style>
${APP_CSS}
    </style>
  </head>
  <body>
    ${renderAppBar('report')}
    <main>
      <header class="page-header">
        <div>
          <h1 class="page-title">Activity report</h1>
          <p class="page-copy">Review recorded lottery engagements, daily sign-ins, draw times, and account-specific activity from recent crawler runs.</p>
        </div>
        ${metrics}
      </header>
      <section class="toolbar" aria-label="Report filters">
        <label class="field" for="account-filter">
          <span>Account</span>
          <select id="account-filter" data-account-filter>
            <option value="">All accounts</option>
            ${accountFilterOptions}
          </select>
        </label>
      </section>
      <section>
        <div class="section-heading">
          <div>
            <h2>Engaged lotteries</h2>
            <p class="section-note">Posts the crawler has entered, including draw time and per-day engagement count.</p>
          </div>
        </div>
        ${emptyLotteryState}
        ${lotteryRows.length > 0 ? `<div class="panel table-container report-table" data-table-container>
        <table class="lottery-table" data-paginated-table data-page-size="20">
          <thead>
            <tr>
              <th>#</th>
              <th>Account</th>
              <th>Title</th>
              <th>Draw Time</th>
              <th>Daily Count</th>
              <th>Engaged Date</th>
              <th>Post ID</th>
            </tr>
          </thead>
          <tbody>${lotteryTableRows}
          </tbody>
        </table>
        </div>
        <div class="pagination" data-pagination hidden>
          <button type="button" data-page-prev>Prev</button>
          <span data-page-status></span>
          <button type="button" data-page-next>Next</button>
        </div>` : ''}
      </section>
      <section>
        <div class="section-heading">
          <div>
            <h2>Daily sign-ins</h2>
            <p class="section-note">One row per account and sign-in date, with status from the crawler run.</p>
          </div>
        </div>
        ${emptySignInState}
        ${signInRows.length > 0 ? `<div class="panel table-container report-table" data-table-container>
        <table data-paginated-table data-page-size="20">
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
        </div>
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
        const accountFilter = document.querySelector('[data-account-filter]');
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
          const container = table.closest('[data-table-container]');
          const controls = container?.nextElementSibling?.matches('[data-pagination]')
            ? container.nextElementSibling
            : table.nextElementSibling?.matches('[data-pagination]')
              ? table.nextElementSibling
              : null;
          const pageSize = Number(table.dataset.pageSize || 20);
          if (!controls || rows.length === 0 || pageSize <= 0) return;

          let page = 0;
          const previous = controls.querySelector('[data-page-prev]');
          const next = controls.querySelector('[data-page-next]');
          const status = controls.querySelector('[data-page-status]');

          const renderPage = () => {
            const selectedAccount = accountFilter?.value || '';
            const visibleRows = rows.filter((row) => !selectedAccount || row.dataset.accountId === selectedAccount);
            const pageCount = Math.max(1, Math.ceil(visibleRows.length / pageSize));
            if (page >= pageCount) page = pageCount - 1;
            const start = page * pageSize;
            const end = Math.min(start + pageSize, visibleRows.length);
            rows.forEach((row) => {
              row.hidden = true;
            });
            visibleRows.slice(start, end).forEach((row) => {
              row.hidden = false;
            });
            previous.disabled = page === 0 || visibleRows.length === 0;
            next.disabled = page >= pageCount - 1 || visibleRows.length === 0;
            status.textContent = visibleRows.length === 0
              ? '0 of 0'
              : (start + 1) + '-' + end + ' of ' + visibleRows.length;
          };

          previous.addEventListener('click', () => {
            if (page === 0) return;
            page -= 1;
            renderPage();
          });
          next.addEventListener('click', () => {
            page += 1;
            renderPage();
          });
          accountFilter?.addEventListener('change', () => {
            page = 0;
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

function renderDrawTime(value) {
  const drawAt = String(value || '').trim();
  if (!drawAt) return '-';
  return `<time datetime="${escapeAttr(drawAt)}">${escapeHtml(drawAt)}</time>`;
}

function renderDailyEngagementCount(row) {
  const count = Number(row.dailyEngagementCount) || 0;
  const date = String(row.lastEngagedDate || '').trim();
  if (!date || count <= 0) return '-';
  return `${escapeHtml(date)}: ${count}`;
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
    if (row.id) accounts.add(row.id);
  });
  return accounts.size;
}

function renderAccountFilterOptions(...groups) {
  const accountIds = new Set();
  groups.flat().forEach((row) => {
    if (row.accountId) accountIds.add(row.accountId);
    if (row.id) accountIds.add(row.id);
  });
  return Array.from(accountIds)
    .sort()
    .map((accountId) => `<option value="${escapeAttr(accountId)}">${escapeHtml(accountId)}</option>`)
    .join('\n            ');
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
  getEngagement,
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
