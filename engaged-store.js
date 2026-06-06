const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function openEngagedStore(dbPath, htmlPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS engaged_lotteries (
      post_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      url TEXT NOT NULL UNIQUE,
      engaged_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_engaged_lotteries_engaged_at
      ON engaged_lotteries (engaged_at DESC);
  `);

  return { db, dbPath, htmlPath };
}

function hasEngagement(store, postId) {
  return Boolean(store.db.prepare('SELECT 1 FROM engaged_lotteries WHERE post_id = ?').get(postId));
}

function saveEngagement(store, record) {
  store.db.prepare(`
    INSERT INTO engaged_lotteries (post_id, title, url, engaged_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(post_id) DO UPDATE SET
      title = excluded.title,
      url = excluded.url,
      engaged_at = excluded.engaged_at
  `).run(record.postId, record.title || record.url, record.url, record.engagedAt);
}

function countEngagements(store) {
  return store.db.prepare('SELECT COUNT(*) AS count FROM engaged_lotteries').get().count;
}

function listEngagements(store) {
  return store.db.prepare(`
    SELECT post_id AS postId, title, url, engaged_at AS engagedAt
    FROM engaged_lotteries
    ORDER BY engaged_at DESC
  `).all();
}

function renderEngagementHtml(store) {
  const rows = listEngagements(store);
  fs.writeFileSync(store.htmlPath, buildHtml(rows), 'utf8');
}

function buildHtml(rows) {
  const generatedAt = new Date().toISOString();
  const tableRows = rows.map((row, index) => `
          <tr>
            <td>${index + 1}</td>
            <td><a href="${escapeAttr(row.url)}" target="_blank" rel="noreferrer">${escapeHtml(row.title)}</a></td>
            <td><time datetime="${escapeAttr(row.engagedAt)}" data-local-datetime>${escapeHtml(formatDate(row.engagedAt))}</time></td>
            <td><code>${escapeHtml(row.postId)}</code></td>
          </tr>`).join('');

  const emptyState = rows.length === 0
    ? '<p class="empty">No engaged lotteries have been recorded yet.</p>'
    : '';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>zFrontier Engaged Lotteries</title>
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
      @media (max-width: 720px) {
        header {
          display: block;
        }
        .meta {
          margin-top: 8px;
          text-align: left;
        }
        th:nth-child(4), td:nth-child(4) {
          display: none;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <div>
          <h1>zFrontier Engaged Lotteries</h1>
        </div>
        <div class="meta">
          <div>${rows.length} records</div>
          <div>Generated <time datetime="${escapeAttr(generatedAt)}" data-local-datetime>${escapeHtml(formatDate(generatedAt))}</time></div>
        </div>
      </header>
      ${emptyState}
      ${rows.length > 0 ? `<table>
        <thead>
          <tr>
            <th>#</th>
            <th>Title</th>
            <th>Engaged Date</th>
            <th>Post ID</th>
          </tr>
        </thead>
        <tbody>${tableRows}
        </tbody>
      </table>` : ''}
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
  hasEngagement,
  listEngagements,
  openEngagedStore,
  renderEngagementHtml,
  saveEngagement,
};
