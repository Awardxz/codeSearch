//! CLI for driving the scanner from tests and scripts.
//!
//! Run with:
//!   cargo run -p semantic-file-search --example scan -- scan <path> [<path>...]
//!   cargo run -p semantic-file-search --example scan -- read <path>
//!   cargo run -p semantic-file-search --example scan -- bytes <path>
//!
//! Prints JSON so Node scripts can assert on the exact same code the app runs,
//! instead of a second copy of the walk that can drift from it.

use semantic_file_search_lib::commands::{
    read_media_bytes, read_text_file, read_text_files_bulk,
};
use semantic_file_search_lib::scanner::scan_folders;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(command) = args.first() else {
        eprintln!("usage: scan <scan|read|bytes|bulk-read> [args...]");
        std::process::exit(2);
    };

    match command.as_str() {
        "scan" => {
            if args.len() < 2 {
                eprintln!("usage: scan <path> [<path>...]");
                std::process::exit(2);
            }
            let paths: Vec<String> = args[1..].to_vec();
            match scan_folders(paths) {
                Ok(result) => print_json(&result),
                Err(error) => {
                    eprintln!("{}", serde_json::to_string_pretty(&error).unwrap());
                    std::process::exit(1);
                }
            }
        }
        "read" => {
            let Some(path) = args.get(1) else {
                eprintln!("usage: read <path>");
                std::process::exit(2);
            };
            match read_text_file(path.clone()) {
                Ok(content) => print_json(&content),
                Err(error) => {
                    eprintln!("{}", serde_json::to_string_pretty(&error).unwrap());
                    std::process::exit(1);
                }
            }
        }
        "bytes" => {
            let Some(path) = args.get(1) else {
                eprintln!("usage: bytes <path>");
                std::process::exit(2);
            };
            match read_media_bytes(path.clone()) {
                Ok(response) => {
                    use tauri::ipc::IpcResponse;
                    match IpcResponse::body(response) {
                        Ok(body) => println!("{:?}", body),
                        Err(error) => {
                            eprintln!("{error}");
                            std::process::exit(1);
                        }
                    }
                }
                Err(error) => {
                    eprintln!("{}", serde_json::to_string_pretty(&error).unwrap());
                    std::process::exit(1);
                }
            }
        }
        "bulk-read" => {
            let paths: Vec<String> = args[1..].to_vec();
            if paths.is_empty() {
                eprintln!("usage: bulk-read <path> [<path>...]");
                std::process::exit(2);
            }
            match read_text_files_bulk(paths) {
                Ok(results) => print_json(&results),
                Err(error) => {
                    eprintln!("{}", serde_json::to_string_pretty(&error).unwrap());
                    std::process::exit(1);
                }
            }
        }
        other => {
            eprintln!("unknown command: {other}");
            std::process::exit(2);
        }
    }
}

fn print_json<T: serde::Serialize>(value: &T) {
    println!("{}", serde_json::to_string_pretty(value).unwrap());
}
