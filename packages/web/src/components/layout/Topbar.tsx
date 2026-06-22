import * as React from 'react';
import { Play, Pause, PlayCircle, Square, Globe, FolderOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useQueueControl, useControl, useQueueHealth } from '@/hooks/useApi';
import { useToast } from '@/hooks/useToast';
import { useAppStore, ALL_TASKS, TASK_LABELS, type TaskId } from '@/store/app';
import { cn } from '@/lib/utils';

const TAB_TITLES: Record<string, { eyebrow: string; title: string }> = {
  dash: { eyebrow: 'Script Controller', title: '本地脚本自动化控制台' },
  queue: { eyebrow: 'Queue', title: '脚本任务队列' },
  config: { eyebrow: 'Config', title: '脚本配置' },
  logs: { eyebrow: 'Logs', title: '历史日志' },
  books: { eyebrow: 'Books', title: '每本进度 / 失败' },
};

export function Topbar() {
  const tab = useAppStore((s) => s.tab);
  const currentTask = useAppStore((s) => s.currentTask);
  const setCurrentTask = useAppStore((s) => s.setCurrentTask);
  const queueControl = useQueueControl();
  const control = useControl();
  const toast = useToast();
  const { data: health } = useQueueHealth();

  const titleInfo = TAB_TITLES[tab] ?? TAB_TITLES.dash;
  const queueRunning = health?.runtime?.running;

  const handleQueueControl = React.useCallback(
    (action: 'start' | 'pause' | 'resume' | 'stop') => {
      queueControl.mutate(action, {
        onSuccess: (r) => toast.success((r as { msg?: string }).msg || '完成'),
        onError: (e) => toast.error(String(e)),
      });
    },
    [queueControl, toast],
  );

  const handleLaunchChrome = React.useCallback(() => {
    control.mutate(
      { action: 'launchChrome' },
      {
        onSuccess: (r) => toast.success((r as { msg?: string }).msg || '完成'),
        onError: (e) => toast.error(String(e)),
      },
    );
  }, [control, toast]);

  const handleOpenLib = React.useCallback(() => {
    control.mutate(
      { action: 'openFolder' },
      {
        onSuccess: (r) => toast.success((r as { msg?: string }).msg || '完成'),
        onError: (e) => toast.error(String(e)),
      },
    );
  }, [control, toast]);

  return (
    <header className="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-4 border-b border-white/[0.06] bg-bg/70 px-6 py-3 backdrop-blur-2xl backdrop-saturate-150">
      <div className="flex items-center gap-4">
        <div className="min-w-[190px]">
          <span className="block text-[11px] font-bold uppercase tracking-[1.6px] text-muted">
            {titleInfo.eyebrow}
          </span>
          <h2 className="m-0 mt-0.5 text-[18px] font-bold leading-tight tracking-tight">
            {titleInfo.title}
          </h2>
        </div>

        {/* 任务选择器（队列页不需要，因为队列是通用的） */}
        {tab !== 'queue' && (
          <div className="flex items-center gap-1 rounded-xl border border-white/[0.06] bg-surface-2/80 p-1 shadow-[0_8px_24px_-20px_rgba(0,0,0,0.7)] backdrop-blur-sm">
            {ALL_TASKS.map((tid: TaskId) => {
              const active = currentTask === tid;
              return (
                <button
                  key={tid}
                  onClick={() => setCurrentTask(tid)}
                  className={cn(
                    'relative flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-semibold transition-all duration-200',
                    active
                      ? 'bg-accent/15 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]'
                      : 'text-dim hover:bg-surface-3/70 hover:text-txt',
                  )}
                >
                  {TASK_LABELS[tid]}
                  {active && queueRunning && (
                    <span className="h-1.5 w-1.5 rounded-full bg-green-400 pulse-ring" />
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex flex-wrap justify-end gap-2.5">
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-white/[0.06] bg-surface-2/80 px-2.5 py-1.5 shadow-[0_8px_24px_-20px_rgba(0,0,0,0.7)] backdrop-blur-sm">
          <span className="mx-1 text-[11px] font-bold uppercase tracking-wide text-muted">
            执行端
          </span>
          <Button size="sm" variant="default" onClick={handleLaunchChrome}>
            <Globe className="h-3.5 w-3.5" />
            启动执行浏览器
          </Button>
          <Button size="sm" variant="default" onClick={handleOpenLib}>
            <FolderOpen className="h-3.5 w-3.5" />
            打开素材库
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-white/[0.06] bg-surface-2/80 px-2.5 py-1.5 shadow-[0_8px_24px_-20px_rgba(0,0,0,0.7)] backdrop-blur-sm">
          <span className="mx-1 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-muted">
            队列
            {queueRunning && (
              <span className="h-1.5 w-1.5 rounded-full bg-green-400 pulse-ring" />
            )}
          </span>
          <Button size="sm" variant="primary" onClick={() => handleQueueControl('start')}>
            <Play className="h-3.5 w-3.5" />
            开始
          </Button>
          <Button size="sm" variant="default" onClick={() => handleQueueControl('pause')}>
            <Pause className="h-3.5 w-3.5" />
            暂停
          </Button>
          <Button size="sm" variant="success" onClick={() => handleQueueControl('resume')}>
            <PlayCircle className="h-3.5 w-3.5" />
            继续
          </Button>
          <Button size="sm" variant="destructive" onClick={() => handleQueueControl('stop')}>
            <Square className="h-3.5 w-3.5" />
            停止
          </Button>
        </div>
      </div>
    </header>
  );
}
