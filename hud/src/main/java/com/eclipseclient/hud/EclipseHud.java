package com.eclipseclient.hud;

import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.client.DeltaTracker;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.core.Holder;
import net.minecraft.resources.ResourceKey;
import net.minecraft.world.level.biome.Biome;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Properties;

public final class EclipseHud {
	private static final DateTimeFormatter CLOCK = DateTimeFormatter.ofPattern("HH:mm");
	private static final Path CONFIG = FabricLoader.getInstance().getConfigDir().resolve("eclipse-hud.properties");
	private static final int MAX_PING = 1000;

	private static boolean loaded;
	private static boolean enabled = true;
	private static boolean showFps = true;
	private static boolean showCoordinates = true;
	private static boolean showBiome = true;
	private static boolean showDimension = true;
	private static boolean showClock = true;
	private static boolean motionBlur = false;
	private static int motionBlurStrength = 50;
	private static boolean motionBlurPlayers = true;
	private static boolean pingOverride = false;
	private static int pingValue = 120;
	private static String position = "top_left";

	private EclipseHud() {
	}

	public static void load() {
		if (loaded) {
			return;
		}
		loaded = true;
		if (!Files.isRegularFile(CONFIG)) {
			save();
			return;
		}
		Properties properties = new Properties();
		try (InputStream input = Files.newInputStream(CONFIG)) {
			properties.load(input);
		} catch (IOException error) {
			EclipseHudClient.LOGGER.warn("Could not read {}", CONFIG, error);
			return;
		}
		enabled = readBoolean(properties, "enabled", true);
		showFps = readBoolean(properties, "show_fps", true);
		showCoordinates = readBoolean(properties, "show_coordinates", true);
		showBiome = readBoolean(properties, "show_biome", true);
		showDimension = readBoolean(properties, "show_dimension", true);
		showClock = readBoolean(properties, "show_clock", true);
		motionBlur = readBoolean(properties, "motion_blur", false);
		motionBlurStrength = readInt(properties, "motion_blur_strength", 50, 0, 100);
		motionBlurPlayers = readBoolean(properties, "motion_blur_players", true);
		pingOverride = readBoolean(properties, "ping_override", false);
		pingValue = readInt(properties, "ping_value", 120, 0, MAX_PING);
		position = normalizePosition(properties.getProperty("position", "top_left"));
		if (!properties.containsKey("ping_override")
			|| !properties.containsKey("ping_value")
			|| !properties.containsKey("motion_blur_strength")
			|| !properties.containsKey("motion_blur_players")) {
			save();
		}
	}

	private static boolean readBoolean(Properties properties, String key, boolean fallback) {
		String value = properties.getProperty(key);
		return value == null ? fallback : Boolean.parseBoolean(value.trim());
	}

	private static int readInt(Properties properties, String key, int fallback, int min, int max) {
		String value = properties.getProperty(key);
		if (value == null) {
			return fallback;
		}
		try {
			return Math.max(min, Math.min(max, Integer.parseInt(value.trim())));
		} catch (NumberFormatException ignored) {
			return fallback;
		}
	}

	private static String normalizePosition(String value) {
		return switch (value == null ? "" : value.trim().toLowerCase(Locale.ROOT)) {
			case "top_right", "bottom_left", "bottom_right" -> value.trim().toLowerCase(Locale.ROOT);
			default -> "top_left";
		};
	}

	public static boolean isEnabled() {
		return enabled;
	}

	public static void setEnabled(boolean value) {
		enabled = value;
	}

	public static boolean showFps() {
		return showFps;
	}

	public static void setShowFps(boolean value) {
		showFps = value;
	}

	public static boolean showCoordinates() {
		return showCoordinates;
	}

	public static void setShowCoordinates(boolean value) {
		showCoordinates = value;
	}

	public static boolean showBiome() {
		return showBiome;
	}

	public static void setShowBiome(boolean value) {
		showBiome = value;
	}

	public static boolean showDimension() {
		return showDimension;
	}

	public static void setShowDimension(boolean value) {
		showDimension = value;
	}

	public static boolean showClock() {
		return showClock;
	}

	public static void setShowClock(boolean value) {
		showClock = value;
	}

	public static boolean motionBlur() {
		return motionBlur;
	}

	public static void setMotionBlur(boolean value) {
		motionBlur = value;
		EclipseMotionBlur.onSettingChanged();
	}

	public static int motionBlurStrength() {
		return motionBlurStrength;
	}

	public static void setMotionBlurStrength(int value) {
		motionBlurStrength = Math.max(0, Math.min(100, value));
	}

	public static boolean motionBlurPlayers() {
		return motionBlurPlayers;
	}

	public static void setMotionBlurPlayers(boolean value) {
		if (motionBlurPlayers != value) {
			motionBlurPlayers = value;
			EclipseMotionBlur.onSettingChanged();
		}
	}

	public static boolean pingOverride() {
		if (!loaded) {
			load();
		}
		return pingOverride;
	}

	public static void setPingOverride(boolean value) {
		pingOverride = value;
	}

	public static int pingValue() {
		return pingValue;
	}

	public static void setPingValue(int value) {
		pingValue = Math.max(0, Math.min(MAX_PING, value));
	}

	public static String position() {
		return position;
	}

	public static void cyclePosition() {
		position = switch (position) {
			case "top_left" -> "top_right";
			case "top_right" -> "bottom_right";
			case "bottom_right" -> "bottom_left";
			default -> "top_left";
		};
	}

	public static void save() {
		Properties properties = new Properties();
		properties.setProperty("enabled", Boolean.toString(enabled));
		properties.setProperty("position", position);
		properties.setProperty("show_fps", Boolean.toString(showFps));
		properties.setProperty("show_coordinates", Boolean.toString(showCoordinates));
		properties.setProperty("show_biome", Boolean.toString(showBiome));
		properties.setProperty("show_dimension", Boolean.toString(showDimension));
		properties.setProperty("show_clock", Boolean.toString(showClock));
		properties.setProperty("motion_blur", Boolean.toString(motionBlur));
		properties.setProperty("motion_blur_strength", Integer.toString(motionBlurStrength));
		properties.setProperty("motion_blur_players", Boolean.toString(motionBlurPlayers));
		properties.setProperty("ping_override", Boolean.toString(pingOverride));
		properties.setProperty("ping_value", Integer.toString(pingValue));
		try {
			Files.createDirectories(CONFIG.getParent());
			try (OutputStream output = Files.newOutputStream(CONFIG)) {
				properties.store(output, "Eclipse HUD settings - open with Right Shift");
			}
		} catch (IOException error) {
			EclipseHudClient.LOGGER.warn("Could not write {}", CONFIG, error);
		}
	}

	public static void tick(Minecraft client) {
		if (!loaded) {
			load();
		}
		while (EclipseHudClient.OPEN_SETTINGS.consumeClick()) {
			if (client.screen == null && client.player != null) {
				client.setScreen(new EclipseHudScreen());
			}
		}
	}

	public static void render(GuiGraphics context, DeltaTracker tickCounter) {
		if (!loaded) {
			load();
		}
		if (!enabled) {
			return;
		}
		Minecraft client = Minecraft.getInstance();
		if (client.player == null || client.level == null || client.options.hideGui) {
			return;
		}

		int accent = EclipseTheme.accent();
		int accentDark = EclipseTheme.accentDark();
		int label = EclipseTheme.muted();
		int value = EclipseTheme.text();
		boolean light = EclipseTheme.isLight();

		List<Line> lines = new ArrayList<>();
		if (showFps) {
			int fps = client.getFps();
			int color = fps >= 120
				? (light ? 0xFF137A46 : 0xFF8EF0B0)
				: fps >= 60
					? (light ? 0xFF8A6200 : 0xFFE8D98A)
					: fps >= 30
						? (light ? 0xFFA24F00 : 0xFFFFB86B)
						: (light ? 0xFFA62B2B : 0xFFFF7A7A);
			lines.add(new Line("FPS", Integer.toString(fps), color));
		}
		if (showCoordinates) {
			lines.add(new Line("XYZ", String.format(Locale.ROOT, "%.1f  %.1f  %.1f",
				client.player.getX(), client.player.getY(), client.player.getZ()), value));
		}
		if (showBiome) {
			Holder<Biome> biome = client.level.getBiome(client.player.blockPosition());
			String name = biome.unwrapKey()
				.map(ResourceKey::identifier)
				.map(identifier -> pretty(identifier.getPath()))
				.orElse("Unknown");
			lines.add(new Line("BIOME", name, accent));
		}
		if (showDimension) {
			lines.add(new Line("DIM", pretty(client.level.dimension().identifier().getPath()),
				light ? 0xFF245F9C : 0xFF9CC8FF));
		}
		if (showClock) {
			lines.add(new Line("TIME", LocalTime.now().format(CLOCK),
				light ? 0xFF8A5A00 : 0xFFE8D98A));
		}
		if (lines.isEmpty()) {
			return;
		}

		Font font = client.font;
		int labelWidth = 0;
		int valueWidth = 0;
		for (Line line : lines) {
			labelWidth = Math.max(labelWidth, font.width(line.label()));
			valueWidth = Math.max(valueWidth, font.width(line.value()));
		}

		int panelWidth = Math.max(font.width("ECLIPSE HUD"), labelWidth + 8 + valueWidth) + 16;
		int panelHeight = 26 + lines.size() * 10;
		int screenWidth = client.getWindow().getGuiScaledWidth();
		int screenHeight = client.getWindow().getGuiScaledHeight();
		int x = 6;
		int y = 6;
		if (position.endsWith("right")) {
			x = screenWidth - panelWidth - 6;
		}
		if (position.startsWith("bottom")) {
			y = screenHeight - panelHeight - 6;
		}

		context.fill(x + 1, y + 1, x + panelWidth + 1, y + panelHeight + 1, 0x55000000);
		context.fill(x, y, x + panelWidth, y + panelHeight, EclipseTheme.panelOverlay());
		context.fill(x, y, x + panelWidth, y + 1, accent);
		context.fill(x, y, x + 2, y + panelHeight, accentDark);
		context.drawString(font, "ECLIPSE HUD", x + 8, y + 6, EclipseTheme.accentBright(), true);
		context.fill(x + 8, y + 17, x + panelWidth - 8, y + 18, EclipseTheme.softAccent(0x44));

		int rowY = y + 22;
		for (Line line : lines) {
			context.drawString(font, line.label(), x + 8, rowY, label, true);
			context.drawString(font, line.value(), x + 8 + labelWidth + 8, rowY, line.color(), true);
			rowY += 10;
		}
	}

	private static String pretty(String raw) {
		StringBuilder result = new StringBuilder();
		for (String part : raw.split("_")) {
			if (part.isEmpty()) {
				continue;
			}
			if (!result.isEmpty()) {
				result.append(' ');
			}
			result.append(Character.toUpperCase(part.charAt(0))).append(part.substring(1));
		}
		return result.isEmpty() ? "Unknown" : result.toString();
	}

	private record Line(String label, String value, int color) {
	}
}
