import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  ArrowDown,
  ArrowRight,
  AudioLines,
  Check,
  ChevronRight,
  Layers,
  MousePointer2,
  RotateCcw,
  Undo2,
} from "lucide-react";
import { track, trainNetwork, type Section, type Point } from "./engine";
import "./story.css";
const titles = [
  "听见地下",
  "回声成像",
  "读懂条纹",
  "认识层位",
  "亲手拾取",
  "走向自动",
];
function useJourney() {
  const [active, setActive] = useState(0);
  useEffect(() => {
    const sections = [
      ...document.querySelectorAll<HTMLElement>(".story-chapter"),
    ];
    let raf = 0;
    const update = () => {
      raf = 0;
      let current = 0;
      sections.forEach((el, i) => {
        const r = el.getBoundingClientRect();
        const visual = el.querySelector(
          ".formation,.horizon-figure,.echo-scene,.phase-figure,.picking-figure,.methods-figure",
        );
        const top = visual?.getBoundingClientRect().top ?? r.top;
        const p = Math.max(
          0,
          Math.min(1, (innerHeight * 0.85 - top) / (innerHeight * 0.58)),
        );
        el.style.setProperty("--reveal", String(p));
        if (r.top < innerHeight * 0.52) {
          current = i;
          el.classList.add("has-entered");
        }
        if (r.top < innerHeight * 0.87) el.classList.add("visible");
      });
      setActive(current);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    addEventListener("scroll", onScroll, { passive: true });
    addEventListener("resize", onScroll);
    const observer = new ResizeObserver(onScroll);
    sections.forEach((el) => observer.observe(el));
    return () => {
      observer.disconnect();
      removeEventListener("scroll", onScroll);
      removeEventListener("resize", onScroll);
      cancelAnimationFrame(raf);
    };
  }, []);
  return active;
}
function EchoScene() {
  return (
    <div className="echo-scene">
      <div className="figure-label">
        <span>01 — 一次回声的旅程</span>
        <span>原理示意 · 非真实比例</span>
      </div>
      <svg
        viewBox="0 0 1000 410"
        role="img"
        aria-label="震源发射地震波，在岩层界面反射后被地表检波器接收"
      >
        <defs>
          <linearGradient id="ground" x2="0" y2="1">
            <stop stopColor="#edf0ec" />
            <stop offset="1" stopColor="#ccd7d4" />
          </linearGradient>
          <linearGradient id="layer" x2="0" y2="1">
            <stop stopColor="#d1dfdf" />
            <stop offset="1" stopColor="#b0c9cd" />
          </linearGradient>
        </defs>
        <path
          d="M40 110 Q310 106 500 116 T960 108 L960 390 L40 390Z"
          fill="url(#ground)"
        />
        <path
          d="M40 218 C270 173 405 267 630 226 S850 184 960 208 L960 390 L40 390Z"
          fill="url(#layer)"
        />
        <path
          d="M40 307 C230 251 420 343 630 303 S850 266 960 290 L960 390 L40 390Z"
          fill="#8caeb9"
          opacity=".58"
        />
        <path
          d="M40 218 C270 173 405 267 630 226 S850 184 960 208"
          fill="none"
          stroke="#6c969f"
          strokeWidth="2"
        />
        <path
          d="M40 307 C230 251 420 343 630 303 S850 266 960 290"
          fill="none"
          stroke="#638d9d"
          strokeWidth="1.5"
        />
        <path
          d="M40 110 Q310 106 500 116 T960 108"
          fill="none"
          stroke="#a4b6ab"
          strokeWidth="2"
        />
        <g transform="translate(200 72)">
          <path d="M-32 24V0H14L31 14V24Z" fill="#2e6adc" />
          <path d="M17 5L26 14H17Z" fill="#dbeaff" />
          <circle cx="-19" cy="26" r="9" fill="#253b58" />
          <circle cx="21" cy="26" r="9" fill="#253b58" />
          <rect x="-7" y="28" width="14" height="10" rx="2" fill="#2e6adc" />
        </g>
        <text x="200" y="48" textAnchor="middle" className="svg-title">
          震源
        </text>
        <text x="742" y="48" textAnchor="middle" className="svg-title">
          检波器记录回声
        </text>
        {[560, 640, 720, 800, 880].map((x, i) => (
          <g key={x}>
            <path d={`M${x - 8} 100L${x} 88L${x + 8} 100Z`} fill="#3579d6" />
            <path d={`M${x} 100v15`} stroke="#3579d6" strokeWidth="2" />
            <circle
              className="receiver-flash"
              style={{ animationDelay: `${i * 0.16 + 2}s` }}
              cx={x}
              cy="94"
              r="15"
              fill="none"
              stroke="#408af0"
            />
          </g>
        ))}
        <path
          className="wave-ray down"
          d="M200 110L427 238"
          fill="none"
          stroke="#327ff0"
          strokeWidth="2.5"
        />
        <path
          className="wave-ray up"
          d="M427 238L720 114"
          fill="none"
          stroke="#327ff0"
          strokeWidth="2.5"
          strokeDasharray="6 5"
        />
        <circle className="wave-dot" r="5" fill="#1768e2">
          <animateMotion
            dur="4s"
            repeatCount="indefinite"
            path="M200 110L427 238L720 114"
          />
        </circle>
        <circle
          className="echo-ring"
          cx="200"
          cy="110"
          r="28"
          fill="none"
          stroke="#3f85e6"
        />
        <circle
          className="echo-ring second"
          cx="200"
          cy="110"
          r="28"
          fill="none"
          stroke="#3f85e6"
        />
        <circle
          cx="427"
          cy="238"
          r="6"
          fill="#fff"
          stroke="#367ddb"
          strokeWidth="2"
        />
        <text x="249" y="158" className="svg-small">
          向下传播
        </text>
        <text x="562" y="169" className="svg-small">
          反射返回
        </text>
        <text x="690" y="260" className="svg-small dark">
          岩层界面：两侧声阻抗不同
        </text>
        <text x="65" y="365" className="svg-small dark">
          更深的界面也会产生反射
        </text>
      </svg>
      <div className="echo-steps">
        <span>
          <b>01</b>发出振动
        </span>
        <ChevronRight />
        <span>
          <b>02</b>遇到界面
        </span>
        <ChevronRight />
        <span>
          <b>03</b>部分能量反射
        </span>
        <ChevronRight />
        <span>
          <b>04</b>记录回声
        </span>
      </div>
    </div>
  );
}
function Seismic({
  section,
  points = [],
  reveal = false,
  interactive = false,
  onPick,
  seed,
  hero = false,
}: {
  section: Section;
  points?: Point[];
  reveal?: boolean;
  interactive?: boolean;
  onPick?: (p: Point) => void;
  seed?: Point | null;
  hero?: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [cursor, setCursor] = useState<Point>({ x: 100, y: 80 });
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    c.width = section.x.length;
    c.height = 256;
    const im = ctx.createImageData(c.width, c.height);
    for (let x = 0; x < c.width; x++)
      for (let y = 0; y < 256; y++) {
        const i = (y * c.width + x) * 4,
          v = Math.round(143 - section.values[x][y] * 108);
        im.data[i] = v;
        im.data[i + 1] = v + 2;
        im.data[i + 2] = v + 4;
        im.data[i + 3] = 255;
      }
    ctx.putImageData(im, 0, 0);
  }, [section]);
  const sorted = points.slice().sort((a, b) => a.x - b.x);
  const path = sorted
    .map(
      (p, i) =>
        `${i ? "L" : "M"}${(p.x / (section.x.length - 1)) * 1000},${(p.y / 255) * 440}`,
    )
    .join(" ");
  const position = (e: React.MouseEvent | React.PointerEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(
        0,
        Math.min(
          section.x.length - 1,
          Math.round(((e.clientX - r.left) / r.width) * (section.x.length - 1)),
        ),
      ),
      y: Math.max(
        0,
        Math.min(255, Math.round(((e.clientY - r.top) / r.height) * 255)),
      ),
    };
  };
  return (
    <div className={`story-seismic ${hero ? "hero-seismic" : ""}`}>
      <div
        className={`seismic-stage ${interactive ? "pickable" : ""}`}
        tabIndex={interactive ? 0 : undefined}
        role={interactive ? "application" : undefined}
        aria-label={
          interactive ? "层位拾取：点击放置种子，或方向键移动光标后按回车" : ""
        }
        onPointerMove={(e) => {
          if (interactive) setCursor(position(e));
        }}
        onClick={(e) => {
          if (interactive) onPick?.(position(e));
        }}
        onKeyDown={(e) => {
          if (!interactive) return;
          if (
            [
              "ArrowLeft",
              "ArrowRight",
              "ArrowUp",
              "ArrowDown",
              "Enter",
              " ",
            ].includes(e.key)
          ) {
            e.preventDefault();
            if (e.key === "Enter" || e.key === " ") onPick?.(cursor);
            else
              setCursor((p) => ({
                x: Math.max(
                  0,
                  Math.min(
                    section.x.length - 1,
                    p.x +
                      (e.key === "ArrowRight"
                        ? 1
                        : e.key === "ArrowLeft"
                          ? -1
                          : 0),
                  ),
                ),
                y: Math.max(
                  0,
                  Math.min(
                    255,
                    p.y +
                      (e.key === "ArrowDown"
                        ? 1
                        : e.key === "ArrowUp"
                          ? -1
                          : 0),
                  ),
                ),
              }));
          }
        }}
      >
        <canvas
          ref={ref}
          aria-label={`真实 F3 地震剖面 Inline ${section.inline}`}
        />
        <svg
          viewBox="0 0 1000 440"
          preserveAspectRatio="none"
          className={reveal ? "horizon-reveal" : ""}
          aria-hidden="true"
        >
          <path
            d={path}
            fill="none"
            stroke="#fff"
            strokeWidth="5"
            opacity=".55"
          />
          <path d={path} fill="none" stroke="#2b81fa" strokeWidth="2.8" />
          {seed && (
            <>
              <circle
                cx={(seed.x / (section.x.length - 1)) * 1000}
                cy={(seed.y / 255) * 440}
                r="7"
                fill="#fff"
                stroke="#1869e1"
                strokeWidth="3"
              />
              <circle
                cx={(seed.x / (section.x.length - 1)) * 1000}
                cy={(seed.y / 255) * 440}
                r="15"
                fill="none"
                stroke="#fff"
                opacity=".7"
              />
            </>
          )}
          {interactive && (
            <g className="pick-crosshair" stroke="#fff" strokeWidth="1">
              <path
                d={`M${(cursor.x / (section.x.length - 1)) * 1000 - 9},${(cursor.y / 255) * 440}h18 M${(cursor.x / (section.x.length - 1)) * 1000},${(cursor.y / 255) * 440 - 9}v18`}
              />
            </g>
          )}
        </svg>
        {hero && (
          <div className="hero-image-caption">
            <span>F3 · 荷兰北海</span>
            <span>真实地震剖面 / INLINE 350</span>
          </div>
        )}
      </div>
      {!hero && (
        <>
          <div className="seismic-y">
            <span>200</span>
            <span>710</span>
            <span>1220</span>
            <b>双程走时 / ms</b>
          </div>
          <div className="seismic-x">
            <span>310</span>
            <span>Crossline · 横向位置</span>
            <span>1202</span>
          </div>
        </>
      )}
    </div>
  );
}
function Formation({ section }: { section: Section }) {
  return (
    <div className="formation">
      <div className="formation-single">
        <div className="diagram-number">01 / 一道</div>
        <svg viewBox="0 0 160 270" aria-label="单个位置的地震振幅随时间变化">
          <line x1="80" x2="80" y1="8" y2="262" stroke="#c9d4e2" />
          <path
            d={
              "M" +
              section.values[100]
                .map((a, y) => `${80 + a * 58},${y + 8}`)
                .join(" L")
            }
            fill="none"
            stroke="#2879e6"
            strokeWidth="1.8"
          />
        </svg>
        <b>一个位置，一条曲线</b>
        <p>记录振幅随时间的变化</p>
      </div>
      <div className="formation-middle">
        <div className="diagram-number">02 / 一面</div>
        <div className="trace-assembly">
          {Array.from({ length: 32 }, (_, i) => (
            <svg
              key={i}
              viewBox="0 0 20 256"
              preserveAspectRatio="none"
              style={{ "--i": i } as CSSProperties}
            >
              <path
                d={
                  "M" +
                  section.values[i * 7]
                    .map((a, y) => `${10 + a * 12},${y}`)
                    .join(" L")
                }
                fill="none"
                stroke={i % 5 === 0 ? "#2d79dc" : "#45566c"}
                strokeWidth=".85"
              />
            </svg>
          ))}
        </div>
        <b>许多道并排，形成剖面</b>
        <p>沿一条测线，观察地下起伏</p>
      </div>
      <div className="formation-volume">
        <div className="diagram-number">03 / 一体</div>
        <div className="paper-cube">
          {[0, 1, 2, 3, 4].map((i) => (
            <div
              className="cube-slice"
              style={{ "--i": i } as CSSProperties}
              key={i}
            >
              <svg viewBox="0 0 160 200">
                {Array.from({ length: 27 }, (_, j) => (
                  <path
                    key={j}
                    d={
                      "M" +
                      Array.from(
                        { length: 40 },
                        (_, x) =>
                          `${x * 4},${j * 7 + Math.sin(x / 7 + j / 4) * 6}`,
                      ).join(" L")
                    }
                    fill="none"
                    stroke="#7895b7"
                    strokeWidth="1"
                  />
                ))}
              </svg>
            </div>
          ))}
        </div>
        <b>相邻剖面，组成数据体</b>
        <p>Inline × Crossline × 时间</p>
      </div>
      <div className="formation-note">
        左、中：真实 F3 波形 &nbsp; / &nbsp; 右：数据体结构示意
      </div>
    </div>
  );
}
function PhaseFigure() {
  return (
    <div className="phase-figure">
      <svg
        viewBox="0 0 940 270"
        role="img"
        aria-label="波峰、波谷、零交叉及相邻地震道之间的反射同相轴"
      >
        <defs>
          <linearGradient id="peakFill" x2="0" y2="1">
            <stop stopColor="#d7e8ff" />
            <stop offset="1" stopColor="#f5f9ff" />
          </linearGradient>
        </defs>
        <line
          x1="40"
          x2="425"
          y1="133"
          y2="133"
          stroke="#bdcce0"
          strokeDasharray="4 6"
        />
        <path
          d="M45 133C75 133 77 43 112 43S146 223 181 223S216 43 250 43S285 223 319 223S356 133 410 133"
          fill="none"
          stroke="#2d7ce5"
          strokeWidth="3"
        />
        <circle cx="112" cy="43" r="5" fill="#2979e2" />
        <circle cx="181" cy="223" r="5" fill="#2979e2" />
        <circle
          cx="146"
          cy="133"
          r="5"
          fill="#fff"
          stroke="#2c79e1"
          strokeWidth="2"
        />
        <text x="112" y="22" textAnchor="middle" className="svg-title">
          波峰
        </text>
        <text x="181" y="254" textAnchor="middle" className="svg-title">
          波谷
        </text>
        <text x="150" y="112" className="svg-small">
          零交叉
        </text>
        <text x="353" y="157" className="svg-small dark">
          时间 →
        </text>
        <line x1="473" x2="473" y1="20" y2="245" stroke="#e1e8f1" />
        {Array.from({ length: 14 }, (_, i) => (
          <path
            key={i}
            d={
              "M" +
              Array.from(
                { length: 140 },
                (_, y) =>
                  `${527 + i * 26 + Math.sin((y - i * 1.2) / 8) * 10},${y * 1.4 + 25}`,
              ).join(" L")
            }
            fill="none"
            stroke="#9cacbe"
            strokeWidth="1"
          />
        ))}
        <path
          className="phase-axis"
          d="M537 43L875 64.8"
          stroke="#2d7ce5"
          strokeWidth="3"
          fill="none"
        />
        <text x="612" y="20" className="svg-title">
          连接相邻道上的同一相位
        </text>
        <text x="634" y="259" className="svg-small">
          反射同相轴 · Reflection event
        </text>
      </svg>
      <div className="diagram-disclaimer">
        波形概念示意；实际地震波形更复杂。
      </div>
    </div>
  );
}
function SurfaceFigure({ sections }: { sections: Section[] }) {
  const project = (x: number, t: number, i: number) =>
    `${100 + x * 2.3 + i * 95},${155 + (t - 450) * 0.45 - i * 42}`;
  const usable = sections.map((s) => s.reference.map((t) => t ?? 480));
  return (
    <div className="surface-figure">
      <svg
        viewBox="0 0 880 350"
        role="img"
        aria-label="三条真实层位解释线及其间的示意插值表面"
      >
        {[0, 1].map((i) => (
          <path
            key={i}
            d={
              "M" +
              usable[i].map((t, x) => project(x, t, i)).join(" L") +
              " L" +
              usable[i + 1]
                .map((t, x) => project(x, t, i + 1))
                .reverse()
                .join(" L") +
              " Z"
            }
            fill={i ? "#5e9fe8" : "#95bcec"}
            opacity=".38"
          />
        ))}
        {sections.map((s, i) => (
          <g key={s.inline}>
            <path
              d={"M" + usable[i].map((t, x) => project(x, t, i)).join(" L")}
              fill="none"
              stroke="#347fe1"
              strokeWidth="2.5"
            />
            <text x={80 + i * 95} y={200 - i * 42} className="svg-small">
              IL {s.inline}
            </text>
          </g>
        ))}
        {Array.from({ length: 18 }, (_, j) => (
          <path
            key={j}
            d={
              "M" +
              usable.map((a, i) => project(j * 13, a[j * 13], i)).join(" L")
            }
            fill="none"
            stroke="#5591da"
            opacity=".45"
          />
        ))}
        <path
          d="M102 257h175m-175 0l-45-52m45 52v43"
          fill="none"
          stroke="#a8b8cd"
        />
        <text x="188" y="279" className="svg-small dark">
          Crossline
        </text>
        <text x="24" y="195" className="svg-small dark">
          Inline
        </text>
        <text x="111" y="311" className="svg-small dark">
          走时
        </text>
        <text x="555" y="240" className="svg-title">
          多条解释线，连接成一张面
        </text>
        <text x="555" y="267" className="svg-small dark">
          测线之间仍需检查，不能跨断层盲目插值。
        </text>
      </svg>
      <span className="diagram-disclaimer">
        真实 F3 参考层位线 + 示意线性插值 · 垂向夸张 · 非完整工区解释
      </span>
    </div>
  );
}
function Picking({ section }: { section: Section }) {
  const [history, setHistory] = useState<Point[]>([]),
    [points, setPoints] = useState<Point[]>([]),
    [count, setCount] = useState(0);
  const seed = history.at(-1);
  useEffect(() => {
    if (!seed) {
      setPoints([]);
      setCount(0);
      return;
    }
    const output = track(section, seed, 0.65, 4);
    setPoints(output);
    setCount(0);
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setCount(output.length);
      return;
    }
    let n = 0;
    const t = setInterval(() => {
      n += 4;
      setCount(Math.min(n, output.length));
      if (n >= output.length) clearInterval(t);
    }, 30);
    return () => clearInterval(t);
  }, [seed, section]);
  return (
    <div className="picking-figure">
      <div className="picking-bar">
        <span>
          <span className="live-dot" />
          轮到你了 <small>点击清晰的反射条纹，放下一个种子点</small>
        </span>
        <div>
          <button
            disabled={!history.length}
            onClick={() => setHistory((h) => h.slice(0, -1))}
            title="撤销最近的种子点"
          >
            <Undo2 size={15} />
            撤销
          </button>
          <button disabled={!history.length} onClick={() => setHistory([])}>
            <RotateCcw size={14} />
            重来
          </button>
        </div>
      </div>
      <Seismic
        section={section}
        points={points.slice(0, count)}
        interactive
        seed={seed}
        onPick={(p) => setHistory((h) => [...h, p])}
      />
      <div className="pick-feedback" aria-live="polite">
        {seed ? (
          <>
            <span>
              <Check size={15} />
              {count < points.length
                ? "正在比较相邻波形…"
                : `从种子向两侧追踪了 ${count} 道`}
            </span>
            <span>
              XL {section.x[seed.x]} · {200 + seed.y * 4} ms
              {count === points.length ? " · 不确定处自动停止" : ""}
            </span>
          </>
        ) : (
          <>
            <span>
              <MousePointer2 size={16} />
              试着点击 450–550 ms 附近的一条连续反射
            </span>
            <span>真实计算 · 非预设动画</span>
          </>
        )}
      </div>
      <div className="pick-instruction">
        {seed
          ? "发现蓝线走错了？在你认为正确的反射上重新点击，替换种子并重新追踪。也可以撤销，回到上一次解释。"
          : "你选择目标，算法帮助延伸。蓝线只依据局部波形，不保证地质正确；断层和噪声附近尤其需要你检查。"}
      </div>
    </div>
  );
}
function Methods({ section }: { section: Section }) {
  const [method, setMethod] = useState(0);
  const model = useRef<ReturnType<typeof trainNetwork> | null>(null);
  if (!model.current) model.current = trainNetwork(section, 150);
  const refpoints = section.reference.flatMap((t, x) =>
    t === null ? [] : [{ x, y: (t - 200) / 4 }],
  );
  const auto = track(
    section,
    refpoints[Math.floor(refpoints.length / 2)],
    0.65,
    4,
  );
  return (
    <div className="methods-figure">
      <div className="method-tabs" role="tablist" aria-label="自动拾取方法">
        {["传统追踪", "深度学习", "人机协作"].map((m, i) => (
          <button
            key={m}
            role="tab"
            aria-selected={method === i}
            onClick={() => setMethod(i)}
          >
            <span>0{i + 1}</span>
            {m}
          </button>
        ))}
      </div>
      <div className="method-body">
        <div className="method-graphic">
          {method === 0 ? (
            <svg viewBox="0 0 450 235" aria-label="相邻波形窗口的匹配比较">
              {[0, 1, 2].map((i) => (
                <g key={i}>
                  <path
                    d={
                      "M" +
                      Array.from(
                        { length: 140 },
                        (_, y) =>
                          `${75 + i * 140 + section.values[100 + i][y + 30] * 40},${y * 1.4 + 15}`,
                      ).join(" L")
                    }
                    fill="none"
                    stroke={i === 1 ? "#2e7be2" : "#8398b5"}
                    strokeWidth="2"
                  />
                  <rect
                    x={43 + i * 140}
                    y="65"
                    width="64"
                    height="62"
                    rx="6"
                    fill="#3c85ed"
                    fillOpacity=".08"
                    stroke="#78a4de"
                    strokeDasharray="4 4"
                  />
                  <text
                    x={75 + i * 140}
                    y="230"
                    textAnchor="middle"
                    className="svg-small"
                  >
                    第 {i + 1} 道
                  </text>
                </g>
              ))}
              <path
                d="M111 95h65m75 0h65"
                stroke="#377fe0"
                strokeWidth="2"
                strokeDasharray="4 5"
              />
            </svg>
          ) : method === 1 ? (
            <div className="network-diagram">
              <span>
                真实振幅
                <br />
                <small>+ 已有解释标签</small>
              </span>
              <ArrowRight />
              <div className="neural-nodes">
                {Array.from({ length: 12 }, (_, i) => (
                  <i key={i} />
                ))}
              </div>
              <ArrowRight />
              <span>
                逐道走时
                <br />
                <small>预测层位</small>
              </span>
              <div>教学小网络：12 个隐藏单元 · 实际训练 150 轮</div>
            </div>
          ) : (
            <div className="human-diagram">
              <MousePointer2 size={30} />
              <span>人选择目标</span>
              <ArrowRight />
              <AudioLines size={34} />
              <span>算法延伸</span>
              <ArrowRight />
              <Check size={30} />
              <span>人复核修正</span>
            </div>
          )}
        </div>
        <div className="method-copy">
          <h3>
            {
              [
                "寻找“长得像”的相邻波形",
                "从已有解释中，学习规律",
                "让人和算法各取所长",
              ][method]
            }
          </h3>
          <p>
            {
              [
                "比较种子附近与邻道的波形，兼顾振幅和连续性。足够相似就前进一步；遇到噪声、断层或模糊区域就停止，交给解释者判断。",
                "训练时，模型同时看到地震数据和人工标签；预测时，输入新的地震图像，输出层位位置或概率。好的结果依赖可靠标签和独立测区验证。",
                "人负责地质判断、选择目标和纠正错误；算法完成重复追踪。自动化节约的是重复劳动，解释责任仍然在人。",
              ][method]
            }
          </p>
          <div className="method-flow">
            {
              [
                "种子 → 波形比较 → 邻道扩展",
                "标签 + 振幅 → 训练 → 层位预测",
                "指定目标 → 自动延伸 → 检查修正",
              ][method]
            }
          </div>
        </div>
      </div>
      <div className="method-preview">
        <Seismic
          section={section}
          points={
            method === 1
              ? model.current.points
              : method === 0
                ? auto
                : refpoints
          }
        />
      </div>
      <p className="method-caveat">
        {method === 1
          ? `上图蓝线由本页小型神经网络实际生成：输入位置和局部平均振幅，输出走时。同剖面留出道误差 ${model.current.mae.toFixed(1)} ms，仅表示插值表现。真实深度学习常用 U-Net 处理图像/数据块并输出概率；本实验不是科研级深度模型，也不证明跨工区泛化。`
          : method === 0
            ? "上图蓝线由本页波形相似性算法实际计算；搜索只在局部进行，可能偏离目标。"
            : "上图展示已有参考解释，表示人工复核的目标形态，并非经过本页人工修正的自动结果。你可以在上一节亲自更换种子，观察结果如何改变。"}
      </p>
    </div>
  );
}
export default function Story() {
  const active = useJourney();
  const [data, setData] = useState<Section[]>([]),
    [error, setError] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    fetch("/learn/f3.json", { signal: abort.signal })
      .then((r) => {
        if (!r.ok) throw Error();
        return r.json();
      })
      .then((d) => setData(d.sections))
      .catch((e) => {
        if (e.name !== "AbortError") setError(true);
      });
    return () => abort.abort();
  }, []);
  const s = data[1];
  const reference =
    s?.reference.flatMap((t, x) =>
      t === null ? [] : [{ x, y: (t - 200) / 4 }],
    ) ?? [];
  const placeholder = (
    <div className="story-loading">
      {error ? (
        <>
          真实 F3 数据暂未加载成功。
          <button onClick={() => location.reload()}>重新加载</button>
        </>
      ) : (
        "正在载入北海地下的真实回声…"
      )}
    </div>
  );
  return (
    <div className="seismic-story">
      <header className="story-header">
        <a href="#top" className="story-logo">
          <span>
            <Layers size={21} />
          </span>
          SeisCanvas <i>地球科学小课堂</i>
        </a>
        <nav aria-label="文章章节">
          {titles.map((t, i) => (
            <a
              key={t}
              href={`#chapter-${i + 1}`}
              className={active === i ? "current" : ""}
            >
              {t}
            </a>
          ))}
        </nav>
        <a className="story-studio" href="/studio">
          探索工作台 <ArrowRight size={14} />
        </a>
      </header>
      <main>
        <section className="story-hero" id="top">
          <div className="hero-kicker">
            <span />
            一堂关于地下世界的可视化入门课
          </div>
          <h1>
            读懂地下的回声<span>从地震波，到一条地震层位。</span>
          </h1>
          <p>
            我们看不见脚下的岩层，却可以用回声描绘它。
            <br />
            跟随一束地震波，亲手连起地下世界的线索。
          </p>
          <div className="hero-meta">
            <span>零基础友好</span>
            <i />
            <span>约 12 分钟</span>
            <i />
            <span>真实 F3 数据</span>
          </div>
          <a className="begin-story" href="#chapter-1">
            向下探索 <ArrowDown size={15} />
          </a>
          <div className="hero-visual">
            {s ? <Seismic section={s} points={reference} hero /> : placeholder}
            <div className="hero-line-label">
              <span />
              这条蓝线，藏着一个地质故事
            </div>
            <div className="hero-side-label">THE EARTH, BETWEEN THE LINES</div>
          </div>
          <div className="hero-caption">
            <span>荷兰北海 F3 区块 · 真实地震数据与已有层位解释</span>
            <span>
              向下滚动，让故事展开 <ArrowDown size={12} />
            </span>
          </div>
        </section>
        <section className="story-chapter" id="chapter-1">
          <div className="chapter-heading">
            <span className="story-number">01 — SEISMIC EXPLORATION</span>
            <h2>
              看不见的地下，
              <br />
              可以用回声来认识。
            </h2>
            <p>
              就像对着山谷喊一声，岩层也会返回回声。地面上的震源发出振动，波穿过地下，在岩层性质变化的地方发生反射，再被地表的检波器记录。
            </p>
          </div>
          <EchoScene />
          <div className="story-aside">
            <span>一个关键直觉</span>
            <p>
              回声<strong>什么时候回来</strong>，帮助我们判断界面的位置；回声
              <strong>有多强</strong>，与界面两侧岩石性质的差异有关。
            </p>
          </div>
        </section>
        <section className="story-chapter" id="chapter-2">
          <div className="chapter-heading">
            <span className="story-number">02 — FROM SIGNAL TO IMAGE</span>
            <h2>
              把回声排在一起，
              <br />
              地下就有了“图像”。
            </h2>
            <p>
              接收到的信号经过处理，成为一条振幅随时间变化的曲线，叫作
              <strong>地震道（Seismic trace）</strong>
              。把许多道并排摆放，就得到二维剖面；把相邻剖面组合起来，就形成三维数据体。
            </p>
          </div>
          {s ? <Formation section={s} /> : placeholder}
          <div className="story-aside">
            <span>先记住坐标</span>
            <p>
              横向表示位置，纵向表示<strong>双程走时</strong>
              ——波从地面到界面再返回的时间。时间不是深度；换算深度还需要地下的速度模型。
            </p>
          </div>
        </section>
        <section className="story-chapter" id="chapter-3">
          <div className="chapter-heading">
            <span className="story-number">03 — READING THE REFLECTIONS</span>
            <h2>
              那些起伏的条纹，
              <br />
              是相邻位置相似的回声。
            </h2>
            <p>
              一条波形有波峰、波谷和零交叉。邻近位置对同一界面的响应往往很相似，把相同相位连起来，便形成
              <strong>反射同相轴（Reflection event）</strong>。
            </p>
          </div>
          <PhaseFigure />
          <div className="reading-pair">
            <div>
              <b>连续的条纹</b>
              <p>
                常提示反射界面的连续延伸。条纹的起伏，可能反映岩层的弯曲与倾斜。
              </p>
            </div>
            <div>
              <b>中断或错开的条纹</b>
              <p>
                可能与断层、沉积变化或噪声有关。仅凭一张剖面，不能急着下地质结论。
              </p>
            </div>
            <div>
              <b>深浅不同的颜色</b>
              <p>本页黑白对应振幅的正负与大小，并不直接代表某种岩石或油气。</p>
            </div>
          </div>
        </section>
        <section className="story-chapter" id="chapter-4">
          <div className="chapter-heading">
            <span className="story-number">04 — WHAT IS A HORIZON?</span>
            <h2>
              在万千条纹中，
              <br />
              认出同一个地质界面。
            </h2>
            <p>
              <strong>地震层位（Seismic horizon）</strong>
              是我们对某个反射界面的解释。在二维剖面上，它是一条线；在三维空间里，它是一张起伏的面。追踪它，才能讨论地层的形态、分布与构造变化。
            </p>
          </div>
          <div className="horizon-figure">
            <div className="figure-label">
              <span>一个界面，一条解释线</span>
              <span className="real-label">
                <span />
                真实 F3 数据 · IL 350
              </span>
            </div>
            {s ? (
              <Seismic section={s} points={reference} reveal />
            ) : (
              placeholder
            )}
            <div className="horizon-legend">
              <span>
                <i />
                已有层位解释
              </span>
              <p>
                随滚动展开的蓝线，不是凭空画出的边界，而是对反射事件的解释。
              </p>
            </div>
          </div>
          <div className="story-aside">
            <span>解释 ≠ 描边</span>
            <p>
              我们追踪的是<strong>同一个目标、同一种相位</strong>
              ，而不是任意一条最深的颜色。参考解释也有不确定性，需要结合其他测线、地质背景和井资料验证。
            </p>
          </div>
        </section>
        <section className="story-chapter" id="chapter-5">
          <div className="chapter-heading">
            <span className="story-number">05 — YOUR FIRST INTERPRETATION</span>
            <h2>
              从一个点开始，
              <br />
              让你的第一条层位延伸。
            </h2>
            <p>
              先在清晰、连续的反射上选一个<strong>种子点</strong>
              ，沿着同一相位向两侧追踪。下面让算法替你完成重复的连接；你来判断目标、检查偏离，并在需要时重新选择。
            </p>
          </div>
          {s ? <Picking section={s} /> : placeholder}
          <div className="story-mini-heading">
            <span>从一条线，到一张面</span>
            <h3>换一条测线，再认出同一个界面。</h3>
            <p>
              在多条剖面上重复解释，检查交叉测线的走时是否一致，再把可靠的解释点连接成层位表面。
            </p>
          </div>
          {data.length > 0 ? <SurfaceFigure sections={data} /> : placeholder}
        </section>
        <section className="story-chapter" id="chapter-6">
          <div className="chapter-heading">
            <span className="story-number">06 — THE NEXT STEP: AUTOMATION</span>
            <h2>
              让算法多走几步，
              <br />
              让人专注于地质判断。
            </h2>
            <p>
              当数据从一张剖面变成整个数据体，逐道点击就变得繁重。传统方法寻找相似波形，深度学习从标签中学习规律；最可靠的工作方式，是把自动结果交回人手中检查。
            </p>
          </div>
          {s ? <Methods section={s} /> : placeholder}
        </section>
        <section className="story-ending">
          <div className="ending-icon">
            <Layers size={27} />
          </div>
          <span className="story-number">你已经走过了完整的第一步</span>
          <h2>一条层位，连接回声与地质。</h2>
          <p>
            从发出地震波，到记录信号、读懂剖面、选定目标，
            <br />
            再到追踪和复核——解释的核心，始终是认出同一个界面。
          </p>
          <div className="ending-flow">
            {["地震波", "地震道", "地震剖面", "种子点", "层位表面"].map(
              (t, i) => (
                <span key={t}>
                  {t}
                  {i < 4 && <ArrowRight size={15} />}
                </span>
              ),
            )}
          </div>
          <a href="#chapter-5" className="ending-link">
            再亲手解释一次 <ArrowRight size={15} />
          </a>
        </section>
      </main>
      <footer className="story-footer">
        <div>
          <a href="#top" className="story-logo">
            <Layers size={19} /> SeisCanvas
          </a>
          <span>让地下科学，变得看得见。</span>
        </div>
        <p>
          真实数据：项目已有 F3 SEG-Y 子集，Inline 300 / 350 / 400，TWT 200–1220
          ms，4 ms 采样，每 4 道展示 1 道。振幅按各剖面 98%
          分位归一化并裁剪。参考层位来自本地 horizon_1
          文件，原解释者与质量尚未核验，不作为标准答案。地震波、波形概念与数据体结构图为明确标注的原理示意。
        </p>
        <div className="footer-links">
          <a
            href="https://www.dgbes.com/resources/data-sets/"
            target="_blank"
            rel="noreferrer"
          >
            dGB 开放地震数据 ↗
          </a>
          <a
            href="https://github.com/microsoft/seismic-deeplearning"
            target="_blank"
            rel="noreferrer"
          >
            F3 深度学习资料 ↗
          </a>
          <a href="/studio">SeisCanvas 工作台 ↗</a>
          <a href="#top">返回顶部 ↑</a>
        </div>
      </footer>
    </div>
  );
}
