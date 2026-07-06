export function formatCommitTimestamp(atMs: number, nowMs: number): string {
  const deltaSeconds = Math.max(0, Math.floor((nowMs - atMs) / 1000));
  if (deltaSeconds < 30) return "just now";
  if (deltaSeconds < 3600) return `${Math.floor(deltaSeconds / 60)}m ago`;
  if (deltaSeconds < 86_400) return `${Math.floor(deltaSeconds / 3600)}h ago`;
  return `${Math.floor(deltaSeconds / 86_400)}d ago`;
}
