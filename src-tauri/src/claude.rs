//! Claude API client + agentic tool-use loop.
//!
//! Token budget kept low by design:
//! - caveman-style system prompt (terse output, ~65% fewer output tokens)
//! - rtk-compressed filesystem probes fed back as tool results
//! - doc_search results capped

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::Emitter;

use crate::{engine, rtk};

const API_URL: &str = "https://api.anthropic.com/v1/messages";
const MAX_TURNS: usize = 10;

#[derive(Serialize, Deserialize, Clone)]
pub struct ShownFile {
    pub path: String,
    pub exists: bool,
    pub size: Option<u64>,
    pub summary: Option<String>,
}

#[derive(Serialize)]
pub struct AgentResult {
    pub text: String,
    pub shown: Vec<ShownFile>,
}

fn system_prompt(lang: &str, roots: &[String]) -> String {
    let lang_line = match lang {
        "es" => "Responde SIEMPRE en español.",
        _ => "ALWAYS reply in English.",
    };
    format!(
        r#"You are Findy, a local file-finding agent running on the user's computer.
Goal: locate the file the user describes, as fast as possible, and show it.

Indexed roots: {roots}

Workflow for every search:
1. Call doc_search first. It matches file NAMES and file CONTENT
   (pdf/docx/odt/text), accent-insensitive, prefix-matched, ranked. Pass the
   user's own words plus obvious synonyms and translations (e.g. user says
   "facture" -> "facture invoice"). Inspect ranked hits: path, name, snippet.
2. If nothing useful: retry doc_search with different words, then fs_probe
   with a filename fragment.
3. If doc_search returns the note "no content index", tell the user to
   rebuild the index from Settings.
4. Presenting results:
   - One clear match: read_file it, write a 2-4 line synthesis, call show_file
     with the absolute path AND that synthesis in the summary field.
   - SEVERAL plausible matches (e.g. the word occurs in multiple documents):
     call show_file for each of the top candidates, best first, up to 5, each
     with its own one-line summary. The first is previewed automatically; the
     others become clickable choices for the user. In your reply, list them
     briefly and numbered so the user can pick.
   Always give the full path(s) in your reply.

When the user asks WHERE some information is ("where is X mentioned",
"donde aparece X", "which file talks about X"):
- use content_search (needle = the literal term, optionally scoped to a file)
- answer with exact locations: path, line number (or PDF page), and quote
  the matching snippet verbatim.

If nothing matches, say so plainly and suggest what to reindex.

{lang_line}

Style rules (strict):
- Terse. Drop filler, pleasantries, hedging. Fragments OK.
- Keep all technical substance: paths, filenames, sizes exact and verbatim.
- Answer pattern: [file found] [path] [why it matches]. Nothing more.
- Never narrate tool calls. Never apologize."#,
        roots = if roots.is_empty() { "(none yet)".to_string() } else { roots.join(", ") },
        lang_line = lang_line,
    )
}

fn tools() -> Value {
    json!([
        {
            "name": "doc_search",
            "description": "Full-text search over file NAMES and CONTENT of every indexed file (pdf, docx, odt, txt, code). Accent-insensitive, prefix-matching, BM25-ranked. PRIMARY tool: call it first for any document search, with the user's own words plus synonyms/translations.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "search words, space-separated"},
                    "limit": {"type": "integer", "default": 10}
                },
                "required": ["query"]
            }
        },
        {
            "name": "fs_probe",
            "description": "Fallback filename scan on disk (rtk-compressed output). Use only when doc_search found nothing relevant.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "dir": {"type": "string", "description": "absolute directory to scan"},
                    "pattern": {"type": "string", "description": "filename fragment, no wildcards"}
                },
                "required": ["dir", "pattern"]
            }
        },
        {
            "name": "read_file",
            "description": "Extract the text content of a file (txt/md/code directly, PDF via extraction). Use to write the synthesis before show_file, or to answer questions about a document's content.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "absolute path"},
                    "max_chars": {"type": "integer", "default": 20000}
                },
                "required": ["path"]
            }
        },
        {
            "name": "content_search",
            "description": "Search a literal term inside file contents (case-insensitive). Scope to one file with path, or search all indexed files. Returns path + line (or PDF page) + snippet for each hit.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "needle": {"type": "string", "description": "literal term to find"},
                    "path": {"type": "string", "description": "optional: restrict to this file"},
                    "limit": {"type": "integer", "default": 20}
                },
                "required": ["needle"]
            }
        },
        {
            "name": "show_file",
            "description": "Offer a file to the user. The first file offered is previewed automatically; call it again for each additional candidate (best first, up to 5) to present them as clickable choices. Include a per-file summary.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "absolute path"},
                    "summary": {"type": "string", "description": "1-line synthesis of this document, in the user's language"}
                },
                "required": ["path"]
            }
        }
    ])
}

async fn execute_tool(
    app: &tauri::AppHandle,
    name: &str,
    input: &Value,
    shown: &mut Vec<ShownFile>,
) -> String {
    let _ = app.emit("agent-activity", json!({"tool": name}));
    let out_dir = match engine::index_dir(app) {
        Ok(d) => d.to_string_lossy().into_owned(),
        Err(e) => return format!("error: {e}"),
    };

    match name {
        "doc_search" => {
            let args = vec![
                "fts".into(), "--out".into(), out_dir,
                "--query".into(), input["query"].as_str().unwrap_or_default().to_string(),
                "--limit".into(), input["limit"].as_u64().unwrap_or(10).to_string(),
            ];
            match engine::run(app, &args, false).await {
                Ok(v) => serde_json::to_string(&v).unwrap_or_default(),
                Err(e) => format!("error: {e}"),
            }
        }
        "fs_probe" => {
            let dir = input["dir"].as_str().unwrap_or(".");
            let pattern = input["pattern"].as_str().unwrap_or_default();
            rtk::probe(dir, pattern).await
        }
        "read_file" => {
            let path = input["path"].as_str().unwrap_or_default().to_string();
            let max_chars = input["max_chars"].as_u64().unwrap_or(20_000).to_string();
            let args = vec![
                "text".into(), "--path".into(), path,
                "--max-chars".into(), max_chars,
            ];
            match engine::run(app, &args, false).await {
                Ok(v) => v["text"].as_str().unwrap_or_default().to_string(),
                Err(e) => format!("error: {e}"),
            }
        }
        "content_search" => {
            let mut args = vec![
                "search".into(), "--out".into(), out_dir,
                "--needle".into(), input["needle"].as_str().unwrap_or_default().to_string(),
                "--limit".into(), input["limit"].as_u64().unwrap_or(20).to_string(),
            ];
            if let Some(p) = input["path"].as_str() {
                args.push("--path".into());
                args.push(p.to_string());
            }
            match engine::run(app, &args, false).await {
                Ok(v) => serde_json::to_string(&v).unwrap_or_default(),
                Err(e) => format!("error: {e}"),
            }
        }
        "show_file" => {
            let path = input["path"].as_str().unwrap_or_default().to_string();
            let meta = std::fs::metadata(&path).ok();
            let f = ShownFile {
                path: path.clone(),
                exists: meta.is_some(),
                size: meta.map(|m| m.len()),
                summary: input["summary"].as_str().map(String::from),
            };
            // Live-preview only the first candidate; the rest become clickable
            // choices in the chat so the user picks which to view.
            if f.exists && !shown.iter().any(|s| s.exists) {
                let _ = app.emit("show-file", &f);
            }
            shown.push(f.clone());
            if f.exists { "offered".into() } else { format!("file not found: {path}") }
        }
        _ => format!("unknown tool: {name}"),
    }
}

pub async fn agent_loop(
    app: &tauri::AppHandle,
    api_key: &str,
    model: &str,
    lang: &str,
    roots: &[String],
    mut messages: Vec<Value>,
) -> Result<AgentResult, String> {
    let client = reqwest::Client::new();
    let system = system_prompt(lang, roots);
    let mut shown: Vec<ShownFile> = vec![];
    let mut last_read: Option<String> = None;
    let mut final_text = String::new();

    for _ in 0..MAX_TURNS {
        let body = json!({
            "model": model,
            "max_tokens": 1024,
            "system": system,
            "tools": tools(),
            "messages": messages,
        });

        let resp = client
            .post(API_URL)
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("network: {e}"))?;

        let status = resp.status();
        let data: Value = resp.json().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            let msg = data["error"]["message"].as_str().unwrap_or("API error");
            return Err(format!("Claude API {status}: {msg}"));
        }

        let content = data["content"].as_array().cloned().unwrap_or_default();
        let stop = data["stop_reason"].as_str().unwrap_or("");

        let mut text_parts: Vec<String> = vec![];
        let mut tool_results: Vec<Value> = vec![];
        for block in &content {
            match block["type"].as_str() {
                Some("text") => {
                    if let Some(t) = block["text"].as_str() {
                        text_parts.push(t.to_string());
                    }
                }
                Some("tool_use") => {
                    let name = block["name"].as_str().unwrap_or_default();
                    let id = block["id"].as_str().unwrap_or_default();
                    if name == "read_file" {
                        if let Some(p) = block["input"]["path"].as_str() {
                            last_read = Some(p.to_string());
                        }
                    }
                    let result = execute_tool(app, name, &block["input"], &mut shown).await;
                    tool_results.push(json!({
                        "type": "tool_result",
                        "tool_use_id": id,
                        "content": result,
                    }));
                }
                _ => {}
            }
        }
        if !text_parts.is_empty() {
            final_text = text_parts.join("\n");
        }

        if stop == "tool_use" && !tool_results.is_empty() {
            messages.push(json!({"role": "assistant", "content": content}));
            messages.push(json!({"role": "user", "content": tool_results}));
            continue;
        }
        break;
    }

    // Safety net: if the agent found and read a file but never called show_file
    // (or every show_file target was missing), preview the last file it read so
    // the user always gets the document on the right, not a blank pane.
    if !shown.iter().any(|s| s.exists) {
        if let Some(path) = last_read {
            if let Ok(m) = std::fs::metadata(&path) {
                let f = ShownFile {
                    path,
                    exists: true,
                    size: Some(m.len()),
                    summary: None,
                };
                let _ = app.emit("show-file", &f);
                shown.push(f);
            }
        }
    }

    Ok(AgentResult { text: final_text, shown })
}

/// One-shot document summary for the preview pane: a punchy TL;DR plus the
/// main points. Returns `{"tldr": "...", "points": ["...", ...]}`.
pub async fn summarize(
    api_key: &str,
    model: &str,
    lang: &str,
    text: &str,
) -> Result<Value, String> {
    if text.trim().is_empty() {
        return Err("empty document".into());
    }
    let lang_line = match lang {
        "es" => "Escribe en español.",
        _ => "Write in English.",
    };
    let system = format!(
        "You write a crisp preview of a document. Reply with ONLY a JSON object, \
         no markdown fences, no commentary: \
         {{\"tldr\": \"one vivid sentence saying what this document is\", \
         \"points\": [\"3 to 6 key takeaways, each a short punchy phrase\"]}}. \
         {lang_line}"
    );
    let client = reqwest::Client::new();
    let body = json!({
        "model": model,
        "max_tokens": 600,
        "system": system,
        "messages": [{"role": "user", "content": format!("Document:\n\n{text}")}],
    });
    let resp = client
        .post(API_URL)
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("network: {e}"))?;

    let status = resp.status();
    let data: Value = resp.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        let msg = data["error"]["message"].as_str().unwrap_or("API error");
        return Err(format!("Claude API {status}: {msg}"));
    }

    let raw = data["content"]
        .as_array()
        .and_then(|a| a.iter().find_map(|b| b["text"].as_str()))
        .unwrap_or_default()
        .trim();
    // tolerate ```json fences or stray prose around the JSON
    let start = raw.find('{');
    let end = raw.rfind('}');
    let parsed = match (start, end) {
        (Some(s), Some(e)) if e > s => {
            serde_json::from_str::<Value>(&raw[s..=e]).ok()
        }
        _ => None,
    };
    Ok(parsed.unwrap_or_else(|| json!({ "tldr": raw, "points": [] })))
}
