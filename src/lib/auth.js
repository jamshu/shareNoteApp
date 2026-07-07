// Client-side auth: talks to the /api/auth/* endpoints. The actual session
// lives in an httpOnly cookie the browser sends automatically — this store only
// holds the current user for the UI.
import { writable } from 'svelte/store';
import { browser } from '$app/environment';
import { base } from '$app/paths';

// undefined = unknown (still checking) · null = logged out · object = logged in
export const user = writable(undefined);

const url = (p) => `${base}${p}`;

export async function checkSession() {
	if (!browser) return;
	try {
		const res = await fetch(url('/api/auth/me'));
		if (res.ok) {
			const d = await res.json();
			user.set(d.user || null);
		} else {
			user.set(null);
		}
	} catch {
		user.set(null);
	}
}

export async function login(email, password) {
	const res = await fetch(url('/api/auth/login'), {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ email, password })
	});
	const d = await res.json().catch(() => ({}));
	if (!res.ok || !d.ok) throw new Error(d.error || 'Login failed');
	user.set(d.user);
	return d.user;
}

// org = { mode: 'create'|'invite'|'join', orgName?, inviteToken?, companyId? }
export async function signup(name, email, password, org) {
	const res = await fetch(url('/api/auth/signup'), {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ name, email, password, org })
	});
	const d = await res.json().catch(() => ({}));
	if (!res.ok || !d.ok) throw new Error(d.error || 'Sign up failed');
	user.set(d.user);
	return d.user;
}

export async function logout() {
	try {
		await fetch(url('/api/auth/logout'), { method: 'POST' });
	} catch {
		/* ignore */
	}
	user.set(null);
}
