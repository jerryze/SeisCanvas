# SeisCanvas 架构审查与渐进重构方案

日期：2026-10-21。本文在实施修改前形成；依据当前工作区实际代码，包含本次开始前已有的未提交项目管理、三维采样等改动。它们是本次基线，不回退、不覆盖。

## 1. 当前架构及数据流

技术栈保持 Python / FastAPI / NumPy / SciPy / segyio / Matplotlib，以及 React 19 / TypeScript / Plotly / Vite。未使用全局状态库，不引入新框架。

```text
frontend/src/App.tsx (1449 行，项目编排、状态、导入、剖面请求、导出、页面)
  ├─ hooks/useWorkspacePersistence.ts → workspace.ts → api/client.ts
  ├─ SeismicViewer2D/SectionPlot.tsx → sectionGeometry/sectionDisplay/horizonCurve
  ├─ SeismicViewer3D/Scene3D.tsx → sceneGeometry/captureScene/GL adapters
  ├─ HorizonMap.tsx (1358 行，地图/剖面请求、Plotly、交互、控制面板)
  └─ hooks/useExportQueue.ts → ExportDialog / ExportQueue
                  ↓ HTTP + 项目 ID / activation epoch / revision
backend/main.py (985 行，路由、进程状态、导入、项目切换、导出编排)
  ├─ project_scope.py → workspace.py → storage.py
  ├─ segy.Survey → geometry / regular_geometry → SEG-Y
  ├─ section_service → rendering / resample / trace_overlay
  ├─ scene → section_service / preview / horizon
  ├─ horizon_map → scene.horizon_grid / preview / section_service
  └─ export_service → rendering / horizon_map / export3d → export_queue
```

实际流程：本地文件选择或上传 → `Survey` 扫描道头或读取几何缓存 → 排序索引/稠密 lookup 或规则几何公式 → 按剖面读取振幅 → 原生数组缓存（256 MiB、12 项）→ 共享 `section_raster` 重建（渲染缓存 96 MiB、12 项）→ 原始振幅裁剪/极性/色标 → JSON → Plotly。层位使用原生三列坐标，另有磁盘缓存、延迟构造网格和显示平滑。导出复用剖面/地图计算，3D 在浏览器捕获，最终文件一次渲染后存入持久队列，ZIP 不重新渲染。

项目保存只记录源文件路径、校验信息、解析参数与显示状态；上传文件另存 assets。项目作用域在请求入口与实际读写锁内复核。前端串行写队列与版本游标已经存在，应保留；不能随意并行化结构性写入。

## 2. 已确认的问题与现有合理设计

后端 26 个模块、61 条静态依赖边，包含函数内导入的检查未发现循环依赖。主要问题是职责集中、跨模块读取 Survey 内部索引、重复采样算法与生命周期缺口，不应虚构循环依赖问题。

合理设计应保留：`core.py` 兼容门面；原始采样与显示重建分离；2D、3D 竖向切片、A–B 剖面共享 `section_raster`；原始层位与 SG/PCHIP 显示几何分离；有上限的数组缓存；原子 JSON 与备份；项目作用域及串行写；已有 `sceneGeometry`、`captureScene`、`profilePlotRenderer` 等纯计算/渲染边界。

| 优先级 | 文件 / 函数（实施前） | 当前问题、证据与影响 | 计划、收益与兼容性风险 |
| --- | --- | --- | --- |
| P1 | `backend/preview.py:read_samples` | 按 samples 与 ids 的 shape 是否相同推断逐点/共享时间轴；N 道 × N 样点误变成 N 个值，影响方形切片与 A–B 剖面 | 显式采样模式，逐一更新调用点；覆盖共享/逐点、mmap/回退路径。只修复错误形状，不降低精度 |
| P1 | `preview.trace_ids_at`、`geometry.build_geometry` | 稀疏分支对未按 crossline 排序的同行道号做 searchsorted；乱序文件可漏读层位振幅 | 统一可靠的坐标查道规则，保留文件 trace ID、重复坐标既有取值规则；用乱序稀疏几何回归测试 |
| P1 | `horizon_map.sample_amplitude`、`preview.sample_horizon_amplitude` | 两套沿层振幅计算；地图分支丢弃最后一个原始时间采样，与三维不一致 | 复用共同采样实现；验证末采样、缺道、非网格点、NaN 与插值边界 |
| P1 | `frontend/src/components/Probe.tsx:useOriginalProbe` | 缓存命中不使旧请求失效；reset 及卸载不取消请求/计时器；已复现旧响应覆盖缓存命中和 reset | 提取可测试的请求控制器，统一最新请求序列、取消和清理；保留 60 ms 延迟和原始振幅读数 |
| P1 | `backend/export_queue.py:archive`、`main.export_archive` | 新归档删除旧 ZIP，FileResponse 尚可能在异步发送旧文件 | 每个响应独占归档文件，发送结束再清理；验证两个归档并存和响应完成清理 |
| P1 | `export_queue.ExportSession.clear/add` | clear 清零计数器，复用 exp_0001，使旧预览身份指向新图 | 保留单调 ID，覆盖 clear→add→重新加载；用户可见的队列排序继续从 1 开始 |
| P1 | `ExportSession.add/rename/delete/clear`、`models.SceneState.camera` | 持久化失败回滚仅捕获 OSError；嵌套 NaN 可通过 camera dict 并触发 ValueError，内存/磁盘不一致 | 在边界拒绝不可持久化值，并完善事务回滚；注入写入失败测试，保留原子提交语义 |
| P2 | `frontend/src/App.tsx` 的 2D 请求 effect | 页面同时管理请求时序、去抖、覆盖率缓存、兼容性校验和 JSX | 提取 `hooks/useSectionData.ts`，集中请求与失效规则，页面只接收 section/loading/viewport；重点保护视图切换与 zoom |
| P2 | `SeismicViewer2D/SectionPlot.tsx` | resize / purge 与串行 Plotly.react 队列分离，卸载可能与在途渲染交错 | 串行化渲染/resize，失效回调后等在途任务完成再 purge；用延迟 Promise 验证时序 |
| P2 | `SeismicViewer3D/sceneGeometry.ts:buildTraces` | cell mesh 路径先构造并丢弃四套完整二维数组 | 仅在 surface fallback 分支构造；逐值比较输出并基准测量 512² 切片构建，不改 GPU 数据/采样/actor ID |
| P2 | `backend/section_service.py:section_raster` | 缓存的是未裁剪原始振幅，key 却包含极性与 Wiggle 插值；设置切换触发无效重建 | 删除与结果无关的 key 字段，测试跨 2D/3D/导出缓存复用和失效边界；数值应完全一致 |
| P2 | `backend/main.py` 导出路由 | 路由适配与项目编排集中；已存在 export_service 却缺 HTTP 边界 | 提取 `backend/api/exports.py`，以显式上下文回调访问活动项目/数据；保持 URL、响应、锁和 ProjectRoute 检查 |
| P3 | `HorizonMap.tsx`、`main.py` 项目编排、类型中的 any | 控件/渲染与事务仍复杂，API 响应类型部分宽泛 | 本轮先处理有证据的边界和热点；后续按独立功能拆分，避免大量 props 或复制另一套状态 |

## 3. 目标目录：保留稳定模块，按真实职责增量扩展

```text
SeisCanvas/
├─ backend/
│  ├─ main.py                  # 应用装配、项目/导入编排（渐进收缩）
│  ├─ api/exports.py           # 新增：导出 HTTP 适配，显式上下文
│  ├─ segy.py / geometry.py / regular_geometry.py / preview.py
│  │                           # 数据读取、索引、按需原始振幅访问
│  ├─ horizon.py / horizon_cache.py / horizon_display.py
│  ├─ section_service.py / resample.py / trace_overlay.py / rendering.py
│  │                           # 共享数值与剖面服务，不依赖 HTTP/UI
│  ├─ scene.py / horizon_map.py # 物理坐标几何、地图与路径业务
│  ├─ export_service.py / export3d.py / figure_export.py / export_queue.py
│  ├─ workspace.py / storage.py / project_scope.py
│  ├─ models.py / style.py / naming.py
│  └─ core.py                  # 保留兼容门面，新代码直接导入实际模块
├─ frontend/src/
│  ├─ App.tsx                  # 页面与用户流程编排
│  ├─ api/client.ts            # 项目作用域、错误、写序列
│  ├─ hooks/useSectionData.ts  # 新增：2D 请求、缓存、失效、视窗
│  ├─ hooks/useWorkspacePersistence.ts / useExportQueue.ts
│  ├─ components/probeController.ts # 新增：独立可测试的光标请求生命周期
│  ├─ components/Probe.tsx / HorizonMap.tsx
│  ├─ components/SeismicViewer2D/ / SeismicViewer3D/
│  ├─ components/panels/       # 保留现有 UI 分组
│  └─ types.ts / workspace.ts  # 共享契约、默认值与恢复规则
├─ tests/                     # Python 数值、服务与 HTTP 集成回归
├─ frontend/tests/            # Node 内置测试，无新增测试框架
├─ benchmarks/                # 可复现性能脚本，不混入产品运行路径
├─ requirements-dev.txt       # 可复现后端测试依赖
├─ ARCHITECTURE_REFACTOR_PLAN.md
└─ REFACTOR_REPORT.md          # 实施完成后补充证据与遗留项
```

依赖方向：HTTP 适配 → 业务服务 → 原始数据/共享数值；React 页面 → hooks/纯控制器 → API。数据与数值模块不导入 `main`、FastAPI 或 React。导出调用同一业务服务，不能复制一套插值/极性算法。扩展新格式优先实现与 Survey 相同的按需采样契约；新显示模式复用物理坐标数据；新导出格式集中在导出适配层注册。尚不引入抽象插件框架。

## 4. 实施顺序与验收

1. **阶段 0：分析与基线**。先交付本文；已运行后端 **402 passed**（48.02 s）、前端 **119 passed**、TypeScript + Vite 构建成功。构建已有 5.29 MB 主包警告；后端已有 Starlette/httpx 弃用及差值重采样除零警告。保存当前源码快照供独立对比，避免把原有工作记为本次成果。
2. **阶段 1：正确性与生命周期**。修复原始采样形状/稀疏坐标/末采样、Probe 竞态、导出身份/事务/归档生命周期。每个修复增加针对真实失败场景的测试；阶段结束运行完整前后端测试与构建。
3. **阶段 2：数据流与可测量热点**。提取 useSectionData，收拢 2D Plotly 生命周期；消除 3D 临时数组和无效重建。使用输出等价断言、调用次数和可复现基准验证；结束再次运行测试与构建。
4. **阶段 3：HTTP 边界与工程交付**。提取导出路由，保护项目作用域与锁；补开发依赖、验证命令和架构约束测试。执行全量回归、构建、真实 F3 数据冒烟（使用隔离状态目录，不写用户项目），提供前后结构/文件清单/实测结果/未解决事项。

风险控制：所有阶段保留 API 与已有保存格式；不迁移现存用户数据；不修改 UI 文案/布局或视图默认行为；不清理未确认无用的兼容接口。数值变更逐值或容差对照原生数据。未经测量不宣称速度提升，不以降采样替代原精度。

## 5. 需后续专门处理的上限

- `scene.slice_data` 的 seismic 分支和 `timeslice` 仍可能构造完整原生剖面/稠密时间平面。要在超大 SEG-Y 上严格限制峰值内存，需分块且保留 Sinc8 支持域、全剖面百分位语义和缺道行为，不能直接切换旧的低清预览路径。本轮记录风险，避免无验证改变精度。
- 几何 npz 缓存只有键/存在性校验，需后续补结构/范围校验与磁盘配额；规则几何是用户显式选择的快速假设，不能保证任意未探测道头都规则。
- 当前是单后端进程、单活动项目；多个浏览器通过 epoch/revision 防止串写，不应声称支持多用户、多 worker。全局锁有串行性能上限，需先测量锁等待再缩小临界区。
- Plotly 体积与内部 WebGL 适配耦合仍在；仅拆 chunk 不等于减少首次加载字节。本轮不盲目替换渲染库。
- 大文件页面仍可进一步按项目事务、地图请求/控件拆分，但先验证本轮建立的边界，避免一次搬迁全部状态。

本轮完成的标准是以上三个可验证实施阶段落地，并如实交付仍需后续专项工作的风险；不是把所有文件搬进新的空目录，也不承诺解决所有规模的性能上限。
