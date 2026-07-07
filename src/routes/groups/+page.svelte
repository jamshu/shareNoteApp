<script>
	import { onMount } from 'svelte';
	import { base } from '$app/paths';
	import { user } from '$lib/auth.js';
	import { odooClient } from '$lib/odoo.js';

	let groups = $state([]);
	let orgUsers = $state([]);
	let newName = $state('');
	let error = $state('');
	let loading = $state(true);

	onMount(async () => {
		try {
			const res = await fetch(`${base}/api/org/users`);
			const d = await res.json();
			if (d.ok) orgUsers = d.users;
			await load();
		} catch (e) {
			error = e.message;
		} finally {
			loading = false;
		}
	});

	async function load() {
		groups = await odooClient.searchRecords([], ['x_name', 'x_studio_member_ids', 'create_uid'], 'groups', { order: 'x_name asc' });
	}

	async function createGroup(e) {
		e.preventDefault();
		if (!newName.trim()) return;
		error = '';
		try {
			await odooClient.createRecord({ x_name: newName.trim() }, 'groups');
			newName = '';
			await load();
		} catch (err) {
			error = err.message;
		}
	}

	async function toggleMember(group, userId) {
		const members = group.x_studio_member_ids || [];
		const next = members.includes(userId)
			? members.filter((m) => m !== userId)
			: [...members, userId];
		try {
			await odooClient.updateRecord(group.id, { x_studio_member_ids: [[6, 0, next]] }, 'groups');
			group.x_studio_member_ids = next;
			groups = groups;
		} catch (err) {
			error = err.message;
		}
	}

	async function removeGroup(id) {
		if (!confirm('Delete this group? Notes shared via it will no longer reach its members.')) return;
		try {
			await odooClient.deleteRecord(id, 'groups');
			await load();
		} catch (err) {
			error = err.message;
		}
	}
</script>

<div class="head-row">
	<h1>Follower groups</h1>
</div>
<p class="muted">Share a note with a group to reach all its members at once.</p>

<form class="card new-group" onsubmit={createGroup}>
	<input class="input" placeholder="New group name…" bind:value={newName} />
	<button class="btn btn--primary">Create</button>
</form>

{#if error}<p class="error-text">{error}</p>{/if}

{#if loading}
	<p class="muted">Loading…</p>
{:else}
	{#each groups as g, i (g.id)}
		<div class="card group-card fade-in" style="--fade-delay: {i * 0.04}s">
			<div class="group-head">
				<h3>{g.x_name}</h3>
				<span class="muted">{(g.x_studio_member_ids || []).length} member(s)</span>
				{#if g.create_uid?.[0] === $user?.uid}
					<button class="btn btn--sm btn--danger" onclick={() => removeGroup(g.id)}>Delete</button>
				{/if}
			</div>
			{#if g.create_uid?.[0] === $user?.uid}
				<div class="picker">
					{#each orgUsers as u (u.id)}
						<button
							class="chip {(g.x_studio_member_ids || []).includes(u.id) ? 'chip--accent' : ''}"
							onclick={() => toggleMember(g, u.id)}
						>{u.name}</button>
					{/each}
					{#if orgUsers.length === 0}
						<p class="muted">No other members in your organization yet.</p>
					{/if}
				</div>
			{/if}
		</div>
	{:else}
		<p class="muted" style="margin-top:16px;">No groups yet.</p>
	{/each}
{/if}

<style>
	.head-row {
		margin: 18px 0 4px;
	}
	.new-group {
		display: flex;
		gap: 10px;
		padding: 14px;
		margin: 16px 0;
	}
	.group-card {
		padding: 16px 18px;
		margin-bottom: 12px;
	}
	.group-head {
		display: flex;
		align-items: center;
		gap: 12px;
		margin-bottom: 10px;
	}
	.group-head h3 {
		flex: 1;
		font-size: 1.05rem;
	}
	.picker {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
</style>
