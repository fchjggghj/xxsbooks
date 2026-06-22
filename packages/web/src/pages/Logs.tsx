import * as React from 'react';
import { Card } from '@/components/ui/card';
import { useDaemonLog, useTaskRunLog } from '@/hooks/useApi';
import { useAppStore, TASK_LABELS } from '@/store/app';
import { cn } from '@/lib/utils';
import type { LogEvent, DaemonLogLine } from '@/lib/api';

const KIND_COLOR: Record<string, string> = {
  ok: 'text-emerald-300',
  fail: 'text-rose-300',
  warn: 'text-amber-300',
  retry: 'text-violet-300',
  book: 'text-blue-300 font-bold',
  rotate: 'text-cyan-300',
  info: 'text-dim',
};

function LogLine({ time, kind, text }: { time: string; kind?: string; text: string }) {
  return (
    <div className="flex gap-2.5 py-0.25">
      <span className="flex-none text-[#566079]">{time}</span>
      <span
        className={cn('whitespace-pre-wrap break-all', kind ? KIND_COLOR[kind] : 'text-[#cdd6e6]')}
      >
        {text}
      </span>
    </div>
  );
}

function RunLogView({ events, taskLabel }: { events: LogEvent[]; taskLabel: string }) {
  const boxRef = React.useRef<HTMLDivElement>(null);
  const [autoscroll, setAutoscroll] = React.useState(true);

  React.useEffect(() => {
    if (autoscroll && boxRef.current) {
      boxRef.current.scrollTop = boxRef.current.scrollHeight;
    }
  }, [events, autoscroll]);

  return (
    <Card>
      <div className="flex items-center border-b border-white/[0.075] px-3.5 py-2.5">
        <strong className="text-[13px]">{taskLabel} 逐章日志 run.log</strong>
        <label className="ml-auto flex items-center gap-1.5 text-xs text-muted">
          <input
            type="checkbox"
            checked={autoscroll}
            onChange={(e) => setAutoscroll(e.target.checked)}
          />
          自动滚动
        </label>
      </div>
      <div
        ref={boxRef}
        className="max-h-[440px] overflow-auto rounded-b-2xl bg-[#0a0d15] p-3.5 font-mono-code text-xs leading-relaxed"
      >
        {events.length === 0 ? (
          <div className="py-5 text-center text-muted">暂无</div>
        ) : (
          events.map((e, i) => {
            let txt: string;
            if (e.kind === 'ok') {
              txt = `✓ ${e.chapter || ''} (${e.chars || 0}字)${e.note ? ' ' + e.note : ''}`;
            } else if (e.kind === 'fail') {
              txt = `✗ ${e.chapter || ''} ${e.reason || ''}`;
            } else if (e.kind === 'book') {
              txt = `▶ 开始：${e.book || ''}（待处理 ${e.pending ?? 0}）`;
            } else {
              txt = e.text || '';
            }
            return <LogLine key={i} time={e.time} kind={e.kind} text={txt} />;
          })
        )}
      </div>
    </Card>
  );
}

function DaemonLogView({ lines }: { lines: DaemonLogLine[] }) {
  const boxRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (boxRef.current) {
      boxRef.current.scrollTop = boxRef.current.scrollHeight;
    }
  }, [lines]);

  return (
    <Card>
      <div className="border-b border-white/[0.075] px-3.5 py-2.5">
        <strong className="text-[13px]">守护事件 daemon.log</strong>
      </div>
      <div
        ref={boxRef}
        className="max-h-[440px] overflow-auto rounded-b-2xl bg-[#0a0d15] p-3.5 font-mono-code text-xs leading-relaxed"
      >
        {lines.length === 0 ? (
          <div className="py-5 text-center text-muted">暂无</div>
        ) : (
          lines.map((l, i) => <LogLine key={i} time={l.time} kind="info" text={l.text} />)
        )}
      </div>
    </Card>
  );
}

export function Logs() {
  const currentTask = useAppStore((s) => s.currentTask);
  const taskLabel = TASK_LABELS[currentTask] || currentTask;

  // 使用当前任务的 run.log（outline 用默认 useRunLog 保持兼容）
  const { data: taskRunLog } = useTaskRunLog(currentTask, 300);
  const { data: daemonLog } = useDaemonLog(120);

  const events = taskRunLog?.events || [];

  return (
    <div className="flex flex-wrap gap-4">
      <div className="min-w-[340px] flex-1">
        <RunLogView events={events} taskLabel={taskLabel} />
      </div>
      <div className="min-w-[340px] flex-1">
        <DaemonLogView lines={daemonLog?.daemon || []} />
      </div>
    </div>
  );
}
