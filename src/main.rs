use rusqlite::{params, Connection};
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Debug)]
struct Record {
    account_id: String,
    post_id: String,
    title: String,
    url: String,
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

            let body = match render_report(&config.db_path) {
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
    let body = raw
        .get(header_end + 4..)
        .unwrap_or("")
        .to_string();
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
    conn.execute_batch(&format!(
        r#"
        DROP TABLE IF EXISTS engaged_lotteries_legacy_migration;
        ALTER TABLE engaged_lotteries RENAME TO engaged_lotteries_legacy_migration;
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
          SELECT {account_expr}, post_id, title, url, engaged_at
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

fn load_records(db_path: &Path) -> rusqlite::Result<Vec<Record>> {
    let conn = Connection::open(db_path)?;
    let mut stmt = conn.prepare(
        r#"
        SELECT account_id, post_id, title, url, engaged_at
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
                engaged_at: row.get(4)?,
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
    let enabled = if form.contains_key("enabled") { 1_i64 } else { 0_i64 };

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
        existing_password
            .ok_or_else(|| "password is required for new accounts".to_string())?
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
            format!(
                r#"
          <div class="account-row">
            <form class="account-form" method="post" action="/config/accounts" autocomplete="off">
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
              <button type="submit">Save</button>
            </form>
            <form method="post" action="/config/accounts/delete">
              <input type="hidden" name="id" value="{}">
              <button class="danger" type="submit">Delete</button>
            </form>
            <div class="row-meta">
              <span>Created <time datetime="{}" data-local-datetime>{}</time></span>
              <span>Updated <time datetime="{}" data-local-datetime>{}</time></span>
            </div>
          </div>"#,
                escape_attr(&account.id),
                escape_attr(&account.phone),
                checked,
                escape_attr(&account.id),
                escape_attr(&account.created_at),
                escape_html(&account.created_at),
                escape_attr(&account.updated_at),
                escape_html(&account.updated_at),
            )
        })
        .collect::<String>();

    let empty_accounts = if accounts.is_empty() {
        r#"<p class="empty">No database accounts are configured yet. The crawler will keep using env fallback credentials until an enabled account is saved here.</p>"#
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
      :root {{
        color-scheme: light;
        --bg: #f4f6f5;
        --fg: #18201f;
        --muted: #64706d;
        --line: #d7ddda;
        --panel: #ffffff;
        --accent: #007c6f;
        --danger: #b42318;
        --focus: #f2c94c;
      }}
      * {{ box-sizing: border-box; }}
      body {{
        margin: 0;
        background: var(--bg);
        color: var(--fg);
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }}
      main {{
        width: min(1040px, calc(100vw - 32px));
        margin: 32px auto;
      }}
      header {{
        display: flex;
        align-items: end;
        justify-content: space-between;
        gap: 20px;
        margin-bottom: 18px;
      }}
      h1 {{
        margin: 0;
        font-size: 26px;
        line-height: 1.2;
      }}
      h2 {{
        margin: 0 0 12px;
        font-size: 18px;
        line-height: 1.3;
      }}
      a {{
        color: var(--accent);
        text-decoration: none;
      }}
      a:hover {{ text-decoration: underline; }}
      section + section {{ margin-top: 28px; }}
      .meta {{
        color: var(--muted);
        font-size: 14px;
        text-align: right;
      }}
      .notice, .empty {{
        margin: 0 0 14px;
        padding: 12px 14px;
        border: 1px solid var(--line);
        background: var(--panel);
      }}
      .notice {{
        border-color: #96d4c8;
        background: #ebfaf6;
        color: #075e52;
      }}
      .account-row, .new-account {{
        border: 1px solid var(--line);
        background: var(--panel);
        padding: 14px;
      }}
      .account-row + .account-row {{
        margin-top: 10px;
      }}
      .account-form, .new-account {{
        display: grid;
        grid-template-columns: minmax(150px, 1fr) minmax(180px, 1.2fr) minmax(180px, 1.2fr) auto auto;
        gap: 12px;
        align-items: end;
      }}
      label {{
        display: grid;
        gap: 6px;
        color: var(--muted);
        font-size: 12px;
        text-transform: uppercase;
      }}
      input {{
        width: 100%;
        min-height: 38px;
        border: 1px solid var(--line);
        border-radius: 4px;
        padding: 7px 9px;
        background: #fff;
        color: var(--fg);
        font: inherit;
      }}
      input[readonly] {{
        background: #f8f9f9;
        color: var(--muted);
      }}
      input:focus {{
        outline: 2px solid var(--focus);
        outline-offset: 1px;
      }}
      .check {{
        display: flex;
        align-items: center;
        gap: 8px;
        min-height: 38px;
        padding-bottom: 1px;
        color: var(--fg);
        font-size: 14px;
        text-transform: none;
      }}
      .check input {{
        width: 18px;
        min-height: 18px;
      }}
      button {{
        min-height: 38px;
        border: 1px solid var(--accent);
        border-radius: 4px;
        padding: 7px 14px;
        background: var(--accent);
        color: #fff;
        font: inherit;
        cursor: pointer;
      }}
      button:hover {{
        filter: brightness(0.95);
      }}
      .danger {{
        margin-top: 10px;
        border-color: var(--danger);
        background: #fff;
        color: var(--danger);
      }}
      .row-meta {{
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        margin-top: 10px;
        color: var(--muted);
        font-size: 12px;
      }}
      @media (max-width: 860px) {{
        header {{ display: block; }}
        .meta {{
          margin-top: 8px;
          text-align: left;
        }}
        .account-form, .new-account {{
          grid-template-columns: 1fr;
        }}
        button {{
          width: 100%;
        }}
      }}
    </style>
  </head>
  <body>
    <main>
      <header>
        <div>
          <h1>zFrontier Configuration</h1>
        </div>
        <div class="meta">
          <div>{} configured accounts</div>
          <div><a href="/">View report</a></div>
        </div>
      </header>
      {}
      <section>
        <h2>Accounts</h2>
        {}
        {}
      </section>
      <section>
        <h2>Add Account</h2>
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
          <button type="submit">Add</button>
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
        accounts.len(),
        notice,
        empty_accounts,
        account_rows,
    ))
}

fn render_report(db_path: &Path) -> rusqlite::Result<String> {
    let records = load_records(db_path)?;
    let sign_ins = load_sign_ins(db_path)?;
    let accounts = load_accounts(db_path)?;
    let account_count = unique_account_count(&records, &sign_ins, &accounts);
    let generated_at = sqlite_now(db_path).unwrap_or_else(|_| "now".to_string());
    let rows = records
        .iter()
        .enumerate()
        .map(|(index, record)| {
            format!(
                r#"
          <tr>
            <td>{}</td>
            <td><code>{}</code></td>
            <td><a href="{}" target="_blank" rel="noreferrer">{}</a></td>
            <td><time datetime="{}" data-local-datetime>{}</time></td>
            <td><code>{}</code></td>
          </tr>"#,
                index + 1,
                escape_html(&record.account_id),
                escape_attr(&record.url),
                escape_html(&record.title),
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
          <tr>
            <td>{}</td>
            <td><code>{}</code></td>
            <td><code>{}</code></td>
            <td><time datetime="{}" data-local-datetime>{}</time></td>
            <td>{}</td>
            <td>{}</td>
          </tr>"#,
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
        r#"<p class="empty">No engaged lotteries have been recorded yet.</p>"#
    } else {
        ""
    };

    let sign_in_empty = if sign_ins.is_empty() {
        r#"<p class="empty">No daily sign-ins have been recorded yet.</p>"#
    } else {
        ""
    };

    let table = if records.is_empty() {
        String::new()
    } else {
        format!(
            r#"<table class="lottery-table" data-paginated-table data-page-size="20">
        <thead>
          <tr>
            <th>#</th>
            <th>Account</th>
            <th>Title</th>
            <th>Engaged Date</th>
            <th>Post ID</th>
          </tr>
        </thead>
        <tbody>{rows}
        </tbody>
      </table>
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
            r#"<table data-paginated-table data-page-size="20">
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
      :root {{
        color-scheme: light;
        --bg: #f6f7f8;
        --fg: #1d252c;
        --muted: #66727d;
        --line: #d9dee3;
        --panel: #ffffff;
        --accent: #008879;
      }}
      * {{ box-sizing: border-box; }}
      body {{
        margin: 0;
        background: var(--bg);
        color: var(--fg);
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }}
      main {{
        width: min(1120px, calc(100vw - 32px));
        margin: 32px auto;
      }}
      header {{
        display: flex;
        align-items: end;
        justify-content: space-between;
        gap: 24px;
        margin-bottom: 18px;
      }}
      h1 {{
        margin: 0;
        font-size: 26px;
        line-height: 1.2;
      }}
      .header-copy {{
        display: grid;
        gap: 10px;
      }}
      .page-nav {{
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }}
      .page-nav a {{
        display: inline-flex;
        align-items: center;
        min-height: 32px;
        padding: 5px 10px;
        border: 1px solid var(--line);
        background: var(--panel);
        color: var(--fg);
        font-size: 14px;
      }}
      .page-nav a[aria-current="page"] {{
        border-color: var(--accent);
        color: var(--accent);
      }}
      section + section {{
        margin-top: 28px;
      }}
      h2 {{
        margin: 0 0 12px;
        font-size: 18px;
        line-height: 1.3;
      }}
      .meta {{
        color: var(--muted);
        font-size: 14px;
        text-align: right;
      }}
      .empty {{
        margin: 0;
        padding: 18px;
        border: 1px solid var(--line);
        background: var(--panel);
      }}
      [hidden] {{
        display: none !important;
      }}
      table {{
        width: 100%;
        border-collapse: collapse;
        background: var(--panel);
        border: 1px solid var(--line);
      }}
      th, td {{
        padding: 12px 14px;
        border-bottom: 1px solid var(--line);
        text-align: left;
        vertical-align: top;
      }}
      th {{
        color: var(--muted);
        font-size: 12px;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        background: #fbfcfd;
      }}
      tr:last-child td {{ border-bottom: 0; }}
      a {{
        color: var(--accent);
        text-decoration: none;
      }}
      a:hover {{ text-decoration: underline; }}
      code {{
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 12px;
        color: var(--muted);
      }}
      .pagination {{
        display: flex;
        justify-content: flex-end;
        align-items: center;
        gap: 10px;
        margin-top: 10px;
        color: var(--muted);
        font-size: 14px;
      }}
      .pagination button {{
        min-width: 72px;
        padding: 6px 10px;
        border: 1px solid var(--line);
        border-radius: 4px;
        background: var(--panel);
        color: var(--fg);
        font: inherit;
        cursor: pointer;
      }}
      .pagination button:hover:not(:disabled) {{
        border-color: var(--accent);
        color: var(--accent);
      }}
      .pagination button:disabled {{
        cursor: not-allowed;
        opacity: 0.45;
      }}
      @media (max-width: 720px) {{
        header {{ display: block; }}
        .meta {{
          margin-top: 8px;
          text-align: left;
        }}
        .lottery-table th:nth-child(5), .lottery-table td:nth-child(5) {{ display: none; }}
      }}
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
          <div>{} accounts</div>
          <div>{} lotteries</div>
          <div>{} sign-ins</div>
          <div>Generated <time datetime="{}" data-local-datetime>{}</time></div>
        </div>
      </header>
      <section>
        <h2>Engaged Lotteries</h2>
        {}
        {}
      </section>
      <section>
        <h2>Daily Sign-ins</h2>
        {}
        {}
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

        document.querySelectorAll('table[data-paginated-table]').forEach((table) => {{
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

          const renderPage = () => {{
            const start = page * pageSize;
            const end = Math.min(start + pageSize, rows.length);
            rows.forEach((row, index) => {{
              row.hidden = index < start || index >= end;
            }});
            previous.disabled = page === 0;
            next.disabled = page >= pageCount - 1;
            status.textContent = `${{start + 1}}-${{end}} of ${{rows.length}}`;
          }};

          previous.addEventListener('click', () => {{
            if (page === 0) return;
            page -= 1;
            renderPage();
          }});
          next.addEventListener('click', () => {{
            if (page >= pageCount - 1) return;
            page += 1;
            renderPage();
          }});

          controls.hidden = false;
          renderPage();
        }});
      }})();
    </script>
  </body>
</html>
"#,
        account_count,
        records.len(),
        sign_ins.len(),
        escape_attr(&generated_at),
        escape_html(&generated_at),
        empty,
        table,
        sign_in_empty,
        sign_in_table
    ))
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
