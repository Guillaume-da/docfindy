//! Claude API client + agentic tool-use loop.
//!
//! Token budget kept low by design:
//! - caveman-style system prompt (terse output, ~65% fewer output tokens)
//! - rtk-compressed filesystem probes fed back as tool results
//! - graph vocab capped, query results capped

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::Emitter;

use crate::{engine, rtk};

const API_URL: &str = "https://api.anthropic.com/v1/messages";
const MAX_TURNS: usize = 10;
const VOCAB_CAP: usize = 3000;

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
1. Call graph_vocab once to get the exact vocabulary of the knowledge graph.
2. Pick up to 12 tokens FROM THAT LIST ONLY that match the user's intent
   (translate across languages: user says "informe"/"report" -> pick matching
   vocab tokens). Never invent tokens not in the list.
3. Call graph_query with those tokens. Inspect results (path, type, neighbors).
4. If the graph gives nothing useful, fall back to fs_probe with a filename
   fragment, or content_search when the user describes CONTENT rather than
   a filename.
5. When you identify the right file: call read_file on it, write a 2-4 line
   synthesis of what the document contains, then call show_file with the
   absolute path AND that synthesis in the summary field. Give the user the
   full path in your reply.

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
            "name": "graph_vocab",
            "description": "Vocabulary (tokens) of all node labels in the local knowledge graph. Call once per search, then pick query tokens only from this list.",
            "input_schema": {"type": "object", "properties": {}}
        },
        {
            "name": "graph_query",
            "description": "Search the knowledge graph. tokens: space-separated tokens taken from graph_vocab. Returns ranked matching nodes with absolute file paths and 1-hop neighbor context.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "tokens": {"type": "string", "description": "space-separated vocab tokens"},
                    "dfs": {"type": "boolean", "description": "true to trace chains deeper"},
                    "limit": {"type": "integer", "default": 8}
                },
                "required": ["tokens"]
            }
        },
        {
            "name": "fs_probe",
            "description": "Fallback filename scan on disk (rtk-compressed output). Use only when graph_query found nothing relevant.",
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
            "description": "Display a file in the app's preview pane, with your synthesis of its content. Call when you found the file the user wants.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "absolute path"},
                    "summary": {"type": "string", "description": "2-4 line synthesis of the document, in the user's language"}
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
        "graph_vocab" => {
            let args = vec!["vocab".into(), "--out".into(), out_dir];
            match engine::run(app, &args, false).await {
                Ok(v) => {
                    let vocab: Vec<String> = v["vocab"]
                        .as_array()
                        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                        .unwrap_or_default();
                    let total = vocab.len();
                    let capped: Vec<&String> = vocab.iter().take(VOCAB_CAP).collect();
                    format!(
                        "{} tokens{}: {}",
                        total,
                        if total > VOCAB_CAP { " (capped)" } else { "" },
                        capped.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(" ")
                    )
                }
                Err(e) => format!("error: {e}"),
            }
        }
        "graph_query" => {
            let tokens = input["tokens"].as_str().unwrap_or_default().to_string();
            let mut args = vec![
                "query".into(), "--out".into(), out_dir,
                "--tokens".into(), tokens,
                "--limit".into(), input["limit"].as_u64().unwrap_or(8).to_string(),
            ];
            if input["dfs"].as_bool().unwrap_or(false) {
                args.push("--dfs".into());
            }
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
            let _ = app.emit("show-file", &f);
            shown.push(f.clone());
            if f.exists { "displayed".into() } else { format!("file not found: {path}") }
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

    Ok(AgentResult { text: final_text, shown })
}
