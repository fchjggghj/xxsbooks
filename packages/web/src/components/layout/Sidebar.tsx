import * as React from 'react';
import { LayoutDashboard, List, Settings, ScrollText, BookOpen } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAppStore, type TabKey, TASK_LABELS } from '@/store/app';
import { useChromeState, useTaskState } from '@/hooks/useApi';

interface NavItem {
  key: TabKey;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const NAV_ITEMS: NavItem[] = [
  { key: 'dash', label: '总览', icon: LayoutDashboard },
  { key: 'queue', label: '脚本队列', icon: List },
  { key: 'config', label: '脚本配置', icon: Settings },
  { key: 'logs', label: '历史日志', icon: ScrollText },
  { key: 'books', label: '每本进度 / 失败', icon: BookOpen },
];

function Dot({ className }: { className?: string }) {
  return <span className={cn('h-2 w-2 flex-none rounded-full', className)} />;
}

export function Sidebar() {
  const tab = useAppStore((s) => s.tab);
  const setTab = useAppStore((s) => s.setTab);
  const currentTask = useAppStore((s) => s.currentTask);
  const { data: chromeData } = useChromeState();
  const { data: stateData } = useTaskState(currentTask);

  const chromeUp = chromeData?.up;
  const status = stateData?.status;
  const taskLabel = TASK_LABELS[currentTask] || currentTask;

  return (
    <aside className="sticky top-0 flex h-screen flex-col border-r border-white/[0.075] bg-gradient-to-b from-surface/90 to-bg-soft/95 px-3.5 py-4.5 backdrop-blur-md z-30">
      {/* Brand */}
      <div className="flex items-center gap-3 px-2 pb-4.5 pt-1.5">
        <div className="grid h-10.5 w-10.5 place-items-center rounded-xl bg-gradient-to-br from-accent-2 via-accent to-purple-500 text-xl font-extrabold text-white shadow-[0_10px_26px_-6px_rgba(99,102,241,0.4),inset_0_1px_0_rgba(255,255,255,0.25)]">
          纲
        </div>
        <div>
          <h1 className="m-0 text-[17px] font-bold leading-tight tracking-tight">脚本控制器</h1>
          <p className="mt-1 text-xs text-muted">本地自动化 · 队列执行</p>
        </div>
      </div>

      {/* Status pills */}
      <div className="my-2.5 flex flex-col gap-1.75">
        <div className="flex min-h-7 items-center gap-2 rounded-lg border border-white/[0.075] bg-surface-3 px-2.5 py-1.5 text-xs text-dim">
          <Dot
            className={chromeUp ? 'bg-ok shadow-[0_0_0_3px_rgba(52,211,153,0.18)]' : 'bg-slate-500'}
          />
          Chrome（浏览器）{chromeUp ? '在线' : '离线'}
        </div>
        <div className="flex min-h-7 items-center gap-2 rounded-lg border border-accent/30 bg-accent/10 px-2.5 py-1.5 text-xs text-dim">
          <span className="font-bold text-accent-2">当前:</span>
          <span className="font-semibold text-txt">{taskLabel}</span>
        </div>
        <div className="flex min-h-7 items-center gap-2 rounded-lg border border-white/[0.075] bg-surface-3 px-2.5 py-1.5 text-xs text-dim">
          <Dot
            className={
              status?.daemonAlive
                ? 'bg-ok shadow-[0_0_0_3px_rgba(52,211,153,0.18)]'
                : 'bg-slate-500'
            }
          />
          守护 {status?.daemonAlive ? '在线' : '停止'}
        </div>
        <div className="flex min-h-7 items-center gap-2 rounded-lg border border-white/[0.075] bg-surface-3 px-2.5 py-1.5 text-xs text-dim">
          <Dot
            className={
              status?.runnerAlive
                ? 'bg-ok shadow-[0_0_0_3px_rgba(52,211,153,0.18)]'
                : 'bg-slate-500'
            }
          />
          Runner {status?.runnerAlive ? '运行中' : '空闲'}
        </div>
        {status?.stop && (
          <div className="flex min-h-7 items-center gap-2 rounded-lg border border-white/[0.075] bg-surface-3 px-2.5 py-1.5 text-xs text-dim">
            <Dot className="bg-warn shadow-[0_0_0_3px_rgba(251,191,36,0.18)]" />
            STOP（停止开关）已置
          </div>
        )}
        {status?.rateLimited && (
          <div className="flex min-h-7 items-center gap-2 rounded-lg border border-white/[0.075] bg-surface-3 px-2.5 py-1.5 text-xs text-dim">
            <Dot className="bg-warn shadow-[0_0_0_3px_rgba(251,191,36,0.18)]" />
            疑似配额墙
          </div>
        )}
        {status?.activeBook && (
          <div className="flex min-h-7 items-center gap-2 rounded-lg border border-white/[0.075] bg-surface-3 px-2.5 py-1.5 text-xs text-dim">
            📕 {status.activeBook.slice(0, 20)}
          </div>
        )}
      </div>

      {/* Tabs */}
      <nav className="flex flex-col gap-1" aria-label="主导航">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const active = tab === item.key;
          return (
            <button
              key={item.key}
              onClick={() => setTab(item.key)}
              className={cn(
                'relative flex min-h-[42px] items-center gap-2.5 rounded-[10px] px-3 py-2.5 text-[13px] font-semibold transition-all',
                active ? 'bg-accent/15 text-white' : 'text-dim hover:bg-surface-3 hover:text-txt',
              )}
            >
              {active && (
                <span className="absolute -left-3.5 top-2.25 bottom-2.25 w-0.75 rounded-r bg-gradient-to-b from-accent-2 to-accent" />
              )}
              <Icon className="h-4 w-4 opacity-85" />
              {item.label}
            </button>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="mt-auto border-t border-white/[0.075] px-2 pt-3 pb-1">
        <span className="text-xs text-muted">
          {stateData ? `扫描于 ${stateData.scanAgeSec}s 前` : '连接中…'}
        </span>
      </div>
    </aside>
  );
}
