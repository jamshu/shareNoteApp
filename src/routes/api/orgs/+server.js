// Public (pre-auth, used on the signup screen):
//   GET /api/orgs                 -> { ok, orgs: [{id, name}] }  organizations to join
//   GET /api/orgs?invite=<token>  -> { ok, org: {id, name} }     resolve an invite link
// Only exposes org names — no member data. Only companies provisioned by this
// app (they carry an invite token) are listed.
import { json } from '@sveltejs/kit';
import { assertConfigured, adminExecute } from '$lib/server/odoo.js';

export const prerender = false;

export async function GET({ url }) {
	try {
		assertConfigured();
		const invite = url.searchParams.get('invite');
		if (invite) {
			const rows = await adminExecute('res.company', 'search_read', [
				[['x_studio_invite_token', '=', invite]]
			], { fields: ['name'], limit: 1 });
			if (!rows.length) return json({ ok: false, error: 'Invalid invite link' }, { status: 404 });
			return json({ ok: true, org: { id: rows[0].id, name: rows[0].name } });
		}
		const rows = await adminExecute('res.company', 'search_read', [
			[['x_studio_invite_token', '!=', false]]
		], { fields: ['name'], order: 'name asc' });
		return json({ ok: true, orgs: rows.map((r) => ({ id: r.id, name: r.name })) });
	} catch (e) {
		return json({ ok: false, error: e?.message || 'Failed' }, { status: e?.status || 500 });
	}
}
