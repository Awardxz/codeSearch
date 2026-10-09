//! Persistent index storage (SQLite).
//!
//! The search itself stays in memory — brute-force cosine over L2-normalized
//! vectors needs every vector resident anyway — but the vectors, chunk texts
//! and file metadata now survive restarts in a SQLite database under the
//! app-data directory. On launch the frontend loads the snapshot back into
//! the in-memory store, so a restart no longer means re-embedding everything.
//!
//! Staleness is handled by the existing size + mtime check: the snapshot
//! stores both per file, and the indexer skips rows that still match. A
//! snapshot written by a different model (dimension or model id mismatch) is
//! discarded on load rather than silently searched with wrong vectors.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

use crate::commands::CommandError;

/// Database file, relative to the Tauri app-data directory.
const DB_DIR_NAME: &str = "index";
const DB_FILE_NAME: &str = "v1.db";

/// Schema version. Bumped when the table layout changes; a mismatch wipes
/// and recreates the database rather than migrating half-understood rows.
const SCHEMA_VERSION: i64 = 1;

fn db_path(app: &AppHandle) -> Result<PathBuf, CommandError> {
    let mut dir = app.path().app_data_dir().map_err(|_| {
        CommandError::ExtractionFailed("The app data directory is unavailable.".to_string())
    })?;
    dir.push(DB_DIR_NAME);
    std::fs::create_dir_all(&dir).map_err(CommandError::from)?;
    dir.push(DB_FILE_NAME);
    Ok(dir)
}

fn open_db(app: &AppHandle) -> Result<Connection, CommandError> {
    let path = db_path(app)?;
    let conn = Connection::open(&path).map_err(|err| {
        CommandError::ExtractionFailed(format!("The index database could not be opened: {err}"))
    })?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA synchronous=NORMAL;",
    )
    .map_err(|err| {
        CommandError::ExtractionFailed(format!("The index database pragmas failed: {err}"))
    })?;
    ensure_schema(&conn)?;
    Ok(conn)
}

fn ensure_schema(conn: &Connection) -> Result<(), CommandError> {
    // The version table itself is created unconditionally, so the version
    // lookup below can only fail on a genuinely broken database.
    conn.execute_batch("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);")
        .map_err(|err| {
            CommandError::ExtractionFailed(format!(
                "The index schema version table failed: {err}"
            ))
        })?;

    let version: Option<i64> = conn
        .query_row(
            "SELECT version FROM schema_version ORDER BY version DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| {
            CommandError::ExtractionFailed(format!("The index schema could not be read: {err}"))
        })?;

    if version == Some(SCHEMA_VERSION) {
        return Ok(());
    }

    conn.execute_batch(
        "DROP TABLE IF EXISTS chunks;
         DROP TABLE IF EXISTS files;
         DROP TABLE IF EXISTS meta;
         DROP TABLE IF EXISTS schema_version;
         CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
         CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
         CREATE TABLE files (
             path TEXT PRIMARY KEY,
             name TEXT NOT NULL,
             extension TEXT NOT NULL DEFAULT '',
             kind TEXT NOT NULL DEFAULT 'text',
             size_bytes INTEGER NOT NULL DEFAULT 0,
             modified_ms INTEGER NULL,
             indexed_at INTEGER NOT NULL
         );
         CREATE TABLE chunks (
             path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
             chunk_index INTEGER NOT NULL,
             text TEXT NOT NULL,
             line_start INTEGER NULL,
             line_end INTEGER NULL,
             embedding BLOB NOT NULL,
             PRIMARY KEY (path, chunk_index)
         );
         CREATE INDEX idx_chunks_path ON chunks(path);",
    )
    .map_err(|err| {
        CommandError::ExtractionFailed(format!("The index schema could not be created: {err}"))
    })?;

    conn.execute("INSERT INTO schema_version (version) VALUES (?1)", [SCHEMA_VERSION])
        .map_err(|err| {
            CommandError::ExtractionFailed(format!(
                "The index schema version could not be recorded: {err}"
            ))
        })?;
    Ok(())
}

fn stored_meta(conn: &Connection, key: &str) -> Result<Option<String>, CommandError> {
    conn.query_row("SELECT value FROM meta WHERE key = ?1", [key], |row| {
        row.get(0)
    })
    .optional()
    .map_err(|err| {
        CommandError::ExtractionFailed(format!("The index metadata could not be read: {err}"))
    })
}

/// One chunk as it crosses the IPC bridge. The embedding travels as base64 of
/// little-endian f32 bytes — the same layout a frontend Float32Array holds on
/// every platform this app ships on (x86-64, ARM64).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedChunk {
    pub text: String,
    pub line_start: Option<u32>,
    pub line_end: Option<u32>,
    pub embedding_b64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedFile {
    pub path: String,
    pub name: String,
    pub extension: String,
    pub kind: String,
    pub size_bytes: u64,
    pub modified_ms: Option<u64>,
    pub indexed_at: u64,
    pub chunks: Vec<PersistedChunk>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedSnapshot {
    pub model_id: Option<String>,
    pub embedding_dim: Option<u32>,
    pub files: Vec<PersistedFile>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistStats {
    pub path: String,
    pub files: u64,
    pub chunks: u64,
    /// On-disk size in bytes (page_count * page_size).
    pub bytes: u64,
}

fn decode_embedding(b64: &str, expected_dim: u32) -> Result<Vec<u8>, CommandError> {
    let bytes = BASE64.decode(b64.trim()).map_err(|_| {
        CommandError::ExtractionFailed("A stored embedding is not valid base64.".to_string())
    })?;
    if bytes.len() % 4 != 0 {
        return Err(CommandError::ExtractionFailed(
            "A stored embedding is not a whole number of f32 values.".to_string(),
        ));
    }
    if bytes.len() / 4 != expected_dim as usize {
        return Err(CommandError::ExtractionFailed(format!(
            "A stored embedding has {} dimensions, expected {}.",
            bytes.len() / 4,
            expected_dim
        )));
    }
    Ok(bytes)
}

/// Insert or replace a batch of indexed files.
///
/// When the incoming model id or dimension differs from what is stored, the
/// whole snapshot is wiped first: vectors from another model must never be
/// searched alongside (or instead of) current ones.
#[tauri::command]
pub fn persist_index_upsert(
    app: AppHandle,
    model_id: String,
    embedding_dim: u32,
    files: Vec<PersistedFile>,
) -> Result<u64, CommandError> {
    if embedding_dim == 0 {
        return Err(CommandError::ExtractionFailed(
            "Cannot persist an index with zero embedding dimensions.".to_string(),
        ));
    }

    // Decode outside the transaction so a corrupt payload fails fast without
    // touching the database.
    let mut decoded: Vec<(&PersistedFile, Vec<Vec<u8>>)> = Vec::with_capacity(files.len());
    for file in &files {
        let mut blobs = Vec::with_capacity(file.chunks.len());
        for chunk in &file.chunks {
            blobs.push(decode_embedding(&chunk.embedding_b64, embedding_dim)?);
        }
        decoded.push((file, blobs));
    }

    let mut conn = open_db(&app)?;
    let tx = conn.transaction().map_err(|err| {
        CommandError::ExtractionFailed(format!("The index transaction failed: {err}"))
    })?;

    let stored_model = tx
        .query_row("SELECT value FROM meta WHERE key = 'model_id'", [], |row| {
            row.get::<_, String>(0)
        })
        .optional()
        .map_err(|err| {
            CommandError::ExtractionFailed(format!(
                "The index metadata could not be read: {err}"
            ))
        })?;
    let stored_dim: Option<u32> = tx
        .query_row(
            "SELECT value FROM meta WHERE key = 'embedding_dim'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|err| {
            CommandError::ExtractionFailed(format!(
                "The index metadata could not be read: {err}"
            ))
        })?
        .and_then(|value| value.parse().ok());

    let replaced = stored_model.as_deref() != Some(model_id.as_str())
        || stored_dim != Some(embedding_dim);
    if replaced {
        tx.execute_batch("DELETE FROM chunks; DELETE FROM files;")
            .map_err(|err| {
                CommandError::ExtractionFailed(format!(
                    "The stale index could not be cleared: {err}"
                ))
            })?;
        tx.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES ('model_id', ?1)",
            [&model_id],
        )
        .map_err(|err| {
            CommandError::ExtractionFailed(format!("The index metadata failed: {err}"))
        })?;
        tx.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES ('embedding_dim', ?1)",
            [embedding_dim.to_string()],
        )
        .map_err(|err| {
            CommandError::ExtractionFailed(format!("The index metadata failed: {err}"))
        })?;
    }

    let mut upserted: u64 = 0;
    for (file, blobs) in &decoded {
        tx.execute(
            "INSERT OR REPLACE INTO files
             (path, name, extension, kind, size_bytes, modified_ms, indexed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                file.path,
                file.name,
                file.extension,
                file.kind,
                file.size_bytes as i64,
                file.modified_ms.map(|ms| ms as i64),
                file.indexed_at as i64,
            ],
        )
        .map_err(|err| {
            CommandError::ExtractionFailed(format!("A file row could not be stored: {err}"))
        })?;
        tx.execute("DELETE FROM chunks WHERE path = ?1", [&file.path])
            .map_err(|err| {
                CommandError::ExtractionFailed(format!(
                    "Stale chunks could not be cleared: {err}"
                ))
            })?;
        for (index, chunk) in file.chunks.iter().enumerate() {
            tx.execute(
                "INSERT INTO chunks
                 (path, chunk_index, text, line_start, line_end, embedding)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    file.path,
                    index as i64,
                    chunk.text,
                    chunk.line_start.map(|line| line as i64),
                    chunk.line_end.map(|line| line as i64),
                    blobs[index],
                ],
            )
            .map_err(|err| {
                CommandError::ExtractionFailed(format!("A chunk could not be stored: {err}"))
            })?;
        }
        upserted += 1;
    }

    tx.commit().map_err(|err| {
        CommandError::ExtractionFailed(format!("The index could not be committed: {err}"))
    })?;
    Ok(upserted)
}

/// Remove persisted rows for paths that left the index.
#[tauri::command]
pub fn persist_index_remove(app: AppHandle, paths: Vec<String>) -> Result<u64, CommandError> {
    if paths.is_empty() {
        return Ok(0);
    }
    let conn = open_db(&app)?;
    let mut removed: u64 = 0;
    for path in &paths {
        removed += conn
            .execute("DELETE FROM files WHERE path = ?1", [path])
            .map_err(|err| {
                CommandError::ExtractionFailed(format!("An index row could not be removed: {err}"))
            })? as u64;
        // chunks has no ON DELETE CASCADE guarantee without `PRAGMA
        // foreign_keys = ON`, so delete explicitly.
        conn.execute("DELETE FROM chunks WHERE path = ?1", [path])
            .map_err(|err| {
                CommandError::ExtractionFailed(format!("Index chunks could not be removed: {err}"))
            })?;
    }
    Ok(removed)
}

/// Drop the whole persisted snapshot (model metadata included).
#[tauri::command]
pub fn persist_index_clear(app: AppHandle) -> Result<(), CommandError> {
    let conn = open_db(&app)?;
    conn.execute_batch("DELETE FROM chunks; DELETE FROM files; DELETE FROM meta;")
        .map_err(|err| {
            CommandError::ExtractionFailed(format!("The index could not be cleared: {err}"))
        })?;
    Ok(())
}

/// Load the full snapshot. Embeddings come back as base64 little-endian f32,
/// mirroring the upsert format.
#[tauri::command]
pub fn persist_index_load(app: AppHandle) -> Result<PersistedSnapshot, CommandError> {
    let conn = open_db(&app)?;
    let model_id = stored_meta(&conn, "model_id")?;
    let embedding_dim: Option<u32> = stored_meta(&conn, "embedding_dim")?
        .and_then(|value| value.parse().ok());

    let mut file_stmt = conn
        .prepare(
            "SELECT path, name, extension, kind, size_bytes, modified_ms, indexed_at
             FROM files ORDER BY path",
        )
        .map_err(|err| {
            CommandError::ExtractionFailed(format!("Index files could not be listed: {err}"))
        })?;
    let file_rows: Vec<(String, String, String, String, i64, Option<i64>, i64)> = file_stmt
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
            ))
        })
        .map_err(|err| {
            CommandError::ExtractionFailed(format!("Index files could not be listed: {err}"))
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| {
            CommandError::ExtractionFailed(format!("Index files could not be read: {err}"))
        })?;

    let mut chunk_stmt = conn
        .prepare(
            "SELECT text, line_start, line_end, embedding
             FROM chunks WHERE path = ?1 ORDER BY chunk_index",
        )
        .map_err(|err| {
            CommandError::ExtractionFailed(format!("Index chunks could not be listed: {err}"))
        })?;

    let mut files = Vec::with_capacity(file_rows.len());
    for (path, name, extension, kind, size_bytes, modified_ms, indexed_at) in file_rows {
        let chunk_rows = chunk_stmt
            .query_map([&path], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                    row.get::<_, Vec<u8>>(3)?,
                ))
            })
            .map_err(|err| {
                CommandError::ExtractionFailed(format!("Index chunks could not be read: {err}"))
            })?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| {
                CommandError::ExtractionFailed(format!("Index chunks could not be read: {err}"))
            })?;

        let chunks = chunk_rows
            .into_iter()
            .map(|(text, line_start, line_end, embedding)| PersistedChunk {
                text,
                line_start: line_start.and_then(|line| u32::try_from(line).ok()),
                line_end: line_end.and_then(|line| u32::try_from(line).ok()),
                embedding_b64: BASE64.encode(&embedding),
            })
            .collect();

        files.push(PersistedFile {
            path,
            name,
            extension,
            kind,
            size_bytes: u64::try_from(size_bytes).unwrap_or(0),
            modified_ms: modified_ms.and_then(|ms| u64::try_from(ms).ok()),
            indexed_at: u64::try_from(indexed_at).unwrap_or(0),
            chunks,
        });
    }

    Ok(PersistedSnapshot {
        model_id,
        embedding_dim,
        files,
    })
}

/// Row counts plus the on-disk size, for the Settings storage readout.
#[tauri::command]
pub fn persist_index_stats(app: AppHandle) -> Result<PersistStats, CommandError> {
    let conn = open_db(&app)?;
    let files: u64 = conn
        .query_row("SELECT COUNT(*) FROM files", [], |row| row.get(0))
        .map_err(|err| {
            CommandError::ExtractionFailed(format!("Index stats failed: {err}"))
        })?;
    let chunks: u64 = conn
        .query_row("SELECT COUNT(*) FROM chunks", [], |row| row.get(0))
        .map_err(|err| {
            CommandError::ExtractionFailed(format!("Index stats failed: {err}"))
        })?;
    let page_count: u64 = conn
        .query_row("PRAGMA page_count", [], |row| row.get(0))
        .map_err(|err| {
            CommandError::ExtractionFailed(format!("Index stats failed: {err}"))
        })?;
    let page_size: u64 = conn
        .query_row("PRAGMA page_size", [], |row| row.get(0))
        .map_err(|err| {
            CommandError::ExtractionFailed(format!("Index stats failed: {err}"))
        })?;
    Ok(PersistStats {
        path: db_path(&app)?
            .to_string_lossy()
            .into_owned(),
        files,
        chunks,
        bytes: page_count.saturating_mul(page_size),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    /// A throwaway app-data root per test so tests can run in parallel.
    /// `AppHandle` cannot be fabricated in unit tests, so the database helpers
    /// are exercised through `open_memory_db` below instead of the commands.
    fn unique_dir() -> PathBuf {
        let id = COUNTER.fetch_add(1, Ordering::SeqCst);
        let mut dir = std::env::temp_dir();
        dir.push(format!(
            "codesearch-persist-test-{}-{}",
            std::process::id(),
            id
        ));
        std::fs::create_dir_all(&dir).expect("test dir");
        dir
    }

    /// Same open + schema path as `open_db`, but rooted at an explicit
    /// directory so tests do not need an `AppHandle`.
    fn open_memory_db(dir: &std::path::Path) -> Connection {
        let path = dir.join("v1.db");
        let conn = Connection::open(&path).expect("open");
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")
            .expect("pragmas");
        ensure_schema(&conn).expect("schema");
        conn
    }

    fn sample_embedding(dim: u32) -> Vec<u8> {
        (0..dim)
            .flat_map(|i| (i as f32 * 0.5).to_le_bytes())
            .collect()
    }

    #[test]
    fn schema_is_idempotent() {
        let dir = unique_dir();
        let conn = open_memory_db(&dir);
        ensure_schema(&conn).expect("second ensure");
        let version: i64 = conn
            .query_row("SELECT version FROM schema_version LIMIT 1", [], |row| {
                row.get(0)
            })
            .expect("version");
        assert_eq!(version, SCHEMA_VERSION);
    }

    #[test]
    fn embedding_decode_validates_dimensions() {
        let bytes = sample_embedding(4);
        let b64 = BASE64.encode(&bytes);
        assert!(decode_embedding(&b64, 4).is_ok());
        assert!(decode_embedding(&b64, 8).is_err());
        assert!(decode_embedding("!!!not-base64!!!", 4).is_err());
    }

    #[test]
    fn file_and_chunk_crud_round_trips() {
        let dir = unique_dir();
        let conn = open_memory_db(&dir);
        let embedding = sample_embedding(4);

        conn.execute(
            "INSERT INTO files (path, name, extension, kind, size_bytes, modified_ms, indexed_at)
             VALUES (?1, 'a.ts', 'ts', 'code', 10, 99, 7)",
            ["C:/proj/a.ts"],
        )
        .expect("insert file");
        conn.execute(
            "INSERT INTO chunks (path, chunk_index, text, line_start, line_end, embedding)
             VALUES (?1, 0, 'hello', 1, 2, ?2)",
            rusqlite::params!["C:/proj/a.ts", embedding],
        )
        .expect("insert chunk");

        let text: String = conn
            .query_row(
                "SELECT text FROM chunks WHERE path = ?1",
                ["C:/proj/a.ts"],
                |row| row.get(0),
            )
            .expect("read chunk");
        assert_eq!(text, "hello");

        let back: Vec<u8> = conn
            .query_row(
                "SELECT embedding FROM chunks WHERE path = ?1",
                ["C:/proj/a.ts"],
                |row| row.get(0),
            )
            .expect("read embedding");
        assert_eq!(back, embedding);

        conn.execute("DELETE FROM files WHERE path = ?1", ["C:/proj/a.ts"])
            .expect("delete file");
        conn.execute("DELETE FROM chunks WHERE path = ?1", ["C:/proj/a.ts"])
            .expect("delete chunks");
        let remaining: u64 = conn
            .query_row("SELECT COUNT(*) FROM files", [], |row| row.get(0))
            .expect("count");
        assert_eq!(remaining, 0);
    }

    #[test]
    fn meta_round_trips() {
        let dir = unique_dir();
        let conn = open_memory_db(&dir);
        conn.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES ('model_id', 'm')",
            [],
        )
        .expect("meta");
        assert_eq!(
            stored_meta(&conn, "model_id").expect("read"),
            Some("m".to_string())
        );
        assert_eq!(stored_meta(&conn, "missing").expect("read"), None);
    }
}
