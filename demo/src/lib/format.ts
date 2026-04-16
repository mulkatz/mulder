import { format, formatDistanceToNowStrict } from 'date-fns';

export function formatPageRange(start: number | null | undefined, end: number | null | undefined) {
  if (typeof start === 'number' && typeof end === 'number') {
    return start === end ? `p. ${start}` : `pp. ${start}-${end}`;
  }

  if (typeof start === 'number') {
    return `p. ${start}`;
  }

  if (typeof end === 'number') {
    return `p. ${end}`;
  }

  return 'Pages unavailable';
}

export function formatConfidence(value: number | null | undefined) {
  if (typeof value !== 'number') {
    return 'Unknown';
  }

  return `${Math.round(value * 100)}%`;
}

export function formatTimestamp(value: string) {
  return format(new Date(value), 'dd MMM yyyy, HH:mm');
}

export function formatRelativeTimestamp(value: string) {
  return formatDistanceToNowStrict(new Date(value), { addSuffix: true });
}

export function initials(value: string) {
  return value
    .split(/\s+/)
    .map((part) => part[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();
}
