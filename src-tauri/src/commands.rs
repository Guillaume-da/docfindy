use serde::Deserialize;
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

use crate::{claude, engine, secrets};

fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

fn load_settings(app: &tauri::AppHandle) -> Value {
    settings_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({"lang": "en", "roots": [], "model": "claude-sonnet-5"}))
}

#[tauri::command]
pub fn get_settings(app: tauri::AppHandle) -> Value {
    load_settings(&app)
}

#[tauri::command]
pub fn save_settings(app: tauri::AppHandle, settings: Value) -> Result<(), String> {
    let p = settings_path(&app)?;
    fs::write(p, serde_json::to_string_pretty(&settings).unwrap()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_api_key(app: tauri::AppHandle, key: String) -> Result<(), String> {
    secrets::set(&app, key.trim())
}

#[tauri::command]
pub fn has_api_key(app: tauri::AppHandle) -> bool {
    secrets::get(&app).is_some()
}

#[tauri::command]
pub fn index_status(app: tauri::AppHandle) -> Value {
    let Ok(dir) = engine::index_dir(&app) else {
        return json!({"exists": false});
    };
    let content_db = dir.join("content.db");
    let files = dir.join("files.json");
    if !content_db.exists() || !files.exists() {
        return json!({"exists": false});
    }
    let meta: Value = fs::read_to_string(files)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(json!({}));
    json!({
        "exists": true,
        "roots": meta["roots"],
        "built_at": meta["built_at"],
        "files": meta["files"].as_array().map(|a| a.len()).unwrap_or(0),
    })
}

#[tauri::command]
pub async fn detect_paths(app: tauri::AppHandle, paths: Vec<String>) -> Result<Value, String> {
    let mut args: Vec<String> = vec!["detect".into()];
    for p in &paths {
        args.push("--path".into());
        args.push(p.clone());
    }
    engine::run(&app, &args, false).await
}

#[tauri::command]
pub async fn build_index(app: tauri::AppHandle, paths: Vec<String>) -> Result<Value, String> {
    let out = engine::index_dir(&app)?.to_string_lossy().into_owned();
    let mut args: Vec<String> = vec!["build".into(), "--out".into(), out];
    for p in &paths {
        args.push("--path".into());
        args.push(p.clone());
    }
    let result = engine::run(&app, &args, true).await?;

    // persist indexed roots in settings for the agent's system prompt
    let mut settings = load_settings(&app);
    settings["roots"] = json!(paths);
    let _ = save_settings(app.clone(), settings);
    Ok(result)
}

#[tauri::command]
pub async fn update_index(app: tauri::AppHandle) -> Result<Value, String> {
    let out = engine::index_dir(&app)?.to_string_lossy().into_owned();
    let args: Vec<String> = vec!["update".into(), "--out".into(), out];
    engine::run(&app, &args, true).await
}

/// Instant search-as-you-type: query the FTS index directly (no LLM).
/// Returns `{query, terms, hits: [...]}` from the engine, or empty for a
/// blank query.
#[tauri::command]
pub async fn quick_search(app: tauri::AppHandle, query: String) -> Result<Value, String> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(json!({ "hits": [] }));
    }
    let out = engine::index_dir(&app)?.to_string_lossy().into_owned();
    let args: Vec<String> = vec![
        "fts".into(), "--out".into(), out,
        "--query".into(), q.to_string(),
        "--limit".into(), "25".into(),
    ];
    engine::run(&app, &args, false).await
}

/// AI summary of the previewed document: `{tldr, points}`. Needs the Claude
/// API key; errors with "no_api_key" if it is not set (UI hides the panel).
#[tauri::command]
pub async fn summarize_file(
    app: tauri::AppHandle,
    path: String,
    lang: Option<String>,
) -> Result<Value, String> {
    let api_key = secrets::get(&app).ok_or("no_api_key")?;
    let settings = load_settings(&app);
    // caller passes the UI's current language so the summary follows the toggle
    let lang = lang
        .filter(|l| !l.trim().is_empty())
        .unwrap_or_else(|| settings["lang"].as_str().unwrap_or("en").to_string());
    let model = settings["model"].as_str().unwrap_or("claude-sonnet-5").to_string();
    let text_args: Vec<String> = vec![
        "text".into(), "--path".into(), path,
        "--max-chars".into(), "12000".into(),
    ];
    let v = engine::run(&app, &text_args, false).await?;
    let text = v["text"].as_str().unwrap_or_default();
    claude::summarize(&api_key, &model, &lang, text).await
}

#[derive(Deserialize)]
pub struct ChatMsg {
    pub role: String,
    pub content: String,
}

#[tauri::command]
pub async fn chat(app: tauri::AppHandle, messages: Vec<ChatMsg>) -> Result<Value, String> {
    let api_key = secrets::get(&app).ok_or("no_api_key")?;
    let settings = load_settings(&app);
    let lang = settings["lang"].as_str().unwrap_or("en").to_string();
    let model = settings["model"].as_str().unwrap_or("claude-sonnet-5").to_string();
    let roots: Vec<String> = settings["roots"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();

    let api_messages: Vec<Value> = messages
        .iter()
        .map(|m| json!({"role": m.role, "content": m.content}))
        .collect();

    let result = claude::agent_loop(&app, &api_key, &model, &lang, &roots, api_messages).await?;
    Ok(json!({"text": result.text, "shown": result.shown}))
}

const TEXT_EXTS: &[&str] = &[
    "txt", "md", "markdown", "log", "csv", "json", "yaml", "yml", "toml", "ini",
    "py", "js", "ts", "tsx", "jsx", "rs", "go", "java", "c", "cpp", "h", "sh",
    "html", "htm", "css", "xml", "sql", "php", "rb",
];
const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"];

#[tauri::command]
pub async fn read_preview(app: tauri::AppHandle, path: String) -> Result<Value, String> {
    let p = PathBuf::from(&path);
    let meta = fs::metadata(&p).map_err(|e| format!("not found: {e}"))?;
    let ext = p
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    let kind = if ext == "pdf" {
        "pdf"
    } else if IMAGE_EXTS.contains(&ext.as_str()) {
        "image"
    } else if ext == "docx" || ext == "odt" || TEXT_EXTS.contains(&ext.as_str()) {
        "text"
    } else {
        "other"
    };

    let mut out = json!({
        "kind": kind,
        "path": path.clone(),
        "name": p.file_name().map(|n| n.to_string_lossy().into_owned()),
        "size": meta.len(),
        "mtime": meta.modified().ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs()),
    });
    if ext == "docx" || ext == "odt" {
        let args = vec![
            "blocks".into(), "--path".into(), path,
            "--max-chars".into(), "200000".into(),
        ];
        match engine::run(&app, &args, false).await {
            Ok(v) => {
                out["text"] = v["text"].clone();
                out["blocks"] = v["blocks"].clone();
            }
            Err(e) => out["text"] = json!(format!("({ext} extraction failed: {e})")),
        }
    } else if kind == "text" && meta.len() <= 500_000 {
        if let Ok(text) = fs::read_to_string(&p) {
            out["text"] = json!(text.chars().take(200_000).collect::<String>());
        }
    }
    Ok(out)
}

/// Open the file in the default web browser (not the default file handler).
#[tauri::command]
pub fn open_in_browser(path: String) -> Result<(), String> {
    let url = format!(
        "file:///{}",
        path.trim_start_matches('/').replace('\\', "/")
    );

    #[cfg(target_os = "windows")]
    {
        // msedge ships on every Windows 10/11; try user browsers first
        for browser in ["chrome", "msedge", "firefox"] {
            if std::process::Command::new("cmd")
                .args(["/C", "start", "", browser, &url])
                .spawn()
                .is_ok()
            {
                return Ok(());
            }
        }
        return Err("no browser found".into());
    }

    #[cfg(not(target_os = "windows"))]
    {
        for browser in ["google-chrome", "chromium", "chromium-browser", "firefox"] {
            if std::process::Command::new(browser).arg(&url).spawn().is_ok() {
                return Ok(());
            }
        }
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}
