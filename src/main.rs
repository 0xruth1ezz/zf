use rusqlite::{params, Connection};
use std::cmp::Ordering;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::env;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

const APP_CSS: &str = include_str!("../ui.generated.css");
const REPORT_PAGE_SIZE: usize = 20;

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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LotterySortOrder {
    EngagedDesc,
    EngagedAsc,
    DrawAsc,
    DrawDesc,
}

impl LotterySortOrder {
    fn from_query(value: Option<&str>) -> Self {
        match value.map(|value| value.trim()) {
            Some("engaged_asc") => Self::EngagedAsc,
            Some("draw_asc") => Self::DrawAsc,
            Some("draw_desc") => Self::DrawDesc,
            _ => Self::EngagedDesc,
        }
    }

    fn value(self) -> &'static str {
        match self {
            Self::EngagedDesc => "engaged_desc",
            Self::EngagedAsc => "engaged_asc",
            Self::DrawAsc => "draw_asc",
            Self::DrawDesc => "draw_desc",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct PageWindow {
    current: usize,
    page_count: usize,
    start: usize,
    end: usize,
    total: usize,
}

impl PageWindow {
    fn new(total: usize, requested_page: usize) -> Self {
        let page_count = total.div_ceil(REPORT_PAGE_SIZE).max(1);
        let current = requested_page.clamp(1, page_count);
        let start = ((current - 1) * REPORT_PAGE_SIZE).min(total);
        let end = (start + REPORT_PAGE_SIZE).min(total);

        Self {
            current,
            page_count,
            start,
            end,
            total,
        }
    }
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
        r##"
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
        <nav class="app-nav" aria-label="Primary">{nav}</nav>
      </div>
    </header>"##
    )
}

fn render_metric_strip(metrics: &[(&str, String)]) -> String {
    let metric_items = metrics
        .iter()
        .map(|(label, value)| {
            format!(
                r#"
            <div class="metric">
              <dt class="metric__label">{}</dt>
              <dd class="metric__value">{}</dd>
            </div>"#,
                escape_html(label),
                escape_html(value)
            )
        })
        .collect::<String>();

    format!(
        r#"
          <dl class="metric-strip">{metric_items}
          </dl>"#
    )
}

fn render_config(db_path: &Path, query: &str) -> rusqlite::Result<String> {
    let accounts = load_accounts(db_path)?;
    let query_values = parse_form_urlencoded(query);
    let notice = if query_values.contains_key("saved") {
        r#"<div class="notice" role="status">Account saved.</div>"#
    } else if query_values.contains_key("deleted") {
        r#"<div class="notice" role="status">Account deleted.</div>"#
    } else {
        ""
    };

    let account_rows = accounts
        .iter()
        .map(|account| {
            let checked = if account.enabled { " checked" } else { "" };
            let status_class = if account.enabled {
                "status-badge--success"
            } else {
                ""
            };
            let status_label = if account.enabled { "Enabled" } else { "Paused" };
            let form_id = format!("account-save-{}", account.id);
            format!(
                r#"
          <article class="account-row">
            <header class="account-row__header">
              <h3><code>{}</code></h3>
              <span class="status-badge {}">{}</span>
            </header>
            <form id="{}" class="account-form" method="post" action="/config/accounts" autocomplete="off">
              <input type="hidden" name="id" value="{}">
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
              <button class="action-primary" type="submit" form="{}" data-pending-label="Saving...">Save</button>
              <form class="delete-form" method="post" action="/config/accounts/delete" data-delete-account data-account-id="{}">
                <input type="hidden" name="id" value="{}">
                <button class="action-danger" type="submit" data-pending-label="Deleting...">Delete</button>
              </form>
            </div>
            <div class="row-meta">
              <span>Created <time datetime="{}" data-local-datetime>{}</time></span>
              <span>Updated <time datetime="{}" data-local-datetime>{}</time></span>
            </div>
          </article>"#,
                escape_html(&account.id),
                status_class,
                status_label,
                escape_attr(&form_id),
                escape_attr(&account.id),
                escape_attr(&account.phone),
                checked,
                escape_attr(&form_id),
                escape_attr(&account.id),
                escape_attr(&account.id),
                escape_attr(&account.created_at),
                escape_html(&account.created_at),
                escape_attr(&account.updated_at),
                escape_html(&account.updated_at),
            )
        })
        .collect::<String>();

    let account_list = if account_rows.is_empty() {
        String::new()
    } else {
        format!(r#"<div class="account-list">{account_rows}</div>"#)
    };

    let empty_accounts = if accounts.is_empty() {
        r#"<div class="empty panel"><strong>No database accounts yet</strong><span>The crawler will keep using env fallback credentials until an enabled account is saved here.</span></div>"#
    } else {
        ""
    };
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
    <main id="main-content">
      <header class="page-header">
        <div>
          <h1 class="page-title">Configuration</h1>
          <p class="page-copy">Manage the crawler accounts used for zFrontier sign-ins and lottery participation.</p>
        </div>
      </header>
      {}
      <section>
        <div class="section-heading">
          <div>
            <h2>Accounts <span class="section-count">{}</span></h2>
            <p class="section-note">Enabled accounts are loaded before environment fallback credentials.</p>
          </div>
        </div>
        {}
        {}
      </section>
      <section>
        <div class="section-heading">
          <div>
            <h2 id="add-account-title">Add account</h2>
            <p class="section-note">Store credentials in the local SQLite database for crawler runs.</p>
          </div>
        </div>
        <form class="new-account" method="post" action="/config/accounts" autocomplete="off" aria-labelledby="add-account-title">
          <label>
            <span>Account ID</span>
            <input name="id" placeholder="e.g. primary" autocomplete="off" required>
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
          <button class="action-primary" type="submit" data-pending-label="Adding...">Add</button>
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

        document.querySelectorAll('[data-delete-account]').forEach((form) => {{
          form.addEventListener('submit', (event) => {{
            const accountId = form.dataset.accountId || 'this account';
            if (!window.confirm(`Delete account "${{accountId}}"? This cannot be undone.`)) {{
              event.preventDefault();
            }}
          }});
        }});

        document.querySelectorAll('form[method="post"]').forEach((form) => {{
          form.addEventListener('submit', (event) => {{
            if (event.defaultPrevented) return;
            const button = event.submitter;
            if (!(button instanceof HTMLButtonElement)) return;
            button.disabled = true;
            button.textContent = button.dataset.pendingLabel || button.textContent;
          }});
        }});
      }})();
    </script>
  </body>
</html>
"#,
        APP_CSS,
        render_app_bar("config"),
        notice,
        accounts.len(),
        empty_accounts,
        account_list,
    ))
}

fn render_report(db_path: &Path, query: &str) -> rusqlite::Result<String> {
    let query_values = parse_form_urlencoded(query);
    let selected_account = query_values
        .get("account")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty());
    let include_drawn = query_flag_enabled(&query_values, "include_drawn");
    let include_unknown = query_flag_enabled(&query_values, "include_unknown");
    let sort_order = LotterySortOrder::from_query(query_values.get("sort").map(String::as_str));
    let all_records = load_records(db_path)?;
    let all_sign_ins = load_sign_ins(db_path)?;
    let accounts = load_accounts(db_path)?;
    let account_ids = report_account_ids(&all_records, &all_sign_ins, &accounts);
    let account_records = filter_records_by_account(&all_records, selected_account);
    let now_china_minute = sqlite_china_now_minute(db_path)?;
    let mut records = filter_records_by_draw_status(
        account_records,
        include_drawn,
        include_unknown,
        &now_china_minute,
    );
    sort_lottery_records(&mut records, sort_order);
    let sign_ins = filter_sign_ins_by_account(&all_sign_ins, selected_account);
    let lottery_page = PageWindow::new(
        records.len(),
        query_page_number(&query_values, "lottery_page"),
    );
    let sign_in_page = PageWindow::new(
        sign_ins.len(),
        query_page_number(&query_values, "sign_in_page"),
    );
    let account_count = selected_account
        .map(|account| usize::from(account_ids.iter().any(|id| id == account)))
        .unwrap_or_else(|| unique_account_count(&all_records, &all_sign_ins, &accounts));
    let account_filter_options = render_account_filter_options(&account_ids, selected_account);
    let lottery_metric_label = if include_drawn {
        "Threads"
    } else {
        "Active draws"
    };
    let metrics = render_metric_strip(&[
        ("Accounts", account_count.to_string()),
        (lottery_metric_label, records.len().to_string()),
        ("Sign-ins", sign_ins.len().to_string()),
        ("Updated", now_china_minute.clone()),
    ]);
    let rows = records[lottery_page.start..lottery_page.end]
        .iter()
        .enumerate()
        .map(|(index, record)| {
            format!(
                r#"
          <tr data-account-id="{}" data-draw-at="{}">
            <td>{}</td>
            <td><code>{}</code></td>
            <td><a href="{}" target="_blank" rel="noreferrer">{}</a></td>
            <td>{}</td>
            <td>{}</td>
            <td><time datetime="{}" data-local-datetime>{}</time></td>
            <td><code>{}</code></td>
          </tr>"#,
                escape_attr(&record.account_id),
                escape_attr(&record.draw_at),
                lottery_page.start + index + 1,
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

    let sign_in_rows = sign_ins[sign_in_page.start..sign_in_page.end]
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
                sign_in_page.start + index + 1,
                escape_html(&record.account_id),
                escape_html(&record.sign_in_date),
                escape_attr(&record.signed_at),
                escape_html(&record.signed_at),
                render_status(&record.status),
                escape_html(&record.message),
            )
        })
        .collect::<String>();

    let empty = if records.is_empty() && include_drawn && include_unknown {
        r#"<div class="empty panel"><strong>No lottery threads found</strong><span>The crawler has not recorded any lottery threads for the selected account.</span></div>"#
    } else if records.is_empty() {
        r#"<div class="empty panel"><strong>No matching lottery threads</strong><span>Change the draw status filters to broaden the list.</span></div>"#
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
        let pagination = render_report_pagination(
            "Lottery threads",
            "lottery_page",
            lottery_page,
            selected_account,
            include_drawn,
            include_unknown,
            sort_order,
            Some(("sign_in_page", sign_in_page.current)),
        );
        format!(
            r#"<div class="panel table-container report-table" data-table-container tabindex="0" aria-label="Lottery threads table">
        <table class="lottery-table">
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
        <tbody>{rows}
        </tbody>
      </table>
      </div>
      {pagination}"#
        )
    };

    let sign_in_table = if sign_ins.is_empty() {
        String::new()
    } else {
        let pagination = render_report_pagination(
            "Daily sign-ins",
            "sign_in_page",
            sign_in_page,
            selected_account,
            include_drawn,
            include_unknown,
            sort_order,
            Some(("lottery_page", lottery_page.current)),
        );
        format!(
            r#"<div class="panel table-container report-table" data-table-container tabindex="0" aria-label="Daily sign-ins table">
        <table>
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
        <tbody>{sign_in_rows}
        </tbody>
      </table>
      </div>
      {pagination}"#
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
    <main id="main-content">
      <header class="page-header">
        <div>
          <h1 class="page-title">Activity report</h1>
          <p class="page-copy">Review recorded lottery engagements, daily sign-ins, draw times, and account-specific activity from recent crawler runs.</p>
        </div>
        {}
      </header>
      <form class="toolbar" method="get" action="/report" aria-label="Report filters" data-report-filter>
        <div class="toolbar__filters">
          <label class="field" for="account-filter">
            <span>Account</span>
            <select id="account-filter" name="account" data-account-filter>
              <option value=""{}>All accounts</option>
              {}
            </select>
          </label>
          <label class="field field--sort" for="lottery-sort">
            <span>Sort order</span>
            <select id="lottery-sort" name="sort" data-lottery-sort>
              {}
            </select>
          </label>
        </div>
        <div class="toolbar__toggles">
          <label class="switch">
            <input name="include_drawn" type="checkbox" value="1" data-include-drawn{}>
            <span>Include drawn</span>
          </label>
          <label class="switch">
            <input name="include_unknown" type="checkbox" value="1" data-include-unknown{}>
            <span>Include unknown draw time</span>
          </label>
        </div>
      </form>
      <section>
        <div class="section-heading">
          <div>
            <h2>Lottery threads <span class="section-count">{}</span></h2>
            <p class="section-note">Draw schedule and per-day engagement activity.</p>
          </div>
        </div>
        {}
        {}
      </section>
      <section>
        <div class="section-heading">
          <div>
            <h2>Daily sign-ins <span class="section-count">{}</span></h2>
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
        const includeDrawn = document.querySelector('[data-include-drawn]');
        const includeUnknown = document.querySelector('[data-include-unknown]');
        const lotterySort = document.querySelector('[data-lottery-sort]');
        const reportFilter = document.querySelector('[data-report-filter]');

        document.querySelectorAll('time[data-local-datetime]').forEach((node) => {{
          const value = node.getAttribute('datetime');
          const date = new Date(value);
          if (Number.isNaN(date.getTime())) return;
          node.textContent = formatLocalDateTime(date);
          node.title = value;
        }});

        const submitFilters = () => {{
          if (reportFilter?.requestSubmit) {{
            reportFilter.requestSubmit();
          }} else {{
            reportFilter?.submit();
          }}
        }};
        accountFilter?.addEventListener('change', submitFilters);
        includeDrawn?.addEventListener('change', submitFilters);
        includeUnknown?.addEventListener('change', submitFilters);
        lotterySort?.addEventListener('change', submitFilters);
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
        render_lottery_sort_options(sort_order),
        if include_drawn { " checked" } else { "" },
        if include_unknown { " checked" } else { "" },
        records.len(),
        empty,
        table,
        sign_ins.len(),
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

fn filter_records_by_draw_status<'a>(
    records: Vec<&'a Record>,
    include_drawn: bool,
    include_unknown: bool,
    now_china_minute: &str,
) -> Vec<&'a Record> {
    records
        .into_iter()
        .filter(|record| match draw_minute_key(&record.draw_at) {
            Some(draw_minute) => {
                include_drawn
                    || now_china_minute.is_empty()
                    || draw_minute.as_str() > now_china_minute
            }
            None => include_unknown,
        })
        .collect()
}

fn sort_lottery_records(records: &mut [&Record], sort_order: LotterySortOrder) {
    records.sort_by(|left, right| {
        let ordering = match sort_order {
            LotterySortOrder::EngagedDesc => compare_optional_sort_values(
                non_empty_sort_value(&left.engaged_at),
                non_empty_sort_value(&right.engaged_at),
                false,
            ),
            LotterySortOrder::EngagedAsc => compare_optional_sort_values(
                non_empty_sort_value(&left.engaged_at),
                non_empty_sort_value(&right.engaged_at),
                true,
            ),
            LotterySortOrder::DrawAsc => compare_optional_sort_values(
                draw_minute_key(&left.draw_at),
                draw_minute_key(&right.draw_at),
                true,
            ),
            LotterySortOrder::DrawDesc => compare_optional_sort_values(
                draw_minute_key(&left.draw_at),
                draw_minute_key(&right.draw_at),
                false,
            ),
        };

        ordering
            .then_with(|| left.account_id.cmp(&right.account_id))
            .then_with(|| left.post_id.cmp(&right.post_id))
    });
}

fn non_empty_sort_value(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

fn compare_optional_sort_values(
    left: Option<String>,
    right: Option<String>,
    ascending: bool,
) -> Ordering {
    match (left, right) {
        (Some(left), Some(right)) if ascending => left.cmp(&right),
        (Some(left), Some(right)) => right.cmp(&left),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => Ordering::Equal,
    }
}

fn draw_minute_key(value: &str) -> Option<String> {
    let normalized = value
        .trim()
        .replace('/', "-")
        .replace('.', "-")
        .replace('T', " ");
    let mut parts = normalized.split_whitespace();
    let date = parts.next()?;
    let time = parts.next()?;

    let mut date_parts = date.split('-');
    let year = date_parts.next()?.parse::<u32>().ok()?;
    let month = date_parts.next()?.parse::<u32>().ok()?;
    let day = date_parts.next()?.parse::<u32>().ok()?;
    if date_parts.next().is_some() {
        return None;
    }

    let mut time_parts = time.split(':');
    let hour = time_parts.next()?.parse::<u32>().ok()?;
    let minute = time_parts.next()?.parse::<u32>().ok()?;
    if !(2000..=2999).contains(&year)
        || !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
    {
        return None;
    }

    Some(format!(
        "{year:04}-{month:02}-{day:02} {hour:02}:{minute:02}"
    ))
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

fn render_lottery_sort_options(selected: LotterySortOrder) -> String {
    [
        (LotterySortOrder::EngagedDesc, "Last engaged: newest first"),
        (LotterySortOrder::EngagedAsc, "Last engaged: oldest first"),
        (LotterySortOrder::DrawAsc, "Draw time: soonest first"),
        (LotterySortOrder::DrawDesc, "Draw time: latest first"),
    ]
    .iter()
    .map(|(value, label)| {
        let selected_attr = if *value == selected { " selected" } else { "" };
        format!(
            r#"<option value="{}"{}>{}</option>"#,
            value.value(),
            selected_attr,
            label
        )
    })
    .collect::<Vec<_>>()
    .join("\n              ")
}

fn render_report_pagination(
    label: &str,
    page_parameter: &str,
    page: PageWindow,
    selected_account: Option<&str>,
    include_drawn: bool,
    include_unknown: bool,
    sort_order: LotterySortOrder,
    other_page: Option<(&str, usize)>,
) -> String {
    if page.total == 0 || page.page_count <= 1 {
        return String::new();
    }

    let mut state = vec![render_hidden_input("sort", sort_order.value())];
    if let Some(account) = selected_account {
        state.push(render_hidden_input("account", account));
    }
    if include_drawn {
        state.push(render_hidden_input("include_drawn", "1"));
    }
    if include_unknown {
        state.push(render_hidden_input("include_unknown", "1"));
    }
    if let Some((parameter, current)) = other_page.filter(|(_, current)| *current > 1) {
        state.push(render_hidden_input(parameter, &current.to_string()));
    }

    let previous_page = page.current.saturating_sub(1).max(1);
    let next_page = (page.current + 1).min(page.page_count);
    let previous_disabled = if page.current == 1 { " disabled" } else { "" };
    let next_disabled = if page.current == page.page_count {
        " disabled"
    } else {
        ""
    };

    format!(
        r#"<form class="pagination" method="get" action="/report" aria-label="{} pagination">
        {}
        <button type="submit" name="{}" value="{}"{}>Previous</button>
        <span class="pagination__status">{}-{} of {} (page {} of {})</span>
        <button type="submit" name="{}" value="{}"{}>Next</button>
      </form>"#,
        escape_attr(label),
        state.join("\n        "),
        page_parameter,
        previous_page,
        previous_disabled,
        page.start + 1,
        page.end,
        page.total,
        page.current,
        page.page_count,
        page_parameter,
        next_page,
        next_disabled,
    )
}

fn render_hidden_input(name: &str, value: &str) -> String {
    format!(
        r#"<input type="hidden" name="{}" value="{}">"#,
        escape_attr(name),
        escape_attr(value)
    )
}

fn query_page_number(values: &HashMap<String, String>, key: &str) -> usize {
    values
        .get(key)
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(1)
}

fn query_flag_enabled(values: &HashMap<String, String>, key: &str) -> bool {
    values
        .get(key)
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "on" | "yes"
            )
        })
        .unwrap_or(false)
}

fn sqlite_china_now_minute(db_path: &Path) -> rusqlite::Result<String> {
    let conn = Connection::open(db_path)?;
    conn.query_row(
        "SELECT strftime('%Y-%m-%d %H:%M', 'now', '+8 hours')",
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
        return r#"<span class="status-badge">Unknown</span>"#.to_string();
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
        return r#"<span class="empty-value">Not recorded</span>"#.to_string();
    }

    format!(
        r#"<span class="count-stack"><strong>{}</strong><small>{}</small></span>"#,
        record.daily_engagement_count,
        escape_html(date)
    )
}

fn render_status(value: &str) -> String {
    let normalized = value.trim().to_ascii_lowercase();
    let tone = match normalized.as_str() {
        "signed" | "already_signed" | "success" => " status-badge--success",
        "clicked" => " status-badge--info",
        "failed" | "error" => " status-badge--danger",
        _ => "",
    };
    let label = humanize_identifier(&normalized);

    format!(
        r#"<span class="status-badge{}">{}</span>"#,
        tone,
        escape_html(&label)
    )
}

fn humanize_identifier(value: &str) -> String {
    let label = value
        .split('_')
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => format!("{}{}", first.to_ascii_uppercase(), chars.as_str()),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ");

    if label.is_empty() {
        "Unknown".to_string()
    } else {
        label
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn record(post_id: &str, draw_at: &str) -> Record {
        Record {
            account_id: "account".to_string(),
            post_id: post_id.to_string(),
            title: post_id.to_string(),
            url: format!("https://example.test/{post_id}"),
            draw_at: draw_at.to_string(),
            last_engaged_date: String::new(),
            daily_engagement_count: 0,
            engaged_at: String::new(),
        }
    }

    #[test]
    fn hides_drawn_and_unknown_records_by_default() {
        let records = [
            record("drawn", "2026-09-04 12:00"),
            record("active", "2026-09-04 12:01"),
            record("unknown", ""),
        ];

        let filtered = filter_records_by_draw_status(
            records.iter().collect(),
            false,
            false,
            "2026-09-04 12:00",
        );
        let post_ids = filtered
            .iter()
            .map(|record| record.post_id.as_str())
            .collect::<Vec<_>>();

        assert_eq!(post_ids, vec!["active"]);
    }

    #[test]
    fn draw_status_filters_are_independent() {
        let records = [
            record("drawn", "2026-09-04 12:00"),
            record("active", "2026-09-04 12:01"),
            record("unknown", ""),
        ];

        let include_drawn = filter_records_by_draw_status(
            records.iter().collect(),
            true,
            false,
            "2026-09-04 12:00",
        );
        let include_unknown = filter_records_by_draw_status(
            records.iter().collect(),
            false,
            true,
            "2026-09-04 12:00",
        );
        let include_both =
            filter_records_by_draw_status(records.iter().collect(), true, true, "2026-09-04 12:00");

        assert_eq!(
            include_drawn
                .iter()
                .map(|record| record.post_id.as_str())
                .collect::<Vec<_>>(),
            vec!["drawn", "active"]
        );
        assert_eq!(
            include_unknown
                .iter()
                .map(|record| record.post_id.as_str())
                .collect::<Vec<_>>(),
            vec!["active", "unknown"]
        );
        assert_eq!(include_both.len(), 3);
    }

    #[test]
    fn sorts_draw_and_engagement_times_with_unknown_values_last() {
        let mut early = record("early", "2026-09-04 13:00");
        early.engaged_at = "2026-09-04T01:00:00.000Z".to_string();
        let mut late = record("late", "2026-09-04 14:00");
        late.engaged_at = "2026-09-04T02:00:00.000Z".to_string();
        let unknown = record("unknown", "");
        let records = [late, unknown, early];

        let mut draw_ascending = records.iter().collect::<Vec<_>>();
        sort_lottery_records(&mut draw_ascending, LotterySortOrder::DrawAsc);
        assert_eq!(
            draw_ascending
                .iter()
                .map(|record| record.post_id.as_str())
                .collect::<Vec<_>>(),
            vec!["early", "late", "unknown"]
        );

        let mut engaged_descending = records.iter().collect::<Vec<_>>();
        sort_lottery_records(&mut engaged_descending, LotterySortOrder::EngagedDesc);
        assert_eq!(
            engaged_descending
                .iter()
                .map(|record| record.post_id.as_str())
                .collect::<Vec<_>>(),
            vec!["late", "early", "unknown"]
        );
    }

    #[test]
    fn pagination_clamps_pages_and_tracks_row_ranges() {
        assert_eq!(
            PageWindow::new(45, 2),
            PageWindow {
                current: 2,
                page_count: 3,
                start: 20,
                end: 40,
                total: 45,
            }
        );
        assert_eq!(PageWindow::new(45, 99).current, 3);
        assert_eq!(PageWindow::new(0, 4).current, 1);
    }
}
