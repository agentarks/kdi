// UI-facing types shared between the SvelteKit components and the server-side
// data bridge. Kept outside $lib/server so client components can import them
// without crossing the server-only module boundary.

export interface BoardRef {
  slug: string;
  name: string;
  archived: boolean;
}

export interface BoardListRow extends BoardRef {
  id: number;
  icon: string | null;
  color: string | null;
  description: string | null;
  workdir: string;
  defaultWorkdir: string | null;
  baseRef: string;
  createdAt: number;
  statusCounts: Record<string, number>;
}

export interface BoardFlags {
  boardMetadata: boolean;
  boardCreateSwitch: boolean;
  defaultWorkdir: boolean;
  boardSwitch: boolean;
  boardRenameHermes: boolean;
  boardRename: boolean;
  boardRmDelete: boolean;
}

export interface FormResult {
  error?: string;
  intent?: string;
  slug?: string;
  success?: boolean;
  values?: Record<string, unknown>;
}
