<script>
	import { onDestroy } from 'svelte';

	let { onconfirm, label = 'Delete', confirmLabel = 'Sure?' } = $props();

	let armed = $state(false);
	let timer;

	function click() {
		if (armed) {
			clearTimeout(timer);
			armed = false;
			onconfirm();
		} else {
			armed = true;
			timer = setTimeout(() => (armed = false), 3000);
		}
	}

	onDestroy(() => clearTimeout(timer));
</script>

<button type="button" class="btn btn--sm btn--danger" class:armed onclick={click}>
	{armed ? confirmLabel : label}
</button>

<style>
	.armed {
		background: var(--red);
		border-color: var(--red);
		color: #fff;
	}
</style>
