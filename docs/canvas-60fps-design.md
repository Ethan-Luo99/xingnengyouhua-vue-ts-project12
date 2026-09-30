# Canvas 2D 大规模节点实时可视化 —— 性能方案设计

- 目标：画布上承载大量节点，每帧执行数百个业务函数（力导向布局 + 邻近碰撞检测 + 状态更新 + 绘制），在 60Hz 屏幕稳定维持 60fps。
- 基线脚手架：React 19.3 + TypeScript 6 + Vite 8，`src/main.tsx` 已包裹 `StrictMode`，渲染目标为 Canvas 2D。
- 本轮产物：架构与技术方案，不含实现代码（仅伪代码 / 接口签名 / 结构示意）。

## 硬性约束

1. 保持 Canvas 2D，**不**改用 WebGL / Three.js。
2. 不引入重量级状态库或第三方渲染库，只用浏览器与 React 原生能力。
3. 必须兼容 StrictMode 双调用与卸载重挂，不产生重复循环或内存泄漏。
4. 必须正确处理 devicePixelRatio 与 resize。

---

## 1. 技术栈理解：影响性能方案的关键点

### 1.1 React 19：它是 UI 框架，不是渲染引擎

- React 19 仍是 Fiber + 并发渲染，状态更新自动批处理（automatic batching）。这些能力服务于 DOM diff，与“每帧重画数千图元”的 Canvas 命令式绘制不在一条链路上。
- 核心原则：**React 只挂载一次画布外壳**（`<canvas ref>` + 控制面板 + 统计读数），每帧数据流完全绕开 React。引擎实例存于 `useRef`，在 `useEffect` 中创建 / 销毁，绝不放入 state。
- React 19 可利用点：
  - 函数组件可直接接收 `ref` prop（无需 `forwardRef`），外壳组件更薄。
  - HUD 统计数据用 `useSyncExternalStore` 订阅引擎（低频推送，约 2–4Hz），React 原生外部 store 订阅机制，无第三方依赖、无 tearing 风险。

### 1.2 StrictMode 双调用（开发期行为，生产构建不存在，但必须兼容）

- 组件函数体渲染两次：render 必须保持纯函数，**禁止在 render 体内创建引擎、启动循环、订阅事件**。
- Effect 序列为 mount → cleanup → mount：引擎必须在 effect 内创建，cleanup 中完整释放（`cancelAnimationFrame`、`disconnect` observer、移除监听、必要时 `worker.terminate()`）。写对后双挂载等于免费的生命周期测试；写错则两个 rAF 循环抢一个 canvas。
- ref 对象在双挂载序列中保持稳定，是存放引擎句柄的正确位置。

### 1.3 TypeScript 约束

- `canvas.getContext('2d')` 返回 `CanvasRenderingContext2D | null`，需显式收窄，不用 `!` 掩盖失败路径。
- 计算层用接口（结构化类型）与 DOM / React 隔离，同一套核心可在主线程与 Worker 复用；Worker 通信用可辨识联合类型约束消息协议。
- SoA（Structure of Arrays）配合 `Float32Array` / `Int32Array` / `Uint8Array` 有完整类型支持；TS 不检查数组越界，长度常量需集中定义。

---

## 2. 瓶颈机理：16.67ms 预算花在哪

60Hz 下单帧总预算约 **16.67ms**，JS 计算、样式 / 布局、Canvas 指令录制与栅格化竞争同一条主线程时间线。

### 2.1 主线程与渲染管线

- Canvas 2D 调用（`arc` / `fill` / `fillText`）本质是录制命令列表，栅格化由后续合成 / GPU 环节消费。录制开销在 JS 线程，帧末还可能出现同步 flush 点。
- `shadowBlur`、每帧重建渐变、频繁 `save/restore`、频繁状态切换（`fillStyle` / `font`）会显著放大每图元成本。
- 输入事件（`pointermove` 可高于 60Hz）、GC、React commit 都挤占同一预算。
- 参考预算分配：sim ≤ 8ms、draw ≤ 6ms、输入 / 余量约 2ms。

### 2.2 React 重渲染开销

- 用 `setState` 驱动每帧 = 每秒 60 次 Fiber 调度 → reconcile → commit（DOM 属性 diff、effect 依赖检查），即使只更新一个数字也唤醒整条 React 管线；并发模式下更新还可能被打断 / 延后，造成视觉抖动。
- 若每个节点一个组件（500 个组件），开销成倍放大。

### 2.3 算法复杂度：碰撞与力导向的 O(n²) 退化

- 朴素两两碰撞为 n(n−1)/2：n=500 约 **12.5 万次 / 帧**，n=1000 约 50 万次 / 帧（约 720 万次 / 秒）；若每次配对还分配向量对象，GC 成本叠加。
- 力导向布局：弹簧力沿边计算是 O(E)（便宜）；节点间斥力若全对计算同样是 O(n²)。
- n 翻倍耗时变 4 倍，复杂度是能否稳 60fps 的头号决定因素，设备升级无法消除。

### 2.4 GC 抖动

- 每帧 `new` 向量 `{x,y}`、临时数组、箭头函数闭包、装箱数字、被丢弃的对象字面量，会快速填满新生代，触发 minor GC（Scavenge）。单次通常亚毫秒到数毫秒，但**随机插入帧中**，表现为规律性掉帧尖刺，而平均帧时可能很好看。
- 隐式恶果：对象形状（hidden class / shape）不统一使引擎走多态内联缓存，拖慢热路径；闭包捕获也会抑制变量优化。

---

## 3. 关键风险：成因与规避

### 3.1 用 React state 驱动每帧动画

- 成因：把声明式 UI 误用到每帧变化的海量可变数据上，reconcile 成本与动画帧率耦合。
- 规避：节点数据存于 React 之外的可变缓冲区；循环直接命令式绘制；只有低频元信息（节点数、fps、暂停态）经 `useSyncExternalStore` 进入 React。React DevTools Profiler 中稳态应看到**零 commit**。

### 3.2 StrictMode 双 rAF

- 成因：在 render 体或模块作用域启动循环，或 effect 无 cleanup（cleanup 未捕获正确的 rAF id），双挂载后两个循环并存，互相覆盖画布、双倍 CPU。
- 规避：循环只在 `useEffect` 中启动；rAF id 在 effect 闭包内更新，cleanup 中 `cancelAnimationFrame`；所有监听 / Observer 在 cleanup 中对称释放。`tick` 内每次重新调度，取消点只作用于下一帧，无竞态。
- 附带：`document.hidden` 时 rAF 自带暂停，恢复后第一帧 dt 巨大，必须 clamp（见 5.5）。

### 3.3 devicePixelRatio 与 resize

- 成因：canvas 有两套尺寸——位图尺寸（`canvas.width/height`，物理像素）与 CSS 尺寸。不乘 DPR 高分屏模糊；每帧或每次回调无脑重设位图会清空画面并触发昂贵的显存重分配；DPR 还会随窗口跨显示器变化。
- 规避（模拟坐标系全部使用 CSS 像素，DPR 仅是绘制层关注点）：
  - `ResizeObserver` 监听画布元素，回调取 `contentRect` 的 CSS 像素宽高；
  - 位图：`canvas.width = Math.round(cssW * dpr)`，`style.width = cssW + 'px'`；
  - 绘制：`ctx.setTransform(dpr, 0, 0, dpr, 0, 0)`（重设位图会重置上下文状态，transform 须在 resize 时重设）；
  - 尺寸未变化时跳过重设（去抖 / 幂等判断）；**DPR 封顶（建议 ≤ 2）**作为质量降级手段；
  - 每次 resize 重新读取 `devicePixelRatio`，覆盖跨屏场景；
  - resize 后重建依赖尺寸的空间哈希等结构。

### 3.4 每帧 new 对象 / 闭包

- 成因：`nodes.map(n => ({ ... }))`、`{x,y}` 临时向量、热循环内 `arr.forEach(() => …)` 绑定闭包、拼接新数组。
- 规避：热数据进预分配 TypedArray；临时向量复用模块级 scratch 变量（单线程安全；Worker 化后每线程各自一份）；循环用 `for (let i=0; i<n; ++i)` 索引写法；对象池供必须使用对象的场合（如事件载荷）；函数引用初始化时绑定一次，不在帧内创建。

---

## 4. 架构设计：三层解耦

### 4.1 数据流与职责边界

```
┌─ React 层 ────────────────────────────────────────┐
│  <canvas ref> 外壳（挂载一次）                      │
│  控制面板（参数修改 → 命令式写入 engine.config）    │
│  HUD：useSyncExternalStore 订阅 2–4Hz 统计快照     │
└───────────┬───────────────────────────────▲───────┘
            │ ref / effect 生命周期          │ 低频 stats 通知
┌───────────▼───────────────────────────────┴───────┐
│  引擎层（框架无关的 class / 闭包对象，可整体搬进 Worker）│
│  rAF 循环：读输入 → fixed-step update → render      │
│  生命周期：start()/stop()/resize()/destroy()        │
└───────────┬───────────────────────────────────────┘
            │ 只传 TypedArray 与 config，零 React 依赖
┌───────────▼───────────────────────────────────────┐
│  纯计算层（pure functions，可单测，可在 Worker 复用） │
│  SoA 世界缓冲 + 系统函数：                          │
│  buildGrid / applySprings / applyRepulsion /        │
│  solveCollisions / integrate / 投影绘制数据         │
└────────────────────────────────────────────────────┘
```

- **React 状态**：只承载 UI 态（播放 / 暂停、滑块参数、HUD 值）。控件回调直接写 `engineRef.current.config.xxx`，不经 per-frame 通道。
- **rAF 循环**：唯一帧驱动器，拥有时钟与调度，不持有 React 引用。
- **纯计算层**：输入为缓冲区与 dt，输出就地写回，无 DOM、无 React、无分配，可在 Node / 单测中直接运行。

### 4.2 接口签名示意（非实现）

```ts
interface World {           // SoA：一整块预分配内存
  readonly n: number
  x: Float32Array; y: Float32Array
  px: Float32Array; py: Float32Array   // 上一步位置，渲染插值用
  vx: Float32Array; vy: Float32Array
  radius: Float32Array; kind: Uint8Array
}

interface SpatialHash {
  rebuild(x: Float32Array, y: Float32Array, radius: Float32Array, n: number): void
  forEachNeighbor(i: number, cb: (j: number) => void): void  // 只查 3×3 邻格
}

interface Engine {
  config: { dprCap: number; paused: boolean }
  start(): void; stop(): void
  resize(cssW: number, cssH: number, dpr: number): void
  pointer: { x: number; y: number; active: boolean }  // 事件直接改写，不入 React
  subscribe(cb: () => void): () => void               // 供 useSyncExternalStore
  getStats(): Readonly<FrameStats>
  destroy(): void
}
```

### 4.3 “数百函数”的组织方式

- 按**系统 / 阶段（system）**组织，不按节点组织：每帧顺序执行 `clearInput → buildGrid → forces → collisions → integrate → render`，每个系统一次线性扫描全部节点。避免“每节点一个对象 + 虚方法 / update 回调”的多态派发。
- **空间划分：均匀网格哈希（uniform grid）**。`cellSize ≥ 2 × maxRadius`（碰撞 / 近距斥力的作用直径）；每帧重建：
  - 零分配实现：`head: Int32Array(cells)` 初始化为 −1，`next: Int32Array(n)` 构成链表，rebuild 为单次 O(n) 扫描；
  - 碰撞只查当前格 + 8 邻格，每节点候选对从 n 降到约 9 格内的密度常数 k，整体近似 **O(n)**；
  - 密度极端不均（全挤一格）时仍会退化，缓解：最大半径钳制、高密度格内提前 break + 多次穿透修正（impulse stacking），或二期做自适应细分。
- 力导向：弹簧沿 `edges: Int32Array` 计算，O(E)；斥力只在网格邻域内作用（短程斥力对视觉布局通常足够）；若确需长程多体斥力，上 Barnes-Hut 四叉树 O(n log n)，而非全对。
- 渲染批处理配合：`kind` 字段即绘制分组键，按组设置一次 `fillStyle`，组内多个 `arc` 合进**一个 path 一次 `fill`**；静态背景预渲染到离屏 canvas。

---

## 5. 技术方案：手段与取舍

按“收益 / 成本 / 副作用”排序：

| # | 手段 | 收益 | 成本 | 副作用 / 注意 |
|---|------|------|------|--------------|
| 1 | React 退出每帧链路（ref + effect + 外部 store HUD） | 极高，直接消灭整条 reconcile | 极低 | 需纪律保证新代码不回退；HUD 需节流 |
| 2 | 空间哈希，碰撞 / 近距力 O(n²)→~O(n) | 极高（n=500 时从 12.5 万对降到 n·k） | 中（网格重建、调 cell 尺寸） | 密度聚集时退化，需钳制与多次修正 |
| 3 | SoA TypedArray + 零分配热路径 | 高：消 GC 尖刺、缓存友好、隐藏类稳定 | 中：写法不如对象直观，索引易越界 | 与 Worker 传 Transferable 天然契合 |
| 4 | Canvas 批绘制（按颜色分组合并 path、少状态切换、禁 `shadowBlur`、静态层离屏缓存） | 高：draw 阶段常占一半时间 | 低–中 | 同组图元不能有独立透明度 / 混合差异 |
| 5 | 固定时间步长 + clamp + 渲染插值 | 高：物理稳定、切后台 / 掉帧不爆炸 | 中：需 prev 双缓冲与 alpha 插值 | 插值多一组数组与一次 lerp 扫描 |
| 6 | DPR 封顶 + resize 去抖 | 中：高分屏像素量可降 50%+ | 极低 | 略降锐利度，可按帧时自适应 |
| 7 | 自适应质量（LOD）：按滚动帧时动态降细节 / 斥力频率 / 绘制粒度 | 中：保住“不掉帧”底线 | 中：需调参与迟滞，避免频繁抖动 | 极端负载下视觉简化 |
| 8 | Web Worker + OffscreenCanvas（`transferControlToOffscreen`） | 中–高：sim 与绘制移出主线程，输入 / React 永不卡顿 | 高：需消息协议；控制权移交不可逆；调试复杂 | 旧版 Safari 不支持，必须特性检测与回退 |
| 9 | 输入事件只写共享对象，rAF 内消费 | 中：防高频事件风暴 | 极低 | 一帧内多次移动只保留最新值 |

### 5.1 固定时间步长

- sim 固定 `STEP = 1000/120`（或 1000/60），累加器模式；帧 dt 先 `Math.min(dt, 250ms)` 防螺旋死亡（spiral of death），再消费累加器；渲染按 `alpha = acc / STEP` 在 `px → x` 间插值。
- 求稳可先用“clamp 的半固定步长”起步，证明有抖动再升级到累加器 + 插值。

### 5.2 Worker / OffscreenCanvas 取舍

- 触发时机：主线程方案不达标（p95 超预算且手段 1–7 已做满）后再上，不是默认架构。
- 前提：计算层已做到框架 / DOM 无关（见第 4 节），迁移时整块核心复用；主线程仅替换为消息代理，对外保持同一 `Engine` 接口（两种实现）。
- StrictMode 注意：控制权移交不可逆，回退决定必须在**首次挂载时**做出；Worker 版在 cleanup 中 `worker.terminate()`，双挂载作用于全新的 OffscreenCanvas 对象，天然安全；切勿在模块级缓存已移交的 canvas。

### 5.3 降级路径（逐级，运行时特性检测 + 帧时监控驱动）

1. OffscreenCanvas + Worker 全卸载；
2. 不支持（`'OffscreenCanvas' in window` 或 `transferControlToOffscreen` 抛错）→ 主线程同构引擎；
3. 帧时超标 → DPR 2 → 1.5 → 1；斥力隔帧计算；降绘制精度（小圆点替代描边、合并更多分组）；
4. 再超标 → 减活动节点数 / 视口裁剪（离屏节点只 sim 不 draw 或降频）。

---

## 6. 验收指标与测量方法

### 6.1 可量化目标（建议合同值）

- 帧时间：中位 ≤ 14ms、**p95 ≤ 16.67ms**、p99 ≤ 20ms；sim / draw 分段预算分别 ≤ 8ms / 6ms。
- 帧率：500 节点满负载平均 ≥ 59fps；**掉帧率（long frames）< 1%**：rAF 间隔 > 25ms（16.67×1.5，即丢 ≥1 个 vsync）计为一次掉帧，并统计连续掉帧数。
- 无抖动：每 1000 帧中 GC 导致的 >16.67ms 帧为 0；Chromium 下 `performance.memory` 稳态堆增长斜率 ≈ 0。
- 正确性门禁：StrictMode 开发模式挂载 / 卸载循环 100 次，活动 rAF 数恒为 1、监听器无残留（堆快照 detached 节点为 0）；resize / DPR 切换画面不模糊不闪烁。

### 6.2 测量方法

- rAF 帧计时（轻量常驻 HUD，自身节流到 4Hz），环形缓冲存最近 N 帧间隔：

```ts
// 伪代码
let last = performance.now()
const frame = (now: number) => {
  raf = requestAnimationFrame(frame)
  const dt = now - last; last = now
  // dropped += dt > 25 ? Math.round(dt / 16.67) - 1 : 0
  performance.mark('sim:start');  /* sim */  performance.mark('sim:end')
  performance.measure('sim', 'sim:start', 'sim:end')
}
```

- `PerformanceObserver({ entryTypes: ['longtask', 'long-animation-frame'] })`：long-animation-frame（Chromium）给出脚本 / 样式分段归因，是定位尖刺的主工具。
- DevTools Performance 面板深度剖析：火焰图中的 GC 事件、Canvas 指令占比、强制布局警告；Memory 分配时间线确认热路径零分配。
- 统计数据从引擎经订阅接口节流推送，React 只负责显示，测量代码本身不制造 per-frame setState。
- 分阶段 mark/measure：sim、buildGrid、collision、draw 各自计时，避免优化靠猜。
- 测试场景矩阵：节点数 100 / 500 / 1000；DPR 1 / 2；密集聚集（网格退化用例）；resize 拖拽；切后台 30s 恢复；StrictMode 反复挂载。

---

## 附：硬性约束落实对照

- **保持 Canvas 2D**：批绘制、离屏预渲染、分组 fill 全部在 Canvas 2D API 内；Worker 方案仅使用 OffscreenCanvas 的 2D context，不引入 WebGL / Three.js。
- **零新增依赖**：订阅用 React 19 原生 `useSyncExternalStore`；空间哈希、对象池、固定步长均自研；只用浏览器原生 rAF / ResizeObserver / Web Worker / TypedArray。
- **StrictMode**：引擎仅由 effect 拥有，start/stop/destroy 严格对称，rAF id、事件监听、ResizeObserver、Worker 全部可取消 / 终止；卸载后回调不再触碰 canvas。
- **DPR / resize**：ResizeObserver 驱动、CSS 像素坐标系 + `setTransform(dpr,…)`、位图仅在尺寸变化时重设、读取时机覆盖跨显示器、DPR cap 作为降级旋钮。
