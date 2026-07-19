// One-time (idempotent, re-runnable) Odoo provisioning for shareNoteApp.
// Creates the manual models/fields the app expects (the same x_studio_* names
// the old Studio instance had, so app code needs zero changes), access rights,
// the notes company record rule, and bootstraps org fields on existing users.
//
// Run: npm run setup:odoo   (reads .env via node --env-file)

const URL_ = (process.env.ODOO_URL || '').replace(/\/$/, '');
const DB = process.env.ODOO_DB;
const USER = process.env.ODOO_USERNAME;
const KEY = process.env.ODOO_API_KEY;
if (!URL_ || !DB || !USER || !KEY) {
	console.error('Set ODOO_URL, ODOO_DB, ODOO_USERNAME, ODOO_API_KEY in .env');
	process.exit(1);
}

async function service(serviceName, method, args) {
	const res = await fetch(`${URL_}/jsonrpc`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			method: 'call',
			params: { service: serviceName, method, args },
			id: Date.now()
		})
	});
	const data = await res.json();
	if (data.error) throw new Error(data.error.data?.message || data.error.message || 'Odoo error');
	return data.result;
}

let uid;
async function x(model, method, args = [], kwargs = {}) {
	return service('object', 'execute_kw', [DB, uid, KEY, model, method, args, kwargs]);
}

async function ensureModel(model, name) {
	const found = await x('ir.model', 'search', [[['model', '=', model]]]);
	if (found.length) return found[0];
	const id = await x('ir.model', 'create', [{ name, model, state: 'manual' }]);
	console.log(`  + model ${model}`);
	return id;
}

// vals: { name, ttype, relation?, selection? }
//   selection is [[value, label], ...] for ttype:'selection'
async function ensureField(modelId, model, vals) {
	const found = await x('ir.model.fields', 'search', [
		[['model_id', '=', modelId], ['name', '=', vals.name]]
	]);
	if (found.length) return found[0]; // leave existing field/selection values as-is
	const { selection, ...rest } = vals;
	const create = {
		model_id: modelId,
		state: 'manual',
		field_description: vals.name.replace(/^x_studio_/, '').replace(/_/g, ' '),
		...rest
	};
	if (vals.ttype === 'selection' && selection) {
		create.selection_ids = selection.map(([value, name], i) => [
			0, 0, { value, name, sequence: (i + 1) * 10 }
		]);
	}
	const id = await x('ir.model.fields', 'create', [create]);
	console.log(`  + field ${model}.${vals.name} (${vals.ttype})`);
	return id;
}

async function ensureAccess(modelId, model, groupId) {
	const found = await x('ir.model.access', 'search', [
		[['model_id', '=', modelId], ['group_id', '=', groupId]]
	]);
	if (found.length) return found[0];
	const id = await x('ir.model.access', 'create', [{
		name: `${model} user access`,
		model_id: modelId,
		group_id: groupId,
		perm_read: true, perm_write: true, perm_create: true, perm_unlink: true
	}]);
	console.log(`  + access ${model}`);
	return id;
}

async function groupIdByXmlId(module, name) {
	const rows = await x('ir.model.data', 'search_read', [
		[['module', '=', module], ['name', '=', name], ['model', '=', 'res.groups']],
		['res_id']
	]);
	return rows[0]?.res_id || null;
}

async function main() {
	uid = await service('common', 'login', [DB, USER, KEY]);
	if (!uid) throw new Error('Admin login failed — check ODOO_USERNAME / ODOO_API_KEY');
	console.log(`Logged in as uid ${uid} on ${URL_} (${DB})`);

	/* ---- models (x_follower_group first: m2m target of x_notes) ---- */
	console.log('Models & fields:');
	const groupModel = await ensureModel('x_follower_group', 'Follower Group');
	await ensureField(groupModel, 'x_follower_group', { name: 'x_studio_member_ids', ttype: 'many2many', relation: 'res.users' });

	const notesModel = await ensureModel('x_notes', 'Note');
	for (const f of [
		{ name: 'x_studio_notes', ttype: 'html' },
		{ name: 'x_studio_notes_md', ttype: 'text' },
		{ name: 'x_studio_editor_mode', ttype: 'selection', selection: [['md', 'Markdown'], ['html', 'HTML']] },
		{ name: 'x_studio_date', ttype: 'date' },
		{ name: 'x_studio_permission', ttype: 'selection', selection: [['owner_edit', 'Owner edit'], ['contribute', 'Contribute']] },
		{ name: 'x_studio_follower_ids', ttype: 'many2many', relation: 'res.users' },
		{ name: 'x_studio_group_ids', ttype: 'many2many', relation: 'x_follower_group' },
		{ name: 'x_studio_company_id', ttype: 'many2one', relation: 'res.company' }
	]) await ensureField(notesModel, 'x_notes', f);

	const commentModel = await ensureModel('x_note_comment', 'Note Comment');
	for (const f of [
		{ name: 'x_studio_body', ttype: 'html' },
		{ name: 'x_studio_note_id', ttype: 'many2one', relation: 'x_notes' }
	]) await ensureField(commentModel, 'x_note_comment', f);

	const pushModel = await ensureModel('x_push_subscription', 'Push Subscription');
	await ensureField(pushModel, 'x_push_subscription', { name: 'x_studio_user_id', ttype: 'many2one', relation: 'res.users' });

	/* ---- fields on existing models ---- */
	const [companyModel] = await x('ir.model', 'search', [[['model', '=', 'res.company']]]);
	await ensureField(companyModel, 'res.company', { name: 'x_studio_invite_token', ttype: 'char' });
	const [usersModel] = await x('ir.model', 'search', [[['model', '=', 'res.users']]]);
	await ensureField(usersModel, 'res.users', { name: 'x_studio_org_role', ttype: 'char' });
	await ensureField(usersModel, 'res.users', { name: 'x_studio_org_status', ttype: 'char' });

	/* ---- access rights (authorization is enforced in the app's server layer) ---- */
	console.log('Access rights:');
	const internalGid = await groupIdByXmlId('base', 'group_user');
	if (!internalGid) throw new Error('base.group_user not found');
	await ensureAccess(groupModel, 'x_follower_group', internalGid);
	await ensureAccess(notesModel, 'x_notes', internalGid);
	await ensureAccess(commentModel, 'x_note_comment', internalGid);
	await ensureAccess(pushModel, 'x_push_subscription', internalGid);

	/* ---- record rule: notes visible only inside the user's companies ---- */
	const ruleName = 'x_notes: company scope';
	const rules = await x('ir.rule', 'search', [[['name', '=', ruleName]]]);
	if (!rules.length) {
		await x('ir.rule', 'create', [{
			name: ruleName,
			model_id: notesModel,
			domain_force: "['|',('x_studio_company_id','=',False),('x_studio_company_id','in',company_ids)]",
			groups: [[6, 0, [internalGid]]]
		}]);
		console.log('  + rule x_notes company scope');
	}

	/* ---- bootstrap org fields for pre-existing users (only when unset) ---- */
	console.log('Org bootstrap:');
	const seed = await x('res.users', 'search_read', [
		[['share', '=', false], ['active', '=', true], ['x_studio_org_status', '=', false]],
		['id', 'company_id']
	]);
	for (const u of seed) {
		await x('res.users', 'write', [[u.id], {
			x_studio_org_role: u.id === uid ? 'admin' : 'member',
			x_studio_org_status: 'approved'
		}]);
		console.log(`  user ${u.id} → ${u.id === uid ? 'admin' : 'member'}/approved`);
	}
	const [adminUser] = await x('res.users', 'read', [[uid], ['company_id']]);
	const cid = adminUser.company_id[0];
	const [comp] = await x('res.company', 'read', [[cid], ['x_studio_invite_token']]);
	if (!comp.x_studio_invite_token) {
		await x('res.company', 'write', [[cid], { x_studio_invite_token: crypto.randomUUID() }]);
		console.log(`  company ${cid} invite token generated`);
	}

	console.log('Done.');
}

main().catch((e) => {
	console.error('FAILED:', e.message);
	process.exit(1);
});
