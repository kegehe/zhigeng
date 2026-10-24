import { useState } from "react";
import { btn, btnPrimary, 路径框 } from "./controls";
import { 缺项, 步骤名, 探针结论 } from "./ai";
import { 是回车提交 } from "./keys";
import { 主题档位, 判备份, 配置归属, type AI忙, type AI表单 } from "./settings";
import type { Theme } from "./theme";
import type { AppInfo, AiDiscovery, AiProbeReport, AiView } from "../ipc/types";

/**
 * 设置页：主区的一档，不是浮层。
 *
 * 为什么走主区——AI 那一格连模型清单带测试结果有一屏多，塞进模态要么挤要么得拆薄；
 * 而"切走之前先把正文落盘"这条纪律（`openSettings` 里的 `persist`）是备份面板已经跑通的。
 * 代价说清楚：打开设置会把正在编辑的那一篇存下并卸载，回来重新装载。
 *
 * 四格的排序按**改完会不会动这个库**：主题只改这台电脑，备份与模型改的是库里的配置，
 * 换库改的是打开哪个目录。这个顺序也是下面那段「哪些跟着库走」的事实顺序。
 */
export function SettingsView(props: {
  info: AppInfo | null;
  flash: string | null;
  /**
   * 回正文的那一条路。
   *
   * 齿轮是**入口**不是开关：开着设置时再按齿轮不会关掉它（它会重新 persist 一遍正文）。
   * 侧栏底栏那几格（回收站/导入/备份/问答）是开关，齿轮不在那一排里——
   * 于是设置页必须自己带一条出去的路，否则它就是个进得去出不来的地方。
   */
  onBack: () => void;
  外观: { theme: Theme; setTheme: (t: Theme) => void };
  备份: {
    draft: string;
    setDraft: (s: string) => void;
    忙: boolean;
    应用: (dir: string | null) => void;
  };
  模型: {
    view: AiView | null;
    form: AI表单;
    setForm: (f: AI表单) => void;
    key: string;
    setKey: (s: string) => void;
    忙: AI忙;
    报告: AiProbeReport | null;
    发现: AiDiscovery | null;
    保存: () => void;
    存Key: () => void;
    测试: () => void;
    发现模型: () => void;
  };
  库: { 忙: boolean; 打开: (path: string) => void };
}) {
  const { info, 外观, 备份, 模型, 库 } = props;
  const 备份格 = 判备份(info);
  /** 换库的输入框是这一格自己的事：它不该在 App 里占一个 state，也不该记住上一次填了什么 */
  const [库草稿, set库草稿] = useState("");

  return (
    <div className="measure-ui px-6 py-8">
      {/* flash 必须在这一支也渲染：「保存配置」「Key 已存」都靠它回话，
          以前它是只在正文那一支出现的，结果存完什么都没看见 */}
      {props.flash ? <p className="mb-4 text-sm text-fg-2">{props.flash}</p> : null}
      <div className="flex items-center gap-3">
        <h2 className="text-xl text-fg">设置</h2>
        <button className={btn} onClick={props.onBack}>
          返回
        </button>
      </div>

      <section className="mt-8 border-t border-line pt-6">
        <h3 className="text-sm text-fg-2">外观</h3>
        <label className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-fg-2">主题</span>
          {/* 用原生 select：控件行为与键盘都得是原生的（[06] §4 判死了自造下拉，
              代码块那枚语言牌同理）。档位从 `主题档位` 取，界面上不再各写一份 */}
          <select
            className="rounded-md border border-line bg-raised px-2 py-1 text-xs"
            value={外观.theme}
            onChange={(e) => 外观.setTheme(e.target.value as Theme)}
          >
            {主题档位.map((档) => (
              <option key={档.值} value={档.值}>
                {档.标签}
              </option>
            ))}
          </select>
        </label>
        <p className="mt-2 text-xs text-fg-disabled">
          换一档当场生效，速记窗（Alt+Shift+N）跟着一起变。它存在<span className="text-fg-2">这台电脑</span>上，
          不写进这个库——把库拷给别人，别人看到的还是他自己的深浅色。
        </p>
      </section>

      <section className="mt-8 border-t border-line pt-6">
        <h3 className="text-sm text-fg-2">备份</h3>
        <div className="mt-3 rounded-md border border-line bg-raised px-4 py-3 text-sm">
          {备份格.档 === "开着" ? (
            <span>
              备份到 <span className="font-mono text-mono">{备份格.目录}</span>
              {备份格.时刻
                ? ` · 最近一次 ${new Date(备份格.时刻).toLocaleString()}`
                : " · 还没做过快照"}
            </span>
          ) : (
            <span className="text-danger">{备份格.文}</span>
          )}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <input
            className={路径框}
            value={备份.draft}
            spellCheck={false}
            placeholder="E:\\笔记备份"
            onChange={(e) => 备份.setDraft(e.target.value)}
          />
          <button
            className={btnPrimary}
            disabled={备份.忙 || !备份.draft.trim()}
            onClick={() => 备份.应用(备份.draft.trim())}
          >
            用这个目录
          </button>
          <button className={btn} disabled={备份.忙} onClick={() => 备份.应用(null)}>
            不备份
          </button>
        </div>
        <p className="mt-2 text-xs text-fg-disabled">
          每天第一次启动时把库里变化过的文件增量快照过去，保留最近 30 份。挑
          <span className="text-fg-2">另一块盘或 NAS</span> 上的目录才有意义——同一块盘坏了就是一起坏。
          快照列表、立即备份与恢复某一版在左下角「备份」那一格里。
        </p>
      </section>

      <section className="mt-8 border-t border-line pt-6">
        <h3 className="text-sm text-fg-2">模型与 Key</h3>
        <p className="mt-3 text-sm text-fg-2">
          填一个 <span className="font-mono text-mono">OpenAI 兼容</span>{" "}
          端点就行：OpenAI、DeepSeek、Kimi、通义，或本机的 Ollama（
          <span className="font-mono text-mono">http://localhost:11434/v1</span>
          ）都走这一套。地址一般填到 <span className="font-mono text-mono">/v1</span> 为止。
        </p>
        <p className="mt-2 text-sm text-fg-2">
          <span className="text-fg">Key 存在 Windows 凭据管理器里</span>
          ：不落盘、不进这个库、也不回到界面脚本里，所以下面只显示末 4 位。换一台电脑要重输一次
          Key，笔记本身跟着库走。
        </p>
        <div className="mt-5 flex max-w-2xl flex-col gap-3">
          {(
            [
              ["接口地址 base_url", "baseUrl", "https://api.openai.com/v1"],
              ["对话模型 chat_model", "chatModel", "gpt-4o-mini"],
              ["嵌入模型 embedding_model（可留空）", "embeddingModel", "text-embedding-3-small"],
            ] as const
          ).map(([标签, 键, 占位]) => (
            <label key={键} className="flex flex-col gap-1">
              <span className="text-xs text-fg-2">{标签}</span>
              <input
                className="rounded-md border border-line bg-page px-3 py-1 font-mono text-mono text-fg"
                value={模型.form[键]}
                spellCheck={false}
                placeholder={占位}
                onChange={(e) => 模型.setForm({ ...模型.form, [键]: e.target.value })}
              />
            </label>
          ))}
          {/* 重排是合并之后的**一道工序**，不是"第四路"，所以它不进检索那一句的主体，
              只在生效时加一段"· 已重排"。**默认关**：那是每次搜索多打一趟模型，
              不能替用户决定花这个钱。回包读不出时后端会明说"这一趟用 RRF 名次"——
              "配了"与"生效了"在界面上必须是两件事。 */}
          <label className="mt-1 flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1 accent-(--accent)"
              checked={模型.form.rerank}
              onChange={(e) => 模型.setForm({ ...模型.form, rerank: e.target.checked })}
            />
            <span className="text-fg-2">
              检索时让对话模型把候选排一遍（listwise 重排）
              <span className="block text-xs text-fg-disabled">
                每次搜索多打一趟模型，最多送前 30 条片段摘录（不含路径与块 ID）。
                没填对话模型时这一格不起作用；排不出来会自动退回按名次合并的结果，并在这里说清。
              </span>
            </span>
          </label>
          <label className="mt-1 flex flex-col gap-1">
            <span className="text-xs text-fg-2">
              API Key
              {模型.view?.keyHint ? (
                <span className="ml-2 font-mono text-mono text-fg-2">
                  现在：{模型.view.keyHint}
                </span>
              ) : (
                <span className="ml-2 text-fg-disabled">
                  没填（本地模型不需要；云端多半会回 401）
                </span>
              )}
            </span>
            <div className="flex gap-2">
              <input
                className={路径框}
                value={模型.key}
                type="password"
                spellCheck={false}
                placeholder={模型.view?.keySet ? "留空并按「存 Key」= 删掉这把" : "sk-…"}
                onChange={(e) => 模型.setKey(e.target.value)}
              />
              <button
                className={btn}
                disabled={模型.忙 !== null || !模型.key.trim()}
                onClick={模型.存Key}
              >
                存 Key
              </button>
            </div>
          </label>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              className={btnPrimary}
              disabled={模型.忙 !== null}
              onClick={模型.保存}
            >
              {模型.忙 === "save" ? "保存中…" : "保存配置"}
            </button>
            <button
              className={btn}
              disabled={模型.忙 !== null || 缺项(模型.form).length > 0}
              onClick={模型.测试}
            >
              {模型.忙 === "test" ? "测试中…" : "测试连通"}
            </button>
            <button
              className={btn}
              disabled={模型.忙 !== null || !模型.form.baseUrl.trim()}
              title="问这个端点要一份模型清单，把能当嵌入模型用的那些列出来。它只发一个 GET 请求，你的笔记一个字节都不出去。"
              onClick={模型.发现模型}
            >
              {模型.忙 === "models" ? "问端点中…" : "看看这家有哪些模型"}
            </button>
            {缺项(模型.form).length > 0 ? (
              <span className="text-xs text-fg-disabled">
                还差：{缺项(模型.form).join(" / ")}
              </span>
            ) : null}
          </div>
          <p className="text-xs text-fg-disabled">
            嵌入模型那一格<strong className="text-fg-2">可以留空</strong>
            ：DeepSeek、Anthropic 这类只有对话端点，Kimi 的嵌入要单独申请。留空不是
            "没配好"，是语义那一路不开、检索只走关键词与链接——问答照旧能用（它靠的是
            检索回来的片段）。这一格与"测试连通"读的都是
            <strong className="text-fg-2">已经存进盘上的那份地址</strong>
            ，改完先按「保存配置」。
          </p>
        </div>
        {模型.发现 ? (
          <div className="mt-5 max-w-2xl rounded-md border border-line bg-raised px-4 py-3">
            <div className="font-mono text-xs text-fg-2">
              端点给了 {模型.发现.all.length} 个模型｜{模型.发现.ms}ms｜其中含
              <span className="mx-1">embed</span>的 {模型.发现.embedCandidates.length} 个
            </div>
            {模型.发现.embedCandidates.length > 0 ? (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="text-xs text-fg-2">可以填进嵌入模型那一格：</span>
                {模型.发现.embedCandidates.map((m) => (
                  <button
                    key={m}
                    className={
                      "rounded-md border px-3 py-1 font-mono text-xs transition-colors duration-(--dur-1) " +
                      (模型.form.embeddingModel === m
                        ? "border-accent text-fg"
                        : "border-line text-fg-2 hover:bg-hover")
                    }
                    title="点一下就填进上面那一格（还要按「保存配置」才落盘）"
                    onClick={() => 模型.setForm({ ...模型.form, embeddingModel: m })}
                  >
                    {m}
                  </button>
                ))}
              </div>
            ) : (
              <p className="mt-2 text-sm text-fg-2">
                这一家<strong className="text-fg">没有</strong>名字里含
                <span className="mx-1 font-mono">embed</span>
                的模型，多半确实不提供嵌入接口。那就把上面那一格空着——
                检索走关键词与链接，问答照旧。
              </p>
            )}
            {模型.发现.all.length > 0 ? (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-fg-2">
                  它给的全部模型（{模型.发现.all.length}）
                </summary>
                <div className="mt-1 flex flex-wrap gap-2">
                  {模型.发现.all.map((m) => (
                    <span key={m} className="font-mono text-xs text-fg-2">
                      {m}
                    </span>
                  ))}
                </div>
              </details>
            ) : null}
          </div>
        ) : null}
        {模型.报告 ? (
          <div className="mt-7 flex max-w-2xl flex-col gap-1">
            <h4 className="text-sm text-fg-2">
              测试结果
              <span
                className={"ml-2 text-xs " + (模型.报告.ok ? "text-success" : "text-danger")}
              >
                {探针结论(模型.报告.ok, 模型.报告.steps)}
              </span>
            </h4>
            {模型.报告.steps.map((r, i) => (
              <div
                key={i}
                className={
                  "rounded-md border px-3 py-2 text-sm " +
                  (r.ok ? "border-line" : "border-danger bg-danger-soft")
                }
              >
                <span className="text-fg">{步骤名(r.stage)}</span>
                <span className="ml-2 font-mono text-xs text-fg-2">{r.ms}ms</span>
                <div className="mt-1 break-words text-xs text-fg-2">{r.detail}</div>
              </div>
            ))}
            <p className="mt-1 text-xs text-fg-disabled">
              每个启用的探针只发一个最小请求，内容是一段固定文本{" "}
              <span className="font-mono text-mono">ping</span>
              ，不会把任何笔记内容发出去。
            </p>
          </div>
        ) : null}
        <p className="mt-5 max-w-2xl text-sm text-fg-2">
          配好之后左下角「问答」那一格就能问了（<span className="font-mono text-mono">Ctrl+K</span>{" "}
          里也有）。要在文档里直接改字：选中一段文字，气泡条上的「AI」会把你写的
          要求交给它——<span className="text-fg">回稿先给你看，点「替换选中」才落盘</span>，
          送出去的只有选中的那段。整理建议、自动打标还没做——那是 M3 的活。
        </p>
      </section>

      <section className="mt-8 border-t border-line pt-6">
        <h3 className="text-sm text-fg-2">库与关于</h3>
        <div className="mt-3 rounded-md border border-line bg-raised px-4 py-3 text-sm">
          {info?.vaultPath ? (
            <span>
              当前库 <span className="font-mono text-mono">{info.vaultPath}</span> · 索引里{" "}
              {info.indexNotes} 篇
            </span>
          ) : (
            <span className="text-danger">还没打开任何目录。</span>
          )}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <input
            className={路径框}
            value={库草稿}
            spellCheck={false}
            placeholder={info?.vaultPath ?? "D:\\Notes"}
            onChange={(e) => set库草稿(e.target.value)}
            onKeyDown={(e) => {
              if (是回车提交(e) && 库草稿.trim()) 库.打开(库草稿.trim());
            }}
          />
          <button
            className={btnPrimary}
            disabled={库.忙 || !库草稿.trim() || 库草稿.trim() === info?.vaultPath}
            onClick={() => 库.打开(库草稿.trim())}
          >
            {库.忙 ? "打开中…" : "打开这个目录"}
          </button>
        </div>
        <p className="mt-2 text-xs text-fg-disabled">
          切过去之前会先把正在编辑的那一篇存下。目录不存在时会新建，不会动里面已有的文件；
          索引与配置在里面的 <span className="font-mono text-mono">.note/</span>，删掉它能重建。
        </p>

        <h4 className="mt-7 text-sm text-fg-2">哪些跟着库走，哪些跟着这台电脑走</h4>
        <div className="mt-2 flex flex-col gap-1">
          {配置归属.map((行) => (
            <div
              key={行.项}
              className="flex flex-wrap items-baseline gap-2 rounded-md border border-line px-3 py-2 text-xs"
            >
              <span className="min-w-0 flex-1 text-fg-2">{行.项}</span>
              <span className="font-mono text-mono">{行.落在哪}</span>
              <span className={行.随库走 ? "text-success" : "text-danger"}>
                {行.随库走 ? "拷库带走" : "换机重来"}
              </span>
            </div>
          ))}
        </div>
        <p className="mt-2 text-xs text-fg-disabled">
          把库拷到另一台电脑，笔记、备份目录与端点地址都在；深浅色要重新选一次，
          Key 要重新输一次——这是刻意的安全取舍，不改成明文落盘。
        </p>
        <p className="mt-6 text-xs text-fg-disabled">
          知更 {info?.version ?? ""} · 落盘格式 schema v{info?.schemaVersion ?? "?"}
        </p>
      </section>
    </div>
  );
}
