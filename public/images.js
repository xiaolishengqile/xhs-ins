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
  let page = 1;
  let pageCount = 1;
  let generation = 0;

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
    if (!account.value) return;
    message.textContent = "正在读取本地图片…";
    try {
      const result = await requestJson(`/api/images?account=${encodeURIComponent(account.value)}&page=${page}`);
      if (current !== generation) return;
      page = result.page;
      pageCount = result.pageCount;
      message.textContent = result.total ? `共 ${result.total} 张图片` : "这个账号还没有已保存的图片。";
      for (const image of result.images) {
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
        grid.append(card);
      }
      pagination.hidden = result.total <= 30;
      pageLabel.textContent = `第 ${page} / ${pageCount} 页`;
      previous.disabled = page <= 1;
      next.disabled = page >= pageCount;
    } catch (error) {
      if (current === generation) message.textContent = error.message;
    }
  }

  async function refresh() {
    const selected = account.value;
    const current = ++generation;
    message.textContent = "正在扫描图片目录…";
    try {
      const result = await requestJson("/api/images/accounts");
      if (current !== generation) return;
      account.replaceChildren(...result.accounts.map((name) => new Option(name, name)));
      account.value = result.accounts.includes(selected) ? selected : result.accounts[0] || "";
      page = 1;
      if (account.value) await loadPage();
      else {
        grid.replaceChildren();
        pagination.hidden = true;
        message.textContent = "当前图片目录还没有已保存的图片。";
      }
    } catch (error) {
      if (current === generation) message.textContent = error.message;
    }
  }

  account.addEventListener("change", () => { page = 1; void loadPage(); });
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
