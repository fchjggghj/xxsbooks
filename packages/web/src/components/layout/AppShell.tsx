import * as React from 'react';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { Toaster } from '@/components/ui/toast';

interface AppShellProps {
  children: React.ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  return (
    <div className="grid min-h-screen grid-cols-[260px_minmax(0,1fr)] max-[860px]:block">
      <Sidebar />
      <div className="flex min-w-0 flex-col">
        <Topbar />
        <main className="mx-auto w-full max-w-[1480px] px-6 pb-12 pt-5 max-[860px]:px-3.5 max-[860px]:pb-8">
          <div className="animate-fade-in">{children}</div>
        </main>
      </div>
      <Toaster />
    </div>
  );
}
