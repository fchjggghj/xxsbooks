import * as React from 'react';
import { cn } from '@/lib/utils';

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type = 'text', ...props }, ref) => {
    return (
      <input
        type={type}
        ref={ref}
        className={cn(
          'h-9 w-full rounded-[10px] border border-border/80 bg-surface-3/80 px-3 py-2 text-sm text-txt transition-all duration-150 placeholder:text-muted',
          'hover:border-border hover:bg-surface-3',
          'focus:border-accent focus:bg-surface-2 focus:outline-none focus:ring-2 focus:ring-accent/20',
          'disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        {...props}
      />
    );
  },
);
Input.displayName = 'Input';

export { Input };
