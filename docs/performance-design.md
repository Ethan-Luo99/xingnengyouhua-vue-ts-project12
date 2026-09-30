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
