use serde::de::DeserializeOwned;
use serde::Serialize;
use std::fs;
use std::path::Path;

pub fn load<T: DeserializeOwned + Serialize + Clone>(path: &Path, defaults: T) -> T {
    if !path.exists() {
        let _ = save(path, &defaults);
        return defaults;
    }
    match fs::read_to_string(path).ok().and_then(|raw| serde_json::from_str::<T>(&raw).ok()) {
        Some(value) => value,
        None => {
            let corrupt = path.with_file_name(format!(
                "{}.corrupt-{}",
                path.file_name().and_then(|v| v.to_str()).unwrap_or("store.json"),
                chrono::Utc::now().timestamp_millis()
            ));
            let _ = fs::rename(path, corrupt);
            let _ = save(path, &defaults);
            defaults
        }
    }
}

pub fn save<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let temp = path.with_extension("tmp");
    let data = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    fs::write(&temp, data).map_err(|e| e.to_string())?;
    if path.exists() {
        let _ = fs::remove_file(path);
    }
    fs::rename(&temp, path).map_err(|e| e.to_string())
}
