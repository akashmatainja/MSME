"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import DateTimePicker from "@/components/ui/DateTimePicker";
import { ChevronLeft, ChevronRight, Cpu, DatabaseBackup, Lock, Radio, ZoomIn, ZoomOut } from "lucide-react";
import { api } from "@/lib/api";
import { getDateRangeFrom } from "@/lib/utils";
import { moduleDef, type ModuleSlug } from "@/lib/modules";
import { useModuleAccess } from "@/components/providers/ModuleAccessProvider";
import { useRealtimeStore } from "@/store/useRealtimeStore";
import CustomSelect from "@/components/ui/CustomSelect";
import KpiTile from "@/components/ui/KpiTile";
import RangePills from "@/components/ui/RangePills";
import LivePill from "@/components/ui/LivePill";
import TrendChart from "@/components/charts/TrendChart";
import RankedBars from "@/components/charts/RankedBars";
import RangeOverview from "@/components/charts/RangeOverview";
import ThresholdStatus from "@/components/charts/ThresholdStatus";
import AlertsList from "@/components/alerts/AlertsList";
import { useHealthBackfill, useHealthHistory, useOverview, usePredictiveHealth } from "@/hooks/useMonitoring";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";
import HealthHistoryChart from "@/components/charts/HealthHistoryChart";
import HealthBreakdown, { formatHoursToLimit, healthColor } from "@/components/charts/HealthBreakdown";
import { useChartPalette, seriesColor } from "@/components/charts/palette";
import {
  buildModuleChartData, chartThreshold, hasLimits, metricStatus, moduleSeries, pickPrimaryMetric, seriesDelta,
} from "@/components/charts/moduleData";
import type { Alert, DashboardSummary, MachineStat } from "@/types";

const NAV_BTN =
  "inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-bold border border-border bg-card text-foreground " +
  "hover:border-navy-500 disabled:opacity-40 disabled:pointer-events-none transition-colors";

const SEC = 1000, MIN = 60 * SEC, HOUR = 60 * MIN, DAY = 24 * HOUR;

/** Chart window sizes, smallest first (zoom buttons step through these). */
const SCALES = [
  { label: "1m", ms: MIN, text: "last minute" },
  { label: "10m", ms: 10 * MIN, text: "last 10 minutes" },
  { label: "15m", ms: 15 * MIN, text: "last 15 minutes" },
  { label: "30m", ms: 30 * MIN, text: "last 30 minutes" },
] as const;
const MIN_SPAN = 10 * SEC;
const MAX_SPAN = 30 * MIN;

/** What the trend chart shows: a window of `span` ms ending at `end` (null = now, follows live data). */
type View = { span: number; end: number | null };

function spanText(ms: number) {
  if (ms >= DAY) return `${+(ms / DAY).toFixed(1)} d`;
  if (ms >= HOUR) return `${+(ms / HOUR).toFixed(1)} h`;
  if (ms >= MIN) return `${+(ms / MIN).toFixed(1)} min`;
  return `${Math.round(ms / SEC)} s`;
}

function windowText(from: number, to: number) {
  const sameDay = new Date(from).toDateString() === new Date(to).toDateString();
  const withSec = to - from <= 15 * MIN;
  const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", ...(withSec ? { second: "2-digit" } : {}), hour12: false });
  const date = (t: number) => new Date(t).toLocaleDateString([], { month: "short", day: "numeric" });
  return sameDay ? `${date(from)}, ${time(from)} – ${time(to)}` : `${date(from)} ${time(from)} – ${date(to)} ${time(to)}`;
}

/** Value for <input type="datetime-local"> in local time. */
function toLocalInput(t: number) {
  const d = new Date(t - new Date(t).getTimezoneOffset() * MIN);
  return d.toISOString().slice(0, 16);
}

/**
 * One monitoring module across the user's machines. The machine is chosen with
 * the picker and kept in the URL (`?machine=<code>`) so views can be linked.
 */
export default function ModulePage({ slug }: { slug: ModuleSlug }) {
  const def = moduleDef(slug);
  const { access, loading: accessLoading } = useModuleAccess();
  const acc = access[slug];
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const palette = useChartPalette();
  const { latestValues, timeSeries, isLive } = useRealtimeStore();

  const [view, setView] = useState<View>({ span: 15 * MIN, end: null });
  const following = view.end === null;
  const [now, setNow] = useState(() => Date.now());
  const [stats, setStats] = useState<MachineStat[]>([]);
  const [statsLoading, setStatsLoading] = useState(false);
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [selected, setSelected] = useState<string[] | null>(null);
  const [historyDays, setHistoryDays] = useState<"7" | "30" | "90">("7");

  const machines = useMemo(() => acc?.machines ?? [], [acc]);
  const mod = acc?.module;
  const param = searchParams.get("machine");
  const machine = machines.find((m) => m.code === param || m.id === param) ?? machines[0];

  const selectMachine = (id: string) => {
    const m = machines.find((x) => x.id === id);
    if (m) router.replace(`${pathname}?machine=${encodeURIComponent(m.code || m.id)}`, { scroll: false });
  };

  useEffect(() => {
    api.get<DashboardSummary>("/api/v1/dashboard/summary").then(setSummary).catch(() => {});
  }, []);

  // While following "now", slide the window every second.
  useEffect(() => {
    if (!following) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [following]);

  // Stored stats for the selected machine and window; refreshed every 30 s while following now.
  useEffect(() => {
    if (!machine) return;
    let cancelled = false;
    const load = async () => {
      setStatsLoading(true);
      try {
        const end = view.end ?? Date.now();
        let url = `/api/v1/machines/${machine.id}/stats?since=${new Date(end - view.span).toISOString()}&limit=5000`;
        if (view.end !== null) url += `&until=${new Date(view.end).toISOString()}`;
        const res = await api.get<MachineStat[]>(url);
        if (!cancelled) setStats(res || []);
      } catch {
        if (!cancelled) setStats([]);
      } finally {
        if (!cancelled) setStatsLoading(false);
      }
    };
    setStats([]);
    load();
    if (view.end !== null) return () => { cancelled = true; };
    const t = setInterval(load, 30000);
    return () => { cancelled = true; clearInterval(t); };
  }, [machine, view.span, view.end]);

  const useLive = isLive && following;
  const windowEnd = view.end ?? now;
  const windowStart = windowEnd - view.span;
  const scale = SCALES.find((s) => s.ms === view.span);

  // ── View controls ─────────────────────────────────────────────────────────
  /** Show [from, to]; snaps back to following "now" when the window reaches the present. */
  const showWindow = useCallback((span: number, end: number) => {
    span = Math.max(MIN_SPAN, Math.min(span, MAX_SPAN));
    setView({ span, end: end >= Date.now() - SEC ? null : end });
  }, []);
  const zoomTo = (span: number) => {
    if (following) return setView({ span, end: null });
    const center = windowEnd - view.span / 2;
    showWindow(span, Math.min(center + span / 2, Date.now()));
  };
  const smaller = [...SCALES].reverse().find((s) => s.ms < view.span);
  const larger = SCALES.find((s) => s.ms > view.span);
  const panBack = () => showWindow(view.span, windowEnd - view.span);
  const panForward = () => showWindow(view.span, windowEnd + view.span);
  const goTo = (value: string) => {
    const t = new Date(value).getTime();
    if (Number.isFinite(t)) showWindow(view.span, Math.min(t + view.span / 2, Date.now()));
  };
  const viewAlert = useCallback((a: Alert) => {
    const start = new Date(a.started_at).getTime();
    const stop = a.resolved_at ? new Date(a.resolved_at).getTime() : a.status === "open" ? Date.now() : new Date(a.last_seen_at).getTime();
    const dur = Math.max(stop - start, 0);
    const pad = Math.max(2 * MIN, dur * 0.25);
    const need = dur + 2 * pad;
    const span = SCALES.find((s) => s.ms >= need)?.ms ?? MAX_SPAN;
    // Long alerts don't fit in 30 min: show their start.
    showWindow(span, Math.min(start - pad + span, Date.now()));
    document.getElementById("module-trend")?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [showWindow]);
  const metrics = useMemo(() => mod?.metrics ?? [], [mod]);
  const sel = selected ?? metrics.map((m) => m.code);

  const chartData = useMemo(
    () => (mod && machine
      ? buildModuleChartData(mod, machine.id, { live: useLive, liveSeries: timeSeries[machine.id], stats, window: [windowStart, windowEnd] })
      : []),
    [mod, machine, useLive, timeSeries, stats, windowStart, windowEnd]
  );
  const series = useMemo(() => (mod ? moduleSeries(mod, sel, def.primaryPrefer) : []), [mod, sel, def]); // eslint-disable-line react-hooks/exhaustive-deps
  const leadMetric = metrics.find((m) => m.code === series[0]?.key);
  const threshold = useMemo(() => chartThreshold(machine, series[0], chartData, leadMetric), [machine, series, chartData, leadMetric]);

  // Compliance per metric since the start of the selected window (from the overview endpoint).
  // Recomputed only when the view changes, not on every live tick.
  const since = useMemo(() => new Date((view.end ?? Date.now()) - view.span), [view.span, view.end]);
  const { overview } = useOverview(since);
  const overviewModule = overview?.modules.find((m) => m.module_id === mod?.id);
  const anyLimits = metrics.some(hasLimits);

  // Predictive health score (24 h window, or 7 d when that range is selected)
  const isPredictive = slug === "predictive";
  const healthSince = useMemo(() => getDateRangeFrom("24h"), []);
  const { health, loading: healthLoading } = usePredictiveHealth(healthSince, isPredictive);
  const machineHealth = health?.machines.find((h) => h.machine_id === machine?.id);
  const { history, loading: historyLoading, unavailable: historyUnavailable, bucket: historyBucket, reload: reloadHistory } =
    useHealthHistory(machine?.id, Number(historyDays), isPredictive);
  const { permissions } = useAuth();
  const canBackfill = isPredictive && !!permissions["superadmin"];
  const { status: backfill, start: startBackfill } = useHealthBackfill(canBackfill, (st) => {
    if (st.error) toast.error(`Backfill stopped: ${st.error}`);
    else toast.success(`Backfill complete — ${st.rows_written.toLocaleString()} snapshots added`);
    reloadHistory();
  });
  const runBackfill = async () => {
    try {
      const st = await startBackfill(90);
      if (st.running) toast.success(`Backfilling ${st.hours_total.toLocaleString()} hours of health history…`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not start backfill");
    }
  };
  const historyPoints = history?.machines.find((h) => h.machine_id === machine?.id)?.points ?? [];
  const historyChange = historyPoints.length > 1 ? historyPoints[historyPoints.length - 1].score - historyPoints[0].score : null;
  const healthRanked = useMemo(
    () => (health?.machines ?? [])
      .filter((h) => h.score !== null)
      .map((h) => ({ id: h.machine_id, label: h.code || h.name, value: h.score as number, highlight: h.machine_id === machine?.id })),
    [health, machine]
  );
  const primary = pickPrimaryMetric(metrics, def.primaryPrefer);

  const latestFor = useCallback((mid: string, key: string): number | null => {
    const live = latestValues[mid]?.[key];
    if (live !== undefined && live !== null) return live;
    const s = summary?.latest_stats?.find((ls) => ls.machine_id === mid && ls.metric_key === key);
    return s ? s.metric_value : null;
  }, [latestValues, summary]);

  const ranked = useMemo(() => {
    if (!primary) return [];
    const key = primary.code.toLowerCase();
    return machines
      .map((m) => ({ id: m.id, label: m.code || m.name, value: latestFor(m.id, key), highlight: m.id === machine?.id }))
      .filter((r): r is { id: string; label: string; value: number; highlight: boolean } => r.value !== null);
  }, [machines, primary, latestFor, machine]);


  // ── States ────────────────────────────────────────────────────────────────
  if (accessLoading) {
    return (
      <div className="space-y-5">
        <div className="skeleton h-12 w-80" />
        <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3">
          {Array.from({ length: 6 }).map((_, i) => <div key={i} className="skeleton h-[84px]" />)}
        </div>
        <div className="skeleton h-[360px]" />
      </div>
    );
  }

  if (!acc || !mod || !machine) {
    return (
      <div className="glass-card p-12 text-center max-w-lg mx-auto mt-10">
        <Lock className="w-10 h-10 text-muted-foreground/40 mx-auto mb-3" />
        <h1 className="text-lg font-bold text-foreground">{def.title} isn&apos;t available</h1>
        <p className="text-sm text-muted-foreground mt-1">
          None of the machines you can monitor have this module assigned.
        </p>
        <Link href="/dashboard" className="btn-secondary mt-5">Back to dashboard</Link>
      </div>
    );
  }

  const isEnv = slug === "environmental";
  const Icon = def.icon;

  return (
    <div className="space-y-5 pb-8">
      {/* Header */}
      <div className="flex flex-col xl:flex-row xl:items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-extrabold tracking-tight text-navy-800 dark:text-white truncate flex items-center gap-2.5">
            <span className="w-8 h-8 rounded-lg bg-brand-500/10 text-brand-600 dark:text-brand-400 flex items-center justify-center shrink-0">
              <Icon className="w-[18px] h-[18px]" />
            </span>
            {machine.code || machine.name}
            <span className="text-muted-foreground/60">·</span>
            {def.title}
          </h1>
          <div className="flex flex-wrap items-center gap-2 mt-2">
            <LivePill live={useLive} offLabel={isLive ? "Historical view" : "Connecting…"} />
            <span className="text-xs text-muted-foreground">
              {machine.name}{machine.location ? ` · ${machine.location}` : ""}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {machines.length > 1 && (
            <CustomSelect
              value={machine.id}
              onChange={selectMachine}
              options={machines.map((m) => ({ value: m.id, label: `${m.name} (${m.code})` }))}
              className="min-w-[220px]"
              iconLeft={<Cpu className="w-4 h-4" />}
            />
          )}
          <RangePills
            value={scale?.label ?? "custom"}
            options={SCALES.map((s) => ({ label: s.label, value: s.label as string }))}
            onChange={(label) => zoomTo(SCALES.find((s) => s.label === label)!.ms)}
          />
        </div>
      </div>

      {/* Health strip (predictive only) */}
      {isPredictive && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <KpiTile
            label="Health score"
            value={healthLoading && !health ? null : machineHealth?.score ?? null}
            unit={machineHealth?.score !== null && machineHealth?.score !== undefined ? "/100" : undefined}
            color={healthColor(machineHealth?.score ?? null)}
            status={machineHealth?.status === "critical" ? "critical" : machineHealth?.status === "watch" ? "warning" : null}
          />
          <div className="glass-card card-accent px-4 py-3.5 pl-5" style={{ ["--accent-color" as string]: machineHealth?.hours_to_limit != null && machineHealth.hours_to_limit < 72 ? "#d64a3c" : "#2f6ca3" }}>
            <p className="eyebrow">Time to limit (trend)</p>
            <p className="mt-1.5 text-[28px] leading-none font-extrabold tracking-tight text-foreground tabular">
              {formatHoursToLimit(machineHealth?.hours_to_limit) ?? (machineHealth?.score != null ? "Stable" : "—")}
            </p>
            {machineHealth?.limit_metric && <p className="text-xs text-muted-foreground mt-1 truncate">{machineHealth.limit_metric}</p>}
          </div>
          <KpiTile
            index={2}
            label="Open alerts"
            value={machineHealth ? machineHealth.open_critical + machineHealth.open_warning : null}
            unit={machineHealth && machineHealth.open_critical > 0 ? `${machineHealth.open_critical} critical` : undefined}
            color="#17a397"
            status={machineHealth ? (machineHealth.open_critical > 0 ? "critical" : machineHealth.open_warning > 0 ? "warning" : null) : null}
          />
        </div>
      )}

      {/* KPI tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3">
        {metrics.map((metric, idx) => {
          const key = metric.code.toLowerCase();
          const vals = useLive
            ? (timeSeries[machine.id]?.[key] || []).map((p) => p.value)
            : stats.filter((s) => s.metric_key === key).sort((a, b) => a.ts.localeCompare(b.ts)).map((s) => s.metric_value);
          const value = latestFor(machine.id, key) ?? (vals.length ? vals[vals.length - 1] : null);
          return (
            <KpiTile
              key={`${machine.id}-${metric.id}`}
              index={idx}
              label={metric.name}
              value={value}
              unit={metric.unit}
              color={seriesColor(palette, idx)}
              delta={seriesDelta(vals, value)}
              status={metricStatus(metric, value)}
            />
          );
        })}
      </div>

      {/* Trend + side panel */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <section id="module-trend" className="glass-card p-5 lg:col-span-2 min-w-0">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-3">
            <h2 className="section-title">
              {series.slice(0, 3).map((s, i) => (i === 0 ? s.name : s.name.toLowerCase())).join(series.length > 2 ? ", " : " & ") || "Trend"}
              {series.length > 3 ? ` +${series.length - 3}` : ""}
              <span className="text-muted-foreground font-semibold">
                {" — "}{following ? (scale ? scale.text : `last ${spanText(view.span)}`) : windowText(windowStart, windowEnd)}
              </span>
            </h2>
            {metrics.length > 1 && (
              <div className="flex flex-wrap gap-1.5">
                {metrics.map((metric) => {
                  const on = sel.includes(metric.code);
                  const idx = series.findIndex((s) => s.key === metric.code);
                  return (
                    <button
                      key={metric.id}
                      onClick={() => setSelected(on ? sel.filter((c) => c !== metric.code) : [...sel, metric.code])}
                      className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-bold border transition-all ${
                        on ? "bg-card border-border text-foreground" : "border-transparent text-muted-foreground/70 hover:text-foreground"
                      }`}
                    >
                      <span className="w-2 h-2 rounded-full" style={{ background: on && idx >= 0 ? seriesColor(palette, idx) : "rgb(var(--muted-foreground) / 0.4)" }} />
                      {metric.name}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          {/* Time navigation: step back/forward, zoom, jump to a time, back to live */}
          <div className="flex flex-wrap items-center gap-1.5 mb-3">
            <button onClick={panBack} className={NAV_BTN} title={`Show the previous ${spanText(view.span)}`}>
              <ChevronLeft className="w-3.5 h-3.5" /> Earlier
            </button>
            <button onClick={panForward} disabled={following} className={NAV_BTN} title={`Show the next ${spanText(view.span)}`}>
              Later <ChevronRight className="w-3.5 h-3.5" />
            </button>
            <span className="w-px h-5 bg-border mx-1" />
            <button onClick={() => smaller && zoomTo(smaller.ms)} disabled={!smaller} className={NAV_BTN} title={smaller ? `Zoom in to ${smaller.label}` : "Fully zoomed in"}>
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
            <button onClick={() => larger && zoomTo(larger.ms)} disabled={!larger} className={NAV_BTN} title={larger ? `Zoom out to ${larger.label}` : "Fully zoomed out"}>
              <ZoomOut className="w-3.5 h-3.5" />
            </button>
            {!scale && <span className="text-xs font-bold text-muted-foreground tabular px-1">{spanText(view.span)}</span>}
            <span className="w-px h-5 bg-border mx-1" />
            <div title="Centre the chart on this date and time" className="w-[210px]">
              <DateTimePicker
                mode="datetime"
                size="sm"
                max={toLocalInput(now)}
                value={toLocalInput(windowEnd - view.span / 2)}
                onChange={goTo}
              />
            </div>
            {!following && (
              <button onClick={() => setView({ span: view.span, end: null })} className={`${NAV_BTN} !text-brand-600 dark:!text-brand-400 !border-brand-500/50`}>
                <Radio className="w-3.5 h-3.5" /> Back to live
              </button>
            )}
            <span className="ml-auto text-xs text-muted-foreground hidden md:inline">Drag across the chart to zoom in</span>
          </div>
          <TrendChart
            data={chartData}
            series={series}
            height={300}
            threshold={threshold}
            animate={!useLive}
            domain={[windowStart, windowEnd]}
            onZoom={(from, to) => showWindow(to - from, to)}
            loading={statsLoading && !useLive && !chartData.length}
            emptyText={useLive ? "Waiting for live OPC UA data…" : "No data in this time window"}
          />
        </section>

        <section className="glass-card p-5 min-w-0">
          {isEnv && anyLimits && overviewModule ? (
            <>
              <h2 className="section-title mb-1">Threshold status <span className="text-muted-foreground font-semibold">— {following && scale ? scale.label : `since ${since.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })}`}</span></h2>
              <p className="text-xs text-muted-foreground mb-5">Share of readings inside each parameter&apos;s limits</p>
              <ThresholdStatus metrics={overviewModule.metrics} perMachine={overviewModule.per_machine} machineId={machine.id} />
            </>
          ) : isEnv ? (
            <>
              <h2 className="section-title mb-1">Range overview <span className="text-muted-foreground font-semibold">— {following && scale ? scale.label : spanText(view.span)}</span></h2>
              <p className="text-xs text-muted-foreground mb-5">Min–max band, average tick and latest value</p>
              <RangeOverview data={chartData} series={series} />
            </>
          ) : isPredictive && healthRanked.length > 0 ? (
            <>
              <h2 className="section-title mb-1">Asset health comparison</h2>
              <p className="text-xs text-muted-foreground mb-5">Health score out of 100, lowest first</p>
              <RankedBars items={healthRanked} mode="health" ascending limit={8} />
            </>
          ) : (
            <>
              <h2 className="section-title mb-1">
                Latest {primary?.name.toLowerCase() ?? "reading"}
                {primary?.unit ? <span className="text-muted-foreground font-semibold"> ({primary.unit})</span> : null}
              </h2>
              <p className="text-xs text-muted-foreground mb-5">
                {slug === "predictive" ? "Asset comparison across machines" : "Across machines with this module"}
              </p>
              <RankedBars items={ranked} unit={primary?.unit} />
            </>
          )}
        </section>
      </div>

      {isPredictive && (
        <section className="glass-card p-5">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
            <div>
              <h2 className="section-title">
                Health score history <span className="text-muted-foreground font-semibold">— {machine.code || machine.name}</span>
              </h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                {historyBucket === "day" ? "Daily average (dashed: lowest hour of the day)" : "Hourly snapshots"}
                {historyChange !== null && (
                  <span className={`ml-2 font-bold ${historyChange >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
                    {historyChange >= 0 ? "▲" : "▼"} {Math.abs(historyChange).toFixed(0)} pts over the period
                  </span>
                )}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {canBackfill && (
                <button
                  onClick={runBackfill}
                  disabled={backfill?.running}
                  className="btn-secondary !px-2.5 !py-1.5 text-xs"
                  title="Rebuild missing hourly snapshots for the past 90 days from stored readings (all machines)"
                >
                  <DatabaseBackup className="w-3.5 h-3.5" />
                  {backfill?.running ? "Backfilling…" : "Backfill 90d"}
                </button>
              )}
              <RangePills
                value={historyDays}
                options={[{ label: "7d", value: "7" }, { label: "30d", value: "30" }, { label: "90d", value: "90" }]}
                onChange={setHistoryDays}
              />
            </div>
          </div>
          {canBackfill && backfill?.running && (
            <div className="mb-3">
              <div className="flex justify-between text-xs text-muted-foreground mb-1 tabular">
                <span>Rebuilding history from stored readings…</span>
                <span>
                  {backfill.hours_done.toLocaleString()} / {backfill.hours_total.toLocaleString()} h · {backfill.rows_written.toLocaleString()} snapshots
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full rounded-full bg-brand-500 transition-[width] duration-700"
                  style={{ width: `${backfill.hours_total ? (backfill.hours_done / backfill.hours_total) * 100 : 0}%` }}
                />
              </div>
            </div>
          )}
          {historyUnavailable ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              History isn&apos;t set up yet — apply <code className="font-mono">add_health_snapshots.sql</code> to the database.
            </p>
          ) : (
            <HealthHistoryChart points={historyPoints} bucket={historyBucket} loading={historyLoading && !history} />
          )}
        </section>
      )}

      {isPredictive && (
        <section className="glass-card p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
            <h2 className="section-title">Health breakdown <span className="text-muted-foreground font-semibold">— {machine.code || machine.name}</span></h2>
            <span className="text-xs text-muted-foreground">Window: last 24 hours</span>
          </div>
          {machineHealth ? <HealthBreakdown machine={machineHealth} />
            : healthLoading ? <div className="skeleton h-24" />
            : <p className="text-sm text-muted-foreground">Health score is unavailable right now.</p>}
        </section>
      )}

      <AlertsList
        title={isPredictive ? "Active predictive alerts" : `Recent ${def.navLabel.toLowerCase()} alerts`}
        moduleId={mod.id}
        onView={(a) => {
          if (a.machine_id !== machine.id) selectMachine(a.machine_id);
          viewAlert(a);
        }}
      />
    </div>
  );
}
