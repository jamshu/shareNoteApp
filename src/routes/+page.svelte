<script>
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { user } from '$lib/auth.js';
	import { odooClient } from '$lib/odoo.js';

	let notes = $state([]);
	let loading = $state(true);
	let error = $state('');

	const FIELDS = ['x_name', 'x_studio_date', 'x_studio_permission', 'create_uid', 'write_date'];

	let mine = $derived(notes.filter((n) => n.create_uid?.[0] === $user?.uid));
	let shared = $derived(notes.filter((n) => n.create_uid?.[0] !== $user?.uid));

	onMount(load);

	async function load() {
		loading = true;
		error = '';
		try {
			// record rules already limit results to own + shared-with-me notes
			notes = await odooClient.searchRecords([], FIELDS, 'notes', { order: 'write_date desc' });
		} catch (e) {
			error = e.message;
		} finally {
			loading = false;
		}
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

{#if error}<p class="error-text">{error}</p>{/if}

{#if loading}
	<p class="muted">Loading…</p>
{:else}
	<div class="section-title"><span class="emo">✍️</span> My notes</div>
	{#if mine.length}{@render noteList(mine)}{:else}<p class="muted">Nothing yet — create your first note.</p>{/if}

	<div class="section-title"><span class="emo">🤝</span> Shared with me</div>
	{#if shared.length}{@render noteList(shared)}{:else}<p class="muted">No shared notes yet.</p>{/if}
{/if}

<style>
	.head-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin: 18px 0 4px;
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
