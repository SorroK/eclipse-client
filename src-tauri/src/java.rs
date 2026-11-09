use crate::model::JavaInstallation;
use crate::util::run_command;
use regex::Regex;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

pub fn parse_version(value: &str) -> u32 {
    let regex = Regex::new(r"^(\d+)(?:\.(\d+))?").unwrap();
    let Some(captures) = regex.captures(value) else { return 0 };
    let mut major = captures.get(1).and_then(|m| m.as_str().parse::<u32>().ok()).unwrap_or(0);
    if major == 1 {
        if let Some(minor) = captures.get(2).and_then(|m| m.as_str().parse::<u32>().ok()) {
            major = minor;
        }
    }
    major
}

pub fn parse_output(stdout: &str, stderr: &str) -> Option<(String, u32, String, String)> {
    let text = format!("{stdout}\n{stderr}");
    let property = Regex::new(r"(?m)^\s{2,}([A-Za-z0-9_.]+)\s*=\s*(.*?)\s*$").unwrap();
    let mut properties = std::collections::HashMap::new();
    for captures in property.captures_iter(&text) {
        properties.insert(captures[1].to_string(), captures[2].trim().to_string());
    }
    let mut version = properties.get("java.version").cloned();
    if version.is_none() {
        if let Some(captures) = Regex::new(r#"(?i)version "([^"]+)""#).unwrap().captures(&text) {
            version = Some(captures[1].to_string());
        }
    }
    let version = version?;
    let major = parse_version(&version);
    if major == 0 { return None; }
    let vendor = properties.get("java.vendor").cloned().unwrap_or_else(|| {
        if text.contains("Zulu") { "Azul Zulu".into() }
        else if text.contains("Temurin") || text.contains("Adoptium") { "Eclipse Temurin".into() }
        else if text.contains("Microsoft") { "Microsoft OpenJDK".into() }
        else if text.contains("Corretto") { "Amazon Corretto".into() }
        else if text.contains("OpenJDK") { "OpenJDK".into() }
        else { "Java".into() }
    });
    let arch = properties.get("os.arch").cloned().unwrap_or_else(|| std::env::consts::ARCH.into());
    Some((version, major, vendor, arch))
}

pub async fn probe(path: &str) -> Option<JavaInstallation> {
    let args = vec!["-XshowSettings:properties".into(), "-version".into()];
    let (_, _, stdout, stderr) = run_command(path, &args, 9).await.ok()?;
    let (version, major, vendor, arch) = parse_output(&stdout, &stderr)?;
    Some(JavaInstallation {
        path: path.into(),
        version,
        major,
        vendor,
        arch,
        source: "Custom".into(),
    })
}

fn executable_name() -> &'static str {
    if cfg!(target_os = "windows") { "java.exe" } else { "java" }
}

fn add_exact(candidates: &mut Vec<(String, String)>, path: PathBuf, source: &str) {
    if path.is_file() {
        candidates.push((path.to_string_lossy().to_string(), source.into()));
    }
}

fn walk_candidates(
    candidates: &mut Vec<(String, String)>,
    root: &Path,
    depth: usize,
    source: &str,
    seen: &mut HashSet<String>,
) {
    let target = executable_name();
    for entry in WalkDir::new(root)
        .max_depth(depth)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .take(2500)
    {
        if !entry.file_type().is_file() || entry.file_name().to_string_lossy().to_lowercase() != target {
            continue;
        }
        let path = entry.path().to_path_buf();
        let key = path.to_string_lossy().to_lowercase();
        if seen.insert(key) {
            candidates.push((path.to_string_lossy().to_string(), source.into()));
        }
        if candidates.len() >= 40 { break; }
    }
}

pub async fn detect(extra_paths: Vec<String>) -> crate::model::JavaState {
    let mut candidates = Vec::new();
    add_exact(&mut candidates, PathBuf::from(executable_name()), "PATH");
    if let Ok(path) = std::env::var("PATH") {
        for folder in std::env::split_paths(&path) {
            add_exact(&mut candidates, folder.join(executable_name()), "PATH");
        }
    }
    if let Some(home) = std::env::var_os("JAVA_HOME") {
        add_exact(&mut candidates, PathBuf::from(home).join("bin").join(executable_name()), "JAVA_HOME");
    }
    for extra in extra_paths {
        if !extra.is_empty() {
            add_exact(&mut candidates, PathBuf::from(extra), "Custom");
        }
    }

    let mut roots: Vec<(PathBuf, usize, String)> = Vec::new();
    if cfg!(target_os = "windows") {
        let program_files = std::env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".into());
        let program_x86 = std::env::var("ProgramFiles(x86)").unwrap_or_else(|_| "C:\\Program Files (x86)".into());
        let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
        let home = std::env::var("USERPROFILE").unwrap_or_default();
        for base in ["Java", "Eclipse Adoptium", "Eclipse Foundation", "Zulu", "Microsoft", "BellSoft", "Amazon Corretto", "IBM", "Semeru", "Liberica", "AdoptOpenJDK"] {
            roots.push((PathBuf::from(&program_files).join(base), 3, "Installed JDK".into()));
        }
        if !local.is_empty() {
            roots.push((PathBuf::from(&local).join("Programs").join("Eclipse Adoptium"), 3, "Installed JDK".into()));
            roots.push((PathBuf::from(&local).join("Programs").join("Microsoft"), 3, "Installed JDK".into()));
            roots.push((PathBuf::from(&local).join("Packages").join("Microsoft.4297127D64EC6_8wekyb3d8bbwe").join("LocalCache").join("Local").join("runtime"), 6, "Mojang runtime".into()));
        }
        roots.push((PathBuf::from(&program_x86).join("Minecraft Launcher").join("runtime"), 6, "Mojang runtime".into()));
        if !home.is_empty() {
            roots.push((PathBuf::from(&home).join(".jdks"), 3, "Installed JDK".into()));
            roots.push((PathBuf::from(&home).join(".minecraft").join("runtime"), 6, "Mojang runtime".into()));
        }
    } else {
        roots.push((PathBuf::from("/usr/lib/jvm"), 3, "Installed JDK".into()));
        if let Some(home) = std::env::var_os("HOME") {
            roots.push((PathBuf::from(home).join(".jdks"), 3, "Installed JDK".into()));
        }
    }

    let mut seen = HashSet::new();
    for (root, depth, source) in roots {
        if root.is_dir() {
            walk_candidates(&mut candidates, &root, depth, &source, &mut seen);
        }
    }
    let mut unique = HashSet::new();
    let mut found = Vec::new();
    for (path, source) in candidates.into_iter().take(24) {
        let key = if cfg!(target_os = "windows") { path.to_lowercase() } else { path.clone() };
        if !unique.insert(key.clone()) { continue; }
        if let Some(mut info) = probe(&key).await {
            info.path = path;
            info.source = source;
            found.push(info);
        }
    }
    found.sort_by(|left, right| right.major.cmp(&left.major).then_with(|| left.path.cmp(&right.path)));
    crate::model::JavaState { detecting: false, installations: found, error: None }
}

pub fn select(installations: &[JavaInstallation], required: u32) -> Option<JavaInstallation> {
    if required <= 8 {
        installations
            .iter()
            .filter(|entry| entry.major == 8)
            .max_by(|left, right| left.version.cmp(&right.version))
            .cloned()
    } else {
        installations
            .iter()
            .filter(|entry| entry.major >= required)
            .min_by(|left, right| {
                left.major.cmp(&right.major).then_with(|| right.version.cmp(&left.version))
            })
            .cloned()
    }
}
