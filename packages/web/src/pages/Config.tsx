import * as React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useConfig, useSaveConfig } from '@/hooks/useApi';
import { useToast } from '@/hooks/useToast';
import { useAppStore, TASK_LABELS, type TaskId } from '@/store/app';
import { cn } from '@/lib/utils';
import { Save, RotateCcw, Code, Cloud, Check } from 'lucide-react';
import type { AppConfig } from '@/lib/api';

interface FieldDef {
  k: string;
  t: 'text' | 'number' | 'bool' | 'lines' | 'textarea';
  label: string;
  hint?: string;
  star?: boolean;
  browse?: boolean;
}

interface SchemaGroup {
  g: string;
  fields: FieldDef[];
}

// ---------- 通用字段组（所有任务共享） ----------

const COMMON_GROUPS: SchemaGroup[] = [
  {
    g: '执行端连接',
    fields: [
      {
        k: 'gptUrl',
        t: 'text',
        label: '执行端入口链接',
        star: true,
        hint: '浏览器自动化要打开的目标页面链接（GPTS 链接）',
      },
      {
        k: 'cdpUrl',
        t: 'text',
        label: 'Chrome 调试地址',
        hint: '默认 http://localhost:9222',
      },
    ],
  },
  {
    g: '执行行为 / 速度',
    fields: [
      {
        k: 'concurrency',
        t: 'number',
        label: '★并发标签页数',
        star: true,
        hint: '默认 1（最稳）。想加速可调 2-3，但越多越容易撞限制。',
      },
      {
        k: 'maxChapters',
        t: 'number',
        label: '单次上限',
        hint: '0=不限；想先小批量试跑就填个小数字。',
      },
      {
        k: 'betweenChaptersMs',
        t: 'number',
        label: '章间隔(毫秒)',
        hint: '每处理完一章停顿多少毫秒。1000=1秒。',
      },
      {
        k: 'deleteConversationAfterDone',
        t: 'bool',
        label: '完成后清理执行记录',
        hint: '开启后，确认输出保存成功再清理目标页面侧当前会话记录。',
      },
    ],
  },
  {
    g: '等待 / 重试',
    fields: [
      { k: 'waitReplyTimeoutMs', t: 'number', label: '等输出超时(ms)', hint: '默认 180000=3 分钟' },
      { k: 'replyStableMs', t: 'number', label: '输出稳定判定(ms)', hint: '文本不再变化多久算生成完' },
      { k: 'rateLimitWaitMs', t: 'number', label: '撞配额墙等待(ms)', hint: '默认 1800000=30 分钟' },
      { k: 'maxRateLimitWaitMs', t: 'number', label: '限流最长等待(ms)', hint: '页面识别到很长等待时间时封顶值' },
      { k: 'failurePauseMs', t: 'number', label: '连续失败暂停(ms)', hint: '达到连续失败阈值后自动暂停多久' },
      { k: 'maxConsecutiveFailures', t: 'number', label: '连续失败阈值', hint: '达到后智能暂停' },
      { k: 'stuckRetries', t: 'number', label: '卡住重试次数', hint: '空/太短/报错时刷新重试上限' },
      { k: 'minOutputChars', t: 'number', label: '最小有效字数', hint: '输出短于此视为无效' },
    ],
  },
];

// ---------- outline 专属字段 ----------

const OUTLINE_GROUPS: SchemaGroup[] = [
  {
    g: '文件夹（输入 / 输出）',
    fields: [
      {
        k: 'libraryRoot',
        t: 'text',
        label: '素材库根目录',
        star: true,
        browse: true,
        hint: '批量输入：每本小说一个子文件夹',
      },
      { k: 'chaptersDir', t: 'text', label: '章节子目录名', hint: '每本书里放章节 txt 的子目录，如 章节' },
      { k: 'outputDir', t: 'text', label: '输出子目录名', hint: '大纲写到每本书的这个子目录' },
      { k: 'outputExt', t: 'text', label: '输出扩展名', hint: '默认 .md' },
      { k: 'skipFiles', t: 'lines', label: '跳过文件', hint: '每行一个文件名' },
    ],
  },
  {
    g: '选择规则（每本取多少章）',
    fields: [
      {
        k: 'selection.firstNPerNovel',
        t: 'number',
        label: '★每本取前几章',
        star: true,
        hint: '核心规则：每本只取前这么多章。填 0 才用旧分档规则。',
      },
      {
        k: 'selection.roundToArc',
        t: 'bool',
        label: '按弧边界取整',
        hint: '绝不把一个世界切一半',
      },
      { k: 'novels', t: 'lines', label: '指定小说（空=全库）', hint: '每行一个小说文件夹名' },
      { k: 'selection.bigThreshold', t: 'number', label: '（旧）全书拆阈值', hint: '仅当上面=0 时生效' },
      { k: 'selection.firstNForSmall', t: 'number', label: '（旧）小书前 N 章', hint: '仅当上面=0 时生效' },
      { k: 'selection.firstNForNoData', t: 'number', label: '（旧）无在读前 N 章', hint: '仅当上面=0 时生效' },
    ],
  },
  {
    g: '批量发送',
    fields: [
      {
        k: 'chaptersPerRequest',
        t: 'number',
        label: '★每次提交章数',
        star: true,
        hint: '一次把几章合成一个任务提交。5 是平衡；填 1=回到一章一处理。',
      },
      { k: 'chaptersPerConversation', t: 'number', label: '每会话章数', hint: '每个标签页处理够 N 章就换新会话' },
      {
        k: 'promptTemplate',
        t: 'textarea',
        label: '任务包装模板',
        hint: '{content} 会被替换成章节正文',
      },
      { k: 'softRetryCap', t: 'number', label: '软失败重试上限', hint: '累计到此值后永久放弃' },
      { k: 'maxItemAttempts', t: 'number', label: '单条尝试上限', hint: '队列单条任务达到后不再尝试' },
    ],
  },
  {
    g: '高级',
    fields: [
      { k: 'webPort', t: 'number', label: '控制台端口', hint: '改完需重启 server 生效' },
      { k: 'scheduledTaskName', t: 'text', label: '计划任务名', hint: '默认 GptOutlineRunner' },
    ],
  },
];

// ---------- adapt 专属字段 ----------

const ADAPT_GROUPS: SchemaGroup[] = [
  {
    g: '文件夹（输入 / 输出）',
    fields: [
      {
        k: 'inputRoot',
        t: 'text',
        label: '输入根目录',
        star: true,
        browse: true,
        hint: '包含小说子文件夹，每个子文件夹内是待改编的大纲文件',
      },
      {
        k: 'outputRoot',
        t: 'text',
        label: '输出根目录',
        star: true,
        browse: true,
        hint: '改编后的大纲输出到此目录（按小说名分子文件夹）',
      },
      { k: 'inputExt', t: 'text', label: '输入扩展名', hint: '默认 .md' },
      { k: 'outputExt', t: 'text', label: '输出扩展名', hint: '默认 .md' },
      { k: 'novels', t: 'lines', label: '指定小说（空=全库）', hint: '每行一个小说文件夹名' },
    ],
  },
  {
    g: '重叠批次策略',
    fields: [
      {
        k: 'overlapBatchSize',
        t: 'number',
        label: '★首批批次大小',
        star: true,
        hint: '首批取多少章一起发送（默认 6）',
      },
      {
        k: 'overlapBatchSizeNext',
        t: 'number',
        label: '后续批次大小',
        hint: '后续批次取多少章（默认 7，含上一批保留的章）',
      },
      {
        k: 'overlapKeepCount',
        t: 'number',
        label: '保留章数',
        hint: '每批保留多少章的输出（默认 5）',
      },
    ],
  },
  {
    g: '提示词',
    fields: [
      {
        k: 'promptPrefix',
        t: 'textarea',
        label: '提示词前缀',
        hint: '发送每批大纲前附加的指令前缀',
      },
    ],
  },
];

// ---------- generate 专属字段（与 adapt 类似） ----------

const GENERATE_GROUPS: SchemaGroup[] = [
  {
    g: '文件夹（输入 / 输出）',
    fields: [
      {
        k: 'inputRoot',
        t: 'text',
        label: '输入根目录',
        star: true,
        browse: true,
        hint: '包含小说子文件夹，每个子文件夹内是待生成正文的大纲文件',
      },
      {
        k: 'outputRoot',
        t: 'text',
        label: '输出根目录',
        star: true,
        browse: true,
        hint: '生成的正文输出到此目录（按小说名分子文件夹）',
      },
      { k: 'inputExt', t: 'text', label: '输入扩展名', hint: '默认 .md' },
      { k: 'outputExt', t: 'text', label: '输出扩展名', hint: '默认 .txt' },
      { k: 'novels', t: 'lines', label: '指定小说（空=全库）', hint: '每行一个小说文件夹名' },
    ],
  },
  {
    g: '提示词',
    fields: [
      {
        k: 'promptPrefix',
        t: 'textarea',
        label: '提示词前缀',
        hint: '发送每章大纲前附加的指令前缀',
      },
    ],
  },
];

/** 获取任务专属字段组 */
function getTaskGroups(taskId: TaskId): SchemaGroup[] {
  if (taskId === 'adapt') return ADAPT_GROUPS;
  if (taskId === 'generate') return GENERATE_GROUPS;
  return OUTLINE_GROUPS;
}

/** 获取完整 schema（通用 + 任务专属） */
function getSchema(taskId: TaskId): SchemaGroup[] {
  return [...COMMON_GROUPS, ...getTaskGroups(taskId)];
}

function getPath(o: unknown, k: string): unknown {
  return k
    .split('.')
    .reduce<unknown>((a, c) => (a == null ? a : (a as Record<string, unknown>)[c]), o);
}

function setPath(o: Record<string, unknown>, k: string, v: unknown): void {
  const ps = k.split('.');
  let cur: Record<string, unknown> = o;
  for (let i = 0; i < ps.length - 1; i++) {
    if (typeof cur[ps[i]] !== 'object' || cur[ps[i]] == null) cur[ps[i]] = {};
    cur = cur[ps[i]] as Record<string, unknown>;
  }
  cur[ps[ps.length - 1]] = v;
}

export function Config() {
  const currentTask = useAppStore((s) => s.currentTask);
  const taskLabel = TASK_LABELS[currentTask];
  const { data, isLoading } = useConfig(currentTask);
  const saveConfig = useSaveConfig(currentTask);
  const toast = useToast();

  const [draft, setDraft] = React.useState<AppConfig | null>(null);
  const [showRaw, setShowRaw] = React.useState(false);
  const [rawText, setRawText] = React.useState('');
  const [dirty, setDirty] = React.useState(false);

  // 任务或数据变化时重置 draft（仅在没有未保存修改时）
  React.useEffect(() => {
    if (data?.config) {
      setDraft(JSON.parse(JSON.stringify(data.config)) as AppConfig);
      setDirty(false);
    }
  }, [data?.config, currentTask]);

  if (isLoading || !draft) {
    return <div className="py-10 text-center text-muted">加载 {taskLabel} 配置中…</div>;
  }

  const schema = getSchema(currentTask);

  const collectFromForm = (): AppConfig => {
    const next: AppConfig = JSON.parse(JSON.stringify(draft));
    const form = document.getElementById('cfg-form');
    if (!form) return next;
    form.querySelectorAll<HTMLElement>('[data-k]').forEach((el) => {
      const k = el.dataset.k!;
      const t = el.dataset.t!;
      let v: unknown;
      if (t === 'bool') v = (el as HTMLInputElement).checked;
      else if (t === 'number') {
        const val = (el as HTMLInputElement).value;
        v = val === '' ? 0 : Number(val);
        if (Number.isNaN(v)) v = 0;
      } else if (t === 'lines') {
        v = (el as HTMLTextAreaElement).value
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean);
      } else v = (el as HTMLInputElement | HTMLTextAreaElement).value;
      setPath(next as Record<string, unknown>, k, v);
    });
    return next;
  };

  const handleSave = () => {
    const next = collectFromForm();
    saveConfig.mutate(next, {
      onSuccess: (r) => {
        toast.success((r as { msg?: string }).msg || `${taskLabel} 配置已保存`);
        setDraft(next);
        setDirty(false);
      },
      onError: (e) => toast.error(String(e)),
    });
  };

  const handleReload = () => {
    if (data?.config) {
      setDraft(JSON.parse(JSON.stringify(data.config)) as AppConfig);
      setDirty(false);
      toast.info('已重新载入');
    }
  };

  const handleOpenRaw = () => {
    setRawText(JSON.stringify(collectFromForm(), null, 2));
    setShowRaw(true);
  };

  const handleSaveRaw = () => {
    try {
      const obj = JSON.parse(rawText) as AppConfig;
      saveConfig.mutate(obj, {
        onSuccess: (r) => {
          toast.success((r as { msg?: string }).msg || '已保存');
          setDraft(obj);
          setShowRaw(false);
          setDirty(false);
        },
        onError: (e) => toast.error(String(e)),
      });
    } catch (e) {
      toast.error('JSON 解析失败：' + String(e));
    }
  };

  // 标记表单已修改
  const markDirty = () => setDirty(true);

  return (
    <div className="space-y-3.5">
      <div className="flex flex-wrap items-center gap-2.5">
        <Button variant="primary" onClick={handleSave} disabled={saveConfig.isPending}>
          <Save className="h-4 w-4" /> 保存 {taskLabel} 配置
        </Button>
        <Button onClick={handleReload}>
          <RotateCcw className="h-4 w-4" /> 重新载入
        </Button>
        <Button onClick={handleOpenRaw}>
          <Code className="h-4 w-4" /> 原始 JSON
        </Button>
        <div className="flex items-center gap-2 text-xs text-muted">
          {/* 热更新状态指示器 */}
          <span
            className={cn(
              'flex items-center gap-1.5 rounded-md border px-2 py-0.5 font-semibold transition-colors',
              dirty
                ? 'border-warn/40 bg-warn/10 text-warn'
                : saveConfig.isPending
                  ? 'border-accent/40 bg-accent/10 text-accent-2'
                  : 'border-ok/40 bg-ok/10 text-ok',
            )}
          >
            {dirty ? (
              <>
                <Cloud className="h-3 w-3" /> 待保存
              </>
            ) : saveConfig.isPending ? (
              <>
                <Cloud className="h-3 w-3 animate-pulse" /> 同步中
              </>
            ) : (
              <>
                <Check className="h-3 w-3" /> 已同步
              </>
            )}
          </span>
          <span className="text-faint">·</span>
          <span>{data?.path}</span>
          <span className="text-faint">·</span>
          <span>端口 {data?.port}</span>
        </div>
      </div>

      {/* 热更新提示条 */}
      <div className="rounded-lg border border-accent/20 bg-accent/[0.05] px-3.5 py-2 text-xs text-dim">
        <Cloud className="mr-1.5 inline h-3 w-3 text-accent-2" />
        配置保存后立即生效（热更新）：runner 下一轮自动读取新配置，无需重启服务。
      </div>

      <div id="cfg-form" className="space-y-3.5" onChange={markDirty}>
        {schema.map((grp) => (
          <Card key={grp.g}>
            <CardContent className="px-4 pb-4 pt-1.5">
              <div className="py-3 text-[13px] font-bold tracking-tight text-accent-2">{grp.g}</div>
              {grp.fields.map((f, idx) => {
                const v = getPath(draft, f.k);
                return (
                  <div
                    key={f.k}
                    className={cn(
                      'grid grid-cols-[210px_1fr] items-start gap-4 py-2.75',
                      idx > 0 && 'border-t border-white/[0.05]',
                      'max-[860px]:grid-cols-1',
                    )}
                  >
                    <div className="pt-2 font-semibold">
                      {f.label}
                      {f.star && <span className="ml-1 text-accent-2">★</span>}
                      {f.hint && (
                        <div className="mt-1 text-xs font-normal text-muted">{f.hint}</div>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      {f.t === 'bool' ? (
                        <label className="flex cursor-pointer items-center gap-2 text-sm text-muted transition-colors hover:text-txt">
                          <input
                            type="checkbox"
                            data-k={f.k}
                            data-t="bool"
                            defaultChecked={!!v}
                            className="h-4 w-4 cursor-pointer rounded border-border accent-accent"
                          />
                          开启
                        </label>
                      ) : f.t === 'number' ? (
                        <Input
                          type="number"
                          data-k={f.k}
                          data-t="number"
                          defaultValue={(v as number | string | undefined) ?? ''}
                        />
                      ) : f.t === 'lines' ? (
                        <textarea
                          data-k={f.k}
                          data-t="lines"
                          placeholder="每行一个"
                          defaultValue={Array.isArray(v) ? (v as string[]).join('\n') : ''}
                          className="min-h-[72px] w-full resize-y rounded-[10px] border border-border/80 bg-surface-3/80 p-2.5 font-mono-code text-xs leading-relaxed text-txt transition-all duration-150 hover:border-border focus:border-accent focus:bg-surface-2 focus:outline-none focus:ring-2 focus:ring-accent/20"
                        />
                      ) : f.t === 'textarea' ? (
                        <textarea
                          data-k={f.k}
                          data-t="text"
                          defaultValue={(v as string | undefined) ?? ''}
                          className="min-h-[72px] w-full resize-y rounded-[10px] border border-border/80 bg-surface-3/80 p-2.5 font-mono-code text-xs leading-relaxed text-txt transition-all duration-150 hover:border-border focus:border-accent focus:bg-surface-2 focus:outline-none focus:ring-2 focus:ring-accent/20"
                        />
                      ) : (
                        <Input
                          data-k={f.k}
                          data-t="text"
                          defaultValue={(v as string | undefined) ?? ''}
                        />
                      )}
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Raw JSON modal */}
      {showRaw && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-5 backdrop-blur-md"
          onClick={() => setShowRaw(false)}
        >
          <div
            className="flex max-h-[88vh] w-[min(900px,94vw)] flex-col rounded-2xl border border-white/[0.1] bg-surface-2 shadow-[0_24px_60px_-28px_rgba(0,0,0,0.8)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 border-b border-white/[0.06] px-4.5 py-3.5">
              <strong className="text-[15px]">{taskLabel} config.json（原始，可编辑保存）</strong>
              <button
                className="ml-auto text-xl text-muted transition-colors hover:text-txt"
                onClick={() => setShowRaw(false)}
              >
                ×
              </button>
            </div>
            <div className="overflow-auto p-5">
              <textarea
                value={rawText}
                onChange={(e) => setRawText(e.target.value)}
                className="min-h-[420px] w-full resize-y rounded-[10px] border border-border/80 bg-surface-3/80 p-3 font-mono-code text-xs leading-relaxed text-txt transition-all duration-150 hover:border-border focus:border-accent focus:bg-surface-2 focus:outline-none focus:ring-2 focus:ring-accent/20"
              />
              <div className="mt-2.5 text-right">
                <Button variant="primary" onClick={handleSaveRaw} disabled={saveConfig.isPending}>
                  保存原始 JSON
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
