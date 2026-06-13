export const SLUG_RE = /^[a-zA-Z0-9_-]+$/;

export function assertValidBoardSlug(slug: string, label: string = "board slug"): void {
  if (!SLUG_RE.test(slug)) {
    throw new Error(`Invalid ${label} "${slug}". Slugs may only contain letters, numbers, underscores, and hyphens.`);
  }
}
