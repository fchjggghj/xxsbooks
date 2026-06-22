import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[10px] text-sm font-semibold transition-all duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:pointer-events-none disabled:opacity-45 active:translate-y-0 active:scale-[0.98]',
  {
    variants: {
      variant: {
        default:
          'bg-surface-3 text-txt border border-border/80 hover:bg-surface-4 hover:border-accent-2/40 hover:-translate-y-px shadow-sm',
        primary:
          'bg-gradient-to-br from-accent to-indigo-600 text-white border border-transparent shadow-[0_8px_24px_-8px_rgba(99,102,241,0.55),inset_0_1px_0_rgba(255,255,255,0.18)] hover:brightness-110 hover:shadow-[0_12px_28px_-8px_rgba(99,102,241,0.65),inset_0_1px_0_rgba(255,255,255,0.22)] hover:-translate-y-px',
        destructive:
          'bg-fail/12 text-rose-200 border border-fail/45 hover:bg-fail/20 hover:border-fail hover:-translate-y-px shadow-[0_8px_24px_-12px_rgba(251,113,133,0.5)]',
        outline:
          'bg-transparent text-txt border border-border hover:bg-surface-3 hover:border-accent-2/40',
        secondary: 'bg-surface-2 text-dim border border-border/70 hover:bg-surface-3 hover:text-txt',
        ghost:
          'bg-transparent text-dim hover:bg-surface-3/70 hover:text-txt border border-transparent',
        link: 'bg-transparent text-accent-2 underline-offset-4 hover:underline border-none p-0 h-auto',
        success:
          'bg-ok/12 text-emerald-200 border border-ok/45 hover:bg-ok/20 hover:border-ok hover:-translate-y-px shadow-[0_8px_24px_-12px_rgba(52,211,153,0.5)]',
      },
      size: {
        default: 'h-9 px-3.5 min-h-[36px]',
        sm: 'h-8 px-3 text-xs min-h-[32px] gap-1.5',
        lg: 'h-11 px-6 text-base min-h-[44px]',
        icon: 'h-9 w-9 p-0 min-h-[36px]',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => {
    return (
      <button
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
