<script lang="ts">
  import "../app.css";
  import FlagBadge from "$lib/components/FlagBadge.svelte";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";

  let { children } = $props();

  const nav = [
    { href: "/boards/default", label: "Board" },
    { href: "/tasks", label: "Tasks" },
    { href: "/dispatch", label: "Dispatch" },
    { href: "/activity", label: "Activity" },
    { href: "/stats", label: "Stats" },
  ];

  // ponytail: placeholder boards until KDI-UI-002 wires real data in.
  const boards = ["default", "myproj"];
  const boardSlug = $derived(
    page.url.pathname.match(/^\/boards\/([^/]+)/)?.[1] ??
      page.url.searchParams.get("board") ??
      "default"
  );

  function isActive(href: string): boolean {
    return page.url.pathname.startsWith(href);
  }

  function switchBoard(event: Event) {
    const target = event.target as HTMLSelectElement;
    goto(`/boards/${target.value}${window.location.search}`);
  }
</script>

<div class="app-shell">
  <header class="topbar">
    <span class="brand">kdi</span>
    <span class="board-switcher">
      <label for="board-select" class="sr-only">Board</label>
      <select id="board-select" name="board" value={boardSlug} onchange={switchBoard}>
        {#each boards as b}
          <option value={b}>{b}</option>
        {/each}
      </select>
    </span>
    <FlagBadge />
  </header>

  <nav class="sidebar nav">
    <h2>Views</h2>
    {#each nav as item}
      <a
        href={item.href}
        class="nav-link"
        class:active={isActive(item.href)}
        aria-current={isActive(item.href) ? "page" : undefined}
      >
        {item.label}
      </a>
    {/each}
  </nav>

  <main class="main">
    <section class="work-area">
      {@render children()}
    </section>
    <div class="command-bar">
      <label for="cmd-input" class="sr-only">Command</label>
      <input
        id="cmd-input"
        name="command"
        type="text"
        placeholder="Run a command or search tasks… (UI actions land in KDI-UI-006)"
        disabled
      />
      <button class="btn" type="button" disabled>Run</button>
    </div>
  </main>
</div>

