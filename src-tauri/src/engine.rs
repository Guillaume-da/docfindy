//! findy-engine sidecar (document indexer). Resolution order:
//! 1. FINDY_ENGINE env var — dev override, e.g.
//!    `FINDY_ENGINE="/home/g/projects/findy/engine/.venv/bin/python /home/g/projects/findy/engine/main.py"`
//! 2. sidecar binary next to the app executable (production bundle)
//! 3. `findy-engine` on PATH

use std::path::PathBuf;
use std::process::Stdio;
use tauri::{Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

fn engine_command() -> (String, Vec<String>) {
    if let Ok(dev) = std::env::var("FINDY_ENGINE") {
        let mut parts = dev.split_whitespace().map(String::from);
        let prog = parts.next().unwrap_or_else(|| "findy-engine".into());
        return (prog, parts.collect());
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let name = if cfg!(windows) { "findy-engine.exe" } else { "findy-engine" };
            let p = dir.join(name);
            if p.exists() {
                return (p.to_string_lossy().into_owned(), vec![]);
            }
        }
    }
    ("findy-engine".into(), vec![])
}

/// Index output directory: `<app_data_dir>/graphify-out`
pub fn index_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("graphify-out");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Run the engine, forward stderr JSON lines to the UI as `index-progress`
/// events, return parsed stdout JSON.
pub async fn run(
    app: &tauri::AppHandle,
    args: &[String],
    emit_progress: bool,
) -> Result<serde_json::Value, String> {
    let (prog, mut base) = engine_command();
    base.extend(args.iter().cloned());

    let mut child = Command::new(&prog)
        .args(&base)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("engine spawn failed ({prog}): {e}"))?;

    let stderr = child.stderr.take().unwrap();
    let app2 = app.clone();
    let stderr_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        let mut tail: Vec<String> = vec![];
        while let Ok(Some(line)) = lines.next_line().await {
            if emit_progress {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                    let _ = app2.emit("index-progress", v);
                    continue;
                }
            }
            tail.push(line);
            if tail.len() > 20 {
                tail.remove(0);
            }
        }
        tail.join("\n")
    });

    let mut stdout = String::new();
    {
        use tokio::io::AsyncReadExt;
        let mut out = child.stdout.take().unwrap();
        out.read_to_string(&mut stdout).await.map_err(|e| e.to_string())?;
    }
    let status = child.wait().await.map_err(|e| e.to_string())?;
    let err_tail = stderr_task.await.unwrap_or_default();

    if !status.success() {
        return Err(format!("engine failed: {err_tail}"));
    }
    serde_json::from_str(stdout.trim())
        .map_err(|e| format!("engine returned invalid JSON: {e}\n{stdout}"))
}
