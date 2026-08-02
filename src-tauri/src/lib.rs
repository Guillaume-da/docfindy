mod agent;
mod commands;
mod engine;
mod migrate;
mod provider;
mod rtk;
mod secrets;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            migrate::run(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::save_settings,
            commands::set_api_key,
            commands::has_api_key,
            commands::provider_keys,
            commands::list_models,
            commands::open_provider_keys_page,
            commands::index_status,
            commands::detect_paths,
            commands::build_index,
            commands::update_index,
            commands::quick_search,
            commands::smart_search,
            commands::summarize_file,
            commands::ask_document,
            commands::chat,
            commands::read_preview,
            commands::open_in_browser,
            commands::open_file,
            commands::reveal_in_folder,
            commands::copy_file_to_clipboard,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
