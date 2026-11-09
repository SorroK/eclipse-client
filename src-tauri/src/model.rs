use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub selected_version: String,
    pub memory_mb: u64,
    pub custom_resolution: bool,
    pub resolution_width: u64,
    pub resolution_height: u64,
    pub java_path: String,
    pub game_dir: String,
    pub minimize_on_launch: bool,
    pub fast_launch: bool,
    pub performance_jvm: bool,
    pub theme: String,
    pub discord_rpc: bool,
    pub discord_client_id: String,
    pub modrinth_page_size: u64,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            selected_version: String::new(),
            memory_mb: 4096,
            custom_resolution: false,
            resolution_width: 1280,
            resolution_height: 720,
            java_path: String::new(),
            game_dir: String::new(),
            minimize_on_launch: false,
            fast_launch: true,
            performance_jvm: true,
            theme: "eclipse".into(),
            discord_rpc: true,
            discord_client_id: String::new(),
            modrinth_page_size: 20,
        }
    }
}

impl Settings {
    pub fn sanitize_theme(&mut self) {
        if !matches!(
            self.theme.as_str(),
            "eclipse" | "aurora" | "ember" | "daylight" | "midnight" | "frost" | "sakura" | "solar"
        ) {
            self.theme = "eclipse".into();
        }
    }

    pub fn sanitize_modrinth_page_size(&mut self) {
        if !matches!(self.modrinth_page_size, 20 | 50 | 100) {
            self.modrinth_page_size = 20;
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountRecord {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub name: String,
    pub uuid: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountView {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub name: String,
    pub uuid: String,
}

impl From<&AccountRecord> for AccountView {
    fn from(value: &AccountRecord) -> Self {
        Self {
            id: value.id.clone(),
            kind: value.kind.clone(),
            name: value.name.clone(),
            uuid: value.uuid.clone(),
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountsFile {
    pub selected_id: String,
    pub profiles: Vec<AccountRecord>,
}

impl Default for AccountsFile {
    fn default() -> Self {
        Self { selected_id: String::new(), profiles: Vec::new() }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountsView {
    pub selected_id: String,
    pub profiles: Vec<AccountView>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JavaInstallation {
    pub path: String,
    pub version: String,
    pub major: u32,
    pub vendor: String,
    pub arch: String,
    pub source: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JavaState {
    pub detecting: bool,
    pub installations: Vec<JavaInstallation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Default for JavaState {
    fn default() -> Self {
        Self { detecting: true, installations: Vec::new(), error: None }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledVersion {
    pub id: String,
    pub installed_at: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoaderDescriptor {
    pub version: String,
    #[serde(default)]
    pub stable: bool,
    #[serde(default)]
    pub recommended: bool,
    #[serde(default)]
    pub channel: String,
    #[serde(default)]
    pub installer_version: String,
    #[serde(default)]
    pub artifact: String,
    #[serde(default)]
    pub minimum_java: u32,
    #[serde(default)]
    pub maven: Value,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderDistances {
    #[serde(default = "default_render_distance")]
    pub item_frames: i32,
    #[serde(default = "default_render_distance")]
    pub players: i32,
    #[serde(default = "default_render_distance")]
    pub dropped_items: i32,
    #[serde(default = "default_render_distance")]
    pub armor_stands: i32,
}

impl Default for RenderDistances {
    fn default() -> Self {
        Self {
            item_frames: default_render_distance(),
            players: default_render_distance(),
            dropped_items: default_render_distance(),
            armor_stands: default_render_distance(),
        }
    }
}

impl RenderDistances {
    pub fn any(&self) -> bool {
        [self.item_frames, self.players, self.dropped_items, self.armor_stands]
            .iter()
            .any(|value| *value >= 0)
    }
}

fn default_render_distance() -> i32 {
    -1
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModpackRecord {
    pub id: String,
    pub name: String,
    #[serde(default = "modpack_kind")]
    pub kind: String,
    pub loader: String,
    pub loader_version: String,
    pub game_version: String,
    pub created_at: String,
    pub source: Value,
    #[serde(default = "essentials_enabled_default")]
    pub essentials_enabled: bool,
    #[serde(default)]
    pub render_distances: RenderDistances,
}

fn modpack_kind() -> String {
    "modpack".into()
}

fn essentials_enabled_default() -> bool {
    true
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ModpacksFile {
    pub instances: Vec<ModpackRecord>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentEntry {
    pub id: String,
    #[serde(default)]
    pub project_id: String,
    #[serde(default)]
    pub project_slug: String,
    pub project_title: String,
    pub project_type: String,
    #[serde(default)]
    pub version_id: String,
    #[serde(default)]
    pub version_number: String,
    pub file_name: String,
    pub path: String,
    #[serde(default)]
    pub icon_url: String,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub sha1: String,
    #[serde(default = "modrinth_source")]
    pub source: String,
    #[serde(default)]
    pub installed_at: String,
    #[serde(default)]
    pub dependencies: Vec<Value>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub bundle: String,
}

fn modrinth_source() -> String {
    "modrinth".into()
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ContentFile {
    #[serde(default)]
    pub entries: Vec<ContentEntry>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub time: String,
    pub source: String,
    pub level: String,
    pub line: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameState {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedLoaders {
    pub loaders: Vec<LoaderDescriptor>,
    pub fetched_at: i64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MrpackFile {
    pub path: String,
    pub downloads: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha1: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha512: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MrpackIndex {
    pub name: String,
    pub version_id: String,
    pub game_version: String,
    pub loader: String,
    pub loader_version: String,
    pub files: Vec<MrpackFile>,
}

impl Default for GameState {
    fn default() -> Self {
        Self {
            status: "idle".into(),
            pid: None,
            version_id: None,
            started_at: None,
            error: None,
        }
    }
}
