package com.eclipseclient.hud;

import io.wispforest.owo.ui.component.ButtonComponent;
import io.wispforest.owo.ui.core.Sizing;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.network.chat.Component;

import java.util.function.Consumer;

public final class EclipseButton extends ButtonComponent {
	public enum Style {
		TAB,
		CLOSE,
		SWITCH,
		ROW,
		CHIP,
		VALUE,
		PRIMARY
	}

	private Style style;
	private boolean on;
	private boolean rowSwitch;
	private boolean rowDim;
	private boolean selected;
	private String trailing = "";

	public EclipseButton(Component message, Style style, Consumer<EclipseButton> onPress) {
		super(message, button -> onPress.accept((EclipseButton) button));
		this.style = style;
		this.textShadow(false);
		applyStyleSize();
	}

	private void applyStyleSize() {
		switch (style) {
			case TAB -> sizing(Sizing.fixed(76), Sizing.fixed(20));
			case CLOSE -> sizing(Sizing.fixed(16), Sizing.fixed(16));
			case SWITCH -> sizing(Sizing.fixed(30), Sizing.fixed(14));
			case ROW -> sizing(Sizing.fill(100), Sizing.fixed(20));
			case CHIP -> sizing(Sizing.fixed(60), Sizing.fixed(16));
			case VALUE -> sizing(Sizing.fixed(26), Sizing.fixed(22));
			case PRIMARY -> sizing(Sizing.content(), Sizing.fixed(20));
		}
	}

	public EclipseButton style(Style style) {
		this.style = style;
		applyStyleSize();
		return this;
	}

	public EclipseButton on(boolean on) {
		this.on = on;
		return this;
	}

	public boolean on() {
		return on;
	}

	public EclipseButton rowSwitch(boolean rowSwitch) {
		this.rowSwitch = rowSwitch;
		return this;
	}

	public EclipseButton rowOn(boolean rowOn) {
		this.on = rowOn;
		return this;
	}

	public boolean rowOn() {
		return on;
	}

	public EclipseButton rowDim(boolean rowDim) {
		this.rowDim = rowDim;
		return this;
	}

	public EclipseButton selected(boolean selected) {
		this.selected = selected;
		return this;
	}

	public boolean selected() {
		return selected;
	}

	public EclipseButton trailing(String trailing) {
		this.trailing = trailing;
		return this;
	}

	public EclipseButton fixedWidth(int width) {
		this.horizontalSizing(Sizing.fixed(width));
		return this;
	}

	@Override
	public void renderContents(GuiGraphics context, int mouseX, int mouseY, float delta) {
		int x = getX();
		int y = getY();
		int width = getWidth();
		int height = getHeight();
		boolean hover = isHovered();
		int accent = EclipseTheme.accent();
		int muted = EclipseTheme.muted();
		int text = EclipseTheme.text();

		switch (style) {
			case TAB -> {
				if (selected || hover) {
					EclipseDraw.rounded(context, x, y, width, height, 5,
						selected ? EclipseTheme.softAccent(0x2A) : EclipseTheme.withAlpha(EclipseTheme.panelAlt(), 0xF0));
				}
				context.drawCenteredString(Minecraft.getInstance().font, getMessage(), x + width / 2, y + 6,
					selected ? accent : muted);
				if (selected) {
					context.fill(x + 13, y + height - 2, x + width - 13, y + height, accent);
				}
			}
			case CLOSE -> {
				EclipseDraw.rounded(context, x, y, width, height, 4,
					hover ? accent : EclipseTheme.border());
				EclipseDraw.rounded(context, x + 1, y + 1, width - 2, height - 2, 3,
					hover ? EclipseTheme.softAccent(0x2A) : EclipseTheme.withAlpha(EclipseTheme.panelAlt(), 0xA0));
				context.drawCenteredString(Minecraft.getInstance().font, getMessage(), x + width / 2, y + 4,
					hover ? accent : muted);
			}
			case SWITCH -> drawSwitch(context, x, y, on, hover, rowDim);
			case ROW -> {
				if (hover) {
					EclipseDraw.rounded(context, x + 1, y + 1, width - 2, height - 2, 4,
						EclipseTheme.softAccent(0x16));
				}
				context.drawString(Minecraft.getInstance().font, getMessage(), x + 9, y + 6,
					rowDim ? muted : (selected ? accent : text), false);
				if (rowSwitch) {
					drawSwitch(context, x + width - 39, y + 3, on, hover, rowDim);
				} else if (!trailing.isEmpty()) {
					int color = rowDim ? muted : accent;
					context.drawString(Minecraft.getInstance().font, trailing,
						x + width - 9 - Minecraft.getInstance().font.width(trailing), y + 6, color, false);
				}
			}
			case CHIP -> {
				int border = selected ? accent : EclipseTheme.border();
				int fill = selected
					? accent
					: hover ? EclipseTheme.softAccent(0x1C) : EclipseTheme.withAlpha(EclipseTheme.panel(), 0xB0);
				EclipseDraw.rounded(context, x, y, width, height, 4, border);
				EclipseDraw.rounded(context, x + 1, y + 1, width - 2, height - 2, 3, fill);
				context.drawCenteredString(Minecraft.getInstance().font, getMessage(), x + width / 2, y + 4,
					selected ? EclipseTheme.accentInk() : muted);
			}
			case VALUE -> {
				int border = hover ? accent : EclipseTheme.border();
				int fill = hover ? EclipseTheme.softAccent(0x24) : EclipseTheme.withAlpha(EclipseTheme.panel(), 0xC0);
				EclipseDraw.rounded(context, x, y, width, height, 5, border);
				EclipseDraw.rounded(context, x + 1, y + 1, width - 2, height - 2, 4, fill);
				context.drawCenteredString(Minecraft.getInstance().font, getMessage(), x + width / 2, y + 7,
					hover ? accent : text);
			}
			case PRIMARY -> {
				EclipseDraw.rounded(context, x, y, width, height, 5, hover ? EclipseTheme.accentBright() : accent);
				context.drawCenteredString(Minecraft.getInstance().font, getMessage(), x + width / 2, y + 6,
					EclipseTheme.accentInk());
			}
		}
	}

	private static void drawSwitch(GuiGraphics context, int x, int y, boolean on, boolean hover, boolean dim) {
		int track = on
			? (dim ? EclipseTheme.withAlpha(EclipseTheme.accent(), 0x77) : (hover ? EclipseTheme.accentBright() : EclipseTheme.accent()))
			: (hover ? EclipseTheme.withAlpha(EclipseTheme.muted(), 0x88) : EclipseTheme.withAlpha(EclipseTheme.muted(), 0x4C));
		EclipseDraw.rounded(context, x, y, 30, 14, 7, track);
		int knobX = on ? x + 17 : x + 3;
		EclipseDraw.rounded(context, knobX, y + 2, 10, 10, 5,
			on ? EclipseTheme.accentInk() : EclipseTheme.panel());
	}
}
