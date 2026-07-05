//! Filesystem probe with token-compressed output.
//!
//! Tries the bundled `rtk` sidecar first (`rtk find …` — compressed output,
//! 60-90% fewer tokens fed back into the Claude context). Falls back to a
//! built-in walkdir scan with rtk-style compression (common-prefix folding,
//! hard result cap) when rtk is unavailable.

use std::path::Path;
use tokio::process::Command;
use walkdir::WalkDir;

const MAX_RESULTS: usize = 80;

fn rtk_program() -> Option<String> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let name = if cfg!(windows) { "rtk.exe" } else { "rtk" };
            let p = dir.join(name);
            if p.exists() {
                return Some(p.to_string_lossy().into_owned());
            }
        }
    }
    which("rtk")
}

fn which(bin: &str) -> Option<String> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let p = dir.join(if cfg!(windows) { format!("{bin}.exe") } else { bin.into() });
        if p.is_file() {
            return Some(p.to_string_lossy().into_owned());
        }
    }
    None
}

pub async fn probe(dir: &str, pattern: &str) -> String {
    // sanitize: pattern is a filename fragment, never a shell expression
    let pat: String = pattern
        .chars()
        .filter(|c| !matches!(c, ';' | '|' | '&' | '`' | '$' | '\n'))
        .collect();

    if let Some(rtk) = rtk_program() {
        let mut cmd = Command::new(&rtk);
        cmd.args(["find", dir, "-iname", &format!("*{pat}*"), "-type", "f"]);
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        let out = cmd.output().await;
        if let Ok(o) = out {
            if o.status.success() {
                let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
                if !s.is_empty() {
                    return s;
                }
            }
        }
    }
    walk_probe(dir, &pat)
}

/// Built-in fallback: case-insensitive substring match on filenames,
/// compressed rtk-style (fold the common root, cap results).
fn walk_probe(dir: &str, pattern: &str) -> String {
    let needle = pattern.to_lowercase();
    let root = Path::new(dir);
    let mut hits: Vec<String> = vec![];
    let mut scanned = 0usize;

    for entry in WalkDir::new(root)
        .follow_links(false)
        .max_depth(12)
        .into_iter()
        .filter_entry(|e| {
            let n = e.file_name().to_string_lossy();
            !(n.starts_with('.') || n == "node_modules" || n == "target" || n == "__pycache__")
        })
        .filter_map(|e| e.ok())
    {
        scanned += 1;
        if scanned > 200_000 || hits.len() >= MAX_RESULTS {
            break;
        }
        if !entry.file_type().is_file() {
            continue;
        }
        if entry.file_name().to_string_lossy().to_lowercase().contains(&needle) {
            let p = entry.path().strip_prefix(root).unwrap_or(entry.path());
            hits.push(p.to_string_lossy().into_owned());
        }
    }

    if hits.is_empty() {
        return format!("0 hits for '{pattern}' under {dir}");
    }
    let truncated = if hits.len() >= MAX_RESULTS { " (truncated)" } else { "" };
    format!("root={dir}{truncated}\n{}", hits.join("\n"))
}
