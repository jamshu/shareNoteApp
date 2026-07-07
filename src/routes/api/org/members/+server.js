// Org admin: membership management.
//   GET  -> { ok, pending: [{id, name, email}] }   users waiting for approval
//   POST { userId, action: 'approve' | 'reject' }  reject deletes the user
// Admin-key writes, gated by requireOrgAdmin (role re-read server-side).
import { json } from '@sveltejs/kit';
import { requireOrgAdmin } from '$lib/server/auth.js';
import { adminExecute } from '$lib/server/odoo.js';

export const prerender = false;

export async function GET({ cookies }) {
	try {
		const { org } = await requireOrgAdmin(cookies);
		const rows = await adminExecute('res.users', 'search_read', [
			[
				['company_id', '=', org.companyId],
				['x_studio_org_status', '=', 'pending']
			]
		], { fields: ['name', 'login'] });
		return json({
			ok: true,
			pending: rows.map((r) => ({ id: r.id, name: r.name, email: r.login }))
		});
	} catch (e) {
		return json({ ok: false, error: e?.message || 'Failed' }, { status: e?.status || 500 });
	}
}

export async function POST({ request, cookies }) {
	try {
		const { org } = await requireOrgAdmin(cookies);
		const { userId, action } = await request.json();
		const uid = Number(userId);
		if (!uid || !['approve', 'reject'].includes(action)) {
			return json({ ok: false, error: 'userId and action required' }, { status: 400 });
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
