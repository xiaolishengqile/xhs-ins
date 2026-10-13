const elements = {
  form: document.querySelector("#task-form"),
  urlInput: document.querySelector("#profile-url"),
  preset: document.querySelector("#range-preset"),
  customRange: document.querySelector("#custom-range"),
  dateFrom: document.querySelector("#date-from"),
  dateTo: document.querySelector("#date-to"),
  message: document.querySelector("#form-message"),
  taskList: document.querySelector("#task-list"),
  emptyState: document.querySelector("#empty-state"),
  refreshStatus: document.querySelector("#refresh-status"),
  schedulerStatus: document.querySelector("#scheduler-status"),
  attentionStatus: document.querySelector("#attention-status"),
  pauseAll: document.querySelector("#pause-all"),
  openOutput: document.querySelector("#open-output"),
  bulkActions: document.querySelector("#bulk-actions"),
  selectAll: document.querySelector("#select-all-tasks"),
  selectionCount: document.querySelector("#selection-count"),
  startSelected: document.querySelector("#start-selected"),
  updateSelected: document.querySelector("#update-selected"),
  recollectSelected: document.querySelector("#recollect-selected"),
  taskSearch: document.querySelector("#task-search"),
  statusFilter: document.querySelector("#status-filter"),
  platformFilter: document.querySelector("#platform-filter"),
  emptyTitle: document.querySelector("#empty-state span"),
  emptyMessage: document.querySelector("#empty-state p"),
  deleteSelected: document.querySelector("#delete-selected"),
  linkFile: document.querySelector("#link-file"),
  importLinks: document.querySelector("#import-links"),
  loadBuiltin: document.querySelector("#load-builtin"),
  pagination: document.querySelector("#pagination"),
  pageLabel: document.querySelector("#page-label"),
  previousPage: document.querySelector("#previous-page"),
  nextPage: document.querySelector("#next-page"),
};

const STATUS = {
  pending: "待开始",
  queued: "等待中",
  running: "运行中",
  paused: "已暂停",
  waiting_user: "等待人工处理",
  blocked: "运行环境受阻",
  completed: "已完成",
  partial: "部分完成",
  failed: "失败",
  cancelled: "已取消",
};

let currentTasks = [];
let currentControl = { paused: false, maxConcurrency: 1 };
let currentPage = 0;
const PAGE_SIZE = 30;
let refreshPromise = null;
let refreshAgain = false;
let lastRefreshAt = 0;
let hasActiveTasks = false;
let controlBusy = false;
let bulkBusy = false;
let inputSource = "manual";
let settingInput = false;
const selectedTaskIds = new Set();

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

async function request(url, options) {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "请求失败");
  return body;
}

function setInput(urls, source) {
  settingInput = true;
  elements.urlInput.value = urls.join("\n");
  settingInput = false;
  inputSource = source;
}

function inputUrls() {
  return [...new Set(elements.urlInput.value.split(/[\r\n,，]+/).map((value) => value.trim()).filter(Boolean))];
}

function formatInputDate(date) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function fillPresetDates(preset) {
  const months = { month: 1, halfYear: 6, year: 12 };
  if (!months[preset] && preset !== "week") return;
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  const to = new Date(from);
  if (preset === "week") from.setDate(from.getDate() - 6);
  else {
    const originalDay = from.getDate();
    from.setDate(1);
    from.setMonth(from.getMonth() - months[preset]);
    const lastDay = new Date(from.getFullYear(), from.getMonth() + 1, 0).getDate();
    from.setDate(Math.min(originalDay, lastDay));
  }
  elements.dateFrom.value = formatInputDate(from);
  elements.dateTo.value = formatInputDate(to);
}

function selectedRange() {
  return {
    preset: "custom",
    from: elements.dateFrom.value,
    to: elements.dateTo.value,
  };
}

function formatDate(value) {
  return value
    ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(new Date(value))
    : "未知";
}

function actionButton(task, action, label) {
  const button = node("button", "task-action", label);
  button.type = "button";
  button.dataset.action = action;
  button.dataset.id = task.id;
  if (currentControl.storageError && ["start", "retry", "update", "recollect", "resume", "recover"].includes(action)) {
    button.disabled = true;
  }
  return button;
}

function renderTask(task) {
  const card = node("article", "task-card");
  card.dataset.taskId = task.id;
  card.dataset.status = task.status;
  const top = node("div", "task-top");
  const identity = node("div", "task-identity");
  const checkbox = node("input", "task-select");
  checkbox.type = "checkbox";
  checkbox.checked = selectedTaskIds.has(task.id);
  checkbox.dataset.taskSelect = task.id;
  checkbox.setAttribute("aria-label", `选择任务 ${task.author || task.profileKey}`);
  identity.append(checkbox, node("span", "task-platform", task.platform === "xiaohongshu" ? "小红书" : "Instagram"));
  top.append(identity, node("span", "status-pill", STATUS[task.status] ?? task.status));
  const heading = node("div", "task-heading");
  heading.append(node("h3", "task-title", task.author || task.profileKey));
  if (task.profileUrl) {
    const link = node("a", "task-link", task.profileUrl);
    link.href = task.profileUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    heading.append(link);
  }
  card.append(top, heading);
  const current = task.progress?.current ?? 0;
  const total = task.progress?.total ?? 0;
  const stage = task.progress?.stage || STATUS[task.status] || "等待";
  const rangeFrom = task.status === "pending" && elements.dateFrom.value ? elements.dateFrom.value : task.from;
  const rangeTo = task.status === "pending" && elements.dateTo.value ? elements.dateTo.value : task.to;
  const range = node("p", "task-range", `${formatDate(rangeFrom)} — ${formatDate(rangeTo)} · `);
  range.append(node("span", "", stage));
  if (total) range.append(` ${current}/${total}`);
  card.append(range);
  if (total > 0 || task.status === "running") {
    const track = node("div", "progress-track");
    const bar = node("div", "progress-bar");
    const ratio = total > 0 ? Math.min(100, current / total * 100) : 8;
    bar.style.width = task.status === "completed" ? "100%" : `${ratio}%`;
    track.append(bar);
    card.append(track);
  }
  const previewImages = task.progress?.previewImages ?? 0;
  if (previewImages > 0) {
    card.append(node("p", "task-warning", `${previewImages} 张图片仅获得平台预览尺寸`));
  }
  if (task.progress?.imagesAvailable !== undefined) {
    const excluded = task.progress.imagesExcluded ? ` · 已删除不再下载 ${task.progress.imagesExcluded} 张` : "";
    card.append(node("p", "task-image-summary", `已保存 ${task.progress.imagesAvailable} 张 · 失败 ${task.progress.imagesFailed ?? 0} 张 · 复用 ${task.progress.imagesSkipped ?? 0} 张${excluded}`));
  }
  if (task.progress?.imagesUpgradeFailed > 0) {
    card.append(node("p", "task-warning", `${task.progress.imagesUpgradeFailed} 张高清升级失败，已保留原图`));
  }
  if (task.error) card.append(node("p", "task-error", task.error));

  const actions = node("div", "task-actions");
  if (task.status === "pending") actions.append(actionButton(task, "start", "开始"));
  if (["queued", "running", "paused", "waiting_user", "blocked"].includes(task.status)) {
    actions.append(actionButton(task, "cancel", "取消"));
  }
  if (["failed", "cancelled"].includes(task.status)) actions.append(actionButton(task, "retry", "重试"));
  if (task.status === "partial") actions.append(actionButton(task, "retry", "补采失败图片"));
  if (["completed", "partial"].includes(task.status)) actions.append(actionButton(task, "update", "采集新增"));
  if (task.status === "waiting_user") {
    actions.append(actionButton(task, "login", "打开登录窗口"));
    actions.append(actionButton(task, "resume", "我已处理，继续"));
  }
  if (task.status === "blocked" && task.blockReason === "browser") {
    actions.append(actionButton(task, "recover", "重新检测并继续"));
  }
  if (task.status !== "pending") actions.append(actionButton(task, "recollect", "重新采集"));
  const remove = actionButton(task, "delete", "删除");
  remove.classList.add("task-action-danger");
  actions.append(remove);
  card.append(actions);
  return card;
}

const STATUS_FILTERS = {
  pending: ["pending"],
  active: ["queued", "running", "paused"],
  completed: ["completed"],
  partial: ["partial"],
  failed: ["failed", "cancelled"],
  attention: ["failed", "partial", "waiting_user", "blocked"],
};

function filteredTasks() {
  const query = elements.taskSearch.value.trim().toLowerCase();
  const statuses = STATUS_FILTERS[elements.statusFilter.value];
  const platform = elements.platformFilter.value;
  return currentTasks.filter((task) => (!statuses || statuses.includes(task.status))
    && (platform === "all" || task.platform === platform)
    && (!query || [task.author, task.profileKey, task.profileUrl].some((value) => String(value ?? "").toLowerCase().includes(query))));
}

function updateBulkActions() {
  const shown = filteredTasks();
  const selected = currentTasks.filter((task) => selectedTaskIds.has(task.id));
  const shownSelected = shown.filter((task) => selectedTaskIds.has(task.id)).length;
  const pendingCount = selected.filter((task) => task.status === "pending").length;
  const updateCount = selected.filter((task) => ["completed", "partial"].includes(task.status)).length;
  const schedulingBlocked = bulkBusy || currentControl.paused || Boolean(currentControl.storageError);
  elements.bulkActions.hidden = currentTasks.length === 0;
  elements.selectAll.checked = shown.length > 0 && shownSelected === shown.length;
  elements.selectAll.indeterminate = shownSelected > 0 && shownSelected < shown.length;
  elements.selectionCount.textContent = `已选 ${selected.length} 项`;
  elements.startSelected.textContent = `开始选中（${pendingCount}）`;
  elements.startSelected.disabled = schedulingBlocked || pendingCount === 0;
  elements.updateSelected.textContent = `采集新增（${updateCount}）`;
  elements.updateSelected.disabled = schedulingBlocked || updateCount === 0;
  elements.recollectSelected.textContent = `重新采集（${selected.length}）`;
  elements.recollectSelected.disabled = schedulingBlocked || selected.length === 0;
  elements.deleteSelected.textContent = `删除选中（${selected.length}）`;
  elements.deleteSelected.disabled = bulkBusy || selected.length === 0;
}

function render(tasks, control = currentControl) {
  currentTasks = tasks;
  currentControl = control;
  const availableIds = new Set(tasks.map((task) => task.id));
  for (const id of selectedTaskIds) if (!availableIds.has(id)) selectedTaskIds.delete(id);
  hasActiveTasks = tasks.some((task) => ["queued", "running"].includes(task.status));
  for (const status of ["pending", "queued", "completed", "paused"]) {
    document.querySelector(`#${status}-summary`).textContent = String(tasks.filter((task) => task.status === status).length);
  }
  const running = tasks.filter((task) => task.status === "running").length;
  document.querySelector('[data-testid="running-summary"]').textContent = `${running} / ${control.maxConcurrency ?? 1}`;
  const attention = tasks.filter((task) => ["failed", "partial", "waiting_user", "blocked"].includes(task.status)).length;
  const coolingPlatforms = Object.keys(control.cooldowns ?? {});
  const browserBlocked = (control.platformBlocks ?? []).some((block) => block.reason === "browser");
  const schedulerText = control.storageError
    ? `存储故障：${control.storageError}`
    : control.paused
    ? "队列已暂停"
    : browserBlocked
      ? "浏览器运行环境受阻"
      : coolingPlatforms.includes("instagram")
      ? "照片墙平台冷却中"
      : coolingPlatforms.length > 0
        ? "部分平台冷却中"
        : control.throttleWait?.reason === "daily"
          ? "今日已达采集上限，明天自动继续"
          : control.throttleWait?.reason === "gap"
            ? `博主间隔等待中，${new Date(control.throttleWait.until).toLocaleTimeString("zh-CN", { hour12: false })} 开始下一个`
            : "正常调度";
  elements.schedulerStatus.textContent = schedulerText;
  elements.attentionStatus.hidden = attention === 0;
  elements.attentionStatus.textContent = `需处理 ${attention}`;
  elements.schedulerStatus.classList.toggle("is-paused", Boolean(control.storageError) || control.paused || browserBlocked || coolingPlatforms.length > 0);
  elements.pauseAll.textContent = control.storageError ? "重试保存并继续" : control.paused ? "继续全部" : "暂停全部";
  elements.pauseAll.disabled = controlBusy;
  const shown = filteredTasks();
  const filtering = shown.length !== tasks.length;
  elements.emptyState.hidden = shown.length > 0;
  elements.emptyTitle.textContent = tasks.length > 0 ? "没有匹配的任务" : "还没有任务";
  elements.emptyMessage.textContent = tasks.length > 0
    ? "没有符合筛选条件的任务。"
    : "在上方整理链接并加入待采集，然后手动开始任务。";
  const pages = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
  currentPage = Math.min(currentPage, pages - 1);
  elements.pagination.hidden = shown.length <= PAGE_SIZE;
  elements.pageLabel.textContent = `第 ${currentPage + 1} / ${pages} 页，共 ${shown.length} 项${filtering ? `（全部 ${tasks.length} 项）` : ""}`;
  elements.previousPage.disabled = currentPage === 0;
  elements.nextPage.disabled = currentPage === pages - 1;
  const visible = shown.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const existing = new Map([...elements.taskList.children].map((card) => [card.dataset.taskId, card]));
  elements.taskList.replaceChildren(...visible.map((task) => {
    const signature = JSON.stringify([
      task,
      selectedTaskIds.has(task.id),
      Boolean(control.storageError),
      task.status === "pending" ? `${elements.dateFrom.value}|${elements.dateTo.value}` : "",
    ]);
    const card = existing.get(task.id);
    if (card?.dataset.signature === signature) return card;
    const next = renderTask(task);
    next.dataset.signature = signature;
    return next;
  }));
  updateBulkActions();
}

function refresh() {
  if (refreshPromise) {
    refreshAgain = true;
    return refreshPromise;
  }
  lastRefreshAt = Date.now();
  refreshPromise = (async () => {
    do {
      refreshAgain = false;
      try {
        const [taskResult, control] = await Promise.all([request("/api/tasks"), request("/api/control")]);
        render(taskResult.tasks, control);
        elements.refreshStatus.textContent = `已更新 ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`;
      } catch (error) {
        elements.refreshStatus.textContent = error.message;
      }
    } while (refreshAgain);
  })().finally(() => { refreshPromise = null; });
  return refreshPromise;
}

elements.urlInput.addEventListener("input", () => {
  if (!settingInput) inputSource = "manual";
});

elements.previousPage.addEventListener("click", () => { currentPage -= 1; render(currentTasks); });
elements.nextPage.addEventListener("click", () => { currentPage += 1; render(currentTasks); });
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refresh();
});

elements.preset.addEventListener("change", () => {
  fillPresetDates(elements.preset.value);
  if (currentTasks.length) render(currentTasks);
});
for (const input of [elements.dateFrom, elements.dateTo]) {
  input.addEventListener("change", () => {
    elements.preset.value = "custom";
    if (currentTasks.length) render(currentTasks);
  });
}

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = elements.form.querySelector('button[type="submit"]');
  const urls = inputUrls();
  if (urls.length === 0) {
    elements.message.textContent = "请至少输入一条博主主页链接";
    return;
  }
  if (inputSource !== "builtin" && urls.length > 500) {
    elements.message.textContent = "手动输入或文件导入一次最多 500 个唯一链接";
    return;
  }
  const batchSize = inputSource === "builtin" ? 500 : urls.length;
  const batches = [];
  for (let index = 0; index < urls.length; index += batchSize) batches.push(urls.slice(index, index + batchSize));
  submit.disabled = true;
  elements.message.textContent = `正在创建 ${urls.length} 个待开始任务…`;
  try {
    let created = 0;
    let rejected = 0;
    let duplicates = 0;
    for (const batch of batches) {
      const result = await request("/api/tasks/batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          entries: batch.map((url, index) => ({ line: index + 1, url })),
          range: selectedRange(),
        }),
      });
      created += result.tasks.length;
      rejected += result.rejected.length;
      duplicates += result.duplicates;
    }
    setInput([], "manual");
    elements.message.textContent = `已创建 ${created} 个待开始任务，跳过 ${rejected} 个无效链接和 ${duplicates} 个重复或已在列表中的博主。`;
    await refresh();
  } catch (error) {
    elements.message.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

elements.importLinks.addEventListener("click", async () => {
  const file = elements.linkFile.files?.[0];
  if (!file) {
    elements.message.textContent = "请选择链接文件";
    return;
  }
  elements.importLinks.disabled = true;
  elements.message.textContent = "正在解析文件…";
  try {
    const parsed = await request("/api/link-files/parse", {
      method: "POST",
      headers: {
        "content-type": file.type || "application/octet-stream",
        "x-file-name": encodeURIComponent(file.name),
      },
      body: await file.arrayBuffer(),
    });
    const urls = parsed.entries.map((entry) => entry.url);
    setInput(urls, "import");
    elements.message.textContent = urls.length
      ? `已导入 ${urls.length} 条链接，请确认后加入待采集。`
      : "文件中没有找到链接";
  } catch (error) {
    elements.message.textContent = error.message;
  } finally {
    elements.importLinks.disabled = false;
  }
});

elements.loadBuiltin.addEventListener("click", async () => {
  elements.loadBuiltin.disabled = true;
  elements.message.textContent = "正在加载内置博主…";
  try {
    const result = await request("/api/profiles/builtin");
    setInput(result.profiles, "builtin");
    elements.message.textContent = `已加载 ${result.profiles.length} 位内置博主，请确认后加入待采集。`;
  } catch (error) {
    elements.message.textContent = error.message;
  } finally {
    elements.loadBuiltin.disabled = false;
  }
});

elements.pauseAll.addEventListener("click", async () => {
  if (controlBusy) return;
  controlBusy = true;
  try {
    const action = currentControl.paused || currentControl.storageError ? "resume" : "pause";
    currentControl = await request(`/api/control/${action}`, { method: "POST" });
    elements.message.textContent = currentControl.paused
      ? "已暂停所有运行和排队任务，应用浏览器已关闭。"
      : "已恢复暂停任务。";
    await refresh();
  } catch (error) {
    elements.message.textContent = error.message;
  } finally {
    controlBusy = false;
  }
});

elements.openOutput.addEventListener("click", async () => {
  try {
    const result = await request("/api/output/open", { method: "POST" });
    elements.message.textContent = `已打开图片文件夹：${result.directory}`;
  } catch (error) {
    elements.message.textContent = error.message;
  }
});

elements.taskList.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const { action, id } = button.dataset;
  if (action === "delete" && !window.confirm("确定删除任务记录吗？不会删除已经保存到图片文件夹的图片。")) return;
  if (action === "recollect") {
    const task = currentTasks.find((item) => item.id === id);
    const range = `${elements.dateFrom.value} 至 ${elements.dateTo.value}`;
    const running = ["running", "queued"].includes(task?.status) ? "会先停止当前采集，" : "";
    if (!window.confirm(`${running}按 ${range} 重新扫描这个博主的主页？已保存的图片不会重复下载。`)) return;
  }
  button.disabled = true;
  try {
    if (action === "delete") await request(`/api/tasks/${id}`, { method: "DELETE" });
    else if (["start", "update", "recollect"].includes(action)) {
      await request(`/api/tasks/${id}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ range: selectedRange() }),
      });
    } else await request(`/api/tasks/${id}/${action}`, { method: "POST" });
    elements.message.textContent = action === "login"
      ? "登录窗口已打开，处理完成后点击“我已处理，继续”。"
      : action === "recover"
        ? "已重新检测浏览器并恢复该平台任务。"
        : action === "recollect"
          ? "已加入重新采集队列。"
          : "操作已完成。";
    await refresh();
  } catch (error) {
    elements.message.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

elements.taskList.addEventListener("change", (event) => {
  const checkbox = event.target.closest("input[data-task-select]");
  if (!checkbox) return;
  if (checkbox.checked) selectedTaskIds.add(checkbox.dataset.taskSelect);
  else selectedTaskIds.delete(checkbox.dataset.taskSelect);
  updateBulkActions();
});

elements.selectAll.addEventListener("change", () => {
  for (const task of filteredTasks()) {
    if (elements.selectAll.checked) selectedTaskIds.add(task.id);
    else selectedTaskIds.delete(task.id);
  }
  for (const checkbox of elements.taskList.querySelectorAll("input[data-task-select]")) {
    checkbox.checked = selectedTaskIds.has(checkbox.dataset.taskSelect);
  }
  updateBulkActions();
});

for (const control of [elements.taskSearch, elements.statusFilter, elements.platformFilter]) {
  control.addEventListener(control === elements.taskSearch ? "input" : "change", () => {
    currentPage = 0;
    render(currentTasks);
  });
}

for (const [button, action, label] of [
  [elements.updateSelected, "update", "采集新增"],
  [elements.recollectSelected, "recollect", "重新采集"],
]) {
  button.addEventListener("click", async () => {
    const ids = currentTasks
      .filter((task) => selectedTaskIds.has(task.id) && (action !== "update" || ["completed", "partial"].includes(task.status)))
      .map((task) => task.id);
    if (ids.length === 0 || bulkBusy) return;
    const range = `${elements.dateFrom.value} 至 ${elements.dateTo.value}`;
    const running = action === "recollect" && currentTasks.some((task) => ids.includes(task.id) && ["running", "queued"].includes(task.status))
      ? "其中正在运行的任务会先停止，"
      : "";
    if (!window.confirm(`按 ${range} 对 ${ids.length} 个博主${label}？${running}已保存的图片不会重复下载。`)) return;
    bulkBusy = true;
    updateBulkActions();
    try {
      const result = await request(`/api/tasks/${action}-batch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids, range: selectedRange() }),
      });
      elements.message.textContent = `已加入${label}队列 ${result.started.length} 个${result.skipped.length ? `，跳过 ${result.skipped.length} 个` : ""}。`;
      await refresh();
    } catch (error) {
      elements.message.textContent = error.message;
    } finally {
      bulkBusy = false;
      updateBulkActions();
    }
  });
}

elements.startSelected.addEventListener("click", async () => {
  const ids = currentTasks
    .filter((task) => selectedTaskIds.has(task.id) && task.status === "pending")
    .map((task) => task.id);
  if (ids.length === 0 || bulkBusy) return;
  bulkBusy = true;
  updateBulkActions();
  try {
    const result = await request("/api/tasks/start-batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids, range: selectedRange() }),
    });
    elements.message.textContent = `已启动 ${result.started.length} 个任务。`;
    await refresh();
  } catch (error) {
    elements.message.textContent = error.message;
  } finally {
    bulkBusy = false;
    updateBulkActions();
  }
});

elements.deleteSelected.addEventListener("click", async () => {
  const ids = [...selectedTaskIds];
  if (ids.length === 0 || bulkBusy) return;
  if (!window.confirm(`确定删除选中的 ${ids.length} 个任务吗？不会删除已经保存到图片文件夹的图片。`)) return;
  bulkBusy = true;
  updateBulkActions();
  try {
    const results = await Promise.allSettled(ids.map((id) => request(`/api/tasks/${id}`, { method: "DELETE" })));
    results.forEach((result, index) => {
      if (result.status === "fulfilled") selectedTaskIds.delete(ids[index]);
    });
    const failed = results.filter((result) => result.status === "rejected").length;
    elements.message.textContent = `已删除 ${ids.length - failed} 个任务${failed ? `，${failed} 个删除失败` : ""}。`;
    await refresh();
  } finally {
    bulkBusy = false;
    updateBulkActions();
  }
});

document.addEventListener("settings-changed", (event) => {
  elements.preset.value = event.detail.preset;
  elements.preset.dispatchEvent(new Event("change"));
});
try {
  const settings = await request("/api/settings");
  elements.preset.value = settings.preset;
} catch { /* 设置不可用时沿用页面默认的一年。 */ }
fillPresetDates(elements.preset.value);
await refresh();
setInterval(() => {
  if (document.visibilityState !== "visible" || refreshPromise) return;
  const interval = hasActiveTasks ? 3_000 : 15_000;
  if (Date.now() - lastRefreshAt >= interval) refresh();
}, 3_000);
