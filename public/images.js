import { requestJson } from "./api.js";

export function createImagesPage() {
  const account = document.querySelector("#image-account");
  const grid = document.querySelector("#image-grid");
  const message = document.querySelector("#images-message");
  const pagination = document.querySelector("#image-pagination");
  const pageLabel = document.querySelector("#image-page-label");
  const previous = document.querySelector("#image-previous");
  const next = document.querySelector("#image-next");
  const viewer = document.querySelector("#image-viewer");
  const viewerImage = document.querySelector("#viewer-image");
  const viewerSize = document.querySelector("#viewer-size");
  const actions = document.querySelector("#image-actions");
  const selectPage = document.querySelector("#image-select-page");
  const selectAll = document.querySelector("#image-select-all");
  const selectionCount = document.querySelector("#image-selection-count");
  const deleteButton = document.querySelector("#image-delete");
  const dateFrom = document.querySelector("#image-from");
  const dateTo = document.querySelector("#image-to");
  let page = 1;
  let pageCount = 1;
  let generation = 0;
  let total = 0;
  let pageNames = [];
  let allSelected = false;
  const selected = new Set();

  function clearSelection() {
    allSelected = false;
    selected.clear();
  }

  function isSelected(name) {
    return allSelected || selected.has(name);
  }

  function updateSelection() {
    const count = allSelected ? total : selected.size;
    actions.hidden = total === 0;
    selectionCount.textContent = `已选 ${count} 张`;
    deleteButton.textContent = `删除选中（${count}）`;
    deleteButton.disabled = count === 0;
    selectAll.textContent = allSelected ? "取消全选" : `选择全部 ${total} 张`;
    const onPage = pageNames.filter(isSelected).length;
    selectPage.checked = pageNames.length > 0 && onPage === pageNames.length;
    selectPage.indeterminate = onPage > 0 && onPage < pageNames.length;
    for (const checkbox of grid.querySelectorAll("input[data-image]")) checkbox.checked = isSelected(checkbox.dataset.image);
  }

  function setSelected(name, value) {
    if (allSelected && !value) {
      allSelected = false;
      for (const item of pageNames) selected.add(item);
    }
    if (value) selected.add(name);
    else selected.delete(name);
  }

  function fit() {
    viewerImage.style.width = "";
    viewerImage.style.maxWidth = "100%";
    viewerImage.style.maxHeight = "calc(100vh - 180px)";
  }

  function original() {
    if (!viewerImage.naturalWidth) return;
    viewerImage.style.width = `${viewerImage.naturalWidth}px`;
    viewerImage.style.maxWidth = "none";
    viewerImage.style.maxHeight = "none";
  }

  function zoom(factor) {
    if (!viewerImage.naturalWidth) return;
    const width = Number.parseFloat(viewerImage.style.width) || viewerImage.getBoundingClientRect().width || viewerImage.naturalWidth;
    viewerImage.style.width = `${Math.max(32, Math.round(width * factor))}px`;
    viewerImage.style.maxWidth = "none";
    viewerImage.style.maxHeight = "none";
  }

  function open(image) {
    document.querySelector("#viewer-name").textContent = image.name;
    viewerSize.textContent = "正在读取图片…";
    fit();
    viewerImage.onload = () => { viewerSize.textContent = `${viewerImage.naturalWidth} × ${viewerImage.naturalHeight}`; };
    viewerImage.onerror = () => { viewerSize.textContent = "图片损坏或格式不支持"; };
    viewerImage.src = image.url;
    viewer.showModal();
  }

  async function loadPage() {
    const current = ++generation;
    grid.replaceChildren();
    pagination.hidden = true;
    pageNames = [];
    if (!account.value) {
      total = 0;
      updateSelection();
      return;
    }
    message.textContent = "正在读取本地图片…";
    try {
      const range = `&from=${encodeURIComponent(dateFrom.value)}&to=${encodeURIComponent(dateTo.value)}`;
      const result = await requestJson(`/api/images?account=${encodeURIComponent(account.value)}&page=${page}${range}`);
      if (current !== generation) return;
      page = result.page;
      pageCount = result.pageCount;
      total = result.total;
      pageNames = result.images.map((image) => image.name);
      const filtered = Boolean(dateFrom.value || dateTo.value);
      message.textContent = result.total
        ? `${filtered ? "该日期范围内" : "共"} ${result.total} 张图片`
        : filtered ? "该日期范围内没有图片。" : "这个账号还没有已保存的图片。";
      let previousPost = null;
      for (const image of result.images) {
        const postKey = image.noteId ?? `file:${image.name}`;
        if (image.noteId && postKey !== previousPost) {
          const header = document.createElement("div");
          header.className = "image-post";
          const date = document.createElement("span");
          date.textContent = image.publishedAt
            ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(new Date(image.publishedAt))
            : "发布日期未知";
          header.append(date);
          if (image.noteUrl) {
            const link = document.createElement("a");
            link.href = image.noteUrl;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            link.textContent = "打开原帖";
            header.append(link);
          }
          grid.append(header);
        }
        previousPost = postKey;
        const item = document.createElement("div");
        item.className = "image-item";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.className = "image-select";
        checkbox.dataset.image = image.name;
        checkbox.setAttribute("aria-label", `选择${image.name}`);
        checkbox.addEventListener("change", () => {
          setSelected(image.name, checkbox.checked);
          updateSelection();
        });
        const card = document.createElement("button");
        card.type = "button";
        card.className = "image-card";
        card.setAttribute("aria-label", `查看${image.name}`);
        const thumbnail = document.createElement("img");
        thumbnail.src = image.thumbnailUrl;
        thumbnail.alt = "";
        thumbnail.loading = "lazy";
        thumbnail.onerror = () => {
          thumbnail.hidden = true;
          const warning = document.createElement("span");
          warning.className = "image-warning";
          warning.textContent = "无法预览";
          card.append(warning);
        };
        const label = document.createElement("span");
        label.textContent = image.name;
        card.append(thumbnail, label);
        card.addEventListener("click", () => open(image));
        item.append(card, checkbox);
        grid.append(item);
      }
      pagination.hidden = result.total <= 30;
      pageLabel.textContent = `第 ${page} / ${pageCount} 页`;
      previous.disabled = page <= 1;
      next.disabled = page >= pageCount;
      updateSelection();
    } catch (error) {
      if (current === generation) message.textContent = error.message;
    }
  }

  async function refresh() {
    const selectedAccount = account.value;
    const current = ++generation;
    message.textContent = "正在扫描图片目录…";
    try {
      const result = await requestJson("/api/images/accounts");
      if (current !== generation) return;
      account.replaceChildren(...result.accounts.map((name) => new Option(name, name)));
      account.value = result.accounts.includes(selectedAccount) ? selectedAccount : result.accounts[0] || "";
      if (account.value !== selectedAccount) clearSelection();
      page = 1;
      if (account.value) await loadPage();
      else {
        grid.replaceChildren();
        pagination.hidden = true;
        total = 0;
        pageNames = [];
        updateSelection();
        message.textContent = "当前图片目录还没有已保存的图片。";
      }
    } catch (error) {
      if (current === generation) message.textContent = error.message;
    }
  }

  account.addEventListener("change", () => { page = 1; clearSelection(); void loadPage(); });
  for (const input of [dateFrom, dateTo]) {
    input.addEventListener("change", () => { page = 1; clearSelection(); void loadPage(); });
  }
  document.querySelector("#image-clear-dates").addEventListener("click", () => {
    dateFrom.value = "";
    dateTo.value = "";
    page = 1;
    clearSelection();
    void loadPage();
  });
  selectPage.addEventListener("change", () => {
    for (const name of pageNames) setSelected(name, selectPage.checked);
    updateSelection();
  });
  selectAll.addEventListener("click", () => {
    const next = !allSelected;
    clearSelection();
    allSelected = next;
    updateSelection();
  });
  deleteButton.addEventListener("click", async () => {
    const count = allSelected ? total : selected.size;
    if (count === 0) return;
    if (!window.confirm(`确定从电脑删除 ${account.value} 的 ${count} 张图片吗？删除后无法恢复，以后采集也不会再下载这些图片。`)) return;
    deleteButton.disabled = true;
    try {
      const result = await requestJson("/api/images/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(allSelected
          ? { account: account.value, all: true, from: dateFrom.value || undefined, to: dateTo.value || undefined }
          : { account: account.value, names: [...selected] }),
      });
      clearSelection();
      if (result.remaining === 0) await refresh();
      else await loadPage();
      message.textContent = `已删除 ${result.deleted} 张图片，剩余 ${result.remaining} 张。`;
    } catch (error) {
      message.textContent = error.message;
      updateSelection();
    }
  });
  document.querySelector("#refresh-images").addEventListener("click", () => { void refresh(); });
  previous.addEventListener("click", () => { if (page > 1) { page -= 1; void loadPage(); } });
  next.addEventListener("click", () => { if (page < pageCount) { page += 1; void loadPage(); } });
  document.querySelector("#viewer-fit").addEventListener("click", fit);
  document.querySelector("#viewer-original").addEventListener("click", original);
  document.querySelector("#viewer-smaller").addEventListener("click", () => zoom(0.8));
  document.querySelector("#viewer-larger").addEventListener("click", () => zoom(1.25));
  document.querySelector("#viewer-open-folder").addEventListener("click", async () => {
    try {
      await requestJson("/api/images/open-folder", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ account: account.value }),
      });
    } catch (error) {
      viewerSize.textContent = error.message;
    }
  });
  document.querySelector("#viewer-close").addEventListener("click", () => viewer.close());
  viewer.addEventListener("close", () => { viewerImage.src = ""; });
  return { refresh };
}
