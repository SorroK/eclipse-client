package com.eclipseclient.hud;

import net.minecraft.client.gui.GuiGraphics;

final class EclipseDraw {
	private EclipseDraw() {
	}

	static void rounded(GuiGraphics context, int x, int y, int width, int height, int radius, int color) {
		if (width <= 0 || height <= 0) {
			return;
		}
		radius = Math.max(0, Math.min(radius, Math.min(width / 2, height / 2)));
		if (radius == 0) {
			context.fill(x, y, x + width, y + height, color);
			return;
		}
		for (int row = 0; row < radius; row++) {
			int inset = radius - (int) Math.sqrt((double) radius * radius - (double) (radius - row) * (radius - row));
			context.fill(x + inset, y + row, x + width - inset, y + row + 1, color);
			context.fill(x + inset, y + height - 1 - row, x + width - inset, y + height - row, color);
		}
		context.fill(x, y + radius, x + width, y + height - radius, color);
	}
}
