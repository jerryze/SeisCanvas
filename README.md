# SeisCanvas

SeisCanvas 是本地运行的地震数据可视化工具，支持 SEG-Y 地震体与层位数据导入、二维剖面浏览、三维切片与层位叠加，以及图片导出。前端使用 React、TypeScript 和 Vite，后端使用 FastAPI、segyio、NumPy 与 Matplotlib。

## 环境要求

- Python 3.10 或更高版本
- Node.js 18 或更高版本，以及 npm

## 安装与启动

### macOS

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

然后在浏览器打开 <http://127.0.0.1:8000>。`run.py` 会启动本地后端并提供构建后的界面。

### Windows（PowerShell）

以下命令从项目根目录运行：

```powershell
py -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt

cd frontend
npm ci
npm run build
cd ..

.venv\Scripts\python.exe run.py
```

然后在浏览器打开 <http://127.0.0.1:8000>。

### 前端开发模式

macOS 在项目根目录启动后端：

```bash
source .venv/bin/activate
python run.py
```

Windows PowerShell 在项目根目录启动后端：

```powershell
.venv\Scripts\python.exe run.py
```

另开一个终端启动前端开发服务器：

```bash
cd frontend
npm run dev
```

打开 <http://127.0.0.1:5173>。Vite 会把 `/api` 请求转发到本地后端 `127.0.0.1:8000`。

## 数据准备

启动应用后，可在界面中直接导入 `.sgy` / `.segy` 地震体和 `.txt` / `.dat` 层位文件。

要使用“加载 F3 示例”，在项目根目录创建 `data/`，将 SEG-Y 文件放在该目录下；可将层位 `.txt` 文件放入 `data/horizons/`。应用会读取按文件名排序的第一个 SEG-Y 文件和 `data/horizons/` 中的 `.txt` 层位文件。

层位文件应包含 Inline、Crossline 和 Time 三列，列之间以空格或 Tab 分隔；可带表头，导入时可以预览并指定列。Time 使用毫秒。导入 SEG-Y 时，默认 Inline 和 Crossline 道头字节位置分别为 189 和 21；如果文件使用其他位置，可在界面中修改。

## 数据导入

- 导入 `.sgy` / `.segy` 地震体，自定义 Inline、Crossline 道头字节位置。
- 批量导入 `.txt` / `.dat` 层位文件，支持空格或 Tab 分隔及可选表头。
- 预览层位文件，手动指定 Inline、Crossline、Time 列；时间单位为毫秒。

## 二维剖面

- 浏览 Inline、Crossline 剖面，通过编号输入或滑块切换位置。
- 支持框选缩放、滚轮缩放、平移和重置视图。
- 独立设置层位颜色、线型、线宽、标记点形状与大小，以及黑色描边。
- 悬停读取光标处的原始振幅（含 Inline、Crossline、TWT），数值来自 SEG-Y 原始采样。

## 三维场景

- 组合显示多个 Inline、Crossline 和 Time Slice，每类最多 12 个，总计最多 18 个。
- 独立设置切片位置、可见性、透明度、边框颜色与宽度，并支持移除切片。
- 层位支持完整曲面和切片交线两种显示模式。
- 完整层位支持曲面、网格、曲面与网格叠加，支持颜色、透明度和网格线宽设置。
- Inline / Crossline 交线支持线型、线宽、颜色、标记点和描边设置。
- 支持旋转、缩放、平移、相机重置，以及 Perspective、Top、Inline、Crossline 快捷视角。
- 支持坐标轴、轴标签、包围盒的显示开关，以及背景颜色和 XYZ 显示比例设置。

## 地震显示插值与自适应分辨率

显示层按照 `原始 SEG-Y → 可见范围 → 自适应分辨率 → 显示插值 → 渲染` 生成绘图数据。插值只提高显示采样密度与视觉连续性，不修改原始 SEG-Y，也不代表提高真实地震分辨率。

- 插值方式：Nearest（检查原始采样结构）、Bilinear（交互浏览默认）、Bicubic（科研导出默认）。
- 自适应分辨率：按可见范围与绘图区像素计算渲染网格。数据远密于屏幕像素时做抗混叠降采样（按面积平均，不跳点），明显稀于屏幕像素时插值升采样，并限制在真实采样数的 3 倍以内；单次交互响应限制在 60 万像素以内。
- 缩放 / 平移结束后约 200 ms 重新请求当前可见范围的数据，局部放大得到的是该范围内的原始道与采样点，而不是放大第一次加载的栅格；未请求完成前继续显示当前图像。
- 颜色范围（vmin / vmax）始终由原始剖面计算，缩放与插值方式不会改变配色。
- 悬停与拾取使用 `/api/sample` 读取原始 SEG-Y 采样点，不使用插值后的显示像素；三维切片纹理同样按插值方式重采样，悬停振幅同样回读原始数据。

## 振幅与色彩

- 提供灰度、黑白、红白蓝、发散色标及 Viridis、Turbo 等色标。
- 支持色标反转和振幅极性反转。
- 支持百分位裁剪、手动振幅上下限和对称振幅范围。

## 图片导出

导出采用“暂存 → 队列管理 → 批量打包”流程：

```text
调整视图 → Add to Export（按当前导出参数完成最终渲染）→ Export Queue 管理 → Export All 生成 ZIP
```

- 每次 `Add to Export` 立即渲染最终文件并写入本次会话的临时目录，不触发浏览器下载；加入后继续修改 inline、crossline、色标、层位、相机等设置都不会改变已暂存的图片。
- 顶栏 `Export Queue · N` 打开导出队列，支持 Preview、Rename、Delete、Clear Queue、Export All；Preview 显示的正是 ZIP 中的最终文件。
- `Export All` 只整理已渲染文件和生成 `export_manifest.json`，不重复执行 Matplotlib 或三维高分辨率渲染，最后打包为 `SeisCanvas_{Dataset}_Export_{YYYYMMDD_HHmm}.zip`（多数据集时为 `SeisCanvas_BatchExport_YYYYMMDD_HHmm.zip`）。
- 文件名为自描述式科研命名 `{Dataset}_{View}_{Location/Target}_{Content}_{KeyStyle}_{Size}_{DPI}`，例如 `F3_2D_Inline_IL0350_Horizons6_Seismic_180x100mm_600dpi.png`；同名文件自动追加 `_02`、`_03`。
- 一个 ZIP 可混合 PNG、PDF、SVG，并按 `2D/Inline`、`2D/Crossline`、`3D`、`HorizonMap`、`HorizonProfile` 自动分类；根目录包含 `export_manifest.json`，记录数据集、完整 ViewState 与绘图参数（振幅范围、裁剪百分位、色标、层位颜色与线型、字体、三维相机、光照、透明度、垂向夸张、等值线间隔等）。
- 暂存文件保存在 `/tmp/seiscanvas/session_xxxxxx/`（Windows 使用系统临时目录），包含 `manifest.json` 和 `figures/`；会话结束或超出保留数量后自动清理。

### 二维导出

- 支持 PNG、PDF、SVG。
- 设置图片宽高（毫米）与 300 / 600 DPI。
- 渲染质量：插值方式默认 Bicubic；分辨率默认 Match Export Resolution，按输出像素对原始剖面重新重采样后再叠加层位与坐标轴，导出图不是浏览器截图的放大；选择 Use View Resolution 时复用交互渲染网格。
- 设置字体、字号，以及标题和坐标轴标签的显示状态。

### 三维导出

- 支持 PNG、PDF、SVG。
- 与二维一致，设置图片宽高（毫米）与 300 / 600 DPI；内部据此换算光栅像素（300 DPI 采用 3×、600 DPI 采用 4× 采样），单图上限约 2400 万像素。
- 渲染质量：导出前按最高纹理精度与所选插值方式（默认 Bicubic）重新读取切片，而不是放大交互预览。
- 设置字体与字号，以及背景、坐标轴、轴标签和包围盒的显示状态；导出文字为纯黑 `#000000`（界面预览仍使用界面配色）。

二维、三维与层位地图导出统一提供 DejaVu Sans、DejaVu Serif、Arial、Times New Roman 字体选项及 5–30 pt 字号设置，默认使用 Times New Roman。DejaVu 字体随应用提供，Arial 和 Times New Roman 使用系统字体；系统缺少所选字体时自动回退到对应的衬线或无衬线字体。

## 层位曲面着色

- 完整层位曲面默认按 TWT 着色，每个层位使用自身原始有效拾取点的最小、最大时间独立归一化，共用 Petrel 色带；也可切换为单色。
- Petrel 色带依次为红、橙、黄、绿、青、蓝、紫、品红，对应由低到高的 TWT，与地震振幅色标独立。
- 层位面板和三维图例显示实际 TWT 范围，范围不随预览精度改变；恒定时间层位使用色带中间颜色。
- 曲面默认开启平滑着色和相机光照，透明度为 1，网格边关闭；平滑着色与光照可独立切换。
- 光照使用环境光 0.80、漫反射 0.20、高光 0.05 和粗糙度 0.55，以柔和明暗表现起伏，减少色带变暗。
- 三维预览与导出共用曲面着色和平滑、光照设置。

## Horizon Map

- 独立查看单个层位在 Crossline–Inline 平面的 TWT 分布，支持 Filled Map、Contour、Filled + Contour 三种模式。
- 提供 Petrel、Turbo、Viridis、Cividis、Jet 色标及反转，支持自动范围和手动颜色范围裁剪。
- 显示层位实际 TWT 范围，Colorbar 与当前色标和范围同步。
- 等值线支持间隔、线宽、数值标签和显示开关；原始网格缺失区域保持为空。
- 使用真实网格坐标与等比例坐标轴，支持缩放、平移、重置和悬停读取。
- Matplotlib 根据当前地图状态与可见范围重新生成 PNG、PDF、SVG，支持毫米尺寸、300/600 DPI、字体、字号、标题、坐标轴标签和 Colorbar 设置。填色图栅格化，PDF/SVG 保留等值线、坐标轴和 Colorbar 等矢量内容。

## 大型 SEG-Y 文件

- “导入 SEG-Y”通过系统文件选择器打开本地文件，所有文件均直接读取原文件，无浏览器上传大小限制；首次扫描道头，地震振幅按剖面读取。macOS / Windows 使用系统选择器，Linux 需要桌面环境和 python3-tk。
- 剖面与时间切片缓存同时受 12 项和 256 MB 上限约束，超大单项不缓存。
- 二维网页预览每方向最多 1200 个时间采样、1600 个道位置，保留真实坐标和端点；导出读取原始剖面。预览抽样可能省略局部细节。
- 大文件索引仍需要时间和内存，具体耗时取决于道数、头字段和磁盘读取性能。

SEG-Y 导入仅扫描 Inline / Crossline 道头并建立索引，不再逐道检查起始时间、采样间隔一致性或重复道坐标。时间轴沿用文件采样信息。

### 几何索引缓存

首次打开 SEG-Y 时只读取必要采样信息，并顺序扫描一次 Trace Header 提取 Inline / Crossline；trace_id 由道顺序直接获得。导入期间不读取振幅，不执行逐道时间一致性、重复道或缺道检查。保留首道时间原点，用于正确显示 TWT。

索引以 NumPy 二进制文件保存在项目 `.cache/geometry/`，按文件绝对路径、大小、纳秒修改时间、Inline byte 和 Crossline byte 匹配。命中时直接读取索引，跳过道头扫描与排序；缓存无法写入时仍可正常打开。

适合密集网格的工区保存二维 trace_id 查找表，按行列定位剖面；稀疏或超大网格使用紧凑排序索引。Inline / Crossline 仅读取相应道的振幅；Time Slice 读取各道所选时间采样，均不在导入阶段读取整个数据体。

### Geometry Mode

- **Auto**：默认模式，优先加载几何缓存，无缓存时完整扫描 IL/XL 道头。
- **Regular Grid (Fast)**：适用于已知完整、等间距矩形工区，且按 Inline 或 Crossline 连续排列的数据。读取标准大端 SEG-Y 的 Binary Header，按固定道长计算偏移，以指数搜索和二分搜索定位首个区块边界。支持两个方向升序或降序，仅保存几何参数，通过公式定位 trace_id，不生成全量道头数组或二维查找表。
- 快速模式不保证发现未探测位置的缺道或乱序，不支持蛇形排列。探测失败时提示切换 Auto；两种模式使用独立缓存。快速模式缓存仅含采样信息、首道偏移、道长、维度数量、起点、步长和排列方式。振幅均按需读取。
