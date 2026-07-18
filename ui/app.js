const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const elements = {
  connectionBadge: $('#connection-badge'),
  refreshStatus: $('#refresh-status'),
  queueState: $('#queue-state'),
  queueProcess: $('#queue-process'),
  queueLock: $('#queue-lock'),
  checkedAt: $('#checked-at'),
  cdpState: $('#cdp-state'),
  cdpUrl: $('#cdp-url'),
  // 控制队列
  actionState: $('#action-state'),
  start: $('#action-start'),
  resume: $('#action-resume'),
  stop: $('#action-stop'),
  actionForce: $('#action-force'),
  actionLimit: $('#action-limit'),
  // Chrome
  launchChrome: $('#launch-chrome'),
  // 番茄发布
  fanqieBook: $('#fanqie-book'),
  fanqieLocalState: $('#fanqie-local-state'),
  fanqieRefreshLocal: $('#fanqie-refresh-local'),
  fanqieLaunchChrome: $('#fanqie-launch-chrome'),
  fanqieLocalOutput: $('#fanqie-local-output'),
  fanqieRemoteState: $('#fanqie-remote-state'),
  fanqieActionState: $('#fanqie-action-state'),
  fanqieFrom: $('#fanqie-from'),
  fanqieTo: $('#fanqie-to'),
  fanqieConfirmation: $('#fanqie-confirmation'),
  fanqieRemoteStatus: $('#fanqie-remote-status'),
  fanqieUploadPreview: $('#fanqie-upload-preview'),
  fanqieReconcilePreview: $('#fanqie-reconcile-preview'),
  fanqieReconcileApply: $('#fanqie-reconcile-apply'),
  fanqieUploadApply: $('#fanqie-upload-apply'),
  fanqieRemoteOutput: $('#fanqie-remote-output'),
  // 素材库
  materialState: $('#material-state'),
  materialActionState: $('#material-action-state'),
  materialRefresh: $('#material-refresh'),
  materialIndex: $('#material-index'),
  materialStatusOutput: $('#material-status-output'),
  materialQuery: $('#material-query'),
  materialSearch: $('#material-search'),
  materialResults: $('#material-results'),
  materialBook: $('#material-book'),
  materialImportPreview: $('#material-import-preview'),
  materialImportApply: $('#material-import-apply'),
  materialSearchOutput: $('#material-search-output'),
  // Reconcile
  reconcileState: $('#reconcile-state'),
  reconcilePreview: $('#reconcile-preview'),
  reconcileApply: $('#reconcile-apply'),
  reconcileOutput: $('#reconcile-output'),
  // Progress
  progressState: $('#progress-state'),
  generateProgress: $('#generate-progress'),
  progressOutput: $('#progress-output'),
  // Books
  refreshBooks: $('#refresh-books'),
  booksMeta: $('#books-meta'),
  booksList: $('#books-list'),
  // Normalize
  normalizeState: $('#normalize-state'),
  normalizeBook: $('#normalize-book'),
  normalizeVolume: $('#normalize-volume'),
  normalizePreview: $('#normalize-preview'),
  normalizeApply: $('#normalize-apply'),
  normalizeOutput: $('#normalize-output'),
  // Import
  importState: $('#import-state'),
  importSource: $('#import-source'),
  importPreview: $('#import-preview'),
  importApply: $('#import-apply'),
  importOutput: $('#import-output'),
  // Preview Volumes
  previewVolState: $('#preview-vol-state'),
  previewVolSource: $('#preview-vol-source'),
  previewVolRun: $('#preview-vol-run'),
  previewVolOutput: $('#preview-vol-output'),
  // Config
  configStage: $('#config-stage'),
  loadConfig: $('#load-config'),
  saveConfig: $('#save-config'),
  configMeta: $('#config-meta'),
  configEditor: $('#config-editor'),
  configError: $('#config-error'),
  // 预检 + 日志
  preflight: $('#run-preflight'),
  preflightSummary: $('#preflight-summary'),
  preflightList: $('#preflight-list'),
  logStage: $('#log-stage'),
  refreshLogs: $('#refresh-logs'),
  logMeta: $('#log-meta'),
  logOutput: $('#log-output'),
  toast: $('#toast'),
};

let statusLoading = false;
let operationBusy = false;
let fanqieBusy = false;
let materialBusy = false;
let toastTimer = null;

async function api(path, options = {}) {
  const response = await fetch(path, {
    cache: 'no-store',
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  const payload = await response.json().catch(() => ({ error: `服务器返回了 HTTP ${response.status}` }));
  if (!response.ok) {
    const error = new Error(payload.error || payload.cause?.message || `请求失败（HTTP ${response.status}）`);
    error.payload = payload;
    throw error;
  }
  return payload;
}

function showToast(message, kind = 'info') {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.className = `toast toast-${kind}`;
  elements.toast.hidden = false;
  toastTimer = setTimeout(() => {
    elements.toast.hidden = true;
  }, 5000);
}

function setPill(element, text, kind = 'neutral') {
  element.textContent = text;
  element.className = `status-pill status-${kind}`;
}

function formatTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

function stageState(stage) {
  const counts = stage?.counts || {};
  if (!stage?.stateExists) return ['未初始化', 'neutral'];
  if ((counts.failed || 0) > 0 || stage.missingOutputs?.length) return ['需要处理', 'danger'];
  if ((counts.running || 0) > 0) return ['运行中', 'active'];
  if (stage.complete) return ['已完成', 'success'];
  return ['等待中', 'warning'];
}

function renderStage(name, stage = {}) {
  const card = $(`#stage-${name}`);
  const counts = stage.counts || {};
  const total = Number(stage.taskCount || 0);
  const done = Number(counts.done || 0);
  const percent = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const [stateText, stateKind] = stageState(stage);

  setPill($('[data-field="state"]', card), stateText, stateKind);
  $('[data-field="progress"]', card).value = percent;
  $('[data-field="progress-text"]', card).textContent = `${done} / ${total} · ${percent}%`;
  $('[data-field="done"]', card).textContent = done;
  $('[data-field="pending"]', card).textContent = Number(counts.pending || 0);
  $('[data-field="running"]', card).textContent = Number(counts.running || 0);
  $('[data-field="failed"]', card).textContent = Number(counts.failed || 0);
  $('[data-field="current"]', card).textContent = stage.currentTaskId || '—';

  const error = $('[data-field="error"]', card);
  const problems = [];
  if (stage.lastError) problems.push(stage.lastError);
  if (stage.missingOutputs?.length) problems.push(`缺少 ${stage.missingOutputs.length} 个已完成任务的输出文件`);
  error.textContent = problems.join('；');
  error.hidden = problems.length === 0;
}

function renderStatus(status) {
  const processes = status.processes || [];
  const lock = status.lock || {};
  const activePid = lock.info?.pid || processes[0]?.pid;
  const running = Boolean(lock.active || processes.length);

  setPill(elements.queueState, running ? '运行中' : lock.stale ? '锁异常' : '空闲', running ? 'active' : lock.stale ? 'danger' : 'success');
  elements.queueProcess.textContent = processes.length ? `${processes.length} 个（PID ${processes.map((item) => item.pid).join('、')}）` : activePid ? `PID ${activePid}` : '无运行进程';
  elements.queueLock.textContent = lock.active ? `占用中（PID ${lock.info?.pid || '未知'}）` : lock.stale ? '发现陈旧锁' : '空闲';
  elements.checkedAt.textContent = formatTime(status.checkedAt);

  const cdpReady = Boolean(status.cdp?.ready);
  setPill(elements.cdpState, cdpReady ? '已连接' : '未连接', cdpReady ? 'success' : 'danger');
  elements.cdpUrl.textContent = status.cdp?.url || '—';
  renderStage('chai', status.stages?.chai);
  renderStage('xie', status.stages?.xie);
}

async function refreshStatus({ quiet = false } = {}) {
  if (statusLoading) return;
  statusLoading = true;
  elements.refreshStatus.disabled = true;
  try {
    const status = await api('/api/status');
    renderStatus(status);
    elements.connectionBadge.textContent = '面板已连接';
    elements.connectionBadge.className = 'badge badge-online';
  } catch (error) {
    elements.connectionBadge.textContent = '连接失败';
    elements.connectionBadge.className = 'badge badge-offline';
    if (!quiet) showToast(error.message, 'error');
  } finally {
    statusLoading = false;
    elements.refreshStatus.disabled = false;
  }
}

// ============ Tab 切换 ============
function setupTabs() {
  const tabs = $$('.tab');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      tabs.forEach((t) => {
        const active = t === tab;
        t.classList.toggle('tab-active', active);
        t.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      $$('.tab-panel').forEach((panel) => {
        const active = panel.id === `tab-${target}`;
        panel.classList.toggle('tab-panel-active', active);
        panel.hidden = !active;
      });
      // 切到功能页时按需加载；番茄只读取本地状态，不自动访问远端。
      if (target === 'books' && !elements.booksList.dataset.loaded) refreshBooks({ quiet: true });
      if (target === 'fanqie' && !elements.fanqieBook.dataset.loaded) refreshFanqieLocal({ quiet: true });
      if (target === 'materials' && !elements.materialResults.dataset.loaded) refreshMaterialStatus({ quiet: true });
      if (target === 'config' && !elements.configEditor.dataset.loaded) loadConfig().catch(() => {});
    });
  });
}

// ============ 控制队列（增强版：limit + force） ============
function selectedStage(name = 'action-stage') {
  return $(`input[name="${name}"]:checked`)?.value || '';
}

function setOperationBusy(value, message = '等待操作') {
  operationBusy = value;
  elements.start.disabled = value;
  elements.resume.disabled = value;
  elements.stop.disabled = value;
  elements.actionState.textContent = message;
}

async function runAction(action) {
  if (operationBusy) return;
  const stage = action === 'stop' ? null : selectedStage();
  if (action !== 'stop' && !stage) {
    showToast('请先选择“拆文”或“正文”阶段。', 'warning');
    return;
  }
  if (action === 'stop') {
    const confirmed = window.confirm('确定要停止当前队列吗？正在处理的任务会被中断，之后可以使用“继续”恢复。');
    if (!confirmed) return;
  }

  const labels = { start: '正在开始', resume: '正在继续', stop: '正在停止' };
  setOperationBusy(true, `${labels[action]}…`);
  try {
    const body = { action };
    if (stage) body.stage = stage;
    if (action === 'start') {
      if (elements.actionForce.checked) body.force = true;
      const limit = Number(elements.actionLimit.value);
      if (elements.actionLimit.value && Number.isInteger(limit) && limit > 0) body.limit = limit;
    }
    const payload = await api('/api/action', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (payload.after) renderStatus(payload.after);
    const successText = action === 'stop'
      ? payload.result?.stopped === false ? '当前没有运行中的队列。' : '队列已停止。'
      : `${stage === 'chai' ? '拆文' : '正文'}阶段操作成功。`;
    showToast(successText, 'success');
    await refreshLogs({ quiet: true });
  } catch (error) {
    if (error.payload?.after) renderStatus(error.payload.after);
    showToast(error.message, 'error');
  } finally {
    setOperationBusy(false);
    await refreshStatus({ quiet: true });
  }
}

// ============ 启动 Chrome ============
async function launchChrome() {
  elements.launchChrome.disabled = true;
  try {
    const payload = await api('/api/chrome', { method: 'POST', body: JSON.stringify({}) });
    showToast(payload.message || 'Chrome 启动命令已发出。', 'success');
    // 5 秒后刷新状态查看 CDP
    setTimeout(() => refreshStatus({ quiet: true }), 5000);
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    elements.launchChrome.disabled = false;
  }
}

// ============ 番茄发布 ============
function selectedFanqieBook() {
  return elements.fanqieBook.value || '';
}

function setFanqieBusy(value, message = '等待操作') {
  fanqieBusy = value;
  for (const button of [
    elements.fanqieRefreshLocal, elements.fanqieLaunchChrome, elements.fanqieRemoteStatus,
    elements.fanqieUploadPreview, elements.fanqieReconcilePreview,
    elements.fanqieReconcileApply, elements.fanqieUploadApply,
  ]) button.disabled = value;
  elements.fanqieActionState.textContent = message;
}

async function refreshFanqieLocal({ quiet = false } = {}) {
  if (fanqieBusy) return;
  elements.fanqieRefreshLocal.disabled = true;
  try {
    const data = await api('/api/fanqie/local-status');
    const previous = selectedFanqieBook();
    elements.fanqieBook.replaceChildren();
    for (const item of data.books || []) {
      const option = document.createElement('option');
      option.value = item.book;
      option.textContent = item.error ? `${item.book}（配置错误）` : item.book;
      elements.fanqieBook.append(option);
    }
    if (previous && [...elements.fanqieBook.options].some((option) => option.value === previous)) {
      elements.fanqieBook.value = previous;
    }
    elements.fanqieBook.dataset.loaded = '1';
    setPill(elements.fanqieLocalState, data.ok ? '本地检查通过' : '需要处理', data.ok ? 'success' : 'danger');
    elements.fanqieLocalOutput.textContent = JSON.stringify(data, null, 2);
    if (!quiet) showToast(data.ok ? '番茄本地配置检查通过。' : '番茄本地配置存在问题。', data.ok ? 'success' : 'warning');
  } catch (error) {
    setPill(elements.fanqieLocalState, '读取失败', 'danger');
    elements.fanqieLocalOutput.textContent = `失败：${error.message}`;
    if (!quiet) showToast(error.message, 'error');
  } finally {
    elements.fanqieRefreshLocal.disabled = false;
  }
}

function setMaterialBusy(value, message = '等待操作') {
  materialBusy = value;
  for (const button of [elements.materialRefresh, elements.materialIndex, elements.materialSearch, elements.materialImportPreview, elements.materialImportApply]) {
    button.disabled = value;
  }
  elements.materialActionState.textContent = message;
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let amount = bytes;
  let unit = -1;
  do { amount /= 1024; unit++; } while (amount >= 1024 && unit < units.length - 1);
  return `${amount.toFixed(2)} ${units[unit]}`;
}

async function refreshMaterialStatus({ quiet = false } = {}) {
  if (materialBusy) return;
  setMaterialBusy(true, '正在读取素材状态…');
  try {
    const [status, books] = await Promise.all([api('/api/material/local-status'), api('/api/books')]);
    setPill(elements.materialState, status.ok && status.indexed ? '索引可用' : '需要建立索引', status.ok && status.indexed ? 'success' : 'warning');
    elements.materialStatusOutput.textContent = JSON.stringify({
      ...status,
      totalSize: formatBytes(status.totalBytes),
    }, null, 2);
    const previousBook = elements.materialBook.value;
    elements.materialBook.replaceChildren();
    for (const item of books.books || []) {
      const option = document.createElement('option');
      option.value = item.name;
      option.textContent = item.name;
      elements.materialBook.append(option);
    }
    if ([...elements.materialBook.options].some((option) => option.value === previousBook)) elements.materialBook.value = previousBook;
    elements.materialResults.dataset.loaded = '1';
  } catch (error) {
    setPill(elements.materialState, '读取失败', 'danger');
    elements.materialStatusOutput.textContent = `失败：${error.message}`;
    if (!quiet) showToast(error.message, 'error');
  } finally {
    setMaterialBusy(false);
  }
}

async function rebuildMaterialIndex() {
  if (materialBusy || !window.confirm('重建素材元数据索引？不会读取或修改素材正文。')) return;
  setMaterialBusy(true, '正在重建索引…');
  try {
    const result = await api('/api/material/index', { method: 'POST', body: JSON.stringify({}) });
    elements.materialStatusOutput.textContent = JSON.stringify({ ...result, totalSize: formatBytes(result.totalBytes) }, null, 2);
    showToast(`已索引 ${result.fileCount} 个素材文件。`, 'success');
  } catch (error) {
    elements.materialStatusOutput.textContent = `失败：${error.message}`;
    showToast(error.message, 'error');
  } finally {
    setMaterialBusy(false);
    await refreshMaterialStatus({ quiet: true });
  }
}

async function searchMaterials() {
  if (materialBusy) return;
  const query = elements.materialQuery.value.trim();
  if (!query) { showToast('请输入素材关键词。', 'warning'); return; }
  setMaterialBusy(true, '正在搜索…');
  try {
    const result = await api(`/api/material/search?query=${encodeURIComponent(query)}&limit=100`);
    elements.materialResults.replaceChildren();
    for (const item of result.items || []) {
      const option = document.createElement('option');
      option.value = item.relativePath;
      option.dataset.sourceId = item.sourceId;
      option.textContent = `${item.title} · ${formatBytes(item.sizeBytes)} · ${item.relativePath}`;
      elements.materialResults.append(option);
    }
    elements.materialSearchOutput.textContent = JSON.stringify(result, null, 2);
    elements.materialActionState.textContent = `找到 ${result.totalMatches} 项`;
  } catch (error) {
    elements.materialSearchOutput.textContent = `失败：${error.message}`;
    showToast(error.message, 'error');
  } finally {
    setMaterialBusy(false, elements.materialActionState.textContent);
  }
}

async function importSelectedMaterial(apply = false) {
  if (materialBusy) return;
  const option = elements.materialResults.selectedOptions[0];
  const book = elements.materialBook.value;
  if (!option || !book) { showToast('请选择素材文件和目标书籍。', 'warning'); return; }
  if (apply && !window.confirm(`把所选素材复制到《${book}》的素材目录？`)) return;
  setMaterialBusy(true, apply ? '正在复制素材…' : '正在预览导入…');
  try {
    const result = await api('/api/material/import', {
      method: 'POST',
      body: JSON.stringify({ sourceId: option.dataset.sourceId || 'main', relativePath: option.value, book, apply }),
    });
    elements.materialSearchOutput.textContent = JSON.stringify(result, null, 2);
    showToast(apply ? '素材已复制到书籍素材目录。' : '导入预览已生成。', 'success');
  } catch (error) {
    elements.materialSearchOutput.textContent = `失败：${error.message}`;
    showToast(error.message, 'error');
  } finally {
    setMaterialBusy(false);
  }
}

function fanqieRangeBody() {
  const body = { book: selectedFanqieBook() };
  if (!body.book) throw new Error('没有可用的番茄书籍绑定。');
  for (const [name, element] of [['from', elements.fanqieFrom], ['to', elements.fanqieTo]]) {
    if (!element.value) continue;
    const value = Number(element.value);
    if (!Number.isInteger(value) || value < 1) throw new Error(`${name} 必须是正整数。`);
    body[name] = value;
  }
  return body;
}

async function launchFanqieChrome() {
  if (fanqieBusy) return;
  let body;
  try { body = fanqieRangeBody(); } catch (error) { showToast(error.message, 'warning'); return; }
  setFanqieBusy(true, '正在启动专用 Chrome…');
  try {
    const result = await api('/api/fanqie/chrome', { method: 'POST', body: JSON.stringify({ book: body.book }) });
    showToast(result.message || '番茄 Chrome 启动命令已发出。', 'success');
  } catch (error) { showToast(error.message, 'error'); }
  finally { setFanqieBusy(false); }
}

async function runFanqieCommand(command, apply = false) {
  if (fanqieBusy) return;
  let body;
  try { body = fanqieRangeBody(); } catch (error) { showToast(error.message, 'warning'); return; }
  body.apply = apply;
  if (apply) {
    body.confirmation = elements.fanqieConfirmation.value;
    const expected = command === 'upload' ? `PUBLISH ${body.book}` : `RECONCILE ${body.book}`;
    if (body.confirmation !== expected) {
      showToast(`请输入准确确认文字：${expected}`, 'warning');
      return;
    }
    const question = command === 'upload'
      ? `最后确认：现在正式向番茄提交“${body.book}”的待发布章节吗？`
      : `确认根据番茄远端列表回填“${body.book}”的本地发布状态吗？`;
    if (!window.confirm(question)) return;
  }
  const endpoint = command === 'status' ? 'remote-status' : command;
  setFanqieBusy(true, apply ? '正在执行受保护写操作…' : '正在进行只读远端检查…');
  elements.fanqieRemoteState.textContent = '执行中…';
  elements.fanqieRemoteOutput.textContent = '正在连接绑定的番茄账号，请稍候……';
  try {
    const result = await api(`/api/fanqie/${endpoint}`, { method: 'POST', body: JSON.stringify(body) });
    elements.fanqieRemoteOutput.textContent = JSON.stringify(result, null, 2);
    elements.fanqieRemoteState.textContent = result.ok ? '检查通过' : '需要处理';
    showToast(result.ok ? '番茄操作完成。' : '番茄检查发现需要处理的问题。', result.ok ? 'success' : 'warning');
  } catch (error) {
    elements.fanqieRemoteOutput.textContent = JSON.stringify(error.payload || { error: error.message }, null, 2);
    elements.fanqieRemoteState.textContent = '失败';
    showToast(error.message, 'error');
  } finally {
    setFanqieBusy(false);
    await refreshFanqieLocal({ quiet: true });
  }
}

// ============ Reconcile（预览/应用） ============
async function runReconcile(apply) {
  const stage = selectedStage('reconcile-stage') || 'all';
  const button = apply ? elements.reconcileApply : elements.reconcilePreview;
  if (apply) {
    const confirmed = window.confirm(`确定要应用 ${stage} 阶段的状态修复吗？这会改写状态文件。`);
    if (!confirmed) return;
  }
  button.disabled = true;
  elements.reconcileState.textContent = apply ? '正在应用…' : '正在预览…';
  elements.reconcileOutput.textContent = '执行中…';
  try {
    const payload = await api('/api/reconcile', {
      method: 'POST',
      body: JSON.stringify({ stage, apply }),
    });
    const result = payload.result;
    const stages = result?.stages || {};
    const lines = [];
    for (const [name, info] of Object.entries(stages)) {
      lines.push(`【${name}】stateExists=${info.stateExists ? '是' : '否'}, 变更 ${info.changes.length} 条`);
      for (const change of info.changes) {
        lines.push(`  - ${change.id}: ${change.field} ${change.from} → ${change.to}（${change.reason}）`);
      }
    }
    if (payload.after) renderStatus(payload.after);
    elements.reconcileOutput.textContent = lines.length ? lines.join('\n') : '没有差异。';
    elements.reconcileState.textContent = apply ? '已应用' : '已预览';
    showToast(apply ? '状态修复已应用。' : '预览完成。', apply ? 'success' : 'info');
  } catch (error) {
    elements.reconcileOutput.textContent = `失败：${error.message}`;
    elements.reconcileState.textContent = '失败';
    showToast(error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

// ============ 生成进度.md ============
async function runGenerateProgress() {
  elements.generateProgress.disabled = true;
  elements.progressState.textContent = '正在生成…';
  elements.progressOutput.textContent = '执行中…';
  try {
    const payload = await api('/api/progress', { method: 'POST', body: JSON.stringify({}) });
    const written = payload.result?.written || [];
    elements.progressOutput.textContent = written.length
      ? `已写入 ${written.length} 个进度文件：\n${written.join('\n')}`
      : '没有可写入的进度文件。';
    elements.progressState.textContent = '完成';
    showToast(`已生成 ${written.length} 个进度.md。`, 'success');
  } catch (error) {
    elements.progressOutput.textContent = `失败：${error.message}`;
    elements.progressState.textContent = '失败';
    showToast(error.message, 'error');
  } finally {
    elements.generateProgress.disabled = false;
  }
}

// ============ 书籍列表 ============
async function refreshBooks({ quiet = false } = {}) {
  elements.refreshBooks.disabled = true;
  if (!quiet) elements.booksMeta.textContent = '正在加载…';
  try {
    const data = await api('/api/books');
    elements.booksMeta.textContent = `${data.volumeMode ? '卷模式' : '扁平模式'} · ${data.books.length} 本书 · ${data.booksDir}`;
    elements.booksList.replaceChildren();
    if (data.books.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = '书籍目录为空。';
      elements.booksList.append(empty);
    } else {
      for (const book of data.books) {
        const card = document.createElement('div');
        card.className = 'book-card';
        const title = document.createElement('div');
        title.className = 'book-title';
        title.textContent = book.name;
        card.append(title);
        if (data.volumeMode) {
          for (const vol of book.volumes) {
            const volRow = document.createElement('div');
            volRow.className = 'volume-row';
            volRow.append(createVolLabel(vol.name), createCountChip('原文', vol.fileCounts?.原文 || 0), createCountChip('拆分', vol.fileCounts?.拆分 || 0), createCountChip('正文', vol.fileCounts?.正文 || 0));
            card.append(volRow);
          }
        } else {
          const counts = book.fileCounts || {};
          const row = document.createElement('div');
          row.className = 'volume-row';
          row.append(createCountChip('原文', counts.原文 || 0), createCountChip('拆分', counts.拆分 || 0), createCountChip('正文', counts.正文 || 0));
          card.append(row);
        }
        elements.booksList.append(card);
      }
    }
    elements.booksList.dataset.loaded = '1';
  } catch (error) {
    elements.booksMeta.textContent = `加载失败：${error.message}`;
    if (!quiet) showToast(error.message, 'error');
  } finally {
    elements.refreshBooks.disabled = false;
  }
}

function createVolLabel(name) {
  const span = document.createElement('span');
  span.className = 'vol-name';
  span.textContent = name;
  return span;
}

function createCountChip(label, count) {
  const chip = document.createElement('span');
  chip.className = `count-chip ${count > 0 ? 'chip-active' : 'chip-empty'}`;
  chip.textContent = `${label} ${count}`;
  return chip;
}

// ============ Normalize ============
async function runNormalize(apply) {
  const book = elements.normalizeBook.value.trim();
  const volume = elements.normalizeVolume.value.trim();
  if (!book) {
    showToast('请填写书名。', 'warning');
    return;
  }
  const button = apply ? elements.normalizeApply : elements.normalizePreview;
  if (apply) {
    const confirmed = window.confirm(`确定要执行 ${book}${volume ? '/' + volume : ''} 的章节编号补零吗？这会重命名源文件。`);
    if (!confirmed) return;
  }
  button.disabled = true;
  elements.normalizeState.textContent = apply ? '正在执行…' : '正在预览…';
  elements.normalizeOutput.textContent = '执行中…';
  try {
    const payload = await api('/api/normalize', {
      method: 'POST',
      body: JSON.stringify({ book, volume, apply }),
    });
    const result = payload.result;
    const lines = [
      `目录: ${result.dir}`,
      `改名 ${result.renamed} 个，跳过 ${result.skipped} 个，${result.applied ? '已执行' : '仅预览'}`,
    ];
    if (result.details?.length) {
      lines.push('', '改名明细（最多显示前 50 条）:');
      for (const item of result.details.slice(0, 50)) {
        lines.push(`  ${item.from} → ${item.to}`);
      }
      if (result.details.length > 50) lines.push(`  …还有 ${result.details.length - 50} 条`);
    }
    elements.normalizeOutput.textContent = lines.join('\n');
    elements.normalizeState.textContent = apply ? '已执行' : '已预览';
    showToast(apply ? `已重命名 ${result.renamed} 个文件。` : `预览完成，${result.renamed} 个待改名。`, apply ? 'success' : 'info');
  } catch (error) {
    elements.normalizeOutput.textContent = `失败：${error.message}`;
    elements.normalizeState.textContent = '失败';
    showToast(error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

// ============ Import ============
async function runImport(apply) {
  const source = elements.importSource.value.trim();
  if (!source) {
    showToast('请填写源目录。', 'warning');
    return;
  }
  const button = apply ? elements.importApply : elements.importPreview;
  if (apply) {
    const confirmed = window.confirm(`确定要从 ${source} 导入新书吗？这会复制文件到 书籍/ 目录。`);
    if (!confirmed) return;
  }
  button.disabled = true;
  elements.importState.textContent = apply ? '正在导入…' : '正在预览…';
  elements.importOutput.textContent = '执行中…';
  try {
    const payload = await api('/api/import', {
      method: 'POST',
      body: JSON.stringify({ source, apply }),
    });
    const result = payload.result;
    elements.importOutput.textContent = result.text || '（无输出）';
    elements.importState.textContent = apply ? '已导入' : '已预览';
    showToast(apply ? '导入完成。' : '预览完成。', apply ? 'success' : 'info');
    await refreshBooks({ quiet: true });
  } catch (error) {
    elements.importOutput.textContent = `失败：${error.message}`;
    elements.importState.textContent = '失败';
    showToast(error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

// ============ Preview Volumes ============
async function runPreviewVolumes() {
  const source = elements.previewVolSource.value.trim();
  if (!source) {
    showToast('请填写源目录。', 'warning');
    return;
  }
  elements.previewVolRun.disabled = true;
  elements.previewVolState.textContent = '正在生成…';
  elements.previewVolOutput.textContent = '执行中…';
  try {
    const payload = await api('/api/preview-volumes', {
      method: 'POST',
      body: JSON.stringify({ source }),
    });
    const result = payload.result;
    elements.previewVolOutput.textContent = result.text || '（无输出）';
    elements.previewVolState.textContent = '完成';
    showToast('分卷预览报告已生成。', 'success');
  } catch (error) {
    elements.previewVolOutput.textContent = `失败：${error.message}`;
    elements.previewVolState.textContent = '失败';
    showToast(error.message, 'error');
  } finally {
    elements.previewVolRun.disabled = false;
  }
}

// ============ 配置编辑器 ============
async function loadConfig() {
  const stage = elements.configStage.value;
  elements.loadConfig.disabled = true;
  elements.configMeta.textContent = '正在加载…';
  elements.configError.hidden = true;
  try {
    const data = await api(`/api/config?stage=${encodeURIComponent(stage)}`);
    elements.configEditor.value = JSON.stringify(data.config, null, 2);
    elements.configMeta.textContent = `${data.file} · 加载于 ${formatTime(new Date().toISOString())}`;
    elements.configEditor.dataset.loaded = '1';
  } catch (error) {
    elements.configMeta.textContent = `加载失败：${error.message}`;
    showToast(error.message, 'error');
  } finally {
    elements.loadConfig.disabled = false;
  }
}

async function saveConfig() {
  const stage = elements.configStage.value;
  let parsed;
  try {
    parsed = JSON.parse(elements.configEditor.value);
  } catch (error) {
    elements.configError.textContent = `JSON 解析失败：${error.message}`;
    elements.configError.hidden = false;
    return;
  }
  elements.configError.hidden = true;
  elements.saveConfig.disabled = true;
  elements.configMeta.textContent = '正在保存…';
  try {
    const payload = await api('/api/config', {
      method: 'POST',
      body: JSON.stringify({ stage, config: parsed }),
    });
    elements.configMeta.textContent = `${payload.file} · 保存于 ${formatTime(new Date().toISOString())}`;
    showToast('配置已保存。', 'success');
    await refreshStatus({ quiet: true });
  } catch (error) {
    elements.configError.textContent = error.message;
    elements.configError.hidden = false;
    elements.configMeta.textContent = '保存失败';
    showToast(error.message, 'error');
  } finally {
    elements.saveConfig.disabled = false;
  }
}

// ============ 预检 ============
async function runPreflight() {
  elements.preflight.disabled = true;
  elements.preflight.textContent = '检查中…';
  elements.preflightSummary.textContent = '正在检查 Chrome、登录态、配置、输入文件和队列锁。';
  elements.preflightList.replaceChildren();
  try {
    const result = await api('/api/preflight');
    elements.preflightSummary.textContent = result.summary || (result.ok ? '全部通过' : '存在未通过项目');
    for (const check of result.checks || []) {
      const item = document.createElement('li');
      item.className = check.ok ? 'check-ok' : 'check-fail';
      const icon = document.createElement('span');
      icon.className = 'check-icon';
      icon.textContent = check.ok ? '✓' : '!';
      const copy = document.createElement('div');
      const name = document.createElement('strong');
      const detail = document.createElement('p');
      name.textContent = check.name || '未命名检查';
      detail.textContent = check.detail || '';
      copy.append(name, detail);
      item.append(icon, copy);
      elements.preflightList.append(item);
    }
    showToast(result.ok ? '预检已全部通过。' : '预检发现需要处理的项目。', result.ok ? 'success' : 'warning');
  } catch (error) {
    elements.preflightSummary.textContent = `预检失败：${error.message}`;
    showToast(error.message, 'error');
  } finally {
    elements.preflight.disabled = false;
    elements.preflight.textContent = '立即预检';
  }
}

// ============ 日志 ============
async function refreshLogs({ quiet = false } = {}) {
  const stage = elements.logStage.value;
  elements.refreshLogs.disabled = true;
  if (!quiet) elements.logMeta.textContent = '正在读取日志…';
  try {
    const result = await api(`/api/logs?stage=${encodeURIComponent(stage)}`);
    const size = new Intl.NumberFormat('zh-CN').format(result.size || 0);
    elements.logMeta.textContent = `${result.logFile} · ${size} 字节${result.truncated ? ' · 仅显示最后 200KB' : ''}`;
    elements.logOutput.textContent = result.text || '暂无日志。';
    elements.logOutput.scrollTop = elements.logOutput.scrollHeight;
  } catch (error) {
    elements.logMeta.textContent = `日志读取失败：${error.message}`;
    if (!quiet) showToast(error.message, 'error');
  } finally {
    elements.refreshLogs.disabled = false;
  }
}

// ============ 绑定事件 ============
function setupEventListeners() {
  elements.refreshStatus.addEventListener('click', () => refreshStatus());
  elements.start.addEventListener('click', () => runAction('start'));
  elements.resume.addEventListener('click', () => runAction('resume'));
  elements.stop.addEventListener('click', () => runAction('stop'));
  elements.preflight.addEventListener('click', runPreflight);
  elements.refreshLogs.addEventListener('click', () => refreshLogs());
  elements.logStage.addEventListener('change', () => refreshLogs());

  elements.launchChrome.addEventListener('click', launchChrome);
  elements.fanqieRefreshLocal.addEventListener('click', () => refreshFanqieLocal());
  elements.fanqieLaunchChrome.addEventListener('click', launchFanqieChrome);
  elements.fanqieRemoteStatus.addEventListener('click', () => runFanqieCommand('status'));
  elements.fanqieUploadPreview.addEventListener('click', () => runFanqieCommand('upload'));
  elements.fanqieReconcilePreview.addEventListener('click', () => runFanqieCommand('reconcile'));
  elements.fanqieReconcileApply.addEventListener('click', () => runFanqieCommand('reconcile', true));
  elements.fanqieUploadApply.addEventListener('click', () => runFanqieCommand('upload', true));
  elements.materialRefresh.addEventListener('click', () => refreshMaterialStatus());
  elements.materialIndex.addEventListener('click', rebuildMaterialIndex);
  elements.materialSearch.addEventListener('click', searchMaterials);
  elements.materialQuery.addEventListener('keydown', (event) => { if (event.key === 'Enter') searchMaterials(); });
  elements.materialImportPreview.addEventListener('click', () => importSelectedMaterial(false));
  elements.materialImportApply.addEventListener('click', () => importSelectedMaterial(true));
  elements.reconcilePreview.addEventListener('click', () => runReconcile(false));
  elements.reconcileApply.addEventListener('click', () => runReconcile(true));
  elements.generateProgress.addEventListener('click', runGenerateProgress);

  elements.refreshBooks.addEventListener('click', () => refreshBooks());
  elements.normalizePreview.addEventListener('click', () => runNormalize(false));
  elements.normalizeApply.addEventListener('click', () => runNormalize(true));
  elements.importPreview.addEventListener('click', () => runImport(false));
  elements.importApply.addEventListener('click', () => runImport(true));
  elements.previewVolRun.addEventListener('click', runPreviewVolumes);

  elements.loadConfig.addEventListener('click', () => loadConfig());
  elements.saveConfig.addEventListener('click', () => saveConfig());
  elements.configStage.addEventListener('change', () => loadConfig().catch(() => {}));
}

setupTabs();
setupEventListeners();
refreshStatus();
refreshLogs({ quiet: true });

// 动态轮询：页面可见时轮询，隐藏时暂停；上一次未完成不发新请求
let pollTimer = null;
function schedulePoll() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    pollTimer = null;
    if (document.visibilityState === 'visible' && !statusLoading) {
      await refreshStatus({ quiet: true });
    }
    schedulePoll();
  }, 5000);
}
schedulePoll();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !pollTimer) schedulePoll();
});
