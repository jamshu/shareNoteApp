// Resolve the authenticated user from request cookies. The app_ctx cookie carries
// the Odoo call context plus org role/status captured at login (/me refreshes it).
// Throws 401/403-tagged Errors; API routes convert to responses.
import { getSession, getContext, setContextCookie, refreshSessionCookie } from './session.js';
import { sessionInfo, buildSessionContext, getUserOrgInfo } from './odoo.js';

/**
 * Returns { uid, sid, ctx } where ctx = { lang, tz, uid, allowed_company_ids,
 * orgRole, orgStatus }. Falls back to a live session + admin lookup when the
 * ctx cookie is missing (e.g. sessions from before a deploy).
 */
export async function requireUser(cookies) {
	const sid = getSession(cookies);
	if (!sid) {
		const e = new Error('Not authenticated');
		e.status = 401;
		throw e;
	}
	let ctx = getContext(cookies);
	if (!ctx?.uid || !ctx.orgStatus) {
		const { result, sessionId } = await sessionInfo(sid);
		refreshSessionCookie(cookies, sessionId, sid);
		if (!result?.uid) {
			const e = new Error('Not authenticated');
			e.status = 401;
			throw e;
		}
		const org = await getUserOrgInfo(result.uid);
		ctx = { ...buildSessionContext(result), orgRole: org.role, orgStatus: org.status };
		setContextCookie(cookies, ctx);
	}
	return { uid: ctx.uid, sid, ctx };
}

/** Same, but rejects users still waiting for organization approval. */
export async function requireApprovedUser(cookies) {
	const u = await requireUser(cookies);
	if (u.ctx.orgStatus !== 'approved') {
		const e = new Error('Your organization access is pending admin approval');
		e.status = 403;
		throw e;
	}
	return u;
}

/**
 * Org admin only. Role is re-read with the admin key (not trusted from the
 * cookie) because this gates approving other users.
 */
export async function requireOrgAdmin(cookies) {
	const u = await requireApprovedUser(cookies);
	const org = await getUserOrgInfo(u.uid);
	if (org.role !== 'admin' || org.status !== 'approved') {
		const e = new Error('Organization admin only');
		e.status = 403;
		throw e;
	}
	return { ...u, org };
}

/** Back-compat helper used by push subscribe route. */
export async function requireUid(cookies) {
	return (await requireUser(cookies)).uid;
}
