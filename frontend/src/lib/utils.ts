export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

export function formatElapsed(startIso: string): string {
  const start = new Date(startIso).getTime();
  const elapsed = Math.floor((Date.now() - start) / 1000);
  const h = Math.floor(elapsed / 3600);
  const m = Math.floor((elapsed % 3600) / 60);
  const s = elapsed % 60;
  return [h, m, s].map((v) => String(v).padStart(2, '0')).join(':');
}

export function cn(...classes: (string | undefined | null | false)[]): string {
  return classes.filter(Boolean).join(' ');
}

export function statusColor(status: string): string {
  switch (status) {
    case 'Completed': return 'text-green-400';
    case 'In Progress': return 'text-blue-400';
    case 'Paused': return 'text-yellow-400';
    case 'Stopped': return 'text-red-400';
    case 'Error': return 'text-red-500';
    case 'Draft': return 'text-gray-400';
    case 'Ready': return 'text-cyan-400';
    default: return 'text-gray-400';
  }
}

export function statusDotColor(status: string): string {
  switch (status) {
    case 'Completed': return 'bg-green-400';
    case 'In Progress': return 'bg-blue-400';
    case 'Paused': return 'bg-yellow-400';
    case 'Stopped': return 'bg-red-400';
    case 'Error': return 'bg-red-500';
    case 'Draft': return 'bg-gray-500';
    case 'Ready': return 'bg-cyan-400';
    default: return 'bg-gray-500';
  }
}

export function severityColor(severity: string): string {
  switch (severity) {
    case 'info': return 'text-blue-400';
    case 'warning': return 'text-yellow-400';
    case 'critical': return 'text-red-400';
    default: return 'text-gray-400';
  }
}

export function truncate(str: string, len: number): string {
  return str.length > len ? str.slice(0, len) + '…' : str;
}

export function getInitials(name: string): string {
  return name
    .split(' ')
    .map((p) => p[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}
