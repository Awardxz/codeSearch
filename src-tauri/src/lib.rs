// Re-exports are public so `examples/scan.rs` can exercise the same code the app
// uses, rather than a second copy of the scan logic to keep in sync.
pub mod commands;
pub mod scanner;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::read_text_file,
            commands::read_text_files_bulk,
            commands::read_media_bytes,
            scanner::scan_folders
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
