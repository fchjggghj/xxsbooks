import * as React from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { MiniBar } from '@/components/ui/progress';
import { useBooks, useFailures, useRetryFailure, useBookDetail, useOutline } from '@/hooks/useApi';
import { useToast } from '@/hooks/useToast';
import { formatNum, readersTxt, cn } from '@/lib/utils';
import { useAppStore } from '@/store/app';
import { X } from 'lucide-react';

type SortKey = 'name' | 'readers' | 'selected' | 'done' | 'pending' | 'failed';

const TIER_BADGE: Record<string, 'success' | 'warning' | 'default'> = {
  big: 'success',
  small: 'warning',
  nodata: 'default',
};

export function Books() {
  const currentTask = useAppStore((s) => s.currentTask);
  const { data: booksData } = useBooks(currentTask);
  const { data: failuresData } = useFailures(currentTask);

  const [filter, setFilter] = React.useState('');
  const [sortKey, setSortKey] = React.useState<SortKey>('name');
  const [sortDir, setSortDir] = React.useState(1);
  const [selectedBook, setSelectedBook] = React.useState<string | null>(null);

  const failures = failuresData?.failures || [];

  const rows = React.useMemo(() => {
    const list = (booksData?.books || []).filter((b) => !filter || b.name.includes(filter));
    return [...list].sort((a, b) => {
      const x = a[sortKey];
      const y = b[sortKey];
      if (sortKey === 'name') return sortDir * String(x).localeCompare(String(y), 'zh');
      const xn = typeof x === 'number' ? x : -1;
      const yn = typeof y === 'number' ? y : -1;
      return sortDir * (xn - yn);
    });
  }, [booksData, filter, sortKey, sortDir]);

  const handleSort = (k: SortKey) => {
    if (sortKey === k) setSortDir((d) => -d);
    else {
      setSortKey(k);
      setSortDir(k === 'name' ? 1 : -1);
    }
  };

  return (
    <div className="space-y-5">
      {/* Failures */}
      <section>
        <h2 className="mb-3 flex items-center gap-2.5 text-[13px] font-bold tracking-wide text-dim">
          失败章节（可重试）
          <span className="text-muted">{failures.length ? `· ${failures.length} 章` : ''}</span>
        </h2>
        <Card>
          <div className="max-h-[540px] overflow-auto rounded-2xl">
            <table className="w-full min-w-[680px] border-collapse text-[13px]">
              <thead>
                <tr>
                  {['书', '章节', '原因', '时间', ''].map((h) => (
                    <th
                      key={h}
                      className="sticky top-0 z-[2] border-b border-white/[0.06] bg-surface-2/95 px-3 py-2.5 text-left text-xs font-bold tracking-tight text-muted backdrop-blur-sm"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {failures.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-5 text-center text-muted">
                      没有失败章节 🎉
                    </td>
                  </tr>
                ) : (
                  failures.slice(0, 400).map((f, i) => (
                    <FailureRow key={i} failure={f} taskId={currentTask} />
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </section>

      {/* Books progress */}
      <section>
        <h2 className="mb-3 flex items-center gap-2.5 text-[13px] font-bold tracking-wide text-dim">
          每本进度
        </h2>
        <div className="mb-2.5 flex flex-wrap items-center gap-2.5">
          <Input
            placeholder="筛选书名…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="max-w-[240px]"
          />
          <span className="text-xs text-muted">共 {rows.length} 本</span>
        </div>
        <Card>
          <div className="max-h-[540px] overflow-auto rounded-2xl">
            <table className="w-full min-w-[680px] border-collapse text-[13px]">
              <thead>
                <tr>
                  {(
                    [
                      ['name', '书名'],
                      ['readers', '在读'],
                      ['selected', '选中'],
                      ['done', '完成'],
                      ['pending', '待处理'],
                      ['failed', '失败'],
                    ] as Array<[SortKey, string]>
                  ).map(([k, label]) => (
                    <th
                      key={k}
                      onClick={() => handleSort(k)}
                      className="sticky top-0 z-[2] cursor-pointer border-b border-white/[0.06] bg-surface-2/95 px-3 py-2.5 text-left text-xs font-bold tracking-tight text-muted backdrop-blur-sm transition-colors hover:text-txt"
                    >
                      {label}
                      {sortKey === k && (sortDir > 0 ? ' ↑' : ' ↓')}
                    </th>
                  ))}
                  <th className="sticky top-0 z-[2] border-b border-white/[0.06] bg-surface-2/95 px-3 py-2.5 text-left text-xs font-bold tracking-tight text-muted backdrop-blur-sm">
                    进度
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-5 text-center text-muted">
                      无匹配
                    </td>
                  </tr>
                ) : (
                  rows.map((b) => {
                    const pct = b.selected ? (b.done / b.selected) * 100 : 0;
                    const fpct = b.selected ? (b.failed / b.selected) * 100 : 0;
                    return (
                      <tr
                        key={b.name}
                        onClick={() => setSelectedBook(b.name)}
                        className="cursor-pointer border-b border-white/[0.05] transition-colors hover:bg-surface-3/60"
                      >
                        <td className="px-3 py-2.5">
                          {b.name.slice(0, 34)}{' '}
                          <Badge variant={TIER_BADGE[b.tier] || 'default'}>{b.tier}</Badge>
                        </td>
                        <td className="px-3 py-2.5 text-muted tabular-nums">
                          {readersTxt(b.readers)}
                        </td>
                        <td className="px-3 py-2.5 tabular-nums">{formatNum(b.selected)}</td>
                        <td className="px-3 py-2.5 text-ok tabular-nums">{formatNum(b.done)}</td>
                        <td className="px-3 py-2.5 tabular-nums">{formatNum(b.pending)}</td>
                        <td
                          className={cn(
                            'px-3 py-2.5 tabular-nums',
                            b.failed ? 'text-fail' : 'text-dim',
                          )}
                        >
                          {formatNum(b.failed)}
                        </td>
                        <td className="px-3 py-2.5">
                          <MiniBar donePct={pct} failPct={fpct} />
                          <span className="ml-1.5 text-xs text-muted tabular-nums">
                            {pct.toFixed(0)}%
                          </span>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </section>

      {/* Book detail modal */}
      {selectedBook && (
        <BookDetailModal
          name={selectedBook}
          taskId={currentTask}
          onClose={() => setSelectedBook(null)}
        />
      )}
    </div>
  );
}

const FailureRow = React.memo(function FailureRow({
  failure,
  taskId,
}: {
  failure: {
    book: string;
    chapter: string;
    reason: string;
    outputPath: string;
    createdAt?: string;
  };
  taskId: string;
}) {
  const retry = useRetryFailure(taskId);
  const toast = useToast();
  const [busy, setBusy] = React.useState(false);

  const handleRetry = () => {
    setBusy(true);
    retry.mutate(failure.outputPath, {
      onSuccess: (r) => {
        toast.success((r as { msg?: string }).msg || '已重试');
      },
      onError: (e) => toast.error(String(e)),
      onSettled: () => setBusy(false),
    });
  };

  return (
    <tr className="border-b border-white/[0.05] transition-colors hover:bg-surface-3/60">
      <td className="px-3 py-2.5">{failure.book.slice(0, 28)}</td>
      <td className="px-3 py-2.5">{failure.chapter}</td>
      <td className="px-3 py-2.5">
        <span className="rounded-md bg-fail/15 px-2 py-0.5 text-[11px] font-bold text-rose-300">
          {failure.reason}
        </span>
      </td>
      <td className="px-3 py-2.5 text-muted">
        {failure.createdAt ? new Date(failure.createdAt).toLocaleString('zh-CN') : '—'}
      </td>
      <td className="px-3 py-2.5">
        <Button size="sm" disabled={busy} onClick={handleRetry}>
          重试
        </Button>
      </td>
    </tr>
  );
});

const CHAPTER_COLOR: Record<string, string> = {
  done: 'bg-ok',
  pending: 'bg-slate-600',
  retry: 'bg-violet-400',
  failed: 'bg-fail',
  unselected: 'bg-surface-3',
};

function BookDetailModal({
  name,
  taskId,
  onClose,
}: {
  name: string;
  taskId: string;
  onClose: () => void;
}) {
  const { data, isLoading } = useBookDetail(name, taskId);
  const [outlinePath, setOutlinePath] = React.useState<string | null>(null);
  const { data: outline } = useOutline(outlinePath, taskId);

  React.useEffect(() => {
    if (!name) setOutlinePath(null);
  }, [name]);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-5 backdrop-blur-md"
      onClick={onClose}
    >
      <div
        className="flex max-h-[88vh] w-[min(900px,94vw)] flex-col rounded-2xl border border-white/[0.1] bg-surface-2 shadow-[0_24px_60px_-28px_rgba(0,0,0,0.8)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-white/[0.06] px-4.5 py-3.5">
          <strong className="text-[15px]">
            {outlinePath ? outlinePath.split(/[\\/]/).pop() : name}
          </strong>
          <span className="text-xs text-muted">
            {isLoading
              ? '加载中…'
              : data?.error
                ? data.error
                : data
                  ? `${data.tier} · 在读 ${readersTxt(data.readers)} · 选中 ${data.selected}/${data.total}`
                  : ''}
          </span>
          <button
            className="ml-auto text-muted transition-colors hover:text-txt"
            onClick={() => {
              if (outlinePath) setOutlinePath(null);
              else onClose();
            }}
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="overflow-auto p-5">
          {outlinePath ? (
            <pre className="whitespace-pre-wrap break-words font-mono-code text-xs leading-relaxed text-[#cdd6e6]">
              {outline?.text || outline?.error || '空'}
            </pre>
          ) : (
            <>
              <div className="flex flex-wrap gap-1">
                {data?.chapters.map((c, i) => (
                  <span
                    key={i}
                    title={`${c.name} · ${c.status}`}
                    onClick={() => c.hasOutput && c.outputPath && setOutlinePath(c.outputPath)}
                    className={cn(
                      'h-3.5 w-3.5 rounded transition-transform hover:scale-125',
                      CHAPTER_COLOR[c.status] || 'bg-surface-3',
                      c.hasOutput && 'cursor-pointer',
                    )}
                  />
                ))}
              </div>
              <div className="mt-3 text-xs text-muted">
                绿=完成（点开看大纲） 灰=待处理 红=失败 暗=未选中
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
