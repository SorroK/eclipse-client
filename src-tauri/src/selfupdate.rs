//! Automatic launcher updates that replace the executable in place.
//!
//! Each release publishes the raw `eclipse-client.exe`, a detached minisign
//! signature, and a small `latest-exe.json` describing them. This module
//! verifies the signature against the key pinned below, renames the running
//! image aside, puts the new build at the same path, and restarts the process.
//! No installer and no second executable are involved.

use crate::util::assert_https;
use base64::Engine;
use serde_json::{json, Value};
use std::cmp::Ordering;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};

const DEFAULT_MANIFEST: &str =
    "https://github.com/SorroK/eclipse-client/releases/latest/download/latest-exe.json";

/// Base64 of the two-line minisign public key (`untrusted comment` + `RW…`).
/// Only builds signed by the matching private key are accepted.
const UPDATE_PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDlBM0E2OUY0QTQ0OTRCMTYKUldRV1MwbWs5R2s2bWpEZUc4SDQ0SWJneEkvZjYzdWQ1TGFHVVhpTUNHOGs0L241OFdnaSt5Q08K";

struct Manifest {
    version: String,
    url: String,
    signature: String,
    sha256: String,
    notes: String,
}

fn manifest_url() -> String {
    std::env::var("ECLIPSE_CLIENT_UPDATE_MANIFEST")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_MANIFEST.to_string())
}

fn parse_manifest(value: &Value) -> Result<Manifest, String> {
    let version = value
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if version.is_empty() {
        return Err("The update manifest does not name a version.".into());
    }
    let url = value
        .get("url")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    assert_https(&url).map_err(|error| format!("The update manifest is unusable: {error}"))?;
    let signature = value
        .get("signature")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if signature.is_empty() {
        return Err("The update manifest has no signature.".into());
    }
    Ok(Manifest {
        version,
        url,
        signature,
        sha256: value
            .get("sha256")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_lowercase(),
        notes: value
            .get("notes")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string(),
    })
}

pub async fn check(http: &reqwest::Client, current: &str) -> Result<Value, String> {
    let raw = crate::util::fetch_json(http, &manifest_url())
        .await
        .map_err(|error| format!("Could not check for updates: {error}"))?;
    let manifest = parse_manifest(&raw)?;
    let available =
        crate::loaders::compare_versions(&manifest.version, current) == Ordering::Greater;
    Ok(json!({
        "available": available,
        "version": manifest.version,
        "currentVersion": current,
        "notes": manifest.notes
    }))
}

pub async fn install(app: &AppHandle, http: &reqwest::Client) -> Result<Value, String> {
    let current = app.package_info().version.to_string();
    let raw = crate::util::fetch_json(http, &manifest_url())
        .await
        .map_err(|error| format!("Could not check for updates: {error}"))?;
    let manifest = parse_manifest(&raw)?;
    if crate::loaders::compare_versions(&manifest.version, &current) != Ordering::Greater {
        return Err("Eclipse Client is already up to date.".into());
    }

    let executable = std::env::current_exe()
        .map_err(|error| format!("Could not locate the launcher executable: {error}"))?;
    let executable = std::fs::canonicalize(&executable).unwrap_or(executable);
    let staged = staged_path(&executable)?;
    let _ = tokio::fs::remove_file(&staged).await;
    let _ = app.emit("update:progress", json!({ "downloaded": 0, "total": Value::Null }));

    if let Err(error) = download(&manifest.url, &staged, app, http).await {
        let _ = tokio::fs::remove_file(&staged).await;
        return Err(error);
    }

    let verified = (|| -> Result<(), String> {
        let bytes = std::fs::read(&staged)
            .map_err(|error| format!("Could not read the downloaded update: {error}"))?;
        if !manifest.sha256.is_empty() && sha256_hex(&bytes) != manifest.sha256 {
            return Err("The downloaded launcher does not match its checksum.".into());
        }
        verify_signature(&bytes, &manifest.signature)?;
        swap_in_place(&executable, &staged)
    })();
    if let Err(error) = verified {
        let _ = std::fs::remove_file(&staged);
        return Err(error);
    }

    let _ = app.emit("update:progress", json!({ "done": true }));
    #[allow(unreachable_code)]
    {
        app.restart();
        Ok(json!({ "installed": true, "version": manifest.version }))
    }
}

/// Remove leftovers from an update that ran while the launcher was starting up.
/// Called once at startup, before the window is shown.
pub fn cleanup_stale() {
    let Ok(executable) = std::env::current_exe() else {
        return;
    };
    let executable = std::fs::canonicalize(&executable).unwrap_or(executable);
    let _ = std::fs::remove_file(executable.with_extension("exe.old"));
    if let Some(directory) = executable.parent() {
        let _ = std::fs::remove_file(directory.join("eclipse-client.exe.new"));
    }
}

fn staged_path(executable: &Path) -> Result<PathBuf, String> {
    let directory = executable
        .parent()
        .ok_or_else(|| "The launcher executable has no folder.".to_string())?;
    Ok(directory.join("eclipse-client.exe.new"))
}

async fn download(
    url: &str,
    destination: &Path,
    app: &AppHandle,
    http: &reqwest::Client,
) -> Result<u64, String> {
    use futures_util::StreamExt;
    use tokio::io::AsyncWriteExt;

    let parsed = assert_https(url)?;
    let response = http
        .get(parsed.as_str())
        .send()
        .await
        .map_err(|error| format!("Could not download the update: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "The update download failed (HTTP {}).",
            response.status().as_u16()
        ));
    }
    let total = response.content_length();
    let mut file = tokio::fs::File::create(destination)
        .await
        .map_err(|error| format!("Could not save the update: {error}"))?;
    let mut stream = response.bytes_stream();
    let mut received = 0u64;
    let mut reported = 0u64;
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|error| format!("The update download stopped: {error}"))?;
        received += bytes.len() as u64;
        file.write_all(&bytes)
            .await
            .map_err(|error| format!("Could not save the update: {error}"))?;
        if received - reported >= 512 * 1024 {
            reported = received;
            let _ = app.emit(
                "update:progress",
                json!({ "downloaded": received, "total": total }),
            );
        }
    }
    file.flush()
        .await
        .map_err(|error| format!("Could not save the update: {error}"))?;
    Ok(received)
}

/// Windows cannot overwrite a running image, but it can rename one, so the
/// current executable is moved aside and the verified build takes its path.
fn swap_in_place(executable: &Path, staged: &Path) -> Result<(), String> {
    let backup = executable.with_extension("exe.old");
    let _ = std::fs::remove_file(&backup);
    std::fs::rename(executable, &backup)
        .map_err(|error| format!("Could not set the running launcher aside: {error}"))?;
    if let Err(error) = std::fs::rename(staged, executable) {
        let _ = std::fs::rename(&backup, executable);
        return Err(format!("Could not put the new launcher in place: {error}"));
    }
    Ok(())
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// Tauri wraps both the public key and the `.sig` file in base64, so unwrap
/// that layer when present and hand the inner minisign text to the verifier.
fn base64_text(value: &str) -> Option<String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(value.trim())
        .ok()?;
    String::from_utf8(bytes).ok()
}

fn verify_signature(bytes: &[u8], signature: &str) -> Result<(), String> {
    verify_with_key(bytes, signature, UPDATE_PUBKEY)
}

fn verify_with_key(bytes: &[u8], signature: &str, key_b64: &str) -> Result<(), String> {
    let key_text =
        base64_text(key_b64).ok_or_else(|| "The pinned update key is unreadable.".to_string())?;
    let key = minisign_verify::PublicKey::decode(&key_text)
        .map_err(|_| "The pinned update key is invalid.".to_string())?;
    let signature_text = base64_text(signature).unwrap_or_else(|| signature.trim().to_string());
    let decoded = minisign_verify::Signature::decode(&signature_text)
        .map_err(|_| "The update signature could not be read.".to_string())?;
    key.verify(bytes, &decoded, true)
        .map_err(|_| "The update signature does not match this build.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Throwaway keypair generated only for these tests; it never signs a release.
    const TEST_PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEU3NDJFNzM2RTY1Q0UyOEQKUldTTjRsem1OdWRDNTN3V2ZTekMvNlhQbVhsQmpNellFVllMaWpZbFo5WUZWQUxQNThuZ1c1MDIK";
    const TEST_SIGNATURE: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVTTjRsem1OdWRDNTVORWlaMm94bksvOTNyM3hPRE00M2dIVG85Ti9qd2ZDT3lmQjBraUdKWHQrWEZoc1FKelBhc3hiRHJuR2d2YnV5YkhTbXNEakUyU0pkd3dHYmJEV3d3PQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzk0Mzg5Mzc5CWZpbGU6c2VsZnVwZGF0ZS1maXh0dXJlLnR4dApKUVY2TFJtd2hldldNWkRwd3RZelJSZFNjbEtuRTdSNzQ4elZsek16TmVLczhQUXlndmhDMk9pVjdFU0lRZjcyeTdGdlM5TEtJSVoyY1o4MnN0cWxCUT09Cg==";
    const TEST_BYTES: &[u8] = b"Eclipse Client update fixture 1.1.1\n";

    #[test]
    fn accepts_a_signature_from_the_matching_key() {
        assert!(verify_with_key(TEST_BYTES, TEST_SIGNATURE, TEST_PUBKEY).is_ok());
    }

    #[test]
    fn rejects_tampered_bytes_and_wrong_keys() {
        let mut tampered = TEST_BYTES.to_vec();
        tampered.push(b'!');
        assert!(verify_with_key(&tampered, TEST_SIGNATURE, TEST_PUBKEY).is_err());
        assert!(verify_with_key(TEST_BYTES, TEST_SIGNATURE, UPDATE_PUBKEY).is_err());
        assert!(verify_signature(TEST_BYTES, "not a signature").is_err());
    }

    #[test]
    fn manifest_requires_https_and_a_signature() {
        let good = json!({
            "version": "1.2.0",
            "url": "https://github.com/SorroK/eclipse-client/releases/download/v1.2.0/eclipse-client.exe",
            "signature": TEST_SIGNATURE,
            "sha256": "ABCDEF",
            "notes": "Fixes things."
        });
        let parsed = parse_manifest(&good).expect("manifest should parse");
        assert_eq!(parsed.version, "1.2.0");
        assert_eq!(parsed.sha256, "abcdef");
        assert_eq!(parsed.notes, "Fixes things.");

        let insecure = json!({
            "version": "1.2.0",
            "url": "http://example.com/eclipse-client.exe",
            "signature": "x"
        });
        assert!(parse_manifest(&insecure).is_err());

        let unsigned = json!({
            "version": "1.2.0",
            "url": "https://example.com/eclipse-client.exe"
        });
        assert!(parse_manifest(&unsigned).is_err());

        let unversioned = json!({
            "url": "https://example.com/eclipse-client.exe",
            "signature": "x"
        });
        assert!(parse_manifest(&unversioned).is_err());
    }

    #[test]
    fn swaps_the_executable_and_restores_it_when_the_move_fails() {
        let directory = std::env::temp_dir().join(format!(
            "eclipse-selfupdate-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).expect("temp directory");

        let live = directory.join("eclipse-client.exe");
        let staged = staged_path(&live).expect("staged path");
        assert_eq!(staged.file_name().unwrap(), "eclipse-client.exe.new");
        std::fs::write(&live, b"old build").expect("old build");
        std::fs::write(&staged, b"new build").expect("new build");

        swap_in_place(&live, &staged).expect("swap should succeed");
        assert_eq!(std::fs::read(&live).unwrap(), b"new build");
        assert_eq!(
            std::fs::read(directory.join("eclipse-client.exe.old")).unwrap(),
            b"old build"
        );
        assert!(!staged.exists());

        let missing = directory.join("eclipse-client.exe.new");
        assert!(swap_in_place(&live, &missing).is_err());
        assert_eq!(std::fs::read(&live).unwrap(), b"new build");

        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn compares_release_versions() {
        assert_eq!(
            crate::loaders::compare_versions("1.1.1", "1.1.0"),
            Ordering::Greater
        );
        assert_eq!(
            crate::loaders::compare_versions("1.1.0", "1.1.0"),
            Ordering::Equal
        );
        assert_eq!(
            crate::loaders::compare_versions("1.0.9", "1.1.0"),
            Ordering::Less
        );
    }
}
