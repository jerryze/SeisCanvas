# 2D 层位 SG 平滑显示

## 设置与显示通道

「层位」面板中的统一 **SG 平滑显示** 开关默认关闭，作用于所有可见的 Inline/Crossline 层位；开启后显示窗口选择 **5、7、11、15 道**，默认 7，道数和开关随工作状态保存。多项式阶数固定为 2。

完整原始层位剖面由 `Horizon.section()` 获取，数据为 `[横向坐标, 时间]`，Inline 的横坐标为 Crossline，Crossline 的横坐标为 Inline。后端生成独立的 `horizon_display` 字段，`horizons` 继续保留原始点。前端沿用 Plotly Scatter/SVG 绘制显示线及描边，原始 trace 负责标记、鼠标拾取与坐标查询。

关闭 SG 时前端立即重新选择原始点，不等待后端响应。窗口、剖面位置和方向必须与显示数据的元信息相符，过期响应不会用于绘制当前 SG 曲线。

现有「平滑曲线」开关仍控制 PCHIP 连接方式。SG 降低原始节点时间抖动，PCHIP 可进一步平顺 SG 节点间的连接；两者均不写回原始拾取。单独关闭 SG 后恢复原始节点，若 PCHIP 开启，则仍以 PCHIP 连接这些原始节点。

## 算法与边界

共用算法位于 `backend/horizon_display.py`，使用 `scipy.signal.savgol_filter`，`polyorder=2`、`mode="interp"`，只处理每个有效段的时间列。浮点计算结果不取整、不重新对齐地震采样时间，不进行二维滤波。使用 SciPy 的原因是让屏幕显示与后端图件导出共享成熟的同一实现；没有增加前端依赖。

先对有明确横坐标的数据按 x 稳定排序；未知横坐标的缺口分隔两侧的排序区间。已知 x 但时间无效的点按坐标放置并作为缺口。再检查原始地震剖面的道间距，以最小正间距作为保守基准，仅连接间距一致的相邻有效点。较大或不规则间距、重复横坐标、无效时间都会切断有效段，显示路径加入空节点，不跨缺口滤波或连线。重复横坐标的拾取分别保留，不平均或合并。

每段使用不大于其长度的最大可用奇数窗口；长度不足 3 的段保留原始值，3 点窗口对二次多项式拟合基本保持原值。不规则区域无法构成足够长的等间距段时保留原始节点，避免把不规则坐标直接作为等间距序列处理。边界使用该段首尾有效窗口的局部二次多项式拟合，避免补零或首尾循环连接引入偏移。算法依据见 [SciPy SG 官方说明](https://docs.scipy.org/doc/scipy/reference/generated/scipy.signal.savgol_filter.html)。

## 缓存和数据保护

SG 始终依据完整剖面计算；屏幕和导出随后按坐标轴范围裁剪，缩放与平移不改变窗口输入或端点拟合。每个层位对象拥有独立、最多 32 项的缓存，键包含剖面方向、位置、窗口和道间距，不包含缩放、时间范围或线条样式。原始剖面内容摘要校验可识别原位修改及数组替换；层位删除或重载后，弱引用缓存自动释放。返回的缓存数组只读。

算法使用独立数组，不修改 `Horizon.data`、原始文件或 API 中的原始 `horizons`。TXT 数据导出仍可使用原始数据；标记点、鼠标拾取及原始 SEG-Y 查询继续使用原始坐标。Wiggle、Variable Area 与地震背景的重建逻辑保持原有实现。

## 图件导出

PNG、SVG、PDF 的 2D 导出调用同一 SG 缓存及分段算法。描边与彩色线共用显示节点，标记仍保留原始位置，线型、颜色及宽度沿用原样。SG 与 PCHIP 同时开启时，导出也对 SG 节点进行 PCHIP 连接，并按输出分辨率生成显示节点。SVG/PDF 层位由 Matplotlib 矢量线条绘制，没有栅格化层位路径。导出队列保存当时的开关和窗口及已渲染文件，后续调整显示不会修改已入队图件。

## 修改文件

| 文件 | 修改内容 |
| --- | --- |
| `backend/horizon_display.py` | SG 分段、道间距检查、浮点计算、完整剖面缓存、导出 PCHIP 及 JSON 缺口处理 |
| `backend/models.py` | `horizon_sg=false`、`horizon_sg_window=7`，仅允许四种窗口 |
| `backend/section_service.py` | 在原始点之外返回独立 SG 显示字段及剖面元信息 |
| `backend/rendering.py` | SG 图件线条与原始标记分离，矢量导出复用显示算法 |
| `backend/export_service.py` | 导出摘要记录 SG 开关及窗口 |
| `frontend/src/components/panels/HorizonPanel.tsx` | 统一开关和条件显示的窗口选择 |
| `frontend/src/components/SeismicViewer2D/sectionGeometry.ts` | SG 线条/描边绘制、响应参数核对、原始交互通道隔离 |
| `frontend/src/App.tsx`、`frontend/src/types.ts` | 默认设置、参数更新请求、状态与响应类型 |
| `requirements.txt` | 增加后端 `scipy>=1.11`，本地验证使用 SciPy 1.13.1 |
| `tests/test_horizon_sg.py` | 数值、分段、短段、缓存、两个剖面方向、三种图件格式及队列测试 |
| `frontend/tests/sectionGeometry.test.mjs`、`frontend/tests/workspace.test.mjs` | 原始点保护、即时关闭、过期响应与工作状态恢复 |

## 验证结果

前端 72 项测试及生产构建通过。后端覆盖 SG、现有 PCHIP、共用剖面、Wiggle/Variable Area、原始数据、工作状态与图件导出。SG 测试用已知 5 点系数独立核对滤波值，并验证四种窗口保留二次趋势及端点、降低抖动；同时检查缓存命中、编辑后失效、缺口、不规则坐标及短段退化。

浏览器实测默认关闭、默认 7 道、四种窗口和关闭后恢复；四个窗口产生不同 SVG 曲线，原始拾取 SVG 路径始终相同，描边与显示线始终重合。切换 Crossline 后仍正确显示，并以 Inline 为横坐标。验证使用端口 8001 的独立临时工作状态。

F3 示例 Inline 350 的 horizon_1，相邻时间差的标准差为：

| 显示 | 相邻时间差标准差（ms） |
| --- | ---: |
| 原始 | 0.880390 |
| SG 5 道 | 0.619703 |
| SG 7 道 | 0.514367 |
| SG 11 道 | 0.400071 |
| SG 15 道 | 0.332815 |

以上用于验证该示例的抖动减少效果，并不代表窗口越大越适合每条层位。

同范围浏览器截图：

- [关闭 SG](output/horizon-sg-qa/off.png)
- [5 道](output/horizon-sg-qa/window-5.png)
- [7 道](output/horizon-sg-qa/window-7.png)
- [11 道](output/horizon-sg-qa/window-11.png)
- [15 道](output/horizon-sg-qa/window-15.png)
- [Crossline / 7 道](output/horizon-sg-qa/crossline-7.png)
