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
 * 只带**改过的**属性项：复杂值（列表 / 映射）面板只读，没删就不出现在补丁里，
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
  let changed = tags.length !== meta.tags.length || tags.some((t, i) => t !== meta.tags[i]);
  const props: PropEdit[] = [];

  for (const r of 行) {
    if (r.删除) {
      if (r.原键 && meta.props.some((p) => p.key === r.原键)) {
        props.push({ key: r.原键, kind: r.类型, value: null });
        changed = true;
      }
      continue;
    }
    if (r.类型 === "json") continue; // 只读：没删就不动
    const key = r.键.trim();
    const 原 = meta.props.find((p) => p.key === r.原键);
    if (!原) {
      props.push({ key, kind: r.类型, value: r.值 });
      changed = true;
    } else if (r.原键 !== key) {
      props.push({ key: r.原键, kind: r.类型, value: null });
      props.push({ key, kind: r.类型, value: r.值 });
      changed = true;
    } else if (r.值 !== 原.value || r.类型 !== 原.kind) {
      props.push({ key, kind: r.类型, value: r.值 });
      changed = true;
    }
  }

  if (私密 !== meta.private || 停用 !== meta.noAi) changed = true;
  if (!changed) return null;
  return { tags, props, private: 私密, noAi: 停用 };
}
