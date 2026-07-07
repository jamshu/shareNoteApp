// Save/remove a device push subscription. x_push_subscription is written with
// the admin key only (no user access rights on the model). Upsert keyed by
// endpoint — endpoints are unique per browser/device subscription.
import { json } from '@sveltejs/kit';
import { requireUid } from '$lib/server/auth.js';
import { adminExecute } from '$lib/server/odoo.js';

export const prerender = false;

const SUB_MODEL = 'x_push_subscription';

export async function POST({ request, cookies }) {
	try {
		const uid = await requireUid(cookies);
		const { endpoint, keys } = (await request.json()) ?? {};
		if (!endpoint || !keys?.p256dh || !keys?.auth) {
			return json({ ok: false, error: 'Invalid subscription data' }, { status: 400 });
		}
		const existing = await adminExecute(SUB_MODEL, 'search', [
			[['x_studio_endpoint', '=', endpoint]]
		]);
		if (existing.length) await adminExecute(SUB_MODEL, 'unlink', [existing]);
		await adminExecute(SUB_MODEL, 'create', [{
			x_name: `push u${uid} ${endpoint.slice(-16)}`,
			x_studio_user_id: uid,
			x_studio_endpoint: endpoint,
			x_studio_keys_p256dh: keys.p256dh,
			x_studio_keys_auth: keys.auth
		}]);
		return json({ ok: true });
	} catch (e) {
		console.error('[push/subscribe] POST failed:', e?.message);
		return json({ ok: false, error: e?.message }, { status: e?.status || 500 });
	}
}

export async function DELETE({ request, cookies }) {
	try {
		await requireUid(cookies);
		const { endpoint } = (await request.json()) ?? {};
		if (!endpoint) return json({ ok: false, error: 'endpoint required' }, { status: 400 });
		const ids = await adminExecute(SUB_MODEL, 'search', [
			[['x_studio_endpoint', '=', endpoint]]
		]);
		if (ids.length) await adminExecute(SUB_MODEL, 'unlink', [ids]);
		return json({ ok: true });
	} catch (e) {
		return json({ ok: false, error: e?.message }, { status: e?.status || 500 });
	}
}
