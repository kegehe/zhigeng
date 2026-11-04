/**
 * 引用 / Callout 的前缀账本。和围栏账本同一条理由：点进去编辑的应当是屏幕上
 * 那一段正文，不是另换一副带 `>`、`[!type]` 的源码样子。
 *
 * 前缀按行原样留着（含懒惰续行的空前缀、Callout 标题行的 `[!type]`），
 * 正文才进节点。保存时按行拼回去。拼不回原样的块不接管，继续两副面孔。
 */

const 引用前缀 = /^(\s{0,3}>\s?)(.*)$/;
const 标注前缀 = /^(\s{0,3}>\s*\[![A-Za-z-]+\][+-]?\s*)(.*)$/;
/** 与显示形 `stripAnchor` 同一条：短于 6 位的不算块锚，别从正文里摘掉 */
const 行尾锚 = /(\s*\^b-[a-z0-9-]{6,}\s*)$/;

export type 引用账 = {
  /** 每行被剥掉的前缀，与正文行一一对应。懒惰续行是空串。 */
  缀: string[];
  /** 剥掉前缀（和行尾块锚）之后的正文，行与行之间是 `\n` */
  身: string;
  /** 从末行摘下的块锚，含它前面的空白。没有就是空串。 */
  锚: string;
};

function 拆一行(行: string, 种类: string, 是首行: boolean): { 缀: string; 身: string } | null {
  const 车 = 行.endsWith("\r") ? "\r" : "";
  const 净 = 车 ? 行.slice(0, -1) : 行;
  const 标 = 是首行 && 种类 === "callout" ? 标注前缀.exec(净) : null;
  const m = 标 ?? 引用前缀.exec(净);
  if (!m) return { 缀: "", 身: 行 };
  return { 缀: m[1] ?? "", 身: (m[2] ?? "") + 车 };
}

function 摘锚(行: string, id: string | null): { 行: string; 锚: string } {
  if (!id) return { 行, 锚: "" };
  const 车 = 行.endsWith("\r") ? "\r" : "";
  const 净 = 车 ? 行.slice(0, -1) : 行;
  const m = 行尾锚.exec(净);
  const 锚 = m?.[1] ?? "";
  if (!锚 || 锚.replace(/\s/g, "") !== `^${id}`) return { 行, 锚: "" };
  return { 行: 净.slice(0, m!.index) + 车, 锚 };
}

/** 新起的一行沿用最近一条普通 `>` 前缀。Callout 标题那条不能复制，否则每行都带 `[!type]`。 */
export function 续行缀(缀: string[]): string {
  for (let i = 缀.length - 1; i >= 0; i--) {
    const 前 = 缀[i] ?? "";
    if (/^\s{0,3}>\s?$/.test(前)) return 前;
  }
  const m = /^(\s{0,3}>)/.exec(缀[0] ?? "");
  return m ? `${m[1]} ` : "> ";
}

/**
 * 把账本拼回源文本。正文行比前缀多（用户回车加了一行）时，多出来的用 `续行缀`。
 * 正文行比前缀少（删掉了几行）时，多出来的前缀丢掉，不把删掉的行写回去。
 */
export function 拼引用(缀: string[], 身: string, 锚: string): string {
  const 行 = 身 === "" ? [""] : 身.split("\n");
  const 出 = 行.map((行文, i) => (i < 缀.length ? 缀[i]! : 续行缀(缀)) + 行文);
  if (锚 && 出.length) {
    const 末 = 出.length - 1;
    const 行文 = 出[末]!;
    const 车 = 行文.endsWith("\r") ? "\r" : "";
    const 净 = 车 ? 行文.slice(0, -1) : 行文;
    出[末] = 净 + 锚 + 车;
  }
  return 出.join("\n");
}

/**
 * 拆开一段引用或 Callout。拼不回 `源` 就返回 null——宁可继续显示源文本，
 * 也不要接管一块我们会写歪的东西。
 */
export function 引用账本(源: string, 种类: string, id: string | null): 引用账 | null {
  if (种类 !== "quote" && 种类 !== "callout") return null;
  if (源 === "") return null;
  const 行 = 源.split("\n");
  const 缀: string[] = [];
  const 身: string[] = [];
  let 有前缀 = false;
  for (let i = 0; i < 行.length; i++) {
    const 拆 = 拆一行(行[i]!, 种类, i === 0);
    if (!拆) return null;
    if (拆.缀) 有前缀 = true;
    缀.push(拆.缀);
    身.push(拆.身);
  }
  if (!有前缀) return null;
  const 末 = 身.length - 1;
  const 摘 = 摘锚(身[末]!, id);
  身[末] = 摘.行;
  const 账: 引用账 = { 缀, 身: 身.join("\n"), 锚: 摘.锚 };
  if (拼引用(账.缀, 账.身, 账.锚) !== 源) return null;
  return 账;
}

/** 剪贴板写回来的前缀。不合这条的整组丢掉，不让外面的 HTML 把任意字符串写进文件。 */
export function 缀可进账本(缀: string[]): boolean {
  return 缀.every((前, i) => {
    if (前 === "" || /^\s{0,3}>\s?$/.test(前)) return true;
    return i === 0 && /^\s{0,3}>\s*\[![A-Za-z-]+\][+-]?\s*$/.test(前);
  });
}

export function 锚可进账本(锚: string): boolean {
  return 锚 === "" || /^\s*\^b-[a-z0-9-]{6,}\s*$/.test(锚);
}
