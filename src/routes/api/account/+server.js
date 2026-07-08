// Self-service account deletion. Destructive, so the password is re-checked
// against Odoo instead of trusting the session cookie alone.
import { json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth.js';
import {
	adminExecute,
	authenticateUser,
	destroySession,
	getUserOrgInfo,
	deleteUserAccount
} from '$lib/server/odoo.js';
import { getSession, clearSessionCookie, clearContextCookie } from '$lib/server/session.js';

export const prerender = false;

export async function POST({ request, cookies }) {
	try {
		// requireUser, not requireApprovedUser — pending users may delete themselves too
		const { uid } = await requireUser(cookies);
		const { password } = await request.json();
		if (!password) return json({ ok: false, error: 'Password required' }, { status: 400 });

		const info = await getUserOrgInfo(uid);
		const { sessionId } = await authenticateUser(info.email, password); // throws 401 on mismatch
		destroySession(sessionId);

		// an admin leaving would orphan the org — nobody could approve or invite
		if (info.role === 'admin' && info.companyId) {
			const others = await adminExecute('res.users', 'search_count', [
				[
					['company_id', '=', info.companyId],
					['id', '!=', uid]
				]
			]);
			if (others) {
				return json(
					{ ok: false, error: 'You are the organization admin — remove all other members first.' },
					{ status: 400 }
				);
			}
		}

		await deleteUserAccount(uid);

		const sid = getSession(cookies);
		if (sid) destroySession(sid);
		clearSessionCookie(cookies);
		clearContextCookie(cookies);
		return json({ ok: true });
	} catch (e) {
		return json({ ok: false, error: e?.message || 'Failed' }, { status: e?.status || 500 });
	}
}
