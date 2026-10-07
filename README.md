# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend enabling type-aware lint rules by installing `oxlint-tsgolint` and editing `.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "options": {
    "typeAware": true
  },
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }]
  }
}
```

See the [Oxlint rules documentation](https://oxc.rs/docs/guide/usage/linter/rules) for the full list of rules and categories.

## 时间旅行：确定性回放 + 快照恢复

模拟内核完全确定性：结果只由 `(固定种子的初始状态, 控制消息序列)` 决定。

- **确定性 RNG**：`src/engine/rng.ts`（Mulberry32），取代 `Math.random`。
- **纯内核**：`src/engine/sim-kernel.ts`（`SimCore`），Worker 与主线程回退共用同一物理实现。
- **快照**：控件「导出快照 / 导入快照」，单个小端二进制 `ArrayBuffer`（魔数 `SNAP`，含 SoA 全量缓冲、
  逻辑宽高、`accumulator`、RNG 状态、`count`、`paused`、帧号），Worker 收发走 Transferable，禁用 JSON。
- **录制/回放**：「录制/停止录制」记录按逻辑帧锚定的控制消息（含录制开始基线快照），「回放」从基线
  逐位重建录制结束时刻状态（含暂停标志）。
- **HUD**：实时显示「帧 N」「状态哈希」；回退路径用徽标标注「主线程回退」，两条路径能力对齐。

详见 [`docs/performance-design.md`](docs/performance-design.md) 第 9 节（含确定性审计表）。

### 自检

访问 `/?selftest=1`：内核自动跑 600 帧、每 60 帧记录状态哈希，随后分别用「快照恢复」和「消息序列回放」
各复现一次，三方哈希逐位对比，结果打印到控制台并显示「自检 PASS/FAIL」徽标。

零依赖 CDP 驱动脚本（需本地 dev server）：

```bash
npm run dev
node scripts/selftest.mjs http://127.0.0.1:5173/?selftest=1
node scripts/selftest.mjs "http://127.0.0.1:5173/?fallback&selftest=1"   # 主线程回退
```
