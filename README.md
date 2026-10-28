<p>
  <img src="frontend/src/assets/seiscanvas-symbol.svg" alt="SeisCanvas 品牌图标" height="48" align="middle" />
  <img src="frontend/src/assets/seiscanvas-wordmark.svg" alt="SeisCanvas" height="30" align="middle" />
</p>

SeisCanvas **v0.4.0** 是本地运行的地震与层位可视化工具，支持二维剖面、三维场景、层位地图和图件导出。只导入层位即可使用全部层位视图，无需预先导入 SEG-Y。

![SeisCanvas 三维切片与层位曲面界面](assets/screenshots/seiscanvas-3d.png)

## 主要功能

- **数据导入**：支持 SEG-Y 地震体及批量层位文件，可配置道头位置、数据列和层位对应关系。
- **层位管理**：按分组整理、批量显隐和调整样式；同一层位跨分组统一颜色。
- **二维与三维**：Inline / Crossline 剖面、时间切片、层位曲面和切片交线；有 SEG-Y 时支持振幅着色、Wiggle 和 Variable Area。
- **层位地图**：时间、沿层振幅和差值分析，支持填色、等值线、叠加及 A–B 剖面。
- **图件导出**：PNG / PDF / SVG 后台生成，支持预览、重命名、设置恢复和 ZIP 下载。默认名称简短，重名自动加序号。
- **项目保存**：自动保存视图、层位配置和导出队列，支持打开、重命名、另存为及缺失文件重新关联。

## 安装与启动

需要 Python 3.10+、Node.js 18+ 和 npm。从项目根目录运行：

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

打开 <http://127.0.0.1:8000>。再次启动只需运行虚拟环境中的 `python run.py`。远程 Linux 与 SSH 端口转发见 [远程部署指南](DEPLOY_LINUX.md)。

## 使用方法

1. 在“数据”中导入 SEG-Y 或层位。层位文件支持表头、空格或 Tab 分隔，指定 Inline、Crossline、Time 列，时间单位为毫秒。SEG-Y 默认道头字节位置为 Inline 189、Crossline 21。
2. 层位导入依次完成“分组与数据 / 层位对应 / 核对导入”。已有文件可在“分组与层位设置”中批量整理，同名层位自动统一颜色。
3. 切换 **2D / 3D / 层位地图** 调整显示。地图等值线设置位于“显示方式”；设置 A、B 端点后，在“A–B 剖面”页签查看曲线。
4. 点击“保存图件”，确认文件名与导出参数后保存到队列。队列支持预览、下载和恢复图件设置，提交后可继续浏览。

纯层位项目支持二维曲线、三维曲面与交线、时间图、差值图和 A–B 剖面。振幅着色、振幅读数与地震波形需要 SEG-Y；后续导入首个 SEG-Y 会补充到当前项目并保留层位配置。

项目只记录本地源文件路径与设置，不复制原始数据，请保留源文件。工作状态默认保存在系统应用数据目录，可通过 `SEISCANVAS_STATE_DIR` 修改。同一后端实例共享一个活动项目。

## 开发与检查

启动后端后，另开终端执行 `npm --prefix frontend run dev`，访问 <http://127.0.0.1:5173>。完整检查命令：

```bash
python -m pip install -r requirements-dev.txt
npm --prefix frontend test
npm --prefix frontend run build
python -m pytest -q
```

测试使用隔离目录，不修改已保存项目。详细说明见 [渲染与插值](SEISMIC_2D_RENDERING.md)、[视觉规范](UI_DESIGN_SYSTEM.md)、[架构](ARCHITECTURE_REFACTOR_PLAN.md)和[切片内存实测](output/slice-memory-qa/README.md)。
