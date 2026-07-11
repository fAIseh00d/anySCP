//! Tauri command wrappers for local-filesystem browsing. Thin adapters over the
//! testable core logic in `super`. Stateless — no session or manager needed.

use super::{LocalEntry, LocalError};

#[tauri::command]
pub async fn local_list_dir(path: String) -> Result<Vec<LocalEntry>, LocalError> {
    super::list_dir(&path).await
}

#[tauri::command]
pub fn local_home_dir() -> Result<String, LocalError> {
    super::home_dir()
}

#[tauri::command]
pub fn local_roots() -> Vec<String> {
    super::roots()
}

#[tauri::command]
pub async fn local_mkdir(path: String) -> Result<(), LocalError> {
    super::mkdir(&path).await
}

#[tauri::command]
pub async fn local_create_file(path: String) -> Result<(), LocalError> {
    super::create_file(&path).await
}

#[tauri::command]
pub async fn local_delete(path: String, is_dir: bool) -> Result<(), LocalError> {
    super::delete(&path, is_dir).await
}

#[tauri::command]
pub async fn local_rename(old_path: String, new_path: String) -> Result<(), LocalError> {
    super::rename(&old_path, &new_path).await
}
