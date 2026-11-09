use serde_json::{json, Value};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

fn updater(app: &AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
    app.updater_builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| format!("Updater unavailable: {error}"))
}

pub async fn check(app: &AppHandle) -> Result<Value, String> {
    let current = app.package_info().version.to_string();
    let update = updater(app)?
        .check()
        .await
        .map_err(|error| format!("Could not check for updates: {error}"))?;

    Ok(match update {
        Some(update) => json!({
            "available": true,
            "version": update.version,
            "currentVersion": update.current_version,
            "notes": update.body,
            "date": update.date.map(|date| date.to_string()),
        }),
        None => json!({
            "available": false,
            "currentVersion": current,
        }),
    })
}

pub async fn install(app: &AppHandle) -> Result<Value, String> {
    let update = updater(app)?
        .check()
        .await
        .map_err(|error| format!("Could not check for updates: {error}"))?
        .ok_or_else(|| "Eclipse Client is already up to date.".to_string())?;

    let progress_handle = app.clone();
    let finish_handle = app.clone();
    let mut downloaded = 0u64;

    update
        .download_and_install(
            move |chunk_length, content_length| {
                downloaded = downloaded.saturating_add(chunk_length as u64);
                let _ = progress_handle.emit(
                    "update:progress",
                    json!({
                        "downloaded": downloaded,
                        "total": content_length,
                    }),
                );
            },
            move || {
                let _ = finish_handle.emit("update:progress", json!({ "done": true }));
            },
        )
        .await
        .map_err(|error| format!("Could not install the update: {error}"))?;

    #[allow(unreachable_code)]
    {
        app.restart();
        Ok(json!({ "installed": true }))
    }
}
