<script>
	import '@fontsource-variable/fraunces';
	import '@fontsource-variable/inter';
	import '../app.css';
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { user, checkSession, logout } from '$lib/auth.js';
	import { applyTheme, THEMES, coerceTheme } from '$lib/themes.js';
	import { pushSupported, registerSW, currentSubscription, subscribePush, unsubscribePush } from '$lib/push.js';

	let { children } = $props();

	let pushState = $state('unknown'); // unknown | off | on | unsupported
	let themeOpen = $state(false);
	let wide = $state(false); // stretch layout to full width on big screens

	function toggleWide() {
		wide = !wide;
		localStorage.setItem('wide', wide ? '1' : '0');
	}

	const PUBLIC_ROUTES = ['/login', '/signup'];
	const isPublic = (path) => PUBLIC_ROUTES.some((p) => path.startsWith(`${base}${p}`));

	// Keepalive: while logged in, re-sync the session every 10 min and whenever the
	// tab becomes visible. Each /api/auth/me call refreshes the rotated session id
	// and slides the cookie's 30-day expiry, so an idle tab never drifts into logout.
	const KEEPALIVE_MS = 10 * 60 * 1000;

	function pingIfVisible() {
		if ($user && document.visibilityState === 'visible') checkSession();
	}

	onMount(() => {
		document.addEventListener('visibilitychange', pingIfVisible);
		const keepaliveTimer = setInterval(pingIfVisible, KEEPALIVE_MS);
		return () => {
			clearInterval(keepaliveTimer);
			document.removeEventListener('visibilitychange', pingIfVisible);
		};
	});

	onMount(async () => {
		applyTheme(coerceTheme(localStorage.getItem('theme')));
		wide = localStorage.getItem('wide') === '1';
		await checkSession();
		registerSW();
		if (!pushSupported()) {
			pushState = 'unsupported';
		} else {
			try {
				pushState = (await currentSubscription()) ? 'on' : 'off';
			} catch {
				pushState = 'off';
			}
		}
	});

	// auth gate: once the session check settles, route guests to /login
	$effect(() => {
		if ($user === null && !isPublic($page.url.pathname)) goto(`${base}/login`);
		if ($user && isPublic($page.url.pathname)) goto(`${base}/`);
	});

	async function enablePush() {
		try {
			await subscribePush();
			pushState = 'on';
		} catch (e) {
			alert(e.message);
		}
	}

	async function doLogout() {
		// unbind this device's push before the session dies — otherwise the next
		// account on this browser inherits a subscription pointed at this user
		await unsubscribePush().catch(() => {});
		if (pushState === 'on') pushState = 'off';
		await logout();
		goto(`${base}/login`);
	}
</script>

<div class="app" class:app--wide={wide}>
	{#if $user === undefined}
		<p class="muted" style="text-align:center; margin-top:40vh">Loading…</p>
	{:else if $user === null}
		{@render children()}
	{:else if $user.status !== 'approved'}
		<!-- pending approval screen -->
		<div class="card fade-in" style="padding: 32px; margin-top: 18vh; text-align: center;">
			<h2>Waiting for approval</h2>
			<p class="muted" style="margin-top: 12px;">
				Your request to join <strong>{$user.companyName}</strong> is pending. An organization
				admin needs to approve you before you can access notes.
			</p>
			<div style="display:flex; gap:10px; justify-content:center; margin-top:20px;">
				<button class="btn" onclick={() => checkSession()}>Check again</button>
				<button class="btn btn--ghost" onclick={doLogout}>Log out</button>
			</div>
		</div>
	{:else}
		<header class="topbar">
			<a href="{base}/" class="brand"><span class="emo">📝</span> ShareNote</a>
			<nav>
				<a href="{base}/" class:active={$page.url.pathname === `${base}/`}>Notes</a>
				<a href="{base}/groups" class:active={$page.url.pathname.startsWith(`${base}/groups`)}>Groups</a>
				{#if $user.role === 'admin'}
					<a href="{base}/admin" class:active={$page.url.pathname.startsWith(`${base}/admin`)}>Admin</a>
				{/if}
			</nav>
			<div class="topbar-actions">
				{#if pushState === 'off'}
					<button class="btn btn--sm" title="Enable notifications" onclick={enablePush}>🔔</button>
				{/if}
				<a href="{base}/account" class="btn btn--sm" title="Account">👤</a>
				<button class="btn btn--sm wide-btn" title={wide ? 'Normal width' : 'Full width'} onclick={toggleWide}>
					{wide ? '🡘' : '⛶'}
				</button>
				<button class="btn btn--sm" title="Theme" onclick={() => (themeOpen = !themeOpen)}>🎨</button>
				<button class="btn btn--sm" title="Log out" onclick={doLogout}>↪</button>
			</div>
		</header>
		{#if themeOpen}
			<div class="card theme-picker fade-in">
				{#each THEMES as t (t.id)}
					<button
						class="theme-swatch"
						onclick={() => { applyTheme(t.id); themeOpen = false; }}
						title={t.name}
					>
						{#each t.swatch as c (c)}<span style="background:{c}"></span>{/each}
						{t.name}
					</button>
				{/each}
			</div>
		{/if}
		{@render children()}
	{/if}
</div>

<style>
	/* pointless on phones — layout is already full width there */
	@media (max-width: 800px) {
		.wide-btn {
			display: none;
		}
	}
	.topbar {
		display: flex;
		align-items: center;
		gap: 18px;
		margin-bottom: 8px;
	}
	.brand {
		font-family: var(--font-display);
		font-weight: 700;
		font-size: 1.25rem;
		color: var(--text);
		text-decoration: none;
		display: flex;
		align-items: center;
		gap: 8px;
	}
	nav {
		display: flex;
		gap: 4px;
		flex: 1;
	}
	nav a {
		color: var(--text-dim);
		text-decoration: none;
		font-size: 0.92rem;
		font-weight: 600;
		padding: 6px 12px;
		border-radius: 999px;
	}
	nav a.active {
		color: var(--text);
		background: var(--surface-2);
	}
	.topbar-actions {
		display: flex;
		gap: 6px;
	}
	.theme-picker {
		padding: 12px;
		margin-bottom: 14px;
		display: flex;
		gap: 10px;
		flex-wrap: wrap;
	}
	.theme-swatch {
		display: flex;
		align-items: center;
		gap: 4px;
		font-size: 0.84rem;
		font-weight: 600;
		color: var(--text-dim);
		padding: 6px 10px;
		border-radius: var(--radius-sm);
		border: 1px solid var(--border);
	}
	.theme-swatch span {
		width: 14px;
		height: 14px;
		border-radius: 50%;
		display: inline-block;
	}
	@media (max-width: 560px) {
		.topbar {
			flex-wrap: wrap;
		}
		nav {
			order: 3;
			width: 100%;
		}
	}
</style>
