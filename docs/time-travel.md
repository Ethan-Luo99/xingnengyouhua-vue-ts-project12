# 确定性回放 + 快照恢复（时间旅行）

在既有 Worker + OffscreenCanvas 架构上，为模拟内核增加三项能力：

- **确定性**：模拟结果完全由 `(初始状态, 控制消息序列)` 决定。
- **快照**：任意帧边界导出完整可恢复快照，经 Transferable ArrayBuffer（Worker 路径）或结构化克隆二进制（回退路径）传输，无损恢复并继续。
- **回放**：Worker 侧录制控制消息序列，从同一初始状态重放到指定帧，末帧哈希与首跑一致。

## 1. 确定性来源审查

对内核逐项排查非确定性来源：

| 来源 | 结论 | 处理 |
|---|---|---|
| `Math.random` | 原本存在于节点播种 `state.ts`，新增节点会消费 RNG | 替换为**状态化 mulberry32 PRNG**，32 位状态存于 `SimState.rngState`，随 SoA/快照一起保存恢复；固定种子 `DEFAULT_SEED` |
| 对象遍历顺序（`for..in` / `Object.keys/entries/values`） | 内核中不存在 | 全部状态为定长 TypedArray，遍历均为 `for (let i=0;i<n;i++)` 索引升序 |
| 浮点累加顺序 | 力、碰撞、积分均为单节点独立顺序循环；碰撞按网格 `cell → offset → entry` 与节点索引确定性顺序处理（`j > i` 去重） | 无跨节点求和，累加顺序固定；`dt` 统一为常量 `FIXED_DT = 1/60`，回放不再依赖真实帧间隔 |
| 哈希遍历 | `hash.ts` 按 `[0,count)` 固定字节序 FNV-1a | 网格（派生数据，每帧重建）与 accumulator/墙钟不参与哈希 |
| 墙钟 / `performance.now` | 仅用于 RAF 调度、累加器、fps 采样 | 不进入模拟状态与状态哈希；回放用固定步长推进 |
| `Array.sort` | 仅 `sampler.ts` 对遥测样本排序 | 属于 HUD 统计，不影响模拟 |

同一消息序列跑两遍，到第 N 帧的 `SimState` 逐位一致（`?selftest=1` 与 UI 回放均验证）。

## 2. 模块划分

- `sim-core.ts`：纯确定性内核 `SimCore`，拥有 SoA 状态、网格、固定 pipeline，提供 `step()/setViewport()/setNodeCount()`，不含渲染/定时器/事件源。Worker 运行时、主线程回退、自检三者共用，保证同一套确定性代码。
- `state.ts`：SoA 状态 + 状态化 PRNG（mulberry32）。
- `hash.ts`：FNV-1a 确定性状态哈希（小端字节序，含全部活动 SoA 缓冲 + 尺寸/计数/RNG）。
- `snapshot.ts`：二进制快照编解码，单个小端 `ArrayBuffer`（魔数 `SNP1` + 版本 + 定长头 + SoA + 网格 + accumulator/frame/paused/RNG），带容量/魔数/版本/长度校验。
- `timeline.ts`：`ControlJournal`，定长 32 字节二进制记录（帧号/类型/两个 f64 参数），可增长缓冲、零 JSON。
- `selftest.ts`：600 帧脚本化首跑、消息回放、快照恢复三条复现路径与哈希比对。
- `worker-runtime.ts` / `main-engine.ts`：分别在 Worker 与主线程复用 `SimCore`，实现录制/回放/快照导入导出/自检与遥测。

## 3. 快照格式

单个可传输 `ArrayBuffer`，64 字节小端头 + 4 字节对齐区域：

- 头：魔数、版本、capacity、count、width、height、accumulator、frame、paused、rngState、网格 cellSize/cols/rows。
- 区域：`x,y,vx,vy,radius`(f32×cap)、`color`(u8×cap)、网格 `counts/offsets/entries`。

网格虽是每帧由状态确定性重建的派生数据，也一并写入，使恢复逐字节完整而非懒重建。

- Worker 路径：`postMessage(buffer, [buffer])` **Transferable 零拷贝**。
- 回退路径：无 Worker 边界，使用 `structuredClone(buffer)` 走**结构化克隆二进制**；UI 徽标与本文件均显式标注，不静默降级为 JSON。
- 全程无 JSON 承载状态。

## 4. 录制—回放语义

- 开始录制：清空日志、对当前状态拍**基线快照**；此后在 Worker 侧记录 `viewport/node-count/pause` 及应用时的绝对帧号。
- 回放：恢复基线快照 → 从基线帧按固定步长 `step()`，消息按“先应用当前帧消息、再推进到下一帧”的实时语义重放，保证与首跑时序一致 → 到目标帧后自动暂停。
- 帧号为绝对帧号；回放目标钳制到不早于基线帧。
- 回放结束、停止录制、导入快照时立即补发一帧精确 stats，避免 500ms 遥测节流导致 HUD 显示陈旧帧号/哈希。

## 5. 协议与生命周期

所有新消息纳入既有可辨识联合（`MainToWorkerMessage` / `WorkerToMainMessage`），TypeScript 穷尽 `switch` 覆盖：

- 主线程→Worker：`record`、`replay`、`snapshot-export/-import`、`selftest`、`selftest-buffers`。
- Worker→主线程：`timeline`（帧号/哈希/录制/回放/消息数/暂停）、`snapshot-exported/-imported`、`selftest-report`、`selftest-snapshots`。
- stats 二进制扩展为 28 字节，追加当前帧号与状态哈希。

StrictMode 双挂、terminate 后重挂、页面离开/返回均验证仅保留一个活跃 Worker；卸载时 reject 未决快照 Promise。时间旅行 API 在 Worker 与回退引擎上签名一致，运行中 Worker 崩溃会透明切换到主线程回退并继续提供录制/快照/回放（传输方式变为结构化克隆）。

## 6. 自检 `?selftest=1`

页面带 `?selftest=1` 时，Worker（或回退引擎）自动：

1. 从固定初始状态脚本化跑 **600 帧**，每 60 帧记录一次状态哈希（含中途改节点数、resize、暂停/恢复）。
2. **消息序列回放**：全新内核 + 同一日志重放，记录同样检查点。
3. **快照恢复**：帧 0 与帧 300 快照先跨边界往返（Worker：转移到主线程再转回；回退：结构化克隆），再恢复并继续到 600 帧。
4. 三方哈希逐点比对，结果 `PASS/FAIL` 打印到控制台表格与 HUD 徽标。

## 7. UI

控件区新增最小交互，风格与既有按钮一致：录制/停止录制、回放至 N 帧、回放、导出快照（下载 `.snp`）、导入快照（文件选择）、自检。HUD 常驻显示当前帧号与状态哈希，录制/回放/自检结果以徽标展示。Canvas 仍为 Canvas 2D，无新增运行时依赖。
