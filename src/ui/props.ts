import type { MetaPatch, MetaPropKind, MetaView, PropEdit } from "../ipc/types";

/** 面板里的一行。`原键` 是打开时的键，改名要按它先删再写。 */
export type 属性行 = {
  原键: string;
  键: string;
  值: string;
  类型: MetaPropKind;
  删除: boolean;
};

export function 行来自(meta: MetaView): 属性行[] {
  return meta.props.map((p) => ({
    原键: p.key,
    键: p.key,
    值: p.value,
    类型: p.kind,
    删除: false,
  }));
}

/**
 * 标签输入框的文字 → 标签数组。**只按逗号（中英文）分**：空白不拆，
 * 否则盘上合法的 `tags: ["python 3"]` 一进面板就被拆成两个，用户按保存就等于
 * 悄悄改了标签。前导 `#` 去掉，重复的只留第一次。
 */
export function 解析标签(s: string): string[] {
  const out: string[] = [];
  for (const part of s.split(/[,，]/)) {
    const t = part.trim().replace(/^#+/, "").trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** 新属性默认按值的长相定类型；已有属性的类型不跟着值改（用户没要求换类型）。 */
export function 推断类型(v: string): MetaPropKind {
  const t = v.trim();
  if (/^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(t)) return "date";
  if (/^-?\d+(\.\d+)?$/.test(t)) return "num";
  if (/^(true|false)$/i.test(t)) return "bool";
  return "text";
}

/** 面板自己就能拦下的问题；有它就别发请求。 */
export function 问题行(行: 属性行[]): string | null {
  const seen = new Set<string>();
  // 复杂值的键先全部占位：把普通属性改名成 `范围` 会覆盖掉那份列表 / 映射，
  // 而它在界面上连输入框都没有，用户不会意识到撞了名。先收一遍再判，
  // 否则"被撞的那一行排在后面"就漏过去了。
  for (const r of 行) {
    if (r.删除 || r.类型 !== "json") continue;
    const key = r.键.trim();
    if (key) seen.add(key);
  }
  for (const r of 行) {
    if (r.删除 || r.类型 === "json") continue;
    const key = r.键.trim();
    if (!key) return "属性键不能为空";
    if (seen.has(key)) return `属性键「${key}」重复`;
    seen.add(key);
  }
  return null;
}

/**
 * 面板的当前状态 → 一次提交。`null` = 什么都没改（直接关掉，不发请求）。
 *
 * **只带改过的栏位**。标签输入框是"逗号分隔的一行文本"，一个本身含逗号的标签
 * （盘上写 `tags: ["a,b"]`）在这里无法原样表达——如果无条件把它重新解析一遍再发，
 * 用户只是切了一下私密开关，标签就会被悄悄拆成两个。所以没编辑过标签输入框
 * （与 `meta.tags.join(", ")` 逐字相同）就整栏不发。
 *
 * 属性是逐项意图：复杂值（列表 / 映射）面板只读，没删就不出现在补丁里，
 * 后端也就不会重写它。改名按"删旧键 + 写新键"两笔表达。
 */
export function 算补丁(
  meta: MetaView,
  标签: string,
  行: 属性行[],
  私密: boolean,
  停用: boolean,
): MetaPatch | null {
  const tags = 解析标签(标签);
  const 原标签 = meta.tags.join(", ");
  const 同序 = (a: string[], b: string[]) =>
    a.length === b.length && a.every((t, i) => t === b[i]);
  // 没动输入框就一律不动标签；只改了空格 / 井号这类写法差异也不算改动
  const tagsChanged = 标签 !== 原标签 && !同序(tags, meta.tags);
  const props: PropEdit[] = [];

  for (const r of 行) {
    if (r.删除) {
      if (r.原键 && meta.props.some((p) => p.key === r.原键)) {
        props.push({ key: r.原键, kind: r.类型, value: null });
      }
      continue;
    }
    if (r.类型 === "json") continue; // 只读：没删就不动
    const key = r.键.trim();
    const 原 = meta.props.find((p) => p.key === r.原键);
    if (!原) {
      props.push({ key, kind: r.类型, value: r.值 });
    } else if (r.原键 !== key) {
      props.push({ key: r.原键, kind: r.类型, value: null });
      props.push({ key, kind: r.类型, value: r.值 });
    } else if (r.值 !== 原.value || r.类型 !== 原.kind) {
      props.push({ key, kind: r.类型, value: r.值 });
    }
  }

  const 私密改了 = 私密 !== meta.private;
  const 停用改了 = 停用 !== meta.noAi;
  if (!tagsChanged && props.length === 0 && !私密改了 && !停用改了) return null;
  return {
    ...(tagsChanged ? { tags } : {}),
    ...(props.length > 0 ? { props } : {}),
    ...(私密改了 ? { private: 私密 } : {}),
    ...(停用改了 ? { noAi: 停用 } : {}),
  };
}
