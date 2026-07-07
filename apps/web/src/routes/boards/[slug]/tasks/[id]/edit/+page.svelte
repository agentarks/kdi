<script lang="ts">
  import { enhance } from "$app/forms";
  import type { PageData, ActionData } from "./$types";

  interface Props {
    data: PageData;
    form: ActionData;
  }

  let { data, form }: Props = $props();

  let body = $state("");

  $effect(() => {
    body = form?.body ?? data.task.body ?? "";
  });
</script>

<svelte:head>
  <title>Edit task #{data.task.id} — {data.board.name}</title>
</svelte:head>

<div class="stack-md">
  <div class="stack-sm">
    <a href="/boards/{data.board.slug}/tasks/{data.task.id}">← Back to task</a>
    <h1>Edit body: {data.task.title}</h1>
  </div>

  {#if form?.error}
    <div class="placeholder" style="padding: 12px; text-align: left;">
      <strong>Error:</strong> {form.error}
    </div>
  {/if}

  <form method="POST" action="?/" use:enhance class="stack-md">
    <div class="stack-sm">
      <label for="body">Body</label>
      <textarea id="body" name="body" rows="8" required bind:value={body}></textarea>
    </div>

    <div class="stack-sm">
      <button type="submit" class="btn btn--primary">Save body</button>
      <a href="/boards/{data.board.slug}/tasks/{data.task.id}" class="btn" role="button">Cancel</a>
    </div>
  </form>
</div>

<style>
  label {
    display: block;
    margin-bottom: 4px;
    color: var(--text-dim);
    font-size: 13px;
  }
  textarea {
    width: 100%;
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 8px 10px;
    color: var(--text);
  }
</style>
