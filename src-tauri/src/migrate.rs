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

fn migrate_dir(old: &Path, new: &Path) {
    if !old.is_dir() || old == new {
        return;
    }
    if let Some(parent) = new.parent() {
        let _ = fs::create_dir_all(parent);
    }

    // Nothing at the new location yet: move the whole tree in one go.
    if !new.exists() && fs::rename(old, new).is_ok() {
        eprintln!("migrated {} -> {}", old.display(), new.display());
        return;
    }

    // The new directory usually already exists by the time this runs: the
    // webview creates its own caches under the new identifier before
    // `setup()` is called. A whole-directory move is therefore not enough and
    // "new dir is non-empty" does not mean "already migrated" — that test
    // would skip the index and silently lose it. Merge entry by entry
    // instead, keeping anything the new location already has.
    if !merge_into(old, new) {
        // Leave the old directory alone so the data stays recoverable.
        eprintln!(
            "migration incomplete for {}, old data left in place",
            old.display()
        );
        return;
    }
    // Every entry either moved or already had a counterpart under the new
    // name, so what is left here is redundant.
    let _ = fs::remove_dir_all(old);
    eprintln!("migrated {} -> {}", old.display(), new.display());
}

/// Move each entry of `old` that has no counterpart in `new`. Returns false if
/// any entry could not be moved.
fn merge_into(old: &Path, new: &Path) -> bool {
    if fs::create_dir_all(new).is_err() {
        return false;
    }
    let Ok(entries) = fs::read_dir(old) else {
        return false;
    };
    let mut ok = true;
    for entry in entries.flatten() {
        let src = entry.path();
        let dst = new.join(entry.file_name());
        if dst.exists() {
            continue;
        }
        if fs::rename(&src, &dst).is_ok() {
            continue;
        }
        // Different filesystems (rename gives EXDEV): copy instead.
        let copied = if src.is_dir() {
            copy_tree(&src, &dst).is_ok()
        } else {
            fs::copy(&src, &dst).is_ok()
        };
        if copied {
            let _ = if src.is_dir() {
                fs::remove_dir_all(&src)
            } else {
                fs::remove_file(&src)
            };
        } else {
            let _ = fs::remove_dir_all(&dst);
            eprintln!("could not migrate {}", src.display());
            ok = false;
        }
    }
    ok
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
