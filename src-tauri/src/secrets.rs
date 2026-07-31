//! API key storage: OS keychain first (Windows Credential Manager, macOS
//! Keychain, Secret Service), plain file in the app config dir as fallback
//! (WSL/headless Linux often has no Secret Service daemon).

use std::fs;
use std::path::PathBuf;
use tauri::Manager;

pub(crate) const SERVICE: &str = "com.guillaume.docfindy";
pub(crate) const USER: &str = "anthropic-api-key";

fn fallback_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    fs::create_dir_all(&dir).ok()?;
    Some(dir.join("api_key"))
}

pub fn set(app: &tauri::AppHandle, key: &str) -> Result<(), String> {
    if let Ok(entry) = keyring::Entry::new(SERVICE, USER) {
        if entry.set_password(key).is_ok() {
            // key moved to the keychain: drop any stale fallback copy
            if let Some(p) = fallback_path(app) {
                let _ = fs::remove_file(p);
            }
            return Ok(());
        }
    }
    let p = fallback_path(app).ok_or("no config dir")?;
    fs::write(&p, key).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&p, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

pub fn get(app: &tauri::AppHandle) -> Option<String> {
    if let Ok(entry) = keyring::Entry::new(SERVICE, USER) {
        if let Ok(pw) = entry.get_password() {
            if !pw.is_empty() {
                return Some(pw);
            }
        }
    }
    fallback_path(app)
        .and_then(|p| fs::read_to_string(p).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}
