import * as React from 'react';
import { cn } from '@/lib/utils';

interface TooltipProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'content'> {
  content: React.ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
  delay?: number;
}

const Tooltip = React.forwardRef<HTMLDivElement, TooltipProps>(
  ({ content, side = 'top', delay = 100, className, children, ...props }, ref) => {
    const [visible, setVisible] = React.useState(false);
    const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    const show = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setVisible(true), delay);
    };
    const hide = () => {
      if (timer.current) clearTimeout(timer.current);
      setVisible(false);
    };

    React.useEffect(() => {
      return () => {
        if (timer.current) clearTimeout(timer.current);
      };
    }, []);

    const sideClasses: Record<string, string> = {
      top: 'bottom-full left-1/2 -translate-x-1/2 mb-2',
      bottom: 'top-full left-1/2 -translate-x-1/2 mt-2',
      left: 'right-full top-1/2 -translate-y-1/2 mr-2',
      right: 'left-full top-1/2 -translate-y-1/2 ml-2',
    };

    return (
      <div
        ref={ref}
        className={cn('relative inline-flex', className)}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        {...props}
      >
        {children}
        {visible && (
          <div
            role="tooltip"
            className={cn(
              'absolute z-50 max-w-xs rounded-lg border border-accent bg-surface-2 px-3 py-2 text-xs leading-relaxed text-txt shadow-[0_24px_60px_-28px_rgba(0,0,0,0.78)] animate-fade-in pointer-events-none',
              sideClasses[side],
            )}
          >
            {content}
          </div>
        )}
      </div>
    );
  },
);
Tooltip.displayName = 'Tooltip';

export { Tooltip };
