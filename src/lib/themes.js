// Color themes. Single source of truth, importable from client and server
// (no browser-only deps). The chosen theme id is persisted (localStorage or a
// user settings field) and applied via a data-theme attribute on <html>.
// Each theme's palette lives in app.css under :root[data-theme='<id>'].
// `midnight` is the base :root palette.

export const DEFAULT_THEME = 'catppuccin-latte';

// swatch = [accent, surface, bg] — three colors shown in the picker preview.
export const THEMES = [
	{ id: 'midnight', name: 'Midnight Teal', swatch: ['#14b8a6', '#111c33', '#0b1120'] },
	{ id: 'claude', name: 'Claude', swatch: ['#c15f3c', '#ffffff', '#faf9f5'] },
	{ id: 'catppuccin-latte', name: 'Catppuccin Latte', swatch: ['#8839ef', '#ffffff', '#eff1f5'] }
];

export const THEME_IDS = THEMES.map((t) => t.id);

export function coerceTheme(id) {
	return THEME_IDS.includes(id) ? id : DEFAULT_THEME;
}

/** Apply on mount and whenever the user picks a new theme. */
export function applyTheme(id) {
	document.documentElement.dataset.theme = coerceTheme(id);
	localStorage.setItem('theme', coerceTheme(id));
}
