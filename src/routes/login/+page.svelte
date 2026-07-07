<script>
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { login } from '$lib/auth.js';

	let email = $state('');
	let password = $state('');
	let error = $state('');
	let busy = $state(false);

	async function submit(e) {
		e.preventDefault();
		error = '';
		busy = true;
		try {
			await login(email, password);
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
	<p class="muted" style="margin: 8px 0 26px;">Notes you write together.</p>
	<form class="card auth-card" onsubmit={submit}>
		<label class="label" for="email">Email</label>
		<input id="email" class="input" type="email" bind:value={email} autocomplete="email" required />
		<label class="label" for="password">Password</label>
		<input id="password" class="input" type="password" bind:value={password} autocomplete="current-password" required />
		{#if error}<p class="error-text">{error}</p>{/if}
		<button class="btn btn--primary" style="width:100%; margin-top:20px;" disabled={busy}>
			{busy ? 'Signing in…' : 'Sign in'}
		</button>
		<p class="muted" style="text-align:center; margin-top:16px;">
			No account? <a href="{base}/signup">Sign up</a>
		</p>
	</form>
</div>

<style>
	.auth-wrap {
		max-width: 400px;
		margin: 12vh auto 0;
		text-align: center;
	}
	.auth-card {
		padding: 26px;
		text-align: left;
	}
	.auth-card a {
		color: var(--accent);
	}
</style>
