//! Model providers.
//!
//! DocFindy talks to three APIs that speak two wire formats: Anthropic's
//! Messages API, and the OpenAI chat-completions format (used by both OpenAI
//! itself and Moonshot/Kimi, which is OpenAI-compatible).
//!
//! The agent code upstream works with the neutral [`Msg`] / [`ToolCall`] types
//! below and never sees either wire format; this module does the translation in
//! both directions.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub enum Provider {
    Anthropic,
    OpenAi,
    Kimi,
}

impl Provider {
    /// Parse the id stored in settings. Unknown ids fall back to Anthropic so a
    /// hand-edited settings file can never leave the app without a provider.
    pub fn from_id(id: &str) -> Self {
        match id.trim().to_ascii_lowercase().as_str() {
            "openai" | "chatgpt" | "gpt" => Provider::OpenAi,
            "kimi" | "moonshot" => Provider::Kimi,
            _ => Provider::Anthropic,
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Provider::Anthropic => "anthropic",
            Provider::OpenAi => "openai",
            Provider::Kimi => "kimi",
        }
    }

    /// Human-facing name, used in error messages.
    pub fn label(self) -> &'static str {
        match self {
            Provider::Anthropic => "Claude",
            Provider::OpenAi => "ChatGPT",
            Provider::Kimi => "Kimi",
        }
    }

    fn default_base_url(self) -> &'static str {
        match self {
            Provider::Anthropic => "https://api.anthropic.com/v1",
            Provider::OpenAi => "https://api.openai.com/v1",
            Provider::Kimi => "https://api.moonshot.ai/v1",
        }
    }

    /// Endpoint root, overridable through `DOCFINDY_<PROVIDER>_BASE_URL`.
    ///
    /// Needed for Moonshot's mainland-China host (`api.moonshot.cn`) and for
    /// OpenAI-compatible gateways people put in front of these APIs.
    fn base_url(self) -> String {
        let var = format!("DOCFINDY_{}_BASE_URL", self.id().to_ascii_uppercase());
        std::env::var(var)
            .ok()
            .map(|s| s.trim_end_matches('/').to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| self.default_base_url().to_string())
    }

    /// Model used until the user picks one from the fetched list.
    pub fn default_model(self) -> &'static str {
        match self {
            Provider::Anthropic => "claude-sonnet-5",
            Provider::OpenAi => "gpt-4.1",
            Provider::Kimi => "kimi-latest",
        }
    }

    /// Where the user creates an API key. Fixed here rather than passed in
    /// from the webview, so this can never become an open redirect into the
    /// user's browser.
    pub fn key_url(self) -> &'static str {
        match self {
            Provider::Anthropic => "https://console.anthropic.com/settings/keys",
            Provider::OpenAi => "https://platform.openai.com/api-keys",
            Provider::Kimi => "https://platform.moonshot.ai/console/api-keys",
        }
    }

    /// Keychain entry name / config-file suffix for this provider's key.
    /// Anthropic keeps the original slot so existing installs keep their key.
    pub fn key_slot(self) -> &'static str {
        match self {
            Provider::Anthropic => "anthropic-api-key",
            Provider::OpenAi => "openai-api-key",
            Provider::Kimi => "kimi-api-key",
        }
    }

    fn anthropic_wire(self) -> bool {
        self == Provider::Anthropic
    }

    fn auth(self, req: reqwest::RequestBuilder, key: &str) -> reqwest::RequestBuilder {
        if self.anthropic_wire() {
            req.header("x-api-key", key)
                .header("anthropic-version", "2023-06-01")
        } else {
            req.header("authorization", format!("Bearer {key}"))
        }
    }
}

#[derive(Clone, Debug)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub input: Value,
}

#[derive(Clone, Debug)]
pub struct ToolResult {
    pub id: String,
    pub name: String,
    pub content: String,
}

/// Provider-neutral conversation history.
#[derive(Clone, Debug)]
pub enum Msg {
    User(String),
    Assistant { text: String, calls: Vec<ToolCall> },
    ToolResults(Vec<ToolResult>),
}

/// One model reply, already normalised.
pub struct Turn {
    pub text: String,
    pub calls: Vec<ToolCall>,
}

/// A tool the model may call. `schema` is a JSON Schema object.
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    pub schema: Value,
}

/// Read the tool list in the Anthropic shape used throughout the agent
/// (`[{name, description, input_schema}]`) into neutral specs.
pub fn tool_specs(tools: &Value) -> Vec<ToolSpec> {
    tools
        .as_array()
        .map(|a| {
            a.iter()
                .map(|t| ToolSpec {
                    name: t["name"].as_str().unwrap_or_default().to_string(),
                    description: t["description"].as_str().unwrap_or_default().to_string(),
                    schema: t["input_schema"].clone(),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn encode_tools(provider: Provider, specs: &[ToolSpec]) -> Value {
    if provider.anthropic_wire() {
        Value::Array(
            specs
                .iter()
                .map(|s| {
                    json!({
                        "name": s.name,
                        "description": s.description,
                        "input_schema": s.schema,
                    })
                })
                .collect(),
        )
    } else {
        Value::Array(
            specs
                .iter()
                .map(|s| {
                    json!({
                        "type": "function",
                        "function": {
                            "name": s.name,
                            "description": s.description,
                            "parameters": s.schema,
                        },
                    })
                })
                .collect(),
        )
    }
}

fn encode_messages(provider: Provider, system: &str, history: &[Msg]) -> Vec<Value> {
    let mut out: Vec<Value> = vec![];
    // Anthropic carries the system prompt in its own top-level field; the
    // OpenAI format wants it as the first message.
    if !provider.anthropic_wire() && !system.is_empty() {
        out.push(json!({"role": "system", "content": system}));
    }
    for m in history {
        match m {
            Msg::User(text) => out.push(json!({"role": "user", "content": text})),
            Msg::Assistant { text, calls } => {
                if provider.anthropic_wire() {
                    let mut blocks: Vec<Value> = vec![];
                    if !text.is_empty() {
                        blocks.push(json!({"type": "text", "text": text}));
                    }
                    for c in calls {
                        blocks.push(json!({
                            "type": "tool_use",
                            "id": c.id,
                            "name": c.name,
                            "input": c.input,
                        }));
                    }
                    out.push(json!({"role": "assistant", "content": blocks}));
                } else {
                    let mut msg = json!({"role": "assistant"});
                    // OpenAI rejects an assistant turn with neither content nor
                    // tool_calls, and wants null (not "") when only calling tools.
                    msg["content"] = if text.is_empty() {
                        Value::Null
                    } else {
                        json!(text)
                    };
                    if !calls.is_empty() {
                        msg["tool_calls"] = Value::Array(
                            calls
                                .iter()
                                .map(|c| {
                                    json!({
                                        "id": c.id,
                                        "type": "function",
                                        "function": {
                                            "name": c.name,
                                            "arguments": c.input.to_string(),
                                        },
                                    })
                                })
                                .collect(),
                        );
                    }
                    out.push(msg);
                }
            }
            Msg::ToolResults(results) => {
                if provider.anthropic_wire() {
                    // all results for one assistant turn ride in a single user message
                    out.push(json!({
                        "role": "user",
                        "content": results
                            .iter()
                            .map(|r| json!({
                                "type": "tool_result",
                                "tool_use_id": r.id,
                                "content": r.content,
                            }))
                            .collect::<Vec<_>>(),
                    }));
                } else {
                    // OpenAI wants one message per result
                    for r in results {
                        out.push(json!({
                            "role": "tool",
                            "tool_call_id": r.id,
                            "name": r.name,
                            "content": r.content,
                        }));
                    }
                }
            }
        }
    }
    out
}

fn parse_turn(provider: Provider, data: &Value) -> Turn {
    if provider.anthropic_wire() {
        let mut text = String::new();
        let mut calls = vec![];
        for block in data["content"].as_array().unwrap_or(&vec![]) {
            match block["type"].as_str() {
                Some("text") => {
                    if let Some(t) = block["text"].as_str() {
                        if !text.is_empty() {
                            text.push('\n');
                        }
                        text.push_str(t);
                    }
                }
                Some("tool_use") => calls.push(ToolCall {
                    id: block["id"].as_str().unwrap_or_default().to_string(),
                    name: block["name"].as_str().unwrap_or_default().to_string(),
                    input: block["input"].clone(),
                }),
                _ => {}
            }
        }
        Turn { text, calls }
    } else {
        let msg = &data["choices"][0]["message"];
        let text = msg["content"].as_str().unwrap_or_default().to_string();
        let calls = msg["tool_calls"]
            .as_array()
            .map(|a| {
                a.iter()
                    .map(|c| ToolCall {
                        id: c["id"].as_str().unwrap_or_default().to_string(),
                        name: c["function"]["name"]
                            .as_str()
                            .unwrap_or_default()
                            .to_string(),
                        // arguments arrive as a JSON *string*; a model can emit
                        // malformed JSON there, so fall back to an empty object
                        // rather than failing the whole turn.
                        input: c["function"]["arguments"]
                            .as_str()
                            .and_then(|s| serde_json::from_str(s).ok())
                            .unwrap_or_else(|| json!({})),
                    })
                    .collect()
            })
            .unwrap_or_default();
        Turn { text, calls }
    }
}

fn error_message(provider: Provider, status: reqwest::StatusCode, data: &Value) -> String {
    let msg = data["error"]["message"]
        .as_str()
        .or_else(|| data["message"].as_str())
        .unwrap_or("API error");
    format!("{} API {status}: {msg}", provider.label())
}

/// Send one request and return the model's reply.
///
/// `tools` may be empty for the one-shot helpers (summary, ask, expand).
pub async fn complete(
    provider: Provider,
    api_key: &str,
    model: &str,
    system: &str,
    history: &[Msg],
    tools: &[ToolSpec],
    max_tokens: u32,
) -> Result<Turn, String> {
    let client = reqwest::Client::new();
    let url = format!(
        "{}/{}",
        provider.base_url(),
        if provider.anthropic_wire() {
            "messages"
        } else {
            "chat/completions"
        }
    );
    let messages = encode_messages(provider, system, history);

    let mut body = json!({
        "model": model,
        "messages": messages,
    });
    if provider.anthropic_wire() {
        body["system"] = json!(system);
        body["max_tokens"] = json!(max_tokens);
    } else {
        // Recent OpenAI models reject `max_tokens` and want
        // `max_completion_tokens`; Moonshot only knows `max_tokens`. Start with
        // each provider's documented field and swap on a 400 that names it.
        body[openai_token_field(provider)] = json!(max_tokens);
    }
    if !tools.is_empty() {
        body["tools"] = encode_tools(provider, tools);
    }

    let mut attempt = 0;
    loop {
        let resp = provider
            .auth(client.post(&url), api_key)
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("network: {e}"))?;

        let status = resp.status();
        let data: Value = resp.json().await.map_err(|e| e.to_string())?;
        if status.is_success() {
            return Ok(parse_turn(provider, &data));
        }

        let msg = error_message(provider, status, &data);
        let sent = openai_token_field(provider);
        let other = if sent == "max_tokens" {
            "max_completion_tokens"
        } else {
            "max_tokens"
        };
        if attempt == 0 && !provider.anthropic_wire() && status == 400 && msg.contains(sent) {
            body.as_object_mut().map(|o| o.remove(sent));
            body[other] = json!(max_tokens);
            attempt += 1;
            continue;
        }
        return Err(msg);
    }
}

fn openai_token_field(provider: Provider) -> &'static str {
    match provider {
        Provider::OpenAi => "max_completion_tokens",
        _ => "max_tokens",
    }
}

/// Convenience wrapper for the one-shot, tool-free calls: returns just the text.
pub async fn complete_text(
    provider: Provider,
    api_key: &str,
    model: &str,
    system: &str,
    user: &str,
    max_tokens: u32,
) -> Result<String, String> {
    let turn = complete(
        provider,
        api_key,
        model,
        system,
        &[Msg::User(user.to_string())],
        &[],
        max_tokens,
    )
    .await?;
    Ok(turn.text.trim().to_string())
}

/// Model ids the key can actually use, newest-looking first.
///
/// Fetched rather than hardcoded: provider line-ups move faster than releases
/// of this app, and a stale hardcoded id is an error the user cannot fix from
/// the UI.
pub async fn list_models(provider: Provider, api_key: &str) -> Result<Vec<String>, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/models", provider.base_url());
    let resp = provider
        .auth(client.get(&url), api_key)
        .send()
        .await
        .map_err(|e| format!("network: {e}"))?;

    let status = resp.status();
    let data: Value = resp.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(error_message(provider, status, &data));
    }

    let mut ids: Vec<String> = data["data"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|m| m["id"].as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    // OpenAI's list also carries embeddings, audio and image models, which
    // would just be broken choices in a chat picker.
    if provider == Provider::OpenAi {
        let chat: Vec<String> = ids
            .iter()
            .filter(|id| {
                let id = id.as_str();
                (id.starts_with("gpt") || id.starts_with("chatgpt") || is_o_series(id))
                    && !id.contains("audio")
                    && !id.contains("realtime")
                    && !id.contains("transcribe")
                    && !id.contains("tts")
                    && !id.contains("image")
                    && !id.contains("search")
                    && !id.contains("embedding")
                    && !id.contains("moderation")
            })
            .cloned()
            .collect();
        if !chat.is_empty() {
            ids = chat;
        }
    }

    ids.sort();
    ids.dedup();
    ids.reverse(); // newer ids sort later, so show them first
    Ok(ids)
}

/// `o1`, `o3`, `o4-mini`, … — reasoning models, chat-capable.
fn is_o_series(id: &str) -> bool {
    let mut chars = id.chars();
    chars.next() == Some('o') && chars.next().is_some_and(|c| c.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_provider_id_falls_back_to_anthropic() {
        assert_eq!(Provider::from_id("nope"), Provider::Anthropic);
        assert_eq!(Provider::from_id("ChatGPT"), Provider::OpenAi);
        assert_eq!(Provider::from_id("moonshot"), Provider::Kimi);
    }

    #[test]
    fn anthropic_keeps_the_original_key_slot() {
        assert_eq!(Provider::Anthropic.key_slot(), "anthropic-api-key");
    }

    #[test]
    fn openai_tool_results_become_one_message_each() {
        let history = vec![Msg::ToolResults(vec![
            ToolResult {
                id: "a".into(),
                name: "doc_search".into(),
                content: "1".into(),
            },
            ToolResult {
                id: "b".into(),
                name: "read_file".into(),
                content: "2".into(),
            },
        ])];
        let out = encode_messages(Provider::OpenAi, "sys", &history);
        // system + one message per tool result
        assert_eq!(out.len(), 3);
        assert_eq!(out[1]["role"], "tool");
        assert_eq!(out[1]["tool_call_id"], "a");
        assert_eq!(out[2]["tool_call_id"], "b");
    }

    #[test]
    fn anthropic_tool_results_ride_in_one_user_message() {
        let history = vec![Msg::ToolResults(vec![
            ToolResult {
                id: "a".into(),
                name: "doc_search".into(),
                content: "1".into(),
            },
            ToolResult {
                id: "b".into(),
                name: "read_file".into(),
                content: "2".into(),
            },
        ])];
        let out = encode_messages(Provider::Anthropic, "sys", &history);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["role"], "user");
        assert_eq!(out[0]["content"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn tool_call_arguments_round_trip_through_the_openai_string_form() {
        let calls = vec![ToolCall {
            id: "c1".into(),
            name: "doc_search".into(),
            input: json!({"query": "facture", "limit": 5}),
        }];
        let history = vec![Msg::Assistant {
            text: String::new(),
            calls,
        }];
        let out = encode_messages(Provider::OpenAi, "", &history);
        let args = out[0]["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(args).unwrap()["query"],
            "facture"
        );
        assert!(out[0]["content"].is_null());
    }

    #[test]
    fn openai_reply_with_malformed_tool_arguments_still_parses() {
        let data = json!({"choices": [{"message": {
            "content": "",
            "tool_calls": [{"id": "x", "type": "function",
                            "function": {"name": "doc_search", "arguments": "{oops"}}]
        }}]});
        let turn = parse_turn(Provider::OpenAi, &data);
        assert_eq!(turn.calls.len(), 1);
        assert_eq!(turn.calls[0].input, json!({}));
    }

    #[test]
    fn o_series_detection_does_not_catch_ordinary_names() {
        assert!(is_o_series("o3-mini"));
        assert!(is_o_series("o1"));
        assert!(!is_o_series("omni-moderation-latest"));
    }

    /// Serve one canned JSON response and hand back the request we received.
    fn one_shot_server(body: &'static str) -> (String, std::sync::mpsc::Receiver<String>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            let mut buf = [0u8; 65536];
            let n = sock.read(&mut buf).unwrap();
            let _ = tx.send(String::from_utf8_lossy(&buf[..n]).into_owned());
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\
                 Content-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = sock.write_all(resp.as_bytes());
        });
        (format!("http://127.0.0.1:{port}"), rx)
    }

    fn specs() -> Vec<ToolSpec> {
        vec![ToolSpec {
            name: "doc_search".into(),
            description: "search".into(),
            schema: json!({"type": "object", "properties": {"query": {"type": "string"}}}),
        }]
    }

    // The env override is process-global, so these two share a lock rather
    // than racing each other under the test harness's thread pool.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[tokio::test]
    async fn openai_request_carries_function_tools_and_parses_a_tool_call() {
        let _guard = ENV_LOCK.lock().unwrap();
        let (url, rx) = one_shot_server(
            r#"{"choices":[{"message":{"content":null,"tool_calls":[
                {"id":"call_1","type":"function",
                 "function":{"name":"doc_search","arguments":"{\"query\":\"facture\"}"}}]},
              "finish_reason":"tool_calls"}]}"#,
        );
        std::env::set_var("DOCFINDY_OPENAI_BASE_URL", &url);
        let turn = complete(
            Provider::OpenAi,
            "k",
            "gpt-4.1",
            "sys",
            &[Msg::User("trouve ma facture".into())],
            &specs(),
            256,
        )
        .await
        .unwrap();
        std::env::remove_var("DOCFINDY_OPENAI_BASE_URL");

        let req = rx.recv().unwrap();
        assert!(req.starts_with("POST /chat/completions"), "{req}");
        assert!(req.contains("authorization: Bearer k"), "{req}");
        let body: Value = serde_json::from_str(req.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(body["tools"][0]["type"], "function");
        assert_eq!(body["tools"][0]["function"]["name"], "doc_search");
        assert_eq!(body["messages"][0]["role"], "system");
        assert!(body["max_completion_tokens"].is_number());

        assert_eq!(turn.calls.len(), 1);
        assert_eq!(turn.calls[0].name, "doc_search");
        assert_eq!(turn.calls[0].input["query"], "facture");
    }

    #[tokio::test]
    async fn anthropic_request_keeps_system_top_level_and_parses_tool_use() {
        let _guard = ENV_LOCK.lock().unwrap();
        let (url, rx) = one_shot_server(
            r#"{"content":[{"type":"text","text":"ok"},
                {"type":"tool_use","id":"tu_1","name":"doc_search",
                 "input":{"query":"facture"}}],"stop_reason":"tool_use"}"#,
        );
        std::env::set_var("DOCFINDY_ANTHROPIC_BASE_URL", &url);
        let turn = complete(
            Provider::Anthropic,
            "k",
            "claude-sonnet-5",
            "sys",
            &[Msg::User("trouve ma facture".into())],
            &specs(),
            256,
        )
        .await
        .unwrap();
        std::env::remove_var("DOCFINDY_ANTHROPIC_BASE_URL");

        let req = rx.recv().unwrap();
        assert!(req.starts_with("POST /messages"), "{req}");
        assert!(req.contains("x-api-key: k"), "{req}");
        let body: Value = serde_json::from_str(req.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(body["system"], "sys");
        assert_eq!(body["tools"][0]["name"], "doc_search");
        assert!(body["tools"][0]["input_schema"].is_object());
        assert_eq!(body["messages"][0]["role"], "user");

        assert_eq!(turn.text, "ok");
        assert_eq!(turn.calls[0].input["query"], "facture");
    }
}
