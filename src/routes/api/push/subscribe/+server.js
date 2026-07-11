// Save/remove a device push subscription. x_push_subscription is written with
// the admin key only (no user access rights on the model). Upsert keyed by
// endpoint — endpoints are unique per browser/device subscription.
//
// Web-push subscriptions are ALSO registered in Odoo's native mail.push.device
// so Odoo-originated notifications (e.g. scheduled reminder messages) reach app
// browsers. For that to work Odoo must sign pushes with the same VAPID key pair
// the browser subscribed under, so we claim Odoo's (unset) VAPID config params
// with the app's keys once. Native APNs/FCM rows (keys.auth 'ios'/'android'/
// 'fcm') are not web push — Odoo can't deliver those; they stay app-only.
import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { requireUid } from '$lib/server/auth.js';
import { adminExecute } from '$lib/server/odoo.js';

export const prerender = false;

const SUB_MODEL = 'x_push_subscription';
const NATIVE = new Set(['ios', 'android', 'fcm']);

// python's base64.urlsafe_b64decode requires padding; npm web-push keys have none
const b64pad = (s) => s + '='.repeat((4 - (s.length % 4)) % 4);

let _vapidClaimed = false;
async function claimOdooVapid() {
	if (_vapidClaimed) return;
	const pub = env.PUBLIC_VAPID_PUBLIC_KEY;
	const priv = env.VAPID_PRIVATE_KEY;
	if (pub && priv) {
		const existing = await adminExecute('ir.config_parameter', 'search', [
			[['key', 'in', ['mail.web_push_vapid_public_key', 'mail.web_push_vapid_private_key']]]
		]);
		// never overwrite — if Odoo already has keys, existing Odoo-side
		// subscriptions depend on them
		if (!existing.length) {
			await adminExecute('ir.config_parameter', 'set_param', [
				'mail.web_push_vapid_public_key', b64pad(pub)
			]);
			await adminExecute('ir.config_parameter', 'set_param', [
				'mail.web_push_vapid_private_key', b64pad(priv)
			]);
		}
	}
	_vapidClaimed = true;
}

async function upsertOdooDevice(uid, endpoint, keys) {
	await claimOdooVapid();
	const [u] = await adminExecute('res.users', 'read', [[uid]], { fields: ['partner_id'] });
	const partnerId = u?.partner_id?.[0];
	if (!partnerId) return;
	const existing = await adminExecute('mail.push.device', 'search', [
		[['endpoint', '=', endpoint]]
	]);
	if (existing.length) await adminExecute('mail.push.device', 'unlink', [existing]);
	await adminExecute('mail.push.device', 'create', [{
		partner_id: partnerId,
		endpoint,
		keys: JSON.stringify({ p256dh: keys.p256dh, auth: keys.auth })
	}]);
}

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
		if (!NATIVE.has(keys.auth)) {
			try {
				await upsertOdooDevice(uid, endpoint, keys);
			} catch (e) {
				// app push still works without the Odoo-side registration
				console.error('[push/subscribe] mail.push.device register failed:', e?.message);
			}
		}
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
		try {
			const devices = await adminExecute('mail.push.device', 'search', [
				[['endpoint', '=', endpoint]]
			]);
			if (devices.length) await adminExecute('mail.push.device', 'unlink', [devices]);
		} catch {
			/* best-effort */
		}
		return json({ ok: true });
	} catch (e) {
		return json({ ok: false, error: e?.message }, { status: e?.status || 500 });
	}
}
