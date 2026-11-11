use crate::runtime::Runtime;
use crate::util::fetch_json;
use serde::Deserialize;
use serde_json::{json, Value};

const API: &str = "https://api.modrinth.com/v2";

#[derive(Clone, Deserialize)]
pub struct Dependency {
    #[serde(default)]
    pub version_id: Option<String>,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub file_name: Option<String>,
    #[serde(default)]
    pub dependency_type: String,
}

#[derive(Clone, Deserialize)]
pub struct File {
    pub url: String,
    pub filename: String,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub hashes: std::collections::HashMap<String, String>,
    #[serde(default)]
    pub primary: bool,
}

#[derive(Clone, Deserialize)]
pub struct Version {
    pub id: String,
    #[serde(default)]
    pub project_id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub version_number: String,
    #[serde(default)]
    pub version_type: String,
    #[serde(default)]
    pub game_versions: Vec<String>,
    #[serde(default)]
    pub loaders: Vec<String>,
    #[serde(default)]
    pub date_published: Option<String>,
    #[serde(default)]
    pub downloads: u64,
    #[serde(default)]
    pub files: Vec<File>,
    #[serde(default)]
    pub dependencies: Vec<Dependency>,
}

#[derive(Clone)]
pub struct NormalizedVersion {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub version_number: String,
    pub version_type: String,
    pub game_versions: Vec<String>,
    pub loaders: Vec<String>,
    pub date_published: Option<String>,
    pub downloads: u64,
    pub file_name: String,
    pub file_size: u64,
    pub sha1: String,
    pub url: String,
    pub dependencies: Vec<Dependency>,
}

#[derive(Clone)]
pub struct Project {
    pub id: String,
    pub slug: String,
    pub title: String,
    pub description: String,
    pub project_type: String,
    pub icon_url: String,
    pub body: String,
    pub categories: Vec<String>,
    pub game_versions: Vec<String>,
    pub loaders: Vec<String>,
}

#[derive(Deserialize)]
struct RawProject {
    id: String,
    #[serde(default)]
    slug: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    project_type: String,
    #[serde(default)]
    icon_url: Option<String>,
    #[serde(default)]
    body: String,
    #[serde(default)]
    categories: Vec<String>,
    #[serde(default)]
    game_versions: Vec<String>,
    #[serde(default)]
    loaders: Vec<String>,
}

fn safe_image(value: Option<&str>) -> String {
    let Some(value) = value else { return String::new() };
    let Ok(url) = url::Url::parse(value) else { return String::new() };
    if url.scheme() != "https" { return String::new(); }
    match url.host_str() {
        Some("cdn.modrinth.com") | Some("cdn-raw.modrinth.com") => url.to_string(),
        _ => String::new(),
    }
}

fn project_ref(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || !regex::Regex::new(r"^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$").unwrap().is_match(value) {
        return Err("Invalid Modrinth project.".into());
    }
    Ok(value.into())
}

fn version_ref(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || !regex::Regex::new(r"^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$").unwrap().is_match(value) {
        return Err("Invalid Modrinth version.".into());
    }
    Ok(value.into())
}

pub fn normalize_version(version: Version) -> Option<NormalizedVersion> {
    let file = version.files.iter().find(|file| file.primary).or_else(|| version.files.first())?;
    let parsed = url::Url::parse(&file.url).ok()?;
    if parsed.scheme() != "https" { return None; }
    Some(NormalizedVersion {
        id: version.id,
        project_id: version.project_id,
        name: version.name,
        version_number: version.version_number,
        version_type: if version.version_type.is_empty() { "release".into() } else { version.version_type },
        game_versions: version.game_versions,
        loaders: version.loaders,
        date_published: version.date_published,
        downloads: version.downloads,
        file_name: file.filename.clone(),
        file_size: file.size,
        sha1: file.hashes.get("sha1").cloned().unwrap_or_default(),
        url: file.url.clone(),
        dependencies: version.dependencies,
    })
}

pub async fn search(runtime: &Runtime, query: &str, project_type: &str, game_version: &str, loader: &str, offset: u64, limit: u64) -> Result<Value, String> {
    if !matches!(project_type, "mod" | "resourcepack" | "shader" | "modpack") {
        return Err("Choose a mod, resource pack, shader, or modpack.".into());
    }
    let type_name = project_type;
    let mut facets: Vec<Vec<String>> = vec![vec![format!("project_type:{type_name}")]];
    if !game_version.is_empty() {
        facets.push(vec![format!("versions:{game_version}")]);
    }
    if type_name == "mod" && !loader.is_empty() {
        facets.push(vec![format!("categories:{loader}")]);
    }
    let limit = limit.clamp(1, 100);
    let mut url = url::Url::parse(&format!("{API}/search")).map_err(|e| e.to_string())?;
    {
        let mut params = url.query_pairs_mut();
        params.append_pair("query", query.trim());
        params.append_pair("limit", &limit.to_string());
        params.append_pair("offset", &offset.min(10000).to_string());
        params.append_pair("index", if query.trim().is_empty() { "downloads" } else { "relevance" });
        params.append_pair("facets", &serde_json::to_string(&facets).map_err(|e| e.to_string())?);
    }
    let data = fetch_json(&runtime.http, url.as_str()).await?;
    let Some(hits) = data.get("hits").and_then(Value::as_array) else {
        return Err("Modrinth returned an unexpected search response.".into());
    };
    let mut output = Vec::new();
    for hit in hits {
        let Some(id) = hit.get("project_id").and_then(Value::as_str) else { continue };
        output.push(json!({
            "id": id,
            "slug": hit.get("slug").and_then(Value::as_str).unwrap_or(""),
            "projectType": hit.get("project_type").and_then(Value::as_str).unwrap_or(""),
            "title": hit.get("title").and_then(Value::as_str).unwrap_or("Untitled"),
            "description": hit.get("description").and_then(Value::as_str).unwrap_or(""),
            "author": hit.get("author").and_then(Value::as_str).unwrap_or(""),
            "iconUrl": safe_image(hit.get("icon_url").and_then(Value::as_str)),
            "downloads": hit.get("downloads").and_then(Value::as_u64).unwrap_or(0),
            "follows": hit.get("follows").and_then(Value::as_u64).unwrap_or(0),
            "categories": hit.get("categories").cloned().unwrap_or_else(|| json!([])),
            "gameVersions": hit.get("versions").cloned().unwrap_or_else(|| json!([])),
            "dateModified": hit.get("date_modified").cloned().unwrap_or(Value::Null)
        }));
    }
    Ok(json!({
        "hits": output,
        "totalHits": data.get("total_hits").and_then(Value::as_u64).unwrap_or(0),
        "offset": offset,
        "limit": limit
    }))
}

pub async fn fetch_project(runtime: &Runtime, reference: &str) -> Result<Project, String> {
    let reference = project_ref(reference)?;
    let data = fetch_json(&runtime.http, &format!("{API}/project/{}", url::form_urlencoded::byte_serialize(reference.as_bytes()).collect::<String>())).await?;
    let raw: RawProject = serde_json::from_value(data).map_err(|_| "Modrinth returned an unexpected project.".to_string())?;
    Ok(Project {
        id: raw.id,
        slug: raw.slug,
        title: if raw.title.is_empty() { "Untitled".into() } else { raw.title },
        description: raw.description,
        project_type: raw.project_type,
        icon_url: safe_image(raw.icon_url.as_deref()),
        body: raw.body,
        categories: raw.categories,
        game_versions: raw.game_versions,
        loaders: raw.loaders,
    })
}

pub async fn fetch_versions(runtime: &Runtime, reference: &str, game_version: &str, loader: &str) -> Result<Vec<NormalizedVersion>, String> {
    let reference = project_ref(reference)?;
    let mut url = url::Url::parse(&format!("{API}/project/{}/version", url::form_urlencoded::byte_serialize(reference.as_bytes()).collect::<String>())).map_err(|e| e.to_string())?;
    {
        let mut params = url.query_pairs_mut();
        if !game_version.is_empty() {
            params.append_pair("game_versions", &serde_json::to_string(&[game_version]).map_err(|e| e.to_string())?);
        }
        if !loader.is_empty() {
            params.append_pair("loaders", &serde_json::to_string(&[loader]).map_err(|e| e.to_string())?);
        }
    }
    let data = fetch_json(&runtime.http, url.as_str()).await?;
    let raw: Vec<Version> = serde_json::from_value(data).map_err(|_| "Modrinth returned an unexpected version list.".to_string())?;
    Ok(raw.into_iter().filter_map(normalize_version).collect())
}

pub async fn fetch_version(runtime: &Runtime, id: &str) -> Result<NormalizedVersion, String> {
    let id = version_ref(id)?;
    let data = fetch_json(&runtime.http, &format!("{API}/version/{}", url::form_urlencoded::byte_serialize(id.as_bytes()).collect::<String>())).await?;
    let raw: Version = serde_json::from_value(data).map_err(|_| "Modrinth returned an unusable version file.".to_string())?;
    normalize_version(raw).ok_or_else(|| "Modrinth returned an unusable version file.".into())
}

pub fn pick_best(versions: &[NormalizedVersion]) -> Option<NormalizedVersion> {
    versions.iter().find(|version| version.version_type == "release").or_else(|| versions.first()).cloned()
}

pub fn version_json(version: &NormalizedVersion) -> Value {
    json!({
        "id": version.id,
        "projectId": version.project_id,
        "name": version.name,
        "versionNumber": version.version_number,
        "versionType": version.version_type,
        "gameVersions": version.game_versions,
        "loaders": version.loaders,
        "datePublished": version.date_published,
        "downloads": version.downloads,
        "fileName": version.file_name,
        "fileSize": version.file_size,
        "sha1": version.sha1,
        "url": version.url,
        "dependencies": version.dependencies.iter().map(|dependency| json!({
            "versionId": dependency.version_id,
            "projectId": dependency.project_id,
            "fileName": dependency.file_name,
            "dependencyType": dependency.dependency_type
        })).collect::<Vec<_>>()
    })
}

pub fn project_json(project: &Project) -> Value {
    json!({
        "id": project.id,
        "slug": project.slug,
        "title": project.title,
        "description": project.description,
        "projectType": project.project_type,
        "iconUrl": project.icon_url,
        "body": project.body,
        "categories": project.categories,
        "gameVersions": project.game_versions,
        "loaders": project.loaders
    })
}

pub fn trusted_download(value: &str) -> Result<String, String> {
    let url = url::Url::parse(value).map_err(|_| "Modrinth supplied an invalid download link.".to_string())?;
    if url.scheme() != "https" {
        return Err("Modrinth supplied an insecure download link.".into());
    }
    let host = url.host_str().unwrap_or("").to_lowercase();
    if host != "cdn.modrinth.com" && !host.ends_with(".modrinth.com") {
        return Err("Modrinth supplied a download link from an unknown host.".into());
    }
    Ok(url.to_string())
}
