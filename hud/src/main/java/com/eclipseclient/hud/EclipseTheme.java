package com.eclipseclient.hud;

import java.util.Locale;

/**
 * The launcher passes the selected theme as -Declipse.theme. Keeping the
 * palette here means the in-game control center follows the same eight themes
 * as the launcher without bundling a second asset pipeline.
 */
public final class EclipseTheme {
    private static final Palette PALETTE = select(System.getProperty("eclipse.theme", "eclipse"));

    private EclipseTheme() {
    }

    private static Palette select(String raw) {
        String id = raw == null ? "eclipse" : raw.trim().toLowerCase(Locale.ROOT);
        return switch (id) {
            case "aurora" -> new Palette(
                "Aurora", false,
                0xFF080A14, 0xFF111524, 0xFF151A2B,
                0xFFF0F2FF, 0xFF9AA3C2, 0xFF697393,
                0xFFA3B4FF, 0xFFC4CEFF, 0xFF7589F2,
                0x1ADBE2FF, 0xFF080B20
            );
            case "ember" -> new Palette(
                "Ember", false,
                0xFF100A0B, 0xFF1A1113, 0xFF211619,
                0xFFFFF2EC, 0xFFBDA59B, 0xFF8A7167,
                0xFFFFB48C, 0xFFFFD1B0, 0xFFEF8B5E,
                0x1AFFEAE4, 0xFF220C04
            );
            case "midnight" -> new Palette(
                "Midnight", false,
                0xFF070B13, 0xFF0E1624, 0xFF121C2D,
                0xFFEDF7FF, 0xFF91A9BD, 0xFF637C92,
                0xFF67E8F9, 0xFFA5F3FC, 0xFF3ECBDF,
                0x1ACBE6FF, 0xFF03151B
            );
            case "daylight" -> new Palette(
                "Daylight", true,
                0xFFF3F5F0, 0xFFFFFFFF, 0xFFF8FAF6,
                0xFF13231A, 0xFF53675B, 0xFF7B8C81,
                0xFF1B7A4E, 0xFF2B7F57, 0xFF0D5A36,
                0x1A12301D, 0xFFFFFFFF
            );
            case "frost" -> new Palette(
                "Frost", true,
                0xFFEDF4F9, 0xFFFFFFFF, 0xFFF5F9FC,
                0xFF102630, 0xFF526B79, 0xFF7B919E,
                0xFF0F7289, 0xFF12839C, 0xFF0A5E72,
                0x1A112C3C, 0xFFFFFFFF
            );
            case "sakura" -> new Palette(
                "Sakura", true,
                0xFFFBF2F3, 0xFFFFFDFD, 0xFFFFF7F8,
                0xFF2D181F, 0xFF7A5C63, 0xFFA0838A,
                0xFFBE4C68, 0xFFCD5B77, 0xFFA23A54,
                0x1A401B26, 0xFFFFFFFF
            );
            case "solar" -> new Palette(
                "Solar", true,
                0xFFF8F2E6, 0xFFFFFDF8, 0xFFFBF6EB,
                0xFF2C2418, 0xFF75664F, 0xFF9B8A6E,
                0xFFA95A0D, 0xFFBD6A18, 0xFF8C4807,
                0x1A3F2F17, 0xFFFFFFFF
            );
            default -> new Palette(
                "Eclipse", false,
                0xFF080B0E, 0xFF11161C, 0xFF151B22,
                0xFFEEF3F1, 0xFF929E9A, 0xFF65716D,
                0xFF8AF3A8, 0xFFA0FFB9, 0xFF55D97D,
                0x1AFFFFFF, 0xFF04120A
            );
        };
    }

    public static String name() {
        return PALETTE.name();
    }

    public static boolean isLight() {
        return PALETTE.light();
    }

    public static int background() {
        return PALETTE.background();
    }

    public static int panel() {
        return PALETTE.panel();
    }

    public static int panelAlt() {
        return PALETTE.panelAlt();
    }

    public static int text() {
        return PALETTE.text();
    }

    public static int muted() {
        return PALETTE.muted();
    }

    public static int dim() {
        return PALETTE.dim();
    }

    public static int accent() {
        return PALETTE.accent();
    }

    public static int accentBright() {
        return PALETTE.accentBright();
    }

    public static int accentDark() {
        return PALETTE.accentDark();
    }

    public static int accentInk() {
        return PALETTE.accentInk();
    }

    public static int border() {
        return PALETTE.border();
    }

    public static int panelOverlay() {
        return withAlpha(PALETTE.panel(), PALETTE.light() ? 0xF4 : 0xDD);
    }

    public static int withAlpha(int color, int alpha) {
        return (color & 0x00FFFFFF) | ((alpha & 0xFF) << 24);
    }

    public static int softAccent(int alpha) {
        return withAlpha(PALETTE.accent(), alpha);
    }

    private record Palette(
        String name,
        boolean light,
        int background,
        int panel,
        int panelAlt,
        int text,
        int muted,
        int dim,
        int accent,
        int accentBright,
        int accentDark,
        int border,
        int accentInk
    ) {
    }
}
