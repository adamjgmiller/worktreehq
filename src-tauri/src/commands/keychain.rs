use crate::error::{AppError, AppResult};

const SERVICE_NAME: &str = "worktreehq";

#[tauri::command]
pub fn keychain_store(key: String, value: String) -> AppResult<()> {
    let entry = keyring::Entry::new(SERVICE_NAME, &key)
        .map_err(|e| AppError::Msg(format!("keychain entry error: {e}")))?;
    entry
        .set_password(&value)
        .map_err(|e| AppError::Msg(format!("keychain store error: {e}")))?;
    Ok(())
}

#[tauri::command]
pub fn keychain_read(key: String) -> AppResult<Option<String>> {
    let entry = keyring::Entry::new(SERVICE_NAME, &key)
        .map_err(|e| AppError::Msg(format!("keychain entry error: {e}")))?;
    match entry.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        // PlatformFailure can mean "no keychain daemon" on Linux (headless
        // servers without gnome-keyring/kwallet). Treat as "no entry" so the
        // app falls through to the plaintext/gh-cli path gracefully.
        Err(keyring::Error::PlatformFailure(_)) => {
            eprintln!("[keychain] platform not available, treating as empty");
            Ok(None)
        }
        Err(e) => Err(AppError::Msg(format!("keychain read error: {e}"))),
    }
}

#[tauri::command]
pub fn keychain_delete(key: String) -> AppResult<()> {
    let entry = keyring::Entry::new(SERVICE_NAME, &key)
        .map_err(|e| AppError::Msg(format!("keychain entry error: {e}")))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()), // already gone, fine
        Err(keyring::Error::PlatformFailure(_)) => Ok(()), // no daemon, nothing to delete
        Err(e) => Err(AppError::Msg(format!("keychain delete error: {e}"))),
    }
}
