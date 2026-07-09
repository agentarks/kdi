export function clampInterval(value: number | null | undefined): number {
  if (value === null || value === undefined || Number.isNaN(value) || !Number.isFinite(value)) return 2;
  if (value < 2) return 2;
  if (value > 30) return 30;
  return value;
}
