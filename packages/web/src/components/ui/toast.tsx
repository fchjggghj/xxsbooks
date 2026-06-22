import * as React from 'react';
import { create } from 'zustand';
import { cn } from '@/lib/utils';
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react';

export type ToastType = 'success' | 'error' | 'info';

export interface ToastItem {
  id: string;
  message: string;
  type: ToastType;
}

interface ToastStore {
  toasts: ToastItem[];
  addToast: (message: string, type?: ToastType) => void;
  removeToast: (id: string) => void;
}

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  addToast: (message, type = 'success') => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    set((s) => ({ toasts: [...s.toasts, { id, message, type }] }));
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, 3600);
  },
  removeToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

const iconMap = {
  success: CheckCircle2,
  error: AlertCircle,
  info: Info,
};

const colorMap = {
  success: 'border-ok/50 text-emerald-300',
  error: 'border-fail/50 text-rose-300',
  info: 'border-accent/50 text-indigo-300',
};

const bgMap = {
  success: 'bg-emerald-500/10',
  error: 'bg-rose-500/10',
  info: 'bg-accent/10',
};

export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  const removeToast = useToastStore((s) => s.removeToast);

  return (
    <div className="pointer-events-none fixed bottom-6 right-6 z-[80] flex flex-col gap-2.5">
      {toasts.map((t) => {
        const Icon = iconMap[t.type];
        return (
          <div
            key={t.id}
            className={cn(
              'pointer-events-auto flex max-w-md items-start gap-3 rounded-xl border bg-surface-2/95 px-4 py-3 text-sm shadow-[0_16px_48px_-16px_rgba(0,0,0,0.8),inset_0_1px_0_rgba(255,255,255,0.04)] backdrop-blur-xl animate-fade-in',
              colorMap[t.type],
            )}
          >
            <div className={cn('grid h-6 w-6 flex-none place-items-center rounded-lg', bgMap[t.type])}>
              <Icon className="h-3.5 w-3.5" />
            </div>
            <span className="flex-1 text-txt">{t.message}</span>
            <button
              onClick={() => removeToast(t.id)}
              className="text-muted transition-colors hover:text-txt"
              aria-label="关闭"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function useToast() {
  const addToast = useToastStore((s) => s.addToast);
  return React.useMemo(
    () => ({
      success: (msg: string) => addToast(msg, 'success'),
      error: (msg: string) => addToast(msg, 'error'),
      info: (msg: string) => addToast(msg, 'info'),
    }),
    [addToast],
  );
}
