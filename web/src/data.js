const bootstrapData = globalThis.window?.__ZF_INITIAL_DATA__;
const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});
const chinaDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
});
const chinaMinuteFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export function isSnapshotMode() {
  return Boolean(bootstrapData?.isSnapshot);
}

export async function fetchDashboard() {
  if (bootstrapData?.isSnapshot) return bootstrapData;

  const response = await fetch('/api/dashboard', {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`Could not load crawler data (${response.status}).`);
  return response.json();
}

async function submitAccount(path, values) {
  const response = await fetch(path, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    },
    body: new URLSearchParams(values),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `Request failed (${response.status}).`);
  }
  return response.json();
}

export function saveAccount(values) {
  return submitAccount('/api/accounts', values);
}

export function deleteAccount(id) {
  return submitAccount('/api/accounts/delete', { id });
}

export function formatDateTime(value) {
  if (!value) return 'Not recorded';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return dateTimeFormatter.format(date);
}

export function formatDrawTime(value) {
  if (!value) return 'Unknown';
  const normalized = value.trim().replace(/[/.]/g, '-').replace('T', ' ');
  const match = normalized.match(/^(20\d{2})-(\d{1,2})-(\d{1,2}) +(\d{1,2}):(\d{2})/);
  if (!match) return value;
  const [, year, month, day, hour, minute] = match;
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')} ${hour.padStart(2, '0')}:${minute}`;
}

export function chinaMinuteKey() {
  const parts = chinaMinuteFormatter.formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}`;
}

export function chinaDateKey() {
  return chinaDateFormatter.format(new Date());
}

export function humanizeStatus(value) {
  return String(value || 'unknown')
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function statusVariant(value) {
  const normalized = String(value || '').toLowerCase();
  if (['signed', 'already_signed', 'success'].includes(normalized)) return 'success';
  if (normalized === 'clicked') return 'info';
  if (['failed', 'error'].includes(normalized)) return 'danger';
  return 'neutral';
}
