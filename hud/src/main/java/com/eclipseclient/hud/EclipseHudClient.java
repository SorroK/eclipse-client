package com.eclipseclient.hud;

import com.mojang.blaze3d.platform.InputConstants;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.keybinding.v1.KeyBindingHelper;
import net.fabricmc.fabric.api.client.rendering.v1.hud.HudElementRegistry;
import net.minecraft.client.KeyMapping;
import net.minecraft.resources.Identifier;
import org.lwjgl.glfw.GLFW;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public final class EclipseHudClient implements ClientModInitializer {
	public static final Logger LOGGER = LoggerFactory.getLogger("eclipse-hud");
	private static final Identifier HUD_ID = Identifier.fromNamespaceAndPath("eclipse-hud", "hud");
	private static final KeyMapping.Category KEY_CATEGORY = KeyMapping.Category.register(
		Identifier.fromNamespaceAndPath("eclipse-hud", "main")
	);
	public static final KeyMapping OPEN_SETTINGS = KeyBindingHelper.registerKeyBinding(new KeyMapping(
		"key.eclipse-hud.open_settings",
		InputConstants.Type.KEYSYM,
		GLFW.GLFW_KEY_RIGHT_SHIFT,
		KEY_CATEGORY
	));

	@Override
	public void onInitializeClient() {
		EclipseHud.load();
		EclipseMotionBlur.initialize();
		HudElementRegistry.addLast(HUD_ID, EclipseHud::render);
		ClientTickEvents.END_CLIENT_TICK.register(EclipseHud::tick);
		LOGGER.info("Eclipse HUD initialized with Right Shift settings key");
	}
}
