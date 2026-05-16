const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  const diff = now.getTime() - then;
  const abs = Math.abs(diff);
  const future = diff < 0;

  let value: number;
  let unit: string;

  if (abs < MINUTE) {
    return future ? 'in a moment' : 'just now';
  } else if (abs < HOUR) {
    value = Math.round(abs / MINUTE);
    unit = 'minute';
  } else if (abs < DAY) {
    value = Math.round(abs / HOUR);
    unit = 'hour';
  } else if (abs < WEEK) {
    value = Math.round(abs / DAY);
    unit = 'day';
  } else if (abs < MONTH) {
    value = Math.round(abs / WEEK);
    unit = 'week';
  } else if (abs < YEAR) {
    value = Math.round(abs / MONTH);
    unit = 'month';
  } else {
    value = Math.round(abs / YEAR);
    unit = 'year';
  }

  const plural = value === 1 ? '' : 's';
  return future ? `in ${value} ${unit}${plural}` : `${value} ${unit}${plural} ago`;
}

export function formatAbsoluteDate(iso: string, opts: Intl.DateTimeFormatOptions = { dateStyle: 'long' }): string {
  return new Date(iso).toLocaleDateString(undefined, opts);
}

export function formatMonthYear(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short' });
}
