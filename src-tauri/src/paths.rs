use regex::Regex;
use std::path::{Component, Path, PathBuf};

#[derive(Clone)]
pub struct McPaths {
    pub root: PathBuf,
    pub libraries: PathBuf,
    pub assets: PathBuf,
    pub asset_objects: PathBuf,
    pub asset_indexes: PathBuf,
    pub versions: PathBuf,
    pub log_configs: PathBuf,
    pub cache: PathBuf,
}

impl McPaths {
    pub fn new(root: PathBuf) -> Self {
        Self {
            libraries: root.join("libraries"),
            assets: root.join("assets"),
            asset_objects: root.join("assets").join("objects"),
            asset_indexes: root.join("assets").join("indexes"),
            versions: root.join("versions"),
            log_configs: root.join("assets").join("log_configs"),
            cache: root.join("cache"),
            root,
        }
    }

    pub fn ensure(&self) -> Result<(), String> {
        for path in [
            &self.libraries,
            &self.assets,
            &self.asset_objects,
            &self.asset_indexes,
            &self.versions,
            &self.log_configs,
            &self.cache,
        ] {
            std::fs::create_dir_all(path).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn version_dir(&self, id: &str) -> Result<PathBuf, String> {
        Ok(self.versions.join(validate_version_id(id)?))
    }

    pub fn version_json(&self, id: &str) -> Result<PathBuf, String> {
        let id = validate_version_id(id)?;
        Ok(self.version_dir(&id)?.join(format!("{id}.json")))
    }

    pub fn client_jar(&self, id: &str) -> Result<PathBuf, String> {
        let id = validate_version_id(id)?;
        Ok(self.version_dir(&id)?.join(format!("{id}.jar")))
    }

    pub fn natives_dir(&self, id: &str) -> Result<PathBuf, String> {
        Ok(self.version_dir(id)?.join("natives"))
    }

    pub fn completion_marker(&self, id: &str) -> Result<PathBuf, String> {
        Ok(self.version_dir(id)?.join(".complete"))
    }

    pub fn asset_index(&self, id: &str) -> Result<PathBuf, String> {
        Ok(self.asset_indexes.join(format!("{}.json", validate_asset_id(id)?)))
    }

    pub fn asset_object(&self, hash: &str) -> Result<PathBuf, String> {
        if !Regex::new(r"(?i)^[0-9a-f]{40}$").unwrap().is_match(hash) {
            return Err("Invalid asset hash".into());
        }
        let hash = hash.to_lowercase();
        Ok(self.asset_objects.join(&hash[..2]).join(hash))
    }

    pub fn virtual_assets(&self, id: &str) -> Result<PathBuf, String> {
        Ok(self.assets.join("virtual").join(validate_asset_id(id)?))
    }

    pub fn log_config(&self, id: &str) -> Result<PathBuf, String> {
        if !Regex::new(r"^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$").unwrap().is_match(id) {
            return Err("Invalid logging config id".into());
        }
        safe_join(&self.log_configs, id)
    }
}

pub fn validate_version_id(value: &str) -> Result<String, String> {
    if value.is_empty()
        || !Regex::new(r"^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$").unwrap().is_match(value)
    {
        return Err(format!("Invalid version id: {value}"));
    }
    Ok(value.to_string())
}

pub fn validate_asset_id(value: &str) -> Result<String, String> {
    if value.is_empty()
        || !Regex::new(r"^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$").unwrap().is_match(value)
    {
        return Err(format!("Invalid asset index id: {value}"));
    }
    Ok(value.to_string())
}

pub fn safe_join(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let normalized = relative.replace('\\', "/");
    let rel = Path::new(&normalized);
    if rel.is_absolute() {
        return Err("Refusing an absolute path".into());
    }
    let mut result = root.to_path_buf();
    for component in rel.components() {
        match component {
            Component::Normal(value) => result.push(value),
            Component::CurDir => {}
            _ => return Err("Refusing a path outside the game folder".into()),
        }
    }
    Ok(result)
}

pub fn validate_pack_path(value: &str, file: bool) -> Result<String, String> {
    let raw = value.replace('\\', "/");
    if raw.is_empty() || raw.contains('\0') {
        return Err("The modpack contains an empty file path.".into());
    }
    if raw.starts_with('/') || Regex::new(r"(?i)^[a-z]:").unwrap().is_match(&raw) {
        return Err("The modpack contains an absolute file path.".into());
    }
    let mut parts: Vec<&str> = Vec::new();
    for part in raw.split('/') {
        match part {
            "" | "." => {}
            ".." => return Err("The modpack contains a file path outside its game folder.".into()),
            value => parts.push(value),
        }
    }
    if parts.is_empty() {
        return Err("The modpack contains an empty file path.".into());
    }
    let normalized = parts.join("/");
    if file && !normalized.contains('/') && normalized.is_empty() {
        return Err("The modpack contains a download entry without a file name.".into());
    }
    if matches!(normalized.to_lowercase().as_str(), "instance.json" | "eclipse-content.json" | "modrinth.index.json") {
        return Err(format!("The modpack tried to overwrite launcher metadata ({normalized})."));
    }
    Ok(normalized)
}
