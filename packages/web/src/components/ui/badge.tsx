import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-bold transition-colors',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-surface-3 text-dim',
        secondary: 'border-transparent bg-surface-3 text-dim',
        destructive: 'border-fail/40 bg-fail/10 text-rose-300',
        outline: 'border-border text-dim',
        success: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
        warning: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
        info: 'border-accent/40 bg-accent/10 text-indigo-300',
        cyan: 'border-cyan-500/40 bg-cyan-500/10 text-cyan-300',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
