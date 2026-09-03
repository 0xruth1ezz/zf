const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_ACCOUNT_ID = 'default';
const APP_CSS = fs.readFileSync(path.join(__dirname, 'ui.generated.css'), 'utf8');

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
    <a class="skip-link" href="#main-content">Skip to content</a>
    <header class="app-bar">
      <div class="app-bar__inner">
        <a class="brand" href="/" aria-label="zFrontier Crawler report">
          <div class="brand__mark" aria-hidden="true">ZF</div>
          <div class="brand__text">
            <p class="brand__name">zFrontier Crawler</p>
            <p class="brand__sub">Lottery and sign-in operations</p>
          </div>
        </a>
        <nav class="app-nav" aria-label="Primary">${nav}</nav>
      </div>
    </header>`;
}

function renderMetricStrip(metrics) {
  return `
          <dl class="metric-strip">
            ${metrics.map((metric) => {
    const attributes = metric.key
      ? ` data-metric="${escapeAttr(metric.key)}" data-total="${escapeAttr(metric.value)}"`
      : '';
    return `
            <div class="metric"${attributes}>
              <dt class="metric__label" data-metric-label>${escapeHtml(metric.label)}</dt>
              <dd class="metric__value">${escapeHtml(metric.value)}</dd>
            </div>`;
  }).join('')}
          </dl>`;
}

function buildHtml(lotteryRows, signInRows, accountRows = []) {
  const generatedAt = new Date().toISOString();
  const accountCount = countUniqueAccounts(lotteryRows, signInRows, accountRows);
  const accountFilterOptions = renderAccountFilterOptions(accountRows, lotteryRows, signInRows);
  const metrics = renderMetricStrip([
    { key: 'accounts', label: 'Accounts', value: String(accountCount) },
    { key: 'lotteries', label: 'Active draws', value: String(lotteryRows.length) },
    { key: 'sign-ins', label: 'Sign-ins', value: String(signInRows.length) },
    { label: 'Updated', value: formatDateMinute(generatedAt) },
  ]);
  const lotteryTableRows = lotteryRows.map((row, index) => `
          <tr data-account-id="${escapeAttr(row.accountId)}" data-draw-at="${escapeAttr(row.drawAt)}">
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
            <td>${renderStatus(row.status)}</td>
            <td>${escapeHtml(row.message)}</td>
          </tr>`).join('');

  const emptyLotteryState = lotteryRows.length === 0
    ? '<div class="empty panel"><strong>No lottery threads found</strong><span>The crawler has not recorded any lottery threads yet.</span></div>'
    : '<div class="empty panel" data-lottery-filter-empty hidden><strong>No active lottery threads</strong><span>Turn on Include drawn to show threads whose draw time has passed.</span></div>';
  const emptySignInState = signInRows.length === 0
    ? '<div class="empty panel"><strong>No daily sign-ins yet</strong><span>Daily sign-in attempts will appear here after the crawler records them.</span></div>'
    : '<div class="empty panel" data-sign-in-filter-empty hidden><strong>No sign-ins for this account</strong><span>Choose another account to review its sign-in history.</span></div>';

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
    <main id="main-content">
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
        <label class="switch">
          <input type="checkbox" data-include-drawn>
          <span>Include drawn</span>
        </label>
      </section>
      <section>
        <div class="section-heading">
          <div>
            <h2>Lottery threads <span class="section-count" data-lottery-section-count>${lotteryRows.length}</span></h2>
            <p class="section-note">Active draws by default, with draw time and per-day engagement count.</p>
          </div>
        </div>
        ${emptyLotteryState}
        ${lotteryRows.length > 0 ? `<div class="panel table-container report-table" data-table-container tabindex="0" aria-label="Lottery threads table">
        <table class="lottery-table" data-paginated-table data-page-size="20">
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Account</th>
              <th scope="col">Title</th>
              <th scope="col">Draw time</th>
              <th scope="col">Daily count</th>
              <th scope="col">Last engaged</th>
              <th scope="col">Post ID</th>
            </tr>
          </thead>
          <tbody>${lotteryTableRows}
          </tbody>
        </table>
        </div>
        <div class="pagination" data-pagination hidden>
          <button type="button" data-page-prev>Previous</button>
          <span data-page-status></span>
          <button type="button" data-page-next>Next</button>
        </div>` : ''}
      </section>
      <section>
        <div class="section-heading">
          <div>
            <h2>Daily sign-ins <span class="section-count" data-sign-in-section-count>${signInRows.length}</span></h2>
            <p class="section-note">One row per account and sign-in date, with status from the crawler run.</p>
          </div>
        </div>
        ${emptySignInState}
        ${signInRows.length > 0 ? `<div class="panel table-container report-table" data-table-container tabindex="0" aria-label="Daily sign-ins table">
        <table data-paginated-table data-page-size="20">
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Account</th>
              <th scope="col">Date</th>
              <th scope="col">Signed at</th>
              <th scope="col">Status</th>
              <th scope="col">Message</th>
            </tr>
          </thead>
          <tbody>${signInTableRows}
          </tbody>
        </table>
        </div>
        <div class="pagination" data-pagination hidden>
          <button type="button" data-page-prev>Previous</button>
          <span data-page-status></span>
          <button type="button" data-page-next>Next</button>
        </div>` : ''}
      </section>
    </main>
    <script>
      (() => {
        const pad = (value) => String(value).padStart(2, '0');
        const accountFilter = document.querySelector('[data-account-filter]');
        const includeDrawn = document.querySelector('[data-include-drawn]');
        const lotteryFilterEmpty = document.querySelector('[data-lottery-filter-empty]');
        const signInFilterEmpty = document.querySelector('[data-sign-in-filter-empty]');
        const formatLocalDateTime = (date) => (
          date.getFullYear() + '-' +
          pad(date.getMonth() + 1) + '-' +
          pad(date.getDate()) + ' ' +
          pad(date.getHours()) + ':' +
          pad(date.getMinutes()) + ':' +
          pad(date.getSeconds())
        );
        const chinaMinuteKey = () => {
          const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: 'Asia/Shanghai',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
          }).formatToParts(new Date());
          const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
          return values.year + '-' + values.month + '-' + values.day + ' ' + values.hour + ':' + values.minute;
        };
        const drawMinuteKey = (value) => {
          const match = String(value || '')
            .trim()
            .replace(/[/.]/g, '-')
            .replace('T', ' ')
            .match(/^(20[0-9]{2})-([0-9]{1,2})-([0-9]{1,2}) +([0-9]{1,2}):([0-9]{2})/);
          if (!match) return '';
          return match[1] + '-' + pad(match[2]) + '-' + pad(match[3]) + ' ' + pad(match[4]) + ':' + match[5];
        };

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
          const isLotteryTable = table.classList.contains('lottery-table');
          const previous = controls.querySelector('[data-page-prev]');
          const next = controls.querySelector('[data-page-next]');
          const status = controls.querySelector('[data-page-status]');

          const renderPage = () => {
            const selectedAccount = accountFilter?.value || '';
            const includeCompleted = includeDrawn?.checked || false;
            const nowMinute = chinaMinuteKey();
            const visibleRows = rows.filter((row) => {
              if (selectedAccount && row.dataset.accountId !== selectedAccount) return false;
              if (!isLotteryTable || includeCompleted) return true;
              const drawMinute = drawMinuteKey(row.dataset.drawAt);
              return !drawMinute || drawMinute > nowMinute;
            });
            const pageCount = Math.max(1, Math.ceil(visibleRows.length / pageSize));
            if (page >= pageCount) page = pageCount - 1;
            const start = page * pageSize;
            const end = Math.min(start + pageSize, visibleRows.length);
            rows.forEach((row) => {
              row.hidden = true;
            });
            visibleRows.forEach((row, index) => {
              const numberCell = row.querySelector('td');
              if (numberCell) numberCell.textContent = String(index + 1);
            });
            visibleRows.slice(start, end).forEach((row) => {
              row.hidden = false;
            });
            previous.disabled = page === 0 || visibleRows.length === 0;
            next.disabled = page >= pageCount - 1 || visibleRows.length === 0;
            status.textContent = visibleRows.length === 0
              ? '0 of 0'
              : (start + 1) + '-' + end + ' of ' + visibleRows.length;
            if (isLotteryTable && lotteryFilterEmpty) {
              lotteryFilterEmpty.hidden = visibleRows.length !== 0;
              container.hidden = visibleRows.length === 0;
            }
            if (!isLotteryTable && signInFilterEmpty) {
              signInFilterEmpty.hidden = visibleRows.length !== 0;
              container.hidden = visibleRows.length === 0;
            }
            const metric = document.querySelector(isLotteryTable ? '[data-metric="lotteries"]' : '[data-metric="sign-ins"]');
            const metricValue = metric?.querySelector('.metric__value');
            if (metricValue) metricValue.textContent = String(visibleRows.length);
            if (isLotteryTable) {
              const metricLabel = metric?.querySelector('[data-metric-label]');
              if (metricLabel) metricLabel.textContent = includeCompleted ? 'Threads' : 'Active draws';
              const sectionCount = document.querySelector('[data-lottery-section-count]');
              if (sectionCount) sectionCount.textContent = String(visibleRows.length);
            } else {
              const sectionCount = document.querySelector('[data-sign-in-section-count]');
              if (sectionCount) sectionCount.textContent = String(visibleRows.length);
            }
            controls.hidden = visibleRows.length <= pageSize;
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
          if (isLotteryTable) {
            includeDrawn?.addEventListener('change', () => {
              page = 0;
              renderPage();
            });
          }

          renderPage();
        });

        accountFilter?.addEventListener('change', () => {
          const metric = document.querySelector('[data-metric="accounts"]');
          const metricValue = metric?.querySelector('.metric__value');
          if (!metricValue) return;
          metricValue.textContent = accountFilter.value ? '1' : (metric.dataset.total || '0');
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

function formatDateMinute(value) {
  return formatDate(value).slice(0, 16);
}

function renderDrawTime(value) {
  const drawAt = String(value || '').trim();
  if (!drawAt) return '<span class="status-badge">Unknown</span>';
  return `<time datetime="${escapeAttr(drawAt)}">${escapeHtml(drawAt)}</time>`;
}

function renderDailyEngagementCount(row) {
  const count = Number(row.dailyEngagementCount) || 0;
  const date = String(row.lastEngagedDate || '').trim();
  if (!date || count <= 0) return '<span class="empty-value">Not recorded</span>';
  return `<span class="count-stack"><strong>${count}</strong><small>${escapeHtml(date)}</small></span>`;
}

function renderStatus(value) {
  const normalized = String(value || '').trim().toLowerCase();
  const tones = {
    signed: ' status-badge--success',
    already_signed: ' status-badge--success',
    success: ' status-badge--success',
    clicked: ' status-badge--info',
    failed: ' status-badge--danger',
    error: ' status-badge--danger',
  };
  const label = normalized
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || 'Unknown';
  return `<span class="status-badge${tones[normalized] || ''}">${escapeHtml(label)}</span>`;
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
