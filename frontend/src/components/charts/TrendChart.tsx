"use client";
import { useMemo, useId, useState } from "react";
import {
  ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, ReferenceDot, ReferenceArea,
} from "recharts";
import { BarChart2 } from "lucide-react";
import { useChartPalette, seriesColor } from "./palette";

export interface TrendSeries {
  key: string;
  name: string;
  unit?: string;
}

export type TrendPoint = { ts: string } & Record<string, number | string>;

export interface TrendThreshold {
  value: number;
  label: string;
  /** "limit" is drawn in red (e.g. rated power); "reference" in neutral grey (e.g. average). */
  kind?: "limit" | "reference";
}

type Range = string;

const SEC = 1000, MIN = 60 * SEC, HOUR = 60 * MIN, DAY = 24 * HOUR;
const TICK_STEPS = [
  1 * SEC, 5 * SEC, 10 * SEC, 15 * SEC, 30 * SEC,
  1 * MIN, 2 * MIN, 5 * MIN, 10 * MIN, 15 * MIN, 30 * MIN,
  1 * HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, 1 * DAY, 2 * DAY,
];

/** Round, local-time-aligned ticks (about 6) across [from, to]. */
function timeTicks(from: number, to: number): number[] {
  const span = to - from;
  if (!(span > 0)) return [from];
  const step = TICK_STEPS.find((s) => span / s <= 6) ?? 7 * DAY;
  const tz = new Date(from).getTimezoneOffset() * MIN; // local = utc - tz
  const ticks: number[] = [];
  for (let local = Math.ceil((from - tz) / step) * step; local + tz <= to; local += step) ticks.push(local + tz);
  return ticks;
}

function formatTick(t: number, span: number, range?: Range) {
  const d = new Date(t);
  if (range === "7d" || span > 2 * DAY) return d.toLocaleDateString([], { month: "short", day: "numeric" });
  return d.toLocaleTimeString([], {
    hour: "2-digit", minute: "2-digit", ...(span <= 10 * MIN ? { second: "2-digit" } : {}), hour12: false,
  });
}

function fmt(v: number) {
  const a = Math.abs(v);
  return v.toLocaleString(undefined, { maximumFractionDigits: a >= 100 ? 0 : a >= 10 ? 1 : 2 });
}

/* Pulsing marker drawn at the peak of the primary series. */
function PeakMarker(props: { cx?: number; cy?: number; color: string; surface: string }) {
  const { cx, cy, color, surface } = props;
  if (cx == null || cy == null) return <g />;
  return (
    <g>
      <circle cx={cx} cy={cy} r={5} fill={color} opacity={0.35}>
        <animate attributeName="r" from="5" to="14" dur="1.8s" repeatCount="indefinite" />
        <animate attributeName="opacity" from="0.35" to="0" dur="1.8s" repeatCount="indefinite" />
      </circle>
      <circle cx={cx} cy={cy} r={4.5} fill={color} stroke={surface} strokeWidth={2} />
      <text x={cx} y={cy - 12} textAnchor="middle" fontSize={14} fontWeight={700} fill={color}>
        peak
      </text>
    </g>
  );
}

export default function TrendChart({
  data,
  series,
  range = "1h",
  height = 300,
  threshold,
  showPeak = true,
  animate = true,
  loading = false,
  emptyText = "No data in the selected range",
  domain,
  onZoom,
}: {
  data: TrendPoint[];
  series: TrendSeries[];
  range?: Range;
  height?: number;
  threshold?: TrendThreshold | null;
  showPeak?: boolean;
  animate?: boolean;
  loading?: boolean;
  emptyText?: string;
  /** Fixed x-axis window [from, to] in ms; defaults to the data's extent. */
  domain?: [number, number];
  /** When set, dragging across the chart selects a time span to zoom into. */
  onZoom?: (from: number, to: number) => void;
}) {
  const p = useChartPalette();
  const gid = useId().replace(/:/g, "");
  const primary = series[0];
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragTo, setDragTo] = useState<number | null>(null);

  // Numeric time axis: rows carry `t` (ms) next to `ts`.
  const rows = useMemo(
    () => data
      .map((d) => ({ ...d, t: new Date(d.ts).getTime() }) as TrendPoint & { t: number })
      .filter((d) => Number.isFinite(d.t)),
    [data]
  );
  const xDomain: [number, number] = domain ?? [rows[0]?.t ?? 0, rows[rows.length - 1]?.t ?? 0];
  const span = xDomain[1] - xDomain[0];
  const ticks = useMemo(() => timeTicks(xDomain[0], xDomain[1]), [xDomain[0], xDomain[1]]); // eslint-disable-line react-hooks/exhaustive-deps

  const finishDrag = () => {
    if (onZoom && dragFrom !== null && dragTo !== null && Math.abs(dragTo - dragFrom) >= 5 * SEC) {
      onZoom(Math.min(dragFrom, dragTo), Math.max(dragFrom, dragTo));
    }
    setDragFrom(null);
    setDragTo(null);
  };

  // Series whose unit differs from the primary go on a second (right) axis,
  // so e.g. kW and A don't flatten each other.
  const onRight = (s: TrendSeries, i: number) => i > 0 && !!primary && (s.unit || "") !== (primary.unit || "");
  const hasRight = series.some(onRight);

  const peak = useMemo(() => {
    if (!primary || !showPeak) return null;
    let best: { t: number; v: number } | null = null;
    for (const d of rows) {
      const v = d[primary.key];
      if (typeof v === "number" && (!best || v > best.v)) best = { t: d.t, v };
    }
    return best;
  }, [rows, primary, showPeak]);

  // Left-axis domain that always keeps the threshold line in view.
  const leftDomain = useMemo<[number, number] | undefined>(() => {
    if (!primary) return undefined;
    const leftKeys = series.filter((s, i) => !onRight(s, i)).map((s) => s.key);
    let lo = Infinity, hi = -Infinity;
    for (const d of data) for (const k of leftKeys) {
      const v = d[k];
      if (typeof v === "number") { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    }
    if (threshold) { lo = Math.min(lo, threshold.value); hi = Math.max(hi, threshold.value); }
    if (!Number.isFinite(lo)) return undefined;
    const pad = (hi - lo) * 0.12 || Math.abs(hi) * 0.1 || 1;
    return [Math.max(lo >= 0 ? 0 : -Infinity, lo - pad), hi + pad];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, series, threshold]);

  if (loading) {
    return <div className="skeleton w-full" style={{ height }} />;
  }

  if (!data.length || !primary) {
    return (
      <div className="w-full flex flex-col items-center justify-center text-muted-foreground" style={{ height }}>
        <BarChart2 className="w-10 h-10 mb-2 opacity-25" />
        <p className="text-sm font-medium">{emptyText}</p>
      </div>
    );
  }

  const thresholdColor = threshold?.kind === "reference" ? p.reference : p.threshold;

  const showDots = rows.length <= 40;
  type ChartMouse = { activeLabel?: string | number } | null;
  const labelOf = (e: ChartMouse) => (e && e.activeLabel != null ? Number(e.activeLabel) : null);

  return (
    <div className="w-full">
      <div style={{ height, cursor: onZoom ? "crosshair" : undefined }} className="select-none">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={rows}
            margin={{ top: 22, right: hasRight ? 4 : 64, left: -8, bottom: 0 }}
            onMouseDown={onZoom ? (e: ChartMouse) => { const t = labelOf(e); if (t !== null) { setDragFrom(t); setDragTo(null); } } : undefined}
            onMouseMove={onZoom ? (e: ChartMouse) => { if (dragFrom !== null) { const t = labelOf(e); if (t !== null) setDragTo(t); } } : undefined}
            onMouseUp={onZoom ? finishDrag : undefined}
            onMouseLeave={onZoom ? () => { setDragFrom(null); setDragTo(null); } : undefined}
          >
            <defs>
              {series.map((s, i) => (
                <linearGradient key={s.key} id={`${gid}-fill-${i}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={seriesColor(p, i)} stopOpacity={i === 0 ? 0.22 : 0.08} />
                  <stop offset="100%" stopColor={seriesColor(p, i)} stopOpacity={0} />
                </linearGradient>
              ))}
            </defs>

            <CartesianGrid stroke={p.grid} strokeDasharray="0" vertical={false} />
            <XAxis
              dataKey="t"
              type="number"
              scale="time"
              domain={xDomain}
              ticks={ticks}
              allowDataOverflow
              tickFormatter={(v: number) => formatTick(v, span, range)}
              tick={{ fontSize: 14, fill: p.axis, fontWeight: 700 }}
              axisLine={{ stroke: p.grid }}
              tickLine={false}
              minTickGap={32}
              dy={6}
            />
            <YAxis
              yAxisId="left"
              domain={leftDomain ?? ["auto", "auto"]}
              tick={{ fontSize: 14, fill: p.axis, fontWeight: 700 }}
              tickFormatter={(v: number) => fmt(v)}
              axisLine={false}
              tickLine={false}
              width={52}
              allowDataOverflow
            />
            {hasRight && (
              <YAxis
                yAxisId="right"
                orientation="right"
                tick={{ fontSize: 14, fill: p.axis, fontWeight: 700 }}
                tickFormatter={(v: number) => fmt(v)}
                axisLine={false}
                tickLine={false}
                width={48}
              />
            )}

            <Tooltip
              cursor={{ stroke: p.axis, strokeDasharray: "3 3", strokeWidth: 1 }}
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                return (
                  <div className="glass-card px-3.5 py-2.5 text-xs shadow-glass-lg min-w-[160px]">
                    <p className="font-semibold text-muted-foreground mb-1.5">
                      {new Date(Number(label)).toLocaleString([], {
                        month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
                        ...(span <= 15 * MIN ? { second: "2-digit" } : {}), hour12: false,
                      })}
                    </p>
                    {payload.map((it) => {
                      const s = series.find((x) => x.key === it.dataKey);
                      return (
                        <div key={String(it.dataKey)} className="flex items-center justify-between gap-4 py-0.5">
                          <span className="flex items-center gap-2 text-foreground font-medium">
                            <span className="w-2.5 h-0.5 rounded-full" style={{ background: it.color }} />
                            {s?.name ?? it.dataKey}
                          </span>
                          <span className="font-bold text-foreground tabular">
                            {typeof it.value === "number" ? fmt(it.value) : it.value}
                            {s?.unit ? <span className="text-muted-foreground font-medium"> {s.unit}</span> : null}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                );
              }}
            />

            {threshold && (
              <ReferenceLine
                yAxisId="left"
                y={threshold.value}
                stroke={thresholdColor}
                strokeDasharray="4 4"
                strokeWidth={1.5}
                ifOverflow="extendDomain"
                label={{ value: threshold.label, position: "right", fill: thresholdColor, fontSize: 14, fontWeight: 700 }}
              />
            )}

            {series.map((s, i) => {
              const color = seriesColor(p, i);
              const common = {
                yAxisId: onRight(s, i) ? "right" : "left",
                type: "monotone" as const,
                dataKey: s.key,
                name: s.name,
                stroke: color,
                dot: showDots ? { r: 2.5, fill: color, strokeWidth: 0 } : false,
                connectNulls: true,
                isAnimationActive: animate,
                animationDuration: 1100,
                animationEasing: "ease-out" as const,
                activeDot: { r: 4.5, fill: color, stroke: p.surface, strokeWidth: 2 },
              };
              return i === 0 ? (
                <Area key={s.key} {...common} strokeWidth={2.25} fill={`url(#${gid}-fill-${i})`} />
              ) : (
                <Line key={s.key} {...common} strokeWidth={2} />
              );
            })}

            {peak && (
              <ReferenceDot
                yAxisId="left"
                x={peak.t}
                y={peak.v}
                ifOverflow="extendDomain"
                shape={(props: { cx?: number; cy?: number }) => (
                  <PeakMarker {...props} color={p.threshold} surface={p.surface} />
                )}
              />
            )}

            {dragFrom !== null && dragTo !== null && (
              <ReferenceArea
                yAxisId="left"
                x1={Math.min(dragFrom, dragTo)}
                x2={Math.max(dragFrom, dragTo)}
                fill={p.axis}
                fillOpacity={0.12}
                stroke={p.axis}
                strokeOpacity={0.4}
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-1 mt-2 text-xs text-muted-foreground">
        {series.map((s, i) => (
          <span key={s.key} className="inline-flex items-center gap-2 font-medium">
            <span className="w-4 h-[3px] rounded-full" style={{ background: seriesColor(p, i) }} />
            {s.name}{s.unit ? ` (${s.unit})` : ""}
          </span>
        ))}
        {threshold && (
          <span className="inline-flex items-center gap-2 font-medium">
            <span className="w-4 border-t-2 border-dashed" style={{ borderColor: thresholdColor }} />
            {threshold.label}
          </span>
        )}
      </div>
    </div>
  );
}
