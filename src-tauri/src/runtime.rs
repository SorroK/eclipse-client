use crate::accounts;
use crate::model::*;
use crate::paths::{validate_version_id, McPaths};
use crate::store;
use crate::util::*;
use chrono::Utc;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use tauri::{AppHandle, Emitter};

pub struct Inner {
    pub settings: Settings,
    pub accounts: AccountsFile,
    pub manifest: Option<Value>,
    pub manifest_fetched_at: i64,
    pub installed: Vec<InstalledVersion>,
    pub java: JavaState,
    pub installing: Option<Value>,
    pub game: Option<GameState>,
    pub logs: Vec<LogEntry>,
    pub modpacks: Vec<ModpackRecord>,
    pub loader_cache: HashMap<String, CachedLoaders>,
    pub modpack_job: bool,
    pub content_job: bool,
    pub launching: bool,
    pub stopping: bool,
    pub catalog_refreshing: bool,
    pub java_refreshing: bool,
    pub signing_in: bool,
}

pub struct Runtime {
    pub app: AppHandle,
    pub data_root: PathBuf,
    pub minecraft_root: PathBuf,
    pub paths: McPaths,
    pub http: reqwest::Client,
    pub inner: Mutex<Inner>,
    pub discord: crate::discord::DiscordRpc,
    pub started_at: i64,
}

impl Runtime {
    pub fn new(app: AppHandle) -> Result<Arc<Self>, String> {
        let data_root = std::env::var_os("ECLIPSE_CLIENT_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                std::env::var_os("APPDATA")
                    .map(PathBuf::from)
                    .unwrap_or_else(std::env::temp_dir)
                    .join("Eclipse Client")
            });
        let minecraft_root = data_root.join("minecraft");
        let paths = McPaths::new(minecraft_root.clone());
        paths.ensure()?;
        fs::create_dir_all(data_root.join("instances")).map_err(|e| e.to_string())?;

        let mut settings: Settings = store::load(&data_root.join("settings.json"), Settings::default());
        settings.sanitize_theme();
        settings.sanitize_modrinth_page_size();
        let accounts_path = data_root.join("accounts.json");
        let accounts_existed = accounts_path.exists();
        let mut accounts: AccountsFile = store::load(&accounts_path, AccountsFile::default());
        accounts.profiles.retain(|profile| !profile.id.is_empty() && !profile.name.is_empty());
        if !accounts_existed && accounts.profiles.is_empty() {
            accounts.profiles.push(accounts::offline_record("Player"));
        }
        if !accounts.profiles.iter().any(|profile| profile.id == accounts.selected_id) {
            accounts.selected_id = accounts.profiles.first().map(|profile| profile.id.clone()).unwrap_or_default();
        }
        let _ = store::save(&accounts_path, &accounts);

        let modpacks_path = data_root.join("modpacks.json");
        let mut modpacks: ModpacksFile = store::load(&modpacks_path, ModpacksFile::default());
        modpacks.instances.retain(|row| {
            validate_version_id(&row.id).is_ok()
                && !row.name.is_empty()
                && matches!(row.loader.as_str(), "fabric" | "forge" | "neoforge")
                && !row.loader_version.is_empty()
                && validate_version_id(&row.game_version).is_ok()
        });
        let _ = store::save(&modpacks_path, &modpacks);

        let mut manifest = None;
        let mut manifest_fetched_at = 0;
        if let Ok(raw) = fs::read_to_string(data_root.join("cache").join("version_manifest.json")) {
            if let Ok(cached) = serde_json::from_str::<Value>(&raw) {
                manifest = cached.get("manifest").cloned();
                manifest_fetched_at = cached.get("fetchedAt").and_then(Value::as_i64).unwrap_or(0);
            }
        }
        let installed = scan_installed(&paths);

        let inner = Inner {
            settings,
            accounts,
            manifest,
            manifest_fetched_at,
            installed,
            java: JavaState::default(),
            installing: None,
            game: None,
            logs: Vec::new(),
            modpacks: modpacks.instances,
            loader_cache: HashMap::new(),
            modpack_job: false,
            content_job: false,
            launching: false,
            stopping: false,
            catalog_refreshing: false,
            java_refreshing: false,
            signing_in: false,
        };

        let runtime = Arc::new(Self {
            app,
            data_root,
            minecraft_root,
            paths,
            http: http_client(),
            inner: Mutex::new(inner),
            discord: crate::discord::DiscordRpc::new(),
            started_at: now_ms(),
        });
        {
            let weak = Arc::downgrade(&runtime);
            runtime.discord.set_logger(Arc::new(move |message: &str| {
                if let Some(runtime) = weak.upgrade() {
                    runtime.log("discord", "debug", message);
                }
            }));
        }
        runtime.log("launcher", "debug", "Eclipse Client Rust launcher started.");
        runtime.refresh_discord_presence();
        Ok(runtime)
    }

    pub fn state(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|poison| poison.into_inner())
    }

    pub fn emit<T: serde::Serialize + Clone>(&self, event: &str, payload: T) {
        let _ = self.app.emit(event, payload);
    }

    pub fn log(&self, source: &str, level: &str, message: &str) {
        let line = strip_ansi(message).trim_end().to_string();
        if line.is_empty() {
            return;
        }
        let entry = LogEntry {
            time: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            source: source.into(),
            level: level.into(),
            line,
        };
        {
            let mut state = self.state();
            state.logs.push(entry.clone());
            if state.logs.len() > 1200 {
                state.logs.remove(0);
            }
        }
        self.emit("launcher:log", entry);
    }

    pub fn save_settings(&self) -> Result<(), String> {
        let settings = self.state().settings.clone();
        store::save(&self.data_root.join("settings.json"), &settings)
    }

    /// Rebuild what Discord shows from the current launcher/game state.
    pub fn refresh_discord_presence(&self) {
        let (enabled, client_id, presence) = {
            let state = self.state();
            (
                state.settings.discord_rpc,
                state.settings.discord_client_id.clone(),
                discord_presence(&state, self.started_at),
            )
        };
        self.discord.update(enabled, &client_id, Some(presence));
    }

    pub fn save_accounts(&self) -> Result<(), String> {
        let accounts = self.state().accounts.clone();
        store::save(&self.data_root.join("accounts.json"), &accounts)
    }

    pub fn save_modpacks(&self) -> Result<(), String> {
        let file = ModpacksFile { instances: self.state().modpacks.clone() };
        store::save(&self.data_root.join("modpacks.json"), &file)
    }

    pub fn accounts_view(&self) -> AccountsView {
        let state = self.state();
        let profiles = state.accounts.profiles.iter().map(AccountView::from).collect();
        let selected = state
            .accounts
            .profiles
            .iter()
            .find(|profile| profile.id == state.accounts.selected_id)
            .or_else(|| state.accounts.profiles.first());
        AccountsView { selected_id: selected.map(|profile| profile.id.clone()).unwrap_or_default(), profiles }
    }

    pub fn selected_account(&self) -> Option<AccountRecord> {
        let state = self.state();
        state
            .accounts
            .profiles
            .iter()
            .find(|profile| profile.id == state.accounts.selected_id)
            .or_else(|| state.accounts.profiles.first())
            .cloned()
    }

    pub fn account_by_id(&self, id: &str) -> Option<AccountRecord> {
        self.state().accounts.profiles.iter().find(|profile| profile.id == id).cloned()
    }

    pub fn app_init(&self) -> Value {
        let state = self.state();
        let selected = state.accounts.profiles.iter()
            .find(|profile| profile.id == state.accounts.selected_id)
            .or_else(|| state.accounts.profiles.first());
        let account_view = AccountsView {
            selected_id: selected.map(|profile| profile.id.clone()).unwrap_or_default(),
            profiles: state.accounts.profiles.iter().map(AccountView::from).collect(),
        };
        let game = state.game.clone().unwrap_or_default();
        let logs: Vec<_> = state.logs.iter().rev().take(400).cloned().collect();
        let selected_name = selected.map(|profile| profile.name.clone());
        let game_dir = if state.settings.game_dir.is_empty() {
            self.minecraft_root.clone()
        } else {
            PathBuf::from(&state.settings.game_dir)
        };
        let modpacks = self.modpack_list_from(&state);
        let settings = state.settings.clone();
        let manifest = state.manifest.clone();
        let manifest_fetched_at = state.manifest_fetched_at;
        let installed = state.installed.clone();
        let java = state.java.clone();
        let installing = state.installing.clone();
        drop(state);
        json!({
            "settings": settings,
            "accounts": account_view,
            "manifest": manifest,
            "manifestFetchedAt": manifest_fetched_at,
            "installed": installed,
            "modpacks": modpacks,
            "java": java,
            "installing": installing,
            "game": game,
            "logs": logs.into_iter().rev().collect::<Vec<_>>(),
            "system": {
                "platform": std::env::consts::OS,
                "arch": std::env::consts::ARCH,
                "totalMemory": total_memory_mb(),
                "appVersion": self.app.package_info().version.to_string(),
                "dataRoot": self.data_root,
                "minecraftRoot": self.minecraft_root,
                "gameDir": game_dir,
                "selectedAccount": selected_name,
                "smoke": std::env::var("ECLIPSE_CLIENT_SMOKE_UI").as_deref() == Ok("1")
            }
        })
    }

    pub fn resolved_game_dir(&self) -> PathBuf {
        let value = self.state().settings.game_dir.clone();
        if value.is_empty() {
            self.minecraft_root.clone()
        } else {
            PathBuf::from(value)
        }
    }

    pub fn modpack_list_from(&self, state: &Inner) -> Value {
        Value::Array(
            state
                .modpacks
                .iter()
                .map(|instance| {
                    json!({
                        "id": instance.id,
                        "name": instance.name,
                        "kind": instance.kind,
                        "loader": instance.loader,
                        "loaderVersion": instance.loader_version,
                        "gameVersion": instance.game_version,
                        "createdAt": instance.created_at,
                        "source": instance.source,
                        "essentialsEnabled": instance.essentials_enabled,
                        "renderDistances": instance.render_distances,
                        "gameDir": self.modpack_game_dir(&instance.id)
                    })
                })
                .collect(),
        )
    }

    pub fn modpack_list(&self) -> Value {
        self.modpack_list_from(&self.state())
    }

    pub fn find_modpack(&self, id: &str) -> Option<ModpackRecord> {
        self.state().modpacks.iter().find(|instance| instance.id == id).cloned()
    }

    pub fn require_modpack(&self, id: &str) -> Result<ModpackRecord, String> {
        self.find_modpack(id).ok_or_else(|| "That modpack no longer exists.".to_string())
    }

    pub fn modpack_game_dir(&self, id: &str) -> PathBuf {
        self.data_root.join("instances").join(id)
    }

    pub fn game_dir_for(&self, version_id: &str) -> PathBuf {
        if let Some(instance) = self.find_modpack(version_id) {
            self.modpack_game_dir(&instance.id)
        } else {
            self.resolved_game_dir()
        }
    }

    pub fn update_settings(&self, patch: &Value) -> Result<Value, String> {
        let object = patch.as_object().ok_or_else(|| "Invalid settings update.".to_string())?;
        let mut next = self.state().settings.clone();
        if let Some(value) = object.get("memoryMb").and_then(Value::as_f64) {
            next.memory_mb = (((value / 512.0).round() * 512.0) as u64).clamp(1024, 32768);
        }
        if let Some(value) = object.get("customResolution").and_then(Value::as_bool) {
            next.custom_resolution = value;
        }
        for (key, field) in [("resolutionWidth", 0), ("resolutionHeight", 1)] {
            if let Some(value) = object.get(key).and_then(Value::as_f64) {
                let clamped = (value.round() as u64).clamp(320, 7680);
                if field == 0 {
                    next.resolution_width = clamped;
                } else {
                    next.resolution_height = clamped;
                }
            }
        }
        if let Some(value) = object.get("minimizeOnLaunch").and_then(Value::as_bool) {
            next.minimize_on_launch = value;
        }
        if let Some(value) = object.get("fastLaunch").and_then(Value::as_bool) {
            next.fast_launch = value;
        }
        if let Some(value) = object.get("performanceJvm").and_then(Value::as_bool) {
            next.performance_jvm = value;
        }
        if let Some(value) = object.get("discordRpc").and_then(Value::as_bool) {
            next.discord_rpc = value;
        }
        if let Some(value) = object.get("discordClientId") {
            let id = value.as_str().unwrap_or("").trim().to_string();
            if !id.is_empty()
                && !(id.len() >= 17 && id.len() <= 20 && id.bytes().all(|byte| byte.is_ascii_digit()))
            {
                return Err("A Discord Application ID is 17–20 digits. Copy the Application ID from the Discord Developer Portal.".into());
            }
            next.discord_client_id = id;
        }
        if let Some(value) = object.get("modrinthPageSize").and_then(Value::as_u64) {
            if !matches!(value, 20 | 50 | 100) {
                return Err("Choose 20, 50, or 100 Modrinth results per load.".into());
            }
            next.modrinth_page_size = value;
        }
        if let Some(value) = object.get("theme").and_then(Value::as_str) {
            if !matches!(
                value,
                "eclipse" | "aurora" | "ember" | "daylight" | "midnight" | "frost" | "sakura" | "solar"
            ) {
                return Err("Unknown launcher theme.".into());
            }
            next.theme = value.into();
        }
        if let Some(value) = object.get("javaPath") {
            let path = value.as_str().unwrap_or("").trim().to_string();
            if !path.is_empty() && !Path::new(&path).is_file() {
                return Err("That Java executable does not exist.".into());
            }
            next.java_path = path;
        }
        if let Some(value) = object.get("gameDir") {
            let path = value.as_str().unwrap_or("").trim().to_string();
            if !path.is_empty() {
                let path = PathBuf::from(path);
                fs::create_dir_all(&path).map_err(|e| e.to_string())?;
                next.game_dir = path.to_string_lossy().to_string();
            } else {
                next.game_dir.clear();
            }
        }
        if let Some(value) = object.get("selectedVersion").and_then(Value::as_str) {
            if !value.is_empty() {
                validate_version_id(value)?;
            }
            next.selected_version = value.into();
        }
        {
            let mut state = self.state();
            state.settings = next.clone();
        }
        self.save_settings()?;
        serde_json::to_value(next).map_err(|e| e.to_string())
    }

    pub async fn refresh_catalog(self: &Arc<Self>, force: bool) -> Result<Value, String> {
        {
            let mut state = self.state();
            if !force && state.manifest.is_some() && now_ms() - state.manifest_fetched_at < 5 * 60 * 1000 {
                return Ok(state.manifest.clone().unwrap_or(Value::Null));
            }
            if state.catalog_refreshing {
                return Ok(state.manifest.clone().unwrap_or(Value::Null));
            }
            state.catalog_refreshing = true;
        }
        let result = async {
            let manifest = fetch_json(&self.http, "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json").await?;
            if !manifest.get("versions").and_then(Value::as_array).is_some_and(|items| !items.is_empty()) {
                return Err("Mojang returned an unexpected version manifest".to_string());
            }
            let fetched_at = now_ms();
            {
                let mut state = self.state();
                state.manifest = Some(manifest.clone());
                state.manifest_fetched_at = fetched_at;
            }
            let cache_path = self.data_root.join("cache").join("version_manifest.json");
            let _ = store::save(&cache_path, &json!({ "fetchedAt": fetched_at, "manifest": manifest }));
            self.emit("catalog:updated", manifest.clone());
            let count = manifest.get("versions").and_then(Value::as_array).map(|items| items.len()).unwrap_or(0);
            self.log("launcher", "debug", &format!("Version list updated ({count} versions)."));
            Ok(manifest)
        }
        .await;
        if let Err(error) = &result {
            self.log("launcher", "error", &format!("Could not refresh the Minecraft version list: {error}"));
            self.emit("catalog:error", error.clone());
        }
        self.state().catalog_refreshing = false;
        result
    }

    pub async fn get_manifest_entry(self: &Arc<Self>, version_id: &str) -> Result<Value, String> {
        let id = validate_version_id(version_id)?;
        let has = {
            let state = self.state();
            state.manifest.as_ref().and_then(|manifest| {
                manifest.get("versions").and_then(Value::as_array).and_then(|versions| {
                    versions.iter().find(|entry| entry.get("id").and_then(Value::as_str) == Some(&id))
                })
            }).cloned()
        };
        if has.is_none() {
            let _ = self.refresh_catalog(true).await;
        }
        let entry = {
            let state = self.state();
            state.manifest.as_ref().and_then(|manifest| {
                manifest.get("versions").and_then(Value::as_array).and_then(|versions| {
                    versions.iter().find(|entry| entry.get("id").and_then(Value::as_str) == Some(&id))
                })
            }).cloned()
        };
        entry.ok_or_else(|| format!("Minecraft {id} is not available from Mojang right now."))
    }

    pub async fn update_installed(&self) -> Vec<InstalledVersion> {
        let installed = scan_installed(&self.paths);
        self.state().installed = installed.clone();
        self.emit("installed:updated", installed.clone());
        installed
    }

    pub async fn refresh_java(self: &Arc<Self>) -> JavaState {
        {
            let mut state = self.state();
            if state.java_refreshing {
                return state.java.clone();
            }
            state.java_refreshing = true;
            state.java.detecting = true;
            state.java.error = None;
            self.emit("java:updated", state.java.clone());
        }
        let extra = {
            let path = self.state().settings.java_path.clone();
            if path.is_empty() { Vec::new() } else { vec![path] }
        };
        let java = crate::java::detect(extra).await;
        let mut state = self.state();
        state.java_refreshing = false;
        state.java = java;
        self.emit("java:updated", state.java.clone());
        state.java.clone()
    }

    pub async fn credentials_for(&self, id: &str) -> Result<Value, String> {
        let account = self.account_by_id(id).ok_or_else(|| "Select a player profile first.".to_string())?;
        if account.kind == "offline" {
            return Ok(json!({
                "name": account.name,
                "uuid": account.uuid,
                "accessToken": random_token(),
                "type": "offline",
                "userProperties": "{}"
            }));
        }
        let secret = accounts::decrypt_secret(account.secret.as_deref().unwrap_or(""), Some(&self.data_root))?;
        let minecraft = accounts::refresh_microsoft(&self.http, &secret).await?;
        {
            let mut state = self.state();
            if let Some(record) = state.accounts.profiles.iter_mut().find(|profile| profile.id == id) {
                record.name = minecraft.name.clone();
                record.uuid = minecraft.uuid.clone();
                record.secret = Some(accounts::encrypt_secret(&minecraft.refresh_token)?);
            }
        }
        self.save_accounts()?;
        Ok(json!({
            "name": minecraft.name,
            "uuid": minecraft.uuid,
            "accessToken": minecraft.access_token,
            "xuid": minecraft.xuid,
            "type": "msa",
            "userProperties": "{}"
        }))
    }
}

fn loader_label(loader: &str) -> &'static str {
    match loader {
        "fabric" => "Fabric",
        "forge" => "Forge",
        "neoforge" => "NeoForge",
        _ => "Modded",
    }
}

fn discord_presence(state: &Inner, launcher_started_at: i64) -> crate::discord::Presence {
    if let Some(game) = state.game.as_ref() {
        let version_id = game.version_id.as_deref().unwrap_or("Minecraft");
        let pack = state.modpacks.iter().find(|pack| pack.id == version_id);
        let (details, state_line) = match pack {
            Some(pack) => (
                format!("Playing {}", pack.name),
                format!("{} {} · Eclipse Client", loader_label(&pack.loader), pack.game_version),
            ),
            None => (
                format!("Playing Minecraft {version_id}"),
                format!("Eclipse Client · Minecraft {version_id}"),
            ),
        };
        return crate::discord::Presence {
            details,
            state: state_line,
            start_timestamp: game.started_at.map(|value| value / 1000),
        };
    }

    let selected = state.settings.selected_version.as_str();
    let activity = state
        .modpacks
        .iter()
        .find(|pack| pack.id == selected)
        .map(|pack| format!("{} · {} {}", pack.name, loader_label(&pack.loader), pack.game_version))
        .unwrap_or_else(|| {
            if selected.is_empty() {
                "Ready to launch".into()
            } else {
                format!("Minecraft {selected}")
            }
        });
    crate::discord::Presence {
        details: "In the Eclipse launcher".into(),
        state: activity,
        start_timestamp: Some(launcher_started_at / 1000),
    }
}

pub fn scan_installed(paths: &McPaths) -> Vec<InstalledVersion> {
    let mut rows = Vec::new();
    let Ok(entries) = fs::read_dir(&paths.versions) else { return rows };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else { continue };
        if !file_type.is_dir() { continue; }
        let id = entry.file_name().to_string_lossy().to_string();
        if validate_version_id(&id).is_err() { continue; }
        let Ok(marker_path) = paths.completion_marker(&id) else { continue };
        let Ok(raw) = fs::read_to_string(marker_path) else { continue };
        let Ok(marker) = serde_json::from_str::<Value>(&raw) else { continue };
        rows.push(InstalledVersion {
            id,
            installed_at: marker.get("installedAt").and_then(Value::as_str).map(str::to_string),
        });
    }
    rows.sort_by(|left, right| left.id.cmp(&right.id));
    rows
}
