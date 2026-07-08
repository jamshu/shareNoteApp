<script>
	import { base } from '$app/paths';
	import { user } from '$lib/auth.js';
	import ConfirmButton from '$lib/components/ConfirmButton.svelte';

	let password = $state('');
	let busy = $state(false);
	let error = $state('');

	async function deleteAccount() {
		if (!password) {
			error = 'Enter your password to confirm.';
			return;
		}
		busy = true;
		error = '';
		try {
			const res = await fetch(`${base}/api/account`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ password })
			});
			const d = await res.json();
			if (!d.ok) throw new Error(d.error);
			// full reload clears all client state and lands on login
			location.href = `${base}/login`;
		} catch (e) {
			error = e.message;
			busy = false;
		}
	}
</script>

<div class="head-row">
	<h1>Account</h1>
</div>

<div class="card info-card">
	<strong>{$user?.name}</strong>
	<div class="muted">{$user?.email}</div>
	<div class="muted">{$user?.companyName} — {$user?.role === 'admin' ? 'admin' : 'member'}</div>
</div>

<div class="section-title"><span class="emo">⚠️</span> Danger zone</div>
<div class="card danger-card">
	<p class="muted" style="margin:0 0 12px;">
		Deleting your account is permanent. Your notes, the comments on them, your comments on other
		notes, and your groups are all deleted and cannot be recovered.
	</p>
	<input
		class="input"
		type="password"
		placeholder="Confirm with your password"
		bind:value={password}
		autocomplete="current-password"
	/>
	{#if error}<p class="error-text">{error}</p>{/if}
	<div class="row">
		<ConfirmButton
			label={busy ? 'Deleting…' : 'Delete my account'}
			confirmLabel="Permanently delete everything?"
			onconfirm={deleteAccount}
		/>
	</div>
</div>

<style>
	.head-row {
		margin: 18px 0 4px;
	}
	.info-card,
	.danger-card {
		padding: 16px 18px;
	}
	.danger-card {
		border-color: color-mix(in srgb, var(--red) 45%, transparent);
	}
	.row {
		display: flex;
		justify-content: flex-end;
		margin-top: 12px;
	}
</style>
