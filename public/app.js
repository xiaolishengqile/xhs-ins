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
  pauseAll: document.querySelector("#pause-all"),
  openOutput: document.querySelector("#open-output"),
  bulkActions: document.querySelector("#bulk-actions"),
  selectAll: document.querySelector("#select-all-tasks"),
  selectionCount: document.querySelector("#selection-count"),
  startSelected: document.querySelector("#start-selected"),
  deleteSelected: document.querySelector("#delete-selected"),
  linkFile: document.querySelector("#link-file"),
  importLinks: document.querySelector("#import-links"),
  loadBuiltin: document.querySelector("#load-builtin"),
};

const STATUS = {
  pending: "待开始",
  queued: "等待中",
  running: "运行中",
  paused: "已暂停",
  waiting_user: "等待人工处理",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

let currentTasks = [];
let currentControl = { paused: false, maxConcurrency: 5 };
let refreshPromise = null;
let refreshAgain = false;
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

function selectedRange() {
  const range = { preset: elements.preset.value };
  if (range.preset === "custom") Object.assign(range, {
    from: elements.dateFrom.value,
    to: elements.dateTo.value,
  });
  return range;
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
  card.append(top, node("h3", "task-title", task.author || task.profileKey));
  card.append(node("p", "task-range", `${formatDate(task.from)} — ${formatDate(task.to)}`));

  const progress = node("div", "task-progress");
  const progressLabel = node("div", "task-progress-label");
  const current = task.progress?.current ?? 0;
  const total = task.progress?.total ?? 0;
  progressLabel.append(
    node("span", "", task.progress?.stage || STATUS[task.status] || "等待"),
    node("span", "", total ? `${current} / ${total}` : String(current)),
  );
  const track = node("div", "progress-track");
  const bar = node("div", "progress-bar");
  bar.style.width = task.status === "completed" ? "100%" : total ? `${Math.min(100, current / total * 100)}%` : "0%";
  track.append(bar);
  progress.append(progressLabel, track);
  card.append(progress);
  const previewImages = task.progress?.previewImages ?? 0;
  if (previewImages > 0) {
    card.append(node("p", "task-warning", `${previewImages} 张图片仅获得平台预览尺寸`));
  }
  if (task.error) card.append(node("p", "task-error", task.error));

  const actions = node("div", "task-actions");
  if (task.status === "pending") actions.append(actionButton(task, "start", "开始"));
  if (["queued", "running", "paused", "waiting_user"].includes(task.status)) {
    actions.append(actionButton(task, "cancel", "取消"));
  }
  if (["failed", "cancelled"].includes(task.status)) actions.append(actionButton(task, "retry", "重试"));
  if (task.status === "waiting_user") {
    actions.append(actionButton(task, "login", "打开登录窗口"));
    actions.append(actionButton(task, "resume", "我已处理，继续"));
  }
  const remove = actionButton(task, "delete", "删除");
  remove.classList.add("task-action-danger");
  actions.append(remove);
  card.append(actions);
  return card;
}

function updateBulkActions() {
  const selected = currentTasks.filter((task) => selectedTaskIds.has(task.id));
  const pendingCount = selected.filter((task) => task.status === "pending").length;
  elements.bulkActions.hidden = currentTasks.length === 0;
  elements.selectAll.checked = currentTasks.length > 0 && selected.length === currentTasks.length;
  elements.selectAll.indeterminate = selected.length > 0 && selected.length < currentTasks.length;
  elements.selectionCount.textContent = `已选 ${selected.length} 项`;
  elements.startSelected.textContent = `开始选中（${pendingCount}）`;
  elements.startSelected.disabled = bulkBusy || currentControl.paused || pendingCount === 0;
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
  document.querySelector('[data-testid="running-summary"]').textContent = `${running} / ${control.maxConcurrency ?? 5}`;
  const coolingPlatforms = Object.keys(control.cooldowns ?? {});
  const schedulerText = control.paused
    ? "队列已暂停"
    : coolingPlatforms.includes("instagram")
      ? "照片墙平台冷却中"
      : coolingPlatforms.length > 0
        ? "部分平台冷却中"
        : "正常调度";
  elements.schedulerStatus.textContent = schedulerText;
  elements.schedulerStatus.classList.toggle("is-paused", control.paused || coolingPlatforms.length > 0);
  elements.pauseAll.textContent = control.paused ? "继续全部" : "暂停全部";
  elements.pauseAll.disabled = controlBusy;
  elements.emptyState.hidden = tasks.length > 0;
  elements.taskList.replaceChildren(...tasks.map(renderTask));
  updateBulkActions();
}

function refresh() {
  if (refreshPromise) {
    refreshAgain = true;
    return refreshPromise;
  }
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

elements.preset.addEventListener("change", () => {
  const custom = elements.preset.value === "custom";
  elements.customRange.hidden = !custom;
  elements.dateFrom.required = custom;
  elements.dateTo.required = custom;
});

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
    elements.message.textContent = `已创建 ${created} 个待开始任务，跳过 ${rejected} 个无效链接和 ${duplicates} 个重复链接。`;
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
    const action = currentControl.paused ? "resume" : "pause";
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
  button.disabled = true;
  try {
    if (action === "delete") await request(`/api/tasks/${id}`, { method: "DELETE" });
    else await request(`/api/tasks/${id}/${action}`, { method: "POST" });
    elements.message.textContent = action === "login" ? "登录窗口已打开，处理完成后点击“我已处理，继续”。" : "操作已完成。";
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
  selectedTaskIds.clear();
  if (elements.selectAll.checked) for (const task of currentTasks) selectedTaskIds.add(task.id);
  for (const checkbox of elements.taskList.querySelectorAll("input[data-task-select]")) {
    checkbox.checked = selectedTaskIds.has(checkbox.dataset.taskSelect);
  }
  updateBulkActions();
});

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
      body: JSON.stringify({ ids }),
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

await refresh();
setInterval(() => {
  if (document.visibilityState === "visible" && hasActiveTasks) refresh();
}, 1_000);
