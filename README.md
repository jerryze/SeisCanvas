<p>
  <img src="frontend/src/assets/seiscanvas-symbol.svg" alt="SeisCanvas 品牌图标" height="48" align="middle" />
  <img src="frontend/src/assets/seiscanvas-wordmark.svg" alt="SeisCanvas" height="30" align="middle" />
</p>

SeisCanvas 是本地运行的地震数据可视化工具，支持 SEG-Y 地震体与层位数据导入、二维剖面、三维场景、层位地图和图片导出。

![SeisCanvas 三维切片与层位曲面界面](assets/screenshots/seiscanvas-3d.png)

## 主要功能

- **数据导入**：打开 `.sgy` / `.segy` 地震体，批量导入 `.txt` / `.dat` 层位文件，支持道头参数和层位列映射。
- **二维剖面**：浏览 Inline、Crossline 剖面，缩放、平移、读取原始振幅，调整层位线条和标记样式；可在颜色背景上独立叠加 Wiggle 波形与 Variable Area 正振幅填充。
- **三维场景**：组合显示 Inline、Crossline、Time Slice 和层位曲面，调整视角、不透明度、网格与配色；层位曲面支持按时间、沿层地震振幅或单色着色，振幅模式沿用地震显示的色标、极性与裁剪设置。
- **层位地图**：查看 Time、沿层振幅或双层位差值，支持填色、等值线、差值统计和 A–B 地震剖面。
- **图件导出**：支持 PNG、PDF、SVG，设置尺寸、字体和背景，通过导出队列预览、重命名并批量打包为 ZIP。
- **项目管理**：新建、打开、重命名、另存为项目；各项目独立保存视图、层位配置和导出队列。
- **自动保存**：自动保存工作状态，支持手动保存及 Ctrl / ⌘ + S，切换前完成保存，重启后恢复最近项目。

## 安装与启动

需要 Python 3.10+、Node.js 18+ 和 npm。以下命令从项目根目录运行。

### macOS / Linux

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
cd frontend
npm ci
npm run build
cd ..
python run.py
```

### Windows（PowerShell）

```powershell
py -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
cd frontend
npm ci
npm run build
cd ..
.venv\Scripts\python.exe run.py
```

启动后在浏览器打开 <http://127.0.0.1:8000>。再次启动只需运行虚拟环境中的 `python run.py`。

## 使用方法

顶栏项目名称旁的下拉菜单提供“新建项目”“打开项目”“另存为新项目”和“重命名”。“新建项目”从空白开始，“另存为”复制当前设置并引用相同源数据，导出队列从空白开始。项目列表支持搜索，并显示原始数据路径及文件缺失状态。

**保存项目不会复制本地原始 SEG-Y 或层位文件**，只保存路径、文件校验信息、解析参数和工作状态。通过浏览器上传的文件仅在导入时保存一份，另存为继续引用该文件。导出图件单独占用磁盘空间。原始文件移动或变化后，使用“重新关联”选择文件并确认，原项目记录会保留。

1. 在侧栏“数据”中导入 SEG-Y 文件。默认 Inline / Crossline 道头字节位置为 189 / 21，可按文件实际格式修改。
2. 导入层位文件并指定 Inline、Crossline、Time 列。文件可带表头，以空格或 Tab 分隔，Time 单位为毫秒。
3. 在侧栏顶部切换 **2D / 3D / 层位地图**，调整剖面位置、层位样式、色标和显示范围。
4. 点击顶栏“保存图件”，设置导出参数并“保存到队列”；在“导出队列”中预览图件，点击“导出全部”下载 ZIP。

侧栏中的层位和切片均点击对象行就地编辑，同一列表只展开一个对象，显隐开关独立操作。2D 的公共平滑选项位于层位列表下方的“全部层位显示设置”。切换视图时，各模式分别保留分组开合、编辑项和滚动位置；侧栏右侧滚动条与底部箭头提示下方仍有内容。

三维“不透明度”从 0%（完全透明）到 100%（完全不透明）。层位地图中的“地图层位”决定地图内容，“地图等值线”控制地图线条；“层位管理”中的勾选和线条样式用于 A–B 剖面，并与其他视图共用。导入、移除和重命名层位会同步所有视图。点击“绘制剖面线”并拾取 A、B 端点后，在“A–B 剖面”页签查看结果，在“剖面设置”中调整端点和显示参数。

2D 剖面、3D Inline/Crossline 切片和层位地图的 A–B 剖面共用“地震显示”设置，可分别开启 Wiggle 和 Variable Area，两者默认关闭。Gain 默认 1.0，控制横向振幅大小，沿用颜色背景的振幅裁剪和极性设置；Variable Area 默认用黑色填充显示极性下的正振幅。全剖面自动间隔显示地震道，放大后恢复逐道显示。PNG、SVG、PDF 导出保留当前缩放范围、Gain、填充颜色和显示道间隔。

“背景插值”和“Wiggle 插值”默认开启并独立保存。背景直接对原始振幅进行时间方向 8 点 Sinc、横向 Linear 重建，再裁剪振幅并映射颜色；关闭后显示原始采样网格。Wiggle 和 Variable Area 共用时间插值序列，关闭 Wiggle 插值后直接连接原始采样点。缩放和平移会重新生成对应分辨率的背景，导出使用相同开关。3D 的固定 Time Slice 使用平面内的空间 Linear 插值，不绘制时间波形。A–B 剖面支持固定横纵比例、缩放和平移，保存剖面时沿用相同的比例与可见范围。详见 [剖面振幅插值与渲染说明](SEISMIC_2D_RENDERING.md)。

PNG、PDF、SVG 均可选择白色或透明背景。PDF/SVG 的二维坐标、文字、层位和波形保留矢量；三维场景保留高清位图，坐标轴、刻度和文字保留矢量轮廓。已经加入队列的文件不会随设置重新生成，调整后需重新保存图件。

使用 F3 示例时，将 SEG-Y 文件放入项目 `data/` 目录，层位 `.txt` 文件放入 `data/horizons/`，然后点击“加载 F3 示例”。

工作状态默认保存在系统应用数据目录，可通过环境变量 `SEISCANVAS_STATE_DIR` 指定其他目录。Linux 本地文件选择器需要桌面环境和 `python3-tk`。

各项目保存在该目录的 `projects/<项目 ID>/`，浏览器上传文件保存在 `assets/`。已有的单项目工作区会自动迁移，旧配置和原始数据文件保留。切换项目会先保存当前状态，目标加载失败时留在原项目。同一后端实例只有一个活动项目；另一个浏览器页面切换项目后，旧页面会暂停编辑并提示重新加载。

## 开发运行

先启动后端 `python run.py`，再另开终端运行：

```bash
cd frontend
npm run dev
```

打开 <http://127.0.0.1:5173>，前端会将 API 请求转发到本地后端。前端检查命令：

```bash
cd frontend
npm test
npm run build
```

后端与前端的完整开发检查（从项目根目录运行）：

```bash
python -m pip install -r requirements-dev.txt
npm --prefix frontend test
npm --prefix frontend run build
python -m pytest -q
```

先构建再运行后端测试，可同时验证生产静态文件服务。`.github/workflows/checks.yml` 提供相同的持续集成检查；测试使用隔离的项目目录，不修改本地已保存项目。

架构、模块依赖与本轮渐进重构方案见 [ARCHITECTURE_REFACTOR_PLAN.md](ARCHITECTURE_REFACTOR_PLAN.md)，实施、验证结果及后续事项见 [REFACTOR_REPORT.md](REFACTOR_REPORT.md)。可复现性能检查位于 `benchmarks/`：

```bash
python benchmarks/raster_cache.py
python benchmarks/export_section.py
node --expose-gc benchmarks/scene_geometry.mjs
```
