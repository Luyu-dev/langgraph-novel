(() => {
  "use strict";

  const storageKey = "novel-complete-skin-v1";
  const skins = {
    base: {
      label: "基础",
      name: "基础工作台",
      description: "保留项目下载时的原始工作台结构和操作习惯。",
    },
    longform: {
      label: "长卷",
      name: "长卷工作台",
      description: "结构清晰的长篇创作台，适合日常建档、写作和审稿。",
    },
    poetic: {
      label: "唯美",
      name: "潮汐蓝",
      description: "电影海报式首页与深色分镜工作台。",
    },
    editorial: {
      label: "艺术",
      name: "朱砂纸场",
      description: "文学刊物式目录、纸面编辑秩序与醒目的朱砂色。",
    },
    anime: {
      label: "二次元",
      name: "雾港放送",
      description: "漫画分镜、高对比描边和轻快的连载企划感。",
    },
    oriental: {
      label: "水墨",
      name: "山河卷",
      description: "宣纸、墨色与章回结构，适合武侠和古典题材。",
    },
  };

  const validSkins = new Set(Object.keys(skins));
  const params = new URLSearchParams(window.location.search);
  const requested = params.get("skin");
  let current = validSkins.has(requested) ? requested : "longform";
  let returnFocus = null;

  try {
    const saved = window.localStorage.getItem(storageKey);
    if (!requested && validSkins.has(saved) && saved !== "longform") {
      const url = new URL(window.location.href);
      url.searchParams.set("skin", saved);
      window.location.replace(url);
      return;
    }
    if (requested) window.localStorage.setItem(storageKey, requested);
    else if (!saved) window.localStorage.setItem(storageKey, current);
  } catch {
    // The current skin still works when browser storage is unavailable.
  }

  document.documentElement.dataset.completeSkin = current;

  function optionMarkup() {
    return Object.entries(skins)
      .map(
        ([key, skin]) => `
          <button class="complete-skin-option" type="button" role="radio" aria-checked="${key === current}" data-complete-skin-option="${key}">
            <span class="complete-skin-swatch complete-skin-swatch-${key}" aria-hidden="true"></span>
            <span class="complete-skin-copy">
              <small>${skin.label}</small>
              <strong>${skin.name}</strong>
              <span>${skin.description}</span>
            </span>
            <span class="complete-skin-check"><i class="ph ph-check" aria-hidden="true"></i>当前</span>
          </button>
        `,
      )
      .join("");
  }

  function buildPanel() {
    if (document.querySelector("[data-complete-skin-overlay]")) return;
    const overlay = document.createElement("div");
    overlay.className = "complete-skin-overlay";
    overlay.dataset.completeSkinOverlay = "";
    overlay.hidden = true;
    overlay.innerHTML = `
      <section class="complete-skin-panel" id="complete-skin-panel" role="dialog" aria-modal="true" aria-labelledby="complete-skin-title">
        <div class="complete-skin-head">
          <div>
            <p class="complete-skin-kicker">SIX COMPLETE INTERFACES</p>
            <h2 id="complete-skin-title">切换界面皮肤</h2>
          </div>
          <button class="complete-skin-close" type="button" data-complete-skin-close aria-label="关闭皮肤面板">
            <i class="ph ph-x" aria-hidden="true"></i>
          </button>
        </div>
        <p class="complete-skin-intro">所有皮肤共用同一套小说、设定、章节和审稿数据，只改变界面组织与视觉语言。切换后会直接进入对应完整页面。</p>
        <div class="complete-skin-options" role="radiogroup" aria-label="界面皮肤">
          ${optionMarkup()}
        </div>
        <div class="complete-skin-foot">
          <span>当前：${skins[current].name}</span>
          <span>数据不会因换肤改变</span>
        </div>
      </section>
    `;
    document.body.append(overlay);
  }

  function ensureLauncher() {
    const launchers = Array.from(document.querySelectorAll("[data-complete-skin-launcher]"));
    if (launchers.length) return launchers;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "global-skin-launcher";
    button.dataset.completeSkinLauncher = "";
    button.setAttribute("aria-label", "切换界面皮肤");
    button.setAttribute("aria-haspopup", "dialog");
    button.setAttribute("aria-controls", "complete-skin-panel");
    button.innerHTML = '<i class="ph ph-palette" aria-hidden="true"></i><span>换肤</span>';
    document.body.append(button);
    return [button];
  }

  function openPanel(launcher) {
    buildPanel();
    const overlay = document.querySelector("[data-complete-skin-overlay]");
    if (!overlay) return;
    returnFocus = launcher || document.activeElement;
    overlay.hidden = false;
    document.body.classList.add("complete-skin-open", "modal-open");
    document.querySelectorAll("[data-complete-skin-launcher]").forEach((button) => {
      button.setAttribute("aria-expanded", "true");
    });
    window.setTimeout(() => {
      const selected = overlay.querySelector('[data-complete-skin-option][aria-checked="true"]');
      (selected || overlay.querySelector("[data-complete-skin-option]"))?.focus();
    }, 30);
  }

  function closePanel() {
    const overlay = document.querySelector("[data-complete-skin-overlay]");
    if (!overlay || overlay.hidden) return;
    overlay.hidden = true;
    document.body.classList.remove("complete-skin-open", "modal-open");
    document.querySelectorAll("[data-complete-skin-launcher]").forEach((button) => {
      button.setAttribute("aria-expanded", "false");
    });
    if (returnFocus instanceof HTMLElement) returnFocus.focus();
  }

  function choose(skin) {
    if (!validSkins.has(skin)) return;
    try {
      window.localStorage.setItem(storageKey, skin);
    } catch {
      // Navigation still preserves the selection in the URL.
    }
    const url = new URL(window.location.href);
    url.searchParams.set("skin", skin);
    window.location.href = `${url.pathname}${url.search}${window.location.hash}`;
  }

  function trapFocus(event) {
    if (event.key !== "Tab") return;
    const panel = document.querySelector(".complete-skin-panel");
    if (!panel || panel.closest("[hidden]")) return;
    const focusable = Array.from(
      panel.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function setup() {
    buildPanel();
    ensureLauncher().forEach((button) => {
      button.setAttribute("aria-expanded", "false");
      button.addEventListener("click", () => openPanel(button));
    });
    document.querySelector("[data-complete-skin-close]")?.addEventListener("click", closePanel);
    document.querySelector("[data-complete-skin-overlay]")?.addEventListener("click", (event) => {
      if (event.target === event.currentTarget) closePanel();
    });
    document.querySelectorAll("[data-complete-skin-option]").forEach((option) => {
      option.addEventListener("click", () => choose(option.dataset.completeSkinOption));
    });
    document.addEventListener(
      "keydown",
      (event) => {
        const overlay = document.querySelector("[data-complete-skin-overlay]");
        if (!overlay || overlay.hidden) return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          closePanel();
          return;
        }
        trapFocus(event);
      },
      true,
    );
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", setup, { once: true });
  } else {
    setup();
  }
})();
