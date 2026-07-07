<script>
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { user } from '$lib/auth.js';
	import { odooClient } from '$lib/odoo.js';

	const noteId = Number($page.params.id);

	let note = $state(null);
	let error = $state('');
	let syncState = $state('idle'); // idle | saving | saved | error
	let bodyEl = $state(null);

	// share panel
	let shareOpen = $state(false);
	let orgUsers = $state([]);
	let myGroups = $state([]);
	let followerIds = $state([]);
	let groupIds = $state([]);

	// comments
	let comments = $state([]);
	let attachments = $state([]); // flat list, joined by commentId
	let commentText = $state('');
	let commentFiles = $state(null);
	let commenting = $state(false);

	let isOwner = $derived(note?.create_uid?.[0] === $user?.uid);
	let canEdit = $derived(isOwner || note?.x_studio_permission === 'contribute');

	onMount(async () => {
		try {
			const [n] = await odooClient.searchRecords([['id', '=', noteId]], [
				'x_name', 'x_studio_notes', 'x_studio_date', 'x_studio_permission',
				'x_studio_follower_ids', 'x_studio_group_ids', 'create_uid'
			]);
			if (!n) { error = 'Note not found or not shared with you.'; return; }
			note = n;
			followerIds = n.x_studio_follower_ids || [];
			groupIds = n.x_studio_group_ids || [];
			if (bodyEl) bodyEl.innerHTML = n.x_studio_notes || '';
			await Promise.all([loadComments(), loadShareData()]);
		} catch (e) {
			error = e.message;
		}
	});

	$effect(() => {
		// bodyEl binds after the {#if note} block renders
		if (bodyEl && note && !bodyEl.dataset.filled) {
			bodyEl.innerHTML = note.x_studio_notes || '';
			bodyEl.dataset.filled = '1';
		}
	});

	/* ── debounced autosave ──────────────────────────────────────────── */
	let saveTimer;
	let pendingValues = {};
	function scheduleSave(values) {
		pendingValues = { ...pendingValues, ...values };
		syncState = 'saving';
		clearTimeout(saveTimer);
		saveTimer = setTimeout(async () => {
			const vals = pendingValues;
			pendingValues = {};
			try {
				await odooClient.updateRecord(noteId, vals);
				syncState = 'saved';
				setTimeout(() => { if (syncState === 'saved') syncState = 'idle'; }, 1500);
			} catch (e) {
				syncState = 'error';
				error = e.message;
			}
		}, 700);
	}

	/* ── sharing ─────────────────────────────────────────────────────── */
	async function loadShareData() {
		const res = await fetch(`${base}/api/org/users`);
		const d = await res.json();
		if (d.ok) orgUsers = d.users;
		myGroups = await odooClient.searchRecords([], ['x_name'], 'groups');
	}

	// always the replace-all command, including [[6,0,[]]] to clear
	const m2m = (ids) => [[6, 0, ids.map(Number)]];

	function toggleFollower(id) {
		followerIds = followerIds.includes(id)
			? followerIds.filter((f) => f !== id)
			: [...followerIds, id];
		scheduleSave({ x_studio_follower_ids: m2m(followerIds) });
	}

	function toggleGroup(id) {
		groupIds = groupIds.includes(id) ? groupIds.filter((g) => g !== id) : [...groupIds, id];
		scheduleSave({ x_studio_group_ids: m2m(groupIds) });
	}

	/* ── comments ────────────────────────────────────────────────────── */
	async function loadComments() {
		comments = await odooClient.searchRecords(
			[['x_studio_note_id', '=', noteId]],
			['x_studio_body', 'create_uid', 'create_date'],
			'comments',
			{ order: 'create_date asc' }
		);
		if (comments.length) {
			const ids = comments.map((c) => c.id).join(',');
			const res = await fetch(`${base}/api/attachments?commentIds=${ids}`);
			const d = await res.json();
			attachments = d.ok ? d.attachments : [];
		} else {
			attachments = [];
		}
	}

	const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

	async function addComment(e) {
		e.preventDefault();
		if (!commentText.trim() && !commentFiles?.length) return;
		commenting = true;
		error = '';
		try {
			const body = `<p>${esc(commentText.trim()).replace(/\n/g, '<br/>')}</p>`;
			const id = await odooClient.createRecord(
				{ x_studio_note_id: noteId, x_studio_body: body },
				'comments'
			);
			for (const file of commentFiles || []) {
				const dataBase64 = await fileToBase64(file);
				const res = await fetch(`${base}/api/attachments`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ commentId: id, name: file.name, mimetype: file.type, dataBase64 })
				});
				const d = await res.json();
				if (!d.ok) throw new Error(d.error || `Upload failed: ${file.name}`);
			}
			commentText = '';
			commentFiles = null;
			await loadComments();
		} catch (err) {
			error = err.message;
		} finally {
			commenting = false;
		}
	}

	function fileToBase64(file) {
		return new Promise((resolve, reject) => {
			const r = new FileReader();
			r.onload = () => resolve(String(r.result).split(',')[1]);
			r.onerror = reject;
			r.readAsDataURL(file);
		});
	}

	async function deleteNote() {
		if (!confirm('Delete this note and its comments?')) return;
		try {
			await odooClient.deleteRecord(noteId);
			goto(`${base}/`);
		} catch (e) {
			error = e.message;
		}
	}

	const fmtWhen = (d) => (d ? new Date(d + 'Z').toLocaleString() : '');
	const commentAtts = (cid) => attachments.filter((a) => a.commentId === cid);
</script>

{#if error && !note}
	<p class="error-text" style="margin-top:40px;">{error}</p>
	<a href="{base}/" class="btn" style="margin-top:12px;">← Back to notes</a>
{:else if note}
	<div class="head-row">
		<a href="{base}/" class="btn btn--sm btn--ghost">←</a>
		<span class="sync muted">
			{#if syncState === 'saving'}saving…{:else if syncState === 'saved'}saved ✓{:else if syncState === 'error'}save failed{/if}
		</span>
		{#if isOwner}
			<button class="btn btn--sm" onclick={() => (shareOpen = !shareOpen)}>
				Share ({followerIds.length + groupIds.length})
			</button>
			<button class="btn btn--sm btn--danger" onclick={deleteNote}>Delete</button>
		{:else}
			<span class="chip">{note.create_uid?.[1]}</span>
			<span class="chip {note.x_studio_permission === 'contribute' ? 'chip--green' : ''}">
				{note.x_studio_permission === 'contribute' ? 'can edit' : 'read only'}
			</span>
		{/if}
	</div>

	{#if shareOpen && isOwner}
		<div class="card share-panel fade-in">
			<div class="label" style="margin-top:0;">Permission</div>
			<select
				class="select"
				value={note.x_studio_permission}
				onchange={(e) => { note.x_studio_permission = e.target.value; scheduleSave({ x_studio_permission: e.target.value }); }}
			>
				<option value="owner_edit">Owner only can edit — followers comment</option>
				<option value="contribute">Followers can contribute — edit the note too</option>
			</select>

			<div class="label">Followers</div>
			{#if orgUsers.length === 0}
				<p class="muted">No other members in your organization yet.</p>
			{/if}
			<div class="picker">
				{#each orgUsers as u (u.id)}
					<button
						class="chip {followerIds.includes(u.id) ? 'chip--accent' : ''}"
						onclick={() => toggleFollower(u.id)}
					>{u.name}</button>
				{/each}
			</div>

			<div class="label">Groups</div>
			{#if myGroups.length === 0}
				<p class="muted">No groups yet — create one on the Groups page.</p>
			{/if}
			<div class="picker">
				{#each myGroups as g (g.id)}
					<button
						class="chip {groupIds.includes(g.id) ? 'chip--accent' : ''}"
						onclick={() => toggleGroup(g.id)}
					>{g.x_name}</button>
				{/each}
			</div>
		</div>
	{/if}

	<input
		class="title-input"
		value={note.x_name}
		readonly={!canEdit}
		oninput={(e) => scheduleSave({ x_name: e.target.value })}
		placeholder="Note title"
	/>
	<input
		class="input date-input"
		type="date"
		value={note.x_studio_date || ''}
		readonly={!canEdit}
		onchange={(e) => scheduleSave({ x_studio_date: e.target.value || false })}
	/>

	<div
		class="richtext"
		bind:this={bodyEl}
		contenteditable={canEdit}
		data-placeholder="Write your note…"
		oninput={() => scheduleSave({ x_studio_notes: bodyEl.innerHTML })}
	></div>

	<div class="section-title"><span class="emo">💬</span> Comments</div>
	{#each comments as c (c.id)}
		<div class="card comment fade-in">
			<div class="comment-head">
				<strong>{c.create_uid?.[1]}</strong>
				<span class="muted">{fmtWhen(c.create_date)}</span>
			</div>
			<!-- eslint-disable-next-line svelte/no-at-html-tags — comment bodies are escaped at write time -->
			<div class="comment-body">{@html c.x_studio_body || ''}</div>
			{#if commentAtts(c.id).length}
				<div class="atts">
					{#each commentAtts(c.id) as a (a.id)}
						<a class="chip" href="{base}/api/attachments/{a.id}" target="_blank" rel="noopener">
							📎 {a.name}
						</a>
					{/each}
				</div>
			{/if}
		</div>
	{:else}
		<p class="muted">No comments yet.</p>
	{/each}

	<form class="card composer" onsubmit={addComment}>
		<textarea
			class="input"
			rows="3"
			placeholder="Write a comment…"
			bind:value={commentText}
		></textarea>
		<div class="composer-row">
			<input type="file" multiple bind:files={commentFiles} />
			<button class="btn btn--primary btn--sm" disabled={commenting}>
				{commenting ? 'Posting…' : 'Comment'}
			</button>
		</div>
	</form>
	{#if error}<p class="error-text">{error}</p>{/if}
{:else}
	<p class="muted" style="margin-top:40px;">Loading…</p>
{/if}

<style>
	.head-row {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 14px 0;
	}
	.sync {
		flex: 1;
		font-size: 0.82rem;
	}
	.share-panel {
		padding: 18px;
		margin-bottom: 16px;
	}
	.picker {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	.title-input {
		width: 100%;
		border: none;
		background: transparent;
		color: var(--text);
		font-family: var(--font-display);
		font-size: 1.7rem;
		font-weight: 700;
		letter-spacing: -0.015em;
		padding: 6px 2px;
	}
	.title-input:focus {
		outline: none;
	}
	.date-input {
		width: auto;
		margin: 4px 0 14px;
	}
	.comment {
		padding: 14px 16px;
		margin-bottom: 10px;
	}
	.comment-head {
		display: flex;
		gap: 10px;
		align-items: baseline;
		font-size: 0.88rem;
		margin-bottom: 6px;
	}
	.comment-body :global(p) {
		margin: 0 0 6px;
	}
	.atts {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin-top: 8px;
	}
	.atts a {
		text-decoration: none;
	}
	.composer {
		padding: 14px 16px;
		margin-top: 14px;
	}
	.composer-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 10px;
		margin-top: 10px;
	}
	.composer-row input[type='file'] {
		font-size: 0.82rem;
		color: var(--text-dim);
	}
</style>
