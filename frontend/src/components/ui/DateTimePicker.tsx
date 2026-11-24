"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Clock, X } from "lucide-react";

/**
 * Date or date-time field with a custom calendar popover. Clicking anywhere on the
 * field opens it. Values use the same strings as native inputs, in local time:
 * "YYYY-MM-DD" (mode "date") or "YYYY-MM-DDTHH:mm" (mode "datetime").
 * Click the month title to pick a month, then again to pick a year, for quick
 * jumps to older dates.
 */

type Mode = "date" | "datetime";
type Panel = "days" | "months" | "years";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const POPOVER_W = 304;

const pad = (n: number) => String(n).padStart(2, "0");
const dayKey = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;
const keyOf = (d: Date) => dayKey(d.getFullYear(), d.getMonth(), d.getDate());

function parse(value: string | undefined): { y: number; m: number; d: number; hh: number; mm: number } | null {
  const r = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(value ?? "");
  if (!r) return null;
  return { y: +r[1], m: +r[2] - 1, d: +r[3], hh: r[4] ? +r[4] : 0, mm: r[5] ? +r[5] : 0 };
}

function display(value: string, mode: Mode) {
  const p = parse(value);
  if (!p) return "";
  const date = new Date(p.y, p.m, p.d).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
  return mode === "datetime" ? `${date}, ${pad(p.hh)}:${pad(p.mm)}` : date;
}

export default function DateTimePicker({
  value,
  onChange,
  mode = "date",
  min,
  max,
  placeholder = "Select date",
  className = "",
  inputClassName,
  size = "md",
  allowClear = false,
}: {
  value: string;
  onChange: (value: string) => void;
  mode?: Mode;
  /** Same format as `value`. */
  min?: string;
  max?: string;
  placeholder?: string;
  className?: string;
  /** Replaces the default field styling. */
  inputClassName?: string;
  size?: "sm" | "md";
  allowClear?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<Panel>("days");
  const sel = parse(value);
  const today = new Date();
  const [cursor, setCursor] = useState(() => ({ y: sel?.y ?? today.getFullYear(), m: sel?.m ?? today.getMonth() }));
  const [pos, setPos] = useState<{ top: number; left: number; up: boolean }>({ top: 0, left: 0, up: false });
  const fieldRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const minKey = min?.slice(0, 10);
  const maxKey = max?.slice(0, 10);

  // Re-centre the calendar on the selected value each time it opens.
  const openPicker = () => {
    const p = parse(value);
    setCursor({ y: p?.y ?? today.getFullYear(), m: p?.m ?? today.getMonth() });
    setPanel("days");
    setOpen(true);
  };

  // Fixed-position popover (portal), so modals and overflow:hidden parents don't clip it.
  const place = useCallback(() => {
    const r = fieldRef.current?.getBoundingClientRect();
    if (!r) return;
    const height = popRef.current?.offsetHeight ?? 400;
    const up = r.bottom + 8 + height > window.innerHeight && r.top - 8 - height > 0;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - POPOVER_W - 8));
    setPos({ top: up ? r.top - 8 - height : r.bottom + 8, left, up });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, place, panel]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!fieldRef.current?.contains(t) && !popRef.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  /** Emit a value, clamped to min/max. */
  const emit = (y: number, m: number, d: number, hh = sel?.hh ?? 0, mm = sel?.mm ?? 0) => {
    let v = mode === "datetime" ? `${dayKey(y, m, d)}T${pad(hh)}:${pad(mm)}` : dayKey(y, m, d);
    if (max && v > max) v = max;
    if (min && v < min) v = min;
    onChange(v);
  };

  const pickDay = (y: number, m: number, d: number) => {
    if (mode === "datetime" && !sel) {
      const now = new Date();
      emit(y, m, d, now.getHours(), now.getMinutes());
    } else emit(y, m, d);
    if (mode === "date") setOpen(false);
  };

  const pickShortcut = (date: Date, withTime: boolean) => {
    const hh = withTime ? date.getHours() : sel?.hh ?? date.getHours();
    const mm = withTime ? date.getMinutes() : sel?.mm ?? date.getMinutes();
    setCursor({ y: date.getFullYear(), m: date.getMonth() });
    emit(date.getFullYear(), date.getMonth(), date.getDate(), hh, mm);
    if (mode === "date") setOpen(false);
  };

  // ── Day grid ─────────────────────────────────────────────────────────────
  const days = useMemo(() => {
    const first = new Date(cursor.y, cursor.m, 1);
    const start = new Date(cursor.y, cursor.m, 1 - first.getDay());
    return Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  }, [cursor]);

  const disabledDay = (k: string) => (!!minKey && k < minKey) || (!!maxKey && k > maxKey);
  const disabledMonth = (y: number, m: number) =>
    (!!minKey && dayKey(y, m, 31) < minKey) || (!!maxKey && dayKey(y, m, 1) > maxKey);
  const disabledYear = (y: number) => (!!minKey && `${y}-12-31` < minKey) || (!!maxKey && `${y}-01-01` > maxKey);

  const step = (dir: 1 | -1) => {
    if (panel === "days") {
      const d = new Date(cursor.y, cursor.m + dir, 1);
      setCursor({ y: d.getFullYear(), m: d.getMonth() });
    } else if (panel === "months") setCursor((c) => ({ ...c, y: c.y + dir }));
    else setCursor((c) => ({ ...c, y: c.y + dir * 12 }));
  };

  const yearStart = cursor.y - (cursor.y % 12);
  const title =
    panel === "days" ? `${MONTHS[cursor.m]} ${cursor.y}` : panel === "months" ? String(cursor.y) : `${yearStart} – ${yearStart + 11}`;

  const selKey = sel ? dayKey(sel.y, sel.m, sel.d) : null;
  const todayKey = keyOf(today);

  const sm = size === "sm";
  const fieldCls =
    inputClassName ??
    `w-full flex items-center gap-2 rounded-xl border-2 font-bold shadow-sm transition-all text-left ${
      sm ? "px-2.5 py-1 text-xs" : "px-3.5 py-2.5 text-sm"
    } ${open ? "border-brand-500/60 ring-2 ring-brand-500/20" : "border-border hover:border-brand-500/30 hover:shadow-md"}`;

  const text = display(value, mode);

  return (
    <div className={`relative ${className}`}>
      <button
        ref={fieldRef}
        type="button"
        onClick={() => (open ? setOpen(false) : openPicker())}
        className={`${fieldCls} cursor-pointer`}
        style={inputClassName ? undefined : { backgroundColor: "rgb(var(--card) / 0.8)", color: "rgb(var(--foreground))" }}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <CalendarDays className={`${sm ? "w-3.5 h-3.5" : "w-4 h-4"} text-muted-foreground shrink-0`} />
        <span className={`flex-1 truncate tabular ${text ? "text-foreground" : "text-muted-foreground font-medium"}`}>
          {text || placeholder}
        </span>
        {allowClear && value ? (
          <span
            role="button"
            onClick={(e) => { e.stopPropagation(); onChange(""); }}
            className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
            title="Clear"
          >
            <X className="w-3.5 h-3.5" />
          </span>
        ) : (
          <ChevronDown className={`w-3.5 h-3.5 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
        )}
      </button>

      {typeof document !== "undefined" && createPortal(
        <AnimatePresence>
          {open && (
            <motion.div
              ref={popRef}
              role="dialog"
              initial={{ opacity: 0, y: pos.up ? 6 : -6, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: pos.up ? 6 : -6, scale: 0.98 }}
              transition={{ duration: 0.14, ease: "easeOut" }}
              className="fixed z-[1100] rounded-2xl border border-border shadow-2xl shadow-black/15 p-3 select-none"
              style={{ top: pos.top, left: pos.left, width: POPOVER_W, backgroundColor: "rgb(var(--card))", color: "rgb(var(--foreground))" }}
            >
              {/* Header */}
              <div className="flex items-center justify-between mb-2">
                <button type="button" onClick={() => step(-1)} className={ICON_BTN} aria-label="Previous">
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setPanel(panel === "days" ? "months" : panel === "months" ? "years" : "years")}
                  className="px-3 py-1.5 rounded-lg text-sm font-extrabold tracking-tight hover:bg-brand-500/10 hover:text-brand-600 dark:hover:text-brand-400 transition-colors"
                  title={panel === "years" ? undefined : panel === "days" ? "Pick a month" : "Pick a year"}
                >
                  {title}
                </button>
                <button type="button" onClick={() => step(1)} className={ICON_BTN} aria-label="Next">
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>

              {panel === "days" && (
                <>
                  <div className="grid grid-cols-7 mb-1">
                    {WEEKDAYS.map((w) => (
                      <span key={w} className="text-center text-[11px] font-bold uppercase tracking-wider text-muted-foreground py-1">{w}</span>
                    ))}
                  </div>
                  <div className="grid grid-cols-7 gap-0.5">
                    {days.map((d) => {
                      const k = keyOf(d);
                      const inMonth = d.getMonth() === cursor.m;
                      const isSel = k === selKey;
                      const isToday = k === todayKey;
                      const off = disabledDay(k);
                      return (
                        <button
                          key={k}
                          type="button"
                          disabled={off}
                          onClick={() => pickDay(d.getFullYear(), d.getMonth(), d.getDate())}
                          className={`relative h-9 rounded-lg text-sm tabular transition-colors ${
                            isSel
                              ? "bg-brand-500 text-white font-extrabold shadow-sm"
                              : off
                                ? "text-muted-foreground/30 cursor-not-allowed"
                                : `${inMonth ? "text-foreground font-semibold" : "text-muted-foreground/50 font-medium"} hover:bg-brand-500/10 hover:text-brand-600 dark:hover:text-brand-400`
                          }`}
                        >
                          {d.getDate()}
                          {isToday && !isSel && <span className="absolute bottom-1 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-brand-500" />}
                        </button>
                      );
                    })}
                  </div>
                </>
              )}

              {panel === "months" && (
                <div className="grid grid-cols-3 gap-1.5 py-1">
                  {MONTHS.map((name, m) => {
                    const isSel = sel?.y === cursor.y && sel?.m === m;
                    const off = disabledMonth(cursor.y, m);
                    return (
                      <button
                        key={name}
                        type="button"
                        disabled={off}
                        onClick={() => { setCursor((c) => ({ ...c, m })); setPanel("days"); }}
                        className={`${GRID_BTN} ${isSel ? GRID_SEL : off ? GRID_OFF : GRID_IDLE}`}
                      >
                        {name.slice(0, 3)}
                      </button>
                    );
                  })}
                </div>
              )}

              {panel === "years" && (
                <div className="grid grid-cols-3 gap-1.5 py-1">
                  {Array.from({ length: 12 }, (_, i) => yearStart + i).map((y) => {
                    const isSel = sel?.y === y;
                    const off = disabledYear(y);
                    return (
                      <button
                        key={y}
                        type="button"
                        disabled={off}
                        onClick={() => { setCursor((c) => ({ ...c, y })); setPanel("months"); }}
                        className={`${GRID_BTN} tabular ${isSel ? GRID_SEL : off ? GRID_OFF : y === today.getFullYear() ? `${GRID_IDLE} ring-1 ring-brand-500/40` : GRID_IDLE}`}
                      >
                        {y}
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Time */}
              {mode === "datetime" && panel === "days" && (
                <div className="mt-3 pt-3 border-t border-border flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-muted-foreground">
                    <Clock className="w-3.5 h-3.5" /> Time
                  </span>
                  <div className="flex items-center gap-1">
                    <TimeSegment
                      value={sel?.hh ?? 0}
                      max={23}
                      disabled={!sel}
                      onChange={(hh) => sel && emit(sel.y, sel.m, sel.d, hh, sel.mm)}
                      label="Hours"
                    />
                    <span className="text-lg font-extrabold text-muted-foreground">:</span>
                    <TimeSegment
                      value={sel?.mm ?? 0}
                      max={59}
                      disabled={!sel}
                      onChange={(mm) => sel && emit(sel.y, sel.m, sel.d, sel.hh, mm)}
                      label="Minutes"
                    />
                  </div>
                </div>
              )}

              {/* Footer */}
              <div className="mt-3 pt-3 border-t border-border flex items-center gap-1.5">
                {mode === "datetime" ? (
                  <button type="button" onClick={() => pickShortcut(new Date(), true)} className={CHIP}>Now</button>
                ) : (
                  <button type="button" onClick={() => pickShortcut(new Date(), false)} className={CHIP}>Today</button>
                )}
                <button
                  type="button"
                  onClick={() => { const d = new Date(); d.setDate(d.getDate() - 1); pickShortcut(d, false); }}
                  className={CHIP}
                >
                  Yesterday
                </button>
                {mode === "datetime" ? (
                  <button type="button" onClick={() => setOpen(false)} className="ml-auto btn-primary !px-3 !py-1.5 text-xs">Done</button>
                ) : allowClear && value ? (
                  <button type="button" onClick={() => { onChange(""); setOpen(false); }} className={`${CHIP} ml-auto`}>Clear</button>
                ) : null}
              </div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}
    </div>
  );
}

/** Two-digit time field with up/down steppers; the mouse wheel and arrow keys also step it. */
function TimeSegment({ value, max, onChange, disabled, label }: {
  value: number; max: number; onChange: (v: number) => void; disabled?: boolean; label: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const wrap = (v: number) => ((v % (max + 1)) + (max + 1)) % (max + 1);
  const commit = () => {
    if (draft !== null) {
      const n = parseInt(draft, 10);
      if (Number.isFinite(n)) onChange(Math.min(max, Math.max(0, n)));
      setDraft(null);
    }
  };
  return (
    <div className={`flex flex-col items-center ${disabled ? "opacity-40 pointer-events-none" : ""}`}>
      <button type="button" onClick={() => onChange(wrap(value + 1))} className={STEP_BTN} aria-label={`${label} up`}>
        <ChevronUp className="w-3.5 h-3.5" />
      </button>
      <input
        aria-label={label}
        inputMode="numeric"
        value={draft ?? pad(value)}
        onFocus={(e) => e.target.select()}
        onChange={(e) => setDraft(e.target.value.replace(/\D/g, "").slice(0, 2))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          else if (e.key === "ArrowUp") { e.preventDefault(); onChange(wrap(value + 1)); }
          else if (e.key === "ArrowDown") { e.preventDefault(); onChange(wrap(value - 1)); }
        }}
        onWheel={(e) => onChange(wrap(value + (e.deltaY < 0 ? 1 : -1)))}
        className="w-11 h-9 text-center rounded-lg border border-border bg-muted/40 text-base font-extrabold tabular focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500/50"
      />
      <button type="button" onClick={() => onChange(wrap(value - 1))} className={STEP_BTN} aria-label={`${label} down`}>
        <ChevronDown className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

const ICON_BTN = "w-8 h-8 inline-flex items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground transition-colors";
const STEP_BTN = "w-11 h-5 inline-flex items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground transition-colors";
const GRID_BTN = "h-11 rounded-lg text-sm transition-colors";
const GRID_SEL = "bg-brand-500 text-white font-extrabold shadow-sm";
const GRID_OFF = "text-muted-foreground/30 cursor-not-allowed";
const GRID_IDLE = "font-semibold text-foreground hover:bg-brand-500/10 hover:text-brand-600 dark:hover:text-brand-400";
const CHIP = "px-2.5 py-1 rounded-md text-xs font-bold border border-border text-muted-foreground hover:text-brand-600 hover:border-brand-500/50 dark:hover:text-brand-400 transition-colors";
