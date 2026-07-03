<script lang="ts">
  import type { BoardFlags } from "$lib/types";

  interface Props {
    name?: string;
    icon?: string;
    color?: string;
    description?: string;
    flags: BoardFlags;
  }
  let { name = "", icon = "", color = "", description = "", flags }: Props = $props();

  const disabled = $derived(!flags.boardMetadata);
  const tooltip = $derived(!flags.boardMetadata ? "FF_BOARD_METADATA" : undefined);
</script>

<div class="stack-md">
  <div class="form-group">
    <label for="board-name">Display name</label>
    <input
      id="board-name"
      name="name"
      type="text"
      value={name}
      {disabled}
      title={tooltip}
    />
  </div>

  <div class="form-group">
    <label for="board-icon">Icon</label>
    <input
      id="board-icon"
      name="icon"
      type="text"
      value={icon}
      {disabled}
      title={tooltip}
    />
  </div>

  <div class="form-group">
    <label for="board-color">Color</label>
    <input
      id="board-color"
      name="color"
      type="text"
      value={color}
      {disabled}
      title={tooltip}
    />
  </div>

  <div class="form-group">
    <label for="board-description">Description</label>
    <textarea
      id="board-description"
      name="description"
      rows={3}
      value={description}
      {disabled}
      title={tooltip}
    ></textarea>
  </div>
</div>
