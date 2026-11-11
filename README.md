# Eclipse Client

Eclipse Client is a Rust/Tauri Minecraft: Java Edition launcher for Windows. It preserves the original Eclipse Client interface, themes, data layout, accounts, and modpack workflow while replacing Electron and its JavaScript launcher engine with Rust.

![Eclipse Client](assets/icon.png)

Source and releases: [github.com/SorroK/eclipse-client](https://github.com/SorroK/eclipse-client)

## What it does

- Browses Mojang's official version manifest, including releases and snapshots.
- Installs the client, libraries, natives, logging config, asset index, and every collected asset directly from Mojang.
- Uses fast launch readiness checks or a deep library check, with tuned G1GC JVM flags.
- Detects Java from PATH, `JAVA_HOME`, common JDK folders, and Mojang runtimes, then selects the version each game build requires.
- Preserves offline profiles and existing Microsoft sessions. Microsoft refresh tokens encrypted by Electron are decrypted with the same DPAPI/Chromium AES-GCM scheme and re-encrypted for Rust.
- Shows the signed-in Microsoft account's own Minecraft head in the sidebar, play card, Settings, and account list, loaded from Mojang's official profile and skin services. Offline profiles and profiles without a custom skin keep their initials.
- Checks GitHub Releases for signed launcher updates on startup and installs them in place from **Settings → Launcher updates**.
- Creates isolated Fabric, Forge, and NeoForge modpacks. Forge and NeoForge use their official installer JARs.
- Imports Modrinth `.mrpack` files with SHA-1/SHA-512 verification and `overrides` / `client-overrides` extraction.
- Searches Modrinth for compatible mods, resource packs, and shaders, resolves required dependencies, and tracks files in `eclipse-content.json`.
- Bundles **Eclipse Essentials** into modpacks: Eclipse HUD (Eclipse's own overlay), Eclipse UI (Eclipse's own theme-matched loading and title-screen art), Armor HUD, Low Fire, Small Totem Pop, Freelook, Zoomify, AppleSkin, Mouse Tweaks, Controlling, BetterF3, and Jade. Each pack has an on/off switch; compatible jars are resolved from Modrinth for its loader and Minecraft version, except Eclipse HUD and Eclipse UI, which ship with the launcher.
- Sets separate per-entity render distances in blocks for item frames, players, dropped items, and armor stands through Entity View Distance on Fabric packs.
- Loads 20, 50, or 100 Modrinth results at a time; the choice is saved in settings.
- Streams launcher and game output into the existing console.
- Shows **Eclipse Client** in Discord Rich Presence while the launcher is open and while Minecraft is running.
- Keeps the Eclipse, Aurora, Ember, Midnight, Daylight, Frost, Sakura, and Solar themes and the “Minecraft Launchers Reimagined” home screen.
- Uses the same data folder as the previous launcher, so worlds, settings, accounts, and modpacks carry over.

Official Mojang versions remain vanilla. Mods, resource packs, and shaders are installed only into isolated modpacks.

## Eclipse Essentials

Eclipse Essentials is the built-in client QoL bundle for modpacks. It currently includes Eclipse HUD, Eclipse UI, Armor HUD, Low Fire, Small Totem Pop, Freelook, Zoomify, AppleSkin, Mouse Tweaks, Controlling, BetterF3, and Jade. Most items are third-party projects; the launcher resolves the newest compatible jars and resource packs from Modrinth for the selected pack. Eclipse HUD and Eclipse UI are different: they are Eclipse Client's own assets, built from the source in `hud/` and `tools/` and embedded in the launcher.

Essentials is enabled for each modpack by default. It installs on the first launch (or from **Content studio → Install now**) and can be switched off per pack. Turning it off removes only Essentials-managed files; shared dependency jars stay installed so unrelated mods are not broken. Low Fire, Small Totem Pop, and Eclipse UI are resource packs, so Eclipse also enables them in the pack's `options.txt`. Eclipse UI is installed in the variant matching the launcher theme.

## Eclipse HUD

Eclipse HUD is Eclipse Client's own client-only Fabric overlay. It shows FPS, coordinates, biome, dimension, and the current real time in a compact panel, with optional velocity-based, depth-reprojection motion blur. Press **Right Shift** in-game to open its owo-lib themed control center; every change is saved immediately. Change the key under **Options → Controls → Key Binds** in the **Eclipse HUD** category. The HUD is built for Minecraft 1.21.11 and is not offered on other versions or on Forge/NeoForge packs.

The settings screen is a themed control center with **HUD**, **PING**, and **BLUR** tabs. The HUD tab controls the HUD switch, panel position, each row, and the motion-blur master switch. The PING tab changes the ping shown in Minecraft's player list to any value from 0 to 1000 ms, with quick presets and a slider. This is a client-side display override: the server still sees the real network latency. The BLUR tab sets motion-blur strength from 0–100% and toggles **Include players**. With it on, the pass runs after the world render; with it off, it runs after opaque terrain and before entities, so the world blurs while players and other entities stay sharp. The same values live in the pack at `config/eclipse-hud.properties`, which is created with defaults the first time the mod loads. `position` accepts `top_left`, `top_right`, `bottom_left`, or `bottom_right`; the `show_*` keys control individual rows; `motion_blur`, `motion_blur_strength`, and `motion_blur_players` control the effect; and `ping_override` / `ping_value` control the displayed ping. The HUD itself stays sharp.

The source is in `hud/`. The launcher embeds the compiled jar from `src-tauri/assets/`, so a mod change requires rebuilding the jar and then the launcher. Loom requires JDK 25 for the build; the mod targets Java 21. Use the checked-in wrapper:

```bash
cd hud
./gradlew build
cp build/libs/eclipse-hud-1.1.0+1.21.11.jar ../src-tauri/assets/
```

## Eclipse UI

Eclipse UI is Eclipse Client's custom resource pack set for Minecraft 1.21.11. It replaces the Mojang loading mark with the Eclipse app icon and wordmark, swaps the title-screen logo for a full Eclipse Client lockup, hides the title-screen splash text, and gives the title screen a theme-colored panorama, logo, and edition mark. Each launcher theme has its own pack; Eclipse installs the matching variant into the pack's `resourcepacks` folder for Fabric, Forge, and NeoForge packs and enables it in `options.txt`. No mod loader is required. Changing the launcher theme updates the title screen on the next launch.

The packs are generated by `tools/build-eclipse-ui.py` into `src-tauri/assets/eclipse-ui-1.0.2-<theme>.zip`. They need Python 3 with Pillow and numpy. The launcher embeds all eight packs, so rebuild the launcher after changing them. Turning Eclipse UI off in Minecraft's Resource Packs screen restores vanilla art; Eclipse Essentials reinstalls the theme pack when the file is missing or the launcher theme changes.

## Per-entity render distances

Each modpack has a **Render distances** card in Content studio with separate values, in blocks, for item frames (including glowing frames), players, dropped items, and armor stands. Blank fields use the vanilla default; numeric values range from 0 to 512 blocks.

This is powered by [Entity View Distance](https://modrinth.com/mod/entity-view-distance), which Eclipse installs into the pack when needed and configures in client mode at `config/entity-view-distance.json`. Existing overrides for other entity types are preserved. The helper currently supports Fabric only, so the card is disabled on Forge and NeoForge packs. Values are client-side render limits; a server can still stop tracking an entity before the configured distance.

## Requirements

- Windows 10/11 with the WebView2 runtime (included with current Windows).
- Java 21 or newer for current Minecraft versions. Eclipse Client does not download Java yet.
- For development: Node.js 20+, npm, Rust, and the Tauri prerequisites.

## Run and build

```bash
npm install
npm run dev      # Tauri development window
npm run build    # release executable
npm run dist     # Windows NSIS installer
```

The installer is written under `src-tauri/target/release/bundle/nsis/`. The completed Rust installer is also copied to `dist/Eclipse Client Setup 1.1.1.exe`.

Building needs no signing key: the executable and installer are unsigned artifacts. Only publishing a release signs anything — the workflow signs the raw executable so installed launchers can verify it (see **Launcher updates**).

On Windows with the GNU Rust toolchain, a checkout path containing spaces breaks MinGW's resource compiler. Build from a path without spaces, or map the checkout to a temporary drive and use a MinGW installation whose own path also has no spaces.

## Launcher updates

Eclipse Client checks `https://github.com/SorroK/eclipse-client/releases/latest/download/latest-exe.json` shortly after launch and from **Settings → Launcher updates**. The manifest names the release version, the raw `eclipse-client.exe` download, its SHA-256, and a minisign signature. When a newer release exists, the card shows its version and notes; **Update now** downloads that executable, checks the checksum, verifies the signature against the public key pinned in `src-tauri/src/selfupdate.rs`, renames the running launcher to `eclipse-client.exe.old`, puts the new build at the same path, and restarts. No installer runs and no NSIS window appears; the leftover `.old` file is deleted the next time the launcher starts. Set `ECLIPSE_CLIENT_UPDATE_MANIFEST` to point at another manifest while testing.

Only builds signed with the matching private key are accepted. The private key and its password belong in `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`; never commit them. Losing the key means existing installations cannot receive future updates.

Releases are built and published by `.github/workflows/release.yml` when a version tag is pushed:

```bash
git tag v1.1.1
git push origin v1.1.1
```

The workflow builds on Windows, publishes the NSIS installer for new installs, then signs the raw executable, writes `latest-exe.json`, and uploads the executable, its `.sig`, and the manifest to the GitHub Release.

## Data locations

| What | Where |
| --- | --- |
| Settings and accounts | `%APPDATA%\Eclipse Client\settings.json`, `accounts.json` |
| Minecraft libraries/assets/versions | `%APPDATA%\Eclipse Client\minecraft` |
| Modpacks and content | `%APPDATA%\Eclipse Client\instances\<modpack-id>` |
| Modpack registry | `%APPDATA%\Eclipse Client\modpacks.json` |
| Launcher cache | `%APPDATA%\Eclipse Client\cache` |

Set `ECLIPSE_CLIENT_DATA_DIR` to use another launcher data folder.

## Discord Rich Presence

Discord needs an application ID before it can show Eclipse Client's activity:

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and create an application named **Eclipse Client**.
2. Copy its **Application ID** (not the OAuth client secret).
3. In Eclipse Client, open **Settings → Discord Rich Presence**, paste the ID, and press **Save**.

Discord takes the display name from the registered application, so the profile card reads Eclipse Client. Presence updates automatically: the launcher line appears while Eclipse is open, and the selected version or modpack plus elapsed play time appear while Minecraft is running. Eclipse keeps retrying in the background if Discord is closed or restarted. Set `ECLIPSE_DISCORD_CLIENT_ID` to override the saved ID while testing.

## Rust architecture

- `src-tauri/src/main.rs` — Tauri entry point, window events, and smoke-test modes.
- `src-tauri/src/backend.rs` — single `launcher` command and the complete renderer-facing action surface.
- `src-tauri/src/runtime.rs` — persistent settings, accounts, manifest cache, install/Java/modpack state, and events.
- `src-tauri/src/selfupdate.rs` — signed GitHub Releases update checks, verified executable download, and the in-place launcher swap that removes the need for an installer.
- `src-tauri/src/accounts.rs` — offline UUIDs, Microsoft OAuth/Xbox/Minecraft flow, DPAPI, and Electron `safeStorage` compatibility.
- `src-tauri/src/installer.rs` — metadata resolution, verified concurrent downloads, natives, legacy assets, and completion markers.
- `src-tauri/src/launch.rs` — rule evaluation, classpath/natives/argument generation, Java selection, process tracking, and stop.
- `src-tauri/src/discord.rs` — Discord IPC handshake, Rich Presence worker, and reconnect handling.
- `src-tauri/src/loaders.rs` — Fabric metadata, Forge/NeoForge version discovery, official installers, and metadata merging.
- `src-tauri/src/modpacks.rs` — pack creation, `.mrpack` import, Modrinth/local content installation and removal, and pack deletion.
- `src-tauri/src/essentials.rs` — Eclipse Essentials resolution plus the embedded Eclipse HUD and Eclipse UI install paths.
- `hud/` — source for the custom Eclipse HUD Fabric mod.
- `tools/build-eclipse-ui.py` — generates the theme-specific Minecraft loading and title-screen resource packs.
- `src-tauri/src/modrinth.rs` — search, projects, versions, dependencies, and trusted downloads.
- `src-tauri/src/render.rs` — per-entity render distances, Entity View Distance installation, and config merge/clear.
- `src-tauri/src/java.rs` — Java discovery, probing, parsing, and selection.
- `src-tauri/src/paths.rs`, `model.rs`, `store.rs`, `util.rs`, `rules.rs` — data layout, compatibility models, atomic JSON, downloads/checksums, and Mojang rules.
- `src/renderer/` — the original dependency-free HTML/CSS/JS interface.
- `src/renderer/tauri-bridge.js` — keeps `window.eclipseClient` compatible with the existing renderer.

The old JavaScript engine remains under `src/main/` and `src/core/` as a migration reference only; the shipped application is Rust.

## Verification

```bash
# UI parity, using the existing app data and the Tauri bridge
ECLIPSE_CLIENT_SMOKE_UI=1 src-tauri/target/debug/eclipse-client.exe

# Deep-check an installed version, refresh the selected account, launch, then stop
ECLIPSE_CLIENT_TEST_LAUNCH=1.21.11 src-tauri/target/debug/eclipse-client.exe

# Create a Fabric pack in a clean data folder
ECLIPSE_CLIENT_DATA_DIR=.tmp/modpack-test \
ECLIPSE_CLIENT_TEST_MODPACK=fabric:1.21.11 \
src-tauri/target/debug/eclipse-client.exe
```

The JavaScript unit tests can still be run with `npm test`; they cover shared Minecraft parsing and safety rules from the original engine. Rust tests use `cargo test` from `src-tauri/`.

Minecraft is a trademark of Mojang Synergies AB. Eclipse Client is an unofficial project and is not affiliated with Mojang or Microsoft.
