# 地震剖面振幅插值与渲染

## 开关与保存

2D Inline/Crossline、3D 垂直切片与层位地图 A–B 剖面共用“地震显示”，提供两个独立开关：

| 开关 | 默认 | 开启 | 关闭 |
| --- | --- | --- | --- |
| 背景插值 | 开启 | 时间 Sinc8 + 横向 Linear | 原始振幅网格与实际单元边界 |
| Wiggle 插值 | 开启 | 时间 Sinc8，保留所有原始采样点 | 直接连接原始时间采样点 |

Wiggle 与 Variable Area 的可见性默认关闭。Variable Area 始终采用与 Wiggle 相同的振幅序列。两者的可见性、Gain、填充颜色、振幅裁剪与极性设置保持原有含义。新开关随已有工作状态自动保存，旧工作状态缺少字段时补为开启；绘图区像素尺寸是即时请求参数，不保存为用户偏好。

## 共用振幅核

`backend/resample.py` 的 `sinc8` 是背景与波形共用的有限 8 点核。实现参考 Seismic Unix 的 [mksinc](https://github.com/JohnWStockwellJr/SeisUnix/blob/master/src/cwp/lib/mksinc.c) 和 [inttable8](https://github.com/JohnWStockwellJr/SeisUnix/blob/master/src/cwp/lib/inttable8.c) 数学构造，使用 NumPy 求解最小二乘系数和缓存的 513 相位表；没有复制 SU 源代码。

每次查询使用 `floor(index)-3` 到 `floor(index)+4` 的八个原始采样值。整数位置直接返回原始值，避免浮点加权改变采样点。时间端点采用常值延拓；视窗边缘仍读取完整原始道的核支撑，平移不会把视窗边缘误当成数据边缘。核输出保留过冲，再由已有振幅范围控制显示。

缺失振幅不当作零。背景核遇到有权重的缺失采样会保留空白；波形按连续有效段分别插值，不跨越缺失区连接或填充。背景要求原始时间采样等间距，横向允许不等距 Trace 坐标。

## 实际流程

交互背景：缓存的原始剖面 → 当前可见世界坐标范围与绘图区像素尺寸 → 时间 Sinc8 → 横向 Linear → 振幅范围裁剪与 Colormap → Plotly Heatmap。

背景关闭时，直接传输可见窗口的原始振幅和每个单元的真实 Trace/TWT 边界，不做额外振幅重采样。两个模式都使用 `zsmooth: false`；浏览器按栅格单元显示颜色，不在 RGB 图像上追加 Bicubic 或 Sinc。鼠标振幅查询仍读取原始剖面。

Wiggle：原始道与极性设置 → 可见时间内的 Sinc8 序列及原始采样点（关闭时仅原始点）→ 插入振幅零交叉及裁剪交叉点 → 按显示道间距和 Gain 缩放横向偏移 → 抗锯齿路径。Variable Area 使用同一序列的正振幅多边形，零交叉位置是共享路径两点间的精确线性交点，填充不会越过负振幅。

层序固定为 Color Background → Variable Area → Wiggle → Horizon → Axes。层位世界坐标和拾取逻辑不随背景采样密度变化。

## 分辨率、缓存和导出

背景开启时以可见范围和实际绘图区像素数决定目标网格，交互栅格最多 60 万点，预览最多 15 万点。公共振幅栅格限制为单边 8000 像素、总计 4000 万点；超过目标预算时等比例限制网格。高倍缩放不再受旧的原始网格三倍放大限制。缓存区分剖面、精确可见范围、目标分辨率、插值状态和显示质量；缩放、平移或切换剖面会命中相应缓存或重新重建。

PNG/SVG/PDF 导出沿用两个开关。背景开启时先用原始振幅占位完成布局测量，再按最终绘图区尺寸从原始振幅重建一次；不先执行旧 Bicubic 再执行 Sinc，也不追加 Matplotlib 图像平滑。背景关闭时使用原始单元的 `pcolormesh`。背景栅格化，波形、填充和层位保留矢量路径；Wiggle 的道间隔和时间密度使用交互绘图区尺寸，确保导出波形与当前视图一致。

Export Queue 在加入图件时记录两个开关、有效背景算法和绘图区尺寸，打包时复用已经生成的文件。已有队列条目不会重绘。3D 和 A–B 剖面共用 `section_raster`、Sinc8 核与 `build_trace_overlay`，复用原始缓存，不因切换显示设置重复读取 SEG-Y。原始 SEG-Y、层位解释和定量振幅数据不变。

## 3D 与层位地图剖面

3D Inline/Crossline 切片复用 2D 原始剖面和公共振幅栅格函数。每个可见采样单元由两片恒定面色三角形绘制，颜色在振幅重建、极性和裁剪之后映射，不让 WebGL 在 RGB 颜色之间追加平滑。关闭背景插值时，每个原始单元保持真实的 Trace/TWT 边界。固定 TWT 的 Time Slice 在 Inline/Crossline 平面内使用 Linear／Linear，只显示背景，因为它没有沿时间方向的地震道。

3D 波形使用后台的同一条路径；正振幅波瓣沿相邻时间节点分条三角化，保留零交叉和凹形边界。波形限制在有限剖面内，深度偏置区分背景、填充、波形和层位交线，不偏移实际世界坐标。当前相机的投影宽高以 CSS 像素控制道间隔和目标网格，按 32 像素量化以避免相机微动反复请求；网格仍受现有场景质量预算限制。缩放、调整视角或窗口尺寸会更新显示请求，缓存与原始采样共享。

A–B 剖面保留原有空间路径取样：从 A、B 的四邻道线性组合出原始时间道，路径按固定网格步长取样，并缓存这一序列。随后使用与 2D 一致的时间 Sinc8／横向 Linear 背景与波形规则。背景开关关闭时，只显示这些路径道的原始时间采样单元。层位曲线使用固定原始路径坐标 `curve_distance`，缩放或切换背景插值不会改变曲线几何。鼠标振幅读数沿用已有 `/api/sample` 和原始 SEG-Y 查询，不查询重建后的显示像素。地图自身的层位 Time、沿层振幅和差值计算不受显示插值开关影响。

A–B 的“剖面显示”中可设置固定横纵比例；比例与 2D 共用已保存的设置。剖面缩放、平移范围单独保存在地图工作状态中，调整端点后重置范围，调整剖面高度会按实际子图大小更新采样。独立剖面导出沿用插值、裁剪、极性、Gain、填充、可见范围和比例，并复用 2D 层位的可见性、线型、线宽、标记和描边，传递曲线／图例／A–B 标注开关；背景关闭时不调用隐藏的高阶图像重采样。

PNG、SVG、PDF 均提供白色／透明背景选择。2D 和 A–B 的文字、坐标轴、波形、填充及层位为矢量对象，地震背景为栅格；3D 场景保留相机一致的高清 RGBA 栅格，PDF/SVG 坐标轴、刻度和文字从当前 GL 字形与线条几何投影为矢量轮廓。3D 文字轮廓可以无损缩放，但不是可选择的 PDF 文本。旧队列文件需重新保存才能采用新流程。

## 验证

数值测试覆盖 SU 核参考系数、原始点保持、短道及时间边界、正弦重建、缺失值、8 点有限支撑、横向线性与世界坐标映射。渲染测试覆盖开关独立性、原始网格、零交叉填充、平移核支撑、缓存、最终绘图区一次重建、三种导出格式及工作状态恢复。

## 修改文件

| 文件 | 修改职责 |
| --- | --- |
| `backend/resample.py` | 共享 Sinc8 相位表与时间 Sinc／横向 Linear 背景振幅函数 |
| `backend/trace_overlay.py` | 原始网格边界、可见范围、波形时间重建与共享填充路径 |
| `backend/section_service.py` | 2D、3D、A–B 共用背景、原始网格、缓存及配置元数据 |
| `backend/scene.py`、`backend/horizon_map.py` | 3D 与 A–B 剖面接入公共振幅、叠加路径和比例导出 |
| `backend/rendering.py` | 2D 背景与矢量叠加导出，原始单元显示，共用层位绘制 |
| `backend/figure_export.py` | 最终绘图区一次振幅重建、三格式透明背景和矢量字体 |
| `backend/export3d.py`、`frontend/src/components/SeismicViewer3D/vectorAxes.ts`、`shaderUniforms.ts` | 3D RGBA 与当前原生字形、轴线的矢量导出，安全读取 GL 程序参数 |
| `backend/models.py` | 两个独立插值开关与即时绘图区高度参数 |
| `backend/export_service.py` | 导出清单中的开关、有效算法和绘图区高度 |
| `frontend/src/types.ts` | 显示配置、原始单元边界和响应元数据类型 |
| `frontend/src/App.tsx` | 默认值、开关更新、绘图区宽高请求和导出传递 |
| `frontend/src/components/panels/SeismicPanel.tsx` | 三种剖面共用的显示与独立插值开关 |
| `frontend/src/components/SeismicViewer3D/sceneGeometry.ts`、`sliceViewport.ts` | 采样单元面色、波形和填充几何、相机投影像素测量 |
| `frontend/src/components/HorizonMap.tsx`、`horizonMapLogic.ts`、`workspace.ts` | A–B 显示、缩放、比例、请求依赖、工作状态和导出配置 |
| `frontend/src/components/SeismicViewer2D/SectionPlot.tsx` | 布局与尺寸变化后测量实际绘图区宽高 |
| `frontend/src/components/SeismicViewer2D/sectionDisplay.ts` | 绘图区测量、请求依赖与旧后端响应检查 |
| `frontend/src/components/SeismicViewer2D/sectionGeometry.ts` | 原始单元边界与稳定世界坐标，空白振幅的极性处理 |
| `README.md`、`SEISMIC_2D_RENDERING.md` | 用户入口、实际流程、边界处理和验证说明 |

新增 `tests/test_sinc8.py`、`tests/test_sinc_rendering.py`、`frontend/tests/sectionPlot.test.mjs`；更新现有 display interpolation、trace overlay、fit export、export queue、workspace、section geometry 和坐标范围测试。

新增跨视图回归测试 `tests/test_shared_sections.py`，覆盖相同输入下 2D／3D 背景和波形路径一致、Time Slice 空间线性、原始单元、禁止旧 Bicubic、缓存、裁剪极性与 A–B 比例及导出。前端测试覆盖凹形波瓣、零交叉、平面坐标、关闭状态、面色、投影尺寸和显示请求失效。
