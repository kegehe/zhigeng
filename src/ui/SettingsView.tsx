import { useState, type KeyboardEvent, type ReactNode } from "react";
import { btn, btnPrimary, 路径框 } from "./controls";
import { 缺项, 步骤名, 探针结论 } from "./ai";
import { 是回车提交 } from "./keys";
import { 主题档位, 判备份, 配置归属, type AI忙, type AI表单 } from "./settings";
import type { Theme } from "./theme";
import type { AppInfo, AiDiscovery, AiProbeReport, AiView } from "../ipc/types";

/**
 * 一行设置：标签在左、控件在右，行与行之间只有一条细线。
 *
 * 上一版是四张卡片，每张卡还带"标题 + 摘要 + 正文 + 脚注"四层——四格摊开就是一堆小字。
 * 设置页要的是**能扫**：这一行改什么、现在是什么值。解释只在控件本身说不清时才留一截，
 * 且贴在标签后面，不再另起一段。
 */
function 行(props: { 标签: string; 提示?: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
      <span className="flex w-28 shrink-0 items-baseline gap-1 whitespace-nowrap text-xs text-fg-2">
        <span>{props.标签}</span>
        {props.提示 ? <span className="text-fg-disabled">{props.提示}</span> : null}
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{props.children}</div>
    </div>
  );
}

/**
 * 一组设置。没有卡片底色、没有摘要：一条横线起头，组名 + 状态，下面就是行。
 * `尾` 留给"点完才有"的东西（测试结果、模型清单），它们跟在行动作的正下方。
 */
function 节(props: { 标题: string; 角?: ReactNode; 尾?: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-8">
      <div className="flex items-baseline gap-3">
        <h3 className="text-sm font-medium text-fg">{props.标题}</h3>
        {props.角 ? <div className="ml-auto">{props.角}</div> : null}
      </div>
      <div className="mt-2 divide-y divide-line border-y border-line">{props.children}</div>
      {props.尾 ? <div className="mt-3 max-w-2xl">{props.尾}</div> : null}
    </section>
  );
}

/** 状态：一枚圆点 + 两个字。带框的胶囊在一页里出现四次，本身就是噪声 */
function 状态(props: { 调: "ok" | "off" | "danger"; children: ReactNode }) {
  // 文字一律用次要色或 danger：实测亮面 --success 对页面底只有 4.37:1、--warning 3.04:1，
  // 12px 的正文过不了 AA 4.5。颜色留给**圆点**（图标线 3:1），它只是辅助，状态本身由字说清；
  // 未配置也不是"禁用"，docs/06 §2 说 --text-disabled 只留给 placeholder 与提示语。
  const 色 = props.调 === "danger" ? "text-danger" : "text-fg-2";
  const 点 =
    props.调 === "ok" ? "bg-success" : props.调 === "danger" ? "bg-danger" : "bg-fg-2";
  return (
    <span className={"flex items-center gap-1 text-xs " + 色}>
      <span className={"h-1 w-1 shrink-0 rounded-full " + 点} aria-hidden="true" />
      {props.children}
    </span>
  );
}

/**
 * 设置页：主区的一档，不是浮层。
 *
 * 为什么走主区——AI 那一格连模型清单带测试结果有一屏多，塞进模态要么挤要么得拆薄；
 * 而"切走之前先把正文落盘"这条纪律（`openSettings` 里的 `persist`）是备份面板已经跑通的。
 * 代价说清楚：打开设置会把正在编辑的那一篇存下并卸载，回来重新装载。
 *
 * 版面是一条一条的设置行，按**改完会不会动这个库**排：外观只改这台电脑，备份与模型改的是
 * 库里的配置，最后是换库与"哪些跟着库走"。说明基本只在控件说不清的地方出现（"可留空"
 * "已存 …7788"），产品口径交给 docs 与各面板自己的正文。
 */
export function SettingsView(props: {
  info: AppInfo | null;
  flash: string | null;
  /**
   * 回正文的那一条路。
   *
   * 齿轮是**入口**不是开关：开着设置时再按它，App 那边直接什么都不做（从前会重进一次，
   * 把刚填的备份目录、模型字段、测试结果一起清掉）。侧栏底栏那几格（回收站/导入/备份/
   * 问答）才是开关，齿轮不在那一排里——于是设置页必须自己带一条出去的路，否则它就是个
   * 进得去出不来的地方。**这一页也不接住齿轮那一下**：那是标题栏的事，不归视图。
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

  // 状态与判据都看**盘上那份**（`view`），不看草稿：草稿填齐了但没保存，仍然不算配好。
  // 这两个也决定"测试连通""列出可用模型"能不能按——它们读的都是已保存的配置。
  const 模型已配 = 模型.view !== null && 缺项(模型.view).length === 0;
  const 已存有地址 = !!模型.view?.baseUrl?.trim();
  const 未保存 =
    !!模型.view &&
    (模型.form.baseUrl !== 模型.view.baseUrl ||
      模型.form.chatModel !== 模型.view.chatModel ||
      模型.form.embeddingModel !== 模型.view.embeddingModel ||
      模型.form.rerank !== 模型.view.rerank);
  const 随库 = 配置归属.filter((行) => 行.随库走);
  const 本机 = 配置归属.filter((行) => !行.随库走);

  /**
   * 设置页输入框里的 Esc：**把这一格退回现在生效的那个值**（或清空草稿）。
   *
   * 这一键以前在输入框里是死的：全局那条 Esc 在 INPUT/TEXTAREA/SELECT 上一律 return，
   * 而这一页的输入框自己没有任何 Escape 行为——于是"刚打完字想退出"按下去什么都不发生，
   * 要离开只能 Tab 到「返回正文」。给它一个真含义，比让键沉默好：
   * 备份目录退回盘上那份、模型三格退回 `view`、Key 与「换到」清空草稿。
   * 组词中的 Esc 不算（中文输入法用它取消候选）。
   */
  const 退格 = (e: KeyboardEvent<HTMLInputElement>, 回: () => void): boolean => {
    if (e.key !== "Escape" || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) {
      return false;
    }
    e.preventDefault();
    e.stopPropagation();
    回();
    return true;
  };

  return (
    <div className="measure-ui px-6 pt-8 pb-16">
      {/* 提示浮在右下角，不占版面：这一页存配置的位置在中段，页顶那行 flash 早滚出去了 */}
      {props.flash ? (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none fixed right-5 bottom-5 z-(--z-toast) max-w-sm rounded-md border border-line bg-raised px-3 py-2 text-xs text-fg-2 shadow-2"
        >
          {props.flash}
        </div>
      ) : null}

      <header className="flex items-center gap-3">
        <h2 className="text-xl text-fg">设置</h2>
        <button className={btn + " ml-auto"} onClick={props.onBack}>
          返回正文
        </button>
      </header>

      <节 标题="外观">
        <行 标签="主题">
          {/* 用原生 select：控件行为与键盘都得是原生的（[06] §4 判死了自造下拉） */}
          <select
            aria-label="主题"
            className="w-32 rounded-md border border-line bg-page px-2 py-1 text-xs text-fg"
            value={外观.theme}
            onChange={(e) => 外观.setTheme(e.target.value as Theme)}
          >
            {主题档位.map((档) => (
              <option key={档.值} value={档.值}>
                {档.标签}
              </option>
            ))}
          </select>
        </行>
      </节>

      <节
        标题="备份"
        角={
          <div className="flex items-center gap-3">
            {备份格.档 === "开着" && 备份格.时刻 ? (
              <span className="text-xs text-fg-2">
                最近{" "}
                {new Date(备份格.时刻).toLocaleString(undefined, {
                  dateStyle: "short",
                  timeStyle: "short",
                })}
              </span>
            ) : null}
            <状态 调={备份格.档 === "开着" ? "ok" : "danger"}>
              {备份格.档 === "开着" ? "已开启" : 备份格.档 === "关着" ? "已关闭" : "未配置"}
            </状态>
          </div>
        }
      >
        <行 标签="备份目录">
          <input
            aria-label="备份目录"
            className={路径框 + " max-w-md"}
            value={备份.draft}
            spellCheck={false}
            placeholder="另一块盘或 NAS 上的目录"
            onChange={(e) => 备份.setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Esc 退回盘上那份（没有第二层含义，但也不许沉默——见 `退格`）
              if (退格(e, () => 备份.setDraft(info?.backupDir ?? ""))) return;
              if (!是回车提交(e) || 备份.忙) return;
              const 目标 = 备份.draft.trim();
              if (目标) 备份.应用(目标);
            }}
          />
          {/* 「现在」这一句是这个行**唯一**说明"盘上正在生效的是哪儿"的地方：
              输入框装的是草稿（取消备份之后它也还留着上次那个路径），不写这一句，
              屏幕上唯一那条路径恰好是已经不在生效的那条。 */}
          <span className="text-xs text-fg-2">
            {备份格.档 === "开着"
              ? `现在：${备份格.目录}`
              : 备份格.档 === "关着"
                ? "现在：不备份"
                : "还没设过备份目录"}
          </span>
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
        </行>
      </节>

      <节
        标题="模型与 Key"
        角={
          <状态 调={模型已配 ? "ok" : "off"}>{模型已配 ? "已配置" : "未配置"}</状态>
        }
        尾={
          <>
            {/* 结果贴着行动作：点完就在下面，不再隔着几段说明 */}
            {模型.报告 ? (
              <div>
                <div className="flex flex-wrap items-baseline gap-2 text-xs">
                  <span className="text-fg">测试结果</span>
                  {/* 结论用次要色（--success 4.37:1 不够 AA），失败那档才用红（5.15:1） */}
                  <span className={模型.报告.ok ? "text-fg-2" : "text-danger"}>
                    {探针结论(模型.报告.ok, 模型.报告.steps)}
                  </span>
                </div>
                <div className="mt-2 divide-y divide-line overflow-hidden rounded-md border border-line">
                  {模型.报告.steps.map((r, i) => (
                    <div key={i} className={"px-3 py-2 text-sm " + (r.ok ? "" : "bg-danger-soft")}>
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span className="text-fg">{步骤名(r.stage)}</span>
                        <span className="font-mono text-xs text-fg-2">{r.ms}ms</span>
                      </div>
                      <div className="mt-1 break-words text-xs text-fg-2">{r.detail}</div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {模型.发现 ? (
              <div className="mt-3 rounded-md border border-line px-3 py-2">
                <div className="font-mono text-xs text-fg-2">
                  {模型.发现.all.length} 个模型 · {模型.发现.ms}ms · 含 embed 的{" "}
                  {模型.发现.embedCandidates.length} 个
                </div>
                {模型.发现.embedCandidates.length > 0 ? (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <span className="text-xs text-fg-2">填进嵌入模型：</span>
                    {模型.发现.embedCandidates.map((m) => (
                      <button
                        key={m}
                        className={
                          "rounded-md border px-3 py-1 font-mono text-xs transition-colors duration-(--dur-1) " +
                          (模型.form.embeddingModel === m
                            ? "border-accent text-fg"
                            : "border-line text-fg-2 hover:bg-hover")
                        }
                        title="点一下填入「嵌入模型」，再按「保存配置」"
                        onClick={() => 模型.setForm({ ...模型.form, embeddingModel: m })}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="mt-1 text-xs text-fg-2">这家没有嵌入模型。</p>
                )}
                {模型.发现.all.length > 0 ? (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-fg-2">
                      全部模型（{模型.发现.all.length}）
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
          </>
        }
      >
        <行 标签="接口地址">
          <input
            aria-label="接口地址"
            className={路径框 + " max-w-md"}
            value={模型.form.baseUrl}
            spellCheck={false}
            placeholder="https://api.openai.com/v1"
            onChange={(e) => 模型.setForm({ ...模型.form, baseUrl: e.target.value })}
            onKeyDown={(e) =>
              退格(e, () => 模型.setForm({ ...模型.form, baseUrl: 模型.view?.baseUrl ?? "" }))
            }
          />
        </行>
        <行 标签="对话模型">
          <input
            aria-label="对话模型"
            className={路径框 + " max-w-md"}
            value={模型.form.chatModel}
            spellCheck={false}
            placeholder="gpt-4o-mini"
            onChange={(e) => 模型.setForm({ ...模型.form, chatModel: e.target.value })}
            onKeyDown={(e) =>
              退格(e, () =>
                模型.setForm({ ...模型.form, chatModel: 模型.view?.chatModel ?? "" }),
              )
            }
          />
        </行>
        <行 标签="嵌入模型" 提示="可留空">
          <input
            aria-label="嵌入模型"
            className={路径框 + " max-w-md"}
            value={模型.form.embeddingModel}
            spellCheck={false}
            placeholder="text-embedding-3-small"
            onChange={(e) => 模型.setForm({ ...模型.form, embeddingModel: e.target.value })}
            onKeyDown={(e) =>
              退格(e, () =>
                模型.setForm({ ...模型.form, embeddingModel: 模型.view?.embeddingModel ?? "" }),
              )
            }
          />
        </行>
        <行 标签="API Key">
          <input
            aria-label="API Key"
            className={路径框 + " max-w-md"}
            value={模型.key}
            type="password"
            spellCheck={false}
            placeholder="sk-…"
            onChange={(e) => 模型.setKey(e.target.value)}
            // Esc 清掉这一格草稿：已经存进去的那把在凭据管理器里，这里只是输入框
            onKeyDown={(e) => 退格(e, () => 模型.setKey(""))}
          />
          {/* 存与删是**两枚**按钮：以前共用一枚，存成功后它当场翻成"删除 Key"——
              用户双击保存的第二下正好落在删除上，刚存进去的那把就没了 */}
          <button
            className={btn}
            disabled={模型.忙 !== null || !模型.key.trim()}
            onClick={模型.存Key}
          >
            {/* 忙态要落在**按下那一枚**上：两枚按钮共用一个 `忙`，键里有没有字才分得出
                这一次跑的是"存"还是"删"——否则按删除时亮的是"存 Key → 处理中…"，正好指反 */}
            {模型.忙 === "key" && !!模型.key.trim() ? "保存中…" : "存 Key"}
          </button>
          {模型.view?.keyHint ? (
            <span className="text-xs text-fg-2">已存 {模型.view.keyHint}</span>
          ) : null}
          {模型.view?.keySet ? (
            <button
              className={btn}
              disabled={模型.忙 !== null || !!模型.key.trim()}
              title={模型.key.trim() ? "先清空输入框，再删这把 Key" : "删掉已存的 Key"}
              onClick={模型.存Key}
            >
              {模型.忙 === "key" && !模型.key.trim() ? "删除中…" : "删除 Key"}
            </button>
          ) : null}
        </行>
        <行 标签="检索重排">
          {/* 行标签已经说了这一格是什么，勾选框不再重复一遍；代价（每次多打一趟模型）在 title 里 */}
          <input
            type="checkbox"
            aria-label="检索重排"
            title="开启后每次搜索会多调用一次模型；失败时自动改用普通排序。"
            className="accent-(--accent)"
            checked={模型.form.rerank}
            onChange={(e) => 模型.setForm({ ...模型.form, rerank: e.target.checked })}
          />
        </行>
        <行 标签="">
          {/* 读不到盘上那份（view 为 null）时不许保存：这时格子里是空的，一按就把原配置写成空。
              读失败的原因由 App 顶部那条错误横幅说，不在这里再占一行字。 */}
          <button
            className={btnPrimary}
            disabled={模型.忙 !== null || 模型.view === null}
            onClick={模型.保存}
          >
            {模型.忙 === "save" ? "保存中…" : "保存配置"}
          </button>
          <button
            className={btn}
            disabled={模型.忙 !== null || !模型已配}
            title="用已保存的配置做一次连通测试，不会发送笔记内容。"
            onClick={模型.测试}
          >
            {模型.忙 === "test" ? "测试中…" : "测试连通"}
          </button>
          <button
            className={btn}
            disabled={模型.忙 !== null || !已存有地址}
            title="查看这个服务提供哪些模型。只读取列表，不会发送笔记内容。"
            onClick={模型.发现模型}
          >
            {模型.忙 === "models" ? "读取中…" : "列出可用模型"}
          </button>
          {/* 动作读的是**盘上**那份，草稿没保存时这里必须说清楚，否则测的是旧地址还以为是新的 */}
          {未保存 ? (
            <span className="text-xs text-fg-2">
              {模型已配 ? "有改动没保存 · 测试用的是已保存的配置" : "有改动没保存 · 先保存再测试"}
            </span>
          ) : null}
        </行>
      </节>

      <节
        标题="库与关于"
        角={
          info ? (
            <span className="text-xs text-fg-2">索引 {info.indexNotes} 篇</span>
          ) : undefined
        }
      >
        <行 标签="当前库">
          {info?.vaultPath ? (
            <span className="break-all font-mono text-mono text-fg-2">{info.vaultPath}</span>
          ) : (
            <span className="text-sm text-danger">还没打开任何目录</span>
          )}
        </行>
        <行 标签="换到">
          <input
            aria-label="要打开的新库目录"
            className={路径框 + " max-w-md"}
            value={库草稿}
            spellCheck={false}
            placeholder="另一个目录的完整路径"
            onChange={(e) => set库草稿(e.target.value)}
            onKeyDown={(e) => {
              if (退格(e, () => set库草稿(""))) return;
              if (!是回车提交(e) || 库.忙) return;
              const 目标 = 库草稿.trim();
              // 与「打开这个目录」同一道门：同一个路径、空串都不重开
              if (目标 && 目标 !== info?.vaultPath) 库.打开(目标);
            }}
          />
          <button
            className={btnPrimary}
            disabled={库.忙 || !库草稿.trim() || 库草稿.trim() === info?.vaultPath}
            onClick={() => 库.打开(库草稿.trim())}
          >
            {库.忙 ? "打开中…" : "打开这个目录"}
          </button>
        </行>
        <行 标签="跟着库走">
          <span className="text-xs text-fg-2">{随库.map((x) => x.项).join("、")}</span>
          <span className="font-mono text-xs text-fg-2">{随库[0]?.落在哪}</span>
        </行>
        <行 标签="跟着本机">
          {本机.map((x, i) => (
            <span key={x.项} className="text-xs text-fg-2">
              {i > 0 ? "、" : ""}
              {x.项}
              <span className="text-fg-2">（{x.落在哪}）</span>
            </span>
          ))}
        </行>
      </节>

      <p className="mt-6 text-xs text-fg-2">
        知更 {info?.version ?? ""} · schema v{info?.schemaVersion ?? "?"}
      </p>
    </div>
  );
}
