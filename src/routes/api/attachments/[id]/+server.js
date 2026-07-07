// Download one attachment as the logged-in user (access enforced by Odoo).
import { assertConfigured, sessionCallKw } from '$lib/server/odoo.js';
import { requireApprovedUser } from '$lib/server/auth.js';
import { refreshSessionCookie } from '$lib/server/session.js';

export const prerender = false;

export async function GET({ params, cookies }) {
	try {
		assertConfigured();
		const { sid, ctx } = await requireApprovedUser(cookies);
		const { orgRole, orgStatus, ...odooCtx } = ctx;
		const { result, sessionId } = await sessionCallKw(
			sid,
			'ir.attachment',
			'read',
			[[Number(params.id)], ['name', 'mimetype', 'datas']],
			{ context: odooCtx }
		);
		refreshSessionCookie(cookies, sessionId, sid);
		const att = result?.[0];
		if (!att?.datas) return new Response('Not found', { status: 404 });
		const bytes = Buffer.from(att.datas, 'base64');
		return new Response(bytes, {
			headers: {
				'Content-Type': att.mimetype || 'application/octet-stream',
				'Content-Disposition': `inline; filename="${encodeURIComponent(att.name || 'file')}"`,
				'Cache-Control': 'private, max-age=3600'
			}
		});
	} catch (e) {
		return new Response(e?.message || 'Failed', { status: e?.status || 500 });
	}
}
