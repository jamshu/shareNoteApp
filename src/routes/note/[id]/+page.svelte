<script>
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { user } from '$lib/auth.js';
	import { odooClient } from '$lib/odoo.js';
	import ConfirmButton from '$lib/components/ConfirmButton.svelte';

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
	let viewerAtt = $state(null); // attachment open in the in-app viewer overlay
	let pdfBox = $state(null); // container for pdf.js page canvases

	$effect(() => {
		if (pdfBox && viewerAtt?.mimetype === 'application/pdf') renderPdf(viewerAtt.id, pdfBox);
	});

	async function renderPdf(attId, el) {
		try {
			const pdfjs = await import('pdfjs-dist');
			pdfjs.GlobalWorkerOptions.workerSrc = (
				await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
			).default;
			// fetch ourselves so the session cookie is sent
			const res = await fetch(`${base}/api/attachments/${attId}`);
			if (!res.ok) throw new Error(await res.text());
			const doc = await pdfjs.getDocument({ data: await res.arrayBuffer() }).promise;
			el.innerHTML = '';
			const width = el.clientWidth;
			for (let i = 1; i <= doc.numPages; i++) {
				const page = await doc.getPage(i);
				const scale = width / page.getViewport({ scale: 1 }).width;
				const vp = page.getViewport({ scale: scale * (window.devicePixelRatio || 1) });
				const canvas = document.createElement('canvas');
				canvas.width = vp.width;
				canvas.height = vp.height;
				canvas.style.width = '100%';
				el.appendChild(canvas);
				await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport: vp })
					.promise;
			}
		} catch (e) {
			el.textContent = `Failed to load PDF: ${e.message}`;
		}
	}
	let commentText = $state('');
	let commentFiles = $state(null);
	let commenting = $state(false);
	let editingId = $state(null);
	let editText = $state('');
	let savingEdit = $state(false);

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

	// inverse of the composer encoding: <p>…<br/>…</p> back to plain text
	const htmlToText = (h) =>
		String(h || '')
			.replace(/<br\s*\/?>/gi, '\n')
			.replace(/<\/p>\s*<p>/gi, '\n\n')
			.replace(/<[^>]*>/g, '')
			.replace(/&lt;/g, '<')
			.replace(/&gt;/g, '>')
			.replace(/&amp;/g, '&')
			.trim();

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
		try {
			await odooClient.deleteRecord(noteId);
			goto(`${base}/`);
		} catch (e) {
			error = e.message;
		}
	}

	async function deleteComment(id) {
		error = '';
		try {
			await odooClient.deleteRecord(id, 'comments');
			if (editingId === id) editingId = null;
			await loadComments();
		} catch (e) {
			error = e.message;
		}
	}

	function startEdit(c) {
		editingId = c.id;
		editText = htmlToText(c.x_studio_body);
	}

	async function saveEdit() {
		const text = editText.trim();
		if (!text || savingEdit) return;
		savingEdit = true;
		error = '';
		try {
			const body = `<p>${esc(text).replace(/\n/g, '<br/>')}</p>`;
			await odooClient.updateRecord(editingId, { x_studio_body: body }, 'comments');
			editingId = null;
			editText = '';
			await loadComments();
		} catch (e) {
			error = e.message;
		} finally {
			savingEdit = false;
		}
	}

	const fmtWhen = (d) => (d ? new Date(d + 'Z').toLocaleString() : '');
	const commentAtts = (cid) => attachments.filter((a) => a.commentId === cid);

	/* ── rich text toolbar ───────────────────────────────────────────── */
	// ponytail: execCommand is deprecated but universally supported and dependency-free;
	// swap for Tiptap if it ever breaks.
	function exec(cmd, value = null) {
		bodyEl?.focus();
		document.execCommand(cmd, false, value);
		scheduleSave({ x_studio_notes: bodyEl.innerHTML });
	}

	function addLink() {
		const url = prompt('Link URL (https://…)');
		if (url) exec('createLink', url);
	}

	const TOOLBAR = [
		{ cmd: 'bold', label: 'B', title: 'Bold', style: 'font-weight:700' },
		{ cmd: 'italic', label: 'I', title: 'Italic', style: 'font-style:italic' },
		{ cmd: 'underline', label: 'U', title: 'Underline', style: 'text-decoration:underline' },
		{ cmd: 'strikeThrough', label: 'S', title: 'Strikethrough', style: 'text-decoration:line-through' },
		{ sep: true },
		{ cmd: 'formatBlock', value: '<h1>', label: 'H1', title: 'Heading 1' },
		{ cmd: 'formatBlock', value: '<h2>', label: 'H2', title: 'Heading 2' },
		{ cmd: 'formatBlock', value: '<h3>', label: 'H3', title: 'Heading 3' },
		{ cmd: 'formatBlock', value: '<p>', label: '¶', title: 'Paragraph' },
		{ sep: true },
		{ cmd: 'insertUnorderedList', label: '•', title: 'Bullet list' },
		{ cmd: 'insertOrderedList', label: '1.', title: 'Numbered list' },
		{ cmd: 'formatBlock', value: '<blockquote>', label: '❝', title: 'Quote' },
		{ cmd: 'formatBlock', value: '<pre>', label: '</>', title: 'Code block' },
		{ sep: true },
		{ cmd: 'justifyLeft', label: '⇤', title: 'Align left' },
		{ cmd: 'justifyCenter', label: '↔', title: 'Align center' },
		{ cmd: 'justifyRight', label: '⇥', title: 'Align right' },
		{ sep: true },
		{ link: true, label: '🔗', title: 'Insert link' },
		{ cmd: 'removeFormat', label: '✕', title: 'Clear formatting' }
	];
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
			<ConfirmButton onconfirm={deleteNote} />
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

	{#if canEdit}
		<div class="toolbar card">
			{#each TOOLBAR as t, i (i)}
				{#if t.sep}
					<span class="tb-sep"></span>
				{:else}
					<button
						class="tb-btn"
						title={t.title}
						style={t.style || ''}
						onmousedown={(e) => e.preventDefault()}
						onclick={() => (t.link ? addLink() : exec(t.cmd, t.value))}
					>{t.label}</button>
				{/if}
			{/each}
			<span class="tb-sep"></span>
			<label class="tb-color" title="Text color">
				A<input type="color" onchange={(e) => exec('foreColor', e.target.value)} />
			</label>
			<label class="tb-color" title="Highlight">
				🖊<input type="color" value="#fff59d" onchange={(e) => exec('hiliteColor', e.target.value)} />
			</label>
		</div>
	{/if}
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
				{#if c.create_uid?.[0] === $user?.uid}
					<div class="comment-actions">
						{#if editingId === c.id}
							<button class="btn btn--sm btn--ghost" onclick={() => (editingId = null)}>
								Cancel
							</button>
						{:else}
							<button class="btn btn--sm btn--ghost" onclick={() => startEdit(c)}>Edit</button>
							<ConfirmButton onconfirm={() => deleteComment(c.id)} />
						{/if}
					</div>
				{/if}
			</div>
			{#if editingId === c.id}
				<textarea class="input" rows="3" bind:value={editText}></textarea>
				<div class="edit-row">
					<button
						class="btn btn--primary btn--sm"
						disabled={savingEdit || !editText.trim()}
						onclick={saveEdit}
					>
						{savingEdit ? 'Saving…' : 'Save'}
					</button>
				</div>
			{:else}
				<!-- eslint-disable-next-line svelte/no-at-html-tags — comment bodies are escaped at write time -->
				<div class="comment-body">{@html c.x_studio_body || ''}</div>
			{/if}
			{#if commentAtts(c.id).length}
				<div class="atts">
					{#each commentAtts(c.id) as a (a.id)}
						<button type="button" class="chip" onclick={() => (viewerAtt = a)}>
							📎 {a.name}
						</button>
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

<svelte:window onkeydown={(e) => e.key === 'Escape' && (viewerAtt = null)} />

{#if viewerAtt}
	<div
		class="viewer"
		role="dialog"
		aria-label={viewerAtt.name}
		onclick={(e) => e.target === e.currentTarget && (viewerAtt = null)}
	>
		<div class="viewer-head">
			<span class="viewer-name">{viewerAtt.name}</span>
			<a
				class="btn btn--sm"
				href="{base}/api/attachments/{viewerAtt.id}?download=1"
				download={viewerAtt.name}
			>
				⬇ Download
			</a>
			<button class="btn btn--sm" onclick={() => (viewerAtt = null)}>✕</button>
		</div>
		{#if viewerAtt.mimetype?.startsWith('image/')}
			<img class="viewer-body" src="{base}/api/attachments/{viewerAtt.id}" alt={viewerAtt.name} />
		{:else if viewerAtt.mimetype === 'application/pdf'}
			<!-- pdf.js canvases — iOS WebKit won't render PDFs in an iframe -->
			<div class="viewer-body viewer-pdf" bind:this={pdfBox}>Loading PDF…</div>
		{:else}
			<p class="viewer-none">No preview available — use Download.</p>
		{/if}
	</div>
{/if}

<style>
	.viewer {
		position: fixed;
		inset: 0;
		z-index: 50;
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 12px;
		padding-top: calc(12px + env(safe-area-inset-top));
		background: rgba(0, 0, 0, 0.85);
	}
	.viewer-head {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.viewer-name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: #fff;
		font-size: 0.9rem;
	}
	.viewer-body {
		flex: 1;
		min-height: 0;
		width: 100%;
		object-fit: contain;
		border: none;
		border-radius: 10px;
		background: #fff;
	}
	img.viewer-body {
		background: transparent;
	}
	.viewer-pdf {
		overflow-y: auto;
		-webkit-overflow-scrolling: touch;
		padding: 8px;
		color: #333;
	}
	.viewer-pdf :global(canvas) {
		display: block;
		margin: 0 auto 8px;
	}
	.viewer-none {
		margin: auto;
		color: #fff;
	}
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
	.toolbar {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 2px;
		padding: 6px 8px;
		margin-bottom: 8px;
		position: sticky;
		top: 8px;
		z-index: 5;
	}
	.tb-btn {
		min-width: 32px;
		height: 30px;
		padding: 0 7px;
		border-radius: 8px;
		font-size: 0.88rem;
		color: var(--text-dim);
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}
	.tb-btn:hover {
		background: var(--surface-2);
		color: var(--text);
	}
	.tb-sep {
		width: 1px;
		height: 20px;
		background: var(--border);
		margin: 0 5px;
	}
	.tb-color {
		position: relative;
		min-width: 32px;
		height: 30px;
		border-radius: 8px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		font-size: 0.88rem;
		color: var(--text-dim);
		cursor: pointer;
	}
	.tb-color:hover {
		background: var(--surface-2);
		color: var(--text);
	}
	.tb-color input[type='color'] {
		position: absolute;
		inset: 0;
		opacity: 0;
		cursor: pointer;
	}
	/* rendered note content */
	.richtext :global(h1),
	.richtext :global(h2),
	.richtext :global(h3) {
		margin: 0.6em 0 0.3em;
	}
	.richtext :global(ul),
	.richtext :global(ol) {
		padding-left: 1.4em;
		margin: 0.4em 0;
	}
	.richtext :global(blockquote) {
		margin: 0.6em 0;
		padding: 4px 14px;
		border-left: 3px solid var(--accent);
		color: var(--text-dim);
	}
	.richtext :global(pre) {
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding: 10px 12px;
		overflow-x: auto;
		font-size: 0.88rem;
	}
	.richtext :global(a) {
		color: var(--accent);
	}
	.comment {
		padding: 14px 16px;
		margin-bottom: 10px;
	}
	.comment-head {
		display: flex;
		flex-wrap: wrap;
		gap: 6px 10px;
		align-items: center;
		font-size: 0.88rem;
		margin-bottom: 6px;
	}
	.comment-actions {
		display: flex;
		gap: 6px;
		margin-left: auto;
	}
	.edit-row {
		display: flex;
		justify-content: flex-end;
		margin-top: 8px;
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
		flex-wrap: wrap;
		justify-content: space-between;
		align-items: center;
		gap: 10px;
		margin-top: 10px;
	}
	.composer-row input[type='file'] {
		flex: 1 1 160px;
		min-width: 0;
		max-width: 100%;
		font-size: 0.82rem;
		color: var(--text-dim);
	}
	.composer-row .btn {
		flex-shrink: 0;
		margin-left: auto;
	}
</style>
