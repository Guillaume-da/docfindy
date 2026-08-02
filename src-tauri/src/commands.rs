use serde::Deserialize;
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

use crate::provider::{Msg, Provider};
use crate::{agent, engine, provider, secrets};

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
        .unwrap_or_else(|| {
            json!({
                "lang": "en",
                "roots": [],
                "provider": Provider::Anthropic.id(),
                "model": Provider::Anthropic.default_model(),
            })
        })
}

/// The configured provider, and the model to use with it.
///
/// `model` is stored per provider (`models: {anthropic: "…", openai: "…"}`) so
/// switching back and forth does not lose the previous choice. The flat
/// `model` key written by older versions is still honoured for Anthropic.
fn provider_and_model(settings: &Value) -> (Provider, String) {
    let prov = Provider::from_id(settings["provider"].as_str().unwrap_or("anthropic"));
    let per_provider = settings["models"][prov.id()].as_str();
    let legacy = if prov == Provider::Anthropic {
        settings["model"].as_str()
    } else {
        None
    };
    let model = per_provider
        .or(legacy)
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .unwrap_or(prov.default_model())
        .to_string();
    (prov, model)
}

/// Provider + key + model for a command that needs to call the API.
/// Errors with `no_api_key`, which the UI turns into "set up your key".
fn ai_context(app: &tauri::AppHandle) -> Result<(Provider, String, String, Value), String> {
    let settings = load_settings(app);
    let (prov, model) = provider_and_model(&settings);
    let key = secrets::get(app, prov).ok_or("no_api_key")?;
    Ok((prov, key, model, settings))
}

#[tauri::command]
pub fn get_settings(app: tauri::AppHandle) -> Value {
    load_settings(&app)
}

#[tauri::command]
pub fn save_settings(app: tauri::AppHandle, settings: Value) -> Result<(), String> {
    let p = settings_path(&app)?;
    // Merge rather than replace: a caller that sends a partial object should
    // not silently drop the keys it left out.
    let merged = merge_settings(load_settings(&app), settings);
    fs::write(p, serde_json::to_string_pretty(&merged).unwrap()).map_err(|e| e.to_string())
}

/// Shallow merge of `incoming` over `current`. Keys present in `incoming` win,
/// including when their value is empty — an explicit `"roots": []` is a real
/// edit. Keys absent from `incoming` are kept.
fn merge_settings(current: Value, incoming: Value) -> Value {
    match (current, incoming) {
        (Value::Object(mut base), Value::Object(patch)) => {
            base.extend(patch);
            Value::Object(base)
        }
        (_, incoming) => incoming,
    }
}

/// Defence in depth for commands that take a path from the webview: the
/// frontend is bundled and trusted, but if script injection ever landed there,
/// these commands would otherwise hand it arbitrary file read/open. Validate
/// against the indexed roots (canonicalised, credential files refused) exactly
/// like the agent's tools; the original path string is kept for the OS calls,
/// which on Windows do not all accept the `\\?\` form canonicalisation yields.
fn ensure_in_roots(app: &tauri::AppHandle, path: &str) -> Result<(), String> {
    let settings = load_settings(app);
    let roots: Vec<String> = settings["roots"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    agent::resolve_in_roots(path, &roots).map(|_| ())
}

/// Store a key. `provider` is optional so the onboarding flow, which only
/// deals with Claude, can keep calling this with just a key.
#[tauri::command]
pub fn set_api_key(
    app: tauri::AppHandle,
    key: String,
    provider: Option<String>,
) -> Result<(), String> {
    let prov = Provider::from_id(provider.as_deref().unwrap_or("anthropic"));
    secrets::set(&app, prov, key.trim())
}

/// Whether a key is stored — for the configured provider by default, or for
/// the named one.
#[tauri::command]
pub fn has_api_key(app: tauri::AppHandle, provider: Option<String>) -> bool {
    let prov = match provider {
        Some(p) => Provider::from_id(&p),
        None => provider_and_model(&load_settings(&app)).0,
    };
    secrets::get(&app, prov).is_some()
}

/// Which providers already have a key, so Settings can show it at a glance.
#[tauri::command]
pub fn provider_keys(app: tauri::AppHandle) -> Value {
    json!({
        "anthropic": secrets::get(&app, Provider::Anthropic).is_some(),
        "openai": secrets::get(&app, Provider::OpenAi).is_some(),
        "kimi": secrets::get(&app, Provider::Kimi).is_some(),
    })
}

/// Open the provider's API-key page. Takes a provider id, never a URL: the
/// destination is a constant on the Rust side.
#[tauri::command]
pub fn open_provider_keys_page(app: tauri::AppHandle, provider: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let url = Provider::from_id(&provider).key_url();
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

/// Model ids the stored key can use. Asked of the provider rather than
/// hardcoded, so a new model is selectable the day it ships.
#[tauri::command]
pub async fn list_models(
    app: tauri::AppHandle,
    provider: Option<String>,
) -> Result<Vec<String>, String> {
    let prov = match provider {
        Some(p) => Provider::from_id(&p),
        None => provider_and_model(&load_settings(&app)).0,
    };
    let key = secrets::get(&app, prov).ok_or("no_api_key")?;
    provider::list_models(prov, &key).await
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
        // Privacy counters. Absent from indexes built before they existed, so
        // default to 0 rather than propagating null into the UI.
        "skipped_sensitive": meta["skipped_sensitive"].as_u64().unwrap_or(0),
        "secret_files": meta["secret_files"].as_u64().unwrap_or(0),
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
        "fts".into(),
        "--out".into(),
        out,
        "--query".into(),
        q.to_string(),
        "--limit".into(),
        "25".into(),
    ];
    engine::run(&app, &args, false).await
}

/// Smart search: Claude expands the query (synonyms + FR/EN translations),
/// then the FTS index is searched with all terms. Returns the engine hits plus
/// an `expanded` list of the terms used. Needs the API key.
#[tauri::command]
pub async fn smart_search(
    app: tauri::AppHandle,
    query: String,
    lang: Option<String>,
) -> Result<Value, String> {
    let _ = lang; // reserved; expansion is language-agnostic (handles FR+EN)
    let q = query.trim();
    if q.is_empty() {
        return Ok(json!({ "hits": [], "expanded": [] }));
    }
    let (prov, api_key, model, _) = ai_context(&app)?;
    let terms = agent::expand_query(prov, &api_key, &model, q).await?;
    let out = engine::index_dir(&app)?.to_string_lossy().into_owned();
    let args: Vec<String> = vec![
        "fts".into(),
        "--out".into(),
        out,
        "--query".into(),
        terms.join(" "),
        "--limit".into(),
        "25".into(),
    ];
    let mut v = engine::run(&app, &args, false).await?;
    v["expanded"] = json!(terms);
    Ok(v)
}

/// AI summary of the previewed document: `{tldr, points}`. Needs the Claude
/// API key; errors with "no_api_key" if it is not set (UI hides the panel).
#[tauri::command]
pub async fn summarize_file(
    app: tauri::AppHandle,
    path: String,
    lang: Option<String>,
) -> Result<Value, String> {
    ensure_in_roots(&app, &path)?;
    let (prov, api_key, model, settings) = ai_context(&app)?;
    // caller passes the UI's current language so the summary follows the toggle
    let lang = lang
        .filter(|l| !l.trim().is_empty())
        .unwrap_or_else(|| settings["lang"].as_str().unwrap_or("en").to_string());
    let text_args: Vec<String> = vec![
        "text".into(),
        "--path".into(),
        path,
        "--max-chars".into(),
        "12000".into(),
    ];
    let v = engine::run(&app, &text_args, false).await?;
    let text = v["text"].as_str().unwrap_or_default();
    agent::summarize(prov, &api_key, &model, &lang, text).await
}

/// Answer a question about the previewed document: `{answer}`. Needs the key.
#[tauri::command]
pub async fn ask_document(
    app: tauri::AppHandle,
    path: String,
    question: String,
    lang: Option<String>,
) -> Result<Value, String> {
    ensure_in_roots(&app, &path)?;
    let (prov, api_key, model, settings) = ai_context(&app)?;
    let lang = lang
        .filter(|l| !l.trim().is_empty())
        .unwrap_or_else(|| settings["lang"].as_str().unwrap_or("en").to_string());
    let text_args: Vec<String> = vec![
        "text".into(),
        "--path".into(),
        path,
        "--max-chars".into(),
        "12000".into(),
    ];
    let v = engine::run(&app, &text_args, false).await?;
    let text = v["text"].as_str().unwrap_or_default();
    agent::ask(prov, &api_key, &model, &lang, text, &question).await
}

#[derive(Deserialize)]
pub struct ChatMsg {
    pub role: String,
    pub content: String,
}

#[tauri::command]
pub async fn chat(app: tauri::AppHandle, messages: Vec<ChatMsg>) -> Result<Value, String> {
    let (prov, api_key, model, settings) = ai_context(&app)?;
    let lang = settings["lang"].as_str().unwrap_or("en").to_string();
    let roots: Vec<String> = settings["roots"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    // Prior turns replay as plain text on both sides: the tool calls that
    // produced them are not kept in the transcript the webview sends back.
    let history: Vec<Msg> = messages
        .iter()
        .map(|m| {
            if m.role == "assistant" {
                Msg::Assistant {
                    text: m.content.clone(),
                    calls: vec![],
                }
            } else {
                Msg::User(m.content.clone())
            }
        })
        .collect();

    let result = agent::agent_loop(&app, prov, &api_key, &model, &lang, &roots, history).await?;
    Ok(json!({"text": result.text, "shown": result.shown}))
}

const TEXT_EXTS: &[&str] = &[
    "txt", "md", "markdown", "log", "csv", "json", "yaml", "yml", "toml", "ini", "py", "js", "ts",
    "tsx", "jsx", "rs", "go", "java", "c", "cpp", "h", "sh", "html", "htm", "css", "xml", "sql",
    "php", "rb",
];
const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"];

#[tauri::command]
pub async fn read_preview(app: tauri::AppHandle, path: String) -> Result<Value, String> {
    ensure_in_roots(&app, &path)?;
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
            "blocks".into(),
            "--path".into(),
            path,
            "--max-chars".into(),
            "200000".into(),
        ];
        match engine::run(&app, &args, false).await {
            Ok(v) => {
                out["text"] = v["text"].clone();
                out["blocks"] = v["blocks"].clone();
                if !v["html"].is_null() {
                    out["html"] = v["html"].clone();
                }
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
pub fn open_in_browser(app: tauri::AppHandle, path: String) -> Result<(), String> {
    ensure_in_roots(&app, &path)?;
    let url = format!(
        "file:///{}",
        path.trim_start_matches('/').replace('\\', "/")
    );

    #[cfg(target_os = "windows")]
    {
        // Through the opener plugin, not `cmd /C start`: cmd.exe re-parses its
        // command line by rules Rust does not escape for, so a crafted filename
        // could break out of the argument and run as a command.
        use tauri_plugin_opener::OpenerExt;
        return app
            .opener()
            .open_url(url, None::<&str>)
            .map_err(|e| e.to_string());
    }

    #[cfg(not(target_os = "windows"))]
    {
        for browser in ["google-chrome", "chromium", "chromium-browser", "firefox"] {
            if std::process::Command::new(browser)
                .arg(&url)
                .spawn()
                .is_ok()
            {
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

/// Open the file with the OS default application (Word for .docx, etc.).
///
/// Goes through the opener plugin rather than `cmd /C start`: cmd.exe parses
/// its command line by different rules than the ones Rust escapes for, so a
/// filename containing `&`, `^` or a quote — trivially arrived at through a
/// download — could break out and run as a command.
#[tauri::command]
pub fn open_file(app: tauri::AppHandle, path: String) -> Result<(), String> {
    ensure_in_roots(&app, &path)?;
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        use tauri_plugin_opener::OpenerExt;
        app.opener()
            .open_path(path, None::<&str>)
            .map_err(|e| e.to_string())
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

/// Copy the file itself (not its path) to the OS clipboard, so it can be
/// pasted in the file manager. Unsupported platforms return an error and the
/// UI falls back to copying the path as text.
///
/// Both platforms drive an interpreter (PowerShell, AppleScript) whose quoting
/// rules are its own, so the path travels in an environment variable and the
/// command line stays a constant. Escaping the path into the script would work
/// until it did not; keeping it out of the script means there is nothing to
/// escape.
#[tauri::command]
pub fn copy_file_to_clipboard(app: tauri::AppHandle, path: String) -> Result<(), String> {
    ensure_in_roots(&app, &path)?;
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let status = std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Set-Clipboard -LiteralPath $env:DOCFINDY_CLIP_PATH",
            ])
            .env("DOCFINDY_CLIP_PATH", &path)
            .creation_flags(0x0800_0000)
            .status()
            .map_err(|e| e.to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err("clipboard copy failed".into())
        }
    }
    #[cfg(target_os = "macos")]
    {
        let status = std::process::Command::new("osascript")
            .args([
                "-e",
                "set the clipboard to (POSIX file (system attribute \"DOCFINDY_CLIP_PATH\"))",
            ])
            .env("DOCFINDY_CLIP_PATH", &path)
            .status()
            .map_err(|e| e.to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err("clipboard copy failed".into())
        }
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        let _ = path;
        Err("unsupported".into())
    }
}

/// Whether a path is safe to embed in an `explorer /select,"…"` raw argument.
///
/// `raw_arg` bypasses Rust's quoting entirely, so the quoting is ours to get
/// right. A double quote or a control character would break out of the
/// argument — and neither is legal in a Windows filename, so rejecting is
/// correct rather than merely cautious.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn safe_for_explorer_arg(path: &str) -> bool {
    !path.contains('"') && !path.chars().any(|c| c.is_control())
}

/// Reveal the file in the OS file manager, selected.
#[tauri::command]
pub fn reveal_in_folder(app: tauri::AppHandle, path: String) -> Result<(), String> {
    ensure_in_roots(&app, &path)?;
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        if !safe_for_explorer_arg(&path) {
            return Err("invalid path".into());
        }
        std::process::Command::new("explorer")
            .raw_arg(format!("/select,\"{path}\""))
            .creation_flags(0x0800_0000)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        let dir = std::path::Path::new(&path)
            .parent()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.clone());
        std::process::Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::{merge_settings, safe_for_explorer_arg};
    use serde_json::json;

    #[test]
    fn ordinary_windows_paths_are_accepted() {
        assert!(safe_for_explorer_arg(
            "C:\\Users\\Sample\\Documents\\report.pdf"
        ));
        assert!(safe_for_explorer_arg("C:\\Users\\Sample\\a & b (1).docx"));
        assert!(safe_for_explorer_arg(
            "C:\\Users\\Sample\\résumé — final.odt"
        ));
    }

    #[test]
    fn quotes_and_control_characters_are_rejected() {
        // Would close the /select,"…" argument early.
        assert!(!safe_for_explorer_arg("C:\\tmp\\a\".exe"));
        assert!(!safe_for_explorer_arg("C:\\tmp\\a\nb.txt"));
        assert!(!safe_for_explorer_arg("C:\\tmp\\a\0b.txt"));
    }

    #[test]
    fn keeps_keys_the_caller_left_out() {
        let current = json!({"lang": "es", "model": "claude-sonnet-5", "roots": ["/docs"]});
        let merged = merge_settings(current, json!({"lang": "en"}));
        assert_eq!(merged["roots"], json!(["/docs"]));
        assert_eq!(merged["model"], "claude-sonnet-5");
        assert_eq!(merged["lang"], "en");
    }

    #[test]
    fn an_explicit_empty_value_is_a_real_edit() {
        let current = json!({"lang": "en", "roots": ["/docs"]});
        let merged = merge_settings(current, json!({"roots": []}));
        assert_eq!(merged["roots"], json!([]));
    }

    #[test]
    fn falls_back_to_the_incoming_value_when_current_is_not_an_object() {
        let merged = merge_settings(json!(null), json!({"lang": "en"}));
        assert_eq!(merged["lang"], "en");
    }
}
