export function formatClock(unix: number, withSeconds = false): string {
  return new Date(unix * 1000).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
    ...(withSeconds ? { second: '2-digit' } : {}),
  });
}

export function formatRelative(unix: number): string {
  const diff = Date.now() / 1000 - unix;
  if (diff < 60) return 'Just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  const d = new Date(unix * 1000);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  const time = formatClock(unix);
  if (d.toDateString() === today.toDateString()) return `Today ${time}`;
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

export function formatDay(unix: number): string {
  const d = new Date(unix * 1000);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === new Date(Date.now() - 86_400_000).toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}

export function labelFor(objects: string[]): string {
  if (objects.length === 0) return 'Motion';
  const uniq = [...new Set(objects)];
  const pretty = uniq.map((o) => o.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()));
  return pretty.length > 2 ? `${pretty.slice(0, 2).join(', ')} +${pretty.length - 2}` : pretty.join(' & ');
}

/** Current time in unix seconds. */
export function nowSec(): number {
  return Date.now() / 1000;
}

/** Event title: recognized names first ("Zach"), else the object labels ("Person & Car"). */
export function titleFor(item: { objects: string[]; subLabels?: string[] }): string {
  const names = [...new Set(item.subLabels ?? [])];
  return names.length ? names.join(' & ') : labelFor(item.objects);
}
