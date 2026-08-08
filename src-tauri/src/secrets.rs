//! API key storage, one key per provider: OS keychain first (Windows
//! Credential Manager, macOS Keychain, Secret Service), plain file in the app
//! config dir as fallback (WSL/headless Linux often has no Secret Service
//! daemon).

use std::fs;
use std::path::PathBuf;
use tauri::Manager;

use crate::provider::Provider;

pub(crate) const SERVICE: &str = "com.guillaume.docfindy";
pub(crate) const USER: &str = "anthropic-api-key";

/// Anthropic keeps the original unsuffixed filename so keys written before
/// multi-provider support are still found after an update.
fn fallback_path(app: &tauri::AppHandle, prov: Provider) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    fs::create_dir_all(&dir).ok()?;
    Some(match prov {
        Provider::Anthropic => dir.join("api_key"),
        other => dir.join(format!("api_key_{}", other.id())),
    })
}

pub fn set(app: &tauri::AppHandle, prov: Provider, key: &str) -> Result<(), String> {
    if let Ok(entry) = keyring::Entry::new(SERVICE, prov.key_slot()) {
        if entry.set_password(key).is_ok() {
            // key moved to the keychain: drop any stale fallback copy
            if let Some(p) = fallback_path(app, prov) {
                let _ = fs::remove_file(p);
            }
            return Ok(());
        }
    }
    let p = fallback_path(app, prov).ok_or("no config dir")?;
    #[cfg(windows)]
    {
        // No mode bits here: the file inherits the config dir's ACL, which is
        // per-user under %APPDATA% but is not an equivalent of 0600. Mark it
        // hidden so it is at least not stumbled upon; the keychain is the
        // primary store and this path is only reached when it fails.
        //
        // The attribute has to be set by the call that *creates* the file —
        // applied to an open of an existing file it is ignored, so writing
        // first and re-opening afterwards would leave the key in plain sight.
        use std::io::Write;
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .attributes(FILE_ATTRIBUTE_HIDDEN)
            .open(&p)
            .map_err(|e| e.to_string())?;
        f.write_all(key.as_bytes()).map_err(|e| e.to_string())?;
    }
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        // Created 0600 rather than fixed up afterwards: a write-then-chmod
        // leaves the key world-readable for the width of that gap.
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true).mode(0o600);
        let mut f = opts.open(&p).map_err(|e| e.to_string())?;
        f.write_all(key.as_bytes()).map_err(|e| e.to_string())?;
        // an existing file keeps its old mode: set it explicitly too
        let _ = fs::set_permissions(&p, fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(any(unix, windows)))]
    fs::write(&p, key).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn get(app: &tauri::AppHandle, prov: Provider) -> Option<String> {
    if let Ok(entry) = keyring::Entry::new(SERVICE, prov.key_slot()) {
        if let Ok(pw) = entry.get_password() {
            if !pw.is_empty() {
                return Some(pw);
            }
        }
    }
    fallback_path(app, prov)
        .and_then(|p| fs::read_to_string(p).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}
