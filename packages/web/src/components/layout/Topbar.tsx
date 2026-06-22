import * as React from 'react';
import { Play, Pause, PlayCircle, Square, Globe, FolderOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useQueueControl, useControl, useTasks } from '@/hooks/useApi';
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
  const { data: tasksData } = useTasks();

  const titleInfo = TAB_TITLES[tab] ?? TAB_TITLES.dash;

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

  // 获取当前任务运行状态
  const taskStatus = tasksData?.tasks.find((t) => t.taskId === currentTask);
  const taskRunning = taskStatus?.status.runnerAlive;

  return (
    <header className="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-4.5 border-b border-white/[0.075] bg-bg/70 px-6 py-3.75 backdrop-blur-xl backdrop-saturate-150">
      <div className="flex items-center gap-4">
        <div className="min-w-[190px]">
          <span className="block text-[11px] font-bold uppercase tracking-[1.4px] text-muted">
            {titleInfo.eyebrow}
          </span>
          <h2 className="m-0 mt-0.75 text-[19px] font-bold leading-tight tracking-tight">
            {titleInfo.title}
          </h2>
        </div>

        {/* 任务选择器（队列页不需要，因为队列是通用的） */}
        {tab !== 'queue' && (
          <div className="flex items-center gap-1 rounded-xl border border-white/[0.075] bg-surface-2 p-1 shadow-[0_16px_40px_-24px_rgba(0,0,0,0.7)]">
            {ALL_TASKS.map((tid: TaskId) => {
              const ts = tasksData?.tasks.find((t) => t.taskId === tid);
              const running = ts?.status.runnerAlive;
              const active = currentTask === tid;
              return (
                <button
                  key={tid}
                  onClick={() => setCurrentTask(tid)}
                  className={cn(
                    'relative flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-semibold transition-all',
                    active
                      ? 'bg-accent/15 text-white'
                      : 'text-dim hover:bg-surface-3 hover:text-txt',
                  )}
                >
                  {TASK_LABELS[tid]}
                  {running && (
                    <span className="h-1.5 w-1.5 rounded-full bg-green-400 shadow-[0_0_0_3px_rgba(52,211,153,0.18)]" />
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex flex-wrap justify-end gap-3">
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-white/[0.075] bg-surface-2 px-2.25 py-1.75 shadow-[0_16px_40px_-24px_rgba(0,0,0,0.7)]">
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

        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-white/[0.075] bg-surface-2 px-2.25 py-1.75 shadow-[0_16px_40px_-24px_rgba(0,0,0,0.7)]">
          <span className="mx-1 text-[11px] font-bold uppercase tracking-wide text-muted">
            队列 {taskRunning ? '· 运行中' : ''}
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
