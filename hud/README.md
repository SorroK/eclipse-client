# Eclipse HUD

Eclipse HUD is Eclipse Client's custom, client-only Minecraft HUD. It is not a
Modrinth dependency and is not a fork of another HUD mod.

It displays:

- FPS, colored by framerate
- Player coordinates
- Biome
- Dimension
- Current real-world time
- Armor durability for every equipped piece, as a themed bar and percentage
- Optional velocity-based, depth-reprojection motion blur

The panel is drawn in the top-left by default. The armor strip sits centered
just above the hotbar and only appears while armor is equipped. Press **Right
Shift** in-game to
open the themed control center. The key can be rebound under **Options →
Controls → Key Binds** in the **Eclipse HUD** category. The control center
follows the launcher's selected theme and includes **PING** and **BLUR** tabs.
The PING tab changes the ping shown in Minecraft's player list; the BLUR tab
controls motion-blur strength and whether players are included in the blur.

## Configuration

The **HUD** tab controls:

- Whether the HUD is enabled
- Which corner the panel uses
- Whether each row is shown (FPS, coordinates, biome, dimension, clock)
- Whether the armor strip and its durability percentages are shown
- Whether motion blur is enabled

The **PING** tab controls the displayed ping (0–1000 ms) with a toggle, slider,
and presets. It only changes the number shown in the player list; actual server
latency and hit registration are unchanged.

The **BLUR** tab controls:

- The motion-blur master switch
- Strength from 0–100%
- Whether players are included in the blur

With **Include players** off, the blur runs after opaque terrain and before the
entity pass. The world blurs while players and other entities stay sharp.

Changes save immediately. The same values live in
`config/eclipse-hud.properties`:

```properties
enabled=true
position=top_left
show_fps=true
show_coordinates=true
show_biome=true
show_dimension=true
show_clock=true
armor_hud=true
armor_hud_numbers=true
motion_blur=false
motion_blur_strength=50
motion_blur_players=true
ping_override=false
ping_value=120
```

`position` accepts `top_left`, `top_right`, `bottom_left`, or `bottom_right`.
Set any `show_*` key to `false` to hide that row. `armor_hud` toggles the armor
strip, and `armor_hud_numbers` toggles the percentages under each piece.
`motion_blur` enables the
effect, `motion_blur_strength` is 0–100, and `motion_blur_players` controls
whether players are part of the blurred scene. The HUD itself stays sharp.
`ping_override` enables the displayed-ping override and `ping_value` is the
number shown, clamped to 0–1000 ms. The file is created with defaults the first
time the mod loads.

## Compatibility and installation

The current build targets Fabric and Minecraft 1.21.11. Eclipse Client only
offers it for those packs and installs Fabric API first if the pack does not
already have it. owo-lib is embedded in the HUD jar, so the control center works
without installing a second mod. The jar is installed and tracked as Essentials
content, so turning Essentials off removes it.

## Build

The Gradle wrapper is checked in. Fabric Loom 1.19.1 requires JDK 25 to run the
build; the mod itself targets Java 21.

```bash
./gradlew build
```

The remapped jar is written to `build/libs/eclipse-hud-1.1.1+1.21.11.jar`.
Copy it to `../src-tauri/assets/` before rebuilding the launcher; the launcher
embeds that exact file with `include_bytes!`.

## Behavior notes

- The key only opens the screen in-game, so inventory or chat input cannot
  trigger it.
- `hideGui` (F1) hides the HUD through Minecraft's normal HUD rendering.
- Motion blur is a client-side depth-reprojection pass. The control center is
  built with owo-lib, which is embedded in the HUD jar.
- With **Include players** on, the pass runs after the world render. With it off,
  it runs after opaque terrain and before entities. The HUD and first-person
  hand stay sharp.
- VulkanMod cannot sample the main depth attachment, so the shader falls back
  to camera-motion blur on that backend.
- The server can still limit entity tracking, but this HUD only reads local
  client state.
