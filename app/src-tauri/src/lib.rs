#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // HTTP plugin: provider API calls route through Rust, bypassing the
        // WebView's CORS enforcement so OpenAI/Gemini work from the desktop app.
        .plugin(tauri_plugin_http::init())
        // Log plugin: stdout + a persistent file in the OS log dir. The JS side
        // forwards console.* into this via @tauri-apps/plugin-log (see main.tsx),
        // so a tester who hits a bug can just send the log file.
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: None,
                    }),
                ])
                .build(),
        )
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
