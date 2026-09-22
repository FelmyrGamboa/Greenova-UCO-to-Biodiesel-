import { cn } from '../lib/utils';

interface StatusBadgeProps {
  status: string;
  size?: 'sm' | 'md';
}

const configs: Record<string, { dot: string; text: string; bg: string }> = {
  Completed:    { dot: 'bg-green-400',  text: 'text-green-400',  bg: 'bg-green-400/10 border-green-400/20' },
  'In Progress':{ dot: 'bg-blue-400',   text: 'text-blue-400',   bg: 'bg-blue-400/10 border-blue-400/20' },
  Paused:       { dot: 'bg-yellow-400', text: 'text-yellow-400', bg: 'bg-yellow-400/10 border-yellow-400/20' },
  Stopped:      { dot: 'bg-red-400',    text: 'text-red-400',    bg: 'bg-red-400/10 border-red-400/20' },
  Error:        { dot: 'bg-red-500',    text: 'text-red-400',    bg: 'bg-red-500/10 border-red-500/20' },
  Draft:        { dot: 'bg-gray-500',   text: 'text-gray-400',   bg: 'bg-gray-500/10 border-gray-500/20' },
  Ready:        { dot: 'bg-cyan-400',   text: 'text-cyan-400',   bg: 'bg-cyan-400/10 border-cyan-400/20' },
  Normal:       { dot: 'bg-green-400',  text: 'text-green-400',  bg: 'bg-green-400/10 border-green-400/20' },
  Warning:      { dot: 'bg-yellow-400', text: 'text-yellow-400', bg: 'bg-yellow-400/10 border-yellow-400/20' },
  Critical:     { dot: 'bg-red-500',    text: 'text-red-400',    bg: 'bg-red-500/10 border-red-500/20' },
  Disconnected: { dot: 'bg-gray-500',   text: 'text-gray-400',   bg: 'bg-gray-500/10 border-gray-500/20' },
  active:       { dot: 'bg-green-400',  text: 'text-green-400',  bg: 'bg-green-400/10 border-green-400/20' },
  inactive:     { dot: 'bg-gray-500',   text: 'text-gray-400',   bg: 'bg-gray-500/10 border-gray-500/20' },
};

export default function StatusBadge({ status, size = 'md' }: StatusBadgeProps) {
  const cfg = configs[status] ?? { dot: 'bg-gray-500', text: 'text-gray-400', bg: 'bg-gray-500/10 border-gray-500/20' };
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border font-medium',
        cfg.bg,
        cfg.text,
        size === 'sm' ? 'text-[11px] px-2 py-0.5' : 'text-xs px-2.5 py-1'
      )}
    >
      <span
        className={cn('status-dot flex-shrink-0', cfg.dot, size === 'sm' ? 'w-1.5 h-1.5' : 'w-2 h-2',
          ['In Progress', 'Paused'].includes(status) ? 'gv-pulse' : ''
        )}
      />
      {status}
    </span>
  );
}
