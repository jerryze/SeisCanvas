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

## 三维场景

- 组合显示多个 Inline、Crossline 和 Time Slice，每类最多 12 个，总计最多 18 个。
- 独立设置切片位置、可见性、透明度、边框颜色与宽度，并支持移除切片。
- 层位支持完整曲面和切片交线两种显示模式。
- 完整层位支持曲面、网格、曲面与网格叠加，支持颜色、透明度和网格线宽设置。
- Inline / Crossline 交线支持线型、线宽、颜色、标记点和描边设置。
- 支持旋转、缩放、平移、相机重置，以及 Perspective、Top、Inline、Crossline 快捷视角。
- 支持坐标轴、轴标签、包围盒的显示开关，以及背景颜色和 XYZ 显示比例设置。

## 振幅与色彩

- 提供灰度、黑白、红白蓝、发散色标及 Viridis、Turbo 等色标。
- 支持色标反转和振幅极性反转。
- 支持百分位裁剪、手动振幅上下限和对称振幅范围。

## 图片导出

### 二维导出

- 支持 PNG、PDF、SVG。
- 设置图片宽高（毫米）与 300 / 600 DPI。
- 设置字体、字号，以及标题和坐标轴标签的显示状态。

### 三维导出

- 支持 PNG、PDF、SVG。
- 设置图片宽高（像素）和 1–4 倍输出分辨率。
- 设置字体与字号，以及背景、坐标轴、轴标签和包围盒的显示状态。

二维与三维导出均提供 DejaVu Sans、DejaVu Serif、Arial、Times New Roman 字体选项及 5–30 pt 字号设置。DejaVu 字体随应用提供，Arial 和 Times New Roman 使用系统字体。
