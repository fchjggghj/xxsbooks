import * as React from 'react';
import { LayoutDashboard, List, Settings, ScrollText, BookOpen, Library, Compass, Layers, PenTool } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAppStore, type TabKey, TASK_LABELS } from '@/store/app';
import { useChromeState, useQueueHealth } from '@/hooks/useApi';

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
  { key: 'library', label: '书库管理', icon: Library },
  { key: 'direction', label: '改编方向', icon: Compass },
  { key: 'pool', label: '大纲池', icon: Layers },
  { key: 'composer', label: '新书组稿', icon: PenTool },
];

function Dot({ className }: { className?: string }) {
  return <span className={cn('h-2 w-2 flex-none rounded-full', className)} />;
}

export function Sidebar() {
  const tab = useAppStore((s) => s.tab);
  const setTab = useAppStore((s) => s.setTab);
  const currentTask = useAppStore((s) => s.currentTask);
  const { data: chromeData } = useChromeState();
  const { data: health } = useQueueHealth();

  const chromeUp = chromeData?.up;
  const taskLabel = TASK_LABELS[currentTask] || currentTask;

  // 队列运行状态（全流程统一由队列驱动）
  const runtime = health?.runtime;
  const queueRunning = runtime?.running;
  const queuePaused = runtime?.paused;
  const queueMessage = runtime?.message || '队列空闲';
  const queueProcessed = runtime?.processed ?? 0;
  const queueFailed = runtime?.failed ?? 0;

  return (
    <aside className="sticky top-0 flex h-screen flex-col border-r border-white/[0.06] bg-gradient-to-b from-surface/95 via-bg-soft/95 to-bg/95 px-3.5 py-4 backdrop-blur-xl z-30">
      {/* Brand */}
      <div className="flex items-center gap-3 px-2 pb-4 pt-1">
        <div className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-accent-2 via-accent to-violet-500 text-lg font-extrabold text-white shadow-[0_8px_24px_-6px_rgba(99,102,241,0.5),inset_0_1px_0_rgba(255,255,255,0.3)]">
          纲
        </div>
        <div>
          <h1 className="m-0 text-[16px] font-bold leading-tight tracking-tight">脚本控制器</h1>
          <p className="mt-0.5 text-[11px] text-muted">本地自动化 · 队列执行</p>
        </div>
      </div>

      {/* Status pills */}
      <div className="my-2 flex flex-col gap-1.5">
        <div className="flex min-h-7 items-center gap-2 rounded-lg border border-white/[0.05] bg-surface-3/60 px-2.5 py-1.5 text-xs text-dim">
          <Dot
            className={cn(
              chromeUp
                ? 'bg-ok shadow-[0_0_0_3px_rgba(52,211,153,0.18)]'
                : 'bg-slate-600',
            )}
          />
          Chrome（浏览器）{chromeUp ? '在线' : '离线'}
        </div>
        <div className="flex min-h-7 items-center gap-2 rounded-lg border border-accent/25 bg-accent/[0.08] px-2.5 py-1.5 text-xs text-dim">
          <span className="font-bold text-accent-2">当前:</span>
          <span className="font-semibold text-txt">{taskLabel}</span>
        </div>
        {/* 队列运行状态（替代旧的 daemon/runner 状态） */}
        <div className="flex min-h-7 items-center gap-2 rounded-lg border border-white/[0.05] bg-surface-3/60 px-2.5 py-1.5 text-xs text-dim">
          <Dot
            className={
              queueRunning
                ? 'bg-ok pulse-ring'
                : queuePaused
                  ? 'bg-warn shadow-[0_0_0_3px_rgba(251,191,36,0.18)]'
                  : 'bg-slate-600'
            }
          />
          队列 {queueRunning ? '运行中' : queuePaused ? '已暂停' : '空闲'}
        </div>
        {(queueProcessed > 0 || queueFailed > 0) && (
          <div className="flex min-h-7 items-center gap-2 rounded-lg border border-white/[0.05] bg-surface-3/60 px-2.5 py-1.5 text-xs text-dim">
            <span>
              本轮已处理 <span className="font-semibold text-ok">{queueProcessed}</span>
              {queueFailed > 0 && (
                <>
                  {' '}/ 失败 <span className="font-semibold text-fail">{queueFailed}</span>
                </>
              )}
            </span>
          </div>
        )}
        {queueMessage && queueMessage !== '队列空闲' && (
          <div className="flex min-h-7 items-center gap-2 rounded-lg border border-white/[0.05] bg-surface-3/60 px-2.5 py-1.5 text-xs text-dim">
            <span className="truncate">{queueMessage}</span>
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
                'group relative flex min-h-[40px] items-center gap-2.5 rounded-[10px] px-3 py-2.5 text-[13px] font-semibold transition-all duration-200',
                active
                  ? 'bg-accent/15 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]'
                  : 'text-dim hover:bg-surface-3/70 hover:text-txt',
              )}
            >
              {active && (
                <span className="absolute -left-3.5 top-2.5 bottom-2.5 w-0.5 rounded-r bg-gradient-to-b from-accent-2 to-accent shadow-[0_0_8px_rgba(99,102,241,0.6)]" />
              )}
              <Icon
                className={cn(
                  'h-4 w-4 transition-transform duration-200',
                  active ? 'opacity-100' : 'opacity-70 group-hover:opacity-90',
                )}
              />
              {item.label}
            </button>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="mt-auto border-t border-white/[0.05] px-2 pt-3 pb-1">
        <span className="text-[11px] text-muted">
          {health ? `运行 ${Math.round((health.uptimeSec || 0))}s` : '连接中…'}
        </span>
      </div>
    </aside>
  );
}
