import { create } from 'zustand';

export type TabKey = 'dash' | 'queue' | 'config' | 'logs' | 'books' | 'library' | 'direction' | 'pool' | 'composer';

/** 任务 ID（对应后端 TASK_DIRS） */
export type TaskId = 'outline' | 'adapt' | 'generate';

/** 任务显示名 */
export const TASK_LABELS: Record<TaskId, string> = {
  outline: '拆大纲',
  adapt: '改编大纲',
  generate: '写正文',
};

/** 所有内置任务 */
export const ALL_TASKS: TaskId[] = ['outline', 'adapt', 'generate'];

interface AppState {
  tab: TabKey;
  setTab: (t: TabKey) => void;
  /** 当前选中的任务（影响 Logs/Config/Books/Dashboard 页面） */
  currentTask: TaskId;
  setCurrentTask: (t: TaskId) => void;
  selectedQueueId: string | null;
  setSelectedQueueId: (id: string | null) => void;
}

export const useAppStore = create<AppState>((set) => ({
  tab: 'dash',
  setTab: (t) => set({ tab: t }),
  currentTask: 'outline',
  setCurrentTask: (t) => set({ currentTask: t }),
  selectedQueueId: null,
  setSelectedQueueId: (id) => set({ selectedQueueId: id }),
}));
