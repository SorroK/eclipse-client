use crate::installer;
use crate::model::{GameState, JavaInstallation, Settings};
use crate::paths::McPaths;
use crate::rules::rule_allowed;
use crate::runtime::Runtime;
use crate::util::*;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};

fn clamp_memory(value: u64) -> u64 {
    ((value / 512) * 512).clamp(1024, 32768)
}

fn clamp_resolution(value: u64, fallback: u64) -> u64 {
    value.clamp(320, 7680).max(fallback.min(320))
}

fn features(settings: &Settings) -> HashMap<String, bool> {
    HashMap::from([
        ("has_custom_resolution".into(), settings.custom_resolution),
        ("has_quick_plays_support".into(), false),
        ("is_quick_play_singleplayer".into(), false),
        ("is_quick_play_multiplayer".into(), false),
        ("is_quick_play_realms".into(), false),
        ("is_demo_user".into(), false),
    ])
}

fn expand_arguments(list: Option<&Value>, features: &HashMap<String, bool>) -> Vec<String> {
    let mut out = Vec::new();
    let Some(items) = list.and_then(Value::as_array) else { return out };
    for item in items {
        if let Some(value) = item.as_str() {
            out.push(value.to_string());
            continue;
        }
        if !rule_allowed(item.get("rules"), features) {
            continue;
        }
        if let Some(value) = item.get("value") {
            if let Some(text) = value.as_str() {
                out.push(text.to_string());
            } else if let Some(values) = value.as_array() {
                out.extend(values.iter().filter_map(Value::as_str).map(str::to_string));
            }
        }
    }
    out
}

fn substitute(value: &str, variables: &HashMap<&str, String>) -> String {
    regex::Regex::new(r"\$\{([A-Za-z0-9_]+)\}").unwrap().replace_all(value, |captures: &regex::Captures| {
        variables.get(&captures[1]).cloned().unwrap_or_else(|| captures[0].to_string())
    }).to_string()
}

fn legacy_args(value: Option<&str>) -> Vec<String> {
    value.unwrap_or("").split_whitespace().map(str::to_string).collect()
}

fn asset_root(paths: &McPaths, meta: &Value, asset_index: Option<&Value>) -> Result<PathBuf, String> {
    let virtual_assets = asset_index.and_then(|index| index.get("virtual")).and_then(Value::as_bool).unwrap_or(false);
    if virtual_assets {
        if let Some(id) = meta.get("assets").and_then(Value::as_str) {
            return paths.virtual_assets(id);
        }
    }
    Ok(paths.assets.clone())
}

fn classpath(paths: &McPaths, meta: &Value, version_id: &str, features: &HashMap<String, bool>) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    if let Some(libraries) = meta.get("libraries").and_then(Value::as_array) {
        for library in libraries {
            if !rule_allowed(library.get("rules"), features) {
                continue;
            }
            let Some(path) = library.pointer("/downloads/artifact/path").and_then(Value::as_str) else { continue };
            if let Ok(dest) = crate::paths::safe_join(&paths.libraries, path) {
                if seen.insert(dest.clone()) {
                    out.push(dest);
                }
            }
        }
    }
    if let Ok(jar) = paths.client_jar(version_id) {
        if seen.insert(jar.clone()) {
            out.push(jar);
        }
    }
    out
}

pub async fn choose_java_for(runtime: &Arc<Runtime>, meta: &Value) -> Result<JavaInstallation, String> {
    let required = meta.pointer("/javaVersion/majorVersion").and_then(Value::as_u64).unwrap_or(8) as u32;
    let configured = runtime.state().settings.java_path.clone();
    if !configured.is_empty() {
        let info = crate::java::probe(&configured).await
            .ok_or_else(|| "The selected Java runtime could not be started. Check the Java path in Settings.".to_string())?;
        let compatible = if required <= 8 { info.major == 8 } else { info.major >= required };
        if !compatible {
            return Err(format!(
                "This version needs Java {required}, but the selected runtime is Java {}. Choose a compatible Java in Settings.",
                info.major
            ));
        }
        return Ok(info);
    }
    let needs_scan = {
        let state = runtime.state();
        state.java.detecting || state.java.installations.is_empty()
    };
    if needs_scan {
        runtime.refresh_java().await;
    }
    let installations = runtime.state().java.installations.clone();
    crate::java::select(&installations, required).ok_or_else(|| {
        let found = installations.iter().map(|entry| entry.major.to_string()).collect::<Vec<_>>().join(", ");
        let found = if found.is_empty() { "none".to_string() } else { found };
        if required <= 8 {
            format!("This version needs Java 8. Installed Java versions: {found}. Install Java 8 or choose a Java path in Settings.")
        } else {
            format!("This version needs Java {required} or newer. Installed Java versions: {found}. Install a newer Java or choose a path in Settings.")
        }
    })
}

pub async fn launch_game(runtime: &Arc<Runtime>, version_id: &str) -> Result<Value, String> {
    {
        let mut state = runtime.state();
        if state.launching {
            return Err("A launch is already in progress.".into());
        }
        if state.game.is_some() {
            return Err("Minecraft is already running.".into());
        }
        if state.installing.is_some() {
            return Err("A Minecraft install is still running.".into());
        }
        if state.modpack_job {
            return Err("Wait for the current modpack job to finish.".into());
        }
        state.launching = true;
        state.stopping = false;
    }
    let result = launch_inner(runtime, version_id).await;
    runtime.state().launching = false;
    if let Err(error) = &result {
        runtime.log("launcher", "error", error);
        runtime.emit("game:state", json!({ "status": "idle" }));
        runtime.refresh_discord_presence();
    }
    result
}

async fn launch_inner(runtime: &Arc<Runtime>, version_id: &str) -> Result<Value, String> {
    let id = crate::paths::validate_version_id(version_id)?;
    let account = runtime.selected_account().ok_or_else(|| "Add a player profile before launching the game.".to_string())?;
    let game_dir = runtime.game_dir_for(&id);
    tokio::fs::create_dir_all(&game_dir).await.map_err(|e| e.to_string())?;
    if let Some(instance) = runtime.find_modpack(&id) {
        if instance.essentials_enabled {
            runtime.log("launcher", "info", "Checking Eclipse Essentials...");
            if let Err(error) = crate::essentials::ensure(runtime, &id).await {
                runtime.log("launcher", "warn", &format!("Eclipse Essentials could not be prepared: {error}"));
            }
        }
        if instance.render_distances.any() {
            if let Err(error) = crate::render::ensure(runtime, &id) {
                runtime.log("launcher", "warn", &format!("Render distances could not be prepared: {error}"));
            }
        }
    }
    let entry = runtime.get_manifest_entry(&id).await.ok();
    let ready = installer::ensure_version(runtime, &id, entry).await?;
    runtime.log("launcher", "info", &format!(
        "Preparing Minecraft {id}{}",
        if ready.fast_launch { " with a fast launch check" } else { "..." }
    ));
    let credentials = runtime.credentials_for(&account.id).await?;
    let java = choose_java_for(runtime, &ready.meta).await?;
    let asset_index = ready.asset_index.as_ref();
    let command = build_command(
        &ready.meta,
        &runtime.paths,
        &id,
        &credentials,
        &runtime.state().settings,
        &java.path,
        &game_dir,
        asset_index,
        &runtime.app.package_info().version.to_string(),
    )?;
    runtime.log("launcher", "info", &format!(
        "Launching Minecraft {id} with Java {} ({})...",
        java.version, java.vendor
    ));
    let mut command_builder = tokio::process::Command::new(&command.java_path);
    command_builder.args(&command.args)
        .current_dir(&command.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(false);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command_builder.creation_flags(0x08000000);
    }
    let mut child = command_builder.spawn().map_err(|e| format!("Could not start Java: {e}"))?;
    let pid = child.id().unwrap_or_default();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let started_at = now_ms();
    {
        let mut state = runtime.state();
        state.game = Some(GameState {
            status: "starting".into(),
            pid: Some(pid),
            version_id: Some(id.clone()),
            started_at: Some(started_at),
            error: None,
        });
    }
    runtime.emit("game:state", json!({
        "status": "starting", "pid": pid, "versionId": id, "startedAt": started_at
    }));
    if let Some(stdout) = stdout {
        attach_output(runtime.clone(), stdout, "stdout");
    }
    if let Some(stderr) = stderr {
        attach_output(runtime.clone(), stderr, "stderr");
    }
    {
        let mut state = runtime.state();
        if let Some(game) = state.game.as_mut() {
            game.status = "running".into();
        }
    }
    runtime.emit("game:state", json!({
        "status": "running", "pid": pid, "versionId": id, "startedAt": started_at
    }));
    runtime.log("launcher", "info", &format!("Minecraft {id} is running (PID {pid})."));
    runtime.refresh_discord_presence();
    if runtime.state().settings.minimize_on_launch {
        if let Some(window) = tauri::Manager::get_webview_window(&runtime.app, "main") {
            let _ = window.minimize();
        }
    }

    let runtime_wait = runtime.clone();
    let id_wait = id.clone();
    tokio::spawn(async move {
        let status = child.wait().await;
        let stopped = runtime_wait.state().stopping;
        runtime_wait.state().stopping = false;
        let code = status.as_ref().ok().and_then(|status| status.code());
        {
            let mut state = runtime_wait.state();
            state.game = None;
        }
        runtime_wait.emit("game:state", json!({
            "status": "exited",
            "versionId": id_wait,
            "code": code,
            "signal": Value::Null,
            "tracked": true,
            "stopped": stopped
        }));
        if stopped {
            runtime_wait.log("launcher", "info", &format!("Minecraft {id_wait} stopped."));
        } else if code == Some(0) {
            runtime_wait.log("launcher", "info", &format!("Minecraft {id_wait} closed."));
        } else {
            runtime_wait.log("launcher", "error", &format!(
                "Minecraft {id_wait} exited with code {}. Check the console for details.",
                code.map(|value| value.to_string()).unwrap_or_else(|| "unknown".into())
            ));
        }
        runtime_wait.refresh_discord_presence();
    });
    Ok(json!({ "pid": pid, "versionId": id }))
}

pub async fn stop_game(runtime: &Arc<Runtime>) -> Result<Value, String> {
    let pid = {
        let state = runtime.state();
        let Some(game) = state.game.as_ref() else { return Ok(json!({ "stopped": false })) };
        game.pid
    };
    let Some(pid) = pid else { return Ok(json!({ "stopped": false })) };
    runtime.state().stopping = true;
    runtime.log("launcher", "warn", &format!("Stopping Minecraft (PID {pid})..."));
    #[cfg(target_os = "windows")]
    {
        let args = vec!["/pid".into(), pid.to_string(), "/T".into(), "/F".into()];
        let (ok, _, _, stderr) = run_command("taskkill", &args, 12).await?;
        if !ok {
            runtime.state().stopping = false;
            return Err(stderr.trim().to_string());
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let args = vec!["-TERM".into(), pid.to_string()];
        let _ = run_command("kill", &args, 12).await;
    }
    Ok(json!({ "stopped": true }))
}

fn attach_output<R: tokio::io::AsyncRead + Unpin + Send + 'static>(runtime: Arc<Runtime>, stream: R, source: &'static str) {
    tokio::spawn(async move {
        let mut lines = BufReader::new(stream).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let clean = strip_ansi(&line);
            if clean.trim().is_empty() {
                continue;
            }
            let level = if regex::Regex::new(r"\b(ERROR|FATAL|Exception)\b").unwrap().is_match(&clean) {
                "error"
            } else if regex::Regex::new(r"\bWARN(ING)?\b").unwrap().is_match(&clean) {
                "warn"
            } else {
                "info"
            };
            runtime.log("game", level, &clean);
        }
        let _ = source;
    });
}

pub struct LaunchCommand {
    pub java_path: String,
    pub args: Vec<String>,
    pub classpath: String,
    pub cwd: PathBuf,
    pub memory_mb: u64,
    pub required_java_major: u32,
}

pub fn build_command(
    meta: &Value,
    paths: &McPaths,
    version_id: &str,
    account: &Value,
    settings: &Settings,
    java_path: &str,
    game_dir: &Path,
    asset_index: Option<&Value>,
    launcher_version: &str,
) -> Result<LaunchCommand, String> {
    if meta.get("mainClass").and_then(Value::as_str).is_none() {
        return Err("Version metadata is missing a main class".into());
    }
    let memory = clamp_memory(settings.memory_mb);
    let width = settings.resolution_width.clamp(320, 7680);
    let height = settings.resolution_height.clamp(320, 7680);
    let features = features(settings);
    let classpath_entries = classpath(paths, meta, version_id, &features);
    let classpath_text = classpath_entries.iter().map(|path| path.to_string_lossy()).collect::<Vec<_>>().join(";");
    let natives = paths.natives_dir(version_id)?;
    for folder in ["", "java", "jna", "lwjgl", "netty"] {
        std::fs::create_dir_all(natives.join(folder)).map_err(|e| e.to_string())?;
    }
    let asset_root = asset_root(paths, meta, asset_index)?;
    let name = account.get("name").and_then(Value::as_str).unwrap_or("Player");
    let uuid = account.get("uuid").and_then(Value::as_str).unwrap_or("");
    let access_token = account.get("accessToken").and_then(Value::as_str).unwrap_or("0");
    let user_type = if account.get("type").and_then(Value::as_str) == Some("msa") { "msa" } else { "legacy" };
    let xuid = account.get("xuid").and_then(Value::as_str).unwrap_or("");
    let user_properties = account.get("userProperties").and_then(Value::as_str).unwrap_or("{}");
    let asset_id = meta.get("assets").and_then(Value::as_str).or_else(|| asset_index.and_then(|index| index.get("id")).and_then(Value::as_str)).unwrap_or("");
    let mut variables: HashMap<&str, String> = HashMap::new();
    variables.insert("auth_player_name", name.into());
    variables.insert("profile_name", name.into());
    variables.insert("version_name", version_id.into());
    variables.insert("game_directory", game_dir.to_string_lossy().into());
    variables.insert("assets_root", asset_root.to_string_lossy().into());
    variables.insert("game_assets", asset_root.to_string_lossy().into());
    variables.insert("assets_index_name", asset_id.into());
    variables.insert("auth_uuid", uuid.into());
    variables.insert("auth_access_token", access_token.into());
    variables.insert("auth_session", format!("token:{access_token}:{uuid}"));
    variables.insert("auth_xuid", xuid.into());
    variables.insert("clientid", String::new());
    variables.insert("user_type", user_type.into());
    variables.insert("version_type", meta.get("type").and_then(Value::as_str).unwrap_or("release").into());
    variables.insert("user_properties", user_properties.into());
    variables.insert("natives_directory", natives.to_string_lossy().into());
    variables.insert("classpath", classpath_text.clone());
    variables.insert("classpath_separator", ";".into());
    variables.insert("launcher_name", "EclipseClient".into());
    variables.insert("launcher_version", launcher_version.into());
    variables.insert("library_directory", paths.libraries.to_string_lossy().into());
    variables.insert("resolution_width", width.to_string());
    variables.insert("resolution_height", height.to_string());

    let mut jvm = vec![format!("-Xms{}M", memory.min(2048)), format!("-Xmx{memory}M")];
    if settings.performance_jvm {
        jvm.extend([
            "-XX:+UseG1GC".into(),
            "-XX:+ParallelRefProcEnabled".into(),
            "-XX:MaxGCPauseMillis=200".into(),
            "-XX:+PerfDisableSharedMem".into(),
            "-XX:G1HeapRegionSize=8M".into(),
            "-XX:G1ReservePercent=20".into(),
            "-XX:InitiatingHeapOccupancyPercent=15".into(),
        ]);
    }
    if let Some(logging) = meta.pointer("/logging/client") {
        if let Some(config_id) = logging.pointer("/file/id").and_then(Value::as_str) {
            if let Ok(log_path) = paths.log_config(config_id) {
                if log_path.is_file() {
                    let template = logging.get("argument").and_then(Value::as_str).unwrap_or("-Dlog4j.configurationFile=${path}");
                    let mut values = HashMap::new();
                    values.insert("path", log_path.to_string_lossy().to_string());
                    jvm.push(substitute(template, &values));
                }
            }
        }
    }
    if let Some(jvm_args) = meta.pointer("/arguments/jvm") {
        let expanded: Vec<String> = expand_arguments(Some(jvm_args), &features)
            .into_iter()
            .map(|value| substitute(&value, &variables))
            .collect();
        let has_classpath = expanded.iter().any(|value| value == "-cp" || value == "-classpath");
        jvm.extend(expanded);
        if !has_classpath {
            jvm.push(format!("-Djava.library.path={}", natives.to_string_lossy()));
            jvm.push("-cp".into());
            jvm.push(classpath_text.clone());
        }
    } else {
        jvm.push(format!("-Djava.library.path={}", natives.to_string_lossy()));
        jvm.push("-cp".into());
        jvm.push(classpath_text.clone());
    }
    if !jvm.iter().any(|value| value.starts_with("-Dminecraft.launcher.brand=")) {
        jvm.push("-Dminecraft.launcher.brand=EclipseClient".into());
    }
    if !jvm.iter().any(|value| value.starts_with("-Dminecraft.launcher.version=")) {
        jvm.push(format!("-Dminecraft.launcher.version={launcher_version}"));
    }
    jvm.push(format!("-Declipse.theme={}", settings.theme));
    let mut game = if meta.pointer("/arguments/game").and_then(Value::as_array).is_some_and(|items| !items.is_empty()) {
        expand_arguments(meta.pointer("/arguments/game"), &features)
    } else {
        legacy_args(meta.get("minecraftArguments").and_then(Value::as_str))
    };
    game = game.into_iter().map(|value| substitute(&value, &variables)).collect();
    if settings.custom_resolution && !game.iter().any(|value| value == "--width") {
        game.push("--width".into());
        game.push(width.to_string());
        game.push("--height".into());
        game.push(height.to_string());
    }
    let mut args = jvm;
    args.push(meta.get("mainClass").and_then(Value::as_str).unwrap_or("net.minecraft.client.main.Main").into());
    args.extend(game);
    Ok(LaunchCommand {
        java_path: java_path.into(),
        args,
        classpath: classpath_text,
        cwd: game_dir.to_path_buf(),
        memory_mb: memory,
        required_java_major: meta.pointer("/javaVersion/majorVersion").and_then(Value::as_u64).unwrap_or(8) as u32,
    })
}
