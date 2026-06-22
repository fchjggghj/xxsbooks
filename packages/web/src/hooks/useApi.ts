import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  apiGet,
  apiPost,
  type StateResponse,
  type ChromeResponse,
  type RunLogResponse,
  type DaemonLogResponse,
  type BooksResponse,
  type FailuresResponse,
  type ConfigResponse,
  type AppConfig,
  type ControlResponse,
  type PromptQueueResponse,
  type QueuePlanResponse,
  type QueueEventsResponse,
  type QueueItemResponse,
  type HealthResponse,
  type BrowseResponse,
  type BookDetail,
  type OutlineResponse,
  type TasksResponse,
} from '@/lib/api';

// ---------- 状态轮询 ----------

export function useChromeState() {
  return useQuery<ChromeResponse>({
    queryKey: ['chrome'],
    queryFn: () => apiGet('/chrome'),
    refetchInterval: 3000,
  });
}

export function useRunState() {
  return useQuery<StateResponse>({
    queryKey: ['state'],
    queryFn: () => apiGet('/state'),
    refetchInterval: 3000,
  });
}

/** 指定任务的状态 */
export function useTaskState(taskId: string) {
  return useQuery<StateResponse>({
    queryKey: ['state', taskId],
    queryFn: () => apiGet(`/state?task=${taskId}`),
    refetchInterval: 3000,
  });
}

/** 所有任务的状态摘要（多任务总览） */
export function useTasks() {
  return useQuery<TasksResponse>({
    queryKey: ['tasks'],
    queryFn: () => apiGet('/tasks'),
    refetchInterval: 3000,
  });
}

/** 指定任务的 run.log */
export function useTaskRunLog(taskId: string, n = 300) {
  return useQuery<RunLogResponse>({
    queryKey: ['log', 'run', taskId, n],
    queryFn: () => apiGet(`/log?which=run&n=${n}&task=${taskId}`),
    refetchInterval: 3000,
  });
}

export function useRunLog(n = 300) {
  return useQuery<RunLogResponse>({
    queryKey: ['log', 'run', n],
    queryFn: () => apiGet(`/log?which=run&n=${n}`),
    refetchInterval: 3000,
  });
}

export function useDaemonLog(n = 120) {
  return useQuery<DaemonLogResponse>({
    queryKey: ['log', 'daemon', n],
    queryFn: () => apiGet(`/log?which=daemon&n=${n}`),
    refetchInterval: 3000,
  });
}

export function useBooks(taskId = 'outline') {
  return useQuery<BooksResponse>({
    queryKey: ['books', taskId],
    queryFn: () => apiGet(`/books?task=${taskId}`),
    refetchInterval: 20000,
  });
}

export function useFailures(taskId = 'outline') {
  return useQuery<FailuresResponse>({
    queryKey: ['failures', taskId],
    queryFn: () => apiGet(`/failures?task=${taskId}`),
    refetchInterval: 20000,
  });
}

export function useConfig(taskId = 'outline') {
  return useQuery<ConfigResponse>({
    queryKey: ['config', taskId],
    queryFn: () => apiGet(`/config?task=${taskId}`),
  });
}

export function useSaveConfig(taskId = 'outline') {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (config: AppConfig) =>
      apiPost<ControlResponse>('/config', { config, task: taskId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['config', taskId] });
      qc.invalidateQueries({ queryKey: ['state', taskId] });
      qc.invalidateQueries({ queryKey: ['books', taskId] });
      qc.invalidateQueries({ queryKey: ['failures', taskId] });
    },
  });
}

// ---------- 控制操作 ----------

export function useControl() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { action: string; extra?: Record<string, unknown> }) =>
      apiPost<ControlResponse>('/control', { action: vars.action, ...(vars.extra || {}) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['state'] });
      qc.invalidateQueries({ queryKey: ['chrome'] });
    },
  });
}

export function useRetryFailure(taskId = 'outline') {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (outputPath: string) =>
      apiPost<ControlResponse>('/control', { action: 'retry', outputPath, task: taskId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['failures', taskId] });
      qc.invalidateQueries({ queryKey: ['state', taskId] });
      qc.invalidateQueries({ queryKey: ['books', taskId] });
    },
  });
}

// ---------- 浏览 ----------

export function useBrowse(path: string, enabled = true) {
  return useQuery<BrowseResponse>({
    queryKey: ['browse', path],
    queryFn: () => apiGet(`/browse?path=${encodeURIComponent(path)}`),
    enabled,
  });
}

export function useBookDetail(name: string | null, taskId = 'outline') {
  return useQuery<BookDetail>({
    queryKey: ['book', taskId, name],
    queryFn: () => apiGet(`/book?task=${taskId}&name=${encodeURIComponent(name!)}`),
    enabled: !!name,
  });
}

export function useOutline(path: string | null, taskId = 'outline') {
  return useQuery<OutlineResponse>({
    queryKey: ['outline', taskId, path],
    queryFn: () => apiGet(`/outline?path=${encodeURIComponent(path!)}&task=${taskId}`),
    enabled: !!path,
  });
}

// ---------- 队列 ----------

export function usePromptQueue() {
  return useQuery<PromptQueueResponse>({
    queryKey: ['prompt-queue'],
    queryFn: () => apiGet('/prompt-queue'),
    refetchInterval: 7000,
  });
}

export function useQueueHealth() {
  return useQuery<HealthResponse>({
    queryKey: ['health'],
    queryFn: () => apiGet('/health'),
    refetchInterval: 7000,
  });
}

export function useQueueEvents(n = 80) {
  return useQuery<QueueEventsResponse>({
    queryKey: ['prompt-queue-events', n],
    queryFn: () => apiGet(`/prompt-queue/events?n=${n}`),
    refetchInterval: 7000,
  });
}

export function useQueuePlan(n = 160) {
  return useQuery<QueuePlanResponse>({
    queryKey: ['prompt-queue-plan', n],
    queryFn: () => apiGet(`/prompt-queue/plan?n=${n}`),
    refetchInterval: 7000,
  });
}

export function useQueueItem(id: string | null) {
  return useQuery<QueueItemResponse>({
    queryKey: ['prompt-queue-item', id],
    queryFn: () => apiGet(`/prompt-queue/item?id=${encodeURIComponent(id!)}`),
    enabled: !!id,
  });
}

export function useQueueApi() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { action: string; extra?: Record<string, unknown> }) =>
      apiPost<PromptQueueResponse>('/prompt-queue', { action: vars.action, ...(vars.extra || {}) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['prompt-queue'] });
      qc.invalidateQueries({ queryKey: ['prompt-queue-plan'] });
      qc.invalidateQueries({ queryKey: ['prompt-queue-events'] });
      qc.invalidateQueries({ queryKey: ['health'] });
    },
  });
}

export function useQueueControl() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: string) => apiPost<ControlResponse>('/prompt-queue/control', { action }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['prompt-queue'] });
      qc.invalidateQueries({ queryKey: ['prompt-queue-plan'] });
      qc.invalidateQueries({ queryKey: ['health'] });
    },
  });
}
