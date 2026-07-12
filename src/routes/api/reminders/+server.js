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

// recurring reminders pre-create every occurrence upfront (no cron to roll them)
const MAX_OCCURRENCES = 30;
const FREQUENCIES = new Set(['daily', 'weekly', 'monthly']);
function occurrenceDates(startIso, frequency, count) {
	const dates = [];
	const d = new Date(startIso);
	for (let i = 0; i < count; i++) {
		dates.push(d.toISOString().slice(0, 19).replace('T', ' '));
		if (frequency === 'daily') d.setUTCDate(d.getUTCDate() + 1);
		else if (frequency === 'weekly') d.setUTCDate(d.getUTCDate() + 7);
		// ponytail: JS month overflow rolls Jan 31 → Mar 3; fine for reminders
		else d.setUTCMonth(d.getUTCMonth() + 1);
	}
	return dates;
}

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
			], { fields: ['scheduled_date', 'subject', 'partner_ids', 'send_context'], order: 'scheduled_date asc' }),
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
				frequency: m.send_context?.sharenote_recur?.freq || '',
				seriesKey: m.send_context?.sharenote_recur?.key || '',
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
		const {
			noteId: rawId,
			userIds,
			when,
			summary = '',
			frequency = 'once',
			count = 1
		} = (await request.json()) ?? {};
		const noteId = Number(rawId);
		if (!noteId || !Array.isArray(userIds) || !userIds.length || !when) {
			return json({ ok: false, error: 'noteId, userIds and when are required' }, { status: 400 });
		}
		const due = new Date(when);
		if (Number.isNaN(due.getTime()) || due <= new Date()) {
			return json({ ok: false, error: 'Reminder must be in the future' }, { status: 400 });
		}
		const recurring = FREQUENCIES.has(frequency);
		const occurrences = recurring
			? Math.min(Math.max(Number(count) || 1, 1), MAX_OCCURRENCES)
			: 1;
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
		const dates = occurrenceDates(when, frequency, occurrences);
		const dt = dates[0];
		const title = summary.trim() || `Reminder: ${a.title}`;
		// subject doubles as the UI label and the email subject — carry the summary
		const subject = summary.trim() ? `Reminder: ${a.title} — ${summary.trim()}` : `Reminder: ${a.title}`;

		// activities as the user's own session so Odoo attributes "assigned by"
		// correctly; admin fallback when the session lacks mail.activity rights.
		// Only the FIRST occurrence sends Odoo's assignment email; the rest are
		// created with mail_activity_quick_update, which suppresses it — a daily
		// ×30 reminder must not burst 30 emails per assignee.
		const activityVals = (date) =>
			targets.map((u) => ({
				res_model_id: refs.modelId,
				res_id: noteId,
				user_id: u,
				date_deadline: date.slice(0, 10),
				summary: title,
				activity_type_id: refs.todoTypeId
			}));
		const createActivities = async (vals, quiet) => {
			const context = quiet ? { ...odooCtx, mail_activity_quick_update: true } : odooCtx;
			try {
				const { sessionId } = await sessionCallKw(sid, 'mail.activity', 'create', [vals], {
					context
				});
				refreshSessionCookie(cookies, sessionId, sid);
			} catch {
				await adminExecute('mail.activity', 'create', [vals], { context });
			}
		};
		await createActivities(activityVals(dates[0]), false);
		if (dates.length > 1) {
			await createActivities(dates.slice(1).flatMap(activityVals), true);
		}

		// due-date notification: Odoo posts this on the note's chatter at `when`,
		// emailing + web-pushing the assignee partners. Authored by OdooBot, not
		// the creator — Odoo skips notifying a message's own author, which would
		// mute self-reminders. The body names the actual creator instead.
		const body =
			`<p>${esc(title)}</p>` +
			`<p>Reminder set by ${esc(info[uid]?.name || 'a follower')}.</p>` +
			`<p><a href="${url.origin}/note/${noteId}">Open "${esc(a.title)}" in ShareNote</a></p>`;
		const seriesKey = recurring ? crypto.randomUUID() : null;
		const messageIds = await adminExecute('mail.scheduled.message', 'create', [
			dates.map((date) => ({
				model: NOTES(),
				res_id: noteId,
				author_id: refs.botPartnerId || info[uid]?.partnerId,
				partner_ids: [[6, 0, targets.map((u) => info[u]?.partnerId).filter(Boolean)]],
				subject,
				body,
				scheduled_date: date,
				// comment: Odoo web-pushes 'comment' messages to all recipients, but
				// 'notification' (the default) only to inbox-pref users — our users
				// are email-pref, so phones stayed silent.
				// light layout: drops the "View Note" button that points at the Odoo
				// backend — the body carries the app link instead
				notification_parameters: JSON.stringify({
					message_type: 'comment',
					email_layout_xmlid: 'mail.mail_notification_light'
				}),
				// groups the series so cancel/series and the UI freq chip work
				send_context: seriesKey ? { sharenote_recur: { key: seriesKey, freq: frequency } } : false
			}))
		]);

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

		return json({ ok: true, messageIds });
	} catch (e) {
		console.error('[reminders] POST failed:', e?.message);
		return json({ ok: false, error: e?.message }, { status: e?.status || 500 });
	}
}

export async function DELETE({ request, cookies }) {
	try {
		assertConfigured();
		const { noteId: rawId, messageId, series = false } = (await request.json()) ?? {};
		const noteId = Number(rawId);
		if (!noteId || !messageId) {
			return json({ ok: false, error: 'noteId and messageId required' }, { status: 400 });
		}
		await assertNoteAccess(cookies, noteId);

		// anyone who can see the note may cancel — scheduled messages are created
		// with the admin key, so create_uid can't identify the actual creator
		const [msg] = await adminExecute('mail.scheduled.message', 'read', [[Number(messageId)]], {
			fields: ['model', 'res_id', 'scheduled_date', 'partner_ids', 'send_context']
		});
		if (!msg || msg.model !== NOTES() || msg.res_id !== noteId) {
			return json({ ok: false, error: 'Reminder not found' }, { status: 404 });
		}

		// series cancel: every pending occurrence sharing this recurrence key
		let chain = [msg];
		const key = msg.send_context?.sharenote_recur?.key;
		if (series && key) {
			const siblings = await adminExecute('mail.scheduled.message', 'search_read', [
				[['model', '=', NOTES()], ['res_id', '=', noteId]]
			], { fields: ['scheduled_date', 'partner_ids', 'send_context'] });
			chain = siblings.filter((s) => s.send_context?.sharenote_recur?.key === key);
		}

		// drop the activities created with these occurrences (note + deadline + assignees)
		for (const m of chain) {
			if (!m.partner_ids?.length) continue;
			const acts = await adminExecute('mail.activity', 'search', [[
				['res_model', '=', NOTES()],
				['res_id', '=', noteId],
				['date_deadline', '=', String(m.scheduled_date).slice(0, 10)],
				['user_id.partner_id', 'in', m.partner_ids]
			]]);
			if (acts.length) await adminExecute('mail.activity', 'unlink', [acts]);
		}
		await adminExecute('mail.scheduled.message', 'unlink', [chain.map((m) => Number(m.id))]);
		return json({ ok: true, cancelled: chain.length });
	} catch (e) {
		return json({ ok: false, error: e?.message }, { status: e?.status || 500 });
	}
}

/** Tick your own reminder done: mail.activity.action_feedback (posts to chatter,
 *  removes the activity). If every assignee of that occurrence is done, the
 *  pending scheduled message is dropped too — nobody needs the due-time ping. */
export async function PATCH({ request, cookies }) {
	try {
		assertConfigured();
		const { noteId: rawId, activityId, feedback = '' } = (await request.json()) ?? {};
		const noteId = Number(rawId);
		if (!noteId || !activityId) {
			return json({ ok: false, error: 'noteId and activityId required' }, { status: 400 });
		}
		const { uid, sid, odooCtx } = await assertNoteAccess(cookies, noteId);

		const [act] = await adminExecute('mail.activity', 'read', [[Number(activityId)]], {
			fields: ['res_model', 'res_id', 'user_id', 'date_deadline']
		});
		if (!act || act.res_model !== NOTES() || act.res_id !== noteId) {
			return json({ ok: false, error: 'Reminder not found' }, { status: 404 });
		}
		if (act.user_id?.[0] !== uid) {
			return json({ ok: false, error: 'You can only mark your own reminder done' }, { status: 403 });
		}

		const kwargs = feedback.trim() ? { feedback: feedback.trim() } : {};
		try {
			const { sessionId } = await sessionCallKw(
				sid, 'mail.activity', 'action_feedback', [[Number(activityId)]],
				{ ...kwargs, context: odooCtx }
			);
			refreshSessionCookie(cookies, sessionId, sid);
		} catch {
			await adminExecute('mail.activity', 'action_feedback', [[Number(activityId)]], kwargs);
		}

		// occurrence fully done? drop its pending scheduled message
		try {
			const msgs = await adminExecute('mail.scheduled.message', 'search_read', [
				[['model', '=', NOTES()], ['res_id', '=', noteId]]
			], { fields: ['scheduled_date', 'partner_ids'] });
			for (const m of msgs) {
				if (String(m.scheduled_date).slice(0, 10) !== act.date_deadline) continue;
				const remaining = await adminExecute('mail.activity', 'search_count', [[
					['res_model', '=', NOTES()],
					['res_id', '=', noteId],
					['date_deadline', '=', act.date_deadline],
					['user_id.partner_id', 'in', m.partner_ids]
				]]);
				if (!remaining) await adminExecute('mail.scheduled.message', 'unlink', [[m.id]]);
			}
		} catch (e) {
			console.error('[reminders] occurrence cleanup failed:', e?.message);
		}

		return json({ ok: true });
	} catch (e) {
		return json({ ok: false, error: e?.message }, { status: e?.status || 500 });
	}
}
