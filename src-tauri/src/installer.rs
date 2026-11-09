use crate::paths::{safe_join, validate_asset_id, validate_version_id};
use crate::rules::rule_allowed;
use crate::runtime::Runtime;
use crate::util::*;
use futures_util::StreamExt;
use serde_json::Value;
use sha1::Digest;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use zip::ZipArchive;

pub const ASSET_BASE: &str = "https://resources.download.minecraft.net";

#[derive(Clone)]
pub struct ReadyVersion {
    pub version_id: String,
    pub meta: Value,
    pub asset_index: Option<Value>,
    pub installed_at: Option<String>,
    pub fast_launch: bool,
}

#[derive(Clone)]
struct Task {
    url: String,
    dest: PathBuf,
    sha1: Option<String>,
    size: Option<u64>,
    kind: String,
    label: String,
    skip: bool,
}

#[derive(Clone)]
struct NativeJar {
    jar: PathBuf,
    exclude: Vec<String>,
}

pub async fn install_version(
    runtime: &Arc<Runtime>,
    version_id: &str,
    entry: Option<Value>,
    game_dir: &Path,
) -> Result<ReadyVersion, String> {
    let id = validate_version_id(version_id)?;
    runtime.paths.ensure()?;
    tokio::fs::create_dir_all(game_dir).await.map_err(|e| e.to_string())?;
    let started_at = now_ms();
    {
        let mut state = runtime.state();
        state.installing = Some(serde_json::json!({
            "versionId": id,
            "startedAt": started_at,
            "stage": "metadata",
            "label": "Reading version data",
            "percent": 0,
            "indeterminate": true
        }));
    }
    emit_progress(runtime, serde_json::json!({
        "versionId": id,
        "stage": "metadata",
        "label": "Reading version data",
        "percent": 0,
        "indeterminate": true
    }), true);

    let meta = resolve_meta(runtime, &id, entry).await?;
    let asset_index = ensure_asset_index(runtime, &id, &meta).await?;
    let plan = build_plan(runtime, &id, &meta, asset_index.as_ref())?;
    runtime.log("launcher", "info", &format!(
        "Installing Minecraft {id}: {} files, {} assets, {} total.",
        plan.tasks.len(),
        plan.asset_count,
        format_bytes(plan.total_bytes)
    ));

    download_tasks(runtime, &id, plan.clone()).await?;
    extract_natives(&id, &runtime.paths, &plan.natives).await?;
    prepare_legacy_assets(runtime, &id, &meta, asset_index.as_ref(), game_dir).await?;
    let natives = runtime.paths.natives_dir(&id)?;
    for folder in ["java", "jna", "lwjgl", "netty"] {
        tokio::fs::create_dir_all(natives.join(folder)).await.map_err(|e| e.to_string())?;
    }
    let installed_at = iso_now();
    let marker = serde_json::json!({
        "versionId": id,
        "installedAt": installed_at,
        "assetIndex": meta.get("assets").cloned().unwrap_or(Value::Null)
    });
    let marker_path = runtime.paths.completion_marker(&id)?;
    let marker_raw = serde_json::to_string_pretty(&marker).map_err(|e| e.to_string())?;
    tokio::fs::write(marker_path, marker_raw).await.map_err(|e| e.to_string())?;

    emit_progress(runtime, serde_json::json!({
        "versionId": id,
        "stage": "complete",
        "label": "Install complete",
        "percent": 100,
        "bytesDone": plan.total_bytes,
        "bytesTotal": plan.total_bytes,
        "filesDone": plan.tasks.len(),
        "filesTotal": plan.tasks.len(),
        "currentFile": "",
        "indeterminate": false,
        "installed": true
    }), true);
    runtime.log("launcher", "info", &format!("Minecraft {id} is ready to launch."));
    Ok(ReadyVersion {
        version_id: id,
        meta,
        asset_index,
        installed_at: Some(installed_at),
        fast_launch: false,
    })
}

pub async fn ensure_version(
    runtime: &Arc<Runtime>,
    version_id: &str,
    entry: Option<Value>,
) -> Result<ReadyVersion, String> {
    let id = validate_version_id(version_id)?;
    let started = now_ms();
    let fast = runtime.state().settings.fast_launch;
    if fast && is_launch_ready(runtime, &id).await {
        let ready = get_existing(runtime, &id).await?;
        runtime.log("launcher", "debug", &format!(
            "Fast launch check finished in {} ms.",
            now_ms() - started
        ));
        return Ok(ReadyVersion { fast_launch: true, ..ready });
    }
    if can_use_existing(runtime, &id).await {
        let ready = get_existing(runtime, &id).await?;
        runtime.log("launcher", "debug", &format!(
            "Verified game files in deep check ({} ms).",
            now_ms() - started
        ));
        return Ok(ready);
    }
    let game_dir = runtime.game_dir_for(&id);
    install_version(runtime, &id, entry, &game_dir).await
}

pub async fn is_launch_ready(runtime: &Runtime, version_id: &str) -> bool {
    let Ok(id) = validate_version_id(version_id) else { return false };
    let Ok(marker) = runtime.paths.completion_marker(&id) else { return false };
    let Ok(json) = runtime.paths.version_json(&id) else { return false };
    let Ok(jar) = runtime.paths.client_jar(&id) else { return false };
    if !marker.is_file() || !json.is_file() || !jar.is_file() {
        return false;
    }
    let Ok(meta) = read_meta(&json) else { return false };
    if let Some(asset_id) = meta.pointer("/assetIndex/id").and_then(Value::as_str) {
        if let Ok(index) = runtime.paths.asset_index(asset_id) {
            if !index.is_file() {
                return false;
            }
        }
    }
    true
}

pub async fn can_use_existing(runtime: &Runtime, version_id: &str) -> bool {
    if !is_launch_ready(runtime, version_id).await {
        return false;
    }
    let Ok(id) = validate_version_id(version_id) else { return false };
    let Ok(json) = runtime.paths.version_json(&id) else { return false };
    let Ok(raw) = tokio::fs::read_to_string(json).await else { return false };
    let Ok(meta) = serde_json::from_str::<Value>(&raw) else { return false };
    let features = HashMap::new();
    if let Some(libraries) = meta.get("libraries").and_then(Value::as_array) {
        for library in libraries {
            if !rule_allowed(library.get("rules"), &features) {
                continue;
            }
            let Some(path) = library.pointer("/downloads/artifact/path").and_then(Value::as_str) else { continue };
            let Ok(dest) = safe_join(&runtime.paths.libraries, path) else { return false };
            if !dest.is_file() {
                return false;
            }
        }
    }
    runtime.paths.client_jar(&id).map(|path| path.is_file()).unwrap_or(false)
}

pub async fn get_existing(runtime: &Runtime, version_id: &str) -> Result<ReadyVersion, String> {
    let id = validate_version_id(version_id)?;
    let meta = read_meta(&runtime.paths.version_json(&id)?)?;
    let asset_index = match meta.pointer("/assetIndex/id").and_then(Value::as_str) {
        Some(asset_id) => {
            let path = runtime.paths.asset_index(asset_id)?;
            let raw = tokio::fs::read_to_string(path).await.map_err(|e| e.to_string())?;
            Some(serde_json::from_str(&raw).map_err(|e| e.to_string())?)
        }
        None => None,
    };
    let installed_at = fs::read_to_string(runtime.paths.completion_marker(&id)?)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|value| value.get("installedAt").and_then(Value::as_str).map(str::to_string));
    Ok(ReadyVersion {
        version_id: id,
        meta,
        asset_index,
        installed_at,
        fast_launch: false,
    })
}

async fn resolve_meta(runtime: &Runtime, id: &str, entry: Option<Value>) -> Result<Value, String> {
    let version_file = runtime.paths.version_json(id)?;
    if let Ok(raw) = tokio::fs::read_to_string(&version_file).await {
        if let Ok(local) = serde_json::from_str::<Value>(&raw) {
            if local.get("mainClass").and_then(Value::as_str).is_some() {
                return Ok(local);
            }
        }
    }
    let url = entry
        .as_ref()
        .and_then(|value| value.get("url"))
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Minecraft {id} is not installed and no metadata is available. Refresh the version list and try again."))?;
    runtime.log("launcher", "info", &format!("Fetching metadata for Minecraft {id}..."));
    let meta = fetch_json(&runtime.http, url).await?;
    if meta.get("mainClass").and_then(Value::as_str).is_none() {
        return Err(format!("Mojang returned invalid metadata for Minecraft {id}"));
    }
    if let Some(parent) = version_file.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
    }
    let data = serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?;
    tokio::fs::write(&version_file, data).await.map_err(|e| e.to_string())?;
    Ok(meta)
}

async fn ensure_asset_index(runtime: &Runtime, id: &str, meta: &Value) -> Result<Option<Value>, String> {
    let Some(index) = meta.get("assetIndex") else { return Ok(None) };
    let Some(asset_id) = index.get("id").and_then(Value::as_str) else { return Ok(None) };
    let asset_id = validate_asset_id(asset_id)?;
    let destination = runtime.paths.asset_index(&asset_id)?;
    let expected = index.get("sha1").and_then(Value::as_str);
    if destination.is_file() {
        if expected.is_none() || sha1_file(&destination).await.map(|actual| actual.eq_ignore_ascii_case(expected.unwrap())).unwrap_or(false) {
            if let Ok(raw) = tokio::fs::read_to_string(&destination).await {
                if let Ok(value) = serde_json::from_str(&raw) {
                    return Ok(Some(value));
                }
            }
        }
    }
    let url = index.get("url").and_then(Value::as_str)
        .ok_or_else(|| format!("Minecraft {id} has no asset index download."))?;
    runtime.log("launcher", "info", &format!("Fetching asset index {asset_id}..."));
    download_file(&runtime.http, url, &destination, expected, None, index.get("size").and_then(Value::as_u64)).await?;
    let raw = tokio::fs::read_to_string(destination).await.map_err(|e| e.to_string())?;
    Ok(Some(serde_json::from_str(&raw).map_err(|e| e.to_string())?))
}

#[derive(Clone)]
struct Plan {
    tasks: Vec<Task>,
    natives: Vec<NativeJar>,
    total_bytes: u64,
    asset_count: usize,
}

fn build_plan(runtime: &Runtime, id: &str, meta: &Value, asset_index: Option<&Value>) -> Result<Plan, String> {
    let features = HashMap::new();
    let mut tasks: Vec<Task> = Vec::new();
    let mut native_jars = Vec::new();
    let mut seen = HashSet::new();
    let mut asset_count = 0usize;
    let add = |tasks: &mut Vec<Task>, seen: &mut HashSet<String>, task: Task| {
        let key = task.dest.to_string_lossy().to_string();
        if seen.insert(key) {
            tasks.push(task);
        }
    };

    let client = meta.get("downloads").and_then(|value| value.get("client"));
    let client_url = client.and_then(|value| value.get("url")).and_then(Value::as_str)
        .ok_or_else(|| format!("Minecraft {id} metadata does not contain a game client download"))?;
    add(&mut tasks, &mut seen, Task {
        url: client_url.into(),
        dest: runtime.paths.client_jar(id)?,
        sha1: client.and_then(|value| value.get("sha1")).and_then(Value::as_str).map(str::to_string),
        size: client.and_then(|value| value.get("size")).and_then(Value::as_u64),
        kind: "client".into(),
        label: "game client".into(),
        skip: false,
    });

    if let Some(libraries) = meta.get("libraries").and_then(Value::as_array) {
        for library in libraries {
            if !rule_allowed(library.get("rules"), &features) {
                continue;
            }
            let artifact = library.pointer("/downloads/artifact");
            if let Some(artifact_path) = artifact.and_then(|value| value.get("path")).and_then(Value::as_str) {
                let dest = safe_join(&runtime.paths.libraries, artifact_path)?;
                if let Some(url) = artifact.and_then(|value| value.get("url")).and_then(Value::as_str).filter(|value| !value.is_empty()) {
                    add(&mut tasks, &mut seen, Task {
                        url: url.into(),
                        dest: dest.clone(),
                        sha1: artifact.and_then(|value| value.get("sha1")).and_then(Value::as_str).map(str::to_string),
                        size: artifact.and_then(|value| value.get("size")).and_then(Value::as_u64),
                        kind: "library".into(),
                        label: artifact_path.rsplit('/').next().unwrap_or(artifact_path).into(),
                        skip: false,
                    });
                }
            }
            let classifier = library.pointer(&format!("/natives/{}", crate::rules::os_name())).and_then(Value::as_str);
            if let Some(classifier) = classifier {
                let native = library.pointer(&format!("/downloads/classifiers/{}", classifier.replace("${arch}", "64")));
                if let (Some(path), Some(url)) = (
                    native.and_then(|value| value.get("path")).and_then(Value::as_str),
                    native.and_then(|value| value.get("url")).and_then(Value::as_str),
                ) {
                    let dest = safe_join(&runtime.paths.libraries, path)?;
                    add(&mut tasks, &mut seen, Task {
                        url: url.into(),
                        dest: dest.clone(),
                        sha1: native.and_then(|value| value.get("sha1")).and_then(Value::as_str).map(str::to_string),
                        size: native.and_then(|value| value.get("size")).and_then(Value::as_u64),
                        kind: "native".into(),
                        label: path.rsplit('/').next().unwrap_or(path).into(),
                        skip: false,
                    });
                    let exclude = library.pointer("/extract/exclude").and_then(Value::as_array)
                        .map(|values| values.iter().filter_map(Value::as_str).map(str::to_string).collect())
                        .unwrap_or_default();
                    native_jars.push(NativeJar { jar: dest, exclude });
                }
            }
        }
    }

    if let Some(logging) = meta.pointer("/logging/client/file") {
        if let (Some(url), Some(file_id)) = (
            logging.get("url").and_then(Value::as_str),
            logging.get("id").and_then(Value::as_str),
        ) {
            add(&mut tasks, &mut seen, Task {
                url: url.into(),
                dest: runtime.paths.log_config(file_id)?,
                sha1: logging.get("sha1").and_then(Value::as_str).map(str::to_string),
                size: logging.get("size").and_then(Value::as_u64),
                kind: "logging".into(),
                label: file_id.into(),
                skip: false,
            });
        }
    }

    if let Some(objects) = asset_index.and_then(|index| index.get("objects")).and_then(Value::as_object) {
        for (name, object) in objects {
            let Some(hash) = object.get("hash").and_then(Value::as_str) else { continue };
            if !regex::Regex::new(r"(?i)^[0-9a-f]{40}$").unwrap().is_match(hash) {
                continue;
            }
            let hash = hash.to_lowercase();
            let dest = runtime.paths.asset_object(&hash)?;
            asset_count += 1;
            add(&mut tasks, &mut seen, Task {
                url: format!("{ASSET_BASE}/{}/{}", &hash[..2], hash),
                dest,
                sha1: Some(hash),
                size: object.get("size").and_then(Value::as_u64),
                kind: "asset".into(),
                label: name.clone(),
                skip: false,
            });
        }
    }

    let total_bytes = tasks.iter().map(|task| task.size.unwrap_or(0)).sum();
    Ok(Plan { tasks, natives: native_jars, total_bytes, asset_count })
}

async fn download_tasks(runtime: &Arc<Runtime>, id: &str, mut plan: Plan) -> Result<(), String> {
    let total_files = plan.tasks.len();
    let mut skipped_files = 0usize;
    let mut done_bytes = 0u64;
    for task in &mut plan.tasks {
        if let Ok(meta) = tokio::fs::metadata(&task.dest).await {
            if meta.is_file() && (task.size.is_none() || Some(meta.len()) == task.size) {
                task.skip = true;
                skipped_files += 1;
                done_bytes += task.size.unwrap_or(meta.len());
            }
        }
    }
    let total_bytes = plan.total_bytes;
    let pending: Vec<Task> = plan.tasks.into_iter().filter(|task| !task.skip).collect();
    runtime.log("launcher", "info", &format!(
        "Install plan: {total_files} files ({}); {skipped_files} already present.",
        format_bytes(total_bytes)
    ));
    if pending.is_empty() {
        emit_progress(runtime, serde_json::json!({
            "versionId": id, "stage": "asset", "label": "Checking files", "percent": 99,
            "bytesDone": total_bytes, "bytesTotal": total_bytes,
            "filesDone": total_files, "filesTotal": total_files,
            "currentFile": "", "indeterminate": false
        }), true);
        return Ok(());
    }

    let bytes = Arc::new(AtomicU64::new(done_bytes));
    let files = Arc::new(AtomicUsize::new(skipped_files));
    let current = Arc::new(Mutex::new(String::new()));
    let last_emit = Arc::new(Mutex::new(std::time::Instant::now() - Duration::from_secs(1)));
    let file_total = total_files;
    let client = runtime.http.clone();
    let results = futures_util::stream::iter(pending.into_iter().map(|task| {
        let client = client.clone();
        let bytes = bytes.clone();
        let files = files.clone();
        let current = current.clone();
        let last_emit = last_emit.clone();
        let runtime = runtime.clone();
        let id = id.to_string();
        async move {
            *current.lock().unwrap_or_else(|e| e.into_inner()) = task.label.clone();
            download_file(&client, &task.url, &task.dest, task.sha1.as_deref(), None, task.size).await?;
            let done_bytes = bytes.fetch_add(task.size.unwrap_or(0), Ordering::Relaxed) + task.size.unwrap_or(0);
            let done_files = files.fetch_add(1, Ordering::Relaxed) + 1;
            let should_emit = {
                let mut last = last_emit.lock().unwrap_or_else(|e| e.into_inner());
                if last.elapsed() >= Duration::from_millis(130) || done_files == file_total {
                    *last = std::time::Instant::now();
                    true
                } else {
                    false
                }
            };
            if should_emit {
                let percent = if total_bytes > 0 {
                    (done_bytes.saturating_mul(100) / total_bytes).min(99) as u64
                } else {
                    (done_files * 100 / file_total.max(1)).min(99) as u64
                };
                let label = format!("Downloading {}…", task.kind);
                crate::installer::emit_progress(&runtime, serde_json::json!({
                    "versionId": id,
                    "stage": task.kind,
                    "label": label,
                    "percent": percent,
                    "bytesDone": done_bytes,
                    "bytesTotal": total_bytes,
                    "filesDone": done_files,
                    "filesTotal": file_total,
                    "currentFile": *current.lock().unwrap_or_else(|e| e.into_inner()),
                    "indeterminate": false,
                    "totalBytesLabel": format_bytes(total_bytes),
                    "doneBytesLabel": format_bytes(done_bytes)
                }), false);
            }
            Ok::<(), String>(())
        }
    }))
    .buffer_unordered(10)
    .collect::<Vec<_>>()
    .await;
    for result in results {
        result?;
    }
    Ok(())
}

fn emit_progress(runtime: &Arc<Runtime>, payload: Value, force: bool) {
    if force || payload.get("percent").and_then(Value::as_u64).unwrap_or(0) < 100 {
        runtime.emit("install:progress", payload.clone());
    }
    let mut state = runtime.state();
    if state.installing.is_some() {
        if let Some(object) = payload.as_object() {
            let mut current = state.installing.take().and_then(|value| value.as_object().cloned()).unwrap_or_default();
            for (key, value) in object {
                current.insert(key.clone(), value.clone());
            }
            state.installing = Some(Value::Object(current));
        }
    }
}

async fn extract_natives(id: &str, paths: &crate::paths::McPaths, jars: &[NativeJar]) -> Result<(), String> {
    if jars.is_empty() {
        return Ok(());
    }
    let native_dir = paths.natives_dir(id)?;
    tokio::fs::create_dir_all(&native_dir).await.map_err(|e| e.to_string())?;
    for native in jars {
        let jar = native.jar.clone();
        let destination = native_dir.clone();
        let exclude = native.exclude.clone();
        tokio::task::spawn_blocking(move || -> Result<(), String> {
            let file = fs::File::open(&jar).map_err(|e| e.to_string())?;
            let mut archive = ZipArchive::new(file).map_err(|e| e.to_string())?;
            for index in 0..archive.len() {
                let mut entry = archive.by_index(index).map_err(|e| e.to_string())?;
                let Some(path) = entry.enclosed_name() else { continue };
                let path = path.to_string_lossy().replace('\\', "/");
                if entry.is_dir() || path.starts_with("META-INF/") {
                    continue;
                }
                if exclude.iter().any(|prefix| path.starts_with(prefix)) {
                    continue;
                }
                let target = safe_join(&destination, &path)?;
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                let mut output = fs::File::create(&target).map_err(|e| e.to_string())?;
                std::io::copy(&mut entry, &mut output).map_err(|e| e.to_string())?;
            }
            Ok(())
        })
        .await
        .map_err(|e| e.to_string())??;
    }
    Ok(())
}

async fn prepare_legacy_assets(
    runtime: &Runtime,
    id: &str,
    meta: &Value,
    asset_index: Option<&Value>,
    game_dir: &Path,
) -> Result<(), String> {
    let Some(index) = asset_index else { return Ok(()) };
    let mut targets = Vec::new();
    if index.get("virtual").and_then(Value::as_bool).unwrap_or(false) {
        if let Some(assets) = meta.get("assets").and_then(Value::as_str) {
            targets.push(runtime.paths.virtual_assets(assets)?);
        }
    }
    if index.get("map_to_resources").and_then(Value::as_bool).unwrap_or(false) {
        targets.push(game_dir.join("resources"));
    }
    if targets.is_empty() {
        return Ok(());
    }
    let Some(objects) = index.get("objects").and_then(Value::as_object) else { return Ok(()) };
    runtime.log("launcher", "info", &format!("Preparing {} legacy asset files...", objects.len()));
    for (name, object) in objects {
        let Some(hash) = object.get("hash").and_then(Value::as_str) else { continue };
        let source = runtime.paths.asset_object(hash)?;
        if !source.is_file() {
            return Err(format!("Legacy asset {name} is missing from the object cache"));
        }
        for root in &targets {
            let destination = safe_join(root, name)?;
            if let Some(parent) = destination.parent() {
                tokio::fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
            }
            if tokio::fs::metadata(&destination).await.map(|m| m.is_file()).unwrap_or(false) {
                continue;
            }
            if tokio::fs::hard_link(&source, &destination).await.is_err() {
                tokio::fs::copy(&source, &destination).await.map_err(|e| e.to_string())?;
            }
        }
    }
    let _ = id;
    Ok(())
}

fn read_meta(path: &Path) -> Result<Value, String> {
    let raw = fs::read_to_string(path).map_err(|e| format!("Could not read version metadata: {e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("Invalid version metadata: {e}"))
}
