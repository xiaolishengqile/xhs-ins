const form = document.querySelector("#task-form");
const urlInput = document.querySelector("#profile-url");
const presetInput = document.querySelector("#range-preset");
const customRange = document.querySelector("#custom-range");
const dateFrom = document.querySelector("#date-from");
const dateTo = document.querySelector("#date-to");
const message = document.querySelector("#form-message");
const taskList = document.querySelector("#task-list");
const emptyState = document.querySelector("#empty-state");
const refreshStatus = document.querySelector("#refresh-status");

const STATUS = {
  queued: "等待中",
  running: "运行中",
  waiting_user: "等待人工处理",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

let refreshPromise = null;
let refreshAgain = false;
let hasActiveTasks = false;

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

async function request(path, options) {
  const response = await fetch(path, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "请求失败");
  return body;
}

function formatDate(value) {
  return value ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(new Date(value)) : "未知";
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
  top.append(
    node("span", "task-platform", task.platform === "xiaohongshu" ? "小红书" : "Instagram"),
    node("span", "status-pill", STATUS[task.status] ?? task.status),
  );
  card.append(top);
  card.append(node("h3", "task-title", task.author || task.profileKey));
  card.append(node("p", "task-range", `${formatDate(task.from)} — ${formatDate(task.to)}`));

  const progress = node("div", "task-progress");
  const progressLabel = node("div", "task-progress-label");
  const current = task.progress?.current ?? 0;
  const total = task.progress?.total ?? 0;
  progressLabel.append(
    node("span", "", task.progress?.stage || "等待采集"),
    node("span", "", total ? `${current} / ${total}` : `${current}`),
  );
  const track = node("div", "progress-track");
  const bar = node("div", "progress-bar");
  bar.style.width = task.status === "completed" ? "100%" : total ? `${Math.min(100, current / total * 100)}%` : "0%";
  track.append(bar);
  progress.append(progressLabel, track);
  card.append(progress);

  if (task.error) card.append(node("p", "task-error", task.error));
  const actions = node("div", "task-actions");
  if (["queued", "running", "waiting_user"].includes(task.status)) actions.append(actionButton(task, "cancel", "取消"));
  if (["failed", "cancelled"].includes(task.status)) actions.append(actionButton(task, "retry", "重试"));
  if (task.status === "waiting_user") actions.append(actionButton(task, "resume", "我已处理，继续"));
  if (task.status === "completed") {
    const download = node("a", "task-action", "下载结果");
    download.href = `/api/tasks/${task.id}/download`;
    actions.append(download);
  }
  const remove = actionButton(task, "delete", "删除");
  remove.classList.add("task-action-danger");
  actions.append(remove);
  card.append(actions);
  return card;
}

function render(tasks) {
  hasActiveTasks = tasks.some((task) => ["queued", "running"].includes(task.status));
  const running = tasks.filter((task) => task.status === "running").length;
  const queued = tasks.filter((task) => task.status === "queued").length;
  const completed = tasks.filter((task) => task.status === "completed").length;
  document.querySelector('[data-testid="running-summary"]').textContent = `${running} / 5`;
  document.querySelector("#queued-summary").textContent = String(queued);
  document.querySelector("#completed-summary").textContent = String(completed);
  emptyState.hidden = tasks.length > 0;
  taskList.replaceChildren(...tasks.map(renderTask));
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
        render((await request("/api/tasks")).tasks);
        refreshStatus.textContent = `已更新 ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`;
      } catch (error) {
        refreshStatus.textContent = error.message;
      }
    } while (refreshAgain);
  })().finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

presetInput.addEventListener("change", () => {
  const custom = presetInput.value === "custom";
  customRange.hidden = !custom;
  dateFrom.required = custom;
  dateTo.required = custom;
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = form.querySelector('button[type="submit"]');
  const submittedText = urlInput.value;
  const urls = [...new Set(submittedText.split(/\r?\n/).map((value) => value.trim()).filter(Boolean))];
  if (urls.length === 0) {
    message.textContent = "请至少输入一条博主主页链接";
    return;
  }
  if (urls.length > 5) {
    message.textContent = "一次最多提交 5 条链接";
    return;
  }
  const range = { preset: presetInput.value };
  if (range.preset === "custom") Object.assign(range, { from: dateFrom.value, to: dateTo.value });
  button.disabled = true;
  message.textContent = `正在创建 ${urls.length} 个任务…`;
  try {
    const results = await Promise.allSettled(urls.map((url) => request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, range }),
    })));
    const failures = results.filter((result) => result.status === "rejected");
    const createdCount = results.length - failures.length;
    if (failures.length === 0 && urlInput.value === submittedText) urlInput.value = "";
    message.textContent = failures.length === 0
      ? `已创建 ${createdCount} 个任务，可继续提交。`
      : `已创建 ${createdCount} 个任务，${failures.length} 个失败：${failures[0].reason.message}`;
    await refresh();
  } catch (error) {
    message.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

taskList.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  if (
    button.dataset.action === "delete" &&
    !window.confirm("删除后将停止采集，并永久移除任务记录、图片和结果文件。确定删除吗？")
  ) return;
  button.disabled = true;
  try {
    if (button.dataset.action === "delete") {
      await request(`/api/tasks/${button.dataset.id}`, { method: "DELETE" });
    } else {
      await request(`/api/tasks/${button.dataset.id}/${button.dataset.action}`, { method: "POST" });
    }
    await refresh();
  } catch (error) {
    message.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

await refresh();
setInterval(() => {
  if (document.visibilityState === "visible" && hasActiveTasks) refresh();
}, 1_000);
