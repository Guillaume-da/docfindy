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
    fs::write(&p, key).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&p, fs::Permissions::from_mode(0o600));
    }
    #[cfg(windows)]
    {
        // No mode bits here: the file inherits the config dir's ACL, which is
        // per-user under %APPDATA% but is not an equivalent of 0600. Mark it
        // hidden so it is at least not stumbled upon; the keychain is the
        // primary store and this path is only reached when it fails.
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
        let _ = fs::OpenOptions::new()
            .write(true)
            .attributes(FILE_ATTRIBUTE_HIDDEN)
            .open(&p);
    }
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
