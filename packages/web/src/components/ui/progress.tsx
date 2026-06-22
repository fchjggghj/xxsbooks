import * as React from 'react';
import { cn } from '@/lib/utils';

interface ProgressProps extends React.HTMLAttributes<HTMLDivElement> {
  value?: number;
  max?: number;
  indicatorClassName?: string;
  glow?: boolean;
}

const Progress = React.forwardRef<HTMLDivElement, ProgressProps>(
  ({ className, value = 0, max = 100, indicatorClassName, glow = false, ...props }, ref) => {
    const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
    return (
      <div
        ref={ref}
        role="progressbar"
        aria-valuenow={value}
        aria-valuemax={max}
        className={cn(
          'relative h-3 w-full overflow-hidden rounded-lg bg-surface-3 shadow-[inset_0_1px_2px_rgba(0,0,0,0.45)]',
          className,
        )}
        {...props}
      >
        <div
          className={cn(
            'h-full rounded-lg bg-gradient-to-r from-accent via-cyan-400 to-emerald-400 transition-all duration-500 ease-out',
            glow && 'glow-bar',
            indicatorClassName,
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
    );
  },
);
Progress.displayName = 'Progress';

interface MiniBarProps {
  donePct: number;
  failPct?: number;
  className?: string;
}

const MiniBar = React.forwardRef<HTMLDivElement, MiniBarProps>(
  ({ donePct, failPct = 0, className }, ref) => (
    <span
      ref={ref}
      className={cn(
        'inline-flex h-2 w-[122px] overflow-hidden rounded-lg bg-surface-3 align-middle shadow-[inset_0_1px_1px_rgba(0,0,0,0.4)]',
        className,
      )}
    >
      <i
        className="block h-full bg-gradient-to-r from-accent via-cyan-400 to-emerald-400 transition-all duration-500"
        style={{ width: `${Math.min(100, donePct)}%` }}
      />
      <i
        className="block h-full bg-gradient-to-r from-rose-500 to-fail transition-all duration-500"
        style={{ width: `${Math.min(100, failPct)}%` }}
      />
    </span>
  ),
);
MiniBar.displayName = 'MiniBar';

export { Progress, MiniBar };
