//! Filesystem watcher for continuous index sync.
//!
//! Folder scans are point-in-time; without a watcher the index rots the
//! moment a file is saved. This module keeps a `notify` recursive watcher on
//! the folders the user scanned and forwards raw create/modify/remove events
//! to the frontend (`index://fs-changed`), which coalesces the OS's event
//! chatter — one save is several modify events — and re-indexes only what the
//! coalesced set names.
//!
//! Deliberately thin: filtering (pruned directories, hidden files, supported
//! extensions) lives in the frontend's watch service next to the extension
//! registry it already owns, so there is exactly one place that decides what
//! is indexable.

use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::fs;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

use crate::commands::CommandError;

/// The live watcher, if any. Held in Tauri-managed state: dropping the
/// `RecommendedWatcher` stops all watching, so replacing it is stop-then-start
/// with no extra bookkeeping.
pub struct WatchState(pub Mutex<Option<RecommendedWatcher>>);

impl Default for WatchState {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct FsChangedPayload {
    pub kind: String,
    pub paths: Vec<String>,
}

fn classify_kind(kind: &EventKind) -> &'static str {
    match kind {
        EventKind::Create(_) => "create",
        EventKind::Modify(_) => "modify",
        EventKind::Remove(_) => "remove",
        _ => "other",
    }
}

fn emit_event(app: &AppHandle, event: Event) {
    let paths: Vec<String> = event
        .paths
        .iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect();
    if paths.is_empty() {
        return;
    }
    // Best effort: a failed emit means the frontend went away, which also
    // means nobody needs the event.
    let _ = app.emit(
        "index://fs-changed",
        FsChangedPayload {
            kind: classify_kind(&event.kind).to_string(),
            paths,
        },
    );
}

/// Replace the watched roots. Returns the roots actually being watched
/// (unreadable ones are skipped, never fatal — a deleted folder must not
/// break watching the rest).
#[tauri::command]
pub fn watch_start(
    app: AppHandle,
    state: State<'_, WatchState>,
    paths: Vec<String>,
) -> Result<Vec<String>, CommandError> {
    // Stop first: assigning a new watcher drops the old one.
    *state.0.lock().map_err(|_| {
        CommandError::ExtractionFailed("The watcher state is unavailable.".to_string())
    })? = None;

    let handle = app.clone();
    let mut watcher =
        RecommendedWatcher::new(move |result: Result<Event, notify::Error>| {
            match result {
                Ok(event) => emit_event(&handle, event),
                Err(_) => {
                    // Transient watcher errors (e.g. a file vanishing
                    // mid-event) are routine; the frontend coalesces.
                }
            }
        }, Config::default())
        .map_err(|err| {
            CommandError::ExtractionFailed(format!("File watching could not start: {err}"))
        })?;

    let mut watched = Vec::new();
    for path in &paths {
        match fs::canonicalize(path) {
            Ok(canonical) => {
                if let Err(err) = watcher.watch(&canonical, RecursiveMode::Recursive) {
                    // Skip unreadable roots; keep watching the rest.
                    let _ = err;
                    continue;
                }
                watched.push(canonical.to_string_lossy().into_owned());
            }
            Err(_) => continue,
        }
    }

    *state.0.lock().map_err(|_| {
        CommandError::ExtractionFailed("The watcher state is unavailable.".to_string())
    })? = Some(watcher);

    Ok(watched)
}

/// Stop watching everything.
#[tauri::command]
pub fn watch_stop(state: State<'_, WatchState>) -> Result<(), CommandError> {
    *state.0.lock().map_err(|_| {
        CommandError::ExtractionFailed("The watcher state is unavailable.".to_string())
    })? = None;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn event_kinds_classify() {
        assert_eq!(classify_kind(&EventKind::Create(notify::event::CreateKind::File)), "create");
        assert_eq!(
            classify_kind(&EventKind::Modify(notify::event::ModifyKind::Data(
                notify::event::DataChange::Content
            ))),
            "modify"
        );
        assert_eq!(classify_kind(&EventKind::Remove(notify::event::RemoveKind::File)), "remove");
        assert_eq!(classify_kind(&EventKind::Other), "other");
    }

    #[test]
    fn watcher_reports_created_files() {
        let dir = std::env::temp_dir().join(format!(
            "codesearch-watch-test-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("test dir");
        let target = dir.join("hello.txt");

        let (tx, rx) = mpsc::channel();
        let mut watcher =
            RecommendedWatcher::new(move |result: Result<Event, notify::Error>| {
                if let Ok(event) = result {
                    let _ = tx.send((
                        classify_kind(&event.kind).to_string(),
                        event
                            .paths
                            .iter()
                            .map(|p| p.to_string_lossy().into_owned())
                            .collect::<Vec<_>>(),
                    ));
                }
            }, Config::default())
            .expect("watcher");
        watcher
            .watch(&dir, RecursiveMode::NonRecursive)
            .expect("watch");

        std::fs::write(&target, "hi").expect("write");

        let deadline = Duration::from_secs(10);
        let start = std::time::Instant::now();
        let mut seen = false;
        while start.elapsed() < deadline {
            match rx.recv_timeout(Duration::from_millis(250)) {
                Ok((kind, paths)) => {
                    let mentions = paths.iter().any(|p| p.ends_with("hello.txt"));
                    if mentions && (kind == "create" || kind == "modify") {
                        seen = true;
                        break;
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }

        let _ = std::fs::remove_dir_all(&dir);
        assert!(seen, "expected a create/modify event for hello.txt");
    }
}
