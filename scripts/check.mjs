// 一条命令跑完所有门禁。仓库没有远端，所以也没有 CI——门禁不会自己跑，
// 但它必须**一条命令就能跑**，否则"提交前清单"就是一句客套话。
//
//   node scripts/check.mjs            # 快档：fmt / clippy / Rust 测试 / tsc / vitest / 护栏
//   node scripts/check.mjs --bench    # 再加性能门禁（ipc-bench + write-bench，几分钟）
//
// 加 git hook：把 scripts/hooks/pre-push 接进 git（一次即可，脚本不会替你改 git 配置）
//   git config core.hooksPath scripts/hooks
import { spawnSync } from "node:child_process";

const bench = process.argv.includes("--bench");

const steps = [
  ["cargo fmt --all --check", () => ["cargo", ["fmt", "--all", "--check"]]],
  // `-D warnings`：clippy 的 `correctness = deny` 只挡硬错，不设这条则"0 条"全靠自觉
  ["cargo clippy --workspace --all-targets -- -D warnings", () => ["cargo", ["clippy", "--workspace", "--all-targets", "--", "-D", "warnings"]]],
  ["cargo test --workspace", () => ["cargo", ["test", "--workspace"]]],
  ["pnpm typecheck", () => ["pnpm", ["typecheck"]]],
  ["pnpm test", () => ["pnpm", ["test"]]],
  ["node scripts/guard.mjs", () => ["node", ["scripts/guard.mjs"]]],
];

if (bench) {
  // 性能红线是"会慢慢被后来的 PR 磨掉"的那类约束，所以数字写在 perf-budget.json，
  // 判定写在 Rust 里（超线即非零退出），这里只负责把它接到同一条命令上。
  steps.push(
    ["note ipc-bench（同步 IPC p95 ≤ 8ms）", () => ["cargo", ["run", "-q", "-p", "note-cli", "--", "ipc-bench"]]],
    ["note write-bench（写命令同步那一半 p95 ≤ 8ms）", () => ["cargo", ["run", "-q", "-p", "note-cli", "--", "write-bench"]]],
  );
}

const bad = [];
for (const [label, mk] of steps) {
  const [cmd, args] = mk();
  process.stdout.write(`\n\u001b[1m▶ ${label}\u001b[0m\n`);
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32" });
  if (r.status === 0) {
    process.stdout.write(`  \u001b[32m✓\u001b[0m ${label}\n`);
  } else {
    bad.push(label);
    process.stdout.write(`  \u001b[31m✗ ${label}（退出码 ${r.status}）\u001b[0m\n`);
  }
}

process.stdout.write("\n");
if (bad.length) {
  process.stdout.write(`\u001b[31m门禁未过 ${bad.length} 项：\n  ${bad.join("\n  ")}\u001b[0m\n`);
  process.exit(1);
}
process.stdout.write(`\u001b[32m门禁全绿（${steps.length} 项${bench ? "，含性能" : "，快档"}）\u001b[0m\n`);
