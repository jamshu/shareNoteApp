// Comment attachments, via standard ir.attachment linked to x_note_comment.
// Runs as the user's own session — Odoo only serves attachments on records the
// user can read (note owner / follower / group member).
//   POST { commentId, name, mimetype, dataBase64 }  -> { ok, id }
//   GET  ?commentIds=1,2,3                          -> { ok, attachments: [...] }
// Note: JSON body through Vercel serverless caps uploads around ~4MB.
import { json } from '@sveltejs/kit';
import { assertConfigured, sessionCallKw } from '$lib/server/odoo.js';
import { requireApprovedUser } from '$lib/server/auth.js';
import { clearSessionCookie, refreshSessionCookie } from '$lib/server/session.js';

export const prerender = false;

const COMMENT_MODEL = 'x_note_comment';

async function userCall(cookies, sid, ctx, model, method, args, kwargs = {}) {
	const { orgRole, orgStatus, ...odooCtx } = ctx;
	const { result, sessionId } = await sessionCallKw(sid, model, method, args, {
		...kwargs,
		context: odooCtx
	});
	refreshSessionCookie(cookies, sessionId, sid);
	return result;
}

export async function POST({ request, cookies }) {
	try {
		assertConfigured();
		const { sid, ctx } = await requireApprovedUser(cookies);
		const { commentId, name, mimetype, dataBase64 } = await request.json();
		if (!commentId || !name || !dataBase64) {
			return json({ ok: false, error: 'commentId, name and dataBase64 required' }, { status: 400 });
		}
		const id = await userCall(cookies, sid, ctx, 'ir.attachment', 'create', [{
			name,
			mimetype: mimetype || 'application/octet-stream',
			datas: dataBase64,
			res_model: COMMENT_MODEL,
			res_id: Number(commentId)
		}]);
		return json({ ok: true, id });
	} catch (e) {
		if (e?.status === 401) clearSessionCookie(cookies);
		return json({ ok: false, error: e?.message || 'Upload failed' }, { status: e?.status || 500 });
	}
}

export async function GET({ url, cookies }) {
	try {
		assertConfigured();
		const { sid, ctx } = await requireApprovedUser(cookies);
		const ids = (url.searchParams.get('commentIds') || '')
			.split(',')
			.map(Number)
			.filter(Boolean);
		if (!ids.length) return json({ ok: true, attachments: [] });
		const rows = await userCall(cookies, sid, ctx, 'ir.attachment', 'search_read', [
			[
				['res_model', '=', COMMENT_MODEL],
				['res_id', 'in', ids]
			]
		], { fields: ['name', 'mimetype', 'res_id', 'file_size'] });
		return json({
			ok: true,
			attachments: rows.map((r) => ({
				id: r.id,
				name: r.name,
				mimetype: r.mimetype,
				commentId: r.res_id,
				size: r.file_size
			}))
		});
	} catch (e) {
		if (e?.status === 401) clearSessionCookie(cookies);
		return json({ ok: false, error: e?.message || 'Failed' }, { status: e?.status || 500 });
	}
}
