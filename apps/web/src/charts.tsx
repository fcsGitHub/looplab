import { useEffect, useMemo, useRef, useState } from "react";

/* 手绘 SVG 训练控制台式图表（零依赖）。
   设计参考 wandb/TensorBoard scalars：稀疏网格、内敛坐标轴、
   主曲线带面积渐变、最新值高亮、虚线基线。 */

export interface Pt { x: number; y: number }
export interface Series {
  name: string;
  color: string;
  points: Pt[];
  dashed?: boolean;
  area?: boolean;
  line?: boolean; // false = 只画散点（如按裁决着色的评测点）
}
export interface VMarker { x: number; label: string; color?: string }

function useContainerWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((es) => setW(es[0].contentRect.width));
    ro.observe(ref.current);
    setW(ref.current.clientWidth);
    return () => ro.disconnect();
  }, []);
  return { ref, w };
}

export function LineChart(props: {
  series: Series[];
  height?: number;
  yFormat?: (v: number) => string;
  xFormat?: (v: number) => string;
  markers?: VMarker[];
  baseline?: { y: number; label: string } | null;
  empty?: string;
  ariaLabel?: string;
}) {
  const { series: rawSeries, height = 168, markers = [], baseline = null } = props;
  const series = useMemo(
    () => rawSeries.map((s) => ({ ...s, points: s.points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y)) })),
    [rawSeries],
  );
  const yFormat = props.yFormat ?? ((v) => (Math.abs(v) < 10 ? v.toFixed(2) : v.toFixed(0)));
  const xFormat = props.xFormat ?? ((v) => String(v));
  const { ref, w } = useContainerWidth<HTMLDivElement>();

  const model = useMemo(() => {
    const all = series.flatMap((s) => s.points).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
    if (all.length === 0) return null;
    let xMin = Math.min(...all.map((p) => p.x));
    let xMax = Math.max(...all.map((p) => p.x));
    let yMin = Math.min(...all.map((p) => p.y));
    let yMax = Math.max(...all.map((p) => p.y));
    if (baseline) { yMin = Math.min(yMin, baseline.y); yMax = Math.max(yMax, baseline.y); }
    if (xMax === xMin) { xMax = xMin + 1; xMin -= 1; }
    if (yMax === yMin) { yMax = yMin + 1; yMin -= 1; }
    const yPad = (yMax - yMin) * 0.12;
    yMin -= yPad; yMax += yPad;
    return { xMin, xMax, yMin, yMax };
  }, [series, baseline]);

  const padL = 44; const padR = 54; const padT = 10; const padB = 22;
  const cw = Math.max(w, 120);
  const ch = height;
  const iw = cw - padL - padR;
  const ih = ch - padT - padB;

  const sx = (x: number) => padL + ((x - model!.xMin) / (model!.xMax - model!.xMin)) * iw;
  const sy = (y: number) => padT + (1 - (y - model!.yMin) / (model!.yMax - model!.yMin)) * ih;

  const yTicks = useMemo(() => {
    if (!model) return [];
    const n = 4;
    return Array.from({ length: n + 1 }, (_, i) => model.yMin + ((model.yMax - model.yMin) * i) / n);
  }, [model]);

  const xTicks = useMemo(() => {
    if (!model) return [];
    const n = Math.min(5, Math.max(2, Math.floor(iw / 110)));
    return Array.from({ length: n + 1 }, (_, i) => model.xMin + ((model.xMax - model.xMin) * i) / n);
  }, [model, iw]);

  const totalPts = series.reduce((a, s) => a + s.points.length, 0);

  return (
    <div ref={ref} className="chart" role="img" aria-label={props.ariaLabel ?? "曲线图"}>
      {(!model || totalPts === 0) && (
        <div className="chart-empty dim" style={{ height }}>{props.empty ?? "暂无数据"}</div>
      )}
      {model && totalPts > 0 && w > 0 && (
        <svg width={cw} height={ch} className="chart-svg">
          <defs>
            {series.filter((s) => s.area).map((s) => (
              <linearGradient key={s.name} id={`g-${s.name}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={s.color} stopOpacity=".22" />
                <stop offset="100%" stopColor={s.color} stopOpacity="0" />
              </linearGradient>
            ))}
          </defs>

          {yTicks.map((v) => (
            <g key={v}>
              <line x1={padL} x2={cw - padR} y1={sy(v)} y2={sy(v)} className="chart-grid" />
              <text x={padL - 6} y={sy(v) + 3} className="chart-tick" textAnchor="end">{yFormat(v)}</text>
            </g>
          ))}
          {xTicks.map((v) => (
            <text key={v} x={sx(v)} y={ch - 6} className="chart-tick" textAnchor="middle">{xFormat(v)}</text>
          ))}

          {markers.map((m, i) => (
            <g key={i}>
              <line x1={sx(m.x)} x2={sx(m.x)} y1={padT} y2={ch - padB} className="chart-marker" style={{ stroke: m.color }} />
              <text x={sx(m.x) + 4} y={padT + 9} className="chart-marker-label" style={{ fill: m.color }}>{m.label}</text>
            </g>
          ))}

          {baseline && (
            <g>
              <line x1={padL} x2={cw - padR} y1={sy(baseline.y)} y2={sy(baseline.y)} className="chart-baseline" />
              <text x={cw - padR + 4} y={sy(baseline.y) + 3} className="chart-baseline-label">{baseline.label}</text>
            </g>
          )}

          {series.map((s) => {
            const pts = s.points.map((p) => `${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(" ");
            const last = s.points[s.points.length - 1];
            return (
              <g key={s.name}>
                {s.area && s.points.length > 1 && (
                  <polygon
                    points={`${sx(s.points[0].x).toFixed(1)},${(ch - padB).toFixed(1)} ${pts} ${sx(last.x).toFixed(1)},${(ch - padB).toFixed(1)}`}
                    fill={`url(#g-${s.name})`}
                  />
                )}
                {s.points.length > 1 && s.line !== false && (
                  <polyline
                    points={pts}
                    fill="none"
                    stroke={s.color}
                    strokeWidth="1.6"
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    strokeDasharray={s.dashed ? "4 3" : undefined}
                  />
                )}
                {s.points.map((p, i) => (
                  <circle key={i} cx={sx(p.x)} cy={sy(p.y)} r={s.points.length === 1 ? 3 : 2.2} fill={s.color} />
                ))}
                {last && (
                  <text x={sx(last.x) + 6} y={sy(last.y) + 3.5} className="chart-last" style={{ fill: s.color }}>
                    {yFormat(last.y)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}

/* 小倍数指标卡：当前值 + 增量 + 迷你走势 */
export function StatCard(props: { label: string; value: string; delta?: string; deltaGood?: boolean; hint?: string }) {
  return (
    <div className="stat-card">
      <span className="eyebrow">{props.label}</span>
      <div className="stat-value num">{props.value}</div>
      {props.delta && (
        <span className={`stat-delta num ${props.deltaGood === false ? "bad" : ""}`}>{props.delta}</span>
      )}
      {props.hint && <span className="stat-hint dim">{props.hint}</span>}
    </div>
  );
}
