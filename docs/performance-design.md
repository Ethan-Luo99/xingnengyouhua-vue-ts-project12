# Canvas 2D 大规模节点实时可视化 —— 性能方案设计

> 技术栈：React 19 + TypeScript 6 + Vite 8，渲染目标 Canvas 2D。
> 目标：画布上大量节点，每帧执行数百个业务函数（力导向布局 + 邻近碰撞检测 + 状态更新 + 绘制），在 60Hz 屏幕稳定维持 60fps。
> 本文档为架构设计，不含实现代码。

## 硬性约束

- 保持 **Canvas 2D**，不得改用 WebGL / Three.js。
- 不引入重量级状态库或第三方渲染库，只用浏览器与 React 原生能力。
- 必须兼容 **StrictMode 双调用与卸载重挂**，不产生重复循环或内存泄漏。
- 必须正确处理 **devicePixelRatio 与 resize**。

---

## 1. 技术栈理解：影响性能方案的关键点

- **React 19 渲染模型**：`createRoot` 并发渲染 + 自动批处理。任何 `setState` 都会调度一次 render → commit，即使批处理合并，每帧 setState 也意味着每帧一次组件树 reconciliation。React 19 的并发特性（Transitions 等）与本场景无关。关键结论：**React 只负责"挂载画布 + 低频 UI 状态"，绝不进入每帧热路径**。
- **StrictMode 双调用**（仅 dev）：组件 mount 时 `useEffect` 执行 setup → cleanup → setup。rAF 循环、事件监听、`ResizeObserver` 若 cleanup 不完整，dev 下会出现**双循环叠加**（两个 rAF 交替回调，帧时间翻倍且状态互相踩踏）。方案必须保证 cleanup 幂等、可重入。
- **TypeScript 约束**：`tsc -b` 严格编译。TypedArray 方案下需处理 `Float32Array` 索引访问（若开启 `noUncheckedIndexedAccess` 需非空断言或局部变量缓存）；纯计算层定义为纯函数接口 `(state: SimState, dt: number) => void`，便于单测与替换。
- **Vite 8 HMR**：模块热替换时 effect 会重跑——与 StrictMode 同理，cleanup 正确性同时覆盖 HMR 场景，无需额外处理。

## 2. 瓶颈机理：每帧数百函数 + Canvas 60fps

- **主线程与渲染管线**：60Hz 下每帧预算 16.7ms，扣除浏览器样式/布局/合成，JS + Canvas 绘制实际可用约 **8–10ms**。Canvas 2D 是立即模式 API，数百节点 × 每帧多次调用，叠加 `fillStyle` 等状态切换的内部校验成本，构成绘制侧主要开销。
- **React 重渲染**：若用 `useState` 存节点坐标，每帧 setState → 每帧 reconcile 组件树 → 即使 DOM 不变，fiber 遍历与 effect 调度本身就是毫秒级浪费，且与 rAF 回调竞争主线程，是帧时间抖动（jank）的主要来源。
- **算法复杂度退化**：朴素碰撞检测为 O(n²) 两两比较。n=500 时约 12.5 万次/帧；n=2000 时 200 万次/帧——仅此一项即可吃光全部帧预算。力导向布局的斥力计算同样天然 O(n²)。
- **GC 抖动**：每帧 `new` 节点对象、临时数组、内联闭包（如 `nodes.map(n => ...)`），在 60fps 下每秒产生数千短生命周期对象 → minor GC 频繁触发，单次 1–5ms 暂停直接表现为周期性掉帧（帧时间直方图尖刺）。

## 3. 关键风险与规避

| 陷阱 | 成因 | 规避 |
|---|---|---|
| React state 驱动每帧动画 | setState 触发 reconcile，帧预算被 React 占用 | 模拟状态放 `useRef` / 模块级引擎实例；React state 只存低频 UI（暂停、节点数、fps——fps 节流至 2–4Hz 更新） |
| StrictMode 双 rAF | effect setup 执行两次，cleanup 未 `cancelAnimationFrame` 则双循环并存 | 循环句柄存 ref，cleanup 中 cancel + 置空；引擎 `start()` 幂等（已运行直接返回）；cleanup 同时断开 `ResizeObserver` |
| devicePixelRatio 与 resize | CSS 像素 ≠ 物理像素，不处理则模糊；跨屏拖动/缩放致 DPR 变化不监听则永久模糊；resize 后未重建 backing store 则拉伸变形 | `canvas.width = cssW * dpr` + `ctx.setTransform(dpr,0,0,dpr,0,0)`，逻辑坐标统一用 CSS 像素；`ResizeObserver` 观察容器，`matchMedia('(resolution: Xdppx)')` 监听 DPR 变化；重建缓冲后强制重绘一帧 |
| 每帧 new 对象/闭包 | 短生命周期对象 → GC 尖刺 | 对象池 + TypedArray（Structure-of-Arrays）；热路径函数全部模块级声明、零闭包分配；临时计算走预分配 scratch 缓冲区 |

## 4. 设计方案（架构层）

### 4.1 三层解耦，单向数据流

```
React 层（壳）            渲染循环层（调度）           纯计算层（引擎）
┌──────────────────┐    ┌─────────────────────┐    ┌──────────────────────┐
│ <CanvasStage/>   │    │ loop.ts             │    │ engine/              │
│  - canvas ref    │───▶│  - rAF 调度          │───▶│  - SimState (SoA)    │
│  - UI state:     │    │  - 固定步长累加器     │    │  - applyForces()     │
│    暂停/规模/fps │◀───│  - fps 采样(节流回调)│    │  - solveCollisions() │
│  - 生命周期effect│    │  - 幂等 start/stop  │    │  - integrate()       │
└──────────────────┘    └─────────────────────┘    │  - render(ctx)       │
        │ 命令式 API：engine.start(canvas)         └──────────────────────┘
        └────────────── 不经过 React 状态 ─────────────────┘
```

- **React 状态**：仅持有 `paused`、`nodeCount`、`fps`（节流更新）。画布尺寸变化通过 `ResizeObserver` 回调命令式通知引擎，不进 state。
- **rAF 渲染循环**：模块级单例 `loop`，持有引擎引用；effect 只负责启停：

```ts
useEffect(() => {
  loop.start(canvasRef.current!)
  return () => loop.stop()
}, [])
```

  StrictMode 双调用下，第二次 setup 幂等复用或安全重建同一引擎。
- **纯计算层**：不 import React，不持有 DOM（render 函数以 `ctx` 为参数）。

### 4.2 状态组织：Structure-of-Arrays + 管线化

```ts
interface SimState {
  count: number
  x: Float32Array; y: Float32Array      // 位置
  vx: Float32Array; vy: Float32Array    // 速度
  radius: Float32Array
}
type SimPass = (s: SimState, dt: number) => void
const pipeline: SimPass[] = [applyForces, solveCollisions, integrate, /* 数百 pass */]
```

- 数百个"业务函数"= 对 SoA 原地读写的纯函数管线，每帧顺序执行。
- 单个 pass 可独立开关、独立计时（`performance.now()` 包裹采样），便于定位热点。

### 4.3 避免 O(n²)：空间划分

- **碰撞检测 → 均匀网格哈希**：按 `cellSize ≈ 2 × maxRadius` 分桶，每节点只检查同格 + 相邻 8 格，复杂度 O(n·k)（k 为平均邻居数）。桶结构优先用计数排序式双数组（预分配复用，每帧只重置计数），避免 `Map` 与数组重建。
- **力导向斥力 → 截断半径近似**：演示级规模（≤2000 节点）使用网格限域的短程斥力；规模更大时预留 Barnes-Hut 四叉树接口，不一期实现。
- **网格缓冲区生命周期**：容量按最大节点数预分配，每帧 in-place 清空与填充，零新增对象。

## 5. 技术方案（手段与取舍）

按"收益 / 成本 / 副作用"排序：

| 优先级 | 手段 | 收益 | 成本 | 副作用 |
|---|---|---|---|---|
| P0 | React 与热路径解耦（ref + 命令式引擎） | 消除 reconcile，架构前提 | 低 | 状态调试不如 state 直观，用节流 fps 回调补足 |
| P0 | 固定时间步长 + 累加器（固定 dt 步进，单帧步进数 clamp 上限） | 物理稳定、掉帧不爆炸 | 低 | 高刷屏（120Hz+）需决定帧间插值或提高步进频率 |
| P0 | 网格哈希碰撞检测 | O(n²)→O(n·k)，数量级收益 | 中 | 内存换时间；cellSize 需调参 |
| P1 | SoA TypedArray + 对象池 | 消除 GC 尖刺，CPU 缓存友好 | 中 | 可读性下降，需封装访问约定 |
| P1 | Canvas 绘制优化：按颜色分桶批量 fill；节点用 `fillRect` 或离屏 sprite + `drawImage` 替代 `arc` | 绘制调用减半以上 | 低-中 | 视觉细节受限 |
| P2 | 帧预算自适应降级：滚动平均帧时超阈值时降节点数 / 关闭部分 pass | 保帧率优先于规模 | 低 | 演示规模动态变化 |
| P3 | Web Worker（计算移出主线程，主线程仅绘制） | 主线程只剩绘制 | 高：SharedArrayBuffer / 结构化克隆复杂度 | 通信延迟约一帧；调试困难 |
| P3 | OffscreenCanvas + Worker 全量迁移 | 主线程完全空闲 | 高 | Safari 兼容性需特性探测；与 React 生命周期耦合变复杂 |

### 降级路径

单线程 Canvas 2D（基准）→ 自适应降载（减节点 / 关 pass）→ Worker 计算 + 主线程绘制 → OffscreenCanvas 全迁移。
每级为可独立交付的里程碑；P0–P1 完成后大概率已达标，P3 仅作兜底预案。

## 6. 验收指标与测量方法

### 6.1 量化指标（n=1000 节点、DPR=2、60Hz 屏、Chrome 稳定版）

- 帧时间：**p50 ≤ 8ms，p95 ≤ 16.7ms，p99 ≤ 25ms**。
- 掉帧率：帧间隔 > 32ms（连丢 ≥1 帧）的比例 **< 1%**（10 秒采样窗）。
- GC 尖刺：10 秒内帧时 > 33ms 的尖刺 ≤ 2 次。
- 内存：持续运行 60 秒后堆大小稳定，无单调增长（验证无泄漏）。

### 6.2 测量方法

- rAF 回调内记录 `performance.now()` 差值，写入预分配环形缓冲区（`Float32Array(600)`），计算 p50/p95/p99 与掉帧率——测量本身零分配。
- `PerformanceObserver` 监听 `longtask` 条目，佐证主线程阻塞。
- Chrome DevTools Performance 面板录制 10s 做离线归因（仅开发期，不进产物）。
- fps 数值经 500ms 节流后 `setState` 显示于 UI，同时验证 React 层开销可控。

### 6.3 生命周期验收（StrictMode / 卸载）

- dev 模式挂载后确认仅存在一个 rAF 循环（Performance 面板中每帧仅一次回调）。
- 反复卸载/重挂组件后，`requestAnimationFrame` 与 `ResizeObserver` 无残留（无帧时增长、无重复回调日志）。
- 跨屏拖动窗口验证 DPR 变化后画面重新清晰、无拉伸。

## 7. 实施路线（下一轮）

1. 引擎骨架：`SimState` SoA + `SimPass[]` 管线 + 固定步长 rAF 循环 + effect 生命周期。
2. 网格哈希碰撞检测 + 短程斥力。
3. Canvas 2D 批量绘制（颜色分桶 / sprite 预渲染）。
4. DPR + ResizeObserver 适配。
5. fps 采样面板与自适应降级。

## 8. P3 落地：Web Worker + OffscreenCanvas 全量迁移

> 本节为 P3 路线的实际实现记录。模拟计算与绘制全部移出主线程，主线程仅保留 React 壳、控件与 HUD 订阅；主线程实现完整保留为运行时回退路径。

### 8.1 模块划分

- Worker 侧（模拟状态唯一所有者）：
  - `src/engine/worker-runtime.ts`：持有 `SimState`、网格哈希、`SimPass[]` 管线、固定步长循环（rAF，rAF 不可用时退化为 `setTimeout`）、离屏 sprite 与 `OffscreenCanvas` 绘制、HUD 采样。
  - `src/engine/sim.worker.ts`：Worker 入口，负责 init 握手、init 前消息排队、运行期消息分发。
- 主线程侧：
  - `src/engine/stage-engine.ts`：统一 `StageEngine` 接口 + `WorkerStageEngine` / `MainStageEngine` 两个实现 + 特性检测工厂。
  - `src/engine/main-engine.ts`：回退用主线程引擎（原 P0–P2 实现）。
  - `src/engine/sampler.ts`：两侧共用的零分配帧时环形采样器。
- 共享：`types/state/grid/passes` 纯计算层两侧复用；`render.ts` 的上下文类型抽象为 `CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D`，sprite 生成同时提供 `HTMLCanvasElement` 与 `OffscreenCanvas` 版本。

### 8.2 关键约束的实现方式

- 状态所有权唯一：`SimState` 仅在 Worker 内创建，主线程从不持有节点数组，不存在双份漂移；主线程不再执行任何每帧计算（CDP tracing 主线程 `FireAnimationFrame` 回调为 0，见 8.4）。
- 零 JSON 帧路径：
  - 画布通过 `canvas.transferControlToOffscreen()` 以 Transferable 转移，仅一次。
  - 每帧数据完全不跨线程；HUD 指标每 500ms 以一个 5×`float32` 的 `ArrayBuffer`（20 字节）Transferable 传回（`postMessage(..., [buffer])`），非每帧、且为二进制转移而非结构化序列化。
  - 消息协议用 `src/engine/protocol.ts` 的可辨识联合（discriminated union）约束：`init | viewport | node-count | pause`（主→Worker），`stats | ready`（Worker→主）。
- 生命周期（StrictMode 双挂载/卸载重挂）：
  - `createStageEngine` 在 effect 内创建，cleanup 中 `worker.terminate()`、置空 `onmessage/onerror`（清理在途回调）、移除 canvas。
  - dev StrictMode 实测：初始 setup→cleanup→setup 共创建 2 个 Worker，1 个被销毁、始终仅 1 个存活；离开页面全部销毁（0 存活）；重挂恢复 1 个，无双循环、无泄漏。
- resize / DPR：`ResizeObserver` 观察容器 + `matchMedia('(resolution: Ndppx)')` 监听 DPR + `window resize` 兜底；尺寸/DPR 经 `viewport` 消息同步到 Worker，Worker 内设置 backing store 尺寸并 `setTransform(dpr,...)`。实测 resize 与 DPR 1→2、2→1 切换后 backing/CSS 比例恒等于当前 DPR，不错位、不模糊。
- 回退：`Worker`、`OffscreenCanvas`、`transferControlToOffscreen` 任一缺失或 Worker 构造/运行抛错时自动回退 `MainStageEngine`，并经 `onModeChange` 在 HUD 显示当前路径。回退后暂停、节点数、尺寸/DPR、stats 功能完整。
- 无新增运行时依赖；仍为 Canvas 2D（`OffscreenCanvas.getContext('2d')`），未使用 WebGL。

### 8.3 验证方式

- 无头 Chromium（chrome-headless-shell，DPR=2，窗口 1280×800，禁用 GPU 走软件合成）经零依赖 CDP 脚本驱动；脚本在 `scripts/`：
  - `bench.mjs`：读取 HUD 的 fps/p50/p95/p99/掉帧率。
  - `trace.mjs`：CDP tracing 统计主线程与 Worker 线程 `FireAnimationFrame` 回调的 p50/p95 与线程忙录占比。
  - `lifecycle.mjs`：跟踪 dedicated worker 目标的创建/存活/销毁。
  - `capability.mjs`：页面脚本执行前删除 `Worker` 或 `OffscreenCanvas`，验证特性检测回退。
  - `resize.mjs`：多组 resize/DPR 组合下比对 backing store / CSS 尺寸比例。
  - `controls.mjs`：验证暂停/继续、节点数切换命令对 Worker 生效。

### 8.4 迁移前后冒烟对比（2000 / 4000 节点）

HUD 帧间隔（软件合成下 rAF 锁定 16.7ms，两侧均稳定 60fps，无掉帧差异）：

| 规模 | 版本 | fps | p50 | p95 | p99 | 掉帧率 |
|---|---|---|---|---|---|---|
| 2000 | 迁移前 | 60 | 16.7ms | 16.7ms | 16.8ms | 0% |
| 2000 | Worker | 60 | 16.7ms | 16.8ms | 16.8ms | 0.5% |
| 4000 | 迁移前 | 60 | 16.7ms | 16.7ms | 16.8ms | 0.3% |
| 4000 | Worker | 60 | 16.7ms | 16.8ms | 16.8ms | 0.8% |

CDP tracing：每帧实际计算/绘制回调耗时（迁移前在主线程，迁移后在 Worker 线程）：

| 规模 | 版本 | 承载线程 | 回调 p50 | 回调 p95 | 线程忙录 |
|---|---|---|---|---|---|
| 2000 | 迁移前 | 主线程 | ~1.96–2.31ms | ~2.39–2.84ms | 主线程 ~26–29% |
| 2000 | Worker | Worker 线程 | ~1.86–1.99ms | ~2.20–2.53ms | 主线程 ~0.7–0.8% / Worker ~23–25% |
| 4000 | 迁移前 | 主线程 | ~11.27–12.57ms | ~12.39–13.55ms | 主线程 ~137–153% |
| 4000 | Worker | Worker 线程 | ~11.20–12.30ms | ~12.16–13.23ms | 主线程 ~0.2–0.3% / Worker ~135–148% |

结论：单帧计算+绘制耗时迁移前后基本持平（同一算法、无序列化热路径开销），未出现明显劣化；负载从主线程近乎完全转移到 Worker（主线程帧回调 0、忙录 <1%），主线程被完全释放。软件合成环境下 rAF 帧间隔恒为 16.7ms，HUD 的 p50/p95 无法反映负载差异，故以 tracing 的回调耗时作为主对比口径；真实 60Hz 硬件 + GPU 合成下的体感数据需在桌面 Chrome 复测（见 8.5）。

### 8.5 已闭环与未闭环项

- 已闭环（无头 Chromium 实测）：Worker 模式画面正确且 DPR=2 锐利；迁移前后 2000/4000 fps/帧时不劣化、主线程负载近零；StrictMode 双挂载/卸载/重挂无 Worker 泄漏与双循环；删除 `Worker`/`OffscreenCanvas` 及 `?fallback` 强制回退功能完整；resize/DPR 不错位不模糊；暂停/节点数控件生效；`npm run build`、`tsc -b`、`oxlint` 全部通过；无新增运行时依赖。
- 环境限制（无法在此容器内验证）：真实 60Hz/120Hz 显示器 + GPU 合成下的体感 fps、跨物理显示器拖动窗口时浏览器原生 DPR 媒体查询触发时机（容器内以合成 resize 事件等效验证应用层处理）；Safari 等浏览器的 OffscreenCanvas 兼容性（已由特性检测 + 回退覆盖，但未逐浏览器实跑）。

---

## 9. 确定性回放 + 快照恢复（时间旅行）

> 在第 8 节 Worker + OffscreenCanvas 架构上引入时间旅行：模拟结果完全由 `(初始状态, 控制消息序列)`
> 决定；可在任意帧边界导出/导入完整二进制快照；支持录制—回放；`?selftest=1` 三方哈希自检。
> 主线程回退路径运行同一确定性内核，能力对齐（HUD 徽标如实区分执行位置，不存在"静默失效"）。

### 9.1 确定性审计（逐项）

| 非确定性来源 | 改动前是否存在 | 处理 |
|---|---|---|
| `Math.random()` | 存在：`state.ts#seedNode` 用 `Math.random()` 生成位置/角度/速度/半径 | 新增 `rng.ts` 的可播种 Mulberry32 `DeterministicRng`；`setNodeCount(s, n, rng)` 显式注入；内核仅此一个随机源，RNG 的 32 位状态入快照 |
| 对象遍历顺序（`for...in` / `Map` / `Object.keys`） | 不存在：所有 pass 与网格均为 TypedArray 上的 `for (let i=0;i<n;i++)` 索引顺序；网格用计数排序式双数组，无 hash 桶遍历 | 保持不变；网格条目的产生顺序由节点索引固定，碰撞仅遍历 `j>i` 且同格/邻格按 `cy,cx,k` 固定序 |
| 浮点累加顺序 | 不存在跨次运行差异：每个 pass 对固定索引顺序做标量运算；碰撞响应 `push/imp` 的读写顺序由 `i,j` 固定 | 保持顺序；状态哈希直接对 Float32 原始位（`Uint8Array(buffer)`）做 FNV-1a，"逐位一致"按位而非按误差判定 |
| 多步/掉帧导致的步进次数差异 | 存在风险：累加器 + `MAX_STEPS` 使同一现实时刻在不同帧率下步进次数不同 | 确定性只约束"相同帧号 N"：帧号=固定步计数 `stepCount`；录制以逻辑帧为锚点（见 9.3），回放驱动器每帧恰好一步，不接触墙钟。实时循环的掉帧丢弃不影响"同一消息序列重放到第 N 帧" |
| 时间/`Date.now`/`performance.now` 进入物理 | 不存在：`performance.now()` 只驱动累加器与采样，不写入状态 | 自检与回放路径完全不读墙钟 |
| 多线程竞争 / 共享内存 | 不存在：状态仅 Worker 内单线程持有，无 `SharedArrayBuffer` | 不变 |
| RNG 跨平台浮点差异 | 仅用 `Math.imul/^/>>>` 整数运算与 IEEE-754 单精度 `Float32Array` | 不依赖宿主 libm 随机；三角函数在同一 V8 下确定（跨引擎的 libm 差异不在本项目验证范围） |

同一控制序列跑两遍到第 N 帧，所有 SoA 字段、`count`、RNG 状态、`stepCount` 的字节完全一致，
由 `?selftest=1` 的 live/snapshot/replay 三方哈希在 10 个检查点全部相等闭环。

### 9.2 模块划分（新增/改动）

- `engine/rng.ts`：确定性 Mulberry32 PRNG（32 位可序列化状态）。
- `engine/sim-kernel.ts`：纯模拟内核 `SimCore`（SoA + 网格 + pass 管线 + RNG + `stepCount` + `accumulator` + `paused`），
  `createSimCore / coreSetViewport / coreSetNodeCount / coreStep`；Worker 与主线程回退共用，物理零分叉。
- `engine/time-travel.ts`：
  - 二进制快照 `exportSnapshot/restoreSnapshot`（64 字节头 + 每节点 21 字节，小端 `DataView`，魔数 `SNAP`）；
  - `stateHash`：对 stepCount/count/RNG/宽高 + 全部活动节点的 x,y,vx,vy,radius 的原始 Float32 位与 color 字节做 FNV-1a；
  - `ControlRecorder`：录制控制消息，记录起止逻辑帧与"录制开始时刻"的基线快照；
  - `replaySequence`（从初始状态重放）与 `replayRecording`（恢复基线 + 重放录制段）。
- `engine/selftest.ts`：与渲染/墙钟无关的确定性自检，两条执行路径共用。
- `engine/protocol.ts`：可辨识联合扩展，主→Worker 增加 `record | export-snapshot | import-snapshot | replay-start | selftest-start`；
  Worker→主增加 `snapshot | selftest-result`；`stats` 二进制帧扩展为 7×float32，末 lane 以原始 uint32 位携带状态哈希。
- `engine/worker-runtime.ts` / `main-engine.ts`：都持有 `SimCore`；录制/快照/回放/自检语义一致。
- `components/CanvasStage.tsx`：控件区新增 录制/停止录制、回放、导出快照、导入快照；HUD 增加"帧 N / 哈希 xxxxxxxx"与自检徽标。

### 9.3 快照与回放语义

- **快照内容**：`stepCount`、逻辑帧、`count`、`capacity`、逻辑宽高、RNG 状态、`accumulator`、`paused`、
  全量 x/y/vx/vy/radius/color（按 capacity 存储，含非活动槽，保证恢复后再次加节点也逐位一致）。
  网格哈希是纯派生量，每帧第一步 `buildGrid` 即重建，故不入快照。
- **传输**：Worker 导出/导入都走 `postMessage(buffer, [buffer])` Transferable，零 JSON、零结构化序列化；
  主线程保存为单个 `ArrayBuffer`（UI 另提供 `.bin` 下载/读取）。导入后立即按恢复状态重绘一帧，画面无跳变、HUD 帧号/哈希连续。
- **录制**：开始时记录当前逻辑帧并捕获基线快照；期间每条控制消息按其到达时的 `stepCount` 锚定；
  停止时记录结束帧。
- **回放**：恢复录制开始时的基线，再按帧锚点重放控制（同帧多条按到达序），逐帧推进到结束帧，
  并在到达结束帧后排空锚定该帧的消息（含最后一条 pause），从而连 `paused` 标志也精确还原。
  因此暂停/继续穿插的录制也能逐位重建（实测录制段结束帧帧号与哈希与首跑完全相等）。

### 9.4 生命周期与回退

- 新消息全部纳入 `MainToWorkerMessage` / `WorkerToMainMessage` 可辨识联合，`switch` 穷尽处理。
- StrictMode 双挂载/terminate 后重挂：录制状态、待完成的快照请求在 `unmount` 中随 worker 一并销毁
  （`snapshotWaiters.clear()`、`terminate()`），重挂是全新会话，不会把旧 worker 的快照/录制串到新实例。
- 主线程回退（`?fallback` 或特性探测失败）运行**同一个** `SimCore` 与同一个 `selftest.ts`，
  录制/快照/回放/自检全部支持且哈希与 Worker 路径一致；差异仅 HUD 徽标显示"主线程回退"。
  不存在"回退路径静默不支持某项能力"的情况。

### 9.5 自检 `?selftest=1`

Worker（回退时为主线程）内：
1. 固定初始控制序列（1280×720、1000 节点、未暂停）与固定种子，跑 600 个理想固定步，每 60 帧记一次哈希（live）；
2. 每个检查点：重放到该帧 → 导出快照 → 恢复进第二个 core → 哈希（snapshot）；
3. 用录制的消息序列在第三个 core 上重放 → 哈希（replay）；
4. 三方逐位比对，结果打印到控制台并回传主线程显示"自检 PASS/FAIL"徽标。

驱动脚本：`scripts/selftest.mjs`（零依赖 CDP，同时捕获页面与 Worker 的 console）。

### 9.6 回归

- 无新增运行时依赖；仍为 Canvas 2D（`OffscreenCanvas.getContext('2d')`）。
- `npm run build`（`tsc -b` + `vite build`）、`oxlint` 均通过。
- 2000/4000 节点 HUD：60fps，p50 16.7ms，无性能劣化（热循环仍是同一条 SoA pass 管线，时间旅行逻辑不在每帧热路径）。
