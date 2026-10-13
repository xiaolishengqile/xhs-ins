import { requestJson } from "./api.js";

export function createSettingsPage() {
  const form = document.querySelector("#settings-form");
  const preset = document.querySelector("#default-preset");
  const output = document.querySelector("#preferred-output-dir");
  const imageDelay = document.querySelector("#image-delay");
  const bloggerGap = document.querySelector("#blogger-gap");
  const dailyLimit = document.querySelector("#daily-limit");
  const message = document.querySelector("#settings-message");
  const stop = document.querySelector("#stop-backend");
  const stopMessage = document.querySelector("#stop-message");

  function show(settings) {
    preset.value = settings.preset;
    output.value = settings.outputDir;
    imageDelay.value = settings.imageDelaySeconds;
    bloggerGap.value = settings.bloggerGapSeconds;
    dailyLimit.value = settings.dailyBloggerLimit;
    document.querySelector("#actual-output-dir").textContent = settings.actualOutputDir;
    document.querySelector("#data-dir").textContent = settings.dataDir;
    document.querySelector("#node-version").textContent = settings.nodeVersion;
  }

  async function refresh() {
    try {
      show(await requestJson("/api/settings"));
    } catch (error) {
      message.textContent = error.message;
    }
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const settings = await requestJson("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          preset: preset.value,
          outputDir: output.value.trim(),
          imageDelaySeconds: Number(imageDelay.value),
          bloggerGapSeconds: Number(bloggerGap.value),
          dailyBloggerLimit: Number(dailyLimit.value),
        }),
      });
      show(settings);
      document.dispatchEvent(new CustomEvent("settings-changed", { detail: settings }));
      message.textContent = "设置已保存；图片目录将在下次启动后台时生效。";
    } catch (error) {
      message.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  stop.addEventListener("click", async () => {
    if (!window.confirm("确定安全停止后台吗？运行中的任务会保存进度；下次使用请重新启动。")) return;
    stop.disabled = true;
    try {
      await requestJson("/api/control/stop", { method: "POST" });
      stopMessage.textContent = "后台正在安全停止；下次使用请双击本机启动入口。";
    } catch (error) {
      stop.disabled = false;
      stopMessage.textContent = error.message;
    }
  });

  return { refresh };
}
