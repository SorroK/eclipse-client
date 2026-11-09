use crate::loaders;
use crate::model::{ContentEntry, ContentFile, ModpackRecord};
use crate::modrinth;
use crate::paths::{safe_join, validate_pack_path, validate_version_id};
use crate::runtime::Runtime;
use crate::util::*;
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use zip::ZipArchive;

const CONTENT_FILE: &str = "eclipse-content.json";

fn clean_name(value: &str) -> String {
    let value = value.chars().filter(|c| !c.is_control()).collect::<String>();
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn content_folder(kind: &str) -> Option<&'static str> {
    match kind {
        "mod" => Some("mods"),
        "resourcepack" => Some("resourcepacks"),
        "shader" => Some("shaderpacks"),
        _ => None,
    }
}

fn emit(runtime: &Runtime, value: Value) {
    runtime.emit("modpack:progress", value);
}

fn public_instance(runtime: &Runtime, instance: &ModpackRecord) -> Value {
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
        "gameDir": runtime.modpack_game_dir(&instance.id)
    })
}

fn next_id(runtime: &Runtime, name: &str, game_version: &str) -> Result<String, String> {
    let name_part = if slugify(name).is_empty() { "modpack".into() } else { slugify(name) };
    let version_part = if slugify(game_version).is_empty() { "minecraft".into() } else { slugify(game_version) };
    let base = format!("eclipse-{name_part}-{version_part}");
    let base = base.chars().take(60).collect::<String>().trim_end_matches('-').to_string();
    let mut candidate = base.clone();
    let mut suffix = 2;
    loop {
        validate_version_id(&candidate)?;
        let exists = runtime.state().modpacks.iter().any(|instance| instance.id == candidate)
            || runtime.paths.version_dir(&candidate).map(|path| path.exists()).unwrap_or(false)
            || runtime.modpack_game_dir(&candidate).exists();
        if !exists {
            return Ok(candidate);
        }
        let suffix_text = format!("-{suffix}");
        candidate = format!("{}{}", base.chars().take(60 - suffix_text.len()).collect::<String>(), suffix_text);
        suffix += 1;
    }
}

fn write_instance(instance: &ModpackRecord, runtime: &Runtime, base_version: &str) -> Result<(), String> {
    let dir = runtime.modpack_game_dir(&instance.id);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut data = serde_json::to_value(instance).map_err(|e| e.to_string())?;
    if let Some(object) = data.as_object_mut() {
        object.insert("baseVersion".into(), json!(base_version));
    }
    fs::write(dir.join("instance.json"), serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

pub async fn create_modpack(runtime: &Arc<Runtime>, input: Value) -> Result<Value, String> {
    let name = clean_name(input.get("name").and_then(Value::as_str).unwrap_or(""));
    if name.chars().count() < 2 || name.chars().count() > 48 {
        return Err("Modpack names must be between 2 and 48 characters.".into());
    }
    let game_version = validate_version_id(input.get("gameVersion").and_then(Value::as_str).unwrap_or(""))
        .map_err(|_| "Choose a valid Minecraft version for the modpack.".to_string())?;
    let loader = loaders::normalize_loader(input.get("loader").and_then(Value::as_str).unwrap_or("fabric"))?;
    let label = loaders::loader_label(loader);
    let entry = runtime.get_manifest_entry(&game_version).await?;
    if entry.get("url").and_then(Value::as_str).is_none() {
        return Err(format!("Minecraft {game_version} is not available from Mojang right now."));
    }
    let available = loaders::fetch_loader_versions(runtime, loader, &game_version).await?;
    let requested = input.get("loaderVersion").and_then(Value::as_str).unwrap_or("").trim().to_string();
    let descriptor = if requested.is_empty() {
        loaders::pick(&available)
    } else {
        loaders::validate_loader_version(&requested)?;
        available.iter().find(|entry| entry.version == requested).cloned()
    };
    let Some(descriptor) = descriptor else {
        return Err(if requested.is_empty() {
            format!("{label} does not publish a loader for Minecraft {game_version}.")
        } else {
            format!("{label} loader {requested} is not available for Minecraft {game_version}.")
        });
    };
    let base_url = entry.get("url").and_then(Value::as_str).ok_or("Minecraft metadata is missing a download URL.")?;
    let base_meta = fetch_json(&runtime.http, base_url).await?;
    let mut installer_version = String::new();
    let profile = if loader == "fabric" {
        emit(runtime, json!({
            "phase": "metadata",
            "label": format!("Fetching Fabric {} metadata…", descriptor.version),
            "percent": 5,
            "indeterminate": true
        }));
        loaders::fetch_fabric_profile(runtime, &game_version, &descriptor.version).await?
    } else {
        let (profile, version) = loaders::install_loader_profile(runtime, loader, &descriptor, &game_version, &base_meta).await?;
        installer_version = version;
        profile
    };
    let id = next_id(runtime, &name, &game_version)?;
    emit(runtime, json!({
        "phase": "metadata",
        "label": format!("Packaging {label} {}…", descriptor.version),
        "percent": 22,
        "indeterminate": true
    }));
    let meta = loaders::merge_metadata(&base_meta, &profile, &json!({
        "versionId": id,
        "name": name,
        "gameVersion": game_version,
        "loader": loader,
        "loaderVersion": descriptor.version,
        "installerVersion": installer_version,
        "minimumJava": descriptor.minimum_java
    }))?;
    let created_at = iso_now();
    if let Some(object) = meta.get("launcher").and_then(|value| value.get("eclipse")).and_then(Value::as_object) {
        let _ = object;
    }
    let version_dir = runtime.paths.version_dir(&id)?;
    let result = async {
        tokio::fs::create_dir_all(&version_dir).await.map_err(|e| e.to_string())?;
        let version_file = runtime.paths.version_json(&id)?;
        let raw = serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?;
        tokio::fs::write(&version_file, raw).await.map_err(|e| e.to_string())?;
        let source = input.get("source").filter(|value| value.is_object()).cloned().unwrap_or_else(|| json!({ "type": "custom" }));
        let instance = ModpackRecord {
            id: id.clone(),
            name: name.clone(),
            kind: "modpack".into(),
            loader: loader.into(),
            loader_version: descriptor.version.clone(),
            game_version: game_version.clone(),
            created_at,
            source,
            essentials_enabled: true,
            render_distances: Default::default(),
        };
        let game_dir = runtime.modpack_game_dir(&id);
        for folder in ["mods", "resourcepacks", "shaderpacks"] {
            tokio::fs::create_dir_all(game_dir.join(folder)).await.map_err(|e| e.to_string())?;
        }
        write_instance(&instance, runtime, base_meta.get("id").and_then(Value::as_str).unwrap_or(&game_version))?;
        runtime.state().modpacks.push(instance.clone());
        runtime.save_modpacks()?;
        runtime.log("launcher", "info", &format!("Created {label} modpack \"{name}\" ({id}) for Minecraft {game_version}."));
        emit(runtime, json!({
            "phase": "complete",
            "label": format!("{label} pack ready"),
            "percent": 100,
            "indeterminate": false
        }));
        Ok::<Value, String>(public_instance(runtime, &instance))
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_dir_all(&version_dir).await;
        let _ = tokio::fs::remove_dir_all(runtime.modpack_game_dir(&id)).await;
        runtime.state().modpacks.retain(|row| row.id != id);
        let _ = runtime.save_modpacks();
    }
    result
}

pub async fn list_loader_versions(runtime: &Arc<Runtime>, loader: &str, game_version: &str) -> Result<Value, String> {
    let list = loaders::fetch_loader_versions(runtime, loader, game_version).await?;
    serde_json::to_value(list).map_err(|e| e.to_string())
}

fn delete_pack_files(runtime: &Arc<Runtime>, version_id: &str) -> Result<Value, String> {
    let id = validate_version_id(version_id)?;
    let Some(instance) = runtime.find_modpack(&id) else {
        return Err("That modpack no longer exists.".into());
    };
    let game_dir = runtime.modpack_game_dir(&id);
    if game_dir.exists() {
        fs::remove_dir_all(&game_dir).map_err(|e| format!("Could not delete the modpack folder: {e}"))?;
    }
    if let Ok(version_dir) = runtime.paths.version_dir(&id) {
        let _ = fs::remove_dir_all(version_dir);
    }
    {
        let mut state = runtime.state();
        state.modpacks.retain(|row| row.id != id);
        if state.settings.selected_version == id {
            state.settings.selected_version.clear();
        }
    }
    runtime.save_modpacks()?;
    runtime.save_settings()?;
    runtime.log("launcher", "info", &format!("Deleted modpack \"{}\".", instance.name));
    let modpacks = runtime.modpack_list();
    runtime.emit("modpacks:updated", modpacks.clone());
    Ok(json!({
        "modpacks": modpacks,
        "removed": id,
        "selectedVersion": runtime.state().settings.selected_version
    }))
}

pub fn remove_modpack(runtime: &Arc<Runtime>, version_id: &str) -> Result<Value, String> {
    let id = validate_version_id(version_id)?;
    if runtime.state().game.is_some() {
        return Err("Close Minecraft before deleting a modpack.".into());
    }
    if runtime.state().installing.is_some() || runtime.state().modpack_job || runtime.state().content_job {
        return Err("Wait for the current download to finish before deleting a modpack.".into());
    }
    delete_pack_files(runtime, &id)
}

fn content_path(runtime: &Runtime, instance: &ModpackRecord, entry: &ContentEntry) -> Result<PathBuf, String> {
    let folder = content_folder(&entry.project_type).ok_or("Unknown content type.")?;
    let directory = runtime.modpack_game_dir(&instance.id).join(folder);
    safe_join(&directory, &entry.file_name)
}

fn read_content(runtime: &Runtime, instance: &ModpackRecord) -> Result<Vec<ContentEntry>, String> {
    let path = runtime.modpack_game_dir(&instance.id).join(CONTENT_FILE);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let file: ContentFile = serde_json::from_str(&raw).unwrap_or_default();
    Ok(file.entries.into_iter().filter(|entry| {
        content_folder(&entry.project_type).is_some() && !entry.file_name.is_empty() && !entry.id.is_empty()
    }).collect())
}

fn write_content(runtime: &Runtime, instance: &ModpackRecord, entries: &[ContentEntry]) -> Result<(), String> {
    let dir = runtime.modpack_game_dir(&instance.id);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let value = json!({ "version": 1, "entries": entries });
    fs::write(dir.join(CONTENT_FILE), serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

fn list_content(runtime: &Runtime, instance: &ModpackRecord) -> Result<Vec<Value>, String> {
    let entries = read_content(runtime, instance)?;
    Ok(entries.into_iter().map(|entry| {
        let exists = content_path(runtime, instance, &entry).map(|path| path.is_file()).unwrap_or(false);
        let mut value = serde_json::to_value(&entry).unwrap_or_else(|_| json!({}));
        if let Some(object) = value.as_object_mut() {
            object.insert("exists".into(), json!(exists));
        }
        value
    }).collect())
}

pub fn list_content_command(runtime: &Arc<Runtime>, version_id: &str) -> Result<Value, String> {
    let instance = runtime.require_modpack(version_id)?;
    Ok(Value::Array(list_content(runtime, &instance)?))
}

/// Install a jar that ships with Eclipse Client instead of resolving it from
/// Modrinth. The entry is tracked exactly like downloaded content so it can be
/// listed, updated, and removed by the normal bundle workflow.
pub fn install_local_content(
    runtime: &Arc<Runtime>,
    version_id: &str,
    mut entry: ContentEntry,
    bytes: &[u8],
) -> Result<Vec<Value>, String> {
    let instance = runtime.require_modpack(version_id)?;
    if runtime.state().game.is_some() {
        return Err("Close Minecraft before changing local content.".into());
    }
    let folder = content_folder(&entry.project_type).ok_or("Unknown content type.")?;
    let directory = runtime.modpack_game_dir(&instance.id).join(folder);
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let destination = safe_join(&directory, &entry.file_name)?;
    let partial = destination.with_file_name(format!(".{}.part", entry.file_name));
    fs::write(&partial, bytes).map_err(|e| e.to_string())?;
    let _ = fs::remove_file(&destination);
    fs::rename(&partial, &destination).map_err(|e| e.to_string())?;
    entry.path = format!("{folder}/{}", entry.file_name);
    entry.size = bytes.len() as u64;
    let mut entries = read_content(runtime, &instance)?;
    let mut kept = Vec::new();
    for existing in entries.drain(..) {
        if existing.project_id == entry.project_id && existing.project_type == entry.project_type {
            if let Ok(path) = content_path(runtime, &instance, &existing) {
                if path != destination {
                    let _ = fs::remove_file(path);
                }
            }
        } else {
            kept.push(existing);
        }
    }
    kept.push(entry);
    write_content(runtime, &instance, &kept)?;
    list_content(runtime, &instance)
}

pub async fn install_content(runtime: &Arc<Runtime>, input: Value) -> Result<Value, String> {
    let instance = runtime.require_modpack(input.get("targetVersion").and_then(Value::as_str).unwrap_or(""))?;
    let requested_type = input.get("projectType").and_then(Value::as_str).unwrap_or("");
    if content_folder(requested_type).is_none() {
        return Err("Choose a mod, resource pack, or shader to install.".into());
    }
    let bundle = match input.get("bundle").and_then(Value::as_str) {
        None | Some("") => String::new(),
        Some("essentials") => "essentials".into(),
        Some(_) => return Err("Unknown content bundle.".into()),
    };
    if requested_type == "mod" && !matches!(instance.loader.as_str(), "fabric" | "forge" | "neoforge") {
        return Err("This modpack is not running a mod loader.".into());
    }
    let project_ref = input.get("projectId").and_then(Value::as_str)
        .or_else(|| input.get("slug").and_then(Value::as_str)).unwrap_or("");
    let project = modrinth::fetch_project(runtime, project_ref).await?;
    if project.project_type != requested_type {
        return Err("That Modrinth project is a different kind of content.".into());
    }
    let versions = modrinth::fetch_versions(runtime, &project.id, &instance.game_version, if requested_type == "mod" { &instance.loader } else { "" }).await?;
    let Some(chosen) = modrinth::pick_best(&versions) else {
        return Err(format!("{} has no compatible content for Minecraft {} yet.", project.title, instance.game_version));
    };
    for folder in ["mods", "resourcepacks", "shaderpacks"] {
        tokio::fs::create_dir_all(runtime.modpack_game_dir(&instance.id).join(folder)).await.map_err(|e| e.to_string())?;
    }
    let mut entries = read_content(runtime, &instance)?;
    let mut added: Vec<Value> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    let mut queue: Vec<(modrinth::NormalizedVersion, modrinth::Project, bool, u32)> = vec![(chosen, project, false, 0)];
    let mut seen_projects = HashSet::new();
    while let Some((version, project, dependency, depth)) = queue.pop() {
        if entries.iter().any(|entry| entry.version_id == version.id) {
            continue;
        }
        if !seen_projects.insert(project.id.clone()) && dependency {
            continue;
        }
        if depth > 4 || added.len() >= 14 {
            if depth <= 4 {
                warnings.push("Some required dependencies were skipped because the limit was reached.".into());
            }
            continue;
        }
        let Some(folder) = content_folder(&project.project_type) else { continue };
        if project.project_type == "mod" && !matches!(instance.loader.as_str(), "fabric" | "forge" | "neoforge") {
            warnings.push(format!("{} was skipped because this pack has no mod loader.", project.title));
            continue;
        }
        let base_name = safe_file_name(&version.file_name, &format!("{}.jar", if project.slug.is_empty() { "content" } else { &project.slug }));
        let used: HashSet<String> = entries.iter().filter(|entry| entry.project_id != project.id).map(|entry| entry.file_name.to_lowercase()).collect();
        let mut used_mut = used;
        let file_name = unique_file_name(&base_name, &mut used_mut);
        let destination = safe_join(&runtime.modpack_game_dir(&instance.id).join(folder), &file_name)?;
        let url = modrinth::trusted_download(&version.url).map_err(|e| format!("{e} For {}", project.title))?;
        runtime.log("launcher", "info", &format!("Downloading \"{}\" for {}...", project.title, instance.name));
        download_file(&runtime.http, &url, &destination, if version.sha1.is_empty() { None } else { Some(&version.sha1) }, None, if version.file_size > 0 { Some(version.file_size) } else { None }).await
            .map_err(|e| format!("Could not download {}: {e}", project.title))?;
        for old in entries.iter().filter(|entry| entry.project_id == project.id && entry.project_type == project.project_type) {
            if let Ok(old_path) = content_path(runtime, &instance, old) {
                if old_path != destination {
                    let _ = fs::remove_file(old_path);
                }
            }
        }
        entries.retain(|entry| !(entry.project_id == project.id && entry.project_type == project.project_type));
        let entry = ContentEntry {
            id: version.id.clone(),
            project_id: project.id.clone(),
            project_slug: project.slug.clone(),
            project_title: project.title.clone(),
            project_type: project.project_type.clone(),
            version_id: version.id.clone(),
            version_number: version.version_number.clone(),
            file_name: file_name.clone(),
            path: format!("{folder}/{file_name}"),
            icon_url: project.icon_url.clone(),
            size: version.file_size,
            sha1: version.sha1.clone(),
            source: "modrinth".into(),
            installed_at: iso_now(),
            dependencies: version.dependencies.iter().map(|dependency| json!({
                "versionId": dependency.version_id,
                "projectId": dependency.project_id,
                "fileName": dependency.file_name,
                "dependencyType": dependency.dependency_type
            })).collect(),
            bundle: if dependency { String::new() } else { bundle.clone() },
        };
        entries.push(entry.clone());
        let mut added_value = serde_json::to_value(&entry).unwrap_or_else(|_| json!({}));
        if let Some(object) = added_value.as_object_mut() {
            object.insert("dependency".into(), json!(dependency));
            object.insert("exists".into(), json!(true));
        }
        added.push(added_value);
        write_content(runtime, &instance, &entries)?;
        if depth < 4 && added.len() < 14 {
            for dependency in &version.dependencies {
                if dependency.dependency_type != "required" {
                    continue;
                }
                if let Some(project_id) = &dependency.project_id {
                    if seen_projects.contains(project_id) {
                        continue;
                    }
                }
                let result = async {
                    let dependency_version = match &dependency.version_id {
                        Some(id) if !id.is_empty() => modrinth::fetch_version(runtime, id).await?,
                        _ => {
                            let Some(project_id) = &dependency.project_id else { return Ok::<_, String>(None) };
                            let dependency_project = modrinth::fetch_project(runtime, project_id).await?;
                            if dependency_project.project_type != "mod" {
                                return Ok(None);
                            }
                            let versions = modrinth::fetch_versions(runtime, &dependency_project.id, &instance.game_version, &instance.loader).await?;
                            return Ok(modrinth::pick_best(&versions).map(|version| (version, dependency_project)));
                        }
                    };
                    let project_id = if !dependency_version.project_id.is_empty() {
                        dependency_version.project_id.clone()
                    } else {
                        dependency.project_id.clone().unwrap_or_default()
                    };
                    if project_id.is_empty() {
                        return Ok(None);
                    }
                    let dependency_project = modrinth::fetch_project(runtime, &project_id).await?;
                    Ok(Some((dependency_version, dependency_project)))
                }
                .await;
                match result {
                    Ok(Some(value)) => queue.push((value.0, value.1, true, depth + 1)),
                    Ok(None) => {}
                    Err(error) => warnings.push(format!("Could not add a required dependency: {error}")),
                }
            }
        }
    }
    write_content(runtime, &instance, &entries)?;
    runtime.log("launcher", if added.is_empty() { "debug" } else { "info" }, &format!(
        "{} {} item{} from Modrinth to \"{}\".",
        if added.is_empty() { "No new" } else { "Added" },
        added.len(),
        if added.len() == 1 { "" } else { "s" },
        instance.name
    ));
    Ok(json!({
        "content": list_content(runtime, &instance)?,
        "added": added,
        "warnings": warnings
    }))
}

pub fn remove_content(runtime: &Arc<Runtime>, input: Value) -> Result<Value, String> {
    let instance = runtime.require_modpack(input.get("targetVersion").and_then(Value::as_str).unwrap_or(""))?;
    let entry_id = input.get("entryId").and_then(Value::as_str).unwrap_or("");
    let mut entries = read_content(runtime, &instance)?;
    let Some(index) = entries.iter().position(|entry| entry.id == entry_id || entry.version_id == entry_id) else {
        return Err("That content item is no longer installed.".into());
    };
    let entry = entries[index].clone();
    let path = content_path(runtime, &instance, &entry)?;
    let _ = fs::remove_file(path);
    entries.remove(index);
    write_content(runtime, &instance, &entries)?;
    runtime.log("launcher", "info", &format!("Removed \"{}\" from \"{}\".", entry.project_title, instance.name));
    Ok(json!({ "content": list_content(runtime, &instance)?, "removed": entry }))
}

pub fn remove_bundle(runtime: &Arc<Runtime>, version_id: &str, bundle: &str) -> Result<Value, String> {
    if bundle != "essentials" {
        return Err("Unknown content bundle.".into());
    }
    let instance = runtime.require_modpack(version_id)?;
    let mut entries = read_content(runtime, &instance)?;
    let mut removed = Vec::new();
    let mut kept = Vec::new();
    for entry in entries.drain(..) {
        if entry.bundle == bundle {
            if let Ok(path) = content_path(runtime, &instance, &entry) {
                let _ = fs::remove_file(path);
            }
            removed.push(serde_json::to_value(&entry).unwrap_or_else(|_| json!({})));
        } else {
            kept.push(entry);
        }
    }
    if !removed.is_empty() {
        write_content(runtime, &instance, &kept)?;
    }
    runtime.log("launcher", "info", &format!(
        "Removed {} Eclipse Essentials item{} from \"{}\".",
        removed.len(),
        if removed.len() == 1 { "" } else { "s" },
        instance.name
    ));
    Ok(json!({ "content": list_content(runtime, &instance)?, "removed": removed }))
}

#[derive(Clone)]
struct PackFile {
    path: String,
    url: String,
    sha1: Option<String>,
    sha512: Option<String>,
    size: Option<u64>,
}

struct Pack {
    name: String,
    version_id: String,
    game_version: String,
    loader: String,
    loader_version: String,
    files: Vec<PackFile>,
}

fn mrpack_download(value: &str) -> Result<String, String> {
    let url = url::Url::parse(value).map_err(|_| "The modpack contains an invalid download link.".to_string())?;
    if url.scheme() != "https" {
        return Err("The modpack contains an insecure download link.".into());
    }
    let host = url.host_str().unwrap_or("").to_lowercase();
    if host != "cdn.modrinth.com" && !host.ends_with(".modrinth.com") {
        return Err("The modpack contains a download from an untrusted host.".into());
    }
    Ok(url.to_string())
}

fn parse_mrpack_index(raw: &Value) -> Result<Pack, String> {
    if raw.get("formatVersion").and_then(Value::as_u64) != Some(1) {
        return Err("That .mrpack uses an unsupported format version.".into());
    }
    if raw.get("game").and_then(Value::as_str) != Some("minecraft") {
        return Err("That .mrpack is not a Minecraft modpack.".into());
    }
    let dependencies = raw.get("dependencies").and_then(Value::as_object).ok_or("That .mrpack has no game dependencies.")?;
    let game_version = dependencies.get("minecraft").and_then(Value::as_str).ok_or("That .mrpack does not specify a Minecraft version.")?.to_string();
    validate_version_id(&game_version)?;
    if dependencies.contains_key("quilt-loader") {
        return Err("Quilt modpacks are not supported by Eclipse Client.".into());
    }
    let loaders = [
        ("fabric", "fabric-loader"),
        ("forge", "forge"),
        ("neoforge", "neoforge"),
    ];
    let mut matched = Vec::new();
    for (loader, key) in loaders {
        if let Some(version) = dependencies.get(key).and_then(Value::as_str) {
            matched.push((loader, version.to_string()));
        }
    }
    if matched.len() != 1 {
        return Err("That .mrpack must use exactly one supported mod loader.".into());
    }
    let (loader, loader_version) = matched.remove(0);
    loaders::validate_loader_version(&loader_version)?;
    let name = clean_name(raw.get("name").and_then(Value::as_str).unwrap_or(""));
    let version_id = raw.get("versionId").and_then(Value::as_str).unwrap_or("").to_string();
    let mut files = Vec::new();
    for file in raw.get("files").and_then(Value::as_array).into_iter().flatten() {
        let path = validate_pack_path(file.get("path").and_then(Value::as_str).unwrap_or(""), true)?;
        let Some(url) = file.get("downloads").and_then(Value::as_array).and_then(|downloads| downloads.first()).and_then(Value::as_str) else { continue };
        let url = mrpack_download(url)?;
        let hashes = file.get("hashes");
        files.push(PackFile {
            path,
            url,
            sha1: hashes.and_then(|value| value.get("sha1")).and_then(Value::as_str).map(str::to_string),
            sha512: hashes.and_then(|value| value.get("sha512")).and_then(Value::as_str).map(str::to_string),
            size: file.get("fileSize").and_then(Value::as_u64),
        });
    }
    Ok(Pack { name, version_id, game_version, loader: loader.into(), loader_version, files })
}

pub async fn import_mrpack(runtime: &Arc<Runtime>, file_path: &Path) -> Result<Value, String> {
    if file_path.extension().and_then(|value| value.to_str()).unwrap_or("").to_lowercase() != "mrpack" {
        return Err("Choose a Modrinth .mrpack file.".into());
    }
    let metadata = fs::metadata(file_path).map_err(|_| "That .mrpack file could not be opened.".to_string())?;
    if !metadata.is_file() {
        return Err("Choose a .mrpack file, not a folder.".into());
    }
    if metadata.len() > 2 * 1024 * 1024 * 1024 {
        return Err("That .mrpack file is too large.".into());
    }
    let (pack, overrides) = {
        let file_path = file_path.to_path_buf();
        tokio::task::spawn_blocking(move || -> Result<(Pack, Vec<(String, Vec<u8>)>), String> {
            let file = fs::File::open(&file_path).map_err(|_| "That .mrpack file could not be opened.".to_string())?;
            let mut archive = ZipArchive::new(file).map_err(|error| format!("That .mrpack archive is invalid: {error}"))?;
            let (index, index_size) = {
                let mut index_entry = archive.by_name("modrinth.index.json").map_err(|_| "That archive has no modrinth.index.json and is not a modpack.")?;
                (std::io::read_to_string(&mut index_entry).map_err(|error| error.to_string())?, index_entry.size())
            };
            if index_size > 16 * 1024 * 1024 {
                return Err("That modpack index is unexpectedly large.".into());
            }
            let raw: Value = serde_json::from_str(&index).map_err(|error| format!("That modpack index is not valid JSON: {error}"))?;
            let pack = parse_mrpack_index(&raw)?;
            let mut overrides = Vec::new();
            let mut budget = 0u64;
            for index in 0..archive.len() {
                let mut entry = archive.by_index(index).map_err(|error| error.to_string())?;
                if entry.is_dir() { continue; }
                let Some(path) = entry.enclosed_name() else { continue };
                let path = path.to_string_lossy().replace('\\', "/");
                let relative = if let Some(value) = path.strip_prefix("overrides/") {
                    value
                } else if let Some(value) = path.strip_prefix("client-overrides/") {
                    value
                } else {
                    continue;
                };
                let relative = validate_pack_path(relative, true)?;
                budget = budget.saturating_add(entry.size());
                if budget > 2 * 1024 * 1024 * 1024 {
                    return Err("That modpack's overrides are too large to import safely.".into());
                }
                let mut bytes = Vec::with_capacity(entry.size().min(64 * 1024 * 1024) as usize);
                std::io::copy(&mut entry, &mut bytes).map_err(|error| error.to_string())?;
                overrides.push((relative, bytes));
            }
            Ok((pack, overrides))
        })
        .await
        .map_err(|error| error.to_string())??
    };
    let pack_name = if pack.name.chars().count() >= 2 { pack.name.chars().take(48).collect::<String>() } else { format!("{} pack", pack.name) };
    runtime.log("launcher", "info", &format!("Importing .mrpack \"{pack_name}\" ({} {})...", loaders::loader_label(&pack.loader), pack.loader_version));
    emit(runtime, json!({ "phase": "import", "label": format!("Preparing {pack_name}…"), "percent": 2, "indeterminate": true }));
    let created = create_modpack(runtime, json!({
        "name": pack_name,
        "gameVersion": pack.game_version,
        "loader": pack.loader,
        "loaderVersion": pack.loader_version,
        "source": {
            "type": "mrpack",
            "fileName": file_path.file_name().and_then(|value| value.to_str()).unwrap_or(""),
            "packVersion": pack.version_id,
            "importedAt": iso_now()
        }
    })).await?;
    let instance_id = created.get("id").and_then(Value::as_str).unwrap_or("").to_string();
    let instance = runtime.require_modpack(&instance_id)?;
    let game_dir = runtime.modpack_game_dir(&instance.id);
    let result = async {
        let total = pack.files.len();
        let completed = Arc::new(AtomicUsize::new(0));
        emit(runtime, json!({
            "phase": "files",
            "label": if total > 0 { format!("Downloading modpack files (0/{total})…") } else { "Applying modpack files…".into() },
            "percent": if total > 0 { 30 } else { 75 },
            "filesDone": 0,
            "filesTotal": total,
            "indeterminate": false
        }));
        let client = runtime.http.clone();
        let directory = game_dir.clone();
        let total_bytes: u64 = pack.files.iter().map(|file| file.size.unwrap_or(0)).sum();
        let done_bytes = Arc::new(AtomicU64::new(0));
        let results = futures_util::stream::iter(pack.files.clone().into_iter().map(|file| {
            let client = client.clone();
            let directory = directory.clone();
            let completed = completed.clone();
            let done_bytes = done_bytes.clone();
            let runtime = runtime.clone();
            let total = total;
            async move {
                let dest = safe_join(&directory, &file.path)?;
                let bytes = download_file(&client, &file.url, &dest, file.sha1.as_deref(), file.sha512.as_deref(), file.size).await?;
                let done = completed.fetch_add(1, Ordering::Relaxed) + 1;
                let done_size = done_bytes.fetch_add(bytes, Ordering::Relaxed) + bytes;
                let _percent = if total > 0 { 30 + ((done as u64 * 65) / total as u64) } else { 95 };
                let _ = &runtime;
                Ok::<(usize, u64, u64), String>((done, done_size, total_bytes))
            }
        }))
        .buffer_unordered(6)
        .collect::<Vec<_>>()
        .await;
        for result in results {
            let (done, bytes, total_bytes) = result?;
            emit(runtime, json!({
                "phase": "files",
                "label": format!("Downloading modpack files ({done}/{total})…"),
                "percent": (30 + ((done as u64 * 65) / total.max(1) as u64)).min(95),
                "bytesDone": bytes,
                "bytesTotal": total_bytes,
                "filesDone": done,
                "filesTotal": total,
                "indeterminate": false
            }));
        }
        emit(runtime, json!({ "phase": "files", "label": "Applying overrides…", "percent": 96, "indeterminate": true }));
        for (relative, bytes) in overrides {
            let dest = safe_join(&game_dir, &relative)?;
            if let Some(parent) = dest.parent() {
                tokio::fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
            }
            tokio::fs::write(&dest, bytes).await.map_err(|e| e.to_string())?;
        }
        let mut entries = Vec::new();
        for file in &pack.files {
            let parts: Vec<&str> = file.path.split('/').collect();
            if parts.len() != 2 {
                continue;
            }
            let folder = parts[0];
            let (kind, title) = if folder == "mods" {
                ("mod", "Imported mod")
            } else if folder == "resourcepacks" {
                ("resourcepack", "Imported resource pack")
            } else if folder == "shaderpacks" {
                ("shader", "Imported shader")
            } else {
                continue;
            };
            let file_name = parts[1].to_string();
            entries.push(ContentEntry {
                id: format!("mrpack-{}", crate::util::md5_hex(file.path.as_bytes())),
                project_id: String::new(),
                project_slug: String::new(),
                project_title: title.into(),
                project_type: kind.into(),
                version_id: String::new(),
                version_number: String::new(),
                file_name: file_name.clone(),
                path: file.path.clone(),
                icon_url: String::new(),
                size: file.size.unwrap_or(0),
                sha1: file.sha1.clone().unwrap_or_default(),
                source: "mrpack".into(),
                installed_at: iso_now(),
                dependencies: Vec::new(),
                bundle: String::new(),
            });
        }
        write_content(runtime, &instance, &entries)?;
        emit(runtime, json!({ "phase": "complete", "label": format!("{pack_name} imported"), "percent": 100, "indeterminate": false }));
        runtime.log("launcher", "info", &format!("Imported .mrpack \"{pack_name}\" ({} files).", total));
        Ok::<Value, String>(json!({
            "instance": public_instance(runtime, &instance),
            "modpacks": runtime.modpack_list(),
            "importedFiles": total
        }))
    }
    .await;
    if result.is_err() {
        let _ = delete_pack_files(runtime, &instance_id);
        runtime.log("launcher", "warn", &format!("Import failed; removed the incomplete \"{pack_name}\" pack."));
        emit(runtime, json!({ "phase": "error", "label": "Import failed", "percent": 0, "indeterminate": false }));
    }
    result
}

