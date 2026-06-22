import * as React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { useTaskState, useTasks } from '@/hooks/useApi';
import { useAppStore, TASK_LABELS } from '@/store/app';
import { formatNum, secsHuman } from '@/lib/utils';
import { cn } from '@/lib/utils';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip as RTooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts';

interface StatCard {
  label: string;
  num: string | number;
  cls: string;
  sub: string;
}

export function Dashboard() {
  const currentTask = useAppStore((s) => s.currentTask);
  const { data: state, isFetching } = useTaskState(currentTask);
  const { data: tasksData } = useTasks();

  // 校验数据归属：keepPreviousData 在切换任务时可能保留旧任务数据，
  // 用后端返回的 taskId 校验，不匹配则视为加载中
  const stateOk = state && state.taskId === currentTask;

  // 用 useMemo 缓存计算结果，减少重渲染
  const computed = React.useMemo(() => {
    if (!stateOk) return null;
    const t = state.totals;
    const s = state.status;
    const cfg = state.config;
    const taskLabel = TASK_LABELS[currentTask] || currentTask;
    const pctDone = t.selected ? (t.done / t.selected) * 100 : 0;
    const pctFail = t.selected ? (t.failed / t.selected) * 100 : 0;
    const eta = state.speed.avgSecPerChapter ? t.pending * state.speed.avgSecPerChapter : null;
    return { t, s, cfg, taskLabel, pctDone, pctFail, eta };
  }, [stateOk, state, currentTask]);

  if (!stateOk || !computed) {
    return (
      <div className="py-10 text-center text-muted">
        {isFetching ? '加载中…' : '暂无数据'}
      </div>
    );
  }

  const { t, s, cfg, taskLabel, pctDone, pctFail, eta } = computed;

  const cards: StatCard[] = [
    {
      label: `${taskLabel} · 已完成`,
      num: formatNum(t.done),
      cls: 'text-ok',
      sub: `${pctDone.toFixed(1)}% / 选中`,
    },
    {
      label: '待处理',
      num: formatNum(t.pending),
      cls: 'text-accent-2',
      sub: `${formatNum(t.failed)} 失败`,
    },
    {
      label: '规则选中',
      num: formatNum(t.selected),
      cls: 'text-txt',
      sub: `${formatNum(t.novels)} 本书`,
    },
    {
      label: '全库章节',
      num: formatNum(t.chapters),
      cls: 'text-txt',
      sub: '按分档规则取子集',
    },
    {
      label: '速度',
      num: state.speed.avgSecPerChapter ? `${Math.round(state.speed.avgSecPerChapter)}s` : '—',
      cls: 'text-txt',
      sub: state.speed.avgSecPerChapter
        ? `约 ${Math.round(3600 / state.speed.avgSecPerChapter)} 章/时`
        : '暂无样本',
    },
  ];

  const chartData = [
    { name: '已完成', value: t.done, color: '#34d399' },
    { name: '待处理', value: t.pending, color: '#818cf8' },
    { name: '失败', value: t.failed, color: '#fb7185' },
  ];

  const stages = cfg.pipelineStages || [];

  return (
    <div className="space-y-5">
      {/* 配额墙警告（保留：队列运行中仍可能触发） */}
      {s.rateLimited && (
        <div className="rounded-xl border border-amber-500/35 bg-amber-500/[0.08] px-4 py-3 text-amber-300 backdrop-blur-sm">
          ⚠ 最近日志疑似撞到账号配额墙，队列会等待后自动重试。
        </div>
      )}

      {/* Stat cards */}
      <div className="grid grid-cols-5 gap-3.5 max-[1180px]:grid-cols-[repeat(auto-fit,minmax(170px,1fr))]">
        {cards.map((c) => (
          <Card
            key={c.label}
            className="group relative overflow-hidden transition-all duration-300 hover:-translate-y-0.5 hover:border-white/[0.12]"
          >
            <div className="absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-accent via-cyan-400 to-ok opacity-80" />
            <CardContent className="p-4">
              <div className="text-xs font-semibold text-dim">{c.label}</div>
              <div
                className={cn(
                  'mt-1.5 text-[28px] font-bold leading-tight tracking-tight tabular-nums',
                  c.cls,
                )}
              >
                {c.num}
              </div>
              <div className="mt-1.5 text-xs text-muted">{c.sub}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Overall progress */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-baseline justify-between">
            <div className="text-xs font-semibold text-dim">总进度（已完成 / 规则选中）</div>
            <div className="text-xs text-muted tabular-nums">
              {formatNum(t.done)} / {formatNum(t.selected)}（{pctDone.toFixed(2)}%）
            </div>
          </div>
          <div className="mt-3 flex h-3 overflow-hidden rounded-lg bg-surface-3 shadow-[inset_0_1px_2px_rgba(0,0,0,0.45)]">
            <div
              className="glow-bar h-full bg-gradient-to-r from-accent via-cyan-400 to-ok transition-all duration-500 ease-out"
              style={{ width: `${pctDone}%` }}
            />
            <div
              className="h-full bg-gradient-to-r from-rose-500 to-fail transition-all duration-500 ease-out"
              style={{ width: `${pctFail}%` }}
            />
          </div>
          <div className="mt-2 text-xs text-muted">
            {eta
              ? `按当前速度纯处理约需 ${secsHuman(eta)}（不含配额墙等待）`
              : '速度样本不足，暂无 ETA'}
          </div>
        </CardContent>
      </Card>

      {/* Quick info */}
      <section>
        <h2 className="mb-3 flex items-center gap-2.5 text-[13px] font-bold tracking-wide text-dim">
          当前脚本 / 文件夹（{taskLabel}）
        </h2>
        <Card>
          <CardContent className="p-3.5 text-[13px]">
            <div className="text-muted">执行端入口</div>
            <div className="my-0.5 mb-2.5">
              <a
                href={cfg.gptUrl || '#'}
                target="_blank"
                rel="noreferrer"
                className="text-accent-2 transition-colors hover:text-accent-3 hover:underline"
              >
                {cfg.gptUrl || '(未设置)'}
              </a>
            </div>
            {currentTask === 'outline' ? (
              <>
                <div className="text-muted">素材库（输入）</div>
                <div className="my-0.5 mb-2.5">
                  {cfg.libraryRoot}{' '}
                  <span className="text-muted">/ 输出子目录 {cfg.outputDir}</span>
                </div>
                <div className="text-muted">
                  每会话章数 {cfg.chaptersPerConversation} · 全书阈值{' '}
                  {formatNum(cfg.selection?.bigThreshold ?? 0)} 在读 · 计划任务{' '}
                  {cfg.scheduledTaskName}
                </div>
              </>
            ) : (
              <>
                <div className="text-muted">输入目录</div>
                <div className="my-0.5 mb-2.5">
                  {cfg.inputRoot || '(未设置)'}{' '}
                  <span className="text-muted">/ 扩展名 {cfg.inputExt}</span>
                </div>
                <div className="text-muted">输出目录</div>
                <div className="my-0.5 mb-2.5">
                  {cfg.outputRoot || '(未设置)'}{' '}
                  <span className="text-muted">/ 扩展名 {cfg.outputExt}</span>
                </div>
                <div className="text-muted">计划任务 {cfg.scheduledTaskName || '—'}</div>
              </>
            )}
          </CardContent>
        </Card>
      </section>

      {/* 多任务进度面板 */}
      <section>
        <h2 className="mb-3 flex items-center gap-2.5 text-[13px] font-bold tracking-wide text-dim">
          任务进度
        </h2>
        {tasksData && tasksData.tasks.length > 0 ? (
          <div className="grid grid-cols-3 gap-2.5 max-[900px]:grid-cols-1">
            {tasksData.tasks.map((t) => {
              const taskNames: Record<string, string> = {
                outline: '拆大纲',
                adapt: '改编大纲',
                generate: '写正文',
              };
              const name = taskNames[t.taskId] || t.taskId;
              const running = t.status.runnerAlive;
              const speed = t.speed.avgSecPerChapter
                ? `${t.speed.avgSecPerChapter.toFixed(1)} 秒/章`
                : '—';
              const lastEvent = t.status.lastEvent;
              return (
                <Card key={t.taskId}>
                  <CardContent className="p-3.5">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-muted">{name}</span>
                      <span
                        className={cn(
                          'rounded px-1.5 py-0.5 text-[10px] font-bold',
                          running
                            ? 'bg-green-500/15 text-green-400'
                            : 'bg-gray-500/15 text-gray-400',
                        )}
                      >
                        {running ? '运行中' : '空闲'}
                      </span>
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-1.5 text-xs">
                      <div>
                        <span className="text-muted">速度: </span>
                        <span className="font-semibold tabular-nums">{speed}</span>
                      </div>
                      <div>
                        <span className="text-muted">事件: </span>
                        <span className="font-semibold tabular-nums">{t.eventCount}</span>
                      </div>
                      <div>
                        <span className="text-muted">最后成功: </span>
                        <span className="font-semibold">{t.status.lastOkTime || '—'}</span>
                      </div>
                      <div>
                        <span className="text-muted">当前: </span>
                        <span className="font-semibold truncate">{t.status.activeBook || '—'}</span>
                      </div>
                    </div>
                    {t.status.rateLimited && (
                      <div className="mt-1.5 text-[11px] text-warn">⚠ 撞配额墙</div>
                    )}
                    {lastEvent && (
                      <div className="mt-1.5 truncate text-[11px] text-muted">
                        {lastEvent.text}
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        ) : (
          <Card>
            <CardContent className="p-5 text-center text-muted">暂无任务数据。</CardContent>
          </Card>
        )}
      </section>

      {/* Pipeline stages */}
      <section>
        <h2 className="mb-3 flex items-center gap-2.5 text-[13px] font-bold tracking-wide text-dim">
          三段流水线
        </h2>
        {stages.length === 0 ? (
          <Card>
            <CardContent className="p-5 text-center text-muted">未配置流水线阶段。</CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-4 gap-2.5 max-[1120px]:grid-cols-[repeat(auto-fit,minmax(150px,1fr))]">
            {stages.map((st, i) => {
              const ctx = st.contextScope === 'novel' ? '同小说同会话' : '普通队列';
              const cls = st.contextScope === 'novel' ? 'text-warn' : 'text-ok';
              return (
                <Card key={st.id || i}>
                  <CardContent className="p-3.5">
                    <div className="text-xs font-semibold text-muted">{st.name || st.id}</div>
                    <div className={cn('mt-1.25 text-[13px] font-bold', cls)}>{ctx}</div>
                    <div className="mt-1.5 text-xs text-muted">
                      {st.inputDir || st.input || ''} → {st.outputDir || st.output || ''}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      {/* Chart */}
      <section>
        <h2 className="mb-3 flex items-center gap-2.5 text-[13px] font-bold tracking-wide text-dim">
          章节状态分布
        </h2>
        <Card>
          <CardContent className="p-4">
            <div className="h-56 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                  <XAxis
                    dataKey="name"
                    stroke="#6c7693"
                    fontSize={12}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis stroke="#6c7693" fontSize={12} tickLine={false} axisLine={false} />
                  <RTooltip
                    contentStyle={{
                      background: '#161b27',
                      border: '1px solid #2a3142',
                      borderRadius: 12,
                      color: '#eef1f8',
                      boxShadow: '0 16px 48px -16px rgba(0,0,0,0.8)',
                    }}
                  />
                  <Bar dataKey="value" radius={[8, 8, 0, 0]} animationDuration={500}>
                    {chartData.map((entry, idx) => (
                      <Cell key={idx} fill={entry.color} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
