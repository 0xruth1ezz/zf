use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::json;
use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

const APP_CSS: &str = include_str!("../dist/assets/app.css");
const APP_JS: &str = include_str!("../dist/assets/app.js");

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SignInRecord {
    account_id: String,
    sign_in_date: String,
    signed_at: String,
    status: String,
    message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AccountConfig {
    id: String,
    phone: String,
    enabled: bool,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DashboardPayload {
    records: Vec<Record>,
    sign_ins: Vec<SignInRecord>,
    accounts: Vec<AccountConfig>,
    generated_at: String,
    is_snapshot: bool,
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
    headers: String,
    body: String,
}

fn main() -> std::io::Result<()> {
    let config = Config::load();
    ensure_schema(&config.db_path).expect("failed to initialize SQLite schema");

    let listener = TcpListener::bind(&config.bind_addr)?;
    println!(
        "Serving zFrontier operations at http://{}",
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

        Self {
            bind_addr: format!("{host}:{port}"),
            db_path,
            report_auth: report_auth_from_env(&dotenv),
        }
    }
}

fn handle_client(mut stream: TcpStream, config: &Config) -> std::io::Result<()> {
    let request = read_request(&mut stream)?;
    let is_public_asset = matches!(
        (request.method.as_str(), request.path.as_str()),
        ("GET", "/health") | ("GET", "/assets/app.css") | ("GET", "/assets/app.js")
    );
    if !is_public_asset && !is_authorized(&request, config.report_auth.as_ref()) {
        return write_unauthorized(&mut stream);
    }

    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/health") => {
            write_response(&mut stream, "200 OK", "text/plain; charset=utf-8", "ok\n")
        }
        ("GET", "/assets/app.css") => {
            write_response(&mut stream, "200 OK", "text/css; charset=utf-8", APP_CSS)
        }
        ("GET", "/assets/app.js") => write_response(
            &mut stream,
            "200 OK",
            "text/javascript; charset=utf-8",
            APP_JS,
        ),
        ("GET", "/")
        | ("GET", "/index.html")
        | ("GET", "/report")
        | ("GET", "/activity")
        | ("GET", "/config")
        | ("GET", "/config.html")
        | ("GET", "/accounts") => write_response(
            &mut stream,
            "200 OK",
            "text/html; charset=utf-8",
            &render_app_shell(),
        ),
        ("GET", "/api/dashboard") => match load_dashboard(&config.db_path) {
            Ok(payload) => write_json(&mut stream, "200 OK", &payload),
            Err(error) => {
                write_json_error(&mut stream, "500 Internal Server Error", &error.to_string())
            }
        },
        ("POST", "/api/accounts") => match save_account_from_form(&config.db_path, &request.body) {
            Ok(()) => write_json_value(&mut stream, "200 OK", &json!({ "ok": true })),
            Err(error) => write_json_error(&mut stream, "400 Bad Request", &error),
        },
        ("POST", "/api/accounts/delete") => {
            match delete_account_from_form(&config.db_path, &request.body) {
                Ok(()) => write_json_value(&mut stream, "200 OK", &json!({ "ok": true })),
                Err(error) => write_json_error(&mut stream, "400 Bad Request", &error),
            }
        }
        ("POST", "/config/accounts") => {
            match save_account_from_form(&config.db_path, &request.body) {
                Ok(()) => write_redirect(&mut stream, "/#accounts"),
                Err(error) => write_response(
                    &mut stream,
                    "400 Bad Request",
                    "text/plain; charset=utf-8",
                    &format!("{error}\n"),
                ),
            }
        }
        ("POST", "/config/accounts/delete") => {
            match delete_account_from_form(&config.db_path, &request.body) {
                Ok(()) => write_redirect(&mut stream, "/#accounts"),
                Err(error) => write_response(
                    &mut stream,
                    "400 Bad Request",
                    "text/plain; charset=utf-8",
                    &format!("{error}\n"),
                ),
            }
        }
        _ => write_response(
            &mut stream,
            "404 Not Found",
            "text/plain; charset=utf-8",
            "not found\n",
        ),
    }
}

fn render_app_shell() -> String {
    r##"<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="theme-color" content="#f5f7f7">
    <meta name="description" content="zFrontier crawler operations workspace">
    <title>zFrontier Operations</title>
    <link rel="stylesheet" href="/assets/app.css">
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/assets/app.js"></script>
  </body>
</html>
"##
    .to_string()
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
    let path = target.split('?').next().unwrap_or("/").to_string();

    Ok(Request {
        method,
        path,
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
        "COALESCE(NULLIF(account_id, ''), 'default')".to_string()
    } else {
        "'default'".to_string()
    };
    let draw_at = legacy_column_expr(&columns, "draw_at", "''");
    let last_engaged_date =
        legacy_column_expr(&columns, "last_engaged_date", "substr(engaged_at, 1, 10)");
    let daily_count = legacy_column_expr(&columns, "daily_engagement_count", "1");

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
        INSERT OR IGNORE INTO engaged_lotteries
          (account_id, post_id, title, url, draw_at, last_engaged_date, daily_engagement_count, engaged_at)
        SELECT {account_expr}, post_id, title, url, {draw_at}, {last_engaged_date}, {daily_count}, engaged_at
        FROM engaged_lotteries_legacy_migration;
        DROP TABLE engaged_lotteries_legacy_migration;
        "#
    ))
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
        INSERT OR IGNORE INTO daily_sign_ins
          (account_id, sign_in_date, signed_at, url, status, message)
        SELECT {account_expr}, sign_in_date, signed_at, url, status, message
        FROM daily_sign_ins_legacy_migration;
        DROP TABLE daily_sign_ins_legacy_migration;
        "#
    ))
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
            .find(|column| column.name == *name)
            .map(|column| column.primary_key_position == (index + 1) as i64)
            .unwrap_or(false)
    })
}

fn add_column_if_missing(
    conn: &Connection,
    table_name: &str,
    column_name: &str,
    definition: &str,
) -> rusqlite::Result<()> {
    if table_columns(conn, table_name)?
        .iter()
        .any(|column| column.name == column_name)
    {
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

fn load_dashboard(db_path: &Path) -> rusqlite::Result<DashboardPayload> {
    Ok(DashboardPayload {
        records: load_records(db_path)?,
        sign_ins: load_sign_ins(db_path)?,
        accounts: load_accounts(db_path)?,
        generated_at: sqlite_now(db_path)?,
        is_snapshot: false,
    })
}

fn load_records(db_path: &Path) -> rusqlite::Result<Vec<Record>> {
    let conn = Connection::open(db_path)?;
    let mut stmt = conn.prepare(
        "SELECT account_id, post_id, title, url, draw_at, last_engaged_date, daily_engagement_count, engaged_at FROM engaged_lotteries ORDER BY engaged_at DESC",
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
        "SELECT account_id, sign_in_date, signed_at, status, message FROM daily_sign_ins ORDER BY signed_at DESC",
    )?;
    let sign_ins = stmt
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
    sign_ins
}

fn load_accounts(db_path: &Path) -> rusqlite::Result<Vec<AccountConfig>> {
    let conn = Connection::open(db_path)?;
    let mut stmt = conn.prepare(
        "SELECT id, phone, enabled, created_at, updated_at FROM zfrontier_accounts ORDER BY id",
    )?;
    let accounts = stmt
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
    accounts
}

fn sqlite_now(db_path: &Path) -> rusqlite::Result<String> {
    let conn = Connection::open(db_path)?;
    conn.query_row(
        "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
        params![],
        |row| row.get(0),
    )
}

fn save_account_from_form(db_path: &Path, body: &str) -> Result<(), String> {
    let form = parse_form_urlencoded(body);
    let id = normalize_account_id(form.get("id").map(String::as_str).unwrap_or(""));
    let phone = form.get("phone").map(|value| value.trim()).unwrap_or("");
    let password = form.get("password").map(|value| value.trim()).unwrap_or("");
    let enabled = i64::from(form.contains_key("enabled"));

    if id.is_empty() {
        return Err("Account ID is required.".to_string());
    }
    if phone.is_empty() {
        return Err("Phone is required.".to_string());
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
        existing_password.ok_or_else(|| "Password is required for new accounts.".to_string())?
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
        .ok_or_else(|| "Account ID is required.".to_string())?;
    let conn = Connection::open(db_path).map_err(|error| error.to_string())?;
    conn.execute("DELETE FROM zfrontier_accounts WHERE id = ?1", params![id])
        .map_err(|error| error.to_string())?;
    Ok(())
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
    header_value(&request.headers, "Authorization")
        .map(|value| value.trim() == auth.expected_header)
        .unwrap_or(false)
}

fn write_unauthorized(stream: &mut TcpStream) -> std::io::Result<()> {
    write_response_with_extra_headers(
        stream,
        "401 Unauthorized",
        "text/plain; charset=utf-8",
        "authentication required\n",
        "WWW-Authenticate: Basic realm=\"zFrontier report\", charset=\"UTF-8\"\r\n",
    )
}

fn write_redirect(stream: &mut TcpStream, location: &str) -> std::io::Result<()> {
    write_response_with_extra_headers(
        stream,
        "303 See Other",
        "text/plain; charset=utf-8",
        "redirecting\n",
        &format!("Location: {location}\r\n"),
    )
}

fn write_json<T: Serialize>(
    stream: &mut TcpStream,
    status: &str,
    value: &T,
) -> std::io::Result<()> {
    let body = serde_json::to_string(value)
        .unwrap_or_else(|_| "{\"error\":\"Serialization failed.\"}".to_string());
    write_response(stream, status, "application/json; charset=utf-8", &body)
}

fn write_json_value(
    stream: &mut TcpStream,
    status: &str,
    value: &serde_json::Value,
) -> std::io::Result<()> {
    write_json(stream, status, value)
}

fn write_json_error(stream: &mut TcpStream, status: &str, message: &str) -> std::io::Result<()> {
    write_json_value(stream, status, &json!({ "error": message }))
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
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n{extra_headers}Connection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(response.as_bytes())
}

fn base64_encode(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::new();
    let mut index = 0;
    while index < input.len() {
        let first = input[index];
        let second = input.get(index + 1).copied();
        let third = input.get(index + 2).copied();
        output.push(TABLE[(first >> 2) as usize] as char);
        output.push(TABLE[(((first & 0b11) << 4) | second.unwrap_or(0) >> 4) as usize] as char);
        output.push(match second {
            Some(second) => {
                TABLE[(((second & 0b1111) << 2) | third.unwrap_or(0) >> 6) as usize] as char
            }
            None => '=',
        });
        output.push(match third {
            Some(third) => TABLE[(third & 0b111111) as usize] as char,
            None => '=',
        });
        index += 3;
    }
    output
}

fn read_dotenv(path: &Path) -> HashMap<String, String> {
    let Ok(contents) = fs::read_to_string(path) else {
        return HashMap::new();
    };
    contents
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                return None;
            }
            let line = line.strip_prefix("export ").unwrap_or(line);
            let (key, value) = line.split_once('=')?;
            Some((
                key.trim().to_string(),
                strip_env_quotes(value.trim()).to_string(),
            ))
        })
        .collect()
}

fn env_or_dotenv(dotenv: &HashMap<String, String>, key: &str) -> Option<String> {
    env::var(key).ok().or_else(|| dotenv.get(key).cloned())
}

fn strip_env_quotes(value: &str) -> &str {
    if value.len() >= 2 {
        let bytes = value.as_bytes();
        if (bytes[0] == b'\"' && bytes[value.len() - 1] == b'\"')
            || (bytes[0] == b'\'' && bytes[value.len() - 1] == b'\'')
        {
            return &value[1..value.len() - 1];
        }
    }
    value
}

fn parse_form_urlencoded(input: &str) -> HashMap<String, String> {
    input
        .split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| {
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            (percent_decode(key), percent_decode(value))
        })
        .collect()
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => output.push(b' '),
            b'%' if index + 2 < bytes.len() => {
                let high = hex_value(bytes[index + 1]);
                let low = hex_value(bytes[index + 2]);
                if let (Some(high), Some(low)) = (high, low) {
                    output.push((high << 4) | low);
                    index += 2;
                } else {
                    output.push(bytes[index]);
                }
            }
            byte => output.push(byte),
        }
        index += 1;
    }
    String::from_utf8_lossy(&output).to_string()
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn normalize_account_id(value: &str) -> String {
    value
        .trim()
        .chars()
        .filter_map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                Some(character.to_ascii_lowercase())
            } else if character.is_whitespace() {
                Some('-')
            } else {
                None
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_form_values_and_normalizes_account_ids() {
        let values = parse_form_urlencoded("id=Primary+Account&phone=%2B65+1234&enabled=1");
        assert_eq!(normalize_account_id(&values["id"]), "primary-account");
        assert_eq!(values["phone"], "+65 1234");
        assert!(values.contains_key("enabled"));
    }

    #[test]
    fn dashboard_json_uses_client_contract_keys() {
        let payload = DashboardPayload {
            records: Vec::new(),
            sign_ins: Vec::new(),
            accounts: Vec::new(),
            generated_at: "2026-09-04T00:00:00.000Z".to_string(),
            is_snapshot: false,
        };
        let value = serde_json::to_value(payload).unwrap();
        assert!(value.get("signIns").is_some());
        assert_eq!(value["isSnapshot"], false);
    }

    #[test]
    fn app_shell_loads_compiled_spa_assets() {
        let html = render_app_shell();
        assert!(html.contains("/assets/app.css"));
        assert!(html.contains("/assets/app.js"));
        assert!(html.contains("id=\"root\""));
    }
}
