// Server-only Odoo helpers. Two auth contexts:
//   1. ADMIN (execute_kw with the API key) — used ONLY to create a company +
//      user at signup. Requires ODOO_USERNAME to be an Odoo administrator.
//   2. USER SESSION (web session cookie) — every data call runs as the logged-in
//      user, so Odoo's multi-company record rules isolate each tenant's data.
import { env } from '$env/dynamic/private';

const baseUrl = () => (env.ODOO_URL || '').replace(/\/$/, '');
export const getModel = () => env.ODOO_MODEL;

export function assertConfigured() {
	if (!env.ODOO_URL || !env.ODOO_DB || !env.ODOO_USERNAME || !env.ODOO_API_KEY || !env.ODOO_MODEL) {
		throw new Error(
			'Odoo is not configured. Set ODOO_URL, ODOO_DB, ODOO_USERNAME, ODOO_API_KEY, ODOO_MODEL.'
		);
	}
}

/** Low-level JSON-RPC POST. Returns { result, setCookie[] }. */
async function rpc(path, params, cookie) {
	const headers = { 'Content-Type': 'application/json' };
	if (cookie) headers.cookie = cookie;
	const res = await fetch(`${baseUrl()}${path}`, {
		method: 'POST',
		headers,
		body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params, id: Date.now() })
	});
	const setCookie =
		typeof res.headers.getSetCookie === 'function'
			? res.headers.getSetCookie()
			: res.headers.get('set-cookie')
				? [res.headers.get('set-cookie')]
				: [];
	const data = await res.json();
	if (data.error) {
		const err = data.error;
		const e = new Error(err.data?.message || err.message || 'Odoo error');
		// Odoo raises code 100 / SessionExpiredException when the session is dead.
		if (err.code === 100 || /SessionExpired|session expired/i.test(err.data?.name || err.message || '')) {
			e.status = 401;
		}
		throw e;
	}
	return { result: data.result, setCookie };
}

function parseSessionId(setCookieArr) {
	for (const c of setCookieArr || []) {
		const m = /^\s*session_id=([^;]+)/.exec(c);
		if (m) return m[1];
	}
	return null;
}

/* ------------------------------ admin context ----------------------------- */

let adminUid = null;
let _adminLoginPromise = null;

async function service(serviceName, method, args) {
	const res = await fetch(`${baseUrl()}/jsonrpc`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			method: 'call',
			params: { service: serviceName, method, args },
			id: Date.now()
		})
	});
	const data = await res.json();
	if (data.error) throw new Error(data.error.data?.message || data.error.message || 'Odoo error');
	return data.result;
}

async function adminLogin() {
	if (adminUid) return adminUid;
	if (!_adminLoginPromise) {
		_adminLoginPromise = service('common', 'login', [env.ODOO_DB, env.ODOO_USERNAME, env.ODOO_API_KEY])
			.then(uid => {
				if (!uid) throw new Error('Admin (API) authentication failed — check ODOO_USERNAME / ODOO_API_KEY');
				adminUid = uid;
				return uid;
			})
			.finally(() => { _adminLoginPromise = null; });
	}
	return _adminLoginPromise;
}

/**
 * Domain limiting notes to what `uid` may see: tenant hard-scope plus
 * owner OR direct follower OR member of a shared group. Kept app-side so a
 * loose/misconfigured Odoo record rule can never leak rows.
 */
export function noteVisibilityDomain(uid, companyId) {
	const scope = companyId
		? [['x_studio_company_id', '=', companyId]]
		: [['create_uid', '=', uid]];
	scope.push(
		'|', '|',
		['create_uid', '=', uid],
		['x_studio_follower_ids', 'in', [uid]],
		['x_studio_group_ids.x_studio_member_ids', 'in', [uid]]
	);
	return scope;
}

export async function adminExecute(model, method, args = [], kwargs = {}) {
	const uid = await adminLogin();
	return service('object', 'execute_kw', [
		env.ODOO_DB,
		uid,
		env.ODOO_API_KEY,
		model,
		method,
		args,
		kwargs
	]);
}

/** Create the res.users record (internal user group), with dup/retry handling. */
async function createUser({ name, email, password }) {
	const vals = {
		name: name || email,
		login: email,
		email,
		password
	};
	try {
		const gid = await adminExecute('ir.model.data', 'xmlid_to_res_id', ['base.group_user', false]);
		if (gid) vals.groups_id = [[6, 0, [gid]]];
	} catch {
		/* fall back to Odoo default groups */
	}

	let _lastUserErr;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			return await adminExecute('res.users', 'create', [vals]);
		} catch (e) {
			if (/transaction.*aborted|deadlock|serialize|could not obtain/i.test(e.message)) {
				_lastUserErr = e;
				await new Promise(r => setTimeout(r, 150 * (attempt + 1)));
				continue;
			}
			if (/login.*already|already.*registered|duplicate|unique|in use/i.test(e.message)) {
				const er = new Error('That email is already registered');
				er.status = 409;
				throw er;
			}
			throw e;
		}
	}
	throw _lastUserErr;
}

/** Assign company + org role/status; on failure delete the user (and company if we made it). */
async function assignCompany(userId, companyId, { role, status, ownCompany = false }) {
	try {
		await adminExecute('res.users', 'write', [[userId], {
			company_id: companyId,
			company_ids: [[6, 0, [companyId]]],
			x_studio_org_role: role,
			x_studio_org_status: status
		}]);
	} catch (e) {
		try { await adminExecute('res.users', 'unlink', [[userId]]); } catch {}
		if (ownCompany) {
			try { await adminExecute('res.company', 'unlink', [[companyId]]); } catch {}
		}
		throw e;
	}
}

/**
 * Signup, three modes:
 *  - create: new organization; user becomes its admin (approved), invite token generated.
 *  - invite: token from an invite link resolves the organization; user auto-approved member.
 *  - join:   user picked an existing organization; member, pending until admin approves.
 */
export async function signupUser({ name, email, password, org }) {
	const { mode, orgName, inviteToken, companyId: chosenCompanyId } = org || {};

	if (mode === 'create') {
		if (!orgName) { const e = new Error('Organization name is required'); e.status = 400; throw e; }
		const userId = await createUser({ name, email, password });
		let companyId;
		try {
			companyId = await adminExecute('res.company', 'create', [{
				name: orgName,
				x_studio_invite_token: crypto.randomUUID()
			}]);
		} catch (e) {
			try { await adminExecute('res.users', 'unlink', [[userId]]); } catch {}
			if (/unique|duplicate|already exists/i.test(e.message)) {
				const er = new Error('An organization with that name already exists');
				er.status = 409;
				throw er;
			}
			throw e;
		}
		await assignCompany(userId, companyId, { role: 'admin', status: 'approved', ownCompany: true });
		return { userId, companyId, status: 'approved' };
	}

	if (mode === 'invite') {
		if (!inviteToken) { const e = new Error('Invite token missing'); e.status = 400; throw e; }
		const companies = await adminExecute('res.company', 'search', [
			[['x_studio_invite_token', '=', inviteToken]]
		]);
		if (!companies.length) { const e = new Error('Invalid invite link'); e.status = 404; throw e; }
		const userId = await createUser({ name, email, password });
		await assignCompany(userId, companies[0], { role: 'member', status: 'approved' });
		return { userId, companyId: companies[0], status: 'approved' };
	}

	if (mode === 'join') {
		const cid = Number(chosenCompanyId);
		if (!cid) { const e = new Error('Choose an organization'); e.status = 400; throw e; }
		// only companies provisioned by this app (they carry an invite token) are joinable
		const valid = await adminExecute('res.company', 'search', [
			[['id', '=', cid], ['x_studio_invite_token', '!=', false]]
		]);
		if (!valid.length) { const e = new Error('Unknown organization'); e.status = 404; throw e; }
		const userId = await createUser({ name, email, password });
		await assignCompany(userId, cid, { role: 'member', status: 'pending' });
		return { userId, companyId: cid, status: 'pending' };
	}

	const e = new Error('Invalid signup mode');
	e.status = 400;
	throw e;
}

/**
 * Org role/status/company for a user, read with the admin key (record rules on
 * res.users may hide these Studio fields from the user's own session).
 * Includes the org invite token for admins so the UI can render the invite link.
 */
export async function getUserOrgInfo(uid) {
	const [u] = await adminExecute('res.users', 'read', [[uid]], {
		fields: ['name', 'login', 'company_id', 'x_studio_org_role', 'x_studio_org_status']
	});
	if (!u) { const e = new Error('User not found'); e.status = 404; throw e; }
	const info = {
		uid,
		name: u.name,
		email: u.login,
		companyId: u.company_id?.[0] ?? null,
		companyName: u.company_id?.[1] ?? null,
		role: u.x_studio_org_role || 'member',
		status: u.x_studio_org_status || 'pending'
	};
	if (info.role === 'admin' && info.companyId) {
		const [c] = await adminExecute('res.company', 'read', [[info.companyId]], {
			fields: ['x_studio_invite_token']
		});
		info.inviteToken = c?.x_studio_invite_token || null;
	}
	return info;
}

/* ------------------------------ user session ------------------------------ */

/** Authenticate a user; returns { sessionId, info }. */
export async function authenticateUser(login, password) {
	const { result, setCookie } = await rpc('/web/session/authenticate', {
		db: env.ODOO_DB,
		login,
		password
	});
	if (!result || !result.uid) {
		const e = new Error('Invalid email or password');
		e.status = 401;
		throw e;
	}
	const sessionId = parseSessionId(setCookie);
	if (!sessionId) throw new Error('Odoo did not return a session');
	return { sessionId, info: result };
}

export async function sessionInfo(sessionId) {
	const { result, setCookie } = await rpc(
		'/web/session/get_session_info',
		{},
		`session_id=${sessionId}`
	);
	if (!result || !result.uid) {
		const e = new Error('Session expired');
		e.status = 401;
		throw e;
	}
	// Odoo may rotate the session id; surface it so callers can re-sync the cookie.
	return { result, sessionId: parseSessionId(setCookie) };
}

/**
 * Build the Odoo call context from an authenticate / get_session_info result:
 * { lang, tz, uid } from user_context, plus allowed_company_ids scoped to the
 * user's current company so multi-company record rules filter to this tenant.
 * Shape: { lang, tz, uid, allowed_company_ids: [companyId] }.
 */
export function buildSessionContext(info) {
	const base = info?.user_context && typeof info.user_context === 'object' ? info.user_context : {};
	const ctx = { ...base };
	const current = info?.user_companies?.current_company ?? info?.company_id ?? null;
	if (current) ctx.allowed_company_ids = [current];
	if (info?.uid != null && ctx.uid == null) ctx.uid = info.uid;
	return ctx;
}

export async function sessionCallKw(sessionId, model, method, args = [], kwargs = {}) {
	const { result, setCookie } = await rpc(
		'/web/dataset/call_kw',
		{ model, method, args, kwargs },
		`session_id=${sessionId}`
	);
	// Odoo may rotate the session id; surface it so callers can re-sync the cookie.
	return { result, sessionId: parseSessionId(setCookie) };
}

export async function destroySession(sessionId) {
	try {
		await rpc('/web/session/destroy', {}, `session_id=${sessionId}`);
	} catch {
		/* ignore — cookie is cleared regardless */
	}
}

/* ---------------------------- account deletion ---------------------------- */

/**
 * Hard-delete a user and everything they own: their notes (with all comments on
 * them), their comments on other notes, groups they created, push subscriptions,
 * and follower/group memberships. Authorization is the caller's responsibility.
 */
export async function deleteUserAccount(uid) {
	const NOTES = env.ODOO_MODEL || 'x_notes';

	// drop them from follower lists and group memberships
	const followed = await adminExecute(NOTES, 'search', [[['x_studio_follower_ids', 'in', [uid]]]]);
	if (followed.length) {
		await adminExecute(NOTES, 'write', [followed, { x_studio_follower_ids: [[3, uid]] }]);
	}
	const memberOf = await adminExecute('x_follower_group', 'search', [
		[['x_studio_member_ids', 'in', [uid]]]
	]);
	if (memberOf.length) {
		await adminExecute('x_follower_group', 'write', [memberOf, { x_studio_member_ids: [[3, uid]] }]);
	}

	// their notes, including everyone's comments on those notes
	const notes = await adminExecute(NOTES, 'search', [[['create_uid', '=', uid]]]);
	if (notes.length) {
		const noteComments = await adminExecute('x_note_comment', 'search', [
			[['x_studio_note_id', 'in', notes]]
		]);
		if (noteComments.length) await adminExecute('x_note_comment', 'unlink', [noteComments]);
		await adminExecute(NOTES, 'unlink', [notes]);
	}

	// their comments on other people's notes
	const comments = await adminExecute('x_note_comment', 'search', [[['create_uid', '=', uid]]]);
	if (comments.length) await adminExecute('x_note_comment', 'unlink', [comments]);

	// groups and push subscriptions they own
	const ownGroups = await adminExecute('x_follower_group', 'search', [[['create_uid', '=', uid]]]);
	if (ownGroups.length) await adminExecute('x_follower_group', 'unlink', [ownGroups]);
	const subs = await adminExecute('x_push_subscription', 'search', [
		[['x_studio_user_id', '=', uid]]
	]);
	if (subs.length) await adminExecute('x_push_subscription', 'unlink', [subs]);

	// reminders assigned to them (would block user unlink) and Odoo push devices
	// on their partner (would block partner unlink)
	const acts = await adminExecute('mail.activity', 'search', [[['user_id', '=', uid]]]);
	if (acts.length) await adminExecute('mail.activity', 'unlink', [acts]);

	// finally the user itself, plus its partner (best-effort — may be referenced)
	const [u] = await adminExecute('res.users', 'read', [[uid]], { fields: ['partner_id'] });
	if (u?.partner_id?.[0]) {
		const devices = await adminExecute('mail.push.device', 'search', [
			[['partner_id', '=', u.partner_id[0]]]
		]);
		if (devices.length) await adminExecute('mail.push.device', 'unlink', [devices]);
	}
	await adminExecute('res.users', 'unlink', [[uid]]);
	if (u?.partner_id?.[0]) {
		try {
			await adminExecute('res.partner', 'unlink', [[u.partner_id[0]]]);
		} catch {
			/* partner referenced elsewhere — leave it */
		}
	}
}
