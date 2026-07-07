<script>
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { page } from '$app/stores';
	import { signup } from '$lib/auth.js';

	let name = $state('');
	let email = $state('');
	let password = $state('');
	let error = $state('');
	let busy = $state(false);

	// org selection
	let inviteToken = $state('');
	let invitedOrg = $state(null); // { id, name } when arriving via invite link
	let mode = $state('create'); // create | join (invite is implied by the link)
	let orgName = $state('');
	let orgs = $state([]);
	let companyId = $state('');

	onMount(async () => {
		inviteToken = $page.url.searchParams.get('invite') || '';
		if (inviteToken) {
			const res = await fetch(`${base}/api/orgs?invite=${encodeURIComponent(inviteToken)}`);
			const d = await res.json();
			if (d.ok) invitedOrg = d.org;
			else {
				error = 'This invite link is invalid or expired.';
				inviteToken = '';
			}
		}
		const res = await fetch(`${base}/api/orgs`);
		const d = await res.json().catch(() => ({}));
		if (d.ok) orgs = d.orgs;
	});

	async function submit(e) {
		e.preventDefault();
		error = '';
		busy = true;
		try {
			const org = invitedOrg
				? { mode: 'invite', inviteToken }
				: mode === 'create'
					? { mode: 'create', orgName }
					: { mode: 'join', companyId: Number(companyId) };
			await signup(name, email, password, org);
			goto(`${base}/`);
		} catch (err) {
			error = err.message;
		} finally {
			busy = false;
		}
	}
</script>

<div class="auth-wrap fade-in">
	<h1><span class="emo">📝</span> ShareNote</h1>
	<p class="muted" style="margin: 8px 0 26px;">Create your account.</p>
	<form class="card auth-card" onsubmit={submit}>
		{#if invitedOrg}
			<div class="chip chip--green" style="margin-bottom: 6px;">
				Invited to {invitedOrg.name}
			</div>
		{/if}

		<label class="label" for="name">Your name</label>
		<input id="name" class="input" bind:value={name} autocomplete="name" required />
		<label class="label" for="email">Email</label>
		<input id="email" class="input" type="email" bind:value={email} autocomplete="email" required />
		<label class="label" for="password">Password</label>
		<input id="password" class="input" type="password" bind:value={password} autocomplete="new-password" minlength="6" required />

		{#if !invitedOrg}
			<label class="label" for="mode-create">Organization</label>
			<div class="mode-row">
				<label class:selected={mode === 'create'}>
					<input id="mode-create" type="radio" bind:group={mode} value="create" /> Create new
				</label>
				<label class:selected={mode === 'join'}>
					<input type="radio" bind:group={mode} value="join" /> Join existing
				</label>
			</div>
			{#if mode === 'create'}
				<input class="input" placeholder="Organization name" bind:value={orgName} required />
				<p class="muted" style="margin-top:8px;">You'll be the organization admin.</p>
			{:else}
				<select class="select" bind:value={companyId} required>
					<option value="" disabled>Choose organization…</option>
					{#each orgs as o (o.id)}
						<option value={o.id}>{o.name}</option>
					{/each}
				</select>
				<p class="muted" style="margin-top:8px;">
					An organization admin must approve you before you can access notes.
				</p>
			{/if}
		{/if}

		{#if error}<p class="error-text">{error}</p>{/if}
		<button class="btn btn--primary" style="width:100%; margin-top:20px;" disabled={busy}>
			{busy ? 'Creating account…' : 'Sign up'}
		</button>
		<p class="muted" style="text-align:center; margin-top:16px;">
			Have an account? <a href="{base}/login">Sign in</a>
		</p>
	</form>
</div>

<style>
	.auth-wrap {
		max-width: 420px;
		margin: 8vh auto 0;
		text-align: center;
	}
	.auth-card {
		padding: 26px;
		text-align: left;
	}
	.auth-card a {
		color: var(--accent);
	}
	.mode-row {
		display: flex;
		gap: 8px;
		margin-bottom: 10px;
	}
	.mode-row label {
		flex: 1;
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 10px 12px;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		font-size: 0.9rem;
		font-weight: 600;
		color: var(--text-dim);
		cursor: pointer;
	}
	.mode-row label.selected {
		border-color: var(--accent);
		color: var(--text);
	}
</style>
