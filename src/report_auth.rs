use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};
use std::io;
use std::path::Path;

use crate::{base64_encode, header_value};

const COOKIE_NAME: &str = "zf_report_session";
// Renew on every authenticated request, within browsers' 400-day cookie limit.
const SESSION_MAX_AGE: i64 = 400 * 24 * 60 * 60;

#[derive(Debug)]
pub(crate) struct ReportAuth {
    expected_header: String,
    credential_hash: String,
}

impl ReportAuth {
    pub(crate) fn new(user: &str, password: &str) -> Self {
        let expected_header = format!(
            "Basic {}",
            base64_encode(format!("{user}:{password}").as_bytes())
        );
        Self {
            credential_hash: hash(&expected_header),
            expected_header,
        }
    }

    pub(crate) fn authenticate(&self, headers: &str, db_path: &Path) -> io::Result<Option<String>> {
        let conn = Connection::open(db_path).map_err(io_error)?;
        if let Some(token) = session_cookie(headers) {
            // Keep only a hash of the bearer token in SQLite. The credential hash
            // makes a saved session invalid as soon as configured credentials change.
            let renewed = conn
                .execute(
                    "UPDATE report_auth_sessions SET expires_at = unixepoch() + ?1
                     WHERE token_hash = ?2 AND credential_hash = ?3 AND expires_at > unixepoch()",
                    params![SESSION_MAX_AGE, hash(token), self.credential_hash],
                )
                .map_err(io_error)?;
            if renewed == 1 {
                return Ok(Some(token.to_string()));
            }
        }

        if header_value(headers, "Authorization") != Some(self.expected_header.as_str()) {
            return Ok(None);
        }

        self.create_session(&conn).map(Some)
    }

    pub(crate) fn login(
        &self,
        user: &str,
        password: &str,
        db_path: &Path,
    ) -> io::Result<Option<String>> {
        let header = format!(
            "Basic {}",
            base64_encode(format!("{user}:{password}").as_bytes())
        );
        if header != self.expected_header {
            return Ok(None);
        }
        let conn = Connection::open(db_path).map_err(io_error)?;
        self.create_session(&conn).map(Some)
    }

    fn create_session(&self, conn: &Connection) -> io::Result<String> {
        let mut random = [0_u8; 32];
        getrandom::fill(&mut random).map_err(io_error)?;
        let token = base64_encode(&random);
        conn.execute(
            "DELETE FROM report_auth_sessions WHERE expires_at <= unixepoch()",
            [],
        )
        .map_err(io_error)?;
        conn.execute(
            "INSERT INTO report_auth_sessions (token_hash, credential_hash, expires_at)
             VALUES (?1, ?2, unixepoch() + ?3)",
            params![hash(&token), self.credential_hash, SESSION_MAX_AGE],
        )
        .map_err(io_error)?;
        Ok(token)
    }
}

pub(crate) fn initialize(db_path: &Path, auth: Option<&ReportAuth>) -> rusqlite::Result<()> {
    let conn = Connection::open(db_path)?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS report_auth_sessions (
            token_hash TEXT PRIMARY KEY,
            credential_hash TEXT NOT NULL,
            expires_at INTEGER NOT NULL
        );",
    )?;
    // Remove old sessions on startup, including when authentication is disabled.
    // Restoring an old password must not revive previously revoked sessions.
    conn.execute(
        "DELETE FROM report_auth_sessions WHERE credential_hash != ?1 OR expires_at <= unixepoch()",
        params![auth.map(|auth| auth.credential_hash.as_str()).unwrap_or("")],
    )?;
    Ok(())
}

pub(crate) fn cookie_header(headers: &str, token: &str) -> String {
    // The server listens over HTTP; HTTPS is terminated by the reverse proxy.
    let secure = header_value(headers, "X-Forwarded-Proto")
        .and_then(|value| value.split(',').next())
        .is_some_and(|proto| proto.trim().eq_ignore_ascii_case("https"));
    format!(
        "Set-Cookie: {COOKIE_NAME}={token}; Path=/; Max-Age={SESSION_MAX_AGE}; HttpOnly; SameSite=Lax{}\r\n",
        if secure { "; Secure" } else { "" }
    )
}

fn session_cookie(headers: &str) -> Option<&str> {
    header_value(headers, "Cookie")?
        .split(';')
        .filter_map(|cookie| cookie.trim().split_once('='))
        .find_map(|(name, value)| (name == COOKIE_NAME).then_some(value))
}

fn hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

fn io_error(error: impl std::fmt::Display) -> io::Error {
    io::Error::other(error.to_string())
}
