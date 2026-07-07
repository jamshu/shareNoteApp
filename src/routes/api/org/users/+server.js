// Approved users of the caller's organization — the share/follower picker.
// Admin-key read (a member's own session can't browse res.users), but scoped to
// the caller's company and only id/name returned.
import { json } from '@sveltejs/kit';
import { requireApprovedUser } from '$lib/server/auth.js';
import { adminExecute } from '$lib/server/odoo.js';

export const prerender = false;

export async function GET({ cookies }) {
	try {
		const { uid, ctx } = await requireApprovedUser(cookies);
		const companyId = ctx.allowed_company_ids?.[0];
		if (!companyId) return json({ ok: false, error: 'No organization' }, { status: 400 });
		const rows = await adminExecute('res.users', 'search_read', [
			[
				['company_id', '=', companyId],
				['x_studio_org_status', '=', 'approved']
			]
		], { fields: ['name', 'login'], order: 'name asc' });
		return json({
			ok: true,
			users: rows
				.filter((r) => r.id !== uid)
				.map((r) => ({ id: r.id, name: r.name, email: r.login }))
		});
	} catch (e) {
		return json({ ok: false, error: e?.message || 'Failed' }, { status: e?.status || 500 });
	}
}
