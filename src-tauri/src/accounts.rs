use crate::model::{AccountRecord, AccountView};
use crate::util::{iso_now, offline_uuid, strip_ansi};
use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::Engine;
use serde_json::{json, Value};
use std::ffi::c_void;
use std::path::Path;

const CLIENT_ID: &str = "00000000402b5328";
const REDIRECT: &str = "https://login.live.com/oauth20_desktop.srf";

pub fn offline_record(name: &str) -> AccountRecord {
    let uuid = offline_uuid(name);
    AccountRecord {
        id: format!("offline-{}", uuid::Uuid::new_v4()),
        kind: "offline".into(),
        name: name.into(),
        uuid,
        secret: None,
        created_at: Some(iso_now()),
    }
}

pub fn normalize_name(name: &str) -> Result<String, String> {
    let value = name.trim();
    if value.len() < 3 || value.len() > 16 || !value.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err("Usernames must be 3–16 characters and use only letters, numbers, or underscores.".into());
    }
    Ok(value.to_string())
}

pub fn view(account: &AccountRecord) -> AccountView {
    AccountView::from(account)
}

#[repr(C)]
struct DataBlob {
    size: u32,
    data: *mut u8,
}

#[link(name = "crypt32")]
extern "system" {
    fn CryptProtectData(
        data_in: *const DataBlob,
        description: *const u16,
        entropy: *const DataBlob,
        reserved: *mut c_void,
        prompt: *mut c_void,
        flags: u32,
        data_out: *mut DataBlob,
    ) -> i32;
    fn CryptUnprotectData(
        data_in: *const DataBlob,
        description: *mut *mut u16,
        entropy: *const DataBlob,
        reserved: *mut c_void,
        prompt: *mut c_void,
        flags: u32,
        data_out: *mut DataBlob,
    ) -> i32;
}

#[link(name = "kernel32")]
extern "system" {
    fn LocalFree(ptr: *mut c_void) -> *mut c_void;
}

fn dpapi_encrypt(value: &str) -> Option<Vec<u8>> {
    let mut input = value.as_bytes().to_vec();
    let input_blob = DataBlob { size: input.len() as u32, data: input.as_mut_ptr() };
    let mut output = DataBlob { size: 0, data: std::ptr::null_mut() };
    let ok = unsafe {
        CryptProtectData(
            &input_blob,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            0,
            &mut output,
        )
    };
    if ok == 0 { return None; }
    let bytes = unsafe { std::slice::from_raw_parts(output.data, output.size as usize).to_vec() };
    unsafe { LocalFree(output.data as *mut c_void) };
    Some(bytes)
}

fn dpapi_decrypt_bytes(bytes: &[u8]) -> Option<Vec<u8>> {
    let mut input = bytes.to_vec();
    let input_blob = DataBlob { size: input.len() as u32, data: input.as_mut_ptr() };
    let mut output = DataBlob { size: 0, data: std::ptr::null_mut() };
    let ok = unsafe {
        CryptUnprotectData(
            &input_blob,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            0,
            &mut output,
        )
    };
    if ok == 0 { return None; }
    let bytes = unsafe { std::slice::from_raw_parts(output.data, output.size as usize).to_vec() };
    unsafe { LocalFree(output.data as *mut c_void) };
    Some(bytes)
}

fn dpapi_decrypt(bytes: &[u8]) -> Option<String> {
    String::from_utf8(dpapi_decrypt_bytes(bytes)?).ok()
}

fn chromium_master_key(data_root: &Path) -> Option<Vec<u8>> {
    let raw = std::fs::read_to_string(data_root.join("Local State")).ok()?;
    let local_state: Value = serde_json::from_str(&raw).ok()?;
    let encoded = local_state.pointer("/os_crypt/encrypted_key")?.as_str()?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(encoded).ok()?;
    let bytes = bytes.strip_prefix(b"DPAPI").unwrap_or(&bytes);
    dpapi_decrypt_bytes(bytes)
}

fn decrypt_chromium_v10(payload: &[u8], key: &[u8]) -> Option<String> {
    if payload.len() < 12 + 16 || key.len() != 32 {
        return None;
    }
    let cipher = Aes256Gcm::new_from_slice(key).ok()?;
    let plaintext = cipher.decrypt(Nonce::from_slice(&payload[..12]), &payload[12..]).ok()?;
    String::from_utf8(plaintext).ok()
}

pub fn encrypt_secret(value: &str) -> Result<String, String> {
    if let Some(encrypted) = dpapi_encrypt(value) {
        return Ok(format!("enc:{}", base64::engine::general_purpose::STANDARD.encode(encrypted)));
    }
    Ok(format!("b64:{}", base64::engine::general_purpose::STANDARD.encode(value.as_bytes())))
}

pub fn decrypt_secret(value: &str, data_root: Option<&Path>) -> Result<String, String> {
    if value.starts_with("enc:") {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&value[4..])
            .map_err(|_| "Could not read the encrypted Microsoft session.".to_string())?;
        if let Some(decrypted) = dpapi_decrypt(&bytes) {
            return Ok(decrypted);
        }
        if bytes.starts_with(b"v10") || bytes.starts_with(b"v11") {
            if let Some(key) = data_root.and_then(chromium_master_key) {
                if let Some(decrypted) = decrypt_chromium_v10(&bytes[3..], &key) {
                    return Ok(decrypted);
                }
            }
            if let Some(decrypted) = dpapi_decrypt(&bytes[3..]) {
                return Ok(decrypted);
            }
        }
        return Err("Your Microsoft session could not be decrypted. Sign in again.".into());
    }
    if value.starts_with("b64:") {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&value[4..])
            .map_err(|_| "Your Microsoft session is missing.".to_string())?;
        return String::from_utf8(bytes).map_err(|_| "Your Microsoft session is invalid.".into());
    }
    Err("Your Microsoft session is missing.".into())
}

pub struct MicrosoftProfile {
    pub name: String,
    pub uuid: String,
    pub access_token: String,
    pub refresh_token: String,
    pub xuid: String,
}

async fn token_request(http: &reqwest::Client, form: &[(&str, &str)]) -> Result<Value, String> {
    let response = http
        .post("https://login.live.com/oauth20_token.srf")
        .form(form)
        .send()
        .await
        .map_err(|e| format!("Could not reach Microsoft: {e}"))?;
    let value: Value = response.json().await.map_err(|e| e.to_string())?;
    if let Some(error) = value.get("error").and_then(Value::as_str) {
        return Err(format!("Microsoft sign-in failed: {error}"));
    }
    Ok(value)
}

async fn minecraft_from_ms_token(http: &reqwest::Client, ms: &Value) -> Result<MicrosoftProfile, String> {
    let access = ms.get("access_token").and_then(Value::as_str).ok_or("Microsoft did not return an access token.")?;
    let refresh = ms.get("refresh_token").and_then(Value::as_str).unwrap_or("").to_string();
    let xbox: Value = http
        .post("https://user.auth.xboxlive.com/user/authenticate")
        .json(&json!({
            "Properties": { "AuthMethod": "RPS", "SiteName": "user.auth.xboxlive.com", "RpsTicket": format!("d={access}") },
            "RelyingParty": "http://auth.xboxlive.com",
            "TokenType": "JWT"
        }))
        .send()
        .await
        .map_err(|e| format!("Could not reach Xbox Live: {e}"))?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let xbl = xbox.get("Token").and_then(Value::as_str).ok_or("Xbox Live did not return a token.")?;
    let xsts_response = http
        .post("https://xsts.auth.xboxlive.com/xsts/authorize")
        .json(&json!({
            "Properties": { "SandboxId": "RETAIL", "UserTokens": [xbl] },
            "RelyingParty": "rp://api.minecraftservices.com/",
            "TokenType": "JWT"
        }))
        .send()
        .await
        .map_err(|e| format!("Could not reach Xbox Live: {e}"))?;
    let xsts: Value = xsts_response.json().await.map_err(|e| e.to_string())?;
    if let Some(error) = xsts.get("XErr").and_then(Value::as_i64) {
        let message = match error {
            2148916233 => "This Microsoft account does not have an Xbox profile. Create one and try again.",
            2148916235 => "Xbox Live is not available in this account's country.",
            2148916238 => "A parent must approve this child account for Xbox Live.",
            _ => "This Microsoft account cannot sign in to Xbox Live.",
        };
        return Err(message.into());
    }
    let token = xsts.get("Token").and_then(Value::as_str).ok_or("Xbox Live did not return a security token.")?;
    let uhs = xsts
        .pointer("/DisplayClaims/xui/0/uhs")
        .and_then(Value::as_str)
        .ok_or("Xbox Live returned an incomplete security token.")?;
    let identity = format!("XBL3.0 x={uhs};{token}");
    let login: Value = http
        .post("https://api.minecraftservices.com/authentication/login_with_xbox")
        .json(&json!({ "identityToken": identity }))
        .send()
        .await
        .map_err(|e| format!("Could not reach Minecraft services: {e}"))?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let mc_token = login.get("access_token").and_then(Value::as_str).ok_or("Minecraft did not return an access token.")?;
    let profile_response = http
        .get("https://api.minecraftservices.com/minecraft/profile")
        .bearer_auth(mc_token)
        .send()
        .await
        .map_err(|e| format!("Could not reach Minecraft services: {e}"))?;
    let profile: Value = profile_response.json().await.map_err(|e| e.to_string())?;
    if profile.get("error").is_some() {
        return Err("This Microsoft account does not own Minecraft: Java Edition, or access was denied.".into());
    }
    let uuid = profile.get("id").and_then(Value::as_str).ok_or("Minecraft did not return a profile.")?;
    let name = profile.get("name").and_then(Value::as_str).unwrap_or("Minecraft Player");
    Ok(MicrosoftProfile {
        name: name.into(),
        uuid: uuid.into(),
        access_token: mc_token.into(),
        refresh_token: refresh,
        xuid: String::new(),
    })
}

pub async fn refresh_microsoft(http: &reqwest::Client, refresh_token: &str) -> Result<MicrosoftProfile, String> {
    let ms = token_request(http, &[
        ("client_id", CLIENT_ID),
        ("refresh_token", refresh_token),
        ("grant_type", "refresh_token"),
    ])
    .await?;
    minecraft_from_ms_token(http, &ms).await
}

pub async fn sign_in_microsoft(app: &tauri::AppHandle, http: &reqwest::Client) -> Result<(AccountRecord, Value), String> {
    let redirect = url::form_urlencoded::byte_serialize(REDIRECT.as_bytes()).collect::<String>();
    let auth_url = format!(
        "https://login.live.com/oauth20_authorize.srf?client_id={CLIENT_ID}&response_type=code&redirect_uri={redirect}&scope=XboxLive.signin%20offline_access&prompt=select_account&mkt=en-US"
    );
    let parsed = url::Url::parse(&auth_url).map_err(|e| e.to_string())?;
    use tauri::Manager;
    let label = "microsoft-auth";
    if let Some(existing) = app.get_webview_window(label) {
        let _ = existing.close();
    }
    let window = tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::External(parsed))
        .title("Sign in to Microsoft")
        .inner_size(520.0, 700.0)
        .min_inner_size(420.0, 560.0)
        .resizable(true)
        .build()
        .map_err(|e| e.to_string())?;

    let code = tauri::async_runtime::spawn_blocking(move || {
        for _ in 0..900 {
            std::thread::sleep(std::time::Duration::from_millis(250));
            if window.url().is_err() {
                return Err("Microsoft sign-in was cancelled.".to_string());
            }
            let Ok(url) = window.url() else { continue };
            let current = url.as_str();
            if current.starts_with(REDIRECT) {
                let query = url.query().unwrap_or("");
                let code = url::form_urlencoded::parse(query.as_bytes())
                    .find(|(key, _)| key == "code")
                    .map(|(_, value)| value.to_string());
                let _ = window.close();
                return code.ok_or_else(|| "Microsoft sign-in was cancelled.".to_string());
            }
        }
        let _ = window.close();
        Err("Microsoft sign-in timed out.".into())
    })
    .await
    .map_err(|e| e.to_string())??;

    let ms = token_request(http, &[
        ("client_id", CLIENT_ID),
        ("code", &code),
        ("grant_type", "authorization_code"),
        ("redirect_uri", REDIRECT),
    ])
    .await?;
    let profile = minecraft_from_ms_token(http, &ms).await?;
    let id = format!("msa-{}", profile.uuid);
    let record = AccountRecord {
        id,
        kind: "msa".into(),
        name: profile.name.clone(),
        uuid: profile.uuid.clone(),
        secret: Some(encrypt_secret(&profile.refresh_token)?),
        created_at: Some(iso_now()),
    };
    Ok((record, json!({
        "accessToken": profile.access_token,
        "name": profile.name,
        "uuid": profile.uuid
    })))
}

fn decode_profile_base64(value: &str) -> Option<Vec<u8>> {
    let mut normalized = value.trim().replace('-', "+").replace('_', "/");
    while normalized.len() % 4 != 0 {
        normalized.push('=');
    }
    base64::engine::general_purpose::STANDARD.decode(normalized).ok()
}

fn png_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 24 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" || &bytes[12..16] != b"IHDR" {
        return None;
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
    let height = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
    Some((width, height))
}

fn skin_texture_url(value: &str) -> Option<String> {
    let decoded = decode_profile_base64(value)?;
    let payload: Value = serde_json::from_slice(&decoded).ok()?;
    let mut parsed = url::Url::parse(payload.pointer("/textures/SKIN/url")?.as_str()?).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str()? != "textures.minecraft.net" {
        return None;
    }
    // Mojang still publishes http:// texture URLs; always download over TLS.
    parsed.set_scheme("https").ok()?;
    Some(parsed.to_string())
}

/// Fetches the official Mojang skin for a profile and returns it as a PNG data
/// URL. `Ok(None)` means the profile exists but has no custom skin yet.
pub async fn skin_data_url(http: &reqwest::Client, uuid: &str) -> Result<Option<String>, String> {
    let uuid = uuid::Uuid::parse_str(uuid.trim()).map_err(|_| "That profile has an invalid UUID.".to_string())?;
    let response = http
        .get(format!(
            "https://sessionserver.mojang.com/session/minecraft/profile/{}",
            uuid.simple()
        ))
        .send()
        .await
        .map_err(|error| format!("Could not reach Mojang: {error}"))?;
    if response.status() == reqwest::StatusCode::NO_CONTENT {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(format!("Mojang returned HTTP {} for that profile.", response.status().as_u16()));
    }
    let profile: Value = response
        .json()
        .await
        .map_err(|error| format!("Mojang returned an unreadable profile: {error}"))?;
    let Some(property) = profile
        .get("properties")
        .and_then(Value::as_array)
        .and_then(|properties| {
            properties
                .iter()
                .find(|property| property.get("name").and_then(Value::as_str) == Some("textures"))
        })
        .and_then(|property| property.get("value").and_then(Value::as_str))
    else {
        return Ok(None);
    };
    let Some(texture) = skin_texture_url(property) else {
        return Ok(None);
    };
    let response = http
        .get(texture)
        .send()
        .await
        .map_err(|error| format!("Could not download the skin: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("The skin server returned HTTP {}.", response.status().as_u16()));
    }
    if response.content_length().unwrap_or(0) > 1_048_576 {
        return Err("That skin file is too large.".into());
    }
    let bytes = response.bytes().await.map_err(|error| format!("Could not read the skin: {error}"))?;
    if bytes.len() > 1_048_576 {
        return Err("That skin file is too large.".into());
    }
    match png_dimensions(&bytes) {
        Some((64, 64)) | Some((64, 32)) => {}
        _ => return Err("Mojang returned a skin that is not a 64x64 PNG.".into()),
    }
    Ok(Some(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )))
}

pub fn friendly_error(error: &str) -> String {
    let raw = strip_ansi(error);
    if raw.contains("error=access_denied") || raw.contains("cancelled") {
        "Microsoft sign-in was cancelled.".into()
    } else if raw.contains("invalid_grant") || raw.contains("AADSTS") {
        "Your Microsoft session has expired. Sign in with Microsoft again.".into()
    } else {
        raw
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encode_textures(value: Value) -> String {
        base64::engine::general_purpose::STANDARD.encode(value.to_string())
    }

    fn png_header(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = vec![0u8; 33];
        bytes[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        bytes[8..12].copy_from_slice(&13u32.to_be_bytes());
        bytes[12..16].copy_from_slice(b"IHDR");
        bytes[16..20].copy_from_slice(&width.to_be_bytes());
        bytes[20..24].copy_from_slice(&height.to_be_bytes());
        bytes
    }

    #[test]
    fn reads_png_dimensions() {
        assert_eq!(png_dimensions(&png_header(64, 64)), Some((64, 64)));
        assert_eq!(png_dimensions(&png_header(64, 32)), Some((64, 32)));
        assert_eq!(png_dimensions(b"not a png"), None);
    }

    #[test]
    fn decodes_official_skin_url() {
        let encoded = encode_textures(json!({
            "textures": {
                "SKIN": { "url": "http://textures.minecraft.net/texture/abcd" },
                "CAPE": { "url": "http://textures.minecraft.net/texture/cape" }
            }
        }));
        assert_eq!(
            skin_texture_url(&encoded).as_deref(),
            Some("https://textures.minecraft.net/texture/abcd")
        );
        assert_eq!(skin_texture_url("not base64"), None);
    }

    #[test]
    fn rejects_foreign_or_missing_skin_urls() {
        let foreign = encode_textures(json!({
            "textures": { "SKIN": { "url": "https://example.com/skin.png" } }
        }));
        assert_eq!(skin_texture_url(&foreign), None);
        let cape_only = encode_textures(json!({
            "textures": { "CAPE": { "url": "https://textures.minecraft.net/texture/cape" } }
        }));
        assert_eq!(skin_texture_url(&cape_only), None);
    }

    #[tokio::test]
    #[ignore = "requires network access to Mojang"]
    async fn fetches_official_skin() {
        let http = reqwest::Client::new();
        let url = skin_data_url(&http, "069a79f444e94726a5befca90e38aaf5")
            .await
            .expect("skin lookup should succeed")
            .expect("the profile should have a skin");
        let encoded = url.trim_start_matches("data:image/png;base64,");
        let bytes = base64::engine::general_purpose::STANDARD.decode(encoded).expect("valid base64");
        assert!(matches!(png_dimensions(&bytes), Some((64, 64)) | Some((64, 32))));
    }
}
