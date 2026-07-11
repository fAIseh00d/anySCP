//! OS-agnostic local-filesystem operations. Async (tokio) so they don't block
//! the Tauri command threads; platform differences are delegated to `platform`.
//!
//! Cancel-safety: `list_dir`, `mkdir`, `create_file`, and `rename` are each a
//! single OS syscall (`rename` is atomic), so dropping the future mid-`.await`
//! leaves no partial state. `delete` via `remove_dir_all` is NOT cancel-safe —
//! a dropped future can leave a partially-removed tree — but Tauri drives these
//! commands to completion, so a cancelled delete isn't a concern here.

use std::path::Path;
use std::time::UNIX_EPOCH;

use crate::sftp::format_permissions;

use super::platform;
use super::types::{LocalEntry, LocalEntryType, LocalError};

fn modified_secs(meta: &std::fs::Metadata) -> Option<u64> {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
}

/// Build a `LocalEntry` from a path and its (possibly-followed) metadata.
/// `symlink_is` reports whether the path itself is a symlink; `followed` is the
/// metadata after following it (`None` for a broken link).
fn build_entry(
    name: String,
    full_path: &Path,
    symlink_is: bool,
    followed: Option<&std::fs::Metadata>,
) -> LocalEntry {
    let (entry_type, size, permissions, modified) = match followed {
        Some(meta) => {
            let ty = if meta.is_dir() {
                LocalEntryType::Directory
            } else if meta.is_file() {
                LocalEntryType::File
            } else {
                LocalEntryType::Other
            };
            (ty, meta.len(), platform::mode_of(meta), modified_secs(meta))
        }
        // Broken symlink or unreadable target.
        None => (LocalEntryType::Symlink, 0, 0, None),
    };

    let permissions_display = if permissions == 0 {
        String::new()
    } else {
        format_permissions(permissions)
    };

    LocalEntry {
        name,
        path: full_path.to_string_lossy().into_owned(),
        entry_type,
        size,
        permissions,
        permissions_display,
        modified,
        is_symlink: symlink_is,
    }
}

/// List a local directory. Entries whose target metadata can't be read are
/// still returned (best-effort), matching how the remote listing tolerates gaps.
pub async fn list_dir(path: &str) -> Result<Vec<LocalEntry>, LocalError> {
    let followed = tokio::fs::metadata(path).await?;
    if !followed.is_dir() {
        return Err(LocalError::NotADirectory(path.to_string()));
    }

    let mut read_dir = tokio::fs::read_dir(path).await?;
    let mut entries = Vec::new();
    while let Some(entry) = read_dir.next_entry().await? {
        let full_path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();

        // symlink_metadata never follows, so it reveals whether the entry itself
        // is a link; metadata() follows it to resolve the real type/size.
        let symlink_is = tokio::fs::symlink_metadata(&full_path)
            .await
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false);
        let followed = tokio::fs::metadata(&full_path).await.ok();

        entries.push(build_entry(name, &full_path, symlink_is, followed.as_ref()));
    }
    Ok(entries)
}

/// The current user's home directory as an absolute path.
pub fn home_dir() -> Result<String, LocalError> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .ok_or_else(|| LocalError::NotFound("home directory".into()))
}

pub async fn mkdir(path: &str) -> Result<(), LocalError> {
    if path.trim().is_empty() {
        return Err(LocalError::InvalidPath(path.to_string()));
    }
    tokio::fs::create_dir(path).await?;
    Ok(())
}

pub async fn create_file(path: &str) -> Result<(), LocalError> {
    if path.trim().is_empty() {
        return Err(LocalError::InvalidPath(path.to_string()));
    }
    // create_new fails if it already exists, so we never clobber a real file.
    tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .await?;
    Ok(())
}

pub async fn delete(path: &str, is_dir: bool) -> Result<(), LocalError> {
    if is_dir {
        tokio::fs::remove_dir_all(path).await?;
    } else {
        tokio::fs::remove_file(path).await?;
    }
    Ok(())
}

pub async fn rename(old_path: &str, new_path: &str) -> Result<(), LocalError> {
    tokio::fs::rename(old_path, new_path).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn lists_files_and_dirs_with_types() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        tokio::fs::create_dir(root.join("sub")).await.unwrap();
        tokio::fs::write(root.join("a.txt"), b"hello").await.unwrap();

        let mut entries = list_dir(root.to_str().unwrap()).await.unwrap();
        entries.sort_by(|a, b| a.name.cmp(&b.name));
        assert_eq!(entries.len(), 2);

        let file = entries.iter().find(|e| e.name == "a.txt").unwrap();
        assert_eq!(file.entry_type, LocalEntryType::File);
        assert_eq!(file.size, 5);
        assert!(!file.is_symlink);

        let dir = entries.iter().find(|e| e.name == "sub").unwrap();
        assert_eq!(dir.entry_type, LocalEntryType::Directory);
    }

    #[tokio::test]
    async fn list_dir_rejects_a_file() {
        let tmp = tempfile::tempdir().unwrap();
        let f = tmp.path().join("f.txt");
        tokio::fs::write(&f, b"x").await.unwrap();
        let err = list_dir(f.to_str().unwrap()).await.unwrap_err();
        assert!(matches!(err, LocalError::NotADirectory(_)));
    }

    #[tokio::test]
    async fn list_dir_missing_path_is_not_found() {
        let tmp = tempfile::tempdir().unwrap();
        let missing = tmp.path().join("nope");
        let err = list_dir(missing.to_str().unwrap()).await.unwrap_err();
        assert!(matches!(err, LocalError::NotFound(_)));
    }

    #[tokio::test]
    async fn mkdir_create_rename_delete_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();

        let dir = root.join("d");
        mkdir(dir.to_str().unwrap()).await.unwrap();
        assert!(dir.is_dir());

        let file = root.join("n.txt");
        create_file(file.to_str().unwrap()).await.unwrap();
        assert!(file.is_file());

        // create_file must not clobber an existing file.
        assert!(matches!(
            create_file(file.to_str().unwrap()).await.unwrap_err(),
            LocalError::AlreadyExists(_)
        ));

        let renamed = root.join("renamed.txt");
        rename(file.to_str().unwrap(), renamed.to_str().unwrap())
            .await
            .unwrap();
        assert!(renamed.is_file() && !file.exists());

        delete(renamed.to_str().unwrap(), false).await.unwrap();
        delete(dir.to_str().unwrap(), true).await.unwrap();
        assert!(!renamed.exists() && !dir.exists());
    }

    #[test]
    fn roots_is_non_empty() {
        assert!(!platform::roots().is_empty());
    }
}
