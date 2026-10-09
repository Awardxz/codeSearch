// Re-exports are public so `examples/scan.rs` can exercise the same code the app
// uses, rather than a second copy of the scan logic to keep in sync.
pub mod commands;
pub mod persist;
pub mod scanner;
pub mod watch;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(watch::WatchState::default())
        .invoke_handler(tauri::generate_handler![
            commands::read_text_file,
            commands::read_text_files_bulk,
            commands::read_media_bytes,
            persist::persist_index_upsert,
            persist::persist_index_remove,
            persist::persist_index_clear,
            persist::persist_index_load,
            persist::persist_index_stats,
            watch::watch_start,
            watch::watch_stop,
            scanner::scan_folders
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
