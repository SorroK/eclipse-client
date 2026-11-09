use crate::accounts;
use crate::installer;
use crate::launch;
use crate::model::AccountView;
use crate::modpacks;
use crate::modrinth;
use crate::runtime::Runtime;
use crate::util::offline_uuid;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

fn payload_object(payload: &Option<Value>) -> &serde_json::Map<String, Value> {
    payload.as_ref().and_then(Value::as_object).unwrap_or_else(|| {
        static EMPTY: std::sync::OnceLock<serde_json::Map<String, Value>> = std::sync::OnceLock::new();
        EMPTY.get_or_init(serde_json::Map::new)
    })
}

fn payload_string(payload: &Option<Value>) -> String {
    payload.as_ref().and_then(Value::as_str).unwrap_or("").to_string()
}

fn emit_accounts(runtime: &Runtime) -> Value {
    let value = serde_json::to_value(runtime.accounts_view()).unwrap_or(Value::Null);
    runtime.emit("accounts:updated", value.clone());
    value
}

fn can_open(target: &Path, data_root: &Path, game_root: &Path) -> bool {
    let normalize = |path: &Path| std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let target = normalize(target);
    target.starts_with(normalize(data_root)) || target.starts_with(normalize(game_root))
}

fn allowed_url(value: &str) -> bool {
    let Ok(url) = url::Url::parse(value) else { return false };
    if url.scheme() != "https" {
        return false;
    }
    let host = url.host_str().unwrap_or("").to_lowercase();
    [
        "minecraft.net",
        "mojang.com",
        "microsoft.com",
        "xbox.com",
        "adoptium.net",
        "azul.com",
        "java.com",
        "discord.com",
    ]
    .iter()
    .any(|domain| host == *domain || host.ends_with(&format!(".{domain}")))
}

#[tauri::command]
pub async fn launcher(
    action: String,
    payload: Option<Value>,
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, Arc<Runtime>>,
) -> Result<Value, String> {
    let runtime = state.inner().clone();
    match action.as_str() {
        "app:init" => {
            let value = runtime.app_init();
            let catalog = runtime.clone();
            let java = runtime.clone();
            tauri::async_runtime::spawn(async move {
                let _ = catalog.refresh_catalog(false).await;
            });
            tauri::async_runtime::spawn(async move {
                let _ = java.refresh_java().await;
            });
            Ok(value)
        }
        "app:update-check" => crate::updates::check(&app).await,
        "app:update-install" => crate::updates::install(&app).await,
        "catalog:refresh" => runtime.refresh_catalog(true).await,
        "version:install" => {
            let id = crate::paths::validate_version_id(&payload_string(&payload))?;
            {
                let state = runtime.state();
                if let Some(job) = &state.installing {
                    return Err(format!(
                        "Minecraft {} is already installing. Wait for it to finish.",
                        job.get("versionId").and_then(Value::as_str).unwrap_or("a version")
                    ));
                }
                if state.game.is_some() {
                    return Err("Close Minecraft before installing a version.".into());
                }
            }
            let entry = runtime.get_manifest_entry(&id).await?;
            let game_dir = runtime.game_dir_for(&id);
            match installer::install_version(&runtime, &id, Some(entry), &game_dir).await {
                Ok(ready) => {
                    runtime.state().installing = None;
                    runtime.update_installed().await;
                    Ok(json!({ "versionId": ready.version_id, "installedAt": ready.installed_at }))
                }
                Err(error) => {
                    runtime.state().installing = None;
                    Err(error)
                }
            }
        }
        "game:launch" => launch::launch_game(&runtime, &payload_string(&payload)).await,
        "game:stop" => launch::stop_game(&runtime).await,
        "settings:update" => {
            let old_java = runtime.state().settings.java_path.clone();
            let value = runtime.update_settings(&payload.unwrap_or(Value::Null))?;
            runtime.refresh_discord_presence();
            let new_java = runtime.state().settings.java_path.clone();
            if old_java != new_java {
                let rt = runtime.clone();
                tauri::async_runtime::spawn(async move { rt.refresh_java().await; });
            }
            Ok(value)
        }
        "java:detect" => Ok(serde_json::to_value(runtime.refresh_java().await).unwrap_or(Value::Null)),
        "modpack:create" => {
            {
                let state = runtime.state();
                if state.modpack_job { return Err("Another modpack job is already running.".into()); }
                if state.content_job { return Err("Wait for the current Modrinth download to finish.".into()); }
                if state.installing.is_some() { return Err("Wait for the current Minecraft install to finish.".into()); }
                if state.game.is_some() { return Err("Close Minecraft before creating a modpack.".into()); }
                drop(state);
                runtime.state().modpack_job = true;
            }
            let result = modpacks::create_modpack(&runtime, payload.unwrap_or_else(|| json!({}))).await;
            runtime.state().modpack_job = false;
            match result {
                Ok(instance) => {
                    let list = runtime.modpack_list();
                    runtime.emit("modpacks:updated", list.clone());
                    Ok(json!({ "instance": instance, "modpacks": list }))
                }
                Err(error) => {
                    runtime.log("launcher", "error", &format!("Could not create modpack: {error}"));
                    Err(error)
                }
            }
        }
        "modpack:import" => {
            {
                let state = runtime.state();
                if state.modpack_job { return Err("Another modpack job is already running.".into()); }
                if state.content_job { return Err("Wait for the current Modrinth download to finish.".into()); }
                if state.installing.is_some() { return Err("Wait for the current Minecraft install to finish.".into()); }
                if state.game.is_some() { return Err("Close Minecraft before importing a modpack.".into()); }
                drop(state);
            }
            let picked = rfd::AsyncFileDialog::new()
                .set_title("Import a Modrinth modpack")
                .add_filter("Modrinth modpack", &["mrpack"])
                .pick_file()
                .await;
            let Some(file) = picked else { return Ok(json!({ "canceled": true })) };
            runtime.state().modpack_job = true;
            let result = modpacks::import_mrpack(&runtime, file.path()).await;
            runtime.state().modpack_job = false;
            match result {
                Ok(mut value) => {
                    if let Some(object) = value.as_object_mut() {
                        object.insert("canceled".into(), json!(false));
                    }
                    let list = runtime.modpack_list();
                    runtime.emit("modpacks:updated", list.clone());
                    if let Some(object) = value.as_object_mut() {
                        object.insert("modpacks".into(), list);
                    }
                    Ok(value)
                }
                Err(error) => {
                    runtime.log("launcher", "error", &format!("Could not import modpack: {error}"));
                    Err(error)
                }
            }
        }
        "modpack:remove" => {
            if runtime.state().game.is_some() {
                return Err("Close Minecraft before deleting a modpack.".into());
            }
            if runtime.state().installing.is_some() || runtime.state().modpack_job || runtime.state().content_job {
                return Err("Wait for the current download to finish before deleting a modpack.".into());
            }
            modpacks::remove_modpack(&runtime, &payload_string(&payload))
        }
        "modpack:list" => Ok(runtime.modpack_list()),
        "modpack:loader-versions" => {
            let object = payload_object(&payload);
            let loader = object.get("loader").and_then(Value::as_str).unwrap_or("fabric");
            let game = object.get("gameVersion").and_then(Value::as_str).unwrap_or("");
            modpacks::list_loader_versions(&runtime, loader, game).await
        }
        "modpack:fabric-versions" => modpacks::list_loader_versions(&runtime, "fabric", &payload_string(&payload)).await,
        "modrinth:search" => {
            let object = payload_object(&payload);
            let project_type = object.get("projectType").and_then(Value::as_str).unwrap_or("mod");
            let target = runtime.require_modpack(object.get("targetVersion").and_then(Value::as_str).unwrap_or(""))?;
            let limit = runtime.state().settings.modrinth_page_size;
            modrinth::search(
                &runtime,
                object.get("query").and_then(Value::as_str).unwrap_or(""),
                project_type,
                &target.game_version,
                if project_type == "mod" { &target.loader } else { "" },
                object.get("offset").and_then(Value::as_u64).unwrap_or(0),
                limit,
            ).await
        }
        "content:list" => modpacks::list_content_command(&runtime, &payload_string(&payload)),
        "content:install" => {
            if runtime.state().content_job {
                return Err("Another Modrinth download is already running. Wait for it to finish.".into());
            }
            let input = payload.unwrap_or_else(|| json!({}));
            if !matches!(input.get("projectType").and_then(Value::as_str), Some("mod" | "resourcepack" | "shader")) {
                return Err("Unknown content type.".into());
            }
            runtime.state().content_job = true;
            let result = modpacks::install_content(&runtime, input).await;
            runtime.state().content_job = false;
            if let Err(error) = &result {
                runtime.log("launcher", "error", &format!("Could not add Modrinth content: {error}"));
            }
            result
        }
        "content:remove" => modpacks::remove_content(&runtime, payload.unwrap_or_else(|| json!({}))),
        "essentials:status" => crate::essentials::status(&runtime, &payload_string(&payload)),
        "essentials:install" => crate::essentials::install(&runtime, &payload_string(&payload)).await,
        "essentials:remove" => crate::essentials::remove(&runtime, &payload_string(&payload)),
        "render:status" => crate::render::status(&runtime, &payload_string(&payload)),
        "render:apply" => crate::render::apply(&runtime, payload.unwrap_or_else(|| json!({}))).await,
        "dialog:choose-folder" => {
            let picked = rfd::AsyncFileDialog::new()
                .set_title("Choose your Minecraft folder")
                .set_directory(runtime.resolved_game_dir())
                .pick_folder()
                .await;
            Ok(picked.map(|file| json!(file.path())).unwrap_or(Value::Null))
        }
        "dialog:choose-java" => {
            let default = {
                let state = runtime.state();
                if !state.settings.java_path.is_empty() {
                    PathBuf::from(&state.settings.java_path).parent().map(Path::to_path_buf)
                } else {
                    std::env::var_os("JAVA_HOME").map(PathBuf::from).map(|path| path.join("bin"))
                }
            };
            let mut dialog = rfd::AsyncFileDialog::new().set_title("Choose a Java executable");
            if let Some(default) = default {
                dialog = dialog.set_directory(default);
            }
            if cfg!(target_os = "windows") {
                dialog = dialog.add_filter("Java executable", &["exe"]);
            }
            let picked = dialog.pick_file().await;
            let Some(file) = picked else { return Ok(Value::Null) };
            let mut chosen = file.path().to_path_buf();
            if cfg!(target_os = "windows") && chosen.file_name().and_then(|value| value.to_str()).map(|value| value.eq_ignore_ascii_case("javaw.exe")).unwrap_or(false) {
                let java_exe = chosen.with_file_name("java.exe");
                if java_exe.exists() {
                    chosen = java_exe;
                }
            }
            let info = crate::java::probe(&chosen.to_string_lossy()).await
                .ok_or_else(|| "That file does not appear to be a working Java executable.".to_string())?;
            Ok(serde_json::to_value(info).unwrap_or(Value::Null))
        }
        "shell:open-path" => {
            let target = payload_string(&payload);
            if target.is_empty() {
                return Err("Invalid folder.".into());
            }
            let path = PathBuf::from(&target);
            if !can_open(&path, &runtime.data_root, &runtime.resolved_game_dir()) {
                return Err("Refusing to open an unknown folder.".into());
            }
            std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
            open::that(&path).map_err(|e| e.to_string())?;
            Ok(Value::Bool(true))
        }
        "shell:open-url" => {
            let target = payload_string(&payload);
            if !allowed_url(&target) {
                return Err("That link is not allowed.".into());
            }
            open::that(&target).map_err(|e| e.to_string())?;
            Ok(Value::Bool(true))
        }
        "window:control" => {
            match payload_string(&payload).as_str() {
                "minimize" => window.minimize().map_err(|e| e.to_string())?,
                "maximize" => {
                    let maximized = window.is_maximized().map_err(|e| e.to_string())?;
                    if maximized {
                        window.unmaximize().map_err(|e| e.to_string())?;
                    } else {
                        window.maximize().map_err(|e| e.to_string())?;
                    }
                    let _ = app.emit("window:maximized", !maximized);
                }
                "close" => window.close().map_err(|e| e.to_string())?,
                _ => return Err("Unknown window action.".into()),
            }
            Ok(Value::Bool(true))
        }
        "accounts:add-offline" => {
            let name = accounts::normalize_name(&payload_string(&payload))?;
            {
                let state = runtime.state();
                if state.accounts.profiles.iter().any(|profile| profile.name.eq_ignore_ascii_case(&name)) {
                    return Err(format!("A profile named \"{name}\" already exists."));
                }
            }
            let profile = accounts::offline_record(&name);
            {
                let mut state = runtime.state();
                state.accounts.selected_id = profile.id.clone();
                state.accounts.profiles.push(profile);
            }
            runtime.save_accounts()?;
            runtime.log("launcher", "info", &format!("Added offline profile \"{name}\"."));
            Ok(emit_accounts(&runtime))
        }
        "accounts:rename-offline" => {
            let object = payload_object(&payload);
            let id = object.get("id").and_then(Value::as_str).unwrap_or("");
            let name = accounts::normalize_name(object.get("name").and_then(Value::as_str).unwrap_or(""))?;
            {
                let mut state = runtime.state();
                if state.accounts.profiles.iter().any(|profile| profile.id != id && profile.name.eq_ignore_ascii_case(&name)) {
                    return Err(format!("A profile named \"{name}\" already exists."));
                }
                let Some(profile) = state.accounts.profiles.iter_mut().find(|profile| profile.id == id) else {
                    return Err("That profile no longer exists.".into());
                };
                if profile.kind != "offline" {
                    return Err("Microsoft profile names are managed by Microsoft.".into());
                }
                profile.name = name.clone();
                profile.uuid = offline_uuid(&name);
            }
            runtime.save_accounts()?;
            Ok(emit_accounts(&runtime))
        }
        "accounts:select" => {
            let id = payload_string(&payload);
            {
                let mut state = runtime.state();
                if !state.accounts.profiles.iter().any(|profile| profile.id == id) {
                    return Err("That profile no longer exists.".into());
                }
                state.accounts.selected_id = id;
            }
            runtime.save_accounts()?;
            Ok(emit_accounts(&runtime))
        }
        "accounts:remove" => {
            let id = payload_string(&payload);
            {
                let mut state = runtime.state();
                state.accounts.profiles.retain(|profile| profile.id != id);
                if state.accounts.selected_id == id {
                    state.accounts.selected_id = state.accounts.profiles.first().map(|profile| profile.id.clone()).unwrap_or_default();
                }
            }
            runtime.save_accounts()?;
            Ok(emit_accounts(&runtime))
        }
        "accounts:sign-in-microsoft" => {
            {
                let mut state = runtime.state();
                if state.signing_in {
                    return Err("A Microsoft sign-in is already in progress.".into());
                }
                state.signing_in = true;
            }
            let result = accounts::sign_in_microsoft(&app, &runtime.http).await;
            runtime.state().signing_in = false;
            let (record, _) = result.map_err(|error| accounts::friendly_error(&error))?;
            let account = {
                let mut state = runtime.state();
                let (selected_id, view) = if let Some(existing) = state.accounts.profiles.iter_mut().find(|profile| profile.id == record.id || (profile.kind == "msa" && profile.uuid == record.uuid)) {
                    existing.name = record.name.clone();
                    existing.uuid = record.uuid.clone();
                    existing.secret = record.secret.clone();
                    existing.kind = "msa".into();
                    (existing.id.clone(), AccountView::from(&*existing))
                } else {
                    let view = AccountView::from(&record);
                    state.accounts.profiles.push(record.clone());
                    (record.id.clone(), view)
                };
                state.accounts.selected_id = selected_id;
                view
            };
            runtime.save_accounts()?;
            runtime.log("launcher", "info", &format!("Signed in as {}.", account.name));
            let accounts = emit_accounts(&runtime);
            Ok(json!({ "account": account, "accounts": accounts }))
        }
        "accounts:skin" => {
            let id = payload_string(&payload);
            let Some(account) = runtime.account_by_id(&id) else {
                return Ok(Value::Null);
            };
            if account.kind != "msa" {
                return Ok(Value::Null);
            }
            match accounts::skin_data_url(&runtime.http, &account.uuid).await {
                Ok(Some(url)) => Ok(Value::String(url)),
                Ok(None) => Ok(Value::Null),
                Err(error) => {
                    runtime.log("launcher", "warn", &format!("Player head unavailable: {error}"));
                    Ok(Value::Null)
                }
            }
        }
        "client:error" => {
            let object = payload_object(&payload);
            let message = object.get("message").and_then(Value::as_str).unwrap_or("Unknown renderer error");
            let stack = object.get("stack").and_then(Value::as_str).unwrap_or("");
            runtime.log("launcher", "error", &format!("Renderer error: {message}{}", if stack.is_empty() { String::new() } else { format!("\n{stack}") }));
            if std::env::var("ECLIPSE_CLIENT_SMOKE_UI").as_deref() == Ok("1") {
                println!("UI_SMOKE_FAILED {message}");
            }
            Ok(Value::Bool(true))
        }
        "smoke:report" => {
            println!("UI_SMOKE_RESULT {}", payload.clone().unwrap_or(Value::Null));
            let ok = payload.as_ref().and_then(|value| value.get("passed")).and_then(Value::as_bool).unwrap_or(false);
            app.exit(if ok { 0 } else { 1 });
            Ok(Value::Bool(true))
        }
        _ => Err(format!("Unknown launcher action: {action}")),
    }
}
