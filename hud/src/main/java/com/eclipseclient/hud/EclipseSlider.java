package com.eclipseclient.hud;

import io.wispforest.owo.ui.component.SliderComponent;
import io.wispforest.owo.ui.core.Sizing;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.network.chat.Component;

public final class EclipseSlider extends SliderComponent {
	public EclipseSlider(Sizing horizontalSizing) {
		super(horizontalSizing);
		sizing(horizontalSizing, Sizing.fixed(22));
		scrollStep(0.02);
	}

	@Override
	public void renderWidget(GuiGraphics context, int mouseX, int mouseY, float delta) {
		int x = getX();
		int y = getY();
		int width = getWidth();
		boolean hover = isHovered();
		boolean enabled = active();
		int trackY = y + 4;
		int trackColor = EclipseTheme.withAlpha(EclipseTheme.muted(), 0x3A);
		EclipseDraw.rounded(context, x, trackY, width, 4, 2, trackColor);
		int fill = (int) Math.round(width * value);
		if (fill > 0) {
			EclipseDraw.rounded(context, x, trackY, Math.max(2, fill), 4, 2,
				enabled ? (hover ? EclipseTheme.accentBright() : EclipseTheme.accent())
					: EclipseTheme.withAlpha(EclipseTheme.muted(), 0xAA));
		}
		int knobX = x + fill;
		EclipseDraw.rounded(context, knobX - 5, trackY - 3, 10, 10, 5,
			enabled ? (hover ? EclipseTheme.accentBright() : EclipseTheme.accent()) : EclipseTheme.muted());
		EclipseDraw.rounded(context, knobX - 1, trackY + 1, 2, 2, 1, EclipseTheme.panel());

		Component message = getMessage();
		if (!message.getString().isEmpty()) {
			context.drawCenteredString(Minecraft.getInstance().font, message, x + width / 2, y + 12,
				enabled ? EclipseTheme.muted() : EclipseTheme.dim());
		}
	}
}
