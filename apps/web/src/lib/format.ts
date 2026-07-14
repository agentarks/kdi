// KDI-UI-009 Slice 1: human-readable duration for the oldest-ready-age stat
// (FR-6: e.g. "3h 12m"). Compound of the two largest units so it stays short.
// ponytail: pure function, no Intl.DurationFormat (not in Bun 1.3 stable set).
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0s";
  const s = Math.floor(seconds);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  if (mins > 0) return `${mins}m`;
  return `${secs}s`;
}
