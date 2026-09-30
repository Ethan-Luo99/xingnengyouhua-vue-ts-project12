import { CanvasStage } from './components/CanvasStage'
import './App.css'

function App() {
  return (
    <main className="app">
      <header className="app-header">
        <h1>Canvas 2D 实时节点模拟</h1>
        <p>力导向布局 · 网格哈希碰撞检测 · 固定步长渲染循环</p>
      </header>
      <CanvasStage />
    </main>
  )
}

export default App
