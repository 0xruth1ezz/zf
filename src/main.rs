use rusqlite::{params, Connection};
use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};

#[derive(Debug)]
struct Record {
    post_id: String,
    title: String,
    url: String,
    engaged_at: String,
}

#[derive(Debug)]
struct Config {
    bind_addr: String,
    db_path: PathBuf,
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
                if let Err(error) = handle_client(stream, &config.db_path) {
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
        }
    }
}

fn handle_client(mut stream: TcpStream, db_path: &Path) -> std::io::Result<()> {
    let mut buffer = [0_u8; 4096];
    let bytes_read = stream.read(&mut buffer)?;
    let request = String::from_utf8_lossy(&buffer[..bytes_read]);
    let request_line = request.lines().next().unwrap_or("");
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let path = parts.next().unwrap_or("/");

    match (method, path) {
        ("GET", "/") | ("GET", "/index.html") | ("GET", "/report") => {
            let body = match render_report(db_path) {
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

fn ensure_schema(db_path: &Path) -> rusqlite::Result<()> {
    if let Some(parent) = db_path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    let conn = Connection::open(db_path)?;
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS engaged_lotteries (
          post_id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          url TEXT NOT NULL UNIQUE,
          engaged_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_engaged_lotteries_engaged_at
          ON engaged_lotteries (engaged_at DESC);
        "#,
    )?;
    Ok(())
}

fn load_records(db_path: &Path) -> rusqlite::Result<Vec<Record>> {
    let conn = Connection::open(db_path)?;
    let mut stmt = conn.prepare(
        r#"
        SELECT post_id, title, url, engaged_at
        FROM engaged_lotteries
        ORDER BY engaged_at DESC
        "#,
    )?;

    let records = stmt
        .query_map(params![], |row| {
            Ok(Record {
                post_id: row.get(0)?,
                title: row.get(1)?,
                url: row.get(2)?,
                engaged_at: row.get(3)?,
            })
        })?
        .collect();

    records
}

fn render_report(db_path: &Path) -> rusqlite::Result<String> {
    let records = load_records(db_path)?;
    let generated_at = sqlite_now(db_path).unwrap_or_else(|_| "now".to_string());
    let rows = records
        .iter()
        .enumerate()
        .map(|(index, record)| {
            format!(
                r#"
          <tr>
            <td>{}</td>
            <td><a href="{}" target="_blank" rel="noreferrer">{}</a></td>
            <td><time datetime="{}">{}</time></td>
            <td><code>{}</code></td>
          </tr>"#,
                index + 1,
                escape_attr(&record.url),
                escape_html(&record.title),
                escape_attr(&record.engaged_at),
                escape_html(&record.engaged_at),
                escape_html(&record.post_id),
            )
        })
        .collect::<String>();

    let empty = if records.is_empty() {
        r#"<p class="empty">No engaged lotteries have been recorded yet.</p>"#
    } else {
        ""
    };

    let table = if records.is_empty() {
        String::new()
    } else {
        format!(
            r#"<table>
        <thead>
          <tr>
            <th>#</th>
            <th>Title</th>
            <th>Engaged Date</th>
            <th>Post ID</th>
          </tr>
        </thead>
        <tbody>{rows}
        </tbody>
      </table>"#
        )
    };

    Ok(format!(
        r#"<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>zFrontier Engaged Lotteries</title>
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
      @media (max-width: 720px) {{
        header {{ display: block; }}
        .meta {{
          margin-top: 8px;
          text-align: left;
        }}
        th:nth-child(4), td:nth-child(4) {{ display: none; }}
      }}
    </style>
  </head>
  <body>
    <main>
      <header>
        <div>
          <h1>zFrontier Engaged Lotteries</h1>
        </div>
        <div class="meta">
          <div>{} records</div>
          <div>Generated {}</div>
        </div>
      </header>
      {}
      {}
    </main>
  </body>
</html>
"#,
        records.len(),
        escape_html(&generated_at),
        empty,
        table
    ))
}

fn sqlite_now(db_path: &Path) -> rusqlite::Result<String> {
    let conn = Connection::open(db_path)?;
    conn.query_row("SELECT datetime('now', 'localtime')", params![], |row| {
        row.get(0)
    })
}

fn write_response(
    stream: &mut TcpStream,
    status: &str,
    content_type: &str,
    body: &str,
) -> std::io::Result<()> {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}",
        body.as_bytes().len()
    );
    stream.write_all(response.as_bytes())
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
