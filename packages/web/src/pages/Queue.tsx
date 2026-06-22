import * as React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  usePromptQueue,
  useQueueHealth,
  useQueueEvents,
  useQueuePlan,
  useQueueItem,
  useQueueApi,
  useQueueControl,
} from '@/hooks/useApi';
import { useToast } from '@/hooks/useToast';
import { useAppStore } from '@/store/app';
import { formatNum, cn } from '@/lib/utils';
import { Play, Pause, PlayCircle, Square, ArrowUp, ArrowDown } from 'lucide-react';
import type { QueueItem, QueueItemStatus } from '@/lib/api';

const STATUS_NAME: Record<QueueItemStatus, string> = {
  pending: '待执行',
  running: '运行中',
  done: '已完成',
  failed: '失败',
  retry: '待重试',
  skipped: '已跳过',
};

const STATUS_BADGE: Record<
  QueueItemStatus,
  'info' | 'warning' | 'success' | 'destructive' | 'default' | 'cyan'
> = {
  pending: 'info',
  running: 'warning',
  done: 'success',
  failed: 'destructive',
  retry: 'cyan',
  skipped: 'default',
};

const PHASE_CN: Record<string, string> = {
  idle: '空闲',
  starting: '启动中',
  connecting_browser: '连接浏览器',
  opening_gpts: '打开执行端',
  sending: '提交中',
  checking_page: '检查页面',
  typing_prompt: '写入任务内容',
  submitting_prompt: '提交任务',
  waiting_start: '等待开始',
  generating: '执行端生成中',
  stabilizing_reply: '等待输出稳定',
  saving_output: '保存输出',
  deleting_conversation: '清理执行记录',
  rate_limited: '触发上限',
  auto_paused: '智能暂停',
  resuming: '自动恢复',
  item_done: '单条完成',
  item_failed: '单条失败',
  item_skipped: '已放弃',
  fatal_error: '运行出错',
  stopped: '已停止',
};

function profileNameOf(profiles: { id: string; name: string }[] | undefined, id?: string): string {
  if (!profiles || !id) return '默认执行档案';
  return profiles.find((p) => p.id === id)?.name || '默认执行档案';
}

export function Queue() {
  const { data: queueData } = usePromptQueue();
  const { data: health } = useQueueHealth();
  const { data: events } = useQueueEvents();
  const { data: plan } = useQueuePlan();

  const [search, setSearch] = React.useState('');
  const [statusFilter, setStatusFilter] = React.useState<string>('');
  const [profileFilter, setProfileFilter] = React.useState<string>('');

  const selectedQueueId = useAppStore((s) => s.selectedQueueId);
  const setSelectedQueueId = useAppStore((s) => s.setSelectedQueueId);

  const items = queueData?.items || [];
  const profiles = queueData?.profiles || [];
  const summary = queueData?.summary || {};
  const runtime = queueData?.runtime || {};

  const filtered = items.filter((item) => {
    if (statusFilter === 'work' && !['running', 'pending', 'failed'].includes(item.status))
      return false;
    if (statusFilter && statusFilter !== 'work' && item.status !== statusFilter) return false;
    if (profileFilter && item.profileId !== profileFilter) return false;
    if (search && !`${item.title}\n${item.contentPreview}\n${item.lastError}`.includes(search))
      return false;
    return true;
  });

  const stats: Array<[string, number, string]> = [
    ['全部', summary.total || 0, ''],
    ['待执行', summary.pending || 0, 'text-accent-2'],
    ['已完成', summary.done || 0, 'text-ok'],
    ['失败', summary.failed || 0, 'text-fail'],
    ['跳过', summary.skipped || 0, ''],
  ];

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="m-0 text-[21px] font-bold leading-tight">脚本任务队列</h2>
          <p className="mt-1.25 text-[13px] text-dim">
            把待处理内容排队、分配执行档案、断点续跑并保存脚本输出。
          </p>
        </div>
        <QueueControlButtons />
      </div>

      {/* Stats */}
      <div className="grid grid-cols-5 gap-2.5 max-[1120px]:grid-cols-[repeat(auto-fit,minmax(110px,1fr))]">
        {stats.map(([k, v, cls]) => (
          <Card key={k}>
            <CardContent className="p-3.25">
              <div className="text-xs font-semibold text-muted">{k}</div>
              <div className={cn('mt-1 text-2xl font-bold', cls)}>{formatNum(v)}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Health grid */}
      <QueueHealthGrid health={health} runtime={runtime} />

      {/* Plan preview */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>预排队明细</CardTitle>
          <span className="text-xs text-muted">
            运行 {plan?.counts?.running || 0} · 待执行 {plan?.counts?.pending || 0} · 失败{' '}
            {plan?.counts?.failed || 0}
            {plan?.counts?.capped ? ` · 达上限 ${plan.counts.capped}` : ''}
          </span>
        </CardHeader>
        <CardContent className="p-2.5 pt-0">
          <div className="grid max-h-[260px] gap-1.75 overflow-auto p-2.5">
            {(plan?.next || []).slice(0, 80).map((item) => (
              <PlanRow
                key={item.id}
                item={item}
                profileName={profileNameOf(profiles, item.profileId)}
                onClick={() => setSelectedQueueId(item.id)}
              />
            ))}
            {(plan?.failed || []).length > 0 && (
              <div className="grid grid-cols-[72px_minmax(0,1fr)_136px_116px] items-center gap-2.5 rounded-[10px] border border-white/[0.075] bg-fail/[0.06] p-2.25">
                <div className="font-extrabold text-fail">失败</div>
                <div>
                  <div className="font-bold">失败优先池</div>
                  <div className="text-xs text-muted">
                    {(plan?.failed || [])
                      .slice(0, 3)
                      .map((x) => x.title)
                      .join(' / ')}
                  </div>
                </div>
                <div className="text-xs text-muted">{plan?.failed?.length} 条</div>
                <div className="text-xs text-muted">点"重试全部失败"提到队首</div>
              </div>
            )}
            {!plan?.next?.length && !plan?.failed?.length && (
              <div className="py-5 text-center text-muted">暂无待执行任务。</div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Two-column layout */}
      <div className="grid grid-cols-[minmax(420px,1.12fr)_minmax(360px,0.88fr)] gap-4 items-start max-[1120px]:grid-cols-1">
        {/* Left: list */}
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>任务列表</CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                placeholder="搜索标题/内容"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-[170px]"
              />
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="h-9 rounded-[10px] border border-border bg-surface-3 px-2.5 text-sm text-txt"
              >
                <option value="">全部状态</option>
                <option value="work">需要处理</option>
                <option value="pending">待执行</option>
                <option value="running">运行中</option>
                <option value="done">已完成</option>
                <option value="failed">失败</option>
                <option value="skipped">已跳过</option>
              </select>
              <select
                value={profileFilter}
                onChange={(e) => setProfileFilter(e.target.value)}
                className="h-9 rounded-[10px] border border-border bg-surface-3 px-2.5 text-sm text-txt"
              >
                <option value="">全部执行档案</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <div className="max-h-[660px] overflow-auto">
              {filtered.length === 0 ? (
                <div className="py-5 text-center text-muted">
                  队列为空。可以手动添加、批量粘贴，或从文件夹导入 txt/md。
                </div>
              ) : (
                filtered.map((item) => (
                  <QueueItemRow
                    key={item.id}
                    item={item}
                    profileName={profileNameOf(profiles, item.profileId)}
                    active={item.id === selectedQueueId}
                    onClick={() => setSelectedQueueId(item.id)}
                  />
                ))
              )}
            </div>
          </CardContent>
        </Card>

        {/* Right: detail */}
        <QueueDetailPanel />
      </div>

      {/* Events */}
      <Card>
        <CardHeader>
          <CardTitle>事件时间线</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex max-h-[240px] flex-col gap-1.5 overflow-auto">
            {(events?.events || [])
              .slice(-80)
              .reverse()
              .map((ev, i) => {
                const t = ev.ts
                  ? new Date(ev.ts).toLocaleTimeString('zh-CN', { hour12: false })
                  : '';
                const msg =
                  ev.title ||
                  ev.message ||
                  ev.error ||
                  ev.outputPath ||
                  ev.profileName ||
                  ev.folder ||
                  ev.itemId ||
                  '';
                return (
                  <div
                    key={i}
                    className="grid grid-cols-[80px_120px_minmax(0,1fr)] gap-2 rounded-lg border border-white/[0.075] bg-surface-3 p-2 text-xs"
                  >
                    <span className="text-muted tabular-nums">{t}</span>
                    <span className="font-bold text-accent-2">{ev.type || 'event'}</span>
                    <span className="text-dim break-words">{msg}</span>
                  </div>
                );
              })}
            {!events?.events?.length && (
              <div className="py-3 text-center text-muted">暂无事件。</div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function QueueControlButtons() {
  const queueControl = useQueueControl();
  const toast = useToast();
  const handle = (action: 'start' | 'pause' | 'resume' | 'stop') => {
    queueControl.mutate(action, {
      onSuccess: (r) => toast.success((r as { msg?: string }).msg || '完成'),
      onError: (e) => toast.error(String(e)),
    });
  };
  return (
    <div className="flex flex-wrap gap-2.5">
      <Button variant="primary" onClick={() => handle('start')}>
        <Play className="h-4 w-4" /> 开始
      </Button>
      <Button onClick={() => handle('pause')}>
        <Pause className="h-4 w-4" /> 暂停
      </Button>
      <Button variant="success" onClick={() => handle('resume')}>
        <PlayCircle className="h-4 w-4" /> 继续
      </Button>
      <Button variant="destructive" onClick={() => handle('stop')}>
        <Square className="h-4 w-4" /> 停止
      </Button>
    </div>
  );
}

function QueueHealthGrid({
  health,
  runtime,
}: {
  health: ReturnType<typeof useQueueHealth>['data'];
  runtime: { running?: boolean; paused?: boolean; message?: string };
}) {
  if (!health) {
    return (
      <div className="grid grid-cols-4 gap-2.5 max-[1120px]:grid-cols-[repeat(auto-fit,minmax(150px,1fr))]">
        <Card>
          <CardContent className="p-3.5">
            <div className="text-xs font-semibold text-muted">健康检查</div>
            <div className="mt-1.25 text-[13px] font-bold text-warn">暂不可用</div>
          </CardContent>
        </Card>
      </div>
    );
  }
  const rt = health.runtime || {};
  const q = health.queue || {};
  const issueText = q.issues && q.issues.length ? q.issues.join('；') : '正常';
  const phase = PHASE_CN[rt.phase || ''] || rt.phase || '空闲';
  const resume = rt.resumeAt
    ? new Date(rt.resumeAt).toLocaleString('zh-CN', { hour12: false })
    : '无';

  const cards: Array<[string, string, 'good' | 'warn' | 'bad' | '']> = [
    ['服务（后台）', health.ok ? '正常' : '需关注', health.ok ? 'good' : 'bad'],
    ['Chrome（浏览器）', health.chrome?.up ? '在线' : '离线', health.chrome?.up ? 'good' : 'warn'],
    [
      '运行阶段',
      `${phase}${rt.heartbeatAgeSec != null ? ` · ${rt.heartbeatAgeSec}秒前` : ''}`,
      (rt.heartbeatAgeSec ?? 0) > 120 ? 'bad' : 'good',
    ],
    ['当前任务', rt.activeTitle || '无', ''],
    ['本轮统计', `${rt.succeeded || 0} 成功 / ${rt.failed || 0} 失败`, ''],
    [
      '连续失败',
      String(rt.consecutiveFailures || 0),
      (rt.consecutiveFailures || 0) > 2 ? 'bad' : 'good',
    ],
    ['自动恢复', resume, rt.autoPaused ? 'warn' : 'good'],
    ['暂停原因', rt.pauseReason || rt.limitHint || '无', rt.autoPaused ? 'warn' : 'good'],
    ['队列文件大小', `${formatNum(q.store?.bytes || 0)} 字节`, ''],
    ['诊断', issueText, q.ok ? 'good' : 'warn'],
  ];

  const colorMap = { good: 'text-ok', warn: 'text-warn', bad: 'text-fail', '': 'text-txt' };

  return (
    <>
      <div className="mb-3 text-xs text-muted">
        {runtime.running ? '运行中' : '空闲'} · {runtime.message || ''}
        {runtime.paused ? ' · 已暂停' : ''}
      </div>
      <div className="mb-4 grid grid-cols-4 gap-2.5 max-[1120px]:grid-cols-[repeat(auto-fit,minmax(150px,1fr))]">
        {cards.map(([k, v, cls]) => (
          <Card key={k}>
            <CardContent className="p-3.5">
              <div className="text-xs font-semibold text-muted">{k}</div>
              <div className={cn('mt-1.25 break-all text-[13px] font-bold', colorMap[cls])}>
                {v}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </>
  );
}

function PlanRow({
  item,
  profileName,
  onClick,
}: {
  item: QueueItem;
  profileName: string;
  onClick: () => void;
}) {
  const pos = item.status === 'running' ? '运行中' : `#${item.queuePosition || '-'}`;
  return (
    <div
      onClick={onClick}
      className={cn(
        'grid cursor-pointer grid-cols-[72px_minmax(0,1fr)_136px_116px] items-center gap-2.5 rounded-[10px] border p-2.25 transition-colors',
        item.status === 'running'
          ? 'border-amber-500/45 bg-amber-500/[0.08]'
          : 'border-white/[0.075] bg-surface-3 hover:bg-surface-3/80',
      )}
    >
      <div
        className={cn(
          'font-extrabold tabular-nums',
          item.status === 'running' ? 'text-warn' : 'text-accent-2',
        )}
      >
        {pos}
      </div>
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="truncate font-bold">{item.title}</span>
          {item.queuePosition === 1 && <Badge variant="success">下一条</Badge>}
          {item.status === 'running' && <Badge variant="warning">当前</Badge>}
          {item.maxAttempts && Number(item.attempts || 0) >= Number(item.maxAttempts) && (
            <Badge variant="destructive">近上限</Badge>
          )}
        </div>
        <div className="truncate text-xs text-muted">{item.contentPreview || ''}</div>
      </div>
      <div className="truncate text-xs text-muted">{profileName}</div>
      <div className="truncate text-xs text-muted">
        尝试 {item.attempts || 0}/{item.maxAttempts || '-'} · {formatNum(item.contentChars || 0)} 字
      </div>
    </div>
  );
}

function QueueItemRow({
  item,
  profileName,
  active,
  onClick,
}: {
  item: QueueItem;
  profileName: string;
  active: boolean;
  onClick: () => void;
}) {
  const queueApi = useQueueApi();
  const toast = useToast();

  const handleMove = (e: React.MouseEvent, dir: 'up' | 'down') => {
    e.stopPropagation();
    queueApi.mutate(
      { action: 'moveItem', extra: { id: item.id, dir } },
      {
        onSuccess: (r) => toast.success((r as { msg?: string }).msg || '已更新'),
        onError: (e) => toast.error(String(e)),
      },
    );
  };

  return (
    <div
      onClick={onClick}
      className={cn(
        'grid cursor-pointer grid-cols-[34px_minmax(0,1fr)_auto] gap-2.5 border-b border-white/[0.075] p-2.75 transition-colors hover:bg-surface-3',
        active && 'bg-accent/15 shadow-[inset_3px_0_0_var(--color-accent)]',
        item.status === 'running' && 'bg-amber-500/[0.08]',
        item.status === 'failed' && 'bg-fail/[0.06]',
        item.queuePosition === 1 && !active && 'shadow-[inset_3px_0_0_var(--color-ok)]',
      )}
    >
      <div className="text-muted tabular-nums">
        {item.status === 'running'
          ? 'RUN'
          : item.queuePosition
            ? `#${item.queuePosition}`
            : item.index + 1}
      </div>
      <div className="min-w-0">
        <div className="truncate font-bold">{item.title}</div>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
          <Badge variant={STATUS_BADGE[item.status]}>{STATUS_NAME[item.status]}</Badge>
          {item.queuePosition === 1 && <Badge variant="success">下一条</Badge>}
          <span>{profileName}</span>
          <span>{formatNum(item.contentChars || 0)} 字</span>
          <span>
            尝试 {item.attempts || 0}/{item.maxAttempts || '-'}
          </span>
          {item.outputChars ? <span>输出 {formatNum(item.outputChars)} 字</span> : null}
          {item.sourcePath && (
            <span title={item.sourcePath}>来源 {item.sourcePath.split(/[\\/]/).pop()}</span>
          )}
          {item.lastError && <span className="text-fail">{item.lastError.slice(0, 54)}</span>}
        </div>
        <div className="mt-1 truncate text-xs text-muted">
          {item.contentPreview || item.responsePreview || ''}
        </div>
      </div>
      <div className="flex items-center gap-1">
        <Button size="sm" variant="ghost" onClick={(e) => handleMove(e, 'up')} title="上移">
          <ArrowUp className="h-3.5 w-3.5" />
        </Button>
        <Button size="sm" variant="ghost" onClick={(e) => handleMove(e, 'down')} title="下移">
          <ArrowDown className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

function QueueDetailPanel() {
  const selectedQueueId = useAppStore((s) => s.selectedQueueId);
  const setSelectedQueueId = useAppStore((s) => s.setSelectedQueueId);
  const { data: queueData } = usePromptQueue();
  const { data: itemDetail } = useQueueItem(selectedQueueId);
  const queueApi = useQueueApi();
  const toast = useToast();

  const profiles = queueData?.profiles || [];
  const [title, setTitle] = React.useState('');
  const [content, setContent] = React.useState('');
  const [profileId, setProfileId] = React.useState('default');

  React.useEffect(() => {
    if (itemDetail?.item) {
      setTitle(itemDetail.item.title || '');
      setContent(itemDetail.item.content || '');
      setProfileId(itemDetail.item.profileId || 'default');
    }
  }, [itemDetail]);

  const clearEditor = () => {
    setSelectedQueueId(null);
    setTitle('');
    setContent('');
    setProfileId(profiles[0]?.id || 'default');
  };

  const handleSave = () => {
    const t = title.trim() || '未命名任务';
    if (selectedQueueId) {
      queueApi.mutate(
        {
          action: 'updateItem',
          extra: { id: selectedQueueId, patch: { title: t, content, profileId } },
        },
        {
          onSuccess: (r) => toast.success((r as { msg?: string }).msg || '已更新'),
          onError: (e) => toast.error(String(e)),
        },
      );
    } else {
      queueApi.mutate(
        { action: 'addItem', extra: { title: t, content, profileId } },
        {
          onSuccess: (r) => toast.success((r as { msg?: string }).msg || '已加入队列'),
          onError: (e) => toast.error(String(e)),
        },
      );
    }
  };

  const handleAction = (action: string, extra?: Record<string, unknown>) => {
    if (!selectedQueueId) {
      toast.error('先选择一个任务');
      return;
    }
    queueApi.mutate(
      { action, extra: { ids: [selectedQueueId], ...(extra || {}) } },
      {
        onSuccess: (r) => toast.success((r as { msg?: string }).msg || '完成'),
        onError: (e) => toast.error(String(e)),
      },
    );
  };

  const outputPreview =
    itemDetail?.outputText ||
    itemDetail?.item?.responsePreview ||
    itemDetail?.item?.lastError ||
    '选择已完成任务后显示输出。';

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>编辑 / 导入 / 执行档案</CardTitle>
        <span className="text-xs text-muted">
          {queueData?.runtime?.running ? '运行中' : '队列空闲'}
        </span>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 p-3.5">
        {/* Current task editor */}
        <div className="rounded-xl border border-white/[0.075] bg-surface-3 p-3.25">
          <h3 className="mb-2.5 text-[13px] font-bold text-dim">当前任务</h3>
          <div className="grid grid-cols-2 gap-2.5">
            <Input
              placeholder="任务标题"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <select
              value={profileId}
              onChange={(e) => setProfileId(e.target.value)}
              className="h-9 rounded-[10px] border border-border bg-surface-3 px-2.5 text-sm text-txt"
            >
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <textarea
            placeholder="这里是要交给脚本执行端处理的完整内容"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            className="mt-2.5 min-h-[150px] w-full resize-y rounded-[10px] border border-border bg-surface-3 p-2.5 font-mono-code text-xs leading-relaxed text-txt focus:border-accent focus:outline-none"
          />
          <div className="mt-2.5 flex flex-wrap justify-end gap-2">
            <Button size="sm" onClick={clearEditor}>
              清空新建
            </Button>
            <Button size="sm" variant="primary" onClick={handleSave}>
              保存/加入队列
            </Button>
            <Button size="sm" onClick={() => handleAction('resetItems')}>
              重置为待执行
            </Button>
            <Button size="sm" onClick={() => handleAction('skipItems')}>
              跳过
            </Button>
            <Button size="sm" variant="destructive" onClick={() => handleAction('deleteItems')}>
              删除
            </Button>
          </div>
        </div>

        {/* Batch import */}
        <BatchImportPanel profileId={profileId} profiles={profiles} />

        {/* Output preview */}
        <div className="rounded-xl border border-white/[0.075] bg-surface-3 p-3.25">
          <h3 className="mb-2.5 text-[13px] font-bold text-dim">输出预览</h3>
          <div className="max-h-[220px] overflow-auto rounded-[10px] border border-white/[0.075] bg-[#0a0d15] p-3 font-mono-code text-xs leading-relaxed text-[#cdd6e6]">
            {outputPreview}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function BatchImportPanel({
  profileId,
  profiles,
}: {
  profileId: string;
  profiles: { id: string; name: string }[];
}) {
  const queueApi = useQueueApi();
  const toast = useToast();
  const [batchText, setBatchText] = React.useState('');
  const [separator, setSeparator] = React.useState('---');
  const [prefix, setPrefix] = React.useState('任务');
  const [folder, setFolder] = React.useState('');
  const [recursive, setRecursive] = React.useState(false);

  const call = (action: string, extra: Record<string, unknown>) => {
    queueApi.mutate(
      { action, extra: { ...extra, profileId } },
      {
        onSuccess: (r) => toast.success((r as { msg?: string }).msg || '完成'),
        onError: (e) => toast.error(String(e)),
      },
    );
  };

  return (
    <div className="rounded-xl border border-white/[0.075] bg-surface-3 p-3.25">
      <h3 className="mb-2.5 text-[13px] font-bold text-dim">批量导入</h3>
      <div className="grid grid-cols-2 gap-2.5">
        <Input
          placeholder="批量任务标题前缀"
          value={prefix}
          onChange={(e) => setPrefix(e.target.value)}
        />
        <Input
          placeholder="分隔符，默认 ---"
          value={separator}
          onChange={(e) => setSeparator(e.target.value)}
        />
      </div>
      <textarea
        placeholder="粘贴多条任务内容；用单独一行 --- 分隔。"
        value={batchText}
        onChange={(e) => setBatchText(e.target.value)}
        className="mt-2.5 min-h-[120px] w-full resize-y rounded-[10px] border border-border bg-surface-3 p-2.5 font-mono-code text-xs leading-relaxed text-txt focus:border-accent focus:outline-none"
      />
      <div className="mt-2.5 grid grid-cols-2 gap-2.5">
        <Input
          placeholder="导入文件夹路径（txt/md）"
          value={folder}
          onChange={(e) => setFolder(e.target.value)}
        />
        <label className="flex items-center gap-2 text-xs text-muted">
          <input
            type="checkbox"
            checked={recursive}
            onChange={(e) => setRecursive(e.target.checked)}
          />
          包含子文件夹
        </label>
      </div>
      <div className="mt-2.5 flex flex-wrap justify-end gap-2">
        <Button
          size="sm"
          onClick={() => call('addBatch', { text: batchText, separator, titlePrefix: prefix })}
        >
          批量加入
        </Button>
        <Button size="sm" onClick={() => call('importFolder', { folder, recursive })}>
          从文件夹导入
        </Button>
        <Button size="sm" onClick={() => call('retryFailed', {})}>
          重试全部失败
        </Button>
        <Button size="sm" onClick={() => call('clearDone', {})}>
          清理完成/跳过
        </Button>
      </div>
      <div className="mt-2.5 text-xs text-muted">
        当前档案：{profileNameOf(profiles, profileId)}
      </div>
    </div>
  );
}
