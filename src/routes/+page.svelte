<script>
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { user } from '$lib/auth.js';
	import { odooClient } from '$lib/odoo.js';

	let notes = $state([]);
	let loading = $state(true);
	let error = $state('');
	let query = $state('');

	const FIELDS = ['x_name', 'x_studio_date', 'x_studio_permission', 'create_uid', 'write_date'];

	let mine = $derived(notes.filter((n) => n.create_uid?.[0] === $user?.uid));
	let shared = $derived(notes.filter((n) => n.create_uid?.[0] !== $user?.uid));

	onMount(load);

	// searches title + rendered html + markdown source server-side
	const searchDomain = (q) => [
		'|', '|',
		['x_name', 'ilike', q],
		['x_studio_notes', 'ilike', q],
		['x_studio_notes_md', 'ilike', q]
	];

	let loadSeq = 0; // drop out-of-order responses from stale searches
	async function load() {
		const seq = ++loadSeq;
		loading = true;
		error = '';
		try {
			// record rules already limit results to own + shared-with-me notes
			const q = query.trim();
			const results = await odooClient.searchRecords(q ? searchDomain(q) : [], FIELDS, 'notes', {
				order: 'write_date desc'
			});
			if (seq !== loadSeq) return;
			notes = results;
		} catch (e) {
			if (seq !== loadSeq) return;
			error = e.message;
		} finally {
			if (seq === loadSeq) loading = false;
		}
	}

	let searchTimer;
	function onSearchInput() {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(load, 300);
	}

	async function newNote() {
		try {
			const id = await odooClient.createRecord({
				x_name: 'Untitled note',
				x_studio_date: new Date().toISOString().slice(0, 10),
				x_studio_permission: 'owner_edit'
			});
			goto(`${base}/note/${id}`);
		} catch (e) {
			error = e.message;
		}
	}

	const fmtDate = (d) => (d ? new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
</script>

{#snippet noteList(items)}
	<div class="note-grid">
		{#each items as n, i (n.id)}
			<a class="card card--interactive note-card fade-in" style="--fade-delay: {i * 0.04}s" href="{base}/note/{n.id}">
				<h3>{n.x_name}</h3>
				<div class="note-meta">
					<span class="muted">{fmtDate(n.x_studio_date)}</span>
					{#if n.create_uid?.[0] !== $user?.uid}
						<span class="chip">{n.create_uid?.[1]}</span>
					{/if}
					{#if n.x_studio_permission === 'contribute'}
						<span class="chip chip--green">contribute</span>
					{/if}
				</div>
			</a>
		{/each}
	</div>
{/snippet}

<div class="head-row">
	<h1>Notes</h1>
	<button class="btn btn--primary" onclick={newNote}>+ New note</button>
</div>

<input
	class="input search-input"
	type="search"
	placeholder="🔍 Search notes…"
	bind:value={query}
	oninput={onSearchInput}
/>

{#if error}<p class="error-text">{error}</p>{/if}

{#if loading}
	<p class="muted">Loading…</p>
{:else}
	<div class="section-title"><span class="emo">✍️</span> My notes</div>
	{#if mine.length}{@render noteList(mine)}{:else}<p class="muted">{query.trim() ? 'No matches.' : 'Nothing yet — create your first note.'}</p>{/if}

	<div class="section-title"><span class="emo">🤝</span> Shared with me</div>
	{#if shared.length}{@render noteList(shared)}{:else}<p class="muted">{query.trim() ? 'No matches.' : 'No shared notes yet.'}</p>{/if}
{/if}

<style>
	.head-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin: 18px 0 4px;
	}
	.search-input {
		width: 100%;
		margin: 4px 0 10px;
	}
	.note-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
		gap: 14px;
	}
	.note-card {
		display: block;
		padding: 18px;
		text-decoration: none;
		color: var(--text);
	}
	.note-card h3 {
		font-size: 1.05rem;
		margin-bottom: 10px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.note-meta {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}
</style>
