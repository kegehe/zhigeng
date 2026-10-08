/**
 * 主题要在**第一帧之前**定下来，所以这既不是模块也不进打包（放在 `public/` 里原样拷过去）：
 * CSS 是渲染阻塞的，而 `main.tsx` 要等整个模块图（React + tiptap + highlight.js）下载解析完
 * 才跑得到 `套主题`——那之前暗色用户看到的是一整屏亮色画布。
 *
 * 也不用内联脚本：CSP 是 `default-src 'self'`（没写 `script-src`，所以内联被禁），
 * 而这正是我们把"渲染 Markdown 不许长出元素"当命根子的应用，不该为了一帧去开 `'unsafe-inline'`。
 *
 * 与 `src/ui/theme.ts` 同一份口径：`note.theme` 存的是**档位**，`data-theme` 上是解析后的深浅。
 * 两边各写一份的结局就是启动那一帧与之后那一帧颜色不同。
 */
(function () {
  var 档 = "system";
  try {
    var 存 = localStorage.getItem("note.theme");
    if (存 === "light" || 存 === "dark" || 存 === "system") 档 = 存;
  } catch (e) {
    /* 隐私模式 / 存储被禁：跟着系统走，别把界面带崩 */
  }
  var 暗 = false;
  try {
    暗 = 档 === "dark" || (档 !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  } catch (e) {
    暗 = 档 === "dark";
  }
  document.documentElement.dataset.theme = 暗 ? "dark" : "light";
})();
