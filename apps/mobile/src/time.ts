/**
 * Shared relative-time label for list rows (history, activity,
 * comments, notifications): "just now", "5m ago", "3h ago", "2d
 * ago", then the plain date. Same wording the Library tab has used
 * since M2 (its local copy predates this shared one).
 */
export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}
