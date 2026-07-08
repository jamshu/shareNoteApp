// Org admin: membership management.
//   GET  -> { ok, pending: [{id, name, email}], members: [{id, name, email, role}] }
//   POST { userId, action: 'approve' | 'reject' | 'remove' }
//         reject deletes a pending user; remove hard-deletes a member + their data
// Admin-key writes, gated by requireOrgAdmin (role re-read server-side).
import { json } from '@sveltejs/kit';
import { requireOrgAdmin } from '$lib/server/auth.js';
import { adminExecute, deleteUserAccount } from '$lib/server/odoo.js';

export const prerender = false;

export async function GET({ cookies }) {
	try {
		const { uid, org } = await requireOrgAdmin(cookies);
		const rows = await adminExecute('res.users', 'search_read', [
			[
				['company_id', '=', org.companyId],
				['x_studio_org_status', '=', 'pending']
			]
		], { fields: ['name', 'login'] });
		const members = await adminExecute('res.users', 'search_read', [
			[
				['company_id', '=', org.companyId],
				['x_studio_org_status', '=', 'approved'],
				['id', '!=', uid]
			]
		], { fields: ['name', 'login', 'x_studio_org_role'], order: 'name asc' });
		return json({
			ok: true,
			pending: rows.map((r) => ({ id: r.id, name: r.name, email: r.login })),
			members: members.map((r) => ({
				id: r.id,
				name: r.name,
				email: r.login,
				role: r.x_studio_org_role || 'member'
			}))
		});
	} catch (e) {
		return json({ ok: false, error: e?.message || 'Failed' }, { status: e?.status || 500 });
	}
}

export async function POST({ request, cookies }) {
	try {
		const { uid: callerUid, org } = await requireOrgAdmin(cookies);
		const { userId, action } = await request.json();
		const uid = Number(userId);
		if (!uid || !['approve', 'reject', 'remove'].includes(action)) {
			return json({ ok: false, error: 'userId and action required' }, { status: 400 });
		}

		if (action === 'remove') {
			if (uid === callerUid) {
				return json({ ok: false, error: 'Use account deletion to remove yourself' }, { status: 400 });
			}
			const [t] = await adminExecute('res.users', 'search_read', [
				[
					['id', '=', uid],
					['company_id', '=', org.companyId]
				]
			], { fields: ['x_studio_org_role'] });
			if (!t) return json({ ok: false, error: 'User not found' }, { status: 404 });
			if (t.x_studio_org_role === 'admin') {
				return json({ ok: false, error: 'Cannot remove another admin' }, { status: 403 });
			}
			await deleteUserAccount(uid);
			return json({ ok: true });
		}

		// target must be a pending member of THIS admin's org
		const target = await adminExecute('res.users', 'search', [
			[
				['id', '=', uid],
				['company_id', '=', org.companyId],
				['x_studio_org_status', '=', 'pending']
			]
		]);
		if (!target.length) return json({ ok: false, error: 'User not found' }, { status: 404 });

		if (action === 'approve') {
			await adminExecute('res.users', 'write', [[uid], { x_studio_org_status: 'approved' }]);
		} else {
			await adminExecute('res.users', 'unlink', [[uid]]);
		}
		return json({ ok: true });
	} catch (e) {
		return json({ ok: false, error: e?.message || 'Failed' }, { status: e?.status || 500 });
	}
}
