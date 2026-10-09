//! Tauri commands for security-sensitive filesystem access.
//!
//! The frontend never receives unrestricted filesystem access. Every file read
//! goes through this module, which validates the extension and enforces a size
//! limit before any content leaves the native side.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// Upper bound for a single text file we are willing to read into memory.
pub const MAX_TEXT_FILE_BYTES: u64 = 10 * 1024 * 1024;

/// Extensions this build can extract as plain text. Mirrors the frontend
/// extractor registry; this list is the security boundary, the frontend list
/// is presentation only.
pub const SUPPORTED_TEXT_EXTENSIONS: &[&str] = &[
    "txt", "md", "markdown", "mdx", "log", "csv", "tsv", "json", "jsonl", "yaml", "yml", "xml",
    "html", "htm", "css", "js", "mjs", "cjs", "jsx", "ts", "tsx", "py", "rs", "java", "c", "h",
    "cpp", "cc", "cxx", "hpp", "hh", "cs", "go", "php", "sql", "sh", "bash", "zsh", "ps1", "psm1",
    "bat", "cmd", "toml", "ini", "cfg", "conf", "env", "gitignore", "dockerfile", "makefile",
    "r", "rb", "swift", "kt", "kts", "scala", "dart", "lua", "pl", "vue", "svelte", "astro",
    "scss", "sass", "less", "graphql", "gql", "proto", "gradle", "properties",
];

/// Error shape returned to the frontend. Serialized as `{ code, message }`
/// matching the frontend `AppErrorCode` union.
#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case", tag = "code", content = "message")]
pub enum CommandError {
    NotFound(String),
    AccessDenied(String),
    UnsupportedFormat(String),
    TooLarge(String),
    ExtractionFailed(String),
}

impl From<std::io::Error> for CommandError {
    fn from(err: std::io::Error) -> Self {
        match err.kind() {
            std::io::ErrorKind::NotFound => {
                CommandError::NotFound("File does not exist.".to_string())
            }
            std::io::ErrorKind::PermissionDenied => CommandError::AccessDenied(
                "Access to the file was denied by the operating system.".to_string(),
            ),
            _ => CommandError::ExtractionFailed(format!(
                "Reading the file failed: {}",
                simplify_io_message(&err)
            )),
        }
    }
}

/// Windows errors can embed the full path; keep messages useful without
/// echoing user paths back into the UI more than necessary.
fn simplify_io_message(err: &std::io::Error) -> String {
    let text = err.to_string();
    match text.find(" (os error") {
        Some(index) => text[..index].to_string(),
        None => text,
    }
}

#[derive(Debug, Serialize)]
pub struct TextFileContent {
    pub path: String,
    pub name: String,
    pub extension: String,
    pub size_bytes: u64,
    pub modified_ms: Option<u64>,
    pub content: String,
}

fn normalized_extension(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
}

fn modified_epoch_ms(metadata: &fs::Metadata) -> Option<u64> {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
}

/// Outcome of a single file in a bulk read: either the contents or the reason
/// it could not be read. One failed file never fails the rest of the batch.
#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum BulkReadOutcome {
    Ok(TextFileContent),
    Err(CommandError),
}

/// Read a media file's raw bytes for the vision and audio encoders.
///
/// Returns an `ArrayBuffer` through Tauri's IPC so the webview receives bytes
/// instead of a JSON array of numbers — the difference between a 500 KB image
/// arriving intact and a several-hundred-kilobyte JSON payload.
///
/// The path is validated exactly as `read_text_file` validates one, with the
/// media extension allowlist and a larger size cap.
#[tauri::command]
pub fn read_media_bytes(path: String) -> Result<tauri::ipc::Response, CommandError> {
    let canonical = validate_media_path(&path)?;
    let bytes = fs::read(&canonical).map_err(CommandError::from)?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Extensions the vision and audio encoders can consume.
const SUPPORTED_MEDIA_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "bmp", "webp", "tif", "tiff", "heic", "svg",
    "ico", "mp3", "wav", "flac", "aac", "ogg", "wma", "m4a", "opus", "mp4",
    "mov", "avi", "mkv", "webm", "wmv", "flv", "m4v",
];

/// Largest media file we will decode. Video is the expensive case; anything
/// larger is reported as skipped rather than stalling the embedding worker.
pub const MAX_MEDIA_BYTES: u64 = 150 * 1024 * 1024;

fn validate_media_path(path: &str) -> Result<PathBuf, CommandError> {
    let input_path = Path::new(path);

    input_path.file_name().and_then(|name| name.to_str()).ok_or_else(|| {
        CommandError::NotFound("The path does not name a file.".to_string())
    })?;

    let canonical = fs::canonicalize(input_path).map_err(CommandError::from)?;
    let metadata = fs::metadata(&canonical).map_err(CommandError::from)?;

    if !metadata.is_file() {
        return Err(CommandError::UnsupportedFormat(
            "The selected path is a directory, not a file.".to_string(),
        ));
    }

    if metadata.len() > MAX_MEDIA_BYTES {
        return Err(CommandError::TooLarge(format!(
            "File is larger than the {} MB media limit.",
            MAX_MEDIA_BYTES / (1024 * 1024)
        )));
    }

    let extension = normalized_extension(&canonical).ok_or_else(|| {
        CommandError::UnsupportedFormat(
            "File has no extension and cannot be classified as media.".to_string(),
        )
    })?;

    if !SUPPORTED_MEDIA_EXTENSIONS.contains(&extension.as_str()) {
        return Err(CommandError::UnsupportedFormat(format!(
            "'{}' files cannot be embedded yet.",
            extension
        )));
    }

    Ok(canonical)
}

/// Read many text files in one call, in parallel.
///
/// Indexing a whole folder one `invoke` per file is dominated by IPC overhead,
/// so bulk indexing reads in batches instead. Every path is still validated
/// exactly as `read_text_file` validates a single path.
#[tauri::command]
pub fn read_text_files_bulk(
    paths: Vec<String>,
) -> Result<Vec<BulkReadOutcome>, CommandError> {
    use rayon::prelude::*;

    Ok(paths
        .par_iter()
        .map(|path| match read_text_file(path.clone()) {
            Ok(content) => BulkReadOutcome::Ok(content),
            Err(error) => BulkReadOutcome::Err(error),
        })
        .collect::<Vec<_>>())
}

/// Read a text-like file after validating extension and size.
///
/// The path is canonicalized to confirm it exists as a regular file, but the
/// original path is returned so the frontend can display and re-open it with
/// the system default application.
#[tauri::command]
pub fn read_text_file(path: String) -> Result<TextFileContent, CommandError> {
    let input_path = Path::new(&path);

    let file_name = input_path
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.to_string())
        .ok_or_else(|| {
            CommandError::NotFound("The path does not name a file.".to_string())
        })?;

    // Canonicalize so we fail fast on missing files and normalize casing,
    // but keep the user's original string for display and opening.
    let canonical = fs::canonicalize(input_path).map_err(CommandError::from)?;
    let metadata = fs::metadata(&canonical).map_err(CommandError::from)?;

    if !metadata.is_file() {
        return Err(CommandError::UnsupportedFormat(
            "The selected path is a directory, not a file.".to_string(),
        ));
    }

    if metadata.len() > MAX_TEXT_FILE_BYTES {
        return Err(CommandError::TooLarge(format!(
            "File is larger than the {} MB text extraction limit.",
            MAX_TEXT_FILE_BYTES / (1024 * 1024)
        )));
    }

    let extension = normalized_extension(&canonical).ok_or_else(|| {
        CommandError::UnsupportedFormat(
            "File has no extension and cannot be classified as text.".to_string(),
        )
    })?;

    if !SUPPORTED_TEXT_EXTENSIONS.contains(&extension.as_str()) {
        return Err(CommandError::UnsupportedFormat(format!(
            "'{}' files are not supported for text extraction yet.",
            extension
        )));
    }

    let bytes = fs::read(&canonical).map_err(CommandError::from)?;

    // Lossy conversion: undecodable bytes become U+FFFD instead of failing
    // the whole file. Binary garbage in a text-named file stays searchable
    // noise but never breaks indexing.
    let content = String::from_utf8_lossy(&bytes).into_owned();

    Ok(TextFileContent {
        path,
        name: file_name,
        extension,
        size_bytes: metadata.len(),
        modified_ms: modified_epoch_ms(&metadata),
        content,
    })
}
