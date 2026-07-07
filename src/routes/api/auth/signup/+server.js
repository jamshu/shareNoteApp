import { json } from '@sveltejs/kit';
import {
	assertConfigured,
	signupUser,
	authenticateUser,
	buildSessionContext,
	getUserOrgInfo
} from '$lib/server/odoo.js';
import { setSessionCookie, setContextCookie } from '$lib/server/session.js';

export const prerender = false;

// NOTE: open signup creates an Odoo user (and possibly a company) using the
// admin API key. In production, gate this with a CAPTCHA / rate limiting to
// prevent abuse and runaway user-seat usage.
//
// body: { name, email, password, org: { mode: 'create'|'invite'|'join',
//         orgName?, inviteToken?, companyId? } }
export async function POST({ request, cookies }) {
	try {
		assertConfigured();
		const { name, email, password, org } = await request.json();

		if (!name || !email || !password) {
			return json({ ok: false, error: 'Name, email and password are required' }, { status: 400 });
		}
		if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
			return json({ ok: false, error: 'Please enter a valid email address' }, { status: 400 });
		}
		if (String(password).length < 6) {
			return json({ ok: false, error: 'Password must be at least 6 characters' }, { status: 400 });
		}

		await signupUser({ name, email, password, org });

		// log the new user straight in (pending users can log in; the data API
		// rejects them until an org admin approves)
		const { sessionId, info } = await authenticateUser(email, password);
		const orgInfo = await getUserOrgInfo(info.uid);
		setSessionCookie(cookies, sessionId);
		setContextCookie(cookies, {
			...buildSessionContext(info),
			orgRole: orgInfo.role,
			orgStatus: orgInfo.status
		});

		return json({ ok: true, user: orgInfo });
	} catch (e) {
		return json({ ok: false, error: e?.message || 'Sign up failed' }, { status: e?.status || 500 });
	}
}
