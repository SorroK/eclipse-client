package com.eclipseclient.hud;

import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.client.DeltaTracker;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.core.Holder;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.ResourceKey;
import net.minecraft.world.level.biome.Biome;
import org.lwjgl.glfw.GLFW;

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
	private static final int ACCENT = 0xFF8A6CFF;
	private static final int ACCENT_DARK = 0xFF5A46C8;
	private static final int LABEL = 0xFF8B93A7;
	private static final int VALUE = 0xFFF2F5FF;

	private static boolean loaded;
	private static boolean enabled = true;
	private static boolean showFps = true;
	private static boolean showCoordinates = true;
	private static boolean showBiome = true;
	private static boolean showDimension = true;
	private static boolean showClock = true;
	private static String position = "top_left";
	private static boolean toggleHeld;

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
		position = normalizePosition(properties.getProperty("position", "top_left"));
	}

	private static boolean readBoolean(Properties properties, String key, boolean fallback) {
		String value = properties.getProperty(key);
		return value == null ? fallback : Boolean.parseBoolean(value.trim());
	}

	private static String normalizePosition(String value) {
		return switch (value == null ? "" : value.trim().toLowerCase(Locale.ROOT)) {
			case "top_right", "bottom_left", "bottom_right" -> value.trim().toLowerCase(Locale.ROOT);
			default -> "top_left";
		};
	}

	private static void save() {
		Properties properties = new Properties();
		properties.setProperty("enabled", Boolean.toString(enabled));
		properties.setProperty("position", position);
		properties.setProperty("show_fps", Boolean.toString(showFps));
		properties.setProperty("show_coordinates", Boolean.toString(showCoordinates));
		properties.setProperty("show_biome", Boolean.toString(showBiome));
		properties.setProperty("show_dimension", Boolean.toString(showDimension));
		properties.setProperty("show_clock", Boolean.toString(showClock));
		try {
			Files.createDirectories(CONFIG.getParent());
			try (OutputStream output = Files.newOutputStream(CONFIG)) {
				properties.store(output, "Eclipse HUD - toggle with F6");
			}
		} catch (IOException error) {
			EclipseHudClient.LOGGER.warn("Could not write {}", CONFIG, error);
		}
	}

	public static void tick(Minecraft client) {
		if (!loaded) {
			load();
		}
		if (client.screen != null) {
			toggleHeld = false;
			return;
		}
		boolean down = GLFW.glfwGetKey(client.getWindow().handle(), GLFW.GLFW_KEY_F6) == GLFW.GLFW_PRESS;
		if (down && !toggleHeld) {
			enabled = !enabled;
			save();
			if (client.player != null) {
				client.player.displayClientMessage(Component.literal("Eclipse HUD " + (enabled ? "on" : "off")), true);
			}
		}
		toggleHeld = down;
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

		List<Line> lines = new ArrayList<>();
		if (showFps) {
			int fps = client.getFps();
			int color = fps >= 120 ? 0xFF8EF0B0 : fps >= 60 ? 0xFFE8D98A : fps >= 30 ? 0xFFFFB86B : 0xFFFF7A7A;
			lines.add(new Line("FPS", Integer.toString(fps), color));
		}
		if (showCoordinates) {
			lines.add(new Line("XYZ", String.format(Locale.ROOT, "%.1f  %.1f  %.1f",
				client.player.getX(), client.player.getY(), client.player.getZ()), VALUE));
		}
		if (showBiome) {
			Holder<Biome> biome = client.level.getBiome(client.player.blockPosition());
			String name = biome.unwrapKey()
				.map(ResourceKey::identifier)
				.map(identifier -> pretty(identifier.getPath()))
				.orElse("Unknown");
			lines.add(new Line("BIOME", name, 0xFF9FE8C4));
		}
		if (showDimension) {
			lines.add(new Line("DIM", pretty(client.level.dimension().identifier().getPath()), 0xFF9CC8FF));
		}
		if (showClock) {
			lines.add(new Line("TIME", LocalTime.now().format(CLOCK), 0xFFE8D98A));
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
		context.fill(x, y, x + panelWidth, y + panelHeight, 0xD20A0D14);
		context.fill(x, y, x + panelWidth, y + 1, ACCENT);
		context.fill(x, y, x + 2, y + panelHeight, ACCENT_DARK);
		context.drawString(font, "ECLIPSE HUD", x + 8, y + 6, 0xFFCBAEFF, true);
		context.fill(x + 8, y + 17, x + panelWidth - 8, y + 18, 0x445A46C8);

		int rowY = y + 22;
		for (Line line : lines) {
			context.drawString(font, line.label(), x + 8, rowY, LABEL, true);
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
