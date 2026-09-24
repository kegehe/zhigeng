import { useEffect, useState } from "react";
import { api } from "./ipc/commands";
import type { AppInfo } from "./ipc/types";

/**
 * 首启界面。docs/03 定的规矩是"默认路径必须让用户确认，不能静默创建"，
 * 所以这里把路径直接摊开成可编辑输入框，而不是藏在一个"确定"按钮后面。
 */
export function FirstRun({ onOpened }: { onOpened: (info: AppInfo) => void }) {
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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
      onOpened(await api.vaultOpen(target));
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-base px-6 py-8">
      <div className="w-full max-w-144 rounded-lg border border-line bg-raised p-8 shadow-2">
        <h1 className="text-2xl text-fg">选一个目录放你的笔记</h1>
        <p className="mt-3 text-fg-2">笔记就是这个目录里的一堆 <span className="font-mono text-mono">.md</span> 文件，用任何编辑器打开都不会坏。</p>
        <p className="mt-2 text-fg-2">索引和缓存放在里面的 <span className="font-mono text-mono">.note/</span>，删掉它也能重建。</p>
        <label className="mt-6 block text-sm text-fg-2" htmlFor="vault-path">
          位置
        </label>
        <input
          id="vault-path"
          className="mt-2 w-full rounded-md border border-line bg-base px-3 py-2 font-mono text-mono text-fg focus-visible:border-accent"
          value={path}
          spellCheck={false}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void open();
          }}
        />
        <div className="mt-6 flex items-center gap-3">
          <button
            className="rounded-md bg-accent px-4 py-2 text-sm text-on-accent transition-colors duration-(--dur-1) hover:bg-accent-hover disabled:bg-active disabled:text-fg-disabled"
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
