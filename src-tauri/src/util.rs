use futures_util::StreamExt;
use regex::Regex;
use md5::Md5;
use sha1::{Digest, Sha1};
use sha2::Sha512;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::io::AsyncWriteExt;

pub const USER_AGENT: &str = "EclipseClient/1.0.0";

pub fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(60))
        .build()
        .expect("HTTP client")
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub fn iso_now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn format_bytes(bytes: u64) -> String {
    if bytes < 1024 {
        format!("{bytes} B")
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else if bytes < 1024 * 1024 * 1024 {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    } else {
        format!("{:.2} GB", bytes as f64 / (1024.0 * 1024.0 * 1024.0))
    }
}

pub fn strip_ansi(value: &str) -> String {
    Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]").unwrap().replace_all(value, "").to_string()
}

pub fn assert_https(raw: &str) -> Result<url::Url, String> {
    let parsed = url::Url::parse(raw).map_err(|_| "Invalid download URL".to_string())?;
    if parsed.scheme() != "https" {
        return Err(format!("Refusing non-HTTPS download: {raw}"));
    }
    Ok(parsed)
}

pub async fn fetch_json(client: &reqwest::Client, url: &str) -> Result<serde_json::Value, String> {
    assert_https(url)?;
    let response = client.get(url).send().await.map_err(|e| format!("Could not reach {url}: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("HTTP {} {}", response.status().as_u16(), response.status().canonical_reason().unwrap_or("")));
    }
    response.json().await.map_err(|e| format!("Invalid server response: {e}"))
}

pub async fn fetch_text(client: &reqwest::Client, url: &str) -> Result<String, String> {
    assert_https(url)?;
    let response = client.get(url).send().await.map_err(|e| format!("Could not reach {url}: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }
    response.text().await.map_err(|e| e.to_string())
}

pub async fn sha1_file(path: &Path) -> Result<String, String> {
    let bytes = tokio::fs::read(path).await.map_err(|e| e.to_string())?;
    let mut hasher = Sha1::new();
    hasher.update(&bytes);
    Ok(format!("{:x}", hasher.finalize()))
}

pub async fn download_file(
    client: &reqwest::Client,
    url: &str,
    destination: &Path,
    sha1: Option<&str>,
    sha512: Option<&str>,
    size: Option<u64>,
) -> Result<u64, String> {
    let parsed = assert_https(url)?;
    if let Some(parent) = destination.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
    }
    let part = PathBuf::from(format!("{}.part", destination.display()));
    let mut last_error = String::new();
    for attempt in 0..3 {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(350 * attempt as u64)).await;
        }
        let _ = tokio::fs::remove_file(&part).await;
        let response = match client.get(parsed.as_str()).send().await {
            Ok(value) => value,
            Err(error) => {
                last_error = error.to_string();
                continue;
            }
        };
        if !response.status().is_success() {
            last_error = format!("HTTP {}", response.status().as_u16());
            continue;
        }
        let mut stream = response.bytes_stream();
        let mut file = match tokio::fs::File::create(&part).await {
            Ok(value) => value,
            Err(error) => return Err(error.to_string()),
        };
        let mut received = 0u64;
        let mut failed = false;
        while let Some(chunk) = stream.next().await {
            match chunk {
                Ok(bytes) => {
                    received += bytes.len() as u64;
                    if let Err(error) = file.write_all(&bytes).await {
                        last_error = error.to_string();
                        failed = true;
                        break;
                    }
                }
                Err(error) => {
                    last_error = error.to_string();
                    failed = true;
                    break;
                }
            }
        }
        if let Err(error) = file.flush().await {
            last_error = error.to_string();
            failed = true;
        }
        drop(file);
        if failed {
            continue;
        }
        if let Some(expected) = size {
            if received != expected {
                last_error = format!("size mismatch (expected {expected}, received {received})");
                continue;
            }
        }
        if let Some(expected) = sha1 {
            let actual = sha1_file(&part).await?;
            if actual.to_lowercase() != expected.to_lowercase() {
                last_error = "SHA-1 checksum mismatch".into();
                continue;
            }
        }
        if let Some(expected) = sha512 {
            let bytes = tokio::fs::read(&part).await.map_err(|e| e.to_string())?;
            let mut hasher = Sha512::new();
            hasher.update(&bytes);
            let actual = format!("{:x}", hasher.finalize());
            if actual.to_lowercase() != expected.to_lowercase() {
                last_error = "SHA-512 checksum mismatch".into();
                continue;
            }
        }
        let _ = tokio::fs::remove_file(destination).await;
        tokio::fs::rename(&part, destination).await.map_err(|e| e.to_string())?;
        return Ok(received);
    }
    let _ = tokio::fs::remove_file(&part).await;
    Err(format!("Could not download {} — {}", url, last_error))
}

pub async fn run_command(
    file: &str,
    args: &[String],
    timeout_secs: u64,
) -> Result<(bool, Option<i32>, String, String), String> {
    let mut command = tokio::process::Command::new(file);
    command.args(args).kill_on_drop(true);
    #[cfg(target_os = "windows")]
    {
        let _ = &command;
        #[allow(unused_imports)]
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let output = tokio::time::timeout(Duration::from_secs(timeout_secs), command.output())
        .await
        .map_err(|_| "Timed out".to_string())?
        .map_err(|e| e.to_string())?;
    Ok((
        output.status.success(),
        output.status.code(),
        String::from_utf8_lossy(&output.stdout).to_string(),
        String::from_utf8_lossy(&output.stderr).to_string(),
    ))
}

pub fn md5_hex(bytes: &[u8]) -> String {
    let mut hasher = Md5::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

pub fn offline_uuid(name: &str) -> String {
    let mut hasher = Md5::new();
    hasher.update(format!("OfflinePlayer:{name}").as_bytes());
    let mut bytes: [u8; 16] = hasher.finalize().into();
    bytes[6] = (bytes[6] & 0x0f) | 0x30;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|value| format!("{value:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &hex[..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..])
}

pub fn random_token() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|value| format!("{value:02x}")).collect()
}

pub fn slugify(value: &str) -> String {
    let value = value.to_lowercase();
    let mut output = String::new();
    let mut dash = false;
    for character in value.chars() {
        if character.is_ascii_alphanumeric() {
            output.push(character);
            dash = false;
        } else if !dash && !output.is_empty() {
            output.push('-');
            dash = true;
        }
    }
    output.trim_matches('-').chars().take(24).collect()
}

pub fn safe_file_name(original: &str, fallback: &str) -> String {
    let base = original.replace('\\', "/");
    let base = base.rsplit('/').next().unwrap_or("");
    let mut name: String = base
        .chars()
        .map(|character| {
            if character.is_control() || "<>:\"/\\|?*".contains(character) {
                '-'
            } else {
                character
            }
        })
        .collect();
    name = name.split_whitespace().collect::<Vec<_>>().join(" ");
    name = name.trim_matches('.').to_string();
    if name.is_empty() {
        name = fallback.to_string();
    }
    if name.len() > 180 {
        name.truncate(180);
    }
    name
}

pub fn unique_file_name(name: &str, used: &mut std::collections::HashSet<String>) -> String {
    if used.insert(name.to_lowercase()) {
        return name.to_string();
    }
    let path = Path::new(name);
    let extension = path.extension().and_then(|value| value.to_str()).unwrap_or("");
    let stem = path.file_stem().and_then(|value| value.to_str()).unwrap_or("content");
    for index in 2..1000 {
        let candidate = if extension.is_empty() {
            format!("{stem}-{index}")
        } else {
            format!("{stem}-{index}.{extension}")
        };
        if used.insert(candidate.to_lowercase()) {
            return candidate;
        }
    }
    format!("{stem}-{}.{}", now_ms(), extension)
}

pub fn total_memory_mb() -> u64 {
    #[cfg(target_os = "windows")]
    {
        // GlobalMemoryStatusEx. Static fallback is used if the query fails.
        #[repr(C)]
        struct MemoryStatusEx {
            length: u32,
            memory_load: u32,
            total_phys: u64,
            avail_phys: u64,
            total_page_file: u64,
            avail_page_file: u64,
            total_virtual: u64,
            avail_virtual: u64,
            avail_extended_virtual: u64,
        }
        #[link(name = "kernel32")]
        extern "system" {
            fn GlobalMemoryStatusEx(buffer: *mut MemoryStatusEx) -> i32;
        }
        let mut status = MemoryStatusEx {
            length: std::mem::size_of::<MemoryStatusEx>() as u32,
            memory_load: 0,
            total_phys: 0,
            avail_phys: 0,
            total_page_file: 0,
            avail_page_file: 0,
            total_virtual: 0,
            avail_virtual: 0,
            avail_extended_virtual: 0,
        };
        if unsafe { GlobalMemoryStatusEx(&mut status) } != 0 && status.total_phys > 0 {
            return status.total_phys / (1024 * 1024);
        }
    }
    8192
}
