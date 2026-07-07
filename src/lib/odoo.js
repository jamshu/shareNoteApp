// Browser-side Odoo client. Talks ONLY to your own /api/odoo proxy, never
// directly to Odoo — credentials and session ids stay server-side.
// @ts-check
import { base } from '$app/paths';
import { env } from '$env/dynamic/public';

// Optional: point a statically-hosted frontend at a proxy on another origin.
// Read via $env/dynamic/public (NOT import.meta.env): SvelteKit's Vite envPrefix
// is VITE_, so import.meta.env.PUBLIC_* is undefined. Empty => same-origin /api/odoo.
const PUBLIC_API_URL = env.PUBLIC_API_URL ? String(env.PUBLIC_API_URL) : '';

class OdooAPI {
	constructor() {
		this.apiUrl =
			PUBLIC_API_URL && PUBLIC_API_URL.trim() !== ''
				? `${PUBLIC_API_URL.replace(/\/$/, '')}/api/odoo`
				: `${base}/api/odoo`;
	}

	/** @param {string} action @param {any} data @param {string} model notes|groups|comments */
	async callApi(action, data, model = 'notes') {
		const response = await fetch(this.apiUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action, model, data })
		});
		const result = await response.json();
		if (!result.success) {
			const e = new Error(result.error || 'API Error');
			// @ts-ignore
			e.status = response.status;
			throw e;
		}
		return result;
	}

	/** @param {Record<string, any>} fields @param {string} model */
	async createRecord(fields, model = 'notes') {
		return (await this.callApi('create', fields, model)).id;
	}

	/** @param {any[]} domain @param {string[]} fields @param {string} model @param {{order?: string, limit?: number}} opts */
	async searchRecords(domain = [], fields = [], model = 'notes', opts = {}) {
		return (await this.callApi('search', { domain, fields, ...opts }, model)).results;
	}

	/** @param {number} id @param {Record<string, any>} values @param {string} model */
	async updateRecord(id, values, model = 'notes') {
		return (await this.callApi('update', { id, values }, model)).result;
	}

	/** @param {number} id @param {string} model */
	async deleteRecord(id, model = 'notes') {
		return (await this.callApi('delete', { id }, model)).result;
	}

	// --- Odoo relational field encoders (see references/odoo-studio-setup.md) ---

	/** many2one expects an integer id (or false to clear). @param {number|string|null|undefined} id */
	formatMany2one(id) {
		return id ? Number(id) : false;
	}

	/** many2many replace-all command: [[6, 0, [ids]]]. @param {Array<number|string>} ids */
	formatMany2many(ids) {
		if (!Array.isArray(ids) || ids.length === 0) return [];
		return [[6, 0, ids.map((i) => Number(i))]];
	}
}

export const odooClient = new OdooAPI();
