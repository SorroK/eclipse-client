use crate::model::RenderDistances;
use crate::modpacks;
use crate::runtime::Runtime;
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;

const HELPER_SLUG: &str = "entity-view-distance";
const HELPER_TITLE: &str = "Entity View Distance";
const CONFIG_FILE: &str = "entity-view-distance.json";
const MAX_DISTANCE: i32 = 512;

fn config_path(runtime: &Runtime, version_id: &str) -> PathBuf {
    runtime
        .modpack_game_dir(version_id)
        .join("config")
        .join(CONFIG_FILE)
}

fn has_helper(runtime: &Arc<Runtime>, version_id: &str) -> Result<bool, String> {
    let content = modpacks::list_content_command(runtime, version_id)?;
    Ok(content
        .as_array()
        .map(|rows| {
            rows.iter().any(|row| {
                row.get("projectSlug").and_then(Value::as_str) == Some(HELPER_SLUG)
                    && row.get("exists").and_then(Value::as_bool).unwrap_or(false)
            })
        })
        .unwrap_or(false))
}

pub fn status(runtime: &Arc<Runtime>, version_id: &str) -> Result<Value, String> {
    let instance = runtime.require_modpack(version_id)?;
    let supported = instance.loader == "fabric";
    let reason = if supported {
        String::new()
    } else {
        "Per-entity render distances currently require a Fabric modpack. There is no maintained Forge or NeoForge build of Entity View Distance.".into()
    };
    Ok(json!({
        "versionId": instance.id,
        "supported": supported,
        "reason": reason,
        "active": instance.render_distances.any(),
        "distances": instance.render_distances,
        "helperInstalled": has_helper(runtime, version_id)?,
        "helper": {
            "slug": HELPER_SLUG,
            "title": HELPER_TITLE
        },
        "maxDistance": MAX_DISTANCE
    }))
}

fn read_distance(
    object: &Map<String, Value>,
    key: &str,
    label: &str,
) -> Result<i32, String> {
    let Some(value) = object.get(key) else {
        return Err(format!("Set a distance for {label}."));
    };
    let Some(value) = value.as_i64() else {
        return Err(format!("{label} must be a whole number of blocks."));
    };
    if !(-1..=MAX_DISTANCE as i64).contains(&value) {
        return Err(format!(
            "{label} must be between 0 and {MAX_DISTANCE} blocks, or blank for the game default."
        ));
    }
    Ok(value as i32)
}

fn distances_from_input(input: &Value) -> Result<RenderDistances, String> {
    let object = input
        .get("distances")
        .and_then(Value::as_object)
        .ok_or_else(|| "No render distances were provided.".to_string())?;
    Ok(RenderDistances {
        item_frames: read_distance(object, "itemFrames", "Item frames")?,
        players: read_distance(object, "players", "Players")?,
        dropped_items: read_distance(object, "droppedItems", "Dropped items")?,
        armor_stands: read_distance(object, "armorStands", "Armor stands")?,
    })
}

impl RenderDistances {
    fn config_entries(self) -> [(&'static str, i32); 5] {
        [
            ("minecraft:item_frame", self.item_frames),
            ("minecraft:glow_item_frame", self.item_frames),
            ("minecraft:player", self.players),
            ("minecraft:item", self.dropped_items),
            ("minecraft:armor_stand", self.armor_stands),
        ]
    }
}

fn read_config(path: &Path) -> Result<Value, String> {
    if !path.exists() {
        return Ok(json!({}));
    }
    let raw = std::fs::read_to_string(path)
        .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
    let value: Value = serde_json::from_str(&raw)
        .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
    if !value.is_object() {
        return Err(format!(
            "{} does not contain a JSON object.",
            path.display()
        ));
    }
    Ok(value)
}

fn merge_config(
    mut root: Value,
    distances: RenderDistances,
    force_client_mode: bool,
) -> Result<Value, String> {
    let object = root
        .as_object_mut()
        .ok_or_else(|| "The Entity View Distance config is not a JSON object.".to_string())?;
    object
        .entry("CONFIG_VERSION_DONT_TOUCH_THIS")
        .or_insert_with(|| json!(1));
    if force_client_mode || !object.contains_key("mode") {
        object.insert("mode".into(), json!("client"));
    }
    let entity = object
        .entry("entityViewDistance")
        .or_insert_with(|| json!({}));
    let overrides = entity.as_object_mut().ok_or_else(|| {
        "The entityViewDistance entry in the Entity View Distance config is not an object."
            .to_string()
    })?;
    for (key, value) in distances.config_entries() {
        if value < 0 {
            overrides.remove(key);
        } else {
            overrides.insert(key.into(), json!(value));
        }
    }
    Ok(root)
}

fn write_config(
    runtime: &Arc<Runtime>,
    version_id: &str,
    distances: RenderDistances,
    force_client_mode: bool,
) -> Result<(), String> {
    let path = config_path(runtime, version_id);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let existing = read_config(&path)?;
    let merged = merge_config(existing, distances, force_client_mode)?;
    let raw = serde_json::to_string_pretty(&merged).map_err(|error| error.to_string())?;
    std::fs::write(&path, format!("{raw}\n"))
        .map_err(|error| format!("Could not write {}: {error}", path.display()))
}

fn clear_config(runtime: &Arc<Runtime>, version_id: &str) -> Result<(), String> {
    let path = config_path(runtime, version_id);
    if !path.exists() {
        return Ok(());
    }
    let existing = read_config(&path)?;
    let cleared = merge_config(existing, RenderDistances::default(), false)?;
    let raw = serde_json::to_string_pretty(&cleared).map_err(|error| error.to_string())?;
    std::fs::write(&path, format!("{raw}\n"))
        .map_err(|error| format!("Could not write {}: {error}", path.display()))
}

fn save_distances(
    runtime: &Arc<Runtime>,
    version_id: &str,
    distances: RenderDistances,
) -> Result<(), String> {
    {
        let mut state = runtime.state();
        let Some(instance) = state.modpacks.iter_mut().find(|row| row.id == version_id) else {
            return Err("That modpack no longer exists.".into());
        };
        instance.render_distances = distances;
    }
    runtime.save_modpacks()?;
    runtime.emit("modpacks:updated", runtime.modpack_list());
    Ok(())
}

pub async fn apply(runtime: &Arc<Runtime>, input: Value) -> Result<Value, String> {
    let version_id = input
        .get("versionId")
        .and_then(Value::as_str)
        .ok_or_else(|| "Choose a modpack first.".to_string())?;
    let instance = runtime.require_modpack(version_id)?;
    if instance.loader != "fabric" {
        return Err(
            "Per-entity render distances currently require a Fabric modpack. There is no maintained Forge or NeoForge build of Entity View Distance."
                .into(),
        );
    }
    let distances = distances_from_input(&input)?;
    if runtime.state().game.is_some() {
        return Err("Close Minecraft before changing render distances.".into());
    }

    if !distances.any() {
        clear_config(runtime, &instance.id)?;
        save_distances(runtime, &instance.id, distances)?;
        return Ok(json!({
            "status": status(runtime, &instance.id)?,
            "installed": false
        }));
    }

    {
        let mut state = runtime.state();
        if state.content_job {
            return Err("Another Modrinth download is already running.".into());
        }
        state.content_job = true;
    }
    let result = apply_inner(runtime, &instance, distances).await;
    runtime.state().content_job = false;
    if let Err(error) = &result {
        runtime.log(
            "launcher",
            "error",
            &format!("Could not apply render distances: {error}"),
        );
    }
    result
}

async fn apply_inner(
    runtime: &Arc<Runtime>,
    instance: &crate::model::ModpackRecord,
    distances: RenderDistances,
) -> Result<Value, String> {
    let installed = if has_helper(runtime, &instance.id)? {
        false
    } else {
        runtime.log(
            "launcher",
            "info",
            &format!("Installing {HELPER_TITLE} for \"{}\"...", instance.name),
        );
        let payload = json!({
            "targetVersion": instance.id,
            "projectId": HELPER_SLUG,
            "projectType": "mod"
        });
        modpacks::install_content(runtime, payload).await.map_err(|error| {
            if error.contains("no compatible content") {
                format!(
                    "Entity View Distance has no build for Minecraft {} on Fabric yet. {error}",
                    instance.game_version
                )
            } else {
                error
            }
        })?;
        true
    };
    write_config(runtime, &instance.id, distances, true)?;
    save_distances(runtime, &instance.id, distances)?;
    runtime.log(
        "launcher",
        "info",
        &format!("Applied per-entity render distances to \"{}\".", instance.name),
    );
    Ok(json!({
        "status": status(runtime, &instance.id)?,
        "installed": installed
    }))
}

/// Keep an already-installed helper's config in sync before launch. This does
/// not install the mod; applying from Content studio owns that step.
pub fn ensure(runtime: &Arc<Runtime>, version_id: &str) -> Result<(), String> {
    let instance = runtime.require_modpack(version_id)?;
    if !instance.render_distances.any() || instance.loader != "fabric" {
        return Ok(());
    }
    if has_helper(runtime, version_id)? {
        write_config(runtime, version_id, instance.render_distances, false)?;
    } else {
        runtime.log(
            "launcher",
            "warn",
            "Render distances are saved, but Entity View Distance is not installed. Apply them in Content studio.",
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_preserves_other_entities_and_uses_client_mode() {
        let existing = json!({
            "CONFIG_VERSION_DONT_TOUCH_THIS": 1,
            "mode": "both",
            "entityViewDistance": {
                "minecraft:cow": 48,
                "minecraft:player": 12
            }
        });
        let distances = RenderDistances {
            item_frames: 32,
            players: 64,
            dropped_items: 24,
            armor_stands: 16,
        };
        let merged = merge_config(existing, distances, true).expect("config should merge");
        assert_eq!(merged["mode"], "client");
        assert_eq!(merged["entityViewDistance"]["minecraft:cow"], 48);
        assert_eq!(merged["entityViewDistance"]["minecraft:player"], 64);
        assert_eq!(merged["entityViewDistance"]["minecraft:item_frame"], 32);
        assert_eq!(merged["entityViewDistance"]["minecraft:glow_item_frame"], 32);
        assert_eq!(merged["entityViewDistance"]["minecraft:item"], 24);
        assert_eq!(merged["entityViewDistance"]["minecraft:armor_stand"], 16);
    }

    #[test]
    fn blank_values_clear_only_managed_overrides() {
        let existing = json!({
            "mode": "client",
            "entityViewDistance": {
                "minecraft:cow": 48,
                "minecraft:item_frame": 32,
                "minecraft:glow_item_frame": 32,
                "minecraft:player": 64,
                "minecraft:item": 24,
                "minecraft:armor_stand": 16
            }
        });
        let merged = merge_config(existing, RenderDistances::default(), false)
            .expect("config should merge");
        assert_eq!(merged["mode"], "client");
        assert_eq!(merged["entityViewDistance"]["minecraft:cow"], 48);
        for key in [
            "minecraft:item_frame",
            "minecraft:glow_item_frame",
            "minecraft:player",
            "minecraft:item",
            "minecraft:armor_stand",
        ] {
            assert!(merged["entityViewDistance"].get(key).is_none());
        }
    }
}
