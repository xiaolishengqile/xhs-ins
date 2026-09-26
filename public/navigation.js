import { createImagesPage } from "./images.js";
import { createSettingsPage } from "./settings.js";

const pages = {
  tasks: document.querySelector("#tasks-view"),
  images: document.querySelector("#images-view"),
  settings: document.querySelector("#settings-view"),
};
const images = createImagesPage();
const settings = createSettingsPage();

for (const button of document.querySelectorAll("[data-view]")) {
  button.addEventListener("click", () => {
    const selected = button.dataset.view;
    for (const [name, page] of Object.entries(pages)) page.hidden = name !== selected;
    for (const item of document.querySelectorAll("[data-view]")) {
      item.setAttribute("aria-pressed", String(item.dataset.view === selected));
    }
    if (selected === "images") void images.refresh();
    if (selected === "settings") void settings.refresh();
  });
}
