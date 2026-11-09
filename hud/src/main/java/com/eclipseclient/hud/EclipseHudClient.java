package com.eclipseclient.hud;

import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.rendering.v1.hud.HudElementRegistry;
import net.minecraft.resources.Identifier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public final class EclipseHudClient implements ClientModInitializer {
	public static final Logger LOGGER = LoggerFactory.getLogger("eclipse-hud");
	private static final Identifier HUD_ID = Identifier.fromNamespaceAndPath("eclipse-hud", "hud");

	@Override
	public void onInitializeClient() {
		EclipseHud.load();
		HudElementRegistry.addLast(HUD_ID, EclipseHud::render);
		ClientTickEvents.END_CLIENT_TICK.register(EclipseHud::tick);
		LOGGER.info("Eclipse HUD initialized");
	}
}
