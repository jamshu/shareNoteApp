// Push fan-out for notes. Reads run with the admin key: the actor's session may
// not see every follower's user record, but recipients were already validated by
// Odoo record rules when the note/comment was written.
import { env } from '$env/dynamic/private';
import { adminExecute } from './odoo.js';
import { sendToUser } from './push.js';

const NOTES = () => env.ODOO_MODEL || 'x_notes';
const GROUPS = 'x_follower_group';

/** All user ids a note is shared with (followers + group members), plus owner. */
export async function noteAudience(noteId) {
	const [note] = await adminExecute(NOTES(), 'read', [[Number(noteId)]], {
		fields: ['x_name', 'create_uid', 'x_studio_follower_ids', 'x_studio_group_ids']
	});
	if (!note) return null;
	const followers = new Set(note.x_studio_follower_ids || []);
	if (note.x_studio_group_ids?.length) {
		const groups = await adminExecute(GROUPS, 'read', [note.x_studio_group_ids], {
			fields: ['x_studio_member_ids']
		});
		for (const g of groups) for (const m of g.x_studio_member_ids || []) followers.add(m);
	}
	return {
		title: note.x_name || 'Untitled note',
		ownerId: note.create_uid?.[0] ?? null,
		followerIds: followers
	};
}

async function userName(uid) {
	try {
		const [u] = await adminExecute('res.users', 'read', [[uid]], { fields: ['name'] });
		return u?.name || 'Someone';
	} catch {
		return 'Someone';
	}
}

async function fanOut(userIds, payload) {
	await Promise.allSettled([...userIds].map((uid) => sendToUser(uid, payload)));
}

/** Note shared: notify followers (owner shares, so exclude the actor). */
export async function notifyNoteShared(noteId, actorUid, onlyUserIds = null) {
	const a = await noteAudience(noteId);
	if (!a) return;
	const actor = await userName(actorUid);
	const targets = new Set(onlyUserIds ? onlyUserIds : a.followerIds);
	targets.delete(actorUid);
	if (!targets.size) return;
	await fanOut(targets, {
		title: `${actor} shared a note`,
		body: a.title,
		url: `/note/${noteId}`
	});
}

/** New comment: notify owner + all followers, minus the commenter. */
export async function notifyComment(noteId, actorUid, commentText = '') {
	const a = await noteAudience(noteId);
	if (!a) return;
	const actor = await userName(actorUid);
	const targets = new Set(a.followerIds);
	if (a.ownerId) targets.add(a.ownerId);
	targets.delete(actorUid);
	if (!targets.size) return;
	await fanOut(targets, {
		title: `${actor} commented on "${a.title}"`,
		body: commentText.slice(0, 120),
		url: `/note/${noteId}`
	});
}
