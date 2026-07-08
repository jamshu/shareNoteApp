<script>
	import { onMount } from 'svelte';
	import { base } from '$app/paths';
	import { user } from '$lib/auth.js';
	import ConfirmButton from '$lib/components/ConfirmButton.svelte';

	let pending = $state([]);
	let members = $state([]);
	let error = $state('');
	let loading = $state(true);
	let copied = $state(false);

	let inviteLink = $derived(
		$user?.inviteToken ? `${location.origin}${base}/signup?invite=${$user.inviteToken}` : ''
	);

	onMount(load);

	async function load() {
		loading = true;
		error = '';
		try {
			const res = await fetch(`${base}/api/org/members`);
			const d = await res.json();
			if (!d.ok) throw new Error(d.error);
			pending = d.pending;
			members = d.members || [];
		} catch (e) {
			error = e.message;
		} finally {
			loading = false;
		}
	}

	async function act(userId, action) {
		error = '';
		try {
			const res = await fetch(`${base}/api/org/members`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ userId, action })
			});
			const d = await res.json();
			if (!d.ok) throw new Error(d.error);
			await load();
		} catch (e) {
			error = e.message;
		}
	}

	async function copyInvite() {
		await navigator.clipboard.writeText(inviteLink);
		copied = true;
		setTimeout(() => (copied = false), 1500);
	}
</script>

<div class="head-row">
	<h1>{$user?.companyName}</h1>
</div>

<div class="section-title"><span class="emo">🔗</span> Invite link</div>
<div class="card invite-card">
	<p class="muted" style="margin:0 0 10px;">
		Anyone who signs up through this link joins your organization automatically — no approval needed.
	</p>
	<div class="invite-row">
		<input class="input" readonly value={inviteLink} onfocus={(e) => e.target.select()} />
		<button class="btn btn--primary" onclick={copyInvite}>{copied ? 'Copied ✓' : 'Copy'}</button>
	</div>
</div>

<div class="section-title"><span class="emo">🛂</span> Pending approvals</div>
{#if error}<p class="error-text">{error}</p>{/if}
{#if loading}
	<p class="muted">Loading…</p>
{:else if pending.length === 0}
	<p class="muted">No one is waiting for approval.</p>
{:else}
	{#each pending as p, i (p.id)}
		<div class="card pending-row fade-in" style="--fade-delay: {i * 0.04}s">
			<div>
				<strong>{p.name}</strong>
				<div class="muted">{p.email}</div>
			</div>
			<div class="actions">
				<button class="btn btn--sm btn--primary" onclick={() => act(p.id, 'approve')}>Approve</button>
				<button class="btn btn--sm btn--danger" onclick={() => act(p.id, 'reject')}>Reject</button>
			</div>
		</div>
	{/each}
{/if}

<div class="section-title"><span class="emo">👥</span> Members</div>
{#if !loading && members.length === 0}
	<p class="muted">No other members yet.</p>
{:else}
	{#each members as m, i (m.id)}
		<div class="card pending-row fade-in" style="--fade-delay: {i * 0.04}s">
			<div>
				<strong>{m.name}</strong>
				<div class="muted">{m.email}</div>
			</div>
			<div class="actions">
				<ConfirmButton
					label="Remove"
					confirmLabel="Delete user + their notes?"
					onconfirm={() => act(m.id, 'remove')}
				/>
			</div>
		</div>
	{/each}
{/if}

<style>
	.head-row {
		margin: 18px 0 4px;
	}
	.invite-card {
		padding: 16px 18px;
	}
	.invite-row {
		display: flex;
		gap: 10px;
	}
	.pending-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 14px 18px;
		margin-bottom: 10px;
	}
	.actions {
		display: flex;
		gap: 8px;
	}
</style>
