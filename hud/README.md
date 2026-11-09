# Eclipse HUD

Eclipse HUD is Eclipse Client's custom, client-only Minecraft HUD. It is not a
Modrinth dependency and is not a fork of another HUD mod.

It displays:

- FPS, colored by framerate
- Player coordinates
- Biome
- Dimension
- Current real-world time

The panel is drawn in the top-left by default. Press **F6** in-game to toggle it.

## Configuration

The first launch creates `config/eclipse-hud.properties`:

```properties
enabled=true
position=top_left
show_fps=true
show_coordinates=true
show_biome=true
show_dimension=true
show_clock=true
```

`position` accepts `top_left`, `top_right`, `bottom_left`, or `bottom_right`.
Set any `show_*` key to `false` to hide that row. The F6 toggle writes the
`enabled` value back to disk.

## Compatibility and installation

The current build targets Fabric and Minecraft 1.21.11. Eclipse Client only
offers it for those packs and installs Fabric API first if the pack does not
already have it. The jar is installed and tracked as Essentials content, so
turning Essentials off removes it.

## Build

The Gradle wrapper is checked in. Fabric Loom 1.19.1 requires JDK 25 to run the
build; the mod itself targets Java 21.

```bash
./gradlew build
```

The remapped jar is written to `build/libs/eclipse-hud-1.0.0+1.21.11.jar`.
Copy it to `../src-tauri/assets/` before rebuilding the launcher; the launcher
embeds that exact file with `include_bytes!`.

## Behavior notes

- The HUD is skipped while a screen is open for the F6 key check, so inventory
  or chat input cannot trigger it.
- `hideGui` (F1) hides the HUD through Minecraft's normal HUD rendering.
- The server can still limit entity tracking, but this HUD only reads local
  client state.
