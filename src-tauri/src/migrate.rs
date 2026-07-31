//! One-shot migration from the pre-rename identity (`com.guillaume.findy`).
//!
//! The rename to DocFindy changed the bundle identifier, which moves the
//! config dir, the data dir (settings, index) and the keychain service name.
//! Without this, existing installs silently lose their settings, their whole
//! index, and their stored API key. Runs on every startup; a no-op once the
//! new locations exist, and a no-op on fresh installs.

use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;

const OLD_IDENTIFIER: &str = "com.guillaume.findy";

pub fn run(app: &tauri::AppHandle) {
    if let Ok(new) = app.path().app_config_dir() {
        migrate_dir(&sibling(&new, OLD_IDENTIFIER), &new);
    }
    if let Ok(new) = app.path().app_data_dir() {
        migrate_dir(&sibling(&new, OLD_IDENTIFIER), &new);
    }
    migrate_keyring();
}

/// Same parent directory, old identifier as the leaf. Every platform Tauri
/// supports derives these dirs as `<base>/<identifier>`.
fn sibling(new: &Path, old_leaf: &str) -> PathBuf {
    match new.parent() {
        Some(parent) => parent.join(old_leaf),
        None => PathBuf::from(old_leaf),
    }
}

fn is_empty_dir(p: &Path) -> bool {
    fs::read_dir(p).map(|mut d| d.next().is_none()).unwrap_or(false)
}

fn migrate_dir(old: &Path, new: &Path) {
    if !old.is_dir() || old == new {
        return;
    }
    // Already migrated, or the user has real data under the new identity.
    if new.is_dir() && !is_empty_dir(new) {
        return;
    }
    // `rename` onto an existing dir fails on Windows; drop the empty placeholder.
    if new.is_dir() {
        let _ = fs::remove_dir(new);
    }
    if let Some(parent) = new.parent() {
        let _ = fs::create_dir_all(parent);
    }

    if fs::rename(old, new).is_ok() {
        eprintln!("migrated {} -> {}", old.display(), new.display());
        return;
    }
    // Different filesystems (rename gives EXDEV): fall back to copy + remove.
    match copy_tree(old, new) {
        Ok(()) => {
            let _ = fs::remove_dir_all(old);
            eprintln!("migrated (copy) {} -> {}", old.display(), new.display());
        }
        Err(e) => {
            // Leave the old dir untouched so the data is still recoverable.
            let _ = fs::remove_dir_all(new);
            eprintln!("migration failed for {}: {e}", old.display());
        }
    }
}

fn copy_tree(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in walkdir::WalkDir::new(src) {
        let entry = entry.map_err(std::io::Error::other)?;
        let rel = match entry.path().strip_prefix(src) {
            Ok(r) if r.as_os_str().is_empty() => continue,
            Ok(r) => r,
            Err(_) => continue,
        };
        let target = dst.join(rel);
        if entry.file_type().is_dir() {
            fs::create_dir_all(&target)?;
        } else {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

/// Move the API key to the renamed keychain service, then drop the old entry
/// so no secret is left behind under a name nothing reads anymore.
fn migrate_keyring() {
    let (new_service, user) = (crate::secrets::SERVICE, crate::secrets::USER);
    if new_service == OLD_IDENTIFIER {
        return;
    }
    let Ok(new_entry) = keyring::Entry::new(new_service, user) else {
        return;
    };
    if matches!(new_entry.get_password(), Ok(pw) if !pw.is_empty()) {
        return;
    }
    let Ok(old_entry) = keyring::Entry::new(OLD_IDENTIFIER, user) else {
        return;
    };
    let Ok(pw) = old_entry.get_password() else {
        return;
    };
    if pw.is_empty() {
        return;
    }
    if new_entry.set_password(&pw).is_ok() {
        let _ = old_entry.delete_credential();
        eprintln!("migrated API key to keychain service {new_service}");
    }
}
