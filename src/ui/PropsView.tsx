import { useEffect, useState } from "react";
import type { MetaPatch, MetaView } from "../ipc/types";
import { btn, btnPrimary } from "./controls";
import { 推断类型, 问题行, 算补丁, 行来自, type 属性行 } from "./props";

const 输入 =
  "min-w-0 rounded-md border border-line bg-page px-2 py-1 text-sm text-fg placeholder:text-fg-disabled";

/**
 * 属性面板：front-matter 里用户能看懂的那几项。
 *
 * 为什么是独立的一档而不是塞进设置页：它改的是**这一篇**，设置页改的是**这个库**。
 * 为什么不是"源码模式"：正文仍然只有所见即所得一面；这里只列结构化字段，
 * 改哪几行由后端按行替换，没碰到的键、注释与排版原样留在文件里。
 *
 * 复杂值（列表 / 映射）只读：面板没有能表达它们的控件，硬塞一个文本框就是猜。
 */
export function PropsView(props: {
  meta: MetaView;
  busy: boolean;
  冲突: boolean;
  错误: string | null;
  /** 「完成」/ Esc：有未保存改动时由 App 先问一句 */
  onBack: () => void;
  /** 「取消」：明确丢弃，不再问 */
  onCancel: () => void;
  /** force=true 是"仍然存我这份"：跳过 expectHash，只在冲突横幅上出现 */
  onSave: (patch: MetaPatch, force: boolean) => void;
  onReload: () => void;
  /** 只把"有没有未保存改动"说给 App：离开这一页的入口不在面板里（侧栏、命令面板） */
  onDirty: (dirty: boolean) => void;
}) {
  const { meta } = props;
  const [标签, set标签] = useState(meta.tags.join(", "));
  const [行, set行] = useState<属性行[]>(() => 行来自(meta));
  const [私密, set私密] = useState(meta.private);
  const [停用, set停用] = useState(meta.noAi);

  const dirty = 算补丁(meta, 标签, 行, 私密, 停用) !== null;
  useEffect(() => {
    props.onDirty(dirty);
  }, [dirty, props.onDirty]);

  const 可编辑 = meta.yamlOk;
  const 问题 = 问题行(行);

  const 补丁 = () => 算补丁(meta, 标签, 行, 私密, 停用);

  const 保存 = (force: boolean) => {
    const patch = 补丁();
    // 没改就直接回去：按一次"保存"不该白落一次盘
    if (!patch) {
      props.onCancel();
      return;
    }
    props.onSave(patch, force);
  };

  const 改行 = (i: number, 改: Partial<属性行>) => {
    set行((旧) =>
      旧.map((r, j) => {
        if (j !== i) return r;
        const 新 = { ...r, ...改 };
        // 新属性的类型跟着值走；已有属性的类型不因为改值而变
        if (r.原键 === "" && 改.值 !== undefined) 新.类型 = 推断类型(改.值);
        return 新;
      }),
    );
  };

  return (
    <div className="measure-ui px-6 py-8">
      <div className="flex items-baseline gap-3">
        <h2 className="text-xl text-fg">属性</h2>
        <span className="font-mono text-xs text-fg-2">front-matter</span>
        <button className={btn + " ml-auto"} onClick={props.onBack}>
          完成
        </button>
      </div>
      <p className="mt-2 text-sm text-fg-2">
        标签、属性与 AI 开关只改 front-matter 里对应的几行；正文、未知字段、注释与排序原样保留。
      </p>

      {!meta.yamlOk ? (
        <div className="mt-4 rounded-md border border-danger bg-danger-soft px-3 py-2 text-sm">
          front-matter 不是合法 YAML，属性面板改不了。先在外部编辑器里修好再回来——
          这里不会拿一份解析不出来的结构去猜改哪一行。
        </div>
      ) : null}
      {props.冲突 ? (
        <div className="mt-4 rounded-md border border-danger bg-danger-soft px-3 py-2 text-sm">
          这篇在你打开属性期间被别处改过（Obsidian、另一个窗口，或同步）。你的改动还在下面，还没保存：
          <div className="mt-3 flex gap-2">
            <button className={btn} onClick={props.onReload} disabled={props.busy}>
              丢掉我的，读磁盘版本
            </button>
            <button className={btn} onClick={() => 保存(true)} disabled={props.busy}>
              仍然存我这份
            </button>
          </div>
        </div>
      ) : null}
      {props.错误 ? <p className="mt-3 text-sm text-danger">{props.错误}</p> : null}

      <fieldset disabled={!可编辑 || props.busy} className="min-w-0">
        <section className="mt-8">
          <h3 className="text-sm font-medium text-fg">标签</h3>
          <input
            className={`${输入} mt-2 w-full`}
            value={标签}
            aria-label="标签"
            placeholder="逗号分隔，例如：ai-native, m4"
            onChange={(e) => set标签(e.target.value)}
          />
        </section>

        <section className="mt-8">
          <div className="flex items-baseline gap-3">
            <h3 className="text-sm font-medium text-fg">属性</h3>
            <button
              className={btn + " ml-auto"}
              onClick={() => set行((旧) => [...旧, { 原键: "", 键: "", 值: "", 类型: "text", 删除: false }])}
            >
              加一项
            </button>
          </div>
          {行.length === 0 ? (
            <p className="mt-2 text-sm text-fg-2">还没有属性。属性是看板 / 日历视图的数据源。</p>
          ) : (
            <div className="mt-2 divide-y divide-line border-y border-line">
              {行.map((r, i) => (
                <div
                  key={`${r.原键}:${i}`}
                  className={
                    "flex flex-wrap items-center gap-2 py-2 " + (r.删除 ? "opacity-55" : "")
                  }
                >
                  {r.类型 === "json" ? (
                    <span className="min-w-0 flex-1 truncate font-mono text-mono text-fg-2">
                      {r.键}
                    </span>
                  ) : (
                    <input
                      className={`${输入} w-40`}
                      value={r.键}
                      aria-label="属性键"
                      placeholder="键"
                      onChange={(e) => 改行(i, { 键: e.target.value })}
                    />
                  )}
                  {r.类型 === "json" ? (
                    <span
                      className="min-w-0 flex-[2] truncate font-mono text-mono text-fg-2"
                      title="列表 / 映射值在属性面板里只读；删除可以"
                    >
                      {r.值}
                    </span>
                  ) : (
                    <input
                      className={`${输入} min-w-0 flex-[2]`}
                      value={r.值}
                      aria-label="属性值"
                      placeholder="值"
                      onChange={(e) => 改行(i, { 值: e.target.value })}
                    />
                  )}
                  <span className="w-12 shrink-0 text-right font-mono text-xs text-fg-2">
                    {r.类型}
                  </span>
                  <button
                    className={btn}
                    onClick={() => {
                      // 新加的行还没落盘，直接拿掉；已有的行留一条"已删除"意图给补丁
                      if (r.原键 === "") set行((旧) => 旧.filter((_, j) => j !== i));
                      else 改行(i, { 删除: !r.删除 });
                    }}
                  >
                    {r.删除 ? "撤销" : r.原键 === "" ? "移除" : "删除"}
                  </button>
                </div>
              ))}
            </div>
          )}
          {问题 ? <p className="mt-2 text-sm text-danger">{问题}</p> : null}
        </section>

        <section className="mt-8">
          <h3 className="text-sm font-medium text-fg">AI</h3>
          <div className="mt-2 divide-y divide-line border-y border-line">
            <label className="flex items-center gap-3 py-3 text-sm">
              <input
                type="checkbox"
                className="accent-(--accent)"
                checked={私密}
                onChange={(e) => set私密(e.target.checked)}
              />
              <span className="text-fg">私密篇</span>
              <span className="text-xs text-fg-2">任何块都不进入 AI 上下文</span>
            </label>
            <label className="flex items-center gap-3 py-3 text-sm">
              <input
                type="checkbox"
                className="accent-(--accent)"
                checked={停用}
                onChange={(e) => set停用(e.target.checked)}
              />
              <span className="text-fg">完全停用 AI</span>
              <span className="text-xs text-fg-2">连摘要、打标都不做（比私密更严格）</span>
            </label>
          </div>
        </section>
      </fieldset>

      <div className="mt-8 flex items-center gap-2">
        <button
          className={btnPrimary}
          disabled={!可编辑 || props.busy || !!问题}
          onClick={() => 保存(false)}
        >
          {props.busy ? "保存中…" : "保存属性"}
        </button>
        <button className={btn} onClick={props.onCancel}>
          取消
        </button>
        {!meta.hasFrontMatter ? (
          <span className="text-xs text-fg-2">这篇还没有 front-matter，保存时会新建一块。</span>
        ) : null}
      </div>
    </div>
  );
}
