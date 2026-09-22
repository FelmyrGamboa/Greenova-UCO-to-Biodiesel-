import { STAGE_NAMES_LIST } from '../lib/store';
import type { ProcessStage } from '../lib/types';
import { cn } from '../lib/utils';

interface ProcessTimelineProps {
  stages: ProcessStage[];
  compact?: boolean;
}

export default function ProcessTimeline({ stages, compact }: ProcessTimelineProps) {
  return (
    <div className={cn('flex flex-col', compact ? 'gap-1' : 'gap-2')}>
      {STAGE_NAMES_LIST.map((name, i) => {
        const stage = stages.find((s) => s.stage_number === i + 1);
        const status = stage?.status ?? 'pending';
        return (
          <div key={i} className="flex items-center gap-3">
            {/* Icon */}
            <div className="flex-shrink-0">
              {status === 'completed' ? (
                <div className={cn('rounded-full flex items-center justify-center bg-green-500', compact ? 'w-5 h-5' : 'w-6 h-6')}>
                  <svg viewBox="0 0 20 20" fill="currentColor" className={compact ? 'w-2.5 h-2.5' : 'w-3 h-3'} style={{ color: '#040c07' }}>
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                </div>
              ) : status === 'current' ? (
                <div className={cn('rounded-full border-2 border-green-400 flex items-center justify-center', compact ? 'w-5 h-5' : 'w-6 h-6')}>
                  <div className={cn('rounded-full bg-green-400 gv-pulse', compact ? 'w-2 h-2' : 'w-2.5 h-2.5')} />
                </div>
              ) : status === 'error' ? (
                <div className={cn('rounded-full bg-red-500/20 border border-red-500/50 flex items-center justify-center', compact ? 'w-5 h-5' : 'w-6 h-6')}>
                  <span className="text-red-400 text-[10px] font-bold">!</span>
                </div>
              ) : (
                <div className={cn('rounded-full border border-gray-700 bg-gray-800/50', compact ? 'w-5 h-5' : 'w-6 h-6')} />
              )}
            </div>

            {/* Label */}
            <span
              className={cn(
                compact ? 'text-xs' : 'text-sm',
                status === 'completed' ? 'text-green-400' :
                status === 'current' ? 'text-white font-semibold' :
                status === 'error' ? 'text-red-400' :
                'text-gray-600'
              )}
            >
              {name}
            </span>
          </div>
        );
      })}
    </div>
  );
}
