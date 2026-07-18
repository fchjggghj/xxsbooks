export function taskStateKey(task) {
  return task.id;
}

export function mergeStateTasks(cfg, state, tasks, opts, options = {}) {
  const exists = options.exists || (() => false);
  const now = options.now || (() => new Date().toISOString());
  const restartNovelKeys = options.restartNovelKeys || new Set();
  const next = {};
  for (const task of tasks) {
    const key = taskStateKey(task);
    const previous = state.tasks[key] || {};
    const outputExists = exists(task.outputPath);
    const restartRequired = restartNovelKeys.has(task.novelKey) || previous.restartRequired === true;
    const status = !opts.force && !restartRequired && cfg.skipExisting && outputExists
      ? 'done'
      : previous.status || 'pending';

    next[key] = {
      ...previous,
      id: task.id,
      localId: task.localId,
      index: task.index,
      novelKey: task.novelKey,
      novelName: task.novelName,
      volumeName: task.volumeName || '',
      inputFiles: task.inputFiles.map((item) => item.relativePath),
      outputFile: task.outputPath,
      status: (opts.force || restartRequired) && status === 'done' ? 'pending' : status,
      restartRequired,
      retries: Number(previous.retries || 0),
      lastError: previous.lastError || '',
      sent: previous.sent === true,
      conversationUrl: previous.conversationUrl || '',
      updatedAt: previous.updatedAt || now(),
    };
  }
  state.tasks = options.preserveExisting ? { ...state.tasks, ...next } : next;
}

export function firstRunnableTask(cfg, state, tasks, opts, options = {}) {
  const exists = options.exists || (() => false);
  for (const task of tasks) {
    const item = state.tasks[taskStateKey(task)];
    if (!item) return task;
    if (item.restartRequired === true) return task;
    if (!opts.force && cfg.skipExisting && exists(task.outputPath)) continue;
    if (item.status !== 'done') return task;
  }
  return null;
}
