use crate::model::{ContentEntry, ModpackRecord};
use crate::modpacks;
use crate::runtime::Runtime;
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;

#[derive(Clone, Copy)]
pub struct Item {
    pub slug: &'static str,
    pub title: &'static str,
    pub description: &'static str,
    pub project_type: &'static str,
    pub loaders: &'static [&'static str],
    pub bundled: bool,
    pub game_versions: &'static [&'static str],
}

const ALL_LOADERS: &[&str] = &["fabric", "forge", "neoforge"];
const FABRIC_ONLY: &[&str] = &["fabric"];
const HUD_SLUG: &str = "eclipse-hud";
const HUD_VERSION: &str = "1.1.0";
const HUD_FILE_NAME: &str = "eclipse-hud-1.1.0+1.21.11.jar";
const HUD_GAME_VERSIONS: &[&str] = &["1.21.11"];
const HUD_JAR: &[u8] = include_bytes!("../assets/eclipse-hud-1.1.0+1.21.11.jar");
const UI_SLUG: &str = "eclipse-ui";
const UI_VERSION: &str = "1.0.2";
const UI_GAME_VERSIONS: &[&str] = &["1.21.11"];

#[derive(Clone, Copy)]
struct UiPack {
    theme: &'static str,
    file_name: &'static str,
    bytes: &'static [u8],
}

const UI_PACKS: &[UiPack] = &[
    UiPack {
        theme: "eclipse",
        file_name: "eclipse-ui-1.0.2-eclipse.zip",
        bytes: include_bytes!("../assets/eclipse-ui-1.0.2-eclipse.zip"),
    },
    UiPack {
        theme: "aurora",
        file_name: "eclipse-ui-1.0.2-aurora.zip",
        bytes: include_bytes!("../assets/eclipse-ui-1.0.2-aurora.zip"),
    },
    UiPack {
        theme: "ember",
        file_name: "eclipse-ui-1.0.2-ember.zip",
        bytes: include_bytes!("../assets/eclipse-ui-1.0.2-ember.zip"),
    },
    UiPack {
        theme: "midnight",
        file_name: "eclipse-ui-1.0.2-midnight.zip",
        bytes: include_bytes!("../assets/eclipse-ui-1.0.2-midnight.zip"),
    },
    UiPack {
        theme: "daylight",
        file_name: "eclipse-ui-1.0.2-daylight.zip",
        bytes: include_bytes!("../assets/eclipse-ui-1.0.2-daylight.zip"),
    },
    UiPack {
        theme: "frost",
        file_name: "eclipse-ui-1.0.2-frost.zip",
        bytes: include_bytes!("../assets/eclipse-ui-1.0.2-frost.zip"),
    },
    UiPack {
        theme: "sakura",
        file_name: "eclipse-ui-1.0.2-sakura.zip",
        bytes: include_bytes!("../assets/eclipse-ui-1.0.2-sakura.zip"),
    },
    UiPack {
        theme: "solar",
        file_name: "eclipse-ui-1.0.2-solar.zip",
        bytes: include_bytes!("../assets/eclipse-ui-1.0.2-solar.zip"),
    },
];

fn ui_pack(theme: &str) -> &'static UiPack {
    UI_PACKS
        .iter()
        .find(|pack| pack.theme == theme)
        .unwrap_or(&UI_PACKS[0])
}

fn ui_version(theme: &str) -> String {
    format!("{UI_VERSION}-{}", ui_pack(theme).theme)
}

pub const ITEMS: &[Item] = &[
    Item {
        slug: HUD_SLUG,
        title: "Eclipse HUD",
        description: "Eclipse's own compact FPS, coordinates, biome, dimension, and clock overlay with depth-reprojection motion blur and an owo-lib themed ping and blur control center",
        project_type: "mod",
        loaders: FABRIC_ONLY,
        bundled: true,
        game_versions: HUD_GAME_VERSIONS,
    },
    Item {
        slug: UI_SLUG,
        title: "Eclipse UI",
        description: "Eclipse's own theme-matched loading splash and title-screen artwork",
        project_type: "resourcepack",
        loaders: ALL_LOADERS,
        bundled: true,
        game_versions: UI_GAME_VERSIONS,
    },
    Item {
        slug: "armor-hud",
        title: "Armor HUD",
        description: "Shows armor durability at a glance",
        project_type: "mod",
        loaders: ALL_LOADERS,
        bundled: false,
        game_versions: &[],
    },
    Item {
        slug: "low-fire-alexin1337",
        title: "Low Fire",
        description: "Keeps the first-person fire overlay out of your face",
        project_type: "resourcepack",
        loaders: ALL_LOADERS,
        bundled: false,
        game_versions: &[],
    },
    Item {
        slug: "small-totem-pop",
        title: "Small Totem Pop",
        description: "Makes the totem animation smaller and less blinding",
        project_type: "resourcepack",
        loaders: ALL_LOADERS,
        bundled: false,
        game_versions: &[],
    },
    Item {
        slug: "freelook-og",
        title: "Freelook",
        description: "Look around without changing your movement direction",
        project_type: "mod",
        loaders: ALL_LOADERS,
        bundled: false,
        game_versions: &[],
    },
    Item {
        slug: "zoomify",
        title: "Zoomify",
        description: "Smooth, configurable zoom",
        project_type: "mod",
        loaders: FABRIC_ONLY,
        bundled: false,
        game_versions: &[],
    },
    Item {
        slug: "appleskin",
        title: "AppleSkin",
        description: "Food, hunger, and saturation information",
        project_type: "mod",
        loaders: ALL_LOADERS,
        bundled: false,
        game_versions: &[],
    },
    Item {
        slug: "mouse-tweaks",
        title: "Mouse Tweaks",
        description: "Faster inventory sorting and dragging",
        project_type: "mod",
        loaders: ALL_LOADERS,
        bundled: false,
        game_versions: &[],
    },
    Item {
        slug: "controlling",
        title: "Controlling",
        description: "Searchable key bindings and conflict detection",
        project_type: "mod",
        loaders: ALL_LOADERS,
        bundled: false,
        game_versions: &[],
    },
    Item {
        slug: "betterf3",
        title: "BetterF3",
        description: "A cleaner, more readable debug HUD",
        project_type: "mod",
        loaders: ALL_LOADERS,
        bundled: false,
        game_versions: &[],
    },
    Item {
        slug: "jade",
        title: "Jade",
        description: "See what block or entity you are looking at",
        project_type: "mod",
        loaders: ALL_LOADERS,
        bundled: false,
        game_versions: &[],
    },
];

fn installed_slugs(rows: &[Value]) -> HashSet<String> {
    rows.iter()
        .filter_map(|row| row.get("projectSlug").and_then(Value::as_str))
        .filter(|slug| !slug.is_empty())
        .map(str::to_string)
        .collect()
}

fn bundled_version(slug: &str, theme: &str) -> Option<String> {
    match slug {
        UI_SLUG => Some(ui_version(theme)),
        HUD_SLUG => Some(HUD_VERSION.into()),
        _ => None,
    }
}

fn bundled_is_current(rows: &[Value], slug: &str, theme: &str) -> bool {
    let Some(version) = bundled_version(slug, theme) else {
        return true;
    };
    rows.iter().any(|row| {
        row.get("projectSlug").and_then(Value::as_str) == Some(slug)
            && row.get("exists").and_then(Value::as_bool) != Some(false)
            && row.get("versionNumber").and_then(Value::as_str) == Some(version.as_str())
    })
}

fn item_applicable(item: &Item, instance: &ModpackRecord) -> bool {
    let loader_matches = item.loaders.is_empty()
        || item.loaders.iter().any(|loader| *loader == instance.loader.as_str());
    let version_matches = item.game_versions.is_empty()
        || item.game_versions.iter().any(|version| *version == instance.game_version.as_str());
    loader_matches && version_matches
}

pub fn status(runtime: &Arc<Runtime>, version_id: &str) -> Result<Value, String> {
    let instance = runtime.require_modpack(version_id)?;
    let content = modpacks::list_content_command(runtime, version_id)?;
    let rows = content.as_array().cloned().unwrap_or_default();
    let installed = installed_slugs(&rows);
    let mut items = Vec::new();
    let mut installed_count = 0usize;
    for item in ITEMS {
        if !item_applicable(item, &instance) {
            continue;
        }
        let is_installed = installed.contains(item.slug);
        if is_installed {
            installed_count += 1;
        }
        items.push(json!({
            "slug": item.slug,
            "title": item.title,
            "description": item.description,
            "projectType": item.project_type,
            "custom": item.bundled,
            "installed": is_installed
        }));
    }
    let bundled = rows
        .iter()
        .filter(|row| row.get("bundle").and_then(Value::as_str) == Some("essentials"))
        .count();
    Ok(json!({
        "versionId": instance.id,
        "enabled": instance.essentials_enabled,
        "bundled": bundled,
        "installedCount": installed_count,
        "total": items.len(),
        "items": items
    }))
}

fn set_enabled(runtime: &Arc<Runtime>, id: &str, enabled: bool) -> Result<(), String> {
    {
        let mut state = runtime.state();
        let Some(row) = state.modpacks.iter_mut().find(|row| row.id == id) else {
            return Err("That modpack no longer exists.".into());
        };
        row.essentials_enabled = enabled;
    }
    runtime.save_modpacks()?;
    runtime.emit("modpacks:updated", runtime.modpack_list());
    Ok(())
}

fn update_resource_packs(
    runtime: &Arc<Runtime>,
    version_id: &str,
    add: &[String],
    remove: &[String],
) -> Result<(), String> {
    if add.is_empty() && remove.is_empty() {
        return Ok(());
    }
    let path = runtime.modpack_game_dir(version_id).join("options.txt");
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let mut lines: Vec<String> = existing.lines().map(str::to_string).collect();
    let position = lines.iter().position(|line| line.starts_with("resourcePacks:"));
    let mut packs: Vec<String> = if let Some(index) = position {
        let raw = lines[index].strip_prefix("resourcePacks:").unwrap_or("");
        serde_json::from_str(raw)
            .map_err(|_| "Could not read the existing resourcePacks line in options.txt.".to_string())?
    } else {
        vec!["vanilla".into()]
    };
    if !packs.iter().any(|pack| pack == "vanilla") {
        packs.insert(0, "vanilla".into());
    }
    for file in add {
        let entry = format!("file/{file}");
        if !packs.iter().any(|pack| pack == &entry) {
            packs.push(entry);
        }
    }
    for file in remove {
        let entry = format!("file/{file}");
        packs.retain(|pack| pack != &entry);
    }
    let value = format!(
        "resourcePacks:{}",
        serde_json::to_string(&packs).map_err(|error| error.to_string())?
    );
    if let Some(index) = position {
        lines[index] = value;
    } else {
        lines.push(value);
    }
    std::fs::write(&path, lines.join("\n")).map_err(|error| error.to_string())?;
    Ok(())
}

pub async fn install(runtime: &Arc<Runtime>, version_id: &str) -> Result<Value, String> {
    let instance = runtime.require_modpack(version_id)?;
    if !matches!(instance.loader.as_str(), "fabric" | "forge" | "neoforge") {
        return Err("Eclipse Essentials needs a Fabric, Forge, or NeoForge modpack.".into());
    }
    {
        let mut state = runtime.state();
        if state.content_job {
            return Err("Another Modrinth download is already running.".into());
        }
        if state.game.is_some() {
            return Err("Close Minecraft before changing Eclipse Essentials.".into());
        }
        state.content_job = true;
    }
    let result = install_inner(runtime, &instance).await;
    runtime.state().content_job = false;
    result
}

async fn install_inner(runtime: &Arc<Runtime>, instance: &ModpackRecord) -> Result<Value, String> {
    let theme = runtime.state().settings.theme.clone();
    let current_ui = ui_pack(&theme);
    let content = modpacks::list_content_command(runtime, &instance.id)?;
    let mut rows = content.as_array().cloned().unwrap_or_default();
    let mut installed = installed_slugs(&rows);
    let applicable: Vec<&Item> = ITEMS
        .iter()
        .filter(|item| item_applicable(item, instance))
        .collect();
    let total = applicable.len();
    let mut report = Vec::new();
    let mut resource_packs = Vec::new();
    let mut retired_resource_packs = Vec::new();

    for (index, item) in applicable.iter().enumerate() {
        if installed.contains(item.slug)
            && (!item.bundled || bundled_is_current(&rows, item.slug, &theme))
        {
            report.push(json!({
                "slug": item.slug,
                "title": item.title,
                "status": "present"
            }));
            continue;
        }
        if item.slug == UI_SLUG {
            retired_resource_packs.extend(rows.iter().filter_map(|row| {
                if row.get("projectSlug").and_then(Value::as_str) != Some(UI_SLUG) {
                    return None;
                }
                row.get("fileName")
                    .and_then(Value::as_str)
                    .filter(|file| *file != current_ui.file_name)
                    .map(str::to_string)
            }));
        }
        runtime.emit("essentials:progress", json!({
            "versionId": instance.id,
            "title": item.title,
            "index": index + 1,
            "total": total,
            "done": false
        }));
        if item.bundled {
            match install_bundled(runtime, instance, item, &theme).await {
                Ok(resource_pack) => {
                    if let Some(file) = resource_pack {
                        resource_packs.push(file);
                    }
                    if let Ok(content) = modpacks::list_content_command(runtime, &instance.id) {
                        rows = content.as_array().cloned().unwrap_or_default();
                        installed = installed_slugs(&rows);
                    }
                    report.push(json!({
                        "slug": item.slug,
                        "title": item.title,
                        "status": "installed"
                    }));
                }
                Err(error) => {
                    runtime.log("launcher", "warn", &format!("Eclipse Essentials skipped {}: {error}", item.title));
                    report.push(json!({
                        "slug": item.slug,
                        "title": item.title,
                        "status": "skipped",
                        "reason": error
                    }));
                }
            }
            continue;
        }
        let payload = json!({
            "targetVersion": instance.id,
            "projectId": item.slug,
            "projectType": item.project_type,
            "bundle": "essentials"
        });
        match modpacks::install_content(runtime, payload).await {
            Ok(value) => {
                if let Some(next) = value.get("content").and_then(Value::as_array) {
                    rows = next.clone();
                    installed = installed_slugs(&rows);
                }
                if item.project_type == "resourcepack" {
                    if let Some(file) = rows.iter().find(|row| {
                        row.get("projectSlug").and_then(Value::as_str) == Some(item.slug)
                    }).and_then(|row| row.get("fileName")).and_then(Value::as_str) {
                        resource_packs.push(file.to_string());
                    }
                }
                report.push(json!({
                    "slug": item.slug,
                    "title": item.title,
                    "status": "installed"
                }));
            }
            Err(error) => {
                runtime.log("launcher", "warn", &format!("Eclipse Essentials skipped {}: {error}", item.title));
                report.push(json!({
                    "slug": item.slug,
                    "title": item.title,
                    "status": "skipped",
                    "reason": error
                }));
            }
        }
    }

    if let Err(error) =
        update_resource_packs(runtime, &instance.id, &resource_packs, &retired_resource_packs)
    {
        runtime.log("launcher", "warn", &format!("Could not enable Essentials resource packs: {error}"));
    }
    set_enabled(runtime, &instance.id, true)?;
    runtime.emit("essentials:progress", json!({
        "versionId": instance.id,
        "done": true,
        "total": total
    }));
    Ok(json!({
        "status": status(runtime, &instance.id)?,
        "report": report
    }))
}

async fn install_bundled(
    runtime: &Arc<Runtime>,
    instance: &ModpackRecord,
    item: &Item,
    theme: &str,
) -> Result<Option<String>, String> {
    if item.slug == UI_SLUG {
        if !UI_GAME_VERSIONS.contains(&instance.game_version.as_str()) {
            return Err(format!("Eclipse UI currently supports Minecraft {}.", UI_GAME_VERSIONS.join(", ")));
        }
        let pack = ui_pack(theme);
        let version = ui_version(theme);
        let mut hasher = Sha1::new();
        hasher.update(pack.bytes);
        let sha1 = format!("{:x}", hasher.finalize());
        let entry = ContentEntry {
            id: format!("{UI_SLUG}-{version}"),
            project_id: UI_SLUG.into(),
            project_slug: UI_SLUG.into(),
            project_title: "Eclipse UI".into(),
            project_type: "resourcepack".into(),
            version_id: format!("{UI_SLUG}-{version}"),
            version_number: version.clone(),
            file_name: pack.file_name.into(),
            path: format!("resourcepacks/{}", pack.file_name),
            icon_url: String::new(),
            size: pack.bytes.len() as u64,
            sha1,
            source: "bundled".into(),
            installed_at: crate::util::iso_now(),
            dependencies: Vec::new(),
            bundle: "essentials".into(),
        };
        modpacks::install_local_content(runtime, &instance.id, entry, pack.bytes)?;
        runtime.log(
            "launcher",
            "info",
            &format!("Installed Eclipse UI ({theme}) in \"{}\".", instance.name),
        );
        return Ok(Some(pack.file_name.into()));
    }
    if item.slug != HUD_SLUG {
        return Err(format!("Unknown bundled item: {}", item.title));
    }	if !HUD_GAME_VERSIONS.contains(&instance.game_version.as_str()) {
		return Err(format!("Eclipse HUD currently supports Minecraft {}.", HUD_GAME_VERSIONS.join(", ")));
	}
	remove_stale_hud_jars(&runtime.modpack_game_dir(&instance.id).join("mods"));
	let content = modpacks::list_content_command(runtime, &instance.id)?;

    let rows = content.as_array().cloned().unwrap_or_default();
    if !installed_slugs(&rows).contains("fabric-api") {
        let payload = json!({
            "targetVersion": instance.id,
            "projectId": "fabric-api",
            "projectType": "mod"
        });
        modpacks::install_content(runtime, payload).await
            .map_err(|error| format!("Eclipse HUD needs Fabric API: {error}"))?;
    }
    let mut hasher = Sha1::new();
    hasher.update(HUD_JAR);
    let sha1 = format!("{:x}", hasher.finalize());
    let entry = ContentEntry {
        id: format!("{HUD_SLUG}-{HUD_VERSION}"),
        project_id: HUD_SLUG.into(),
        project_slug: HUD_SLUG.into(),
        project_title: "Eclipse HUD".into(),
        project_type: "mod".into(),
        version_id: format!("{HUD_SLUG}-{HUD_VERSION}"),
        version_number: HUD_VERSION.into(),
        file_name: HUD_FILE_NAME.into(),
        path: format!("mods/{HUD_FILE_NAME}"),
        icon_url: String::new(),
        size: HUD_JAR.len() as u64,
        sha1,
        source: "bundled".into(),
        installed_at: crate::util::iso_now(),
        dependencies: vec![json!({
            "projectId": "fabric-api",
            "dependencyType": "required"
        })],
        bundle: "essentials".into(),
    };
    modpacks::install_local_content(runtime, &instance.id, entry, HUD_JAR)?;
    runtime.log("launcher", "info", &format!("Installed Eclipse HUD in \"{}\".", instance.name));
    Ok(None)
}

pub fn remove(runtime: &Arc<Runtime>, version_id: &str) -> Result<Value, String> {
    let instance = runtime.require_modpack(version_id)?;
    {
        let mut state = runtime.state();
        if state.content_job {
            return Err("Another Modrinth download is already running.".into());
        }
        if state.game.is_some() {
            return Err("Close Minecraft before changing Eclipse Essentials.".into());
        }
        state.content_job = true;
    }
    let result = remove_inner(runtime, &instance);
    runtime.state().content_job = false;
    result
}

fn remove_inner(runtime: &Arc<Runtime>, instance: &ModpackRecord) -> Result<Value, String> {
    let content = modpacks::list_content_command(runtime, &instance.id)?;
    let resource_packs: Vec<String> = content
        .as_array()
        .into_iter()
        .flatten()
        .filter(|row| row.get("bundle").and_then(Value::as_str) == Some("essentials"))
        .filter(|row| row.get("projectType").and_then(Value::as_str) == Some("resourcepack"))
        .filter_map(|row| row.get("fileName").and_then(Value::as_str))
        .map(str::to_string)
        .collect();
    let removed = modpacks::remove_bundle(runtime, &instance.id, "essentials")?;
    if let Err(error) = update_resource_packs(runtime, &instance.id, &[], &resource_packs) {
        runtime.log("launcher", "warn", &format!("Could not disable Essentials resource packs: {error}"));
    }
    set_enabled(runtime, &instance.id, false)?;
    Ok(json!({
        "status": status(runtime, &instance.id)?,
        "removed": removed.get("removed").cloned().unwrap_or_else(|| json!([]))
    }))
}/// Removes old Eclipse HUD jars left behind by an update, for example when the
/// previous file was still open in a running game. Minecraft must never see two
/// Eclipse HUD jars at once.
fn remove_stale_hud_jars(mods: &Path) {
	let Ok(entries) = std::fs::read_dir(mods) else {
		return;
	};
	for entry in entries.flatten() {
		let file_name = entry.file_name();
		let file_name = file_name.to_string_lossy();
		if file_name.starts_with("eclipse-hud-")
			&& file_name.ends_with(".jar")
			&& file_name != HUD_FILE_NAME
		{
			let _ = std::fs::remove_file(entry.path());
		}
	}
}

/// On the first launch of an enabled pack, add the bundle. Existing bundles
/// also pick up newly added bundled items when they become supported for the pack.
pub async fn ensure(runtime: &Arc<Runtime>, version_id: &str) -> Result<(), String> {
	let instance = runtime.require_modpack(version_id)?;
	if !instance.essentials_enabled || !matches!(instance.loader.as_str(), "fabric" | "forge" | "neoforge") {
		return Ok(());
	}
	remove_stale_hud_jars(&runtime.modpack_game_dir(&instance.id).join("mods"));
	let theme = runtime.state().settings.theme.clone();

    let content = modpacks::list_content_command(runtime, version_id)?;
    let rows = content.as_array().cloned().unwrap_or_default();
    let has_bundle = rows.iter().any(|row| row.get("bundle").and_then(Value::as_str) == Some("essentials"));
    let missing_bundled = ITEMS
        .iter()
        .filter(|item| item.bundled && item_applicable(item, &instance))
        .filter(|item| !bundled_is_current(&rows, item.slug, &theme))
        .count();
    if has_bundle && missing_bundled == 0 {
        return Ok(());
    }
    let result = install(runtime, version_id).await?;
    if let Some(report) = result.get("report").and_then(Value::as_array) {
        let skipped = report
            .iter()
            .filter(|row| row.get("status").and_then(Value::as_str) == Some("skipped"))
            .count();
        if skipped > 0 {
            runtime.log(
                "launcher",
                "warn",
                &format!(
                    "Eclipse Essentials installed with {skipped} unavailable item{}.",
                    if skipped == 1 { "" } else { "s" }
                ),
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn pack(loader: &str, game_version: &str) -> ModpackRecord {
        ModpackRecord {
            id: "test-pack".into(),
            name: "Test Pack".into(),
            kind: "modpack".into(),
            loader: loader.into(),
            loader_version: "0.20.1".into(),
            game_version: game_version.into(),
            created_at: "test".into(),
            source: json!({ "type": "test" }),
            essentials_enabled: true,
            render_distances: Default::default(),
        }
    }

    #[test]
    fn bundled_hud_is_limited_to_fabric_1_21_11() {
        let item = ITEMS.iter().find(|item| item.slug == HUD_SLUG).expect("bundled HUD");
        assert!(item.bundled);
        assert!(item_applicable(item, &pack("fabric", "1.21.11")));
        assert!(!item_applicable(item, &pack("fabric", "1.21.1")));
        assert!(!item_applicable(item, &pack("forge", "1.21.11")));
        assert!(!item_applicable(item, &pack("neoforge", "1.21.11")));
    }	#[test]
	fn bundled_hud_asset_is_a_jar() {
		assert!(HUD_JAR.starts_with(b"PK"));
		assert!(HUD_FILE_NAME.ends_with(".jar"));
		assert_eq!(HUD_FILE_NAME, format!("eclipse-hud-{HUD_VERSION}+1.21.11.jar"));
	}

	#[test]
	fn stale_hud_jars_are_removed() {
		let directory = std::env::temp_dir().join(format!("eclipse-hud-cleanup-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&directory);
		std::fs::create_dir_all(&directory).expect("create temp dir");
		for name in [HUD_FILE_NAME, "eclipse-hud-1.0.4+1.21.11.jar", "fabric-api.jar"] {
			std::fs::write(directory.join(name), b"test").expect("write test jar");
		}
		remove_stale_hud_jars(&directory);
		assert!(directory.join(HUD_FILE_NAME).exists());
		assert!(!directory.join("eclipse-hud-1.0.4+1.21.11.jar").exists());
		assert!(directory.join("fabric-api.jar").exists());
		let _ = std::fs::remove_dir_all(&directory);
	}


    #[test]
    fn bundled_ui_theme_changes_are_refreshed() {
        let current = vec![json!({
            "projectSlug": UI_SLUG,
            "versionNumber": ui_version("eclipse"),
            "exists": true
        })];
        assert!(bundled_is_current(&current, UI_SLUG, "eclipse"));
        assert!(!bundled_is_current(&current, UI_SLUG, "aurora"));
        let old = vec![json!({
            "projectSlug": UI_SLUG,
            "versionNumber": "0.0.0",
            "exists": true
        })];
        assert!(!bundled_is_current(&old, UI_SLUG, "eclipse"));
        assert!(!bundled_is_current(&[], UI_SLUG, "eclipse"));
    }

    #[test]
    fn bundled_ui_is_available_for_all_loaders_on_1_21_11() {
        let item = ITEMS.iter().find(|item| item.slug == UI_SLUG).expect("bundled UI");
        assert!(item.bundled);
        assert_eq!(item.project_type, "resourcepack");
        for loader in ["fabric", "forge", "neoforge"] {
            assert!(item_applicable(item, &pack(loader, "1.21.11")));
        }
        assert!(!item_applicable(item, &pack("fabric", "1.21.1")));
    }

    #[test]
    fn bundled_ui_asset_is_a_format_75_resource_pack() {
        use std::collections::HashSet;
        use std::io::Read;

        let mut hashes = HashSet::new();
        for theme in [
            "eclipse", "aurora", "ember", "midnight", "daylight", "frost", "sakura", "solar",
        ] {
            let pack = ui_pack(theme);
            assert_eq!(pack.theme, theme);
            assert!(pack.file_name.contains(theme));
            assert!(pack.file_name.ends_with(".zip"));
            assert!(pack.bytes.starts_with(b"PK"));
            let mut hasher = Sha1::new();
            hasher.update(pack.bytes);
            hashes.insert(format!("{:x}", hasher.finalize()));

            let mut archive =
                zip::ZipArchive::new(std::io::Cursor::new(pack.bytes)).expect("valid resource pack");
            let raw = {
                let mut meta = archive.by_name("pack.mcmeta").expect("pack.mcmeta");
                let mut raw = String::new();
                meta.read_to_string(&mut raw).expect("read pack.mcmeta");
                raw
            };
            let meta: Value = serde_json::from_str(&raw).expect("valid pack.mcmeta");
            assert_eq!(meta["pack"]["min_format"], json!([75, 0]));
            assert_eq!(meta["pack"]["max_format"], json!([75, 0]));
            for path in [
                "pack.png",
                "assets/minecraft/textures/gui/title/mojangstudios.png",
                "assets/minecraft/textures/gui/title/minecraft.png",
                "assets/minecraft/textures/gui/title/edition.png",
                "assets/minecraft/texts/splashes.txt",
                "assets/minecraft/textures/gui/title/background/panorama_0.png",
                "assets/minecraft/textures/gui/title/background/panorama_5.png",
                "assets/minecraft/textures/gui/title/background/panorama_overlay.png",
            ] {
                assert!(archive.by_name(path).is_ok(), "missing {path} in {theme}");
            }
            let mut splash_text = String::new();
            archive
                .by_name("assets/minecraft/texts/splashes.txt")
                .expect("splashes.txt")
                .read_to_string(&mut splash_text)
                .expect("read splashes.txt");
            assert!(splash_text.is_empty(), "the title screen should have no splash text");
        }
        assert_eq!(hashes.len(), 8, "each launcher theme needs distinct title-screen art");
    }
}
