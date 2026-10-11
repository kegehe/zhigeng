import { useEffect, useState } from "react";
import { api } from "./ipc/commands";
import type { AppInfo } from "./ipc/types";

const btnPrimary =
  "rounded-md bg-accent px-4 py-2 text-sm text-on-accent transition-colors duration-(--dur-1) hover:bg-accent-hover active:translate-y-px disabled:opacity-55";
const inputCls =
  "mt-2 w-full rounded-md border border-line bg-page px-3 py-2 font-mono text-mono text-fg focus-visible:border-accent";

/**
 * 首启界面。两步，都要用户亲手确认：
 *
 * 1. 库放哪儿。docs/03 定的规矩是"默认路径必须让用户确认，不能静默创建"，
 *    所以把路径摊开成可编辑输入框，而不是藏在一个"确定"按钮后面。
 * 2. 备份放哪儿。docs/03 §备份 的判据是"唯一副本 = 没有副本"，所以这一步不能省：
 *    要么给一个**别的盘上**的目录，要么显式选"我不备份"。没答过之前每次启动都会再问。
 */
export function FirstRun({ onOpened }: { onOpened: (info: AppInfo) => void }) {
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /** 非空 = 库已经选好了，现在停在第二步 */
  const [vault, setVault] = useState<AppInfo | null>(null);
  const [backup, setBackup] = useState("");

  useEffect(() => {
    api
      .vaultDefaultPath()
      .then(setPath)
      .catch((e) => setErr(String(e)));
  }, []);

  const open = async () => {
    const target = path.trim();
    if (!target || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const info = await api.vaultOpen(target);
      if (info.backupUnconfigured) {
        setVault(info);
        setBackup("");
      } else {
        onOpened(info);
      }
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const choose = async (dir: string | null) => {
    setBusy(true);
    setErr(null);
    try {
      onOpened(await api.backupSet(dir, dir === null));
    } catch (e) {
      setErr(String(e));
      setBusy(false);
    }
  };

  if (vault) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-page px-6 py-8">
        <div className="w-full max-w-144 rounded-lg border border-line bg-raised p-8 shadow-2">
          <h1 className="text-2xl text-fg">再给备份挑一个目录</h1>
          <p className="mt-3 text-fg-2">
            你的笔记只存在 <span className="font-mono text-mono">{vault.vaultPath}</span>{" "}
            这一块盘上。盘坏了就是全坏——所以这一步不是可选项。
          </p>
          <p className="mt-2 text-fg-2">
            挑<span className="text-fg">另一个盘</span>（或 NAS 挂载点）上的空目录，每天第一次启动时
            做一次增量快照，保留最近 30 份。
          </p>
          <label className="mt-6 block text-sm text-fg-2" htmlFor="backup-path">
            备份目录
          </label>
          <input
            id="backup-path"
            className={inputCls}
            value={backup}
            spellCheck={false}
            placeholder="E:\\笔记备份"
            onChange={(e) => setBackup(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && backup.trim()) void choose(backup.trim());
            }}
          />
          <div className="mt-6 flex items-center gap-3">
            <button
              className={btnPrimary}
              disabled={busy || !backup.trim()}
              onClick={() => void choose(backup.trim())}
            >
              {busy ? "设置中…" : "每天备份到这里"}
            </button>
            <button className="text-sm text-fg-disabled underline" disabled={busy} onClick={() => void choose(null)}>
              我不备份
            </button>
          </div>
          <p className="mt-4 text-sm text-fg-disabled">
            {err ? (
              <span className="text-danger">{err}</span>
            ) : (
              "备份目录不能选在库里面。这一步以后也能在界面左下角改。"
            )}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-page px-6 py-8">
      <div className="w-full max-w-144 rounded-lg border border-line bg-raised p-8 shadow-2">
        <h1 className="text-2xl text-fg">选一个目录放你的笔记</h1>
        <p className="mt-3 text-fg-2">笔记就是这个目录里的一堆 <span className="font-mono text-mono">.md</span> 文件，用任何编辑器打开都不会坏。</p>
        <p className="mt-2 text-fg-2">索引和缓存放在里面的 <span className="font-mono text-mono">.note/</span>，删掉它也能重建。</p>
        <label className="mt-6 block text-sm text-fg-2" htmlFor="vault-path">
          位置
        </label>
        <input
          id="vault-path"
          className={inputCls}
          value={path}
          spellCheck={false}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void open();
          }}
        />
        <div className="mt-6 flex items-center gap-3">
          <button
            className={btnPrimary}
            disabled={busy || !path.trim()}
            onClick={() => void open()}
          >
            {busy ? "建立中…" : "就用这个目录"}
          </button>
          <span className="text-sm text-fg-disabled">
            {err ? <span className="text-danger">{err}</span> : "目录不存在时会新建，不会动里面已有的文件"}
          </span>
        </div>
      </div>
    </div>
  );
}
