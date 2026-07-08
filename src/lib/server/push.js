import webpush from 'web-push';
import { createSign } from 'node:crypto';
import { connect } from 'node:http2';
import { env } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';
import { adminExecute } from './odoo.js';

const SUB_MODEL = 'x_push_subscription';

// ─── VAPID ──────────────────────────────────────────────────────────────────

let vapidSet = false;
function ensureVapid() {
	if (vapidSet) return;
	let subject = (env.VAPID_SUBJECT || '').trim();
	if (subject && !/^(mailto:|https?:)/.test(subject)) {
		subject = subject.includes('@') ? `mailto:${subject}` : `https://${subject}`;
	}
	// $env/dynamic/private excludes PUBLIC_-prefixed vars — the key lives there
	const pub = (publicEnv.PUBLIC_VAPID_PUBLIC_KEY || env.VAPID_PUBLIC_KEY || '').trim();
	const priv = (env.VAPID_PRIVATE_KEY || '').trim();
	console.log(
		`[push] vapid setup: subject=${subject || 'MISSING'} pubLen=${pub.length} privLen=${priv.length}`
	);
	webpush.setVapidDetails(subject, pub, priv);
	vapidSet = true;
}

// ─── FCM HTTP v1 (Android — no firebase-admin, raw JWT + REST) ──────────────

let _serviceAccount = null;
function getServiceAccount() {
	if (_serviceAccount) return _serviceAccount;
	const raw = (env.FIREBASE_SERVICE_ACCOUNT || '').trim();
	if (!raw) return null;
	try {
		_serviceAccount = JSON.parse(raw);
		return _serviceAccount;
	} catch {
		console.error('[push] FIREBASE_SERVICE_ACCOUNT is not valid JSON');
		return null;
	}
}

function base64url(str) {
	return Buffer.from(str).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

let _fcmAccessToken = null;
let _fcmTokenExpiry = 0;

async function getFcmAccessToken() {
	if (_fcmAccessToken && Date.now() < _fcmTokenExpiry) return _fcmAccessToken;

	const sa = getServiceAccount();
	if (!sa) return null;

	const now = Math.floor(Date.now() / 1000);
	const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
	const payload = base64url(
		JSON.stringify({
			iss: sa.client_email,
			scope: 'https://www.googleapis.com/auth/firebase.messaging',
			aud: 'https://oauth2.googleapis.com/token',
			iat: now,
			exp: now + 3600
		})
	);

	const signer = createSign('RSA-SHA256');
	signer.update(`${header}.${payload}`);
	const sig = signer.sign(sa.private_key, 'base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

	const res = await fetch('https://oauth2.googleapis.com/token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'urn:ietf:params:oauth2:jwt-bearer',
			assertion: `${header}.${payload}.${sig}`
		})
	});

	if (!res.ok) {
		console.error('[push] FCM OAuth token exchange failed:', await res.text());
		return null;
	}

	const { access_token, expires_in } = await res.json();
	_fcmAccessToken = access_token;
	_fcmTokenExpiry = Date.now() + (expires_in - 60) * 1000;
	return _fcmAccessToken;
}

async function sendFCM(token, payload) {
	const sa = getServiceAccount();
	if (!sa) {
		console.warn('[push] FIREBASE_SERVICE_ACCOUNT not set — skipping Android push');
		return;
	}

	const accessToken = await getFcmAccessToken();
	if (!accessToken) return;

	const message = {
		message: {
			token,
			notification: { title: payload.title, body: payload.body },
			...(payload.url ? { data: { url: String(payload.url) } } : {}),
			android: {
				priority: 'high',
				notification: { channel_id: 'default' }
			}
		}
	};

	const res = await fetch(
		`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`,
		{
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${accessToken}`
			},
			body: JSON.stringify(message)
		}
	);

	if (!res.ok) {
		const body = await res.text();
		console.error(`[push] FCM send failed: status=${res.status} body=${body.slice(0, 200)}`);
		if (res.status === 404 || body.includes('UNREGISTERED') || body.includes('NOT_FOUND')) {
			await removeStaleSub(token);
		}
		if (res.status === 401) { _fcmAccessToken = null; _fcmTokenExpiry = 0; }
	}
}

// ─── APNs HTTP/2 (iOS — no Firebase, direct APNs) ───────────────────────────

let _apnsJwt = null;
let _apnsJwtExpiry = 0;

function getApnsJwt() {
	if (_apnsJwt && Date.now() < _apnsJwtExpiry) return _apnsJwt;

	const keyId = (env.APNS_KEY_ID || '').trim();
	const teamId = (env.APNS_TEAM_ID || '').trim();
	// Vercel may store newlines as \n — normalize
	const keyP8 = (env.APNS_KEY_P8 || '').trim().replace(/\\n/g, '\n');
	if (!keyId || !teamId || !keyP8) return null;

	const now = Math.floor(Date.now() / 1000);
	const header = base64url(JSON.stringify({ alg: 'ES256', kid: keyId }));
	const payload = base64url(JSON.stringify({ iss: teamId, iat: now }));

	const signer = createSign('SHA256');
	signer.update(`${header}.${payload}`);
	// ieee-p1363 converts DER → raw r||s required by JWT ES256
	const sig = signer.sign({ key: keyP8, dsaEncoding: 'ieee-p1363' }, 'base64url');

	_apnsJwt = `${header}.${payload}.${sig}`;
	_apnsJwtExpiry = Date.now() + 55 * 60 * 1000;
	return _apnsJwt;
}

function sendAPNs(deviceToken, payload) {
	const jwt = getApnsJwt();
	if (!jwt) {
		console.warn('[push] APNs env vars not set — skipping iOS push');
		return Promise.resolve();
	}

	const bundleId = (env.APNS_BUNDLE_ID || '').trim();
	const host = env.APNS_SANDBOX === 'true'
		? 'https://api.sandbox.push.apple.com'
		: 'https://api.push.apple.com';

	const body = JSON.stringify({
		aps: { alert: { title: payload.title, body: payload.body }, sound: 'default' },
		...(payload.url ? { url: String(payload.url) } : {})
	});

	return new Promise((resolve) => {
		const client = connect(host);
		client.on('error', (e) => {
			console.error('[push] APNs client error:', e.message);
			resolve();
		});

		const req = client.request({
			':method': 'POST',
			':path': `/3/device/${deviceToken.toLowerCase()}`,
			'authorization': `bearer ${jwt}`,
			'apns-topic': bundleId,
			'apns-push-type': 'alert',
			'apns-priority': '10',
			'content-type': 'application/json',
			'content-length': Buffer.byteLength(body)
		});

		req.write(body);
		req.end();

		let status;
		let respBody = '';
		req.on('response', (h) => { status = h[':status']; });
		req.on('data', (c) => { respBody += c; });
		req.on('end', () => {
			client.close();
			if (status !== 200) {
				console.error(`[push] APNs error: status=${status} body=${respBody.slice(0, 200)}`);
				if (status === 410) removeStaleSub(deviceToken);
				if (status === 403) { _apnsJwt = null; _apnsJwtExpiry = 0; }
			}
			resolve();
		});
		req.on('error', (e) => {
			client.close();
			console.error('[push] APNs request error:', e.message);
			resolve();
		});
	});
}

// ─── Shared ──────────────────────────────────────────────────────────────────

async function removeStaleSub(endpoint) {
	try {
		const ids = await adminExecute(SUB_MODEL, 'search', [[['x_studio_endpoint', '=', endpoint]]]);
		if (ids.length) await adminExecute(SUB_MODEL, 'unlink', [ids]);
	} catch {
		/* best-effort */
	}
}

/**
 * Route by keys.auth:
 *   'ios'               → APNs HTTP/2 direct
 *   'android' | 'fcm'  → FCM HTTP v1  (legacy 'fcm' kept for old records)
 *   anything else       → VAPID web push
 */
export async function sendPush(sub, payload) {
	const auth = sub.keys?.auth;
	if (auth === 'ios') { await sendAPNs(sub.endpoint, payload); return; }
	if (auth === 'android' || auth === 'fcm') { await sendFCM(sub.endpoint, payload); return; }
	try {
		ensureVapid();
		await webpush.sendNotification(sub, JSON.stringify(payload));
	} catch (err) {
		console.error(
			`[push] sendNotification failed: status=${err.statusCode} body=${err.body} msg=${err.message} endpoint=${sub.endpoint?.slice(0, 40)}`
		);
		if (err.statusCode === 404 || err.statusCode === 410) {
			await removeStaleSub(sub.endpoint);
		}
	}
}

/** Send to all devices registered for one user. */
export async function sendToUser(userId, payload) {
	const rows = await adminExecute(
		SUB_MODEL,
		'search_read',
		[[['x_studio_user_id', '=', userId]]],
		{ fields: ['x_studio_endpoint', 'x_studio_keys_p256dh', 'x_studio_keys_auth'] }
	);
	await Promise.allSettled(
		rows.map((r) =>
			sendPush(
				{
					endpoint: r.x_studio_endpoint,
					keys: { p256dh: r.x_studio_keys_p256dh, auth: r.x_studio_keys_auth }
				},
				payload
			)
		)
	);
}

/** Broadcast to all subscribed users. Returns subscriber count. */
export async function sendToAll(payload) {
	const rows = await adminExecute(SUB_MODEL, 'search_read', [[]], {
		fields: ['x_studio_user_id', 'x_studio_endpoint', 'x_studio_keys_p256dh', 'x_studio_keys_auth']
	});
	console.log(`[push] sendToAll: ${rows.length} subscription(s) found`);
	if (!rows.length) return 0;
	const results = await Promise.allSettled(
		rows.map((r) =>
			sendPush(
				{
					endpoint: r.x_studio_endpoint,
					keys: { p256dh: r.x_studio_keys_p256dh, auth: r.x_studio_keys_auth }
				},
				payload
			)
		)
	);
	const failed = results.filter((r) => r.status === 'rejected').length;
	if (failed) console.error(`[push] sendToAll: ${failed}/${rows.length} push(es) failed`);
	return rows.length;
}
