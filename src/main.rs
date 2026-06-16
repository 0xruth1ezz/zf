use rusqlite::{params, Connection};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::env;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

const APP_CSS: &str = r#"
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
      button:disabled {
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
      }
"#;

#[derive(Debug)]
struct Record {
    account_id: String,
    post_id: String,
    title: String,
    url: String,
    draw_at: String,
    last_engaged_date: String,
    daily_engagement_count: i64,
    engaged_at: String,
}

#[derive(Debug)]
struct SignInRecord {
    account_id: String,
    sign_in_date: String,
    signed_at: String,
    status: String,
    message: String,
}

#[derive(Debug)]
struct AccountConfig {
    id: String,
    phone: String,
    enabled: bool,
    created_at: String,
    updated_at: String,
}

#[derive(Debug)]
struct Config {
    bind_addr: String,
    db_path: PathBuf,
    report_auth: Option<ReportAuth>,
}

#[derive(Debug)]
struct ReportAuth {
    expected_header: String,
}

#[derive(Debug)]
struct TableColumn {
    name: String,
    primary_key_position: i64,
}

#[derive(Debug)]
struct Request {
    method: String,
    path: String,
    query: String,
    headers: String,
    body: String,
}

fn main() -> std::io::Result<()> {
    let config = Config::load();
    ensure_schema(&config.db_path).expect("failed to initialize SQLite schema");

    let listener = TcpListener::bind(&config.bind_addr)?;
    println!(
        "Serving engaged lottery report at http://{}",
        config.bind_addr
    );
    println!("Reading SQLite records from {}", config.db_path.display());

    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                if let Err(error) = handle_client(stream, &config) {
                    eprintln!("request failed: {error}");
                }
            }
            Err(error) => eprintln!("connection failed: {error}"),
        }
    }

    Ok(())
}

impl Config {
    fn load() -> Self {
        let cwd = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let dotenv = read_dotenv(&cwd.join(".env"));
        let host = env_or_dotenv(&dotenv, "REPORT_HOST").unwrap_or_else(|| "127.0.0.1".to_string());
        let port = env_or_dotenv(&dotenv, "REPORT_PORT").unwrap_or_else(|| "8787".to_string());
        let db_path = env_or_dotenv(&dotenv, "ZF_ENGAGED_DB")
            .map(PathBuf::from)
            .unwrap_or_else(|| cwd.join("engaged-lotteries.sqlite"));
        let report_auth = report_auth_from_env(&dotenv);

        Self {
            bind_addr: format!("{host}:{port}"),
            db_path,
            report_auth,
        }
    }
}

fn handle_client(mut stream: TcpStream, config: &Config) -> std::io::Result<()> {
    let request = read_request(&mut stream)?;

    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/") | ("GET", "/index.html") | ("GET", "/report") => {
            if !is_authorized(&request, config.report_auth.as_ref()) {
                return write_unauthorized(&mut stream);
            }

            let body = match render_report(&config.db_path, &request.query) {
                Ok(html) => html,
                Err(error) => {
                    let error_html = format!(
                        "<!doctype html><meta charset=\"utf-8\"><title>Error</title><h1>Report Error</h1><pre>{}</pre>",
                        escape_html(&error.to_string())
                    );
                    return write_response(
                        &mut stream,
                        "500 Internal Server Error",
                        "text/html; charset=utf-8",
                        &error_html,
                    );
                }
            };
            write_response(&mut stream, "200 OK", "text/html; charset=utf-8", &body)
        }
        ("GET", "/config") | ("GET", "/config.html") => {
            if !is_authorized(&request, config.report_auth.as_ref()) {
                return write_unauthorized(&mut stream);
            }

            let body = match render_config(&config.db_path, &request.query) {
                Ok(html) => html,
                Err(error) => {
                    let error_html = format!(
                        "<!doctype html><meta charset=\"utf-8\"><title>Error</title><h1>Config Error</h1><pre>{}</pre>",
                        escape_html(&error.to_string())
                    );
                    return write_response(
                        &mut stream,
                        "500 Internal Server Error",
                        "text/html; charset=utf-8",
                        &error_html,
                    );
                }
            };
            write_response(&mut stream, "200 OK", "text/html; charset=utf-8", &body)
        }
        ("POST", "/config/accounts") => {
            if !is_authorized(&request, config.report_auth.as_ref()) {
                return write_unauthorized(&mut stream);
            }

            match save_account_from_form(&config.db_path, &request.body) {
                Ok(()) => write_redirect(&mut stream, "/config?saved=1"),
                Err(error) => write_response(
                    &mut stream,
                    "400 Bad Request",
                    "text/plain; charset=utf-8",
                    &format!("{}\n", error),
                ),
            }
        }
        ("POST", "/config/accounts/delete") => {
            if !is_authorized(&request, config.report_auth.as_ref()) {
                return write_unauthorized(&mut stream);
            }

            match delete_account_from_form(&config.db_path, &request.body) {
                Ok(()) => write_redirect(&mut stream, "/config?deleted=1"),
                Err(error) => write_response(
                    &mut stream,
                    "400 Bad Request",
                    "text/plain; charset=utf-8",
                    &format!("{}\n", error),
                ),
            }
        }
        ("GET", "/health") => {
            write_response(&mut stream, "200 OK", "text/plain; charset=utf-8", "ok\n")
        }
        _ => write_response(
            &mut stream,
            "404 Not Found",
            "text/plain; charset=utf-8",
            "not found\n",
        ),
    }
}

fn read_request(stream: &mut TcpStream) -> std::io::Result<Request> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut bytes = Vec::new();
    let mut chunk = [0_u8; 4096];
    let mut expected_len = None;

    loop {
        let read = stream.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..read]);

        if expected_len.is_none() {
            if let Some(header_end) = header_end_index(&bytes) {
                let headers = String::from_utf8_lossy(&bytes[..header_end]).to_string();
                let content_length = header_value(&headers, "Content-Length")
                    .and_then(|value| value.parse::<usize>().ok())
                    .unwrap_or(0);
                expected_len = Some(header_end + 4 + content_length);
            }
        }

        if expected_len.map(|len| bytes.len() >= len).unwrap_or(false) {
            break;
        }

        if bytes.len() > 64 * 1024 {
            break;
        }
    }

    let raw = String::from_utf8_lossy(&bytes).to_string();
    let header_end = raw.find("\r\n\r\n").unwrap_or(raw.len());
    let headers = raw[..header_end].to_string();
    let body = raw.get(header_end + 4..).unwrap_or("").to_string();
    let request_line = headers.lines().next().unwrap_or("");
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let target = parts.next().unwrap_or("/");
    let (path, query) = target
        .split_once('?')
        .map(|(path, query)| (path.to_string(), query.to_string()))
        .unwrap_or_else(|| (target.to_string(), String::new()));

    Ok(Request {
        method,
        path,
        query,
        headers,
        body,
    })
}

fn header_end_index(bytes: &[u8]) -> Option<usize> {
    bytes.windows(4).position(|window| window == b"\r\n\r\n")
}

fn header_value<'a>(headers: &'a str, header_name: &str) -> Option<&'a str> {
    for line in headers.lines().skip(1) {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if name.trim().eq_ignore_ascii_case(header_name) {
            return Some(value.trim());
        }
    }
    None
}

fn ensure_schema(db_path: &Path) -> rusqlite::Result<()> {
    if let Some(parent) = db_path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    let conn = Connection::open(db_path)?;
    migrate_legacy_engagements(&conn)?;
    migrate_legacy_sign_ins(&conn)?;
    conn.execute_batch(
        r#"
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
        "#,
    )?;
    add_column_if_missing(
        &conn,
        "engaged_lotteries",
        "draw_at",
        "TEXT NOT NULL DEFAULT ''",
    )?;
    add_column_if_missing(
        &conn,
        "engaged_lotteries",
        "last_engaged_date",
        "TEXT NOT NULL DEFAULT ''",
    )?;
    add_column_if_missing(
        &conn,
        "engaged_lotteries",
        "daily_engagement_count",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    backfill_engagement_daily_state(&conn)?;
    Ok(())
}

fn migrate_legacy_engagements(conn: &Connection) -> rusqlite::Result<()> {
    let columns = table_columns(conn, "engaged_lotteries")?;
    if columns.is_empty() || is_composite_primary_key(&columns, &["account_id", "post_id"]) {
        return Ok(());
    }

    let account_expr = if columns.iter().any(|column| column.name == "account_id") {
        "COALESCE(NULLIF(account_id, ''), 'default')"
    } else {
        "'default'"
    };
    let draw_at_expr = legacy_column_expr(&columns, "draw_at", "''");
    let last_engaged_date_expr =
        legacy_column_expr(&columns, "last_engaged_date", "substr(engaged_at, 1, 10)");
    let daily_engagement_count_expr = legacy_column_expr(&columns, "daily_engagement_count", "1");
    conn.execute_batch(&format!(
        r#"
        DROP TABLE IF EXISTS engaged_lotteries_legacy_migration;
        ALTER TABLE engaged_lotteries RENAME TO engaged_lotteries_legacy_migration;
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
        INSERT OR IGNORE INTO engaged_lotteries (
          account_id,
          post_id,
          title,
          url,
          draw_at,
          last_engaged_date,
          daily_engagement_count,
          engaged_at
        )
          SELECT {account_expr}, post_id, title, url, {draw_at_expr}, {last_engaged_date_expr}, {daily_engagement_count_expr}, engaged_at
          FROM engaged_lotteries_legacy_migration;
        DROP TABLE engaged_lotteries_legacy_migration;
        "#
    ))?;
    Ok(())
}

fn migrate_legacy_sign_ins(conn: &Connection) -> rusqlite::Result<()> {
    let columns = table_columns(conn, "daily_sign_ins")?;
    if columns.is_empty() || is_composite_primary_key(&columns, &["account_id", "sign_in_date"]) {
        return Ok(());
    }

    let account_expr = if columns.iter().any(|column| column.name == "account_id") {
        "COALESCE(NULLIF(account_id, ''), 'default')"
    } else {
        "'default'"
    };
    conn.execute_batch(&format!(
        r#"
        DROP TABLE IF EXISTS daily_sign_ins_legacy_migration;
        ALTER TABLE daily_sign_ins RENAME TO daily_sign_ins_legacy_migration;
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
          SELECT {account_expr}, sign_in_date, signed_at, url, status, message
          FROM daily_sign_ins_legacy_migration;
        DROP TABLE daily_sign_ins_legacy_migration;
        "#
    ))?;
    Ok(())
}

fn table_columns(conn: &Connection, table_name: &str) -> rusqlite::Result<Vec<TableColumn>> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table_name})"))?;
    let columns = stmt
        .query_map(params![], |row| {
            Ok(TableColumn {
                name: row.get(1)?,
                primary_key_position: row.get(5)?,
            })
        })?
        .collect();

    columns
}

fn is_composite_primary_key(columns: &[TableColumn], names: &[&str]) -> bool {
    names.iter().enumerate().all(|(index, name)| {
        columns
            .iter()
            .any(|column| column.name == *name && column.primary_key_position == (index + 1) as i64)
    })
}

fn add_column_if_missing(
    conn: &Connection,
    table_name: &str,
    column_name: &str,
    definition: &str,
) -> rusqlite::Result<()> {
    let columns = table_columns(conn, table_name)?;
    if columns.iter().any(|column| column.name == column_name) {
        return Ok(());
    }

    conn.execute_batch(&format!(
        "ALTER TABLE {table_name} ADD COLUMN {column_name} {definition}"
    ))
}

fn legacy_column_expr(columns: &[TableColumn], column_name: &str, fallback: &str) -> String {
    if columns.iter().any(|column| column.name == column_name) {
        format!("COALESCE({column_name}, {fallback})")
    } else {
        fallback.to_string()
    }
}

fn backfill_engagement_daily_state(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        r#"
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
        "#,
    )
}

fn load_records(db_path: &Path) -> rusqlite::Result<Vec<Record>> {
    let conn = Connection::open(db_path)?;
    let mut stmt = conn.prepare(
        r#"
        SELECT
          account_id,
          post_id,
          title,
          url,
          draw_at,
          last_engaged_date,
          daily_engagement_count,
          engaged_at
        FROM engaged_lotteries
        ORDER BY engaged_at DESC
        "#,
    )?;

    let records = stmt
        .query_map(params![], |row| {
            Ok(Record {
                account_id: row.get(0)?,
                post_id: row.get(1)?,
                title: row.get(2)?,
                url: row.get(3)?,
                draw_at: row.get(4)?,
                last_engaged_date: row.get(5)?,
                daily_engagement_count: row.get(6)?,
                engaged_at: row.get(7)?,
            })
        })?
        .collect();

    records
}

fn load_sign_ins(db_path: &Path) -> rusqlite::Result<Vec<SignInRecord>> {
    let conn = Connection::open(db_path)?;
    let mut stmt = conn.prepare(
        r#"
        SELECT account_id, sign_in_date, signed_at, status, message
        FROM daily_sign_ins
        ORDER BY signed_at DESC
        "#,
    )?;

    let records = stmt
        .query_map(params![], |row| {
            Ok(SignInRecord {
                account_id: row.get(0)?,
                sign_in_date: row.get(1)?,
                signed_at: row.get(2)?,
                status: row.get(3)?,
                message: row.get(4)?,
            })
        })?
        .collect();

    records
}

fn load_accounts(db_path: &Path) -> rusqlite::Result<Vec<AccountConfig>> {
    let conn = Connection::open(db_path)?;
    let mut stmt = conn.prepare(
        r#"
        SELECT id, phone, enabled, created_at, updated_at
        FROM zfrontier_accounts
        ORDER BY id
        "#,
    )?;

    let records = stmt
        .query_map(params![], |row| {
            Ok(AccountConfig {
                id: row.get(0)?,
                phone: row.get(1)?,
                enabled: row.get::<_, i64>(2)? == 1,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
            })
        })?
        .collect();

    records
}

fn save_account_from_form(db_path: &Path, body: &str) -> Result<(), String> {
    let form = parse_form_urlencoded(body);
    let id = normalize_account_id(form.get("id").map(String::as_str).unwrap_or(""));
    let phone = form.get("phone").map(|value| value.trim()).unwrap_or("");
    let password = form.get("password").map(|value| value.trim()).unwrap_or("");
    let enabled = if form.contains_key("enabled") {
        1_i64
    } else {
        0_i64
    };

    if id.is_empty() {
        return Err("account id is required".to_string());
    }
    if phone.is_empty() {
        return Err("phone is required".to_string());
    }

    let conn = Connection::open(db_path).map_err(|error| error.to_string())?;
    let existing_password = conn
        .query_row(
            "SELECT password FROM zfrontier_accounts WHERE id = ?1",
            params![id],
            |row| row.get::<_, String>(0),
        )
        .ok();
    let password_to_save = if password.is_empty() {
        existing_password.ok_or_else(|| "password is required for new accounts".to_string())?
    } else {
        password.to_string()
    };

    conn.execute(
        r#"
        INSERT INTO zfrontier_accounts (id, phone, password, enabled, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        ON CONFLICT(id) DO UPDATE SET
          phone = excluded.phone,
          password = excluded.password,
          enabled = excluded.enabled,
          updated_at = excluded.updated_at
        "#,
        params![id, phone, password_to_save, enabled],
    )
    .map_err(|error| error.to_string())?;

    Ok(())
}

fn delete_account_from_form(db_path: &Path, body: &str) -> Result<(), String> {
    let form = parse_form_urlencoded(body);
    let id = form
        .get("id")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "account id is required".to_string())?;

    let conn = Connection::open(db_path).map_err(|error| error.to_string())?;
    conn.execute("DELETE FROM zfrontier_accounts WHERE id = ?1", params![id])
        .map_err(|error| error.to_string())?;

    Ok(())
}

fn render_app_bar(active_page: &str) -> String {
    let nav_items = [
        ("report", "Report", "/"),
        ("config", "Configuration", "/config"),
    ];
    let nav = nav_items
        .iter()
        .map(|(id, label, href)| {
            let current = if *id == active_page {
                r#" aria-current="page""#
            } else {
                ""
            };
            format!(r#"<a href="{href}"{current}>{label}</a>"#)
        })
        .collect::<String>();

    format!(
        r#"
    <div class="app-bar">
      <div class="app-bar__inner">
        <div class="brand">
          <div class="brand__mark" aria-hidden="true">ZF</div>
          <div class="brand__text">
            <p class="brand__name">zFrontier Crawler</p>
            <p class="brand__sub">Lottery and sign-in operations</p>
          </div>
        </div>
        <nav class="app-nav" aria-label="Primary">{nav}</nav>
      </div>
    </div>"#
    )
}

fn render_metric_strip(metrics: &[(&str, String)]) -> String {
    let metric_items = metrics
        .iter()
        .map(|(label, value)| {
            format!(
                r#"
            <div class="metric">
              <span class="metric__label">{}</span>
              <span class="metric__value">{}</span>
            </div>"#,
                escape_html(label),
                escape_html(value)
            )
        })
        .collect::<String>();

    format!(
        r#"
          <div class="metric-strip">{metric_items}
          </div>"#
    )
}

fn render_config(db_path: &Path, query: &str) -> rusqlite::Result<String> {
    let accounts = load_accounts(db_path)?;
    let query_values = parse_form_urlencoded(query);
    let notice = if query_values.contains_key("saved") {
        r#"<div class="notice">Account saved.</div>"#
    } else if query_values.contains_key("deleted") {
        r#"<div class="notice">Account deleted.</div>"#
    } else {
        ""
    };

    let account_rows = accounts
        .iter()
        .map(|account| {
            let checked = if account.enabled { " checked" } else { "" };
            let form_id = format!("account-save-{}", account.id);
            format!(
                r#"
          <div class="account-row">
            <form id="{}" class="account-form" method="post" action="/config/accounts" autocomplete="off">
              <label>
                <span>Account ID</span>
                <input name="id" value="{}" readonly>
              </label>
              <label>
                <span>Phone</span>
                <input name="phone" value="{}" inputmode="numeric" autocomplete="off" required>
              </label>
              <label>
                <span>Password</span>
                <input name="password" type="password" value="" placeholder="Leave blank to keep" autocomplete="new-password">
              </label>
              <label class="check">
                <input name="enabled" type="checkbox" value="1"{}>
                <span>Enabled</span>
              </label>
            </form>
            <div class="account-actions">
              <button class="action-primary" type="submit" form="{}">Save</button>
              <form class="delete-form" method="post" action="/config/accounts/delete">
                <input type="hidden" name="id" value="{}">
                <button class="action-danger" type="submit">Delete</button>
              </form>
            </div>
            <div class="row-meta">
              <span>Created <time datetime="{}" data-local-datetime>{}</time></span>
              <span>Updated <time datetime="{}" data-local-datetime>{}</time></span>
            </div>
          </div>"#,
                escape_attr(&form_id),
                escape_attr(&account.id),
                escape_attr(&account.phone),
                checked,
                escape_attr(&form_id),
                escape_attr(&account.id),
                escape_attr(&account.created_at),
                escape_html(&account.created_at),
                escape_attr(&account.updated_at),
                escape_html(&account.updated_at),
            )
        })
        .collect::<String>();

    let empty_accounts = if accounts.is_empty() {
        r#"<div class="empty panel"><strong>No database accounts yet</strong><span>The crawler will keep using env fallback credentials until an enabled account is saved here.</span></div>"#
    } else {
        ""
    };
    let metrics = render_metric_strip(&[("Accounts", accounts.len().to_string())]);

    Ok(format!(
        r#"<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>zFrontier Configuration</title>
    <style>
{}
    </style>
  </head>
  <body>
    {}
    <main>
      <header class="page-header">
        <div>
          <h1 class="page-title">Configuration</h1>
          <p class="page-copy">Manage the crawler accounts used for zFrontier sign-ins and lottery participation.</p>
        </div>
        {}
      </header>
      {}
      <section>
        <div class="section-heading">
          <div>
            <h2>Accounts</h2>
            <p class="section-note">Enabled accounts are loaded before environment fallback credentials.</p>
          </div>
        </div>
        {}
        {}
      </section>
      <section>
        <div class="section-heading">
          <div>
            <h2>Add account</h2>
            <p class="section-note">Store credentials in the local SQLite database for crawler runs.</p>
          </div>
        </div>
        <form class="new-account" method="post" action="/config/accounts" autocomplete="off">
          <label>
            <span>Account ID</span>
            <input name="id" placeholder="default" autocomplete="off" required>
          </label>
          <label>
            <span>Phone</span>
            <input name="phone" inputmode="numeric" autocomplete="off" required>
          </label>
          <label>
            <span>Password</span>
            <input name="password" type="password" autocomplete="new-password" required>
          </label>
          <label class="check">
            <input name="enabled" type="checkbox" value="1" checked>
            <span>Enabled</span>
          </label>
          <button class="action-primary" type="submit">Add</button>
        </form>
      </section>
    </main>
    <script>
      (() => {{
        const pad = (value) => String(value).padStart(2, '0');
        const formatLocalDateTime = (date) => `${{date.getFullYear()}}-${{pad(date.getMonth() + 1)}}-${{pad(date.getDate())}} ${{pad(date.getHours())}}:${{pad(date.getMinutes())}}:${{pad(date.getSeconds())}}`;

        document.querySelectorAll('time[data-local-datetime]').forEach((node) => {{
          const value = node.getAttribute('datetime');
          const date = new Date(value);
          if (Number.isNaN(date.getTime())) return;
          node.textContent = formatLocalDateTime(date);
          node.title = value;
        }});
      }})();
    </script>
  </body>
</html>
"#,
        APP_CSS,
        render_app_bar("config"),
        metrics,
        notice,
        empty_accounts,
        account_rows,
    ))
}

fn render_report(db_path: &Path, query: &str) -> rusqlite::Result<String> {
    let query_values = parse_form_urlencoded(query);
    let selected_account = query_values
        .get("account")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty());
    let all_records = load_records(db_path)?;
    let all_sign_ins = load_sign_ins(db_path)?;
    let accounts = load_accounts(db_path)?;
    let account_ids = report_account_ids(&all_records, &all_sign_ins, &accounts);
    let records = filter_records_by_account(&all_records, selected_account);
    let sign_ins = filter_sign_ins_by_account(&all_sign_ins, selected_account);
    let account_count = selected_account
        .map(|account| usize::from(account_ids.iter().any(|id| id == account)))
        .unwrap_or_else(|| unique_account_count(&all_records, &all_sign_ins, &accounts));
    let account_filter_options = render_account_filter_options(&account_ids, selected_account);
    let generated_at = sqlite_now(db_path).unwrap_or_else(|_| "now".to_string());
    let metrics = render_metric_strip(&[
        ("Accounts", account_count.to_string()),
        ("Lotteries", records.len().to_string()),
        ("Sign-ins", sign_ins.len().to_string()),
        ("Generated", generated_at.clone()),
    ]);
    let rows = records
        .iter()
        .enumerate()
        .map(|(index, record)| {
            format!(
                r#"
          <tr data-account-id="{}">
            <td>{}</td>
            <td><code>{}</code></td>
            <td><a href="{}" target="_blank" rel="noreferrer">{}</a></td>
            <td>{}</td>
            <td>{}</td>
            <td><time datetime="{}" data-local-datetime>{}</time></td>
            <td><code>{}</code></td>
          </tr>"#,
                escape_attr(&record.account_id),
                index + 1,
                escape_html(&record.account_id),
                escape_attr(&record.url),
                escape_html(&record.title),
                render_draw_time(&record.draw_at),
                render_daily_engagement_count(record),
                escape_attr(&record.engaged_at),
                escape_html(&record.engaged_at),
                escape_html(&record.post_id),
            )
        })
        .collect::<String>();

    let sign_in_rows = sign_ins
        .iter()
        .enumerate()
        .map(|(index, record)| {
            format!(
                r#"
          <tr data-account-id="{}">
            <td>{}</td>
            <td><code>{}</code></td>
            <td><code>{}</code></td>
            <td><time datetime="{}" data-local-datetime>{}</time></td>
            <td>{}</td>
            <td>{}</td>
          </tr>"#,
                escape_attr(&record.account_id),
                index + 1,
                escape_html(&record.account_id),
                escape_html(&record.sign_in_date),
                escape_attr(&record.signed_at),
                escape_html(&record.signed_at),
                escape_html(&record.status),
                escape_html(&record.message),
            )
        })
        .collect::<String>();

    let empty = if records.is_empty() {
        r#"<div class="empty panel"><strong>No engaged lotteries yet</strong><span>The crawler has not recorded any lottery engagement rows for the selected account.</span></div>"#
    } else {
        ""
    };

    let sign_in_empty = if sign_ins.is_empty() {
        r#"<div class="empty panel"><strong>No daily sign-ins yet</strong><span>Daily sign-in attempts will appear here after the crawler records them.</span></div>"#
    } else {
        ""
    };

    let table = if records.is_empty() {
        String::new()
    } else {
        format!(
            r#"<div class="panel table-container report-table" data-table-container>
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
        <tbody>{rows}
        </tbody>
      </table>
      </div>
      <div class="pagination" data-pagination hidden>
        <button type="button" data-page-prev>Prev</button>
        <span data-page-status></span>
        <button type="button" data-page-next>Next</button>
      </div>"#
        )
    };

    let sign_in_table = if sign_ins.is_empty() {
        String::new()
    } else {
        format!(
            r#"<div class="panel table-container report-table" data-table-container>
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
        <tbody>{sign_in_rows}
        </tbody>
      </table>
      </div>
      <div class="pagination" data-pagination hidden>
        <button type="button" data-page-prev>Prev</button>
        <span data-page-status></span>
        <button type="button" data-page-next>Next</button>
      </div>"#
        )
    };

    Ok(format!(
        r#"<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>zFrontier Activity Report</title>
    <style>
{}
    </style>
  </head>
  <body>
    {}
    <main>
      <header class="page-header">
        <div>
          <h1 class="page-title">Activity report</h1>
          <p class="page-copy">Review recorded lottery engagements, daily sign-ins, draw times, and account-specific activity from recent crawler runs.</p>
        </div>
        {}
      </header>
      <form class="toolbar" method="get" action="/report" aria-label="Report filters" data-report-filter>
        <label class="field" for="account-filter">
          <span>Account</span>
          <select id="account-filter" name="account" data-account-filter>
            <option value=""{}>All accounts</option>
            {}
          </select>
        </label>
      </form>
      <section>
        <div class="section-heading">
          <div>
            <h2>Engaged lotteries</h2>
            <p class="section-note">Posts the crawler has entered, including draw time and per-day engagement count.</p>
          </div>
        </div>
        {}
        {}
      </section>
      <section>
        <div class="section-heading">
          <div>
            <h2>Daily sign-ins</h2>
            <p class="section-note">One row per account and sign-in date, with status from the crawler run.</p>
          </div>
        </div>
        {}
        {}
      </section>
    </main>
    <script>
      (() => {{
        const pad = (value) => String(value).padStart(2, '0');
        const formatLocalDateTime = (date) => `${{date.getFullYear()}}-${{pad(date.getMonth() + 1)}}-${{pad(date.getDate())}} ${{pad(date.getHours())}}:${{pad(date.getMinutes())}}:${{pad(date.getSeconds())}}`;
        const accountFilter = document.querySelector('[data-account-filter]');
        const reportFilter = document.querySelector('[data-report-filter]');

        document.querySelectorAll('time[data-local-datetime]').forEach((node) => {{
          const value = node.getAttribute('datetime');
          const date = new Date(value);
          if (Number.isNaN(date.getTime())) return;
          node.textContent = formatLocalDateTime(date);
          node.title = value;
        }});

        document.querySelectorAll('table[data-paginated-table]').forEach((table) => {{
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

          const renderPage = () => {{
            const selectedAccount = accountFilter?.value || '';
            const visibleRows = rows.filter((row) => !selectedAccount || row.dataset.accountId === selectedAccount);
            const pageCount = Math.max(1, Math.ceil(visibleRows.length / pageSize));
            if (page >= pageCount) page = pageCount - 1;
            const start = page * pageSize;
            const end = Math.min(start + pageSize, visibleRows.length);
            rows.forEach((row) => {{
              row.hidden = true;
            }});
            visibleRows.slice(start, end).forEach((row) => {{
              row.hidden = false;
            }});
            previous.disabled = page === 0 || visibleRows.length === 0;
            next.disabled = page >= pageCount - 1 || visibleRows.length === 0;
            status.textContent = visibleRows.length === 0
              ? '0 of 0'
              : `${{start + 1}}-${{end}} of ${{visibleRows.length}}`;
          }};

          previous.addEventListener('click', () => {{
            if (page === 0) return;
            page -= 1;
            renderPage();
          }});
          next.addEventListener('click', () => {{
            page += 1;
            renderPage();
          }});
          controls.hidden = false;
          renderPage();
        }});

        accountFilter?.addEventListener('change', () => {{
          if (reportFilter?.requestSubmit) {{
            reportFilter.requestSubmit();
          }} else {{
            reportFilter?.submit();
          }}
        }});
      }})();
    </script>
  </body>
</html>
"#,
        APP_CSS,
        render_app_bar("report"),
        metrics,
        if selected_account.is_none() {
            " selected"
        } else {
            ""
        },
        account_filter_options,
        empty,
        table,
        sign_in_empty,
        sign_in_table
    ))
}

fn report_account_ids(
    records: &[Record],
    sign_ins: &[SignInRecord],
    accounts: &[AccountConfig],
) -> Vec<String> {
    let mut account_ids = BTreeSet::new();
    for account in accounts {
        account_ids.insert(account.id.clone());
    }
    for record in records {
        account_ids.insert(record.account_id.clone());
    }
    for record in sign_ins {
        account_ids.insert(record.account_id.clone());
    }
    account_ids.into_iter().collect()
}

fn filter_records_by_account<'a>(
    records: &'a [Record],
    selected_account: Option<&str>,
) -> Vec<&'a Record> {
    records
        .iter()
        .filter(|record| {
            selected_account
                .map(|account| record.account_id == account)
                .unwrap_or(true)
        })
        .collect()
}

fn filter_sign_ins_by_account<'a>(
    sign_ins: &'a [SignInRecord],
    selected_account: Option<&str>,
) -> Vec<&'a SignInRecord> {
    sign_ins
        .iter()
        .filter(|record| {
            selected_account
                .map(|account| record.account_id == account)
                .unwrap_or(true)
        })
        .collect()
}

fn render_account_filter_options(account_ids: &[String], selected_account: Option<&str>) -> String {
    account_ids
        .iter()
        .map(|account_id| {
            let selected = if selected_account == Some(account_id.as_str()) {
                " selected"
            } else {
                ""
            };
            format!(
                r#"<option value="{}"{}>{}</option>"#,
                escape_attr(account_id),
                selected,
                escape_html(account_id)
            )
        })
        .collect::<Vec<_>>()
        .join("\n            ")
}

fn sqlite_now(db_path: &Path) -> rusqlite::Result<String> {
    let conn = Connection::open(db_path)?;
    conn.query_row(
        "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
        params![],
        |row| row.get(0),
    )
}

fn unique_account_count(
    records: &[Record],
    sign_ins: &[SignInRecord],
    accounts: &[AccountConfig],
) -> usize {
    let mut account_ids = HashSet::new();
    for account in accounts {
        account_ids.insert(account.id.as_str());
    }
    for record in records {
        account_ids.insert(record.account_id.as_str());
    }
    for record in sign_ins {
        account_ids.insert(record.account_id.as_str());
    }
    account_ids.len()
}

fn report_auth_from_env(dotenv: &HashMap<String, String>) -> Option<ReportAuth> {
    let user = env_or_dotenv(dotenv, "REPORT_BASIC_AUTH_USER")
        .or_else(|| env_or_dotenv(dotenv, "REPORT_AUTH_USER"))?;
    let password = env_or_dotenv(dotenv, "REPORT_BASIC_AUTH_PASSWORD")
        .or_else(|| env_or_dotenv(dotenv, "REPORT_AUTH_PASSWORD"))?;

    if user.is_empty() || password.is_empty() {
        return None;
    }

    let credential = format!("{user}:{password}");
    Some(ReportAuth {
        expected_header: format!("Basic {}", base64_encode(credential.as_bytes())),
    })
}

fn is_authorized(request: &Request, auth: Option<&ReportAuth>) -> bool {
    let Some(auth) = auth else {
        return true;
    };

    request_header(request, "Authorization")
        .map(|value| value.trim() == auth.expected_header)
        .unwrap_or(false)
}

fn request_header<'a>(request: &'a Request, header_name: &str) -> Option<&'a str> {
    header_value(&request.headers, header_name)
}

fn write_unauthorized(stream: &mut TcpStream) -> std::io::Result<()> {
    write_response_with_extra_headers(
        stream,
        "401 Unauthorized",
        "text/plain; charset=utf-8",
        "authentication required\n",
        "WWW-Authenticate: Basic realm=\"zFrontier Report\"",
    )
}

fn write_redirect(stream: &mut TcpStream, location: &str) -> std::io::Result<()> {
    write_response_with_extra_headers(
        stream,
        "303 See Other",
        "text/plain; charset=utf-8",
        "redirecting\n",
        &format!("Location: {}", location),
    )
}

fn write_response(
    stream: &mut TcpStream,
    status: &str,
    content_type: &str,
    body: &str,
) -> std::io::Result<()> {
    write_response_with_extra_headers(stream, status, content_type, body, "")
}

fn write_response_with_extra_headers(
    stream: &mut TcpStream,
    status: &str,
    content_type: &str,
    body: &str,
    extra_headers: &str,
) -> std::io::Result<()> {
    let extra_headers = if extra_headers.is_empty() {
        String::new()
    } else {
        format!("{extra_headers}\r\n")
    };
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\n{extra_headers}Connection: close\r\n\r\n{body}",
        body.as_bytes().len()
    );
    stream.write_all(response.as_bytes())
}

fn base64_encode(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(input.len().div_ceil(3) * 4);

    for chunk in input.chunks(3) {
        let first = chunk[0];
        let second = *chunk.get(1).unwrap_or(&0);
        let third = *chunk.get(2).unwrap_or(&0);

        output.push(TABLE[(first >> 2) as usize] as char);
        output.push(TABLE[(((first & 0b0000_0011) << 4) | (second >> 4)) as usize] as char);

        if chunk.len() > 1 {
            output.push(TABLE[(((second & 0b0000_1111) << 2) | (third >> 6)) as usize] as char);
        } else {
            output.push('=');
        }

        if chunk.len() > 2 {
            output.push(TABLE[(third & 0b0011_1111) as usize] as char);
        } else {
            output.push('=');
        }
    }

    output
}

fn read_dotenv(path: &Path) -> HashMap<String, String> {
    let mut values = HashMap::new();
    let Ok(content) = fs::read_to_string(path) else {
        return values;
    };

    for raw_line in content.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        values.insert(
            key.trim().to_string(),
            strip_env_quotes(value.trim()).to_string(),
        );
    }

    values
}

fn env_or_dotenv(dotenv: &HashMap<String, String>, key: &str) -> Option<String> {
    env::var(key).ok().or_else(|| dotenv.get(key).cloned())
}

fn strip_env_quotes(value: &str) -> &str {
    if value.len() >= 2 {
        let bytes = value.as_bytes();
        let first = bytes[0];
        let last = bytes[value.len() - 1];
        if (first == b'\'' && last == b'\'') || (first == b'"' && last == b'"') {
            return &value[1..value.len() - 1];
        }
    }
    value
}

fn parse_form_urlencoded(input: &str) -> HashMap<String, String> {
    let mut values = HashMap::new();
    for pair in input.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        values.insert(percent_decode(key), percent_decode(value));
    }
    values
}

fn percent_decode(input: &str) -> String {
    let mut output = Vec::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut index = 0;

    while index < bytes.len() {
        match bytes[index] {
            b'+' => {
                output.push(b' ');
                index += 1;
            }
            b'%' if index + 2 < bytes.len() => {
                let hex = &input[index + 1..index + 3];
                if let Ok(value) = u8::from_str_radix(hex, 16) {
                    output.push(value);
                    index += 3;
                } else {
                    output.push(bytes[index]);
                    index += 1;
                }
            }
            value => {
                output.push(value);
                index += 1;
            }
        }
    }

    String::from_utf8_lossy(&output).to_string()
}

fn normalize_account_id(value: &str) -> String {
    let mut output = String::new();
    let mut previous_dash = false;
    for character in value.trim().chars() {
        if character.is_ascii_alphanumeric() || character == '_' || character == '.' {
            output.push(character);
            previous_dash = false;
        } else if character == '-' {
            if !previous_dash {
                output.push('-');
                previous_dash = true;
            }
        } else if !previous_dash {
            output.push('-');
            previous_dash = true;
        }
    }
    output.trim_matches('-').to_string()
}

fn render_draw_time(value: &str) -> String {
    let draw_at = value.trim();
    if draw_at.is_empty() {
        return "-".to_string();
    }

    format!(
        r#"<time datetime="{}">{}</time>"#,
        escape_attr(draw_at),
        escape_html(draw_at)
    )
}

fn render_daily_engagement_count(record: &Record) -> String {
    let date = record.last_engaged_date.trim();
    if date.is_empty() || record.daily_engagement_count <= 0 {
        return "-".to_string();
    }

    format!("{}: {}", escape_html(date), record.daily_engagement_count)
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn escape_attr(value: &str) -> String {
    escape_html(value).replace('`', "&#96;")
}
