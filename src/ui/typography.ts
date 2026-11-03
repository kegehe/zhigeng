/**
 * 正文行高的**唯一**一份逻辑，主窗与设置页共用。
 *
 * 行高没有可逆的 Markdown 语法：写进 `.md` 只能借内联 HTML，那既破坏字节级往返，
 * 也让"换一台机器看着一样"变成一句空话（docs/02 D35：「行高不是文档的属性」）。
 * 所以它是**本机的阅读偏好**，只落 localStorage，跟主题走同一条路。
 *
 * 与 `--leading-body` 分开记：后者是排版基准（字阶表、面板正文、速记框都读它），
 * 改了它等于把界面上所有 15.5px 的段落一起拉高。正文编辑区只读 `--leading-note`。
 */
export type 行距 = "tight" | "standard" | "loose";

const 键 = "note.leading";

/**
 * 换档后在 document 上广播一次。焦点竖线按块高缓存位置，行高变了必须重画；
 * 但它不该为此收到一个 ProseMirror 事务（那会把"只是换了个显示偏好"标成文档改动）。
 */
export const 行距事件 = "note:leading";

export function 读行距(): 行距 {
  try {
    const 存 = localStorage.getItem(键);
    return 存 === "tight" || 存 === "standard" || 存 === "loose" ? 存 : "standard";
  } catch {
    return "standard"; // 隐私模式 / 存储被禁：回到标准，不许把正文排版带崩
  }
}

/** 落到 DOM 上。三档的数值写在 tokens.css 的 `html[data-leading]` 分支里 */
export function 套行距(v: 行距): void {
  const 根 = document.documentElement;
  const 换过 = 根.dataset.leading !== v;
  根.dataset.leading = v;
  // 只有真的换档才广播：首帧那次套用发生在正文挂载之前，没有人需要重画
  if (换过) document.dispatchEvent(new Event(行距事件));
}

/** 存 + 套。给设置页与命令面板用 */
export function 写行距(v: 行距): void {
  套行距(v);
  try {
    localStorage.setItem(键, v);
  } catch {
    /* 存不下也要当场生效，重启回到标准，比把正文按错档排一辈子强 */
  }
}

/**
 * 订阅"另一个窗口改了行距"。`storage` 只在**其它**上下文写同一个 key 时触发，
 * 本窗口自己改由调用方直接 set state（与主题同一条纪律）。
 */
export function 盯行距变化(重算: () => void): () => void {
  const 串窗 = (e: StorageEvent) => {
    if (e.key === 键 || e.key === null) 重算();
  };
  window.addEventListener("storage", 串窗);
  return () => window.removeEventListener("storage", 串窗);
}
