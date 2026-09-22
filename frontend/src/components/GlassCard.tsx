import type { ReactNode } from 'react';
import { cn } from '../lib/utils';

interface GlassCardProps {
  children: ReactNode;
  className?: string;
  glow?: boolean;
  hover?: boolean;
  onClick?: () => void;
}

export default function GlassCard({ children, className, glow, hover, onClick }: GlassCardProps) {
  return (
    <div
      onClick={onClick}
      className={cn(
        'glass rounded-2xl',
        glow && 'glow-green-sm',
        hover && 'glass-hover transition-all cursor-pointer',
        onClick && 'cursor-pointer',
        className
      )}
    >
      {children}
    </div>
  );
}
