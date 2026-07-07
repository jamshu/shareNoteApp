import { json } from '@sveltejs/kit';
import { sessionInfo, buildSessionContext, getUserOrgInfo } from '$lib/server/odoo.js';
import {
	getSession,
	clearSessionCookie,
	setContextCookie,
	refreshSessionCookie
} from '$lib/server/session.js';

export const prerender = false;

export async function GET({ cookies }) {
	const sid = getSession(cookies);
	if (!sid) return json({ ok: false }, { status: 401 });
	try {
		const { result: info, sessionId } = await sessionInfo(sid);
		// Keep the cookie in sync with any rotated id + slide the 30-day expiry.
		refreshSessionCookie(cookies, sessionId, sid);
		// Re-read org role/status every load — this is how a pending user's UI
		// unlocks after an admin approves them.
		const orgInfo = await getUserOrgInfo(info.uid);
		setContextCookie(cookies, {
			...buildSessionContext(info),
			orgRole: orgInfo.role,
			orgStatus: orgInfo.status
		});
		return json({ ok: true, user: orgInfo });
	} catch {
		clearSessionCookie(cookies);
		return json({ ok: false }, { status: 401 });
	}
}
