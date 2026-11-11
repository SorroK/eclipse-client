package com.eclipseclient.hud;

import io.wispforest.owo.ui.base.BaseOwoScreen;
import io.wispforest.owo.ui.component.BoxComponent;
import io.wispforest.owo.ui.component.LabelComponent;
import io.wispforest.owo.ui.component.UIComponents;
import io.wispforest.owo.ui.container.FlowLayout;
import io.wispforest.owo.ui.container.UIContainers;
import io.wispforest.owo.ui.core.Color;
import io.wispforest.owo.ui.core.HorizontalAlignment;
import io.wispforest.owo.ui.core.Insets;
import io.wispforest.owo.ui.core.OwoUIAdapter;
import io.wispforest.owo.ui.core.OwoUIGraphics;
import io.wispforest.owo.ui.core.ParentUIComponent;
import io.wispforest.owo.ui.core.Sizing;
import io.wispforest.owo.ui.core.VerticalAlignment;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.network.chat.Component;
import org.jetbrains.annotations.NotNull;

import java.util.Locale;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;

public final class EclipseHudScreen extends BaseOwoScreen<FlowLayout> {
	private static final int PANEL_MAX_WIDTH = 452;
	private static final int PANEL_MAX_HEIGHT = 272;

	private enum Tab {
		HUD,
		PING,
		BLUR
	}

	private Tab tab = Tab.HUD;
	private FlowLayout content;
	private EclipseButton hudTab;
	private EclipseButton pingTab;
	private EclipseButton blurTab;
	private int panelWidth;
	private int panelHeight;

	public EclipseHudScreen() {
		super(Component.literal("Eclipse Control Center"));
	}

	@Override
	protected @NotNull OwoUIAdapter<FlowLayout> createAdapter() {
		return OwoUIAdapter.create(this, UIContainers::verticalFlow);
	}

	@Override
	protected void build(FlowLayout rootComponent) {
		panelWidth = Math.min(PANEL_MAX_WIDTH, Math.max(300, width - 24));
		panelHeight = Math.min(PANEL_MAX_HEIGHT, Math.max(230, height - 24));

		rootComponent
			.horizontalAlignment(HorizontalAlignment.CENTER)
			.verticalAlignment(VerticalAlignment.CENTER)
			.surface((context, component) -> {
				context.fillGradient(component.x(), component.y(),
					component.x() + component.width(), component.y() + component.height(),
					0xB3000000, 0xE6000000);
				context.fillGradient(component.x(), component.y(),
					component.x() + component.width(), component.y() + component.height(),
					EclipseTheme.softAccent(0x10), 0x00000000);
			});

		FlowLayout panel = UIContainers.verticalFlow(Sizing.fixed(panelWidth), Sizing.fixed(panelHeight));
		panel.padding(Insets.of(18, 12, 18, 10));
		panel.gap(0);
		panel.surface(this::drawPanel);
		rootComponent.child(panel);

		FlowLayout header = UIContainers.horizontalFlow(Sizing.fill(100), Sizing.fixed(36));
		header.verticalAlignment(VerticalAlignment.CENTER);
		FlowLayout titles = UIContainers.verticalFlow(Sizing.content(), Sizing.content());
		titles.child(label("ECLIPSE CLIENT", EclipseTheme.accent(), true));
		titles.child(label("Control Center", EclipseTheme.text(), true));
		titles.child(label(
			EclipseTheme.name().toUpperCase(Locale.ROOT) + " THEME  ·  OWO CONTROL CENTER",
			EclipseTheme.muted(), false
		));
		header.child(titles);
		header.child(UIComponents.spacer());
		header.child(new EclipseButton(Component.literal("×"), EclipseButton.Style.CLOSE, button -> onClose()));
		panel.child(header);

		panel.child(separator());

		FlowLayout tabs = UIContainers.horizontalFlow(Sizing.fill(100), Sizing.fixed(20));
		tabs.gap(5);
		tabs.margins(Insets.top(5));
		hudTab = new EclipseButton(Component.literal("HUD"), EclipseButton.Style.TAB, button -> showTab(Tab.HUD));
		pingTab = new EclipseButton(Component.literal("PING"), EclipseButton.Style.TAB, button -> showTab(Tab.PING));
		blurTab = new EclipseButton(Component.literal("BLUR"), EclipseButton.Style.TAB, button -> showTab(Tab.BLUR));
		tabs.child(hudTab).child(pingTab).child(blurTab);
		panel.child(tabs);

		content = UIContainers.verticalFlow(Sizing.fill(100), Sizing.content());
		content.gap(8);
		content.margins(Insets.top(12));
		panel.child(content);

		panel.child(UIComponents.spacer());

		FlowLayout footer = UIContainers.horizontalFlow(Sizing.fill(100), Sizing.fixed(10));
		footer.verticalAlignment(VerticalAlignment.CENTER);
		footer.child(label("Changes save automatically", EclipseTheme.dim(), false));
		footer.child(UIComponents.spacer());
		footer.child(label("ESC TO CLOSE", EclipseTheme.dim(), false));
		panel.child(footer);

		showTab(Tab.HUD);
	}

	private void drawPanel(OwoUIGraphics context, ParentUIComponent component) {
		int x = component.x();
		int y = component.y();
		int width = component.width();
		int height = component.height();
		EclipseDraw.rounded(context, x + 5, y + 7, width, height, 9, 0x55000000);
		EclipseDraw.rounded(context, x - 1, y - 1, width + 2, height + 2, 9, EclipseTheme.border());
		EclipseDraw.rounded(context, x, y, width, height, 8, EclipseTheme.panelOverlay());
		context.fillGradient(x + 8, y + 2, x + width - 8, y + 48,
			EclipseTheme.softAccent(0x1A), 0x00000000);
		EclipseDraw.rounded(context, x + 18, y, width - 36, 2, 1, EclipseTheme.accent());
		context.fill(x, y + 18, x + 2, y + height - 18, EclipseTheme.accentDark());
	}

	private void showTab(Tab next) {
		tab = next;
		if (hudTab != null) {
			hudTab.selected(next == Tab.HUD);
			pingTab.selected(next == Tab.PING);
			blurTab.selected(next == Tab.BLUR);
		}
		content.clearChildren();
		switch (next) {
			case HUD -> renderHudTab();
			case PING -> renderPingTab();
			case BLUR -> renderBlurTab();
		}
	}

	private void refresh() {
		Minecraft client = Minecraft.getInstance();
		client.execute(() -> {
			if (client.screen == this) {
				showTab(tab);
			}
		});
	}

	private void renderHudTab() {
		FlowLayout columns = UIContainers.horizontalFlow(Sizing.fill(100), Sizing.content());
		columns.gap(12);
		FlowLayout left = hudColumn();
		left.child(hudRow("HUD status", EclipseHud.isEnabled(),
			() -> EclipseHud.setEnabled(!EclipseHud.isEnabled()), false));
		left.child(positionRow());
		left.child(hudRow("FPS", EclipseHud.showFps(),
			() -> EclipseHud.setShowFps(!EclipseHud.showFps()), false));
		left.child(hudRow("Coordinates", EclipseHud.showCoordinates(),
			() -> EclipseHud.setShowCoordinates(!EclipseHud.showCoordinates()), false));

		FlowLayout right = hudColumn();
		right.child(hudRow("Biome", EclipseHud.showBiome(),
			() -> EclipseHud.setShowBiome(!EclipseHud.showBiome()), false));
		right.child(hudRow("Dimension", EclipseHud.showDimension(),
			() -> EclipseHud.setShowDimension(!EclipseHud.showDimension()), false));
		right.child(hudRow("Clock", EclipseHud.showClock(),
			() -> EclipseHud.setShowClock(!EclipseHud.showClock()), false));
		right.child(hudRow("Motion blur", EclipseHud.motionBlur(),
			() -> EclipseHud.setMotionBlur(!EclipseHud.motionBlur()), false));

		columns.child(left).child(right);
		content.child(columns);
	}

	private FlowLayout hudColumn() {
		FlowLayout column = UIContainers.verticalFlow(Sizing.fill(49), Sizing.content());
		column.padding(Insets.of(6));
		column.surface(this::drawCard);
		return column;
	}

	private EclipseButton hudRow(String name, boolean enabled, Runnable toggle, boolean dim) {
		EclipseButton row = new EclipseButton(Component.literal(name), EclipseButton.Style.ROW, button -> {
			toggle.run();
			EclipseHud.save();
			refresh();
		});
		row.rowSwitch(true).rowOn(enabled).rowDim(dim);
		return row;
	}

	private EclipseButton positionRow() {
		EclipseButton row = new EclipseButton(Component.literal("Position"), EclipseButton.Style.ROW, button -> {
			EclipseHud.cyclePosition();
			EclipseHud.save();
			refresh();
		});
		row.trailing(positionLabel());
		return row;
	}

	private void renderPingTab() {
		boolean override = EclipseHud.pingOverride();
		FlowLayout card = card();

		FlowLayout header = UIContainers.horizontalFlow(Sizing.fill(100), Sizing.fixed(22));
		header.verticalAlignment(VerticalAlignment.CENTER);
		FlowLayout headerText = UIContainers.verticalFlow(Sizing.content(), Sizing.content());
		headerText.child(label("PING OVERRIDE", EclipseTheme.text(), true));
		headerText.child(label("CLIENT-SIDE", EclipseTheme.dim(), false));
		header.child(headerText);
		header.child(UIComponents.spacer());
		header.child(switchButton(override, value -> {
			EclipseHud.setPingOverride(value);
			EclipseHud.save();
			refresh();
		}));
		card.child(header);

		FlowLayout valueRow = UIContainers.horizontalFlow(Sizing.fill(100), Sizing.fixed(24));
		valueRow.gap(6);
		valueRow.verticalAlignment(VerticalAlignment.CENTER);

		FlowLayout valueBox = UIContainers.horizontalFlow(Sizing.fixed(98), Sizing.fixed(22));
		valueBox.padding(Insets.of(8, 4, 8, 4));
		valueBox.verticalAlignment(VerticalAlignment.CENTER);
		valueBox.surface((context, component) -> {
			EclipseDraw.rounded(context, component.x(), component.y(), component.width(), component.height(), 5,
				override ? EclipseTheme.softAccent(0x1E) : EclipseTheme.withAlpha(EclipseTheme.muted(), 0x18));
		});
		LabelComponent valueLabel = label(Integer.toString(EclipseHud.pingValue()),
			override ? EclipseTheme.accent() : EclipseTheme.muted(), true);
		valueBox.child(valueLabel);
		valueBox.child(label("ms", EclipseTheme.muted(), false).margins(Insets.left(4)));
		valueRow.child(valueBox);

		LabelComponent stateLabel = label(override ? "ACTIVE" : "BYPASSED",
			override ? EclipseTheme.accent() : EclipseTheme.dim(), false);
		valueRow.child(stateLabel.margins(Insets.left(6)));
		valueRow.child(UIComponents.spacer());
		valueRow.child(new EclipseButton(Component.literal("-"), EclipseButton.Style.VALUE, button -> {
			EclipseHud.setPingOverride(true);
			EclipseHud.setPingValue(EclipseHud.pingValue() - 10);
			EclipseHud.save();
			refresh();
		}));
		valueRow.child(new EclipseButton(Component.literal("+"), EclipseButton.Style.VALUE, button -> {
			EclipseHud.setPingOverride(true);
			EclipseHud.setPingValue(EclipseHud.pingValue() + 10);
			EclipseHud.save();
			refresh();
		}));
		card.child(valueRow);

		FlowLayout sliderHeader = UIContainers.horizontalFlow(Sizing.fill(100), Sizing.fixed(10));
		sliderHeader.child(label("Ping value", EclipseTheme.muted(), false));
		sliderHeader.child(UIComponents.spacer());
		LabelComponent sliderValue = label(EclipseHud.pingValue() + " ms",
			override ? EclipseTheme.accent() : EclipseTheme.muted(), false);
		sliderHeader.child(sliderValue);
		card.child(sliderHeader);

		EclipseSlider slider = new EclipseSlider(Sizing.fill(100));
		slider.value(EclipseHud.pingValue() / 1000.0);
		slider.message(value -> Component.empty());
		slider.onChanged().subscribe(value -> {
			int next = (int) Math.round(value * 1000.0);
			EclipseHud.setPingOverride(true);
			EclipseHud.setPingValue(next);
			valueLabel.text(Component.literal(Integer.toString(next))).color(Color.ofArgb(EclipseTheme.accent()));
			stateLabel.text(Component.literal("ACTIVE")).color(Color.ofArgb(EclipseTheme.accent()));
			sliderValue.text(Component.literal(next + " ms")).color(Color.ofArgb(EclipseTheme.accent()));
		});
		slider.slideEnd().subscribe(() -> {
			EclipseHud.save();
			refresh();
		});
		card.child(slider);

		int[] presets = {-1, 50, 100, 150, 250, 500};
		String[] presetLabels = {"Actual", "50", "100", "150", "250", "500"};
		int gap = 4;
		int chipWidth = Math.max(36, (panelWidth - 60 - gap * (presets.length - 1)) / presets.length);
		FlowLayout chips = UIContainers.horizontalFlow(Sizing.fill(100), Sizing.fixed(16));
		chips.gap(gap);
		for (int index = 0; index < presets.length; index++) {
			int preset = presets[index];
			boolean active = preset < 0 ? !override : override && EclipseHud.pingValue() == preset;
			EclipseButton chip = new EclipseButton(Component.literal(presetLabels[index]), EclipseButton.Style.CHIP, button -> {
				if (preset < 0) {
					EclipseHud.setPingOverride(false);
				} else {
					EclipseHud.setPingOverride(true);
					EclipseHud.setPingValue(preset);
				}
				EclipseHud.save();
				refresh();
			});
			chip.fixedWidth(chipWidth).selected(active);
			chips.child(chip);
		}
		card.child(chips);

		card.child(separator());
		card.child(label("Changes the ping shown in the player list.", EclipseTheme.muted(), false));
		card.child(label("Server latency is unchanged.", EclipseTheme.dim(), false));
		content.child(card);
	}

	private void renderBlurTab() {
		boolean enabled = EclipseHud.motionBlur();
		boolean includePlayers = EclipseHud.motionBlurPlayers();
		FlowLayout card = card();

		FlowLayout header = UIContainers.horizontalFlow(Sizing.fill(100), Sizing.fixed(22));
		header.verticalAlignment(VerticalAlignment.CENTER);
		FlowLayout headerText = UIContainers.verticalFlow(Sizing.content(), Sizing.content());
		headerText.child(label("MOTION BLUR", EclipseTheme.text(), true));
		headerText.child(label("VELOCITY REPROJECTION", EclipseTheme.dim(), false));
		header.child(headerText);
		header.child(UIComponents.spacer());
		header.child(switchButton(enabled, value -> {
			EclipseHud.setMotionBlur(value);
			EclipseHud.save();
			refresh();
		}));
		card.child(header);

		FlowLayout strengthHeader = UIContainers.horizontalFlow(Sizing.fill(100), Sizing.fixed(10));
		strengthHeader.child(label("Strength", enabled ? EclipseTheme.text() : EclipseTheme.muted(), false));
		strengthHeader.child(UIComponents.spacer());
		LabelComponent strengthLabel = label(EclipseHud.motionBlurStrength() + "%",
			enabled ? EclipseTheme.accent() : EclipseTheme.muted(), false);
		strengthHeader.child(strengthLabel);
		card.child(strengthHeader);

		EclipseSlider slider = new EclipseSlider(Sizing.fill(100));
		slider.value(EclipseHud.motionBlurStrength() / 100.0);
		slider.active(enabled);
		slider.message(value -> Component.empty());
		slider.onChanged().subscribe(value -> {
			int next = (int) Math.round(value * 100.0);
			EclipseHud.setMotionBlurStrength(next);
			strengthLabel.text(Component.literal(next + "%"));
		});
		slider.slideEnd().subscribe(EclipseHud::save);
		card.child(slider);

		EclipseButton playersRow = new EclipseButton(Component.literal("Include players"), EclipseButton.Style.ROW, button -> {
			EclipseHud.setMotionBlurPlayers(!EclipseHud.motionBlurPlayers());
			EclipseHud.save();
			refresh();
		});
		playersRow.rowSwitch(true).rowOn(includePlayers).rowDim(!enabled);
		card.child(playersRow);

		card.child(separator());
		card.child(label(
			enabled
				? (includePlayers ? "Players blur with the world." : "World-only blur. Players stay sharp.")
				: "Enable motion blur to use these settings.",
			EclipseTheme.muted(), false
		));
		card.child(label("Velocity reprojection keeps the HUD and first-person hand sharp.", EclipseTheme.dim(), false));
		content.child(card);
	}

	private EclipseButton switchButton(boolean initial, Consumer<Boolean> onChange) {
		EclipseButton button = new EclipseButton(Component.empty(), EclipseButton.Style.SWITCH, self -> {
			boolean next = !self.on();
			self.on(next);
			onChange.accept(next);
		});
		button.on(initial);
		return button;
	}

	private FlowLayout card() {
		FlowLayout card = UIContainers.verticalFlow(Sizing.fill(100), Sizing.content());
		card.padding(Insets.of(12, 10, 12, 10));
		card.gap(6);
		card.surface(this::drawCard);
		return card;
	}

	private void drawCard(OwoUIGraphics context, ParentUIComponent component) {
		EclipseDraw.rounded(context, component.x() - 1, component.y() - 1,
			component.width() + 2, component.height() + 2, 7, EclipseTheme.border());
		EclipseDraw.rounded(context, component.x(), component.y(),
			component.width(), component.height(), 6,
			EclipseTheme.withAlpha(EclipseTheme.panelAlt(), EclipseTheme.isLight() ? 0xE8 : 0xB8));
	}

	private BoxComponent separator() {
		BoxComponent line = UIComponents.box(Sizing.fill(100), Sizing.fixed(1));
		line.color(Color.ofArgb(EclipseTheme.border()));
		line.margins(Insets.vertical(4));
		return line;
	}

	private LabelComponent label(String text, int color, boolean shadow) {
		return UIComponents.label(Component.literal(text))
			.color(Color.ofArgb(color))
			.shadow(shadow);
	}

	private static String positionLabel() {
		return switch (EclipseHud.position()) {
			case "top_right" -> "Top right";
			case "bottom_left" -> "Bottom left";
			case "bottom_right" -> "Bottom right";
			default -> "Top left";
		};
	}
}
