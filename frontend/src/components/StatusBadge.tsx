import { cn } from '../lib/utils';

interface StatusBadgeProps {
  status: string;
  size?: 'sm' | 'md';
}

const configs: Record<string, { text: string; bg: string }> = {
  Completed:    { text: 'text-green-400',  bg: 'bg-green-400/10 border-green-400/20' },
  'In Progress':{ text: 'text-blue-400',   bg: 'bg-blue-400/10 border-blue-400/20' },
  Paused:       { text: 'text-yellow-400', bg: 'bg-yellow-400/10 border-yellow-400/20' },
  Stopped:      { text: 'text-red-400',    bg: 'bg-red-400/10 border-red-400/20' },
  Error:        { text: 'text-red-400',    bg: 'bg-red-500/10 border-red-500/20' },
  Draft:        { text: 'text-gray-400',   bg: 'bg-gray-500/10 border-gray-500/20' },
  Ready:        { text: 'text-cyan-400',   bg: 'bg-cyan-400/10 border-cyan-400/20' },
  Normal:       { text: 'text-green-400',  bg: 'bg-green-400/10 border-green-400/20' },
  Warning:      { text: 'text-yellow-400', bg: 'bg-yellow-400/10 border-yellow-400/20' },
  Critical:     { text: 'text-red-400',    bg: 'bg-red-500/10 border-red-500/20' },
  Disconnected: { text: 'text-gray-400',   bg: 'bg-gray-500/10 border-gray-500/20' },
  active:       { text: 'text-green-400',  bg: 'bg-green-400/10 border-green-400/20' },
  inactive:     { text: 'text-gray-400',   bg: 'bg-gray-500/10 border-gray-500/20' },
};

export default function StatusBadge({ status, size = 'md' }: StatusBadgeProps) {
  const cfg = configs[status] ?? { text: 'text-gray-400', bg: 'bg-gray-500/10 border-gray-500/20' };
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border font-medium',
        cfg.bg,
        cfg.text,
        size === 'sm' ? 'text-[11px] px-2 py-0.5' : 'text-xs px-2.5 py-1'
      )}
    >
      {status}
    </span>
  );
}
