/**
 * 主题的**唯一**一份逻辑，两个窗口共用。
 *
 * 为什么单独一个模块而不是留在 `App.tsx`：速记窗是另一个 WebView 上下文，它以前
 * 从来没被问过主题——于是主窗是暗的、速记窗永远是浅的（用户原话"为什么没有跟随系统颜色"）。
 * 而"跟随系统"这件事本身没坏：坏的是**没人把它存下来**，也没人把它带到第二个窗口。
 *
 * 存储用 `localStorage`（两个窗口同源，共享同一份），跨窗口靠 `storage` 事件同步——
 * 那个事件只在**其它**上下文写同一个 key 时触发，正好就是我们要的。
 */
export type Theme = "system" | "light" | "dark";

const 键 = "note.theme";

const 系统偏好 = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";

/** 解析成真正该套的那一档 */
export function 解析(t: Theme): "light" | "dark" {
  return t === "system" ? 系统偏好() : t;
}

export function 读主题(): Theme {
  try {
    const 存 = localStorage.getItem(键);
    return 存 === "light" || 存 === "dark" || 存 === "system" ? 存 : "system";
  } catch {
    return "system"; // 隐私模式 / 存储被禁：默认跟随系统，不许把整篇界面带崩
  }
}

/** 落到 DOM 上。只改一个属性——颜色全在 tokens.css 的 `[data-theme]` 分支里 */
export function 套主题(t: Theme): void {
  document.documentElement.dataset.theme = 解析(t);
}

/** 存 + 套。给设置处用 */
export function 写主题(t: Theme): void {
  套主题(t);
  try {
    localStorage.setItem(键, t);
  } catch {
    /* 存不下也要当场生效，重启回到默认，比白屏强 */
  }
}

/**
 * 订阅"该重算主题了"：系统换了深浅色，或**另一个窗口**改了偏好。
 * 返回取消订阅。
 */
export function 盯主题变化(重算: () => void): () => void {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const 换 = () => 重算();
  const 串窗 = (e: StorageEvent) => {
    if (e.key === 键 || e.key === null) 重算();
  };
  mq.addEventListener("change", 换);
  window.addEventListener("storage", 串窗);
  return () => {
    mq.removeEventListener("change", 换);
    window.removeEventListener("storage", 串窗);
  };
}
