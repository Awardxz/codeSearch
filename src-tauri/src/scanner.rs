//! Recursive folder scanning for bulk indexing.
//!
//! One job: walk the folders the user picks and return the files worth
//! indexing, plus counts of everything skipped and why. Skipping happens in
//! Rust because a project tree can contain hundreds of thousands of files, and
//! shipping them all to the webview only to discard them is the single biggest
//! possible cost.
//!
//! The walk is parallel (the same `ignore` crate ripgrep uses) and prunes
//! dependency, cache and OS directories before ever touching their contents.

use crate::commands::{CommandError, SUPPORTED_TEXT_EXTENSIONS};
use ignore::WalkBuilder;
use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

/// Directory names that are never worth walking into. This is the main lever on
/// scan cost: `node_modules`, `.git` and `target` trees account for most of a
/// developer's file count and none of it is worth indexing.
const SKIPPED_DIRECTORIES: &[&str] = &[
    // Version control
    ".git", ".hg", ".svn", ".bzr", "_darcs", // Dependencies / build output
    "node_modules", "bower_components", "jspm_packages", "vendor", "target", "build",
    "dist", "out", "debug", "release", "obj", ".gradle", ".m2", ".nuget", ".cargo",
    ".rustup", ".npm", ".yarn", ".pnpm-store", "__pycache__", ".venv", "venv",
    ".tox", ".mypy_cache", ".pytest_cache", ".next", ".nuxt", ".svelte-kit",
    ".parcel-cache", ".turbo", // Caches / editor state
    ".idea", ".vscode", ".vs", ".settings", ".fleet", ".cache",
    // OS and application data
    "AppData", "Application Data", "Library", "$RECYCLE.BIN",
    "System Volume Information", "Windows", "ProgramData", "Program Files",
    "Program Files (x86)", "Programs", "Recovery", "PerfLogs", ".Trash",
    ".Trash-1000", "lost+found",
];

/// One file the walker decided to index.
#[derive(Debug, Serialize)]
pub struct ScanFile {
    pub path: String,
    pub name: String,
    pub extension: String,
    pub kind: ScanKind,
    pub size_bytes: u64,
    pub modified_ms: Option<u64>,
}

/// How the file will be indexed. Text files embed their contents; media files
/// are embedded through the model's vision and audio encoders.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum ScanKind {
    Text,
    Image,
    Audio,
    Video,
}

/// What happened to files the walker looked at but did not return.
#[derive(Debug, Default, Serialize)]
pub struct ScanSkipped {
    pub unsupported_extension: usize,
    pub binary: usize,
    pub too_large: usize,
    pub hidden: usize,
    pub error: usize,
    pub duplicates: usize,
}

#[derive(Debug, Serialize)]
pub struct ScanResult {
    pub files: Vec<ScanFile>,
    pub skipped: ScanSkipped,
    pub directories_visited: usize,
    /// Wall-clock time of the scan, for the progress UI.
    pub elapsed_ms: u64,
}

/// Walk the given roots and return the files worth indexing.
///
/// Paths that are not directories are ignored, so a caller can pass whatever it
/// has and get back a scan of whatever existed.
#[tauri::command]
pub fn scan_folders(paths: Vec<String>) -> Result<ScanResult, CommandError> {
    let roots: Vec<PathBuf> = paths
        .into_iter()
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
        .collect();

    if roots.is_empty() {
        return Err(CommandError::NotFound(
            "None of the selected folders exist.".to_string(),
        ));
    }

    let started = std::time::Instant::now();

    let results = Mutex::new(Vec::<ScanFile>::new());
    let skipped = Mutex::new(ScanSkipped::default());
    let seen = Mutex::new(HashSet::<String>::new());
    let directories = AtomicUsize::new(0);

    for root in &roots {
        let sink = ScanSink {
            results: &results,
            skipped: &skipped,
            seen: &seen,
            directories: &directories,
        };

        WalkBuilder::new(root)
            .standard_filters(false)
            .hidden(false)
            .follow_links(false)
            .same_file_system(false)
            .threads(walker_threads())
            .build_parallel()
            .run(|| Box::new(|entry| sink.visit(entry)));
    }

    let mut files = results.into_inner().unwrap_or_default();
    let skipped = skipped.into_inner().unwrap_or_default();

    // Deterministic order keeps progress reporting and dedupe stable.
    files.sort_by(|a, b| a.path.cmp(&b.path));

    Ok(ScanResult {
        files,
        skipped,
        directories_visited: directories.load(Ordering::Relaxed),
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

/// Collects entries for one walker thread. Each walker thread gets its own
/// instance, so the shared containers are locked only to merge a whole file.
struct ScanSink<'a> {
    results: &'a Mutex<Vec<ScanFile>>,
    skipped: &'a Mutex<ScanSkipped>,
    seen: &'a Mutex<std::collections::HashSet<String>>,
    directories: &'a AtomicUsize,
}

impl ScanSink<'_> {
    fn visit(&self, entry: Result<ignore::DirEntry, ignore::Error>) -> ignore::WalkState {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => return self.bump_skip(|s| s.error += 1),
        };

        let Some(file_type) = entry.file_type() else {
            return self.bump_skip(|s| s.error += 1);
        };

        let path = entry.path();

        if file_type.is_dir() {
            if is_skipped_directory(path) {
                return ignore::WalkState::Skip;
            }
            self.directories.fetch_add(1, Ordering::Relaxed);
            return ignore::WalkState::Continue;
        }

        if !file_type.is_file() {
            return ignore::WalkState::Continue;
        }

        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            return self.bump_skip(|s| s.error += 1);
        };

        // Hidden FILES are skipped as configuration noise. Hidden DIRECTORIES
        // are not, unless they are pruned above: a project's `.github`,
        // `.config` or `.circleci` trees are legitimately worth searching.
        if name.starts_with('.') {
            return self.bump_skip(|s| s.hidden += 1);
        }

        let path_string = path.to_string_lossy().to_string();

        if let Ok(mut seen) = self.seen.lock() {
            if !seen.insert(path_string.clone()) {
                return self.bump_skip(|s| s.duplicates += 1);
            }
        }

        let extension = normalized_extension(path).unwrap_or_default();

        // Cheap metadata read; a failure here means the entry vanished between
        // the walk and the stat, which is normal and not worth reporting.
        let Ok(metadata) = fs::metadata(path) else {
            return self.bump_skip(|s| s.error += 1);
        };
        let size_bytes = metadata.len();

        if is_text_extension(&extension) {
            if size_bytes > crate::commands::MAX_TEXT_FILE_BYTES {
                return self.bump_skip(|s| s.too_large += 1);
            }

            if let Ok(mut results) = self.results.lock() {
                results.push(ScanFile {
                    path: path_string,
                    name: name.to_string(),
                    extension,
                    kind: ScanKind::Text,
                    size_bytes,
                    modified_ms: modified_epoch_ms(&metadata),
                });
            }
        } else if let Some(kind) = media_kind(&extension) {
            if let Ok(mut results) = self.results.lock() {
                results.push(ScanFile {
                    path: path_string,
                    name: name.to_string(),
                    extension,
                    kind,
                    size_bytes,
                    modified_ms: modified_epoch_ms(&metadata),
                });
            }
        } else {
            return self.bump_skip(|s| {
                if looks_binary(&extension) {
                    s.binary += 1;
                } else {
                    s.unsupported_extension += 1;
                }
            });
        }

        ignore::WalkState::Continue
    }

    fn bump_skip(
        &self,
        apply: impl FnOnce(&mut ScanSkipped),
    ) -> ignore::WalkState {
        if let Ok(mut skipped) = self.skipped.lock() {
            apply(&mut skipped);
        }
        ignore::WalkState::Continue
    }
}

fn is_skipped_directory(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    let lower = name.to_ascii_lowercase();

    SKIPPED_DIRECTORIES
        .iter()
        .any(|skip| skip.eq_ignore_ascii_case(&lower))
}

fn normalized_extension(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
}

fn is_text_extension(extension: &str) -> bool {
    SUPPORTED_TEXT_EXTENSIONS.contains(&extension)
}

/// Classify a media extension into the encoder that will consume it. Video
/// frames run through the vision encoder, but they are filed as video so the
/// UI and frame sampling treat them correctly.
fn media_kind(extension: &str) -> Option<ScanKind> {
    match extension {
        "png" | "jpg" | "jpeg" | "gif" | "bmp" | "webp" | "tif" | "tiff" | "heic"
        | "svg" | "ico" => Some(ScanKind::Image),
        "mp3" | "wav" | "flac" | "aac" | "ogg" | "wma" | "m4a" | "opus" => {
            Some(ScanKind::Audio)
        }
        "mp4" | "mov" | "avi" | "mkv" | "webm" | "wmv" | "flv" | "m4v" => {
            Some(ScanKind::Video)
        }
        _ => None,
    }
}

/// Separate a binary we skipped on purpose from an extension we do not know.
fn looks_binary(extension: &str) -> bool {
    matches!(
        extension,
        "exe" | "dll" | "sys" | "bin" | "dat" | "db" | "sqlite" | "mdb" | "zip"
            | "rar" | "7z" | "tar" | "gz" | "bz2" | "xz" | "iso" | "jar" | "war"
            | "whl" | "msi" | "apk" | "deb" | "rpm" | "woff" | "woff2" | "ttf"
            | "otf" | "eot" | "pdb" | "lib" | "class" | "pyc" | "wasm"
    )
}

fn modified_epoch_ms(metadata: &fs::Metadata) -> Option<u64> {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
}

/// Cap the walker: past a handful of threads this becomes I/O bound and extra
/// threads only add contention.
fn walker_threads() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .min(8)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// A unique temp directory, removed when the test ends.
    struct TempTree {
        root: PathBuf,
    }

    impl TempTree {
        fn new(tag: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "sfs-scan-{tag}-{}-{:?}",
                std::process::id(),
                std::thread::current().id()
            ));
            let _ = fs::remove_dir_all(&root);
            fs::create_dir_all(&root).expect("create temp root");
            Self { root }
        }

        fn path(&self) -> &Path {
            &self.root
        }

        fn join(&self, relative: &str) -> PathBuf {
            self.root.join(relative)
        }

        fn write(&self, relative: &str, contents: &str) {
            let path = self.join(relative);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).expect("create parent");
            }
            fs::File::create(&path)
                .and_then(|mut file| file.write_all(contents.as_bytes()))
                .expect("write file");
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn scan(root: &Path) -> ScanResult {
        scan_folders(vec![root.to_string_lossy().to_string()]).expect("scan succeeds")
    }

    fn scan_paths(paths: Vec<PathBuf>) -> ScanResult {
        scan_folders(paths.iter().map(|p| p.to_string_lossy().to_string()).collect())
            .expect("scan succeeds")
    }

    fn names(result: &ScanResult) -> Vec<&str> {
        result.files.iter().map(|f| f.name.as_str()).collect()
    }

    #[test]
    fn finds_text_files_and_records_metadata() {
        let tree = TempTree::new("text");
        tree.write("a.txt", "hello world\nsecond line\n");
        tree.write("notes/code.rs", "fn main() {}\n");
        tree.write("notes/deep/data.json", "{\"a\": 1}\n");

        let result = scan(tree.path());

        assert_eq!(result.files.len(), 3, "expected all three text files");
        assert!(
            result.files.iter().all(|file| file.kind == ScanKind::Text),
            "text extensions are classified as text"
        );
        let mut found = names(&result);
        found.sort();
        assert_eq!(found, vec!["a.txt", "code.rs", "data.json"]);
        assert!(result.directories_visited >= 2, "root and notes are counted");
        for file in &result.files {
            assert_eq!(file.extension, file.path.rsplit('.').next().unwrap());
        }
    }

    #[test]
    fn result_is_sorted_by_path() {
        let tree = TempTree::new("sorted");
        tree.write("z.txt", "z");
        tree.write("m.txt", "m");
        tree.write("a.txt", "a");

        let result = scan(tree.path());
        let paths: Vec<&String> = result.files.iter().map(|f| &f.path).collect();

        let mut sorted = paths.clone();
        sorted.sort();
        assert_eq!(paths, sorted, "results are deterministic");
    }

    #[test]
    fn a_picked_project_folder_ignores_nested_repos() {
        let tree = TempTree::new("project");
        tree.write("src/main.rs", "fn main() {}");
        tree.write("README.md", "# project");
        tree.write("docs/guide.md", "# guide");
        // Dependency and VCS trees a project folder almost always has.
        tree.write("target/debug/out.txt", "skip");
        tree.write("node_modules/pkg/index.js", "skip");
        tree.write(".git/config", "skip");
        tree.write(".venv/lib/mod.rs", "skip");
        tree.write("dist/bundle.js", "skip");
        tree.write("AppData/cache.txt", "skip");

        let result = scan(tree.path());

        let mut found = names(&result);
        found.sort();
        assert_eq!(
            found,
            vec!["README.md", "guide.md", "main.rs"],
            "only the project's own sources are returned"
        );
    }

    #[test]
    fn pruning_is_case_insensitive_on_windows() {
        let tree = TempTree::new("case");
        tree.write("keep.txt", "keep");
        tree.write("NODE_MODULES/pkg/index.js", "skip");
        tree.write("Target/out.txt", "skip");
        tree.write(".GIT/config", "skip");

        let result = scan(tree.path());
        assert_eq!(
            names(&result),
            vec!["keep.txt"],
            "case variants of pruned names must still prune"
        );
    }

    #[test]
    fn directory_names_without_underscores_are_not_pruned() {
        let tree = TempTree::new("no-underscore");
        tree.write("nodemodules/pkg/index.js", "ordinary folder");
        tree.write("main.txt", "keep");

        let result = scan(tree.path());
        assert_eq!(
            result.files.len(),
            2,
            "'nodemodules' is not 'node_modules' and must not be pruned"
        );
    }

    #[test]
    fn hidden_files_are_counted_not_indexed() {
        let tree = TempTree::new("hidden");
        tree.write("visible.txt", "v");
        tree.write(".env", "SECRET=1");
        // A hidden directory that is not on the prune list: its files are still
        // worth searching, because CI and tool config live there.
        tree.write(".github/workflows/ci.yml", "name: ci");
        tree.write(".git/config", "skip");

        let result = scan(tree.path());

        let mut found = names(&result);
        found.sort();
        assert_eq!(
            found,
            vec!["ci.yml", "visible.txt"],
            "hidden files are skipped, files inside hidden dirs are kept"
        );
        assert_eq!(result.skipped.hidden, 1, "only the hidden file is counted");
    }

    #[test]
    fn media_is_classified_by_modality() {
        let tree = TempTree::new("media");
        tree.write("photo.jpg", "not really a jpeg");
        tree.write("song.mp3", "audio bytes");
        tree.write("clip.mp4", "video bytes");
        tree.write("notes.txt", "text");
        tree.write("frame.png", "png-ish");

        let result = scan(tree.path());

        let mut found: Vec<(&str, ScanKind)> = result
            .files
            .iter()
            .map(|f| (f.name.as_str(), f.kind))
            .collect();
        found.sort();

        assert_eq!(
            found,
            vec![
                ("clip.mp4", ScanKind::Video),
                ("frame.png", ScanKind::Image),
                ("notes.txt", ScanKind::Text),
                ("photo.jpg", ScanKind::Image),
                ("song.mp3", ScanKind::Audio),
            ],
            "each modality is classified into its own encoder"
        );
    }

    #[test]
    fn binaries_and_unknown_archives_are_counted_separately() {
        let tree = TempTree::new("binary");
        tree.write("app.exe", "MZ");
        tree.write("archive.zip", "PK");
        tree.write("weird.qqq", "unknown");
        tree.write("notes.txt", "text");

        let result = scan(tree.path());

        assert_eq!(names(&result), vec!["notes.txt"]);
        assert_eq!(result.skipped.binary, 2, "exe and zip count as binary");
        assert_eq!(
            result.skipped.unsupported_extension, 1,
            "unknown extension counts as unsupported"
        );
    }

    #[test]
    fn files_over_the_size_limit_are_skipped() {
        let tree = TempTree::new("large");
        tree.write("small.txt", "small");
        let big = tree.join("big.txt");
        fs::File::create(&big)
            .and_then(|mut file| file.write_all(&vec![b'x'; 11 * 1024 * 1024]))
            .expect("write big file");

        let result = scan(tree.path());

        assert_eq!(names(&result), vec!["small.txt"]);
        assert_eq!(result.skipped.too_large, 1);
    }

    #[test]
    fn missing_roots_are_an_error() {
        let error = scan_folders(vec!["C:\\definitely\\not\\a\\real\\path".to_string()])
            .err()
            .expect("a missing path should error");

        assert!(matches!(error, CommandError::NotFound(_)), "got {error:?}");
    }

    #[test]
    fn several_roots_are_walked_and_deduplicated() {
        let first = TempTree::new("multi-a");
        let second = TempTree::new("multi-b");
        first.write("a.txt", "a");
        second.write("b.txt", "b");

        let result = scan_paths(vec![first.path().to_path_buf(), second.path().to_path_buf()]);
        let mut found = names(&result);
        found.sort();
        assert_eq!(found, vec!["a.txt", "b.txt"]);

        // Passing the same root twice must not duplicate the files.
        let again = scan_paths(vec![first.path().to_path_buf(), first.path().to_path_buf()]);
        assert_eq!(names(&again), vec!["a.txt"]);
    }

    #[test]
    fn media_paths_are_validated_before_bytes_are_read() {
        let tree = TempTree::new("media-bytes");
        tree.write("photo.jpg", "jpeg-ish bytes");
        tree.write("notes.txt", "text");

        let good = crate::commands::read_media_bytes(
            tree.join("photo.jpg").to_string_lossy().to_string(),
        );
        assert!(good.is_ok(), "a valid media file reads bytes");
        match tauri::ipc::IpcResponse::body(good.unwrap()).expect("response body") {
            tauri::ipc::InvokeResponseBody::Raw(bytes) => {
                assert_eq!(bytes, b"jpeg-ish bytes".to_vec());
            }
            other => panic!("expected raw bytes, got {other:?}"),
        }

        let not_media = crate::commands::read_media_bytes(
            tree.join("notes.txt").to_string_lossy().to_string(),
        );
        assert!(not_media.is_err(), "a text extension is refused by the media reader");
        if let Err(error) = not_media {
            assert!(
                matches!(error, CommandError::UnsupportedFormat(_)),
                "got {error:?}"
            );
        }

        let missing = crate::commands::read_media_bytes(
            tree.join("nope.png").to_string_lossy().to_string(),
        );
        assert!(missing.is_err(), "a missing file is an error, not empty bytes");
    }

    #[test]
    fn bulk_read_returns_contents_in_requested_order() {
        let tree = TempTree::new("read");
        tree.write("first.txt", "one");
        tree.write("second.txt", "two");
        tree.write("third.txt", "three");

        let contents = read_bulk(&tree, &["first.txt", "second.txt", "third.txt"]);
        assert_eq!(contents, vec!["one", "two", "three"]);
    }

    #[test]
    fn bulk_read_isolates_per_file_failures() {
        let tree = TempTree::new("read-fail");
        tree.write("good.txt", "good");
        tree.write("bad.exe", "binary");

        let paths = vec![
            tree.join("good.txt").to_string_lossy().to_string(),
            tree.join("missing.txt").to_string_lossy().to_string(),
            tree.join("bad.exe").to_string_lossy().to_string(),
        ];
        let results = crate::commands::read_text_files_bulk(paths).expect("bulk read");

        assert_eq!(results.len(), 3, "one entry per requested path");
        assert!(matches!(
            results[0],
            crate::commands::BulkReadOutcome::Ok(_)
        ));
        assert!(
            matches!(
                results[1],
                crate::commands::BulkReadOutcome::Err(CommandError::NotFound(_))
            ),
            "a missing file is an error, not a crash"
        );
        assert!(
            matches!(
                results[2],
                crate::commands::BulkReadOutcome::Err(CommandError::UnsupportedFormat(_))
            ),
            "an unsupported extension is refused per file"
        );
    }

    fn read_bulk(tree: &TempTree, files: &[&str]) -> Vec<String> {
        let paths: Vec<String> = files
            .iter()
            .map(|file| tree.join(file).to_string_lossy().to_string())
            .collect();

        crate::commands::read_text_files_bulk(paths)
            .expect("bulk read")
            .into_iter()
            .map(|entry| match entry {
                crate::commands::BulkReadOutcome::Ok(content) => content.content,
                crate::commands::BulkReadOutcome::Err(error) => {
                    panic!("unexpected error: {error:?}")
                }
            })
            .collect()
    }
}
