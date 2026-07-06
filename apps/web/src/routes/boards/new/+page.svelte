<script lang="ts">
  import BoardMetadataFields from "$lib/components/BoardMetadataFields.svelte";
  import type { PageProps } from "./$types";

  let { data, form }: PageProps = $props();

  const values = $derived(form?.values ?? {});
</script>

<svelte:head>
  <title>Create board — kdi</title>
</svelte:head>

<h1 class="stack-md">Create board</h1>

<form method="POST" action="/boards/new">
  <div class="form-group">
    <label for="slug">Slug</label>
    <input id="slug" name="slug" type="text" value={(values.slug as string) ?? ""} required />
  </div>

  <div class="form-group">
    <label for="workdir">Workdir</label>
    <input id="workdir" name="workdir" type="text" value={(values.workdir as string) ?? ""} required />
  </div>

  <div class="form-group">
    <label for="baseRef">Base ref</label>
    <input id="baseRef" name="baseRef" type="text" value={(values.baseRef as string) ?? "origin/main"} />
  </div>

  <BoardMetadataFields
    name={(values.name as string) ?? ""}
    icon={(values.icon as string) ?? ""}
    color={(values.color as string) ?? ""}
    description={(values.description as string) ?? ""}
    flags={data.flags}
  />

  <div class="form-group">
    <label>
      <input
        type="checkbox"
        name="switch"
        value="on"
        checked={values.switch === "on"}
        disabled={!data.flags.boardCreateSwitch}
        title={!data.flags.boardCreateSwitch ? "FF_BOARD_CREATE_SWITCH" : undefined}
      />
      Switch to this board after creation
    </label>
  </div>

  {#if form?.error}
    <p class="error">{form.error}</p>
  {/if}

  <div class="stack-sm">
    <button type="submit" class="btn btn--primary">Create board</button>
    <a href="/boards" class="btn">Cancel</a>
  </div>
</form>
