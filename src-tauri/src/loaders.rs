use crate::model::LoaderDescriptor;
use crate::paths::validate_version_id;
use crate::runtime::Runtime;
use crate::util::*;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;

const FABRIC_META: &str = "https://meta.fabricmc.net/v2";
const FORGE_PROMOTIONS: &str = "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json";
const FORGE_MAVEN: &str = "https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml";
const NEOFORGE_MAVEN: &str = "https://maven.neoforged.net/api/maven/versions/releases";

pub fn normalize_loader(value: &str) -> Result<&'static str, String> {
    match value.trim().to_lowercase().as_str() {
        "fabric" => Ok("fabric"),
        "forge" => Ok("forge"),
        "neoforge" => Ok("neoforge"),
        _ => Err("Choose Fabric, Forge, or NeoForge.".into()),
    }
}

pub fn loader_label(value: &str) -> &'static str {
    match value {
        "fabric" => "Fabric",
        "forge" => "Forge",
        "neoforge" => "NeoForge",
        _ => "Loader",
    }
}

pub fn validate_loader_version(value: &str) -> Result<String, String> {
    if value.is_empty() || !regex::Regex::new(r"^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$").unwrap().is_match(value) {
        return Err("Invalid mod loader version.".into());
    }
    Ok(value.into())
}

fn version_parts(value: &str) -> Vec<String> {
    value.split(|c: char| !c.is_ascii_alphanumeric()).filter(|v| !v.is_empty()).map(str::to_string).collect()
}

pub fn compare_versions(left: &str, right: &str) -> std::cmp::Ordering {
    let a = version_parts(left);
    let b = version_parts(right);
    for index in 0..a.len().max(b.len()) {
        let av = a.get(index).map(String::as_str).unwrap_or("0");
        let bv = b.get(index).map(String::as_str).unwrap_or("0");
        match (av.parse::<u64>(), bv.parse::<u64>()) {
            (Ok(an), Ok(bn)) if an != bn => return an.cmp(&bn),
            (Ok(_), Ok(_)) => {}
            _ => {
                let order = av.cmp(bv);
                if order != std::cmp::Ordering::Equal {
                    return order;
                }
            }
        }
    }
    std::cmp::Ordering::Equal
}

pub fn pick(loaders: &[LoaderDescriptor]) -> Option<LoaderDescriptor> {
    loaders.iter().find(|entry| entry.recommended)
        .or_else(|| loaders.iter().find(|entry| entry.stable))
        .or_else(|| loaders.first())
        .cloned()
}

pub async fn fetch_loader_versions(runtime: &Arc<Runtime>, loader: &str, game_version: &str) -> Result<Vec<LoaderDescriptor>, String> {
    let kind = normalize_loader(loader)?;
    let game = validate_version_id(game_version)?;
    let key = format!("{kind}:{game}");
    if let Some(cached) = runtime.state().loader_cache.get(&key) {
        if now_ms() - cached.fetched_at < 10 * 60 * 1000 {
            return Ok(cached.loaders.clone());
        }
    }
    let list = match kind {
        "fabric" => fetch_fabric_loaders(&runtime, &game).await?,
        "forge" => fetch_forge_loaders(&runtime, &game).await?,
        _ => fetch_neoforge_loaders(&runtime, &game).await?,
    };
    if list.is_empty() {
        return Err(format!("{} does not publish a loader for Minecraft {game}.", loader_label(kind)));
    }
    runtime.state().loader_cache.insert(key, crate::model::CachedLoaders { loaders: list.clone(), fetched_at: now_ms() });
    Ok(list)
}

async fn fetch_fabric_loaders(runtime: &Runtime, game: &str) -> Result<Vec<LoaderDescriptor>, String> {
    let url = format!("{FABRIC_META}/versions/loader/{}", urlencode(game));
    let raw = fetch_json(&runtime.http, &url).await.map_err(|error| format!("Could not reach Fabric: {error}"))?;
    let Some(items) = raw.as_array() else { return Err("Fabric returned an unexpected loader list.".into()) };
    let mut rows = Vec::new();
    for item in items {
        let loader = item.get("loader").unwrap_or(&Value::Null);
        let Some(version) = loader.get("version").and_then(Value::as_str) else { continue };
        rows.push(LoaderDescriptor {
            version: version.into(),
            stable: loader.get("stable").and_then(Value::as_bool).unwrap_or(false),
            recommended: false,
            channel: String::new(),
            installer_version: String::new(),
            artifact: String::new(),
            minimum_java: item.pointer("/launcherMeta/min_java_version").and_then(Value::as_u64).unwrap_or(0) as u32,
            maven: loader.get("maven").cloned().unwrap_or(Value::Null),
        });
    }
    rows.sort_by(|left, right| compare_versions(&right.version, &left.version));
    Ok(rows)
}

async fn fetch_forge_loaders(runtime: &Runtime, game: &str) -> Result<Vec<LoaderDescriptor>, String> {
    let (promotions_result, maven_result) = tokio::join!(
        fetch_json(&runtime.http, FORGE_PROMOTIONS),
        fetch_text(&runtime.http, FORGE_MAVEN)
    );
    let mut found: std::collections::HashMap<String, LoaderDescriptor> = std::collections::HashMap::new();
    if let Ok(xml) = maven_result {
        let prefix = format!("{game}-");
        let regex = regex::Regex::new(r"<version>([^<]+)</version>").unwrap();
        for captures in regex.captures_iter(&xml) {
            let raw = captures[1].trim();
            if !raw.starts_with(&prefix) { continue; }
            let version = raw[prefix.len()..].to_string();
            if validate_loader_version(&version).is_err() { continue; }
            found.insert(version.clone(), LoaderDescriptor {
                version,
                stable: true,
                recommended: false,
                channel: String::new(),
                installer_version: raw.into(),
                artifact: "forge".into(),
                minimum_java: if game == "1.16.5" || game == "1.17.1" { 8 } else if game >= "1.18" { 17 } else { 8 },
                maven: Value::Null,
            });
        }
    }
    if let Ok(promotions) = &promotions_result {
        let source = promotions.get("promos").and_then(Value::as_object).or_else(|| promotions.as_object());
        if let Some(source) = source {
            let prefix = format!("{game}-");
            for (key, value) in source {
                let Some(version) = value.as_str() else { continue };
                if !key.starts_with(&prefix) { continue; }
                let channel = &key[prefix.len()..];
                if channel != "latest" && channel != "recommended" { continue; }
                if validate_loader_version(version).is_err() { continue; }
                let entry = found.entry(version.into()).or_insert_with(|| LoaderDescriptor {
                    version: version.into(),
                    stable: true,
                    recommended: false,
                    channel: String::new(),
                    installer_version: format!("{game}-{version}"),
                    artifact: "forge".into(),
                    minimum_java: if game >= "1.18" { 17 } else { 8 },
                    maven: Value::Null,
                });
                if channel == "recommended" {
                    entry.recommended = true;
                    entry.channel = "recommended".into();
                } else if entry.channel.is_empty() {
                    entry.channel = "latest".into();
                }
            }
        }
    }
    if found.is_empty() {
        if let Err(error) = promotions_result {
            return Err(format!("Could not reach Forge: {error}"));
        }
        return Err(format!("Forge does not publish a loader for Minecraft {game}."));
    }
    let mut rows: Vec<_> = found.into_values().collect();
    rows.sort_by(|left, right| compare_versions(&right.version, &left.version));
    Ok(rows)
}

fn neo_prefix(game: &str) -> Option<String> {
    let parts: Vec<&str> = game.split('.').collect();
    if parts.len() < 2 || parts[0] != "1" {
        return None;
    }
    Some(format!("{}.{}", parts[1], parts.get(2).copied().unwrap_or("0")))
}

async fn fetch_neoforge_loaders(runtime: &Runtime, game: &str) -> Result<Vec<LoaderDescriptor>, String> {
    let legacy = game == "1.20.1";
    let artifact = if legacy { "forge" } else { "neoforge" };
    let url = format!("{NEOFORGE_MAVEN}/net/neoforged/{artifact}");
    let raw = fetch_json(&runtime.http, &url).await.map_err(|error| format!("Could not reach NeoForge: {error}"))?;
    let Some(items) = raw.get("versions").and_then(Value::as_array) else { return Err("NeoForge returned an unexpected version list.".into()) };
    let prefix = if legacy { format!("{game}-") } else {
        format!("{}.", neo_prefix(game).ok_or_else(|| format!("NeoForge does not publish a loader for Minecraft {game}."))?)
    };
    let mut rows = Vec::new();
    for item in items {
        let Some(raw_version) = item.as_str() else { continue };
        if !raw_version.starts_with(&prefix) { continue; }
        let version = if legacy { raw_version[prefix.len()..].to_string() } else { raw_version.into() };
        if validate_loader_version(&version).is_err() { continue; }
        rows.push(LoaderDescriptor {
            version,
            stable: true,
            recommended: false,
            channel: "latest".into(),
            installer_version: raw_version.into(),
            artifact: artifact.into(),
            minimum_java: 21,
            maven: Value::Null,
        });
    }
    rows.sort_by(|left, right| compare_versions(&right.version, &left.version));
    if let Some(first) = rows.first_mut() {
        first.recommended = true;
    }
    Ok(rows)
}

fn urlencode(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

pub async fn fetch_fabric_profile(runtime: &Runtime, game: &str, loader: &str) -> Result<Value, String> {
    let game = validate_version_id(game)?;
    let loader = validate_loader_version(loader)?;
    let url = format!("{FABRIC_META}/versions/loader/{}/{}/profile/json", urlencode(&game), urlencode(&loader));
    let profile = fetch_json(&runtime.http, &url).await?;
    if profile.get("mainClass").and_then(Value::as_str).is_none() {
        return Err("Fabric returned an invalid loader profile.".into());
    }
    Ok(profile)
}

fn maven_coordinate(value: &str) -> Option<(String, String, String, String, String)> {
    let parts: Vec<&str> = value.split(':').collect();
    if parts.len() < 3 || parts.len() > 5 { return None; }
    let group = parts[0];
    let artifact = parts[1];
    let version = parts[2];
    let classifier = parts.get(3).copied().unwrap_or("");
    let extension = parts.get(4).copied().unwrap_or("jar");
    let ok = |value: &str| !value.is_empty() && value.chars().all(|c| c.is_ascii_alphanumeric() || "._+-".contains(c));
    if !ok(group) || !ok(artifact) || !ok(version) || (!classifier.is_empty() && !ok(classifier)) || !extension.chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    Some((group.into(), artifact.into(), version.into(), classifier.into(), extension.into()))
}

fn normalize_library(library: &Value) -> Option<Value> {
    let name = library.get("name").and_then(Value::as_str)?;
    let (group, artifact, version, classifier, extension) = maven_coordinate(name)?;
    let file = format!("{artifact}-{version}{}{}.{}", if classifier.is_empty() { "" } else { "-" }, classifier, extension);
    let path = format!("{}/{}/{}/{}", group.replace('.', "/"), artifact, version, file);
    let mut artifact_value = json!({ "path": path });
    if let Some(downloads) = library.get("downloads") {
        if let Some(item) = downloads.get("artifact") {
            if let Some(path) = item.get("path").and_then(Value::as_str) {
                if !path.is_empty() && !path.contains("..") {
                    artifact_value["path"] = json!(path);
                }
            }
            if let Some(url) = item.get("url").and_then(Value::as_str) {
                artifact_value["url"] = json!(url);
            }
            if let Some(sha1) = item.get("sha1").and_then(Value::as_str) {
                artifact_value["sha1"] = json!(sha1);
            }
            if let Some(size) = item.get("size").and_then(Value::as_u64) {
                artifact_value["size"] = json!(size);
            }
        }
    }
    if artifact_value.get("url").is_none() {
        if let Some(base) = library.get("url").and_then(Value::as_str).filter(|value| !value.is_empty()) {
            artifact_value["url"] = json!(format!("{}/{}", base.trim_end_matches('/'), artifact_value["path"].as_str().unwrap_or("")));
        } else {
            artifact_value["url"] = json!("");
        }
    }
    let mut result = json!({
        "name": name,
        "downloads": { "artifact": artifact_value }
    });
    if let Some(rules) = library.get("rules") {
        result["rules"] = rules.clone();
    }
    if let Some(natives) = library.get("natives") {
        result["natives"] = natives.clone();
    }
    if let Some(extract) = library.get("extract") {
        result["extract"] = extract.clone();
    }
    Some(result)
}

pub fn merge_metadata(base: &Value, profile: &Value, options: &Value) -> Result<Value, String> {
    if base.get("mainClass").and_then(Value::as_str).is_none() {
        return Err("Mojang returned invalid base version metadata.".into());
    }
    if profile.get("mainClass").and_then(Value::as_str).is_none() {
        return Err("The loader returned an invalid profile.".into());
    }
    let version_id = validate_version_id(options.get("versionId").and_then(Value::as_str).unwrap_or(""))?;
    let mut merged = base.clone();
    let mut seen = HashSet::new();
    let mut libraries = Vec::new();
    if let Some(base_libraries) = base.get("libraries").and_then(Value::as_array) {
        for library in base_libraries {
            if let Some(name) = library.get("name").and_then(Value::as_str) {
                if seen.insert(name.to_string()) {
                    libraries.push(library.clone());
                }
            }
        }
    }
    if let Some(profile_libraries) = profile.get("libraries").and_then(Value::as_array) {
        for library in profile_libraries {
            let Some(normalized) = normalize_library(library) else { continue };
            if let Some(name) = normalized.get("name").and_then(Value::as_str) {
                if seen.insert(name.to_string()) {
                    libraries.push(normalized);
                }
            }
        }
    }
    let base_arguments = base.get("arguments").cloned().unwrap_or_else(|| json!({}));
    let profile_arguments = profile.get("arguments").cloned().unwrap_or_else(|| json!({}));
    let mut game_args = base_arguments.get("game").and_then(Value::as_array).cloned().unwrap_or_default();
    game_args.extend(profile_arguments.get("game").and_then(Value::as_array).cloned().unwrap_or_default());
    let mut jvm_args = base_arguments.get("jvm").and_then(Value::as_array).cloned().unwrap_or_default();
    jvm_args.extend(profile_arguments.get("jvm").and_then(Value::as_array).cloned().unwrap_or_default());
    merged["id"] = json!(version_id);
    merged["type"] = json!("release");
    merged["mainClass"] = profile.get("mainClass").cloned().unwrap_or(Value::Null);
    merged["libraries"] = Value::Array(libraries);
    if !game_args.is_empty() || !jvm_args.is_empty() {
        merged["arguments"] = json!({ "game": game_args, "jvm": jvm_args });
    }
    if game_args.is_empty() {
        if let Some(legacy) = base.get("minecraftArguments") {
            merged["minecraftArguments"] = legacy.clone();
        }
    }
    let time = iso_now();
    merged["releaseTime"] = json!(time);
    merged["time"] = json!(time);
    if let Some(object) = merged.as_object_mut() {
        object.remove("inheritsFrom");
    }
    let minimum = options.get("minimumJava").and_then(Value::as_u64).unwrap_or(0);
    let base_java = base.pointer("/javaVersion/majorVersion").and_then(Value::as_u64).unwrap_or(8);
    if minimum > base_java {
        merged["javaVersion"] = json!({ "component": "java-runtime-gamma", "majorVersion": minimum });
    }
    let loader = options.get("loader").and_then(Value::as_str).unwrap_or("fabric");
    merged["launcher"] = json!({
        "eclipse": {
            "kind": "modpack",
            "name": options.get("name").and_then(Value::as_str).unwrap_or(""),
            "loader": loader,
            "loaderVersion": options.get("loaderVersion").and_then(Value::as_str).unwrap_or(""),
            "installerVersion": options.get("installerVersion").and_then(Value::as_str).unwrap_or(""),
            "gameVersion": options.get("gameVersion").and_then(Value::as_str).or_else(|| base.get("id").and_then(Value::as_str)).unwrap_or(""),
            "createdAt": time
        }
    });
    Ok(merged)
}

fn installer_url(loader: &str, descriptor: &LoaderDescriptor) -> Result<String, String> {
    let version = validate_loader_version(&descriptor.installer_version)?;
    match loader {
        "forge" => Ok(format!(
            "https://maven.minecraftforge.net/net/minecraftforge/forge/{}/forge-{}-installer.jar",
            urlencode(&version), urlencode(&version)
        )),
        "neoforge" => {
            let artifact = if descriptor.artifact == "forge" { "forge" } else { "neoforge" };
            Ok(format!(
                "https://maven.neoforged.net/releases/net/neoforged/{}/{}/{}-{}-installer.jar",
                artifact, urlencode(&version), artifact, urlencode(&version)
            ))
        }
        _ => Err("Fabric does not need an installer download.".into()),
    }
}

pub async fn install_loader_profile(
    runtime: &Arc<Runtime>,
    loader: &str,
    descriptor: &LoaderDescriptor,
    game_version: &str,
    base_meta: &Value,
) -> Result<(Value, String), String> {
    let label = loader_label(loader);
    if descriptor.installer_version.is_empty() {
        return Err(format!("{label} did not provide installer information."));
    }
    let installer_version = validate_loader_version(&descriptor.installer_version)?;
    let url = installer_url(loader, descriptor)?;
    let installers = runtime.data_root.join("cache").join("loaders");
    tokio::fs::create_dir_all(&installers).await.map_err(|e| e.to_string())?;
    let file_name = format!("{loader}-{installer_version}-installer.jar");
    let installer_path = installers.join(file_name);
    runtime.paths.ensure()?;
    let profiles_file = runtime.paths.root.join("launcher_profiles.json");
    if !profiles_file.exists() {
        tokio::fs::write(&profiles_file, r#"{
  "profiles": {},
  "settings": {},
  "version": 3
}"#).await.map_err(|e| e.to_string())?;
    }
    emit_progress(runtime, json!({
        "phase": "loader",
        "label": format!("Downloading {label} {installer_version} installer…"),
        "percent": 4,
        "indeterminate": true
    }));
    download_file(&runtime.http, &url, &installer_path, None, None, None).await?;
    let java = crate::launch::choose_java_for(runtime, base_meta).await
        .map_err(|error| format!("The {label} installer needs a compatible Java runtime: {error}"))?;
    emit_progress(runtime, json!({
        "phase": "loader",
        "label": format!("Running the {label} installer. This can take a minute…"),
        "percent": 8,
        "indeterminate": true
    }));
    runtime.log("launcher", "info", &format!("Running the official {label} {installer_version} installer..."));
    let started = now_ms();
    let args = vec![
        "-jar".into(),
        installer_path.to_string_lossy().to_string(),
        "--installClient".into(),
        runtime.paths.root.to_string_lossy().to_string(),
    ];
    let (ok, code, stdout, stderr) = run_command(&java.path, &args, 600).await?;
    if !ok {
        let detail = strip_ansi(&format!("{stdout}\n{stderr}")).trim().chars().rev().take(1600).collect::<String>().chars().rev().collect::<String>();
        runtime.log("launcher", "error", &format!("{label} installer output:\n{}", if detail.is_empty() { "(no output)" } else { &detail }));
        return Err(format!(
            "The {label} installer failed{}. {}",
            code.map(|value| format!(" (exit code {value})")).unwrap_or_default(),
            detail.lines().rev().take(3).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join(" ")
        ));
    }
    let profile = find_installed_profile(runtime, loader, descriptor, game_version, started).await?;
    emit_progress(runtime, json!({
        "phase": "loader",
        "label": format!("{label} {} installed", descriptor.version),
        "percent": 18,
        "indeterminate": true
    }));
    runtime.log("launcher", "info", &format!("Installed {label} profile {}.", profile.get("id").and_then(Value::as_str).unwrap_or("unknown")));
    Ok((profile, installer_version))
}

async fn find_installed_profile(
    runtime: &Runtime,
    loader: &str,
    descriptor: &LoaderDescriptor,
    game_version: &str,
    started_at: i64,
) -> Result<Value, String> {
    let mut candidates = Vec::new();
    let expected_ids = HashSet::from([
        format!("{game_version}-forge-{}", descriptor.version),
        format!("neoforge-{}", descriptor.installer_version),
        format!("{game_version}-neoforge-{}", descriptor.version),
    ]);
    let entries = std::fs::read_dir(&runtime.paths.versions).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        if !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) { continue; }
        let dir_id = entry.file_name().to_string_lossy().to_string();
        let path = entry.path().join(format!("{dir_id}.json"));
        let Ok(raw) = std::fs::read_to_string(&path) else { continue };
        let Ok(profile) = serde_json::from_str::<Value>(&raw) else { continue };
        if profile.get("id").and_then(Value::as_str) != Some(&dir_id) { continue; }
        if profile.get("mainClass").and_then(Value::as_str).is_none() { continue; }
        if profile.get("inheritsFrom").and_then(Value::as_str) != Some(game_version) { continue; }
        if profile.pointer("/launcher/eclipse").is_some() { continue; }
        let hint = format!("{} {}", dir_id, profile.get("mainClass").and_then(Value::as_str).unwrap_or("")).to_lowercase();
        if loader == "forge" && !hint.contains("forge") { continue; }
        if loader == "neoforge" && !hint.contains("neoforge") && !hint.contains("forge") { continue; }
        let modified = std::fs::metadata(&path).and_then(|meta| meta.modified()).ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as i64)
            .unwrap_or(0);
        candidates.push((profile, modified, expected_ids.contains(&dir_id), modified >= started_at - 5000));
    }
    candidates.sort_by(|left, right| right.2.cmp(&left.2).then_with(|| right.1.cmp(&left.1)));
    let fallback = candidates.first().cloned();
    candidates.into_iter().find(|row| row.3).or(fallback)
        .map(|row| row.0)
        .ok_or_else(|| format!("The {} installer finished, but Eclipse Client could not find the generated game profile.", loader_label(loader)))
}

fn emit_progress(runtime: &Runtime, payload: Value) {
    runtime.emit("modpack:progress", payload);
}

pub fn _unused_path(path: PathBuf) -> PathBuf {
    path
}
