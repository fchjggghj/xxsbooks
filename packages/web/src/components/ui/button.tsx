import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[10px] text-sm font-semibold transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:pointer-events-none disabled:opacity-45 active:translate-y-0',
  {
    variants: {
      variant: {
        default:
          'bg-surface-3 text-txt border border-border hover:bg-surface-3/80 hover:border-accent-2/50 hover:-translate-y-px',
        primary:
          'bg-gradient-to-br from-accent to-indigo-700 text-white border border-transparent shadow-[0_10px_26px_-8px_rgba(99,102,241,0.4)] hover:brightness-110 hover:shadow-[0_14px_32px_-8px_rgba(99,102,241,0.5)]',
        destructive:
          'bg-fail/10 text-rose-300 border border-fail/40 hover:bg-fail/20 hover:border-fail',
        outline:
          'bg-transparent text-txt border border-border hover:bg-surface-3 hover:border-accent-2/50',
        secondary: 'bg-surface-2 text-dim border border-border hover:bg-surface-3 hover:text-txt',
        ghost:
          'bg-transparent text-dim hover:bg-surface-3 hover:text-txt border border-transparent',
        link: 'bg-transparent text-accent-2 underline-offset-4 hover:underline border-none p-0 h-auto',
        success: 'bg-ok/10 text-emerald-300 border border-ok/40 hover:bg-ok/20 hover:border-ok',
      },
      size: {
        default: 'h-9 px-3.5 min-h-[36px]',
        sm: 'h-8 px-3 text-xs min-h-[32px]',
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
      <button className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    );
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
