import { fmtDate, fmtTime, tr } from '../i18n/index.ts';

export function formatClock(unix: number, withSeconds = false): string {
  return fmtTime(new Date(unix * 1000), withSeconds);
}

export function formatRelative(unix: number): string {
  const c = tr().common;
  const diff = Date.now() / 1000 - unix;
  if (diff < 60) return c.justNow;
  if (diff < 3600) return c.minAgo(Math.floor(diff / 60));
  const d = new Date(unix * 1000);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  const time = formatClock(unix);
  if (d.toDateString() === today.toDateString()) return c.todayAt(time);
  if (d.toDateString() === yesterday.toDateString()) return c.yesterdayAt(time);
  return c.dateAt(fmtDate(d, { month: 'short', day: 'numeric' }), time);
}

export function formatDay(unix: number): string {
  const c = tr().common;
  const d = new Date(unix * 1000);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return c.today;
  if (d.toDateString() === new Date(Date.now() - 86_400_000).toDateString()) return c.yesterday;
  return fmtDate(d, { weekday: 'long', month: 'short', day: 'numeric' });
}

/** A detected object's name in the app's language ("person" → "Person" / "Persona"). */
export function objectLabel(o: string): string {
  return tr().common.objects[o] ?? o.replace(/_/g, ' ').replace(/^\w/, (ch) => ch.toUpperCase());
}

export function labelFor(objects: string[]): string {
  const c = tr().common;
  if (objects.length === 0) return c.motion;
  const uniq = [...new Set(objects)];
  const pretty = uniq.map(objectLabel);
  if (pretty.length > 2) return c.andMore(pretty.slice(0, 2).join(', '), pretty.length - 2);
  return pretty.length === 2 ? c.both(pretty[0], pretty[1]) : pretty[0];
}

/** Current time in unix seconds. */
export function nowSec(): number {
  return Date.now() / 1000;
}

/** Event title: recognized names first ("Zach"), else the object labels ("Person & Car"). */
export function titleFor(item: { objects: string[]; subLabels?: string[] }): string {
  const names = [...new Set(item.subLabels ?? [])];
  if (!names.length) return labelFor(item.objects);
  return names.length === 2 ? tr().common.both(names[0], names[1]) : names.join(' & ');
}
