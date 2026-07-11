// Note reminders, built on Odoo defaults:
//  - one mail.activity per assignee (Odoo emails the assignee at creation and
//    tracks the to-do in its systray/chatter),
//  - one mail.scheduled.message per reminder, posted by Odoo's "Mail: Post
//    scheduled messages" cron at the due datetime — assignees then get an email
//    (per their notification preference) and an Odoo native web push.
// Access checks run as the user's session; mail.* reads/writes use the admin
// key (regular users can't manage other users' activities), gated app-side.
import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import {
	assertConfigured,
	adminExecute,
	sessionCallKw,
	noteVisibilityDomain
} from '$lib/server/odoo.js';
import { requireApprovedUser } from '$lib/server/auth.js';
import { refreshSessionCookie } from '$lib/server/session.js';
import { noteAudience } from '$lib/server/notify.js';
import { sendToUser } from '$lib/server/push.js';

export const prerender = false;

const NOTES = () => env.ODOO_MODEL || 'x_notes';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ir.model id of the notes model + the To-Do activity type. Cached per cold
// start. NB: Odoo 19 removed xmlid_to_res_id — resolve via ir.model.data.
let _refs = null;
async function mailRefs() {
	if (_refs) return _refs;
	const [modelId] = await adminExecute('ir.model', 'search', [[['model', '=', NOTES()]]]);
	if (!modelId) throw new Error(`ir.model not found for ${NOTES()}`);
	const [todo] = await adminExecute('ir.model.data', 'search_read', [
		[['module', '=', 'mail'], ['name', '=', 'mail_activity_data_todo']]
	], { fields: ['res_id'] });
	// OdooBot partner: scheduled messages are authored by the bot, because Odoo
	// never notifies a message's own author — a creator-authored reminder would
	// silently skip the creator (self-reminders got no due-date email)
	const [root] = await adminExecute('ir.model.data', 'search_read', [
		[['module', '=', 'base'], ['name', '=', 'partner_root']]
	], { fields: ['res_id'] });
	_refs = { modelId, todoTypeId: todo?.res_id || false, botPartnerId: root?.res_id || false };
	return _refs;
}

/** 404 unless the caller's own session can see the note. Returns caller info. */
async function assertNoteAccess(cookies, noteId) {
	const { uid, sid, ctx } = await requireApprovedUser(cookies);
	const { orgRole, orgStatus, ...odooCtx } = ctx;
	const companyId = odooCtx.allowed_company_ids?.[0] ?? null;
	const { result: count, sessionId } = await sessionCallKw(
		sid,
		NOTES(),
		'search_count',
		[[['id', '=', noteId], ...noteVisibilityDomain(uid, companyId)]],
		{ context: odooCtx }
	);
	refreshSessionCookie(cookies, sessionId, sid);
	if (!count) {
		const e = new Error('Note not found or not shared with you');
		e.status = 404;
		throw e;
	}
	return { uid, sid, odooCtx };
}

/** id -> { partnerId, name } for the given user ids. */
async function usersInfo(userIds) {
	const users = await adminExecute('res.users', 'read', [userIds], {
		fields: ['partner_id', 'name']
	});
	return Object.fromEntries(
		users.map((u) => [u.id, { partnerId: u.partner_id?.[0], name: u.name }])
	);
}

// Odoo datetimes are naive UTC "YYYY-MM-DD HH:MM:SS"
const toOdooDt = (iso) => new Date(iso).toISOString().slice(0, 19).replace('T', ' ');

export async function GET({ url, cookies }) {
	try {
		assertConfigured();
		const noteId = Number(url.searchParams.get('noteId'));
		if (!noteId) return json({ ok: false, error: 'noteId required' }, { status: 400 });
		await assertNoteAccess(cookies, noteId);

		const a = await noteAudience(noteId);
		const memberIds = [...new Set([a.ownerId, ...a.followerIds])].filter(Boolean);
		const users = memberIds.length
			? await adminExecute('res.users', 'read', [memberIds], { fields: ['name', 'partner_id'] })
			: [];
		const byPartner = Object.fromEntries(users.map((u) => [u.partner_id?.[0], u]));

		const [messages, activities] = await Promise.all([
			adminExecute('mail.scheduled.message', 'search_read', [
				[['model', '=', NOTES()], ['res_id', '=', noteId]]
			], { fields: ['scheduled_date', 'subject', 'partner_ids'], order: 'scheduled_date asc' }),
			adminExecute('mail.activity', 'search_read', [
				[['res_model', '=', NOTES()], ['res_id', '=', noteId]]
			], { fields: ['user_id', 'date_deadline', 'summary', 'state', 'create_uid'], order: 'date_deadline asc' })
		]);

		return json({
			ok: true,
			reminders: messages.map((m) => ({
				id: m.id,
				when: m.scheduled_date,
				subject: m.subject,
				users: m.partner_ids.map((p) => byPartner[p]).filter(Boolean).map((u) => ({ id: u.id, name: u.name }))
			})),
			activities: activities.map((x) => ({
				id: x.id,
				userId: x.user_id?.[0] ?? null,
				userName: x.user_id?.[1] ?? '',
				deadline: x.date_deadline,
				summary: x.summary,
				state: x.state
			})),
			audience: users.map((u) => ({ id: u.id, name: u.name }))
		});
	} catch (e) {
		return json({ ok: false, error: e?.message }, { status: e?.status || 500 });
	}
}

export async function POST({ request, cookies, url }) {
	try {
		assertConfigured();
		const { noteId: rawId, userIds, when, summary = '' } = (await request.json()) ?? {};
		const noteId = Number(rawId);
		if (!noteId || !Array.isArray(userIds) || !userIds.length || !when) {
			return json({ ok: false, error: 'noteId, userIds and when are required' }, { status: 400 });
		}
		const due = new Date(when);
		if (Number.isNaN(due.getTime()) || due <= new Date()) {
			return json({ ok: false, error: 'Reminder must be in the future' }, { status: 400 });
		}
		const { uid, sid, odooCtx } = await assertNoteAccess(cookies, noteId);

		// only the note's audience (owner + followers + group members) is assignable
		const a = await noteAudience(noteId);
		const allowed = new Set([a.ownerId, ...a.followerIds]);
		const targets = [...new Set(userIds.map(Number))].filter((u) => allowed.has(u));
		if (!targets.length) {
			return json({ ok: false, error: 'No valid assignees — pick note followers' }, { status: 400 });
		}

		const refs = await mailRefs();
		const info = await usersInfo([...new Set([...targets, uid])]);
		const dt = toOdooDt(when);
		const title = summary.trim() || `Reminder: ${a.title}`;
		// subject doubles as the UI label and the email subject — carry the summary
		const subject = summary.trim() ? `Reminder: ${a.title} — ${summary.trim()}` : `Reminder: ${a.title}`;

		// activities as the user's own session so Odoo attributes "assigned by"
		// correctly; admin fallback when the session lacks mail.activity rights
		const vals = targets.map((u) => ({
			res_model_id: refs.modelId,
			res_id: noteId,
			user_id: u,
			date_deadline: dt.slice(0, 10),
			summary: title,
			activity_type_id: refs.todoTypeId
		}));
		try {
			const { sessionId } = await sessionCallKw(sid, 'mail.activity', 'create', [vals], {
				context: odooCtx
			});
			refreshSessionCookie(cookies, sessionId, sid);
		} catch {
			await adminExecute('mail.activity', 'create', [vals]);
		}

		// due-date notification: Odoo posts this on the note's chatter at `when`,
		// emailing + web-pushing the assignee partners. Authored by OdooBot, not
		// the creator — Odoo skips notifying a message's own author, which would
		// mute self-reminders. The body names the actual creator instead.
		const body =
			`<p>${esc(title)}</p>` +
			`<p>Reminder set by ${esc(info[uid]?.name || 'a follower')}.</p>` +
			`<p><a href="${url.origin}/note/${noteId}">Open "${esc(a.title)}" in ShareNote</a></p>`;
		const messageId = await adminExecute('mail.scheduled.message', 'create', [{
			model: NOTES(),
			res_id: noteId,
			author_id: refs.botPartnerId || info[uid]?.partnerId,
			partner_ids: [[6, 0, targets.map((u) => info[u]?.partnerId).filter(Boolean)]],
			subject,
			body,
			scheduled_date: dt,
			// post as a comment: Odoo web-pushes 'comment' messages to all
			// recipients, but 'notification' (the default) only to inbox-pref
			// users — our users are email-pref, so phones stayed silent
			notification_parameters: JSON.stringify({ message_type: 'comment' })
		}]);

		// heads-up push now — best-effort, never fail the write
		try {
			const others = targets.filter((u) => u !== uid);
			await Promise.allSettled(
				others.map((u) =>
					sendToUser(u, {
						title: `Reminder set on "${a.title}"`,
						body: `${title} — due ${dt}`,
						url: `/note/${noteId}`
					})
				)
			);
		} catch (e) {
			console.error('[reminders] push failed:', e?.message);
		}

		return json({ ok: true, messageId });
	} catch (e) {
		console.error('[reminders] POST failed:', e?.message);
		return json({ ok: false, error: e?.message }, { status: e?.status || 500 });
	}
}

export async function DELETE({ request, cookies }) {
	try {
		assertConfigured();
		const { noteId: rawId, messageId } = (await request.json()) ?? {};
		const noteId = Number(rawId);
		if (!noteId || !messageId) {
			return json({ ok: false, error: 'noteId and messageId required' }, { status: 400 });
		}
		await assertNoteAccess(cookies, noteId);

		// anyone who can see the note may cancel — scheduled messages are created
		// with the admin key, so create_uid can't identify the actual creator
		const [msg] = await adminExecute('mail.scheduled.message', 'read', [[Number(messageId)]], {
			fields: ['model', 'res_id', 'scheduled_date', 'partner_ids']
		});
		if (!msg || msg.model !== NOTES() || msg.res_id !== noteId) {
			return json({ ok: false, error: 'Reminder not found' }, { status: 404 });
		}

		// drop the activities created with this reminder (same note + deadline + assignees)
		if (msg.partner_ids?.length) {
			const acts = await adminExecute('mail.activity', 'search', [[
				['res_model', '=', NOTES()],
				['res_id', '=', noteId],
				['date_deadline', '=', String(msg.scheduled_date).slice(0, 10)],
				['user_id.partner_id', 'in', msg.partner_ids]
			]]);
			if (acts.length) await adminExecute('mail.activity', 'unlink', [acts]);
		}
		await adminExecute('mail.scheduled.message', 'unlink', [[Number(msg.id)]]);
		return json({ ok: true });
	} catch (e) {
		return json({ ok: false, error: e?.message }, { status: e?.status || 500 });
	}
}
