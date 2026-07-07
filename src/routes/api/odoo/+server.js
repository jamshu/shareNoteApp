// Data proxy. Every call runs as the LOGGED-IN user via their Odoo web session
// (not the admin key) — Odoo record rules enforce note visibility and the
// owner-edit/contribute permission. The proxy adds: model whitelist, org
// approval gate, company hard-scoping, and push notifications on share/comment.
import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { assertConfigured, sessionCallKw, adminExecute } from '$lib/server/odoo.js';
import { requireApprovedUser } from '$lib/server/auth.js';
import { clearSessionCookie, refreshSessionCookie } from '$lib/server/session.js';
import { notifyNoteShared, notifyComment } from '$lib/server/notify.js';

export const prerender = false;

// body: { action: create|search|update|delete, model: notes|groups|comments, data }
const MODELS = () => ({
	notes: env.ODOO_MODEL || 'x_notes',
	groups: 'x_follower_group',
	comments: 'x_note_comment'
});

const stripHtml = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

/** Followers a note resolves to right now (direct + via groups) — for share diffing. */
async function currentFollowerSet(model, noteId) {
	const [note] = await adminExecute(model, 'read', [[noteId]], {
		fields: ['x_studio_follower_ids', 'x_studio_group_ids']
	});
	const set = new Set(note?.x_studio_follower_ids || []);
	if (note?.x_studio_group_ids?.length) {
		const groups = await adminExecute('x_follower_group', 'read', [note.x_studio_group_ids], {
			fields: ['x_studio_member_ids']
		});
		for (const g of groups) for (const m of g.x_studio_member_ids || []) set.add(m);
	}
	return set;
}

export async function POST({ request, cookies }) {
	try {
		assertConfigured();
		const { uid, sid, ctx } = await requireApprovedUser(cookies);

		const { action, model: modelKey = 'notes', data } = await request.json();
		const MODEL = MODELS()[modelKey];
		if (!MODEL) return json({ success: false, error: 'Invalid model' }, { status: 400 });

		// org role/status ride in the ctx cookie but are not Odoo context keys
		const { orgRole, orgStatus, ...odooCtx } = ctx;
		const companyId = odooCtx.allowed_company_ids?.[0] ?? null;

		const call = async (m, method, args, kwargs = {}) => {
			const { result, sessionId } = await sessionCallKw(sid, m, method, args, {
				...kwargs,
				context: odooCtx
			});
			refreshSessionCookie(cookies, sessionId, sid);
			return result;
		};

		switch (action) {
			case 'create': {
				const values = { ...data };
				if (companyId && !values.x_studio_company_id) values.x_studio_company_id = companyId;
				if (modelKey === 'comments' && !values.x_name) {
					values.x_name = stripHtml(values.x_studio_body).slice(0, 60) || 'Comment';
				}
				const id = await call(MODEL, 'create', [values]);

				// push notifications — best-effort, never fail the write
				try {
					if (modelKey === 'notes' && (values.x_studio_follower_ids || values.x_studio_group_ids)) {
						await notifyNoteShared(id, uid);
					} else if (modelKey === 'comments' && values.x_studio_note_id) {
						await notifyComment(values.x_studio_note_id, uid, stripHtml(values.x_studio_body));
					}
				} catch (e) {
					console.error('[notify] failed:', e?.message);
				}
				return json({ success: true, id });
			}

			case 'search': {
				const { domain = [], fields = [], order, limit } = data || {};
				// Hard-scope to the user's own tenant so a loose/misconfigured record
				// rule can never leak another company's rows into the app.
				const scope = companyId
					? [['x_studio_company_id', '=', companyId]]
					: [['create_uid', '=', uid]];
				// Visibility hard-scope: notes/comments are private to owner +
				// followers + group members even if the Odoo record rules are loose.
				if (modelKey === 'notes') {
					scope.push(
						'|', '|',
						['create_uid', '=', uid],
						['x_studio_follower_ids', 'in', [uid]],
						['x_studio_group_ids.x_studio_member_ids', 'in', [uid]]
					);
				} else if (modelKey === 'comments') {
					scope.push(
						'|', '|',
						['x_studio_note_id.create_uid', '=', uid],
						['x_studio_note_id.x_studio_follower_ids', 'in', [uid]],
						['x_studio_note_id.x_studio_group_ids.x_studio_member_ids', 'in', [uid]]
					);
				}
				const kwargs = { fields };
				if (order) kwargs.order = order;
				if (limit) kwargs.limit = limit;
				return json({
					success: true,
					results: await call(MODEL, 'search_read', [[...scope, ...domain]], kwargs)
				});
			}

			case 'update': {
				const { id, values } = data;

				// diff followers before/after so only NEWLY shared users get pushed
				let before = null;
				if (
					modelKey === 'notes' &&
					(values.x_studio_follower_ids || values.x_studio_group_ids)
				) {
					before = await currentFollowerSet(MODEL, Number(id));
				}

				const result = await call(MODEL, 'write', [[Number(id)], values]);

				try {
					if (before) {
						const after = await currentFollowerSet(MODEL, Number(id));
						const added = [...after].filter((u) => !before.has(u));
						if (added.length) await notifyNoteShared(Number(id), uid, added);
					}
				} catch (e) {
					console.error('[notify] failed:', e?.message);
				}
				return json({ success: true, result });
			}

			case 'delete': {
				const { id } = data;
				return json({ success: true, result: await call(MODEL, 'unlink', [[Number(id)]]) });
			}

			default:
				return json({ success: false, error: 'Invalid action' }, { status: 400 });
		}
	} catch (error) {
		const status = error?.status || 500;
		if (status === 401) clearSessionCookie(cookies); // expired session -> force re-login
		console.error('Odoo API Error:', error);
		return json(
			{ success: false, error: error instanceof Error ? error.message : 'Unknown error' },
			{ status }
		);
	}
}
