// Insights: a native, local-only usage dashboard. No DOM, no shell, no stored cx.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Button, Input, InputState, Editor, EditorState, Popover } from "gpui-base";
import { exec, appHome, home, theme, settings, nextCommand, readTextFile } from "herdr";
import { costsSummary, requestFilter, requestsTable } from "./requests-ui.js";
import {
  PALETTES,
  clampRefreshSeconds,
  dayLabel,
  formatBytes,
  formatCompact,
  formatDuration,
  formatHitRate,
  formatInt,
  formatTimestamp,
  initials,
  isDay,
  isPresentation,
  normalizeConfig,
  periodRange,
  projectName,
  todayKey,
  weekdayLabels,
} from "./analytics.js";
import {
  G,
  H,
  R,
  T,
  bodyText,
  button,
  card,
  cardHeader,
  controlInput,
  fieldLabel,
  iconButton,
  inset,
  metaLabel,
  mutedText,
  notice,
  pageTitle,
  segmented,
  statCell,
  stateCard,
  toggleSwitch,
  tokens,
} from "./ui.js";

const MIN_CELL = 12;
const MAX_CELL = 16;
const CELL_GAP = 2;
const DAY_LABEL_WIDTH = 30;

/**
 * Heatmap cells stay small on narrow views and grow up to MAX_CELL on wide
 * ones so the grid reads centered instead of pinned to the left edge.
 */
export function heatmapMetrics(width, weekCount) {
  const viewWidth = Number.isFinite(width) ? width : 960;
  const weeks = Math.max(1, weekCount);
  const pagePadding = (viewWidth < 620 ? G.md : viewWidth < 900 ? G.lg : G.xl) * 2;
  const available = Math.max(320, Math.min(1480, viewWidth - pagePadding) - G.lg * 2);
  const fitted = Math.floor((available - DAY_LABEL_WIDTH - (weeks - 1) * CELL_GAP) / weeks);
  const cell = Math.max(MIN_CELL, Math.min(MAX_CELL, fitted));
  const weekWidth = cell + CELL_GAP;
  const contentWidth = DAY_LABEL_WIDTH + weeks * weekWidth;
  return { cell, weekWidth, contentWidth, centered: contentWidth <= available };
}

/** Categorical chart palette that reads on both dark and light themes. */
const MODEL_CHART_COLORS = ["#5b8def", "#3fb27f", "#e0a23c", "#d96c92", "#8f6fe0", "#41b3ba", "#e2704f"];
const OTHER_CHART_COLOR = "#6f8fd1";
const CHART_HEIGHT = 168;

function modelChartColor(name, index) {
  if (name === "Other") return OTHER_CHART_COLOR;
  return MODEL_CHART_COLORS[index % MODEL_CHART_COLORS.length];
}

/** Bundled monochrome brand marks, tinted with the surrounding text color. */
const PROVIDER_LOGO_FILES = {
  openai: "openai.svg",
  anthropic: "anthropic.svg",
  google: "googlegemini.svg",
  gemini: "googlegemini.svg",
  deepseek: "deepseek.svg",
  xai: "xai.svg",
  meta: "meta.svg",
  mistral: "mistralai.svg",
  aws: "amazonaws.svg",
  amazon: "amazonaws.svg",
  bedrock: "amazonaws.svg",
  opencode: "opencode.svg",
  ollama: "ollama.svg",
};

export function providerLogo(provider) {
  const key = String(provider ?? "").toLowerCase().trim();
  if (!key || key === "unknown" || key === "unknown provider") return null;
  if (PROVIDER_LOGO_FILES[key]) return PROVIDER_LOGO_FILES[key];
  for (const [prefix, file] of Object.entries(PROVIDER_LOGO_FILES)) {
    if (key.startsWith(prefix)) return file;
  }
  return null;
}

const MODEL_LOGO_PATTERNS = [
  [/claude/i, "anthropic.svg"],
  [/gpt|\bo[1-9]/i, "openai.svg"],
  [/gemini/i, "googlegemini.svg"],
  [/deepseek/i, "deepseek.svg"],
  [/grok/i, "xai.svg"],
  [/mistral|mixtral|codestral/i, "mistralai.svg"],
  [/ollama/i, "ollama.svg"],
  [/llama/i, "meta.svg"],
];

export function modelLogo(model) {
  const key = String(model ?? "").toLowerCase().trim();
  if (!key || key === "unknown" || key === "unknown model") return null;
  const candidates = key.includes("/") ? [key.split("/").at(-1), key] : [key];
  for (const candidate of candidates) {
    for (const [pattern, file] of MODEL_LOGO_PATTERNS) {
      if (pattern.test(candidate)) return file;
    }
  }
  return null;
}

export function usageLogo(model, provider) {
  return modelLogo(model) ?? providerLogo(provider);
}
const MAX_FACET_OPTIONS = 250;
const DEFAULT_NODE = "node";
const RUNTIME_FILE = "mods/insights/runtime.json";
const PRESENTER_FILE = "mods/insights/presenter.mjs";
const ACTIVITY_TIMEOUT_MS = 180_000;

const HEAT_COLORS = {
  blue: {
    dark: ["#12324f", "#155e8a", "#1d86c4", "#4fb3f0"],
    light: ["#dbeafe", "#93c5fd", "#3b82f6", "#1d4ed8"],
  },
  green: {
    dark: ["#12351f", "#166534", "#15803d", "#4ade80"],
    light: ["#dcfce7", "#86efac", "#22c55e", "#15803d"],
  },
  purple: {
    dark: ["#2a1b4d", "#4c1d95", "#6d28d9", "#a78bfa"],
    light: ["#ede9fe", "#c4b5fd", "#8b5cf6", "#6d28d9"],
  },
};

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function prettyJson(value) {
  return JSON.stringify(value, null, 2);
}

function sanitizeError(error) {
  let text;
  if (error && typeof error === "object") text = error.message ?? error.error ?? "";
  else text = String(error ?? "");
  text = text.replace(/\s+/g, " ").trim();
  if (!text) text = "未知错误";
  return text.length > 420 ? `${text.slice(0, 417)}…` : text;
}

function resultError(result) {
  const stderr = String(result?.stderr ?? "").trim();
  const stdout = String(result?.stdout ?? "").trim();
  const text = stderr || stdout;
  if (!text) return `采集程序退出，错误码 ${result?.code ?? "?"}。`;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      const message = parsed.error ?? parsed.message;
      if (message) return String(message);
      return `采集程序退出，错误码 ${result?.code ?? "?"}。`;
    }
  } catch {
    // Diagnostics are plain text.
  }
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  // Node startup failures put an internal frame first; prefer the real exception line.
  const errorLine = lines.find((line) => /^(?:[A-Za-z][\w.]*Error|Error|error):/.test(line));
  return sanitizeError(errorLine || lines.find((line) => !/^at\s/.test(line)) || text);
}

function parseRuntimeNode(raw) {
  if (raw === null || raw === undefined) return DEFAULT_NODE;
  let config;
  try {
    config = JSON.parse(raw);
  } catch (error) {
    throw new Error(`runtime.json 的 JSON 格式无效：${sanitizeError(error)}`, { cause: error });
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("runtime.json 必须是包含 node 路径的 JSON 对象。");
  }
  if (typeof config.node !== "string") {
    throw new Error("runtime.json 缺少 node 程序路径。");
  }
  const node = config.node.trim();
  if (!node) throw new Error("Node 程序路径不能为空。");
  if (/[\u0000-\u001f\u007f]/.test(config.node)) {
    throw new Error("Node 程序路径不能包含控制字符。");
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(node) && !/^[a-z]:[\\/]/i.test(node)) {
    throw new Error("node 必须填写本地 Node 程序路径，不能填写网址。");
  }
  return node;
}

function parseSnapshot(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) throw new Error("统计程序未返回看板数据。");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("统计程序返回的 JSON 无效。");
  }
  if (!isPresentation(parsed)) {
    throw new Error("统计程序返回的数据格式不兼容。");
  }
  return parsed;
}

function presentationKey(snapshot, options = {}) {
  return JSON.stringify({
    generatedAt: snapshot?.generatedAt ?? null,
    lastScanAt: snapshot?.lastScanAt ?? null,
    config: snapshot?.config ?? null,
    filters: options.filters ?? {},
    period: options.period ?? "all",
    year: options.year ?? null,
    heatmapMode: options.heatmapMode ?? "daily",
    selectedDay: options.selectedDay ?? null,
    today: options.today ?? null,
    requestPage: options.requestPage ?? 1,
    requestPageSize: options.requestPageSize ?? 50,
    requestAgent: options.requestAgent ?? "all",
    requestModel: options.requestModel ?? "all",
  });
}

function sameOptions(left, right) {
  return JSON.stringify(left ?? {}) === JSON.stringify(right ?? {});
}

function sourceKey(source, index) {
  return String(source?.id || source?.adapter || `source-${index}`);
}

function rootsText(source) {
  return Array.isArray(source?.roots) ? source.roots.join(", ") : "";
}

function splitRoots(text) {
  return String(text ?? "").split(/[\n,]+/).map((root) => root.trim()).filter(Boolean);
}

function sourceLabel(value, config) {
  const source = (config.sources ?? []).find((item) => item?.adapter === value || item?.id === value);
  return source?.label || (value === "unknown" ? "未知来源" : value);
}

function warningText(warning) {
  if (warning === null || warning === undefined) return "";
  if (typeof warning === "string") return warning;
  if (typeof warning === "object") return String(warning.message ?? warning.text ?? warning.error ?? "");
  return String(warning);
}

function sourceStatEntry(snapshot, source) {
  const map = snapshot?.sourceStats;
  if (!map || typeof map !== "object" || Array.isArray(map) || !source?.id) return null;
  const entry = map[source.id];
  if (entry === undefined || entry === null) return null;
  if (typeof entry === "string") return { status: entry, stats: null, error: null };
  if (typeof entry !== "object") return null;
  return {
    status: String(entry.status ?? entry.state ?? ""),
    stats: entry.stats && typeof entry.stats === "object" ? entry.stats : entry,
    error: entry.error ?? entry.message ?? null,
  };
}

function sourceStatusColor(status, c) {
  if (status === "ok") return c.done;
  if (status === "error" || status === "missing") return c.destructive;
  if (status === "empty") return c.accent;
  return c.dim;
}

function sourceStatusLabel(status) {
  return ({ ok: "已读取", error: "读取失败", missing: "路径不存在", empty: "暂无记录", disabled: "已关闭", enabled: "已启用" })[status] ?? "未知状态";
}

function statCount(value) {
  if (value === null || value === undefined || value === "") return "—";
  const number = Number(value);
  return Number.isFinite(number) ? formatInt(number) : "—";
}

function statBytes(value) {
  if (value === null || value === undefined || value === "") return "—";
  const number = Number(value);
  return Number.isFinite(number) ? formatBytes(number) : "—";
}

function sourceStatsText(entry) {
  const stats = entry?.stats;
  if (!stats || typeof stats !== "object") return "";
  const parts = [];
  if (stats.files !== undefined) parts.push(`${statCount(stats.files)} 个文件`);
  if (stats.filesRead !== undefined) parts.push(`已读 ${statCount(stats.filesRead)} 个`);
  if (stats.errors) parts.push(`${statCount(stats.errors)} 个错误`);
  if (stats.bytesRead) parts.push(statBytes(stats.bytesRead));
  if (entry.error) parts.push(sanitizeError(entry.error));
  return parts.join(" · ");
}

function isDarkTheme(t) {
  const match = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(String(t?.background ?? ""));
  if (!match) return true;
  const number = Number.parseInt(match[1], 16);
  const red = (number >> 16) & 255;
  const green = (number >> 8) & 255;
  const blue = number & 255;
  return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue) < 128;
}

function heatColor(level, palette, dark) {
  if (level <= 0) return null;
  const set = HEAT_COLORS[palette] ?? HEAT_COLORS.blue;
  return (dark ? set.dark : set.light)[Math.min(3, level - 1)];
}

function changeColor(change, c) {
  if (change?.kind === "up") return c.done;
  if (change?.kind === "down") return c.destructive;
  if (change?.kind === "new") return c.accent;
  return c.dim;
}

function allLabelFor(field) {
  if (field === "source") return "全部来源";
  if (field === "provider") return "全部服务商";
  if (field === "model") return "全部模型";
  return "全部项目";
}

function facetLabel(field, value, config) {
  if (field === "source") return sourceLabel(value, config);
  if (field === "provider") return value === "unknown" ? "未知服务商" : value;
  if (field === "model") return value === "unknown" ? "未知模型" : value;
  return value === "unknown" ? "未知项目" : projectName(value);
}

function buildFacetOptions(field, facet, config) {
  const stats = facet?.stats ?? [];
  const options = stats.map((stat) => ({
    value: stat.value,
    label: facetLabel(field, stat.value, config),
    detail: field === "project" && stat.value !== "unknown" ? stat.value : "",
    meta: stat.meta ?? formatCompact(stat.tokens),
    tokens: stat.tokens,
    tooltip: stat.tooltip ?? `${formatInt(stat.tokens)} Token · ${formatInt(stat.sessions)} 次会话`,
  }));
  const seen = new Set(options.map((option) => option.value));
  if (field === "source") {
    for (const source of config.sources ?? []) {
      const value = String(source?.adapter || source?.id || "");
      if (!value || seen.has(value)) continue;
      options.push({
        value,
        label: source.label || value,
        detail: source.adapter ? `适配器 ${source.adapter}` : "",
        meta: "0",
        tokens: 0,
        tooltip: "0 Token",
      });
      seen.add(value);
    }
  }
  options.sort((left, right) => right.tokens - left.tokens || left.label.localeCompare(right.label));
  const total = facet?.total ?? 0;
  const truncated = Boolean(facet?.truncated) || options.length > MAX_FACET_OPTIONS;
  const visible = options.slice(0, MAX_FACET_OPTIONS);
  return {
    truncated,
    total,
    options: [
      { value: "all", label: allLabelFor(field), detail: "", meta: facet?.totalMeta ?? formatCompact(total), tokens: total, tooltip: facet?.totalTooltip ?? `${formatInt(total)} Token` },
      ...visible,
    ],
  };
}

function selectedFacet(facet, value, field, config) {
  if (value === "all") return { value: "all", label: allLabelFor(field) };
  const found = (facet?.stats ?? []).find((stat) => stat.value === value);
  return { value, label: facetLabel(field, found?.value ?? value, config) };
}



function preferenceRow(label, control, c) {
  return h_flex().w_full().flex_wrap().gap(16).items_center().min_h(44)
    .child(div().w(164).flex_none().child(fieldLabel(label, c).line_height("20px")))
    .child(h_flex().min_w(0).items_center().child(control));
}

export default class Insights extends View {
  init(_props, cx) {
    this.closed = false;
    this.snapshot = null;
    this.loading = false;
    this.error = null;
    this.width = 960;
    this.height = 800;
    this.filters = { provider: "all", model: "all" };
    this.period = "all";
    this.year = Number(todayKey().slice(0, 4));
    this.heatmapMode = "daily";
    this.selectedDay = todayKey();
    this.showSettings = false;
    this.activeView = localStorage.getItem("usage-view") === "overview" ? "overview" : "requests";
    this.requestPage = 1;
    this.requestPageSize = 50;
    this.requestAgent = "all";
    this.requestModel = "all";
    this.openFilter = null;
    this.openOptions = null;
    this.configDraft = null;
    this.configText = "";
    this.configDirty = false;
    this.editorDirty = false;
    this.rootsDirty = false;
    this.refreshDirty = false;
    this.saving = false;
    this.saveError = null;
    this.saveMessage = null;
    this.syncingInputs = false;
    this.syncingEditor = false;
    this.sourceInputs = new Map();
    this.refreshInput = null;
    this.configEditor = null;
    this.settingsTask = null;
    this.settingsQueued = false;
    this.timer = null;
    this.timerSeconds = null;
    this.commandTask = null;
    this.runtimeTask = null;
    this.runtimeReady = false;
    this.runtimeError = null;
    this.nodeBinary = null;
    this.dashboard = null;
    this.dashboardKey = null;
    this.dashboardPending = null;
    this.dashboardError = null;
    this.dashboardTimer = null;
    this.dashboardTask = null;
    this.progressTimer = null;
    this.scanProgress = null;
    this.progressTask = null;
    this.progressGeneration = 0;
    this.activityTask = null;
    this.activityGeneration = 0;
    this.dashboardQueued = false;
    this.dashboardGeneration = 0;
    this.dashboardWatchdog = null;
    this.refreshWatchdog = null;
    this.saveWatchdog = null;
    this.years = [Number(todayKey().slice(0, 4))];

    this.resolveRuntime(cx);
    this.commandTask = cx.spawn(async (commandCx) => {
      for (;;) {
        let command;
        try {
          command = await nextCommand();
        } catch {
          break;
        }
        const name = String(command).replace(/^insights\./, "");
        if (name === "refresh") this.refresh(commandCx);
        else if (name === "settings") this.openSettings(commandCx);
        else if (name === "dashboard") {
          this.showSettings = false;
          commandCx.notify();
        } else if (name === "requests" || name === "overview") {
          this.selectUsageView(name, commandCx);
        } else if (name === "page.next" || name === "page.prev") {
          this.setRequestPage(this.requestPage + (name === "page.next" ? 1 : -1), commandCx);
        } else if (name.startsWith("agent.")) {
          this.requestAgent = name.slice("agent.".length) || "all";
          this.requestPage = 1;
          this.scheduleDashboard(commandCx, { force: true });
          commandCx.notify();
        } else if (name.startsWith("request-model.")) {
          this.requestModel = name.slice("request-model.".length) || "all";
          this.requestPage = 1;
          this.scheduleDashboard(commandCx, { force: true });
          commandCx.notify();
        } else if (name.startsWith("period.")) {
          this.setPeriod(name.slice("period.".length), commandCx);
          commandCx.notify();
        } else if (name === "year.prev" || name === "year.next") {
          this.setYear(name === "year.prev" ? 1 : -1, commandCx);
          commandCx.notify();
        } else if (name.startsWith("heatmap.")) {
          const mode = name.slice("heatmap.".length);
          if (["daily", "weekly", "cumulative"].includes(mode)) {
            this.heatmapMode = mode;
            this.scheduleDashboard(commandCx, { force: true });
            commandCx.notify();
          }
        } else if (name === "filters.clear") {
          this.filters = { provider: "all", model: "all" };
          this.requestAgent = "all";
          this.requestModel = "all";
          this.requestPage = 1;
          this.scheduleDashboard(commandCx, { force: true });
          commandCx.notify();
        }
      }
    });
  }

  close() {
    this.closed = true;
    this.cancelDashboardWork();
    this.activityGeneration = (this.activityGeneration ?? 0) + 1;
    try { this.activityTask?.cancel(); } catch { /* already gone */ }
    this.activityTask = null;
    this.cancelProgress();
    try { this.timer?.cancel(); } catch { /* already gone */ }
    try { this.dashboardTimer?.cancel(); } catch { /* already gone */ }
    try { this.dashboardTask?.cancel(); } catch { /* already gone */ }
    try { this.dashboardWatchdog?.cancel(); } catch { /* already gone */ }
    try { this.refreshWatchdog?.cancel(); } catch { /* already gone */ }
    try { this.progressTimer?.cancel(); } catch { /* already gone */ }
    try { this.saveWatchdog?.cancel(); } catch { /* already gone */ }
    try { this.settingsTask?.cancel(); } catch { /* already gone */ }
    try { this.commandTask?.cancel(); } catch { /* already gone */ }
    try { this.runtimeTask?.cancel(); } catch { /* already gone */ }
    try { this.refreshInput?.release(); } catch { /* already released */ }
    for (const state of this.sourceInputs.values()) {
      try { state.release(); } catch { /* already released */ }
    }
    try { this.configEditor?.release(); } catch { /* already released */ }
    this.refreshInput = null;
    this.configEditor = null;
    this.settingsTask = null;
    this.settingsQueued = false;
    this.sourceInputs = new Map();
  }

  editorOptions() {
    const t = theme();
    const options = {
      language: "json",
      value: this.configText || "{}",
      font_size: 12,
      line_numbers: true,
      folding: false,
      soft_wrap: false,
      syntax: {
        keyword: t.ansi5,
        string: t.ansi2,
        comment: t.dim,
        function: t.ansi4,
        type: t.ansi3,
        number: t.ansi1,
        constant: t.ansi6,
      },
    };
    if (settings()?.font_family) options.font_family = settings().font_family;
    return options;
  }

  // Native editor and source inputs are only needed while Settings is open.
  // The dashboard never constructs or syncs them during a background snapshot.
  ensureSettingsControls() {
    if (!this.snapshot && !this.configDraft) return null;
    const savedConfig = normalizeConfig(this.snapshot?.config ?? {});
    const config = this.configDirty || this.editorDirty ? this.draftConfig(savedConfig) : savedConfig;
    if (!this.configDraft) this.configDraft = deepClone(config);
    if (!this.configText) this.configText = prettyJson(this.configDraft);

    if (!this.configEditor) {
      this.configEditor = EditorState.new(this.editorOptions());
      this.configEditor.on("change", () => {
        if (this.syncingEditor || !this.configEditor) return;
        const value = this.configEditor.value();
        if (!this.editorDirty && value === this.configText) return;
        this.editorDirty = true;
        this.configDirty = true;
        this.saveMessage = null;
      });
      this.configEditor.on("blur", (_event, notifyCx) => {
        this.applyEditorDraft();
        notifyCx.notify();
      });
    }

    if (!this.refreshInput) {
      this.refreshInput = InputState.new({ value: String(config.refreshSeconds) });
      this.refreshInput.on("change", () => {
        if (this.syncingInputs) return;
        this.refreshDirty = true;
        this.configDirty = true;
        this.saveMessage = null;
      });
      this.refreshInput.on("blur", (_event, notifyCx) => notifyCx.notify());
      this.refreshInput.on("submit", (_event, submitCx) => this.saveConfig(submitCx));
    }
    return config;
  }

  syncSettingsControls() {
    if (!this.showSettings) return;
    const config = this.ensureSettingsControls();
    if (!config) return;
    if (!this.configDirty && !this.editorDirty) this.setEditorText(this.configText || prettyJson(config));
    this.ensureSourceInputs(config);
    if (!this.rootsDirty) this.syncSourceInputs(config);
    if (!this.refreshDirty) this.syncRefreshInput(config);
  }

  scheduleSettingsSync(cx) {
    if (!this.showSettings) return;
    if (this.settingsTask) {
      this.settingsQueued = true;
      return;
    }
    let task = null;
    task = cx.spawn(async (syncCx) => {
      try {
        if (this.showSettings) this.syncSettingsControls();
      } catch (error) {
        this.saveError = sanitizeError(error);
      } finally {
        if (this.settingsTask === task) this.settingsTask = null;
        if (this.showSettings && this.settingsQueued) {
          this.settingsQueued = false;
          this.scheduleSettingsSync(syncCx);
        }
        syncCx.notify();
      }
    });
    this.settingsTask = task;
  }

  busy() {
    return this.loading || this.saving;
  }

  resolveRuntime(cx) {
    if (this.closed || (this.runtimeTask && !this.runtimeReady)) return;
    this.runtimeReady = false;
    this.runtimeError = null;
    this.loading = true;
    this.runtimeTask = cx.spawn(async (runtimeCx) => {
      try {
        const raw = await readTextFile(this.runtimePath());
        if (this.closed) return;
        this.nodeBinary = parseRuntimeNode(raw);
      } catch (error) {
        if (this.closed) return;
        this.nodeBinary = null;
        this.runtimeError = `统计程序配置读取失败（${this.runtimePath()}）：${sanitizeError(error)}`;
        this.error = this.runtimeError;
      } finally {
        if (!this.closed) {
          this.runtimeReady = true;
          this.runtimeTask = null;
          this.loading = false;
        }
      }
      if (this.closed) return;
      if (this.nodeBinary) {
        this.refresh(runtimeCx);
        this.schedule(runtimeCx);
      }
      runtimeCx.notify();
    });
    cx.notify();
  }

  runtimePath() {
    return `${appHome()}/${RUNTIME_FILE}`;
  }

  presenterPath() {
    return `${appHome()}/${PRESENTER_FILE}`;
  }

  storePath() {
    return `${appHome()}/data/insights/insights.json`;
  }

  schedule(cx) {
    const seconds = clampRefreshSeconds(this.snapshot?.config?.refreshSeconds ?? 60);
    if (this.timer && this.timerSeconds === seconds) return;
    try { this.timer?.cancel(); } catch { /* already gone */ }
    this.timerSeconds = seconds;
    this.timer = cx.timer.every(seconds * 1000, (timerCx) => this.refresh(timerCx));
  }

  dashboardOptions() {
    return {
      filters: this.filters,
      period: this.period,
      year: this.year,
      heatmapMode: this.heatmapMode,
      selectedDay: this.selectedDay,
      today: todayKey(),
      requestPage: this.activeView === "requests" ? this.requestPage : 1,
      requestPageSize: this.requestPageSize,
      requestAgent: this.activeView === "requests" ? this.requestAgent : "all",
      requestModel: this.activeView === "requests" ? this.requestModel : "all",
    };
  }

  // Analytics run in the Node presentation helper. QuickJS only stores the
  // compact result and renders it; no derivation runs in a render frame.
  progressPath() {
    return `${this.storePath()}.progress.json`;
  }

  // The collector writes a small progress file while scanning. Poll it only
  // while a refresh is in flight so the loading card can name the live file.
  armProgress(cx) {
    this.cancelProgress();
    // Self-terminating: if a refresh continuation is interrupted before its
    // finally runs, the poll must not leak into a permanent notify loop.
    let ticks = 0;
    const generation = this.progressGeneration;
    this.progressTimer = cx.timer.every(500, (timerCx) => {
      ticks += 1;
      if (!this.loading || ticks > Math.ceil(ACTIVITY_TIMEOUT_MS / 500) + 2) {
        this.cancelProgress();
        return;
      }
      if (this.progressTask) return;
      this.progressTask = timerCx.spawn(async (progressCx) => {
        let next = null;
        try {
          const parsed = JSON.parse(await readTextFile(this.progressPath()));
          if (parsed && Number.isFinite(Number(parsed.processed)) && Number.isFinite(Number(parsed.total))) next = parsed;
        } catch { /* the progress file is best-effort */ }
        if (generation !== this.progressGeneration || !this.loading) return;
        this.progressTask = null;
        const changed = (next?.processed ?? null) !== (this.scanProgress?.processed ?? null)
          || (next?.file ?? null) !== (this.scanProgress?.file ?? null);
        this.scanProgress = next;
        if (changed) progressCx.notify();
      });
    });
  }

  cancelProgress() {
    this.progressGeneration = (this.progressGeneration ?? 0) + 1;
    try { this.progressTimer?.cancel(); } catch { /* already gone */ }
    try { this.progressTask?.cancel(); } catch { /* already gone */ }
    this.progressTimer = null;
    this.progressTask = null;
    this.scanProgress = null;
  }

  armWatchdog(kind, cx) {
    const field = kind === "refresh" ? "refreshWatchdog" : "saveWatchdog";
    try { this[field]?.cancel(); } catch { /* already gone */ }
    const generation = this.activityGeneration;
    this[field] = cx.timer.after(ACTIVITY_TIMEOUT_MS, (timerCx) => {
      if (generation !== this.activityGeneration) return;
      this[field] = null;
      this.activityGeneration = (this.activityGeneration ?? 0) + 1;
      try { this.activityTask?.cancel(); } catch { /* already gone */ }
      this.activityTask = null;
      if (kind === "refresh" && this.loading) {
        this.loading = false;
        this.cancelProgress();
        this.error = "刷新超过 3 分钟。首次读取历史记录可能较久，请稍后重试。";
        timerCx.notify();
      }
      if (kind === "save" && this.saving) {
        this.saving = false;
        this.saveError = "保存后重新读取超过 3 分钟，请稍后刷新检查。";
        timerCx.notify();
      }
    });
  }

  cancelWatchdog(kind) {
    const field = kind === "refresh" ? "refreshWatchdog" : "saveWatchdog";
    try { this[field]?.cancel(); } catch { /* already gone */ }
    this[field] = null;
  }

  cancelDashboardWork() {
    this.dashboardGeneration = (this.dashboardGeneration ?? 0) + 1;
    this.dashboardQueued = false;
    this.dashboardPending = null;
    try { this.dashboardTimer?.cancel(); } catch { /* already gone */ }
    this.dashboardTimer = null;
    try { this.dashboardTask?.cancel(); } catch { /* already gone */ }
    try { this.dashboardWatchdog?.cancel(); } catch { /* already gone */ }
    this.dashboardTask = null;
    this.dashboardWatchdog = null;
  }

  scheduleDashboard(cx, { force = false } = {}) {
    if (!this.snapshot || !this.nodeBinary || this.runtimeError) return;
    const options = this.dashboardOptions();
    const key = presentationKey(this.snapshot, options);
    if (!force && this.dashboard && this.dashboardKey === key) return;
    if (!force && this.dashboardPending === key) return;
    if (this.dashboardTask) {
      // Coalesce every filter/settings change made while a prepare is running.
      this.dashboardQueued = true;
      this.dashboardError = null;
      return;
    }
    try { this.dashboardTimer?.cancel(); } catch { /* already gone */ }
    this.dashboardPending = key;
    this.dashboardError = null;
    this.dashboardTimer = cx.timer.after(0, (timerCx) => {
      this.dashboardTimer = null;
      this.prepareDashboard(timerCx, key);
    });
  }

  prepareDashboard(cx, key) {
    if (!this.snapshot || !this.nodeBinary || this.runtimeError) return;
    const options = this.dashboardOptions();
    if (presentationKey(this.snapshot, options) !== key) {
      // A newer snapshot or filter replaced the request before the timer ran.
      this.scheduleDashboard(cx, { force: true });
      return;
    }
    const generation = (this.dashboardGeneration ?? 0) + 1;
    this.dashboardGeneration = generation;
    try { this.dashboardWatchdog?.cancel(); } catch { /* already gone */ }
    this.dashboardWatchdog = cx.timer.after(ACTIVITY_TIMEOUT_MS, (timerCx) => {
      this.dashboardWatchdog = null;
      if (generation !== this.dashboardGeneration) return;
      this.dashboardGeneration += 1;
      this.dashboardPending = null;
      this.dashboardQueued = false;
      try { this.dashboardTask?.cancel(); } catch { /* already gone */ }
      this.dashboardTask = null;
      this.dashboardError = "生成看板超时，请重试。";
      timerCx.notify();
    });
    let task = null;
    task = cx.spawn(async (prepareCx) => {
      try {
        const result = await exec(this.nodeBinary, [
          this.presenterPath(),
          "prepare",
          "--store",
          this.storePath(),
          "--options",
          JSON.stringify(options),
        ]);
        if (result.code !== 0) throw new Error(resultError(result));
        const payload = parseSnapshot(result.stdout);
        if (generation !== this.dashboardGeneration) return;
        if (payload.error && !payload.dashboard) throw new Error(payload.error);
        if (!payload.dashboard) throw new Error("统计程序未返回看板数据。");
        if (!this.snapshot || presentationKey(this.snapshot, this.dashboardOptions()) !== key) return;
        this.dashboard = payload.dashboard;
        this.dashboardKey = key;
        if (Array.isArray(payload.dashboard.years) && payload.dashboard.years.length) this.years = payload.dashboard.years;
        this.dashboardError = null;
      } catch (error) {
        if (generation === this.dashboardGeneration && this.snapshot
          && presentationKey(this.snapshot, this.dashboardOptions()) === key) {
          this.dashboardError = sanitizeError(error);
        }
      } finally {
        if (generation === this.dashboardGeneration) {
          try { this.dashboardWatchdog?.cancel(); } catch { /* already gone */ }
          this.dashboardWatchdog = null;
          if (this.dashboardPending === key) this.dashboardPending = null;
          if (this.dashboardTask === task) this.dashboardTask = null;
          prepareCx.notify();
          if (this.dashboardQueued) {
            this.dashboardQueued = false;
            this.scheduleDashboard(prepareCx);
          }
        }
      }
    });
    this.dashboardTask = task;
  }

  refresh(cx) {
    if (this.closed || !this.runtimeReady) return;
    if (this.runtimeError) {
      this.resolveRuntime(cx);
      return;
    }
    if (this.busy()) return;
    const generation = (this.activityGeneration ?? 0) + 1;
    this.activityGeneration = generation;
    this.loading = true;
    this.error = null;
    cx.notify();
    this.armWatchdog("refresh", cx);
    this.armProgress(cx);
    const presenter = this.presenterPath();
    const store = this.storePath();
    const options = this.dashboardOptions();
    this.activityTask = cx.spawn(async (refreshCx) => {
      let payload = null;
      let failure = null;
      try {
        const result = await exec(this.nodeBinary, [
          presenter,
          "snapshot",
          "--store",
          store,
          "--home",
          home(),
          "--options",
          JSON.stringify(options),
        ]);
        if (result.code !== 0) throw new Error(resultError(result));
        payload = parseSnapshot(result.stdout);
      } catch (error) {
        failure = error;
      } finally {
        if (generation === this.activityGeneration) {
          this.activityTask = null;
          this.loading = false;
          this.cancelWatchdog("refresh");
          this.cancelProgress();
          if (failure) {
            this.error = sanitizeError(failure);
            refreshCx.notify();
          }
        }
      }
      if (!payload || generation !== this.activityGeneration) return;
      this.error = null;
      try {
        this.applySnapshot(payload, refreshCx);
      } catch (error) {
        this.error = sanitizeError(error);
        refreshCx.notify();
      }
    });
  }

  applySnapshot(payload, cx) {
    if (!isPresentation(payload)) throw new Error("统计程序返回的数据格式不兼容。");
    const snapshot = payload.snapshot;
    this.cancelDashboardWork();
    this.snapshot = snapshot;
    const savedConfig = normalizeConfig(snapshot.config);
    const today = todayKey();
    const years = Array.isArray(payload.dashboard?.years) && payload.dashboard.years.length
      ? payload.dashboard.years
      : [Number(today.slice(0, 4))];
    this.years = years;
    if (!Number.isInteger(this.year) || !years.includes(this.year)) this.year = years[0] ?? Number(today.slice(0, 4));
    if (!isDay(this.selectedDay)) this.selectedDay = today;

    // Publish the compact dashboard before editor and input host work so an
    // interruption there can never bring back a permanent Preparing screen.
    const optionsNow = this.dashboardOptions();
    const key = presentationKey(snapshot, optionsNow);
    if (payload.dashboard && sameOptions(payload.options, optionsNow)) {
      this.dashboard = payload.dashboard;
      this.dashboardKey = key;
      this.dashboardError = payload.error ? sanitizeError(payload.error) : null;
    } else {
      this.dashboard = null;
      this.dashboardKey = null;
      this.dashboardError = payload.error ? sanitizeError(payload.error) : null;
    }
    this.schedule(cx);
    if (!this.dashboard) this.scheduleDashboard(cx, { force: true });

    if (!this.configDirty && !this.editorDirty) {
      this.configDraft = deepClone(savedConfig);
      this.configText = prettyJson(this.configDraft);
    }

    // Only compact metadata and the prepared dashboard are applied here. The
    // native settings controls are created or synced by a separate Task after
    // this notification, so they can never interrupt the first dashboard frame.
    cx.notify();
    if (this.showSettings) this.scheduleSettingsSync(cx);
  }

  draftConfig(fallback) {
    const base = this.configDraft ?? fallback ?? this.snapshot?.config ?? {};
    if (this.editorDirty && this.configEditor) {
      try {
        const parsed = JSON.parse(this.configEditor.value());
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return normalizeConfig(parsed);
      } catch {
        // Invalid JSON keeps the last valid draft alive during background refreshes.
      }
    }
    return normalizeConfig(base);
  }

  setEditorText(text) {
    this.configText = text;
    if (!this.configEditor) return;
    this.syncingEditor = true;
    try {
      this.configEditor.set_value(text);
    } finally {
      this.syncingEditor = false;
    }
  }

  syncRefreshInput(config) {
    if (this.refreshDirty || !this.refreshInput) return;
    this.syncingInputs = true;
    try {
      this.refreshInput.set_value(String(config.refreshSeconds));
    } finally {
      this.syncingInputs = false;
    }
  }

  ensureSourceInputs(config = normalizeConfig(this.snapshot?.config ?? {})) {
    const next = new Map();
    const sources = config.sources ?? [];
    for (let index = 0; index < sources.length; index += 1) {
      const source = sources[index] ?? {};
      const key = sourceKey(source, index);
      let state = this.sourceInputs.get(key);
      if (!state) {
        state = InputState.new({ value: rootsText(source), placeholder: "~/.harness/sessions" });
        state.on("change", () => {
          if (this.syncingInputs) return;
          this.rootsDirty = true;
          this.configDirty = true;
          this.saveMessage = null;
        });
        state.on("blur", (_event, notifyCx) => notifyCx.notify());
        state.on("submit", (_event, submitCx) => this.saveConfig(submitCx));
      }
      next.set(key, state);
    }
    for (const [key, state] of this.sourceInputs) {
      if (next.has(key)) continue;
      try { state.release(); } catch { /* already released */ }
    }
    this.sourceInputs = next;
  }

  syncSourceInputs(config) {
    if (this.rootsDirty) return;
    this.syncingInputs = true;
    try {
      const sources = config.sources ?? [];
      for (let index = 0; index < sources.length; index += 1) {
        const source = sources[index] ?? {};
        const state = this.sourceInputs.get(sourceKey(source, index));
        if (state) state.set_value(rootsText(source));
      }
    } finally {
      this.syncingInputs = false;
    }
  }

  applyEditorDraft() {
    if (!this.editorDirty) return;
    try {
      const parsed = JSON.parse(this.configEditor.value());
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      this.configDraft = parsed;
      const config = normalizeConfig(parsed);
      this.ensureSourceInputs(config);
      this.syncSourceInputs(config);
      this.syncRefreshInput(config);
    } catch {
      // Saving reports the parse error; keep the editor text untouched.
    }
  }

  updateDraft(mutator) {
    let base = this.configDraft;
    if (this.editorDirty) {
      try {
        const parsed = JSON.parse(this.configEditor.value());
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) base = parsed;
      } catch {
        // Keep the last valid draft when the editor is mid-edit or invalid.
      }
    }
    this.configDraft = deepClone(base ?? normalizeConfig(this.snapshot?.config ?? {}));
    mutator(this.configDraft);
    this.configDirty = true;
    this.editorDirty = false;
    this.saveMessage = null;
    this.setEditorText(prettyJson(this.configDraft));
    const config = normalizeConfig(this.configDraft);
    this.ensureSourceInputs(config);
    this.syncSourceInputs(config);
    this.syncRefreshInput(config);
  }

  buildConfigForSave() {
    let config;
    if (this.editorDirty) {
      let parsed;
      try {
        parsed = JSON.parse(this.configEditor.value());
      } catch (error) {
        throw new Error(`配置的 JSON 格式无效：${sanitizeError(error)}`, { cause: error });
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("配置必须是 JSON 对象。");
      }
      config = parsed;
    } else {
      config = deepClone(this.configDraft ?? normalizeConfig(this.snapshot?.config ?? {}));
    }

    if (!Array.isArray(config.sources)) config.sources = [];
    if (this.rootsDirty || !this.editorDirty) {
      for (let index = 0; index < config.sources.length; index += 1) {
        const source = config.sources[index];
        if (!source || typeof source !== "object") continue;
        const state = this.sourceInputs.get(sourceKey(source, index));
        if (state) source.roots = splitRoots(state.value());
      }
    }

    if (this.refreshDirty || !this.editorDirty) {
      const current = this.refreshInput ? Number(this.refreshInput.value()) : Number(config.refreshSeconds);
      if (Number.isFinite(current)) config.refreshSeconds = clampRefreshSeconds(current);
    }
    config.refreshSeconds = clampRefreshSeconds(config.refreshSeconds);
    if (config.includeCache === undefined) config.includeCache = true;
    return config;
  }

  draftSignature() {
    return JSON.stringify({
      draft: this.configDraft,
      editor: this.configEditor?.value() ?? this.configText,
      roots: Array.from(this.sourceInputs ?? [], ([key, input]) => [key, input.value()]),
      refresh: this.refreshInput?.value(),
    });
  }

  saveConfig(cx) {
    if (this.closed || !this.runtimeReady) return;
    if (this.runtimeError) {
      this.saveError = this.runtimeError;
      cx.notify();
      return;
    }
    if (this.busy()) return;
    let config;
    try {
      config = this.buildConfigForSave();
    } catch (error) {
      this.saveError = sanitizeError(error);
      this.saveMessage = null;
      cx.notify();
      return;
    }
    const generation = (this.activityGeneration ?? 0) + 1;
    this.activityGeneration = generation;
    const draftSignature = this.draftSignature();
    this.saving = true;
    this.saveError = null;
    this.saveMessage = null;
    cx.notify();
    this.armWatchdog("save", cx);
    const presenter = this.presenterPath();
    const store = this.storePath();
    const options = this.dashboardOptions();
    this.activityTask = cx.spawn(async (saveCx) => {
      let payload = null;
      let failure = null;
      try {
        const result = await exec(this.nodeBinary, [
          presenter,
          "configure",
          "--store",
          store,
          "--home",
          home(),
          "--config",
          JSON.stringify(config),
          "--options",
          JSON.stringify(options),
        ]);
        if (result.code !== 0) throw new Error(resultError(result));
        payload = parseSnapshot(result.stdout);
      } catch (error) {
        failure = error;
      } finally {
        if (generation === this.activityGeneration) {
          this.activityTask = null;
          this.saving = false;
          this.cancelWatchdog("save");
          if (failure) this.saveError = sanitizeError(failure);
          saveCx.notify();
        }
      }
      if (!payload || generation !== this.activityGeneration) return;
      const draftUnchanged = this.draftSignature() === draftSignature;
      if (draftUnchanged) {
        this.configDirty = false;
        this.editorDirty = false;
        this.rootsDirty = false;
        this.refreshDirty = false;
      } else {
        this.configDirty = true;
      }
      this.error = null;
      this.saveError = null;
      try {
        this.applySnapshot(payload, saveCx);
        this.saveMessage = draftUnchanged ? "配置已保存。" : "已保存；保存期间的新修改尚未保存。";
      } catch (error) {
        this.saveError = sanitizeError(error);
      }
      saveCx.notify();
    });
  }

  resetConfigDraft(cx) {
    if (!this.snapshot) return;
    const config = normalizeConfig(this.snapshot.config);
    this.configDirty = false;
    this.editorDirty = false;
    this.rootsDirty = false;
    this.refreshDirty = false;
    this.configDraft = deepClone(config);
    this.setEditorText(prettyJson(this.configDraft));
    this.ensureSourceInputs(config);
    this.syncSourceInputs(config);
    this.syncRefreshInput(config);
    this.saveError = null;
    this.saveMessage = "已恢复为上次保存的配置。";
    cx.notify();
  }

  formatConfigEditor(cx) {
    try {
      const parsed = JSON.parse(this.configEditor.value());
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("配置必须是 JSON 对象。");
      }
      this.configDraft = parsed;
      this.editorDirty = true;
      this.configDirty = true;
      this.setEditorText(prettyJson(parsed));
      this.applyEditorDraft();
      this.saveError = null;
      this.saveMessage = "格式已整理。";
    } catch (error) {
      this.saveError = sanitizeError(error);
      this.saveMessage = null;
    }
    cx.notify();
  }

  openSettings(cx) {
    this.showSettings = true;
    this.syncSettingsControls();
    cx.notify();
  }

  setPeriod(period, cx) {
    this.period = period;
    this.requestPage = 1;
    const today = todayKey();
    const config = normalizeConfig(this.snapshot?.config ?? {});
    if (period === "year") {
      const years = this.years?.length ? this.years : [Number(today.slice(0, 4))];
      if (!years.includes(this.year)) this.year = years[0] ?? Number(today.slice(0, 4));
    }
    this.selectedDay = periodRange(period, { today, weekStartsOn: config.weekStartsOn, year: this.year }).end;
    this.scheduleDashboard(cx, { force: true });
  }

  setYear(delta, cx) {
    this.requestPage = 1;
    const today = todayKey();
    const years = this.years?.length ? this.years : [Number(today.slice(0, 4))];
    const current = Math.max(0, years.indexOf(this.year));
    const next = Math.min(years.length - 1, Math.max(0, current + delta));
    this.year = years[next] ?? Number(today.slice(0, 4));
    const config = normalizeConfig(this.snapshot?.config ?? {});
    this.selectedDay = periodRange("year", { today, weekStartsOn: config.weekStartsOn, year: this.year }).end;
    this.scheduleDashboard(cx, { force: true });
  }

  render(_cx) {
    const c = tokens(theme());
    const width = this.width || 960;
    const padding = width < 620 ? G.md : width < 900 ? G.lg : G.xl;
    const content = [];
    if (this.error && this.snapshot) content.push(this.errorBanner(c));
    if (this.dashboardError && this.snapshot) content.push(this.dashboardErrorBanner(c));
    if (!this.snapshot) content.push(this.initialState(c));
    else if (this.showSettings) content.push(this.settingsView(c));
    else content.push(this.dashboardView(c));

    return v_flex().id("insights-frame").size_full().min_h(0).rounded(R.panel).overflow_hidden().bg(c.background)
      .on_size_change((size, sizeCx) => {
        const changed = Math.abs((this.width || 0) - size.width) >= 1;
        this.width = size.width;
        this.height = size.height;
        if (changed) sizeCx.notify();
      })
      .child(h_flex().w_full().flex_none().justify_center().px(padding).py(16)
        .child(div().w_full().max_w(this.showSettings ? 960 : 1480).child(this.header(c))))
      .child(v_flex().id("insights-page").flex_1().min_h(0).text_color(c.text).overflow_y_scrollbar()
        .child(h_flex().w_full().justify_center().px(padding).pb(24)
          .child(v_flex().w_full().max_w(this.showSettings ? 960 : 1480).gap(24).children(content))));
  }

  header(c) {
    const updated = this.snapshot ? formatTimestamp(this.snapshot.lastScanAt || this.snapshot.generatedAt) : "";
    const preparing = !this.dashboard && (this.dashboardPending || this.dashboardQueued);
    const status = this.loading ? "正在刷新…"
      : this.saving ? "正在保存…"
        : preparing ? "正在计算…"
          : this.error ? (this.snapshot ? "正在显示上次结果" : "暂不可用")
            : this.dashboardError ? "看板生成失败"
              : updated ? `更新于 ${updated}` : "";
    const statusError = Boolean(this.error || this.dashboardError);
    return h_flex().w_full().flex_wrap().gap(G.md).items_center().justify_between()
      .child(h_flex().flex_wrap().gap(G.lg).items_center()
        .child(pageTitle(this.showSettings ? "设置" : "用量统计", c))
        .when(!this.showSettings && Boolean(this.snapshot), (el) => el.child(segmented("ins-usage-view", [
          { key: "overview", label: "概览" }, { key: "requests", label: "请求明细" },
        ], this.activeView, (value, cx) => this.selectUsageView(value, cx), c))))
      .child(h_flex().flex_wrap().gap(G.sm).items_center()
        .when(Boolean(status), (el) => el.child(div().text_size(T.small)
          .text_color(statusError ? c.destructive : c.dim).child(status)))
        .child(button("insights-refresh", "↻ 刷新", (_event, clickCx) => this.refresh(clickCx), c, {
          disabled: this.busy(),
          variant: "outline",
        }))
        .when(Boolean(this.snapshot), (el) => el.child(button(
          "insights-settings",
          this.showSettings ? "统计看板" : "设置",
          (_event, clickCx) => {
            if (this.showSettings) {
              this.showSettings = false;
              clickCx.notify();
            } else {
              this.openSettings(clickCx);
            }
          },
          c,
          { variant: "outline" },
        ))));
  }

  errorBanner(c) {
    return notice(c, {
      title: "用量刷新失败",
      body: this.error,
      action: button("insights-retry", "重试", (_event, clickCx) => this.refresh(clickCx), c, {
        disabled: this.busy(),
        variant: "outline",
      }),
    });
  }

  initialState(c) {
    const loading = this.loading || !this.runtimeReady;
    const progress = this.scanProgress;
    const total = Number(progress?.total) || 0;
    const processed = Number(progress?.processed) || 0;
    const file = typeof progress?.file === "string" ? progress.file : "";
    return stateCard(c, {
      tone: loading ? c.accent : c.destructive,
      title: loading ? "正在读取本地用量" : "用量采集程序尚未就绪",
      body: loading
        ? (total > 0 ? `已扫描 ${formatInt(processed)} / ${formatInt(total)} 个文件` : null)
        : (this.error || "采集程序尚未返回结果。"),
      detail: loading && file ? file : null,
      action: loading || this.busy() ? null : button("insights-initial-retry", "重试", (_event, clickCx) => this.refresh(clickCx), c, {
        variant: "primary",
      }),
    });
  }

  dashboardErrorBanner(c) {
    return notice(c, {
      title: "看板生成失败",
      body: this.dashboardError,
      action: button("insights-dashboard-retry", "重试", (_event, clickCx) => {
        this.scheduleDashboard(clickCx, { force: true });
        clickCx.notify();
      }, c, { disabled: Boolean(this.dashboardPending), variant: "outline" }),
    });
  }

  dashboardView(c) {
    const derived = this.dashboard;
    if (!derived) {
      const retry = (id, primary) => button(id, "重试", (_event, clickCx) => {
        this.scheduleDashboard(clickCx, { force: true });
        clickCx.notify();
      }, c, { disabled: Boolean(this.dashboardPending), variant: primary ? "primary" : "outline" });
      if (this.dashboardError) {
        return stateCard(c, {
          tone: c.destructive,
          title: "用量统计生成失败",
          body: this.dashboardError,
          action: retry("insights-prepare-retry", true),
        });
      }
      return stateCard(c, {
        tone: c.accent,
        title: "正在生成用量统计",
        action: retry("insights-prepare-retry", false),
      });
    }
    const { config, rowCount, range, lifetime, peak, streaks, heatmap, leaders, selectedDay, selectedTotals, selectedTop, years } = derived;

    const page = derived.requestPage;
    const controls = this.usageControls(c, derived);
    const fees = costsSummary(derived.costs, page, c);
    if (this.activeView === "requests") {
      return v_flex().w_full().min_w(0).gap(24).child(controls).child(fees)
        .child(requestsTable(this, page, c));
    }

    const modelPanels = (this.width || 960) >= 1100 ? h_flex().items_start() : v_flex();
    if (derived.modelSeries?.weeks?.length) modelPanels.child(div().flex_1().w_full().min_w(0).child(this.modelChartCard(c, derived.modelSeries)));
    modelPanels.child(div().flex_1().w_full().min_w(0).child(this.leaderboardCard(c, leaders, range)));
    return v_flex().w_full().gap(24)
      .child(controls)
      .child(fees)
      .when(rowCount === 0, (el) => el.child(this.emptyNotice(c, config)))
      .child(h_flex().w_full().flex_wrap().gap(20).items_end().justify_between().pt(8)
        .child(cardHeader("模型分析", null, c).pb(8))
        .child(this.filtersBar(c, config, range, derived.facets, years).w_auto()))
      .child(modelPanels.w_full().gap(G.lg))
      .child(this.heatmapCard(c, config, heatmap, selectedDay))
      .child(this.tokenDetailCard(c, heatmap, selectedDay, derived.today, selectedTotals, selectedTop, lifetime, derived.lifetimeTop))
      .child(this.sectionHeader("累计统计 · 全部时间", c))
      .child(this.metricStrip(c, lifetime, peak, streaks));
  }

  selectUsageView(value, cx) {
    this.activeView = value === "overview" ? "overview" : "requests";
    localStorage.setItem("usage-view", this.activeView);
    this.showSettings = false;
    this.openFilter = null;
    this.scheduleDashboard(cx, { force: true });
    cx.notify();
  }

  setRequestPage(value, cx) {
    const page = this.dashboard?.requestPage;
    const maximum = Math.max(1, Number(page?.totalPages) || Math.ceil((Number(page?.total) || 0) / this.requestPageSize));
    this.requestPage = Math.max(1, Math.min(maximum, Math.round(Number(value) || 1)));
    this.scheduleDashboard(cx, { force: true });
    cx.notify();
  }

  usageControls(c, derived) {
    const years = derived.years ?? [Number(todayKey().slice(0, 4))];
    const page = derived.requestPage;
    const facets = page?.facets ?? {};
    const agentValues = facets.agents ?? page?.agents ?? [];
    const modelValues = facets.models ?? page?.models ?? [];
    const filtersActive = this.requestAgent !== "all" || this.requestModel !== "all";
    return h_flex().w_full().flex_wrap().gap_x(20).gap_y(16).items_end()
      .child(v_flex().gap(8)
        .child(div().pl(1).text_size(T.small).line_height("18px").text_color(c.mutedForeground).child("时间范围"))
        .child(segmented("ins-usage-period", [
        { key: "week", label: "本周" }, { key: "month", label: "本月" },
        { key: "year", label: "年度" }, { key: "all", label: "全部" },
      ], this.period, (key, cx) => this.setPeriod(key, cx), c)))
      .when(this.period === "year", (el) => el.child(h_flex().gap(G.xs).items_center()
        .child(iconButton("ins-usage-year-older", "‹", "上一年", (_event, cx) => { this.setYear(1, cx); cx.notify(); }, c))
        .child(div().min_w(36).text_center().text_size(T.body).font_medium().text_color(c.text).child(String(this.year)))
        .child(iconButton("ins-usage-year-newer", "›", "下一年", (_event, cx) => { this.setYear(-1, cx); cx.notify(); }, c, {
          color: this.year >= years[0] ? c.dim : c.mutedForeground,
        }))))
      .when(this.activeView === "requests", (el) => el
        .child(requestFilter(this, "agent", "Agent", agentValues, c))
        .child(requestFilter(this, "model", "请求模型", modelValues, c))
        .when(filtersActive, (box) => box.child(button("ins-request-clear", "清除筛选", (_event, cx) => {
          this.requestAgent = "all"; this.requestModel = "all"; this.requestPage = 1;
          this.scheduleDashboard(cx, { force: true }); cx.notify();
        }, c, { variant: "ghost" }))))
      .child(div().flex_1())
      .child(div().pb(8).text_size(T.small).line_height("20px").text_color(c.mutedForeground).child(derived.range?.label ?? "全部时间"));
  }

  sectionHeader(title, c) {
    return h_flex().w_full().items_center().gap(G.md).pt(G.sm)
      .child(div().text_size(T.card).font_semibold().text_color(c.text).child(title));
  }

  filtersBar(c, config, _range, facets, years) {
    const active = Object.values(this.filters).some((value) => value !== "all");

    // The page-level time range also controls this chart. These two menus
    // only refine the model chart, independently of the lifetime heatmap.
    return h_flex().w_full().flex_wrap().gap(16).items_end()
      .child(this.filterMenu("provider", "服务商", this.filters.provider, facets.provider, config, c, (value, pickCx) => { this.filters.provider = value; this.scheduleDashboard(pickCx, { force: true }); }))
      .child(this.filterMenu("model", "模型", this.filters.model, facets.model, config, c, (value, pickCx) => { this.filters.model = value; this.scheduleDashboard(pickCx, { force: true }); }))
      .when(active, (el) => el.child(button("ins-clear-filters", "清除筛选", (_event, clickCx) => {
        this.filters = { provider: "all", model: "all" };
        this.scheduleDashboard(clickCx, { force: true });
        clickCx.notify();
      }, c, { variant: "ghost" })));
  }

  filterMenu(field, label, value, facet, config, c, onPick) {
    const selected = selectedFacet(facet, value, field, config);
    const id = `ins-${field}-filter`;
    const active = value !== "all";
    const trigger = Button.new(`ins-${field}-trigger`).h(H.control).w(field === "model" ? 224 : 168).px(12).gap(12).items_center().rounded(R.control)
      .border_1().border_color(active ? c.ring : c.border).bg(c.card).cursor_pointer()
      .hover((style) => style.bg(c.subtle))
      .focus((style) => style.border_color(c.ring))
      .accessibility_label(`${label}: ${selected.label}`)
      .child(div().flex_1().min_w(0).truncate().text_size(T.body).line_height("20px").text_color(c.text).child(selected.label))
      .child(div().w(12).flex_none().text_center().text_size(12).line_height("20px").text_color(c.dim).child("⌄"));

    const menu = Popover.new(id).trigger(trigger)
      .open(this.openFilter === id)
      .on_open_change((open, changeCx) => {
        this.openFilter = open ? id : null;
        // Menu data is prepared in this event, never in the 50 ms render pass.
        this.openOptions = open ? buildFacetOptions(field, facet, config) : null;
        changeCx.notify();
      });
    // Closed menus build no option elements; only the trigger is rendered.
    if (this.openFilter === id && this.openOptions) {
      menu.content(this.filterMenuContent(field, value, this.openOptions, c, onPick));
    }
    return v_flex().flex_none().gap(8)
      .child(div().pl(1).text_size(T.small).line_height("18px").text_color(c.mutedForeground).child(label))
      .child(menu);
  }

  filterMenuContent(field, value, options, c, onPick) {
    return v_flex().w(320).max_h(360).overflow_y_scrollbar().p(6).gap(2).rounded(R.card)
      .bg(c.popover).border_1().border_color(c.border)
      .children(options.options.map((option, index) => {
        const selected = option.value === value;
        return Button.new(`ins-${field}-option-${index}`)
          .min_h(option.detail ? 54 : 36).px(10).gap(12).items_center().rounded(R.control)
          .selected(selected)
          .set_position(index + 1, options.options.length)
          .cursor_pointer()
          .when(selected, (el) => el.bg(c.selected))
          .when(!selected, (el) => el.hover((style) => style.bg(c.subtle)))
          .focus((style) => style.bg(c.selected))
          .accessibility_label(option.label)
          .on_click((_event, clickCx) => {
            this.openFilter = null;
            this.openOptions = null;
            onPick(option.value, clickCx);
            clickCx.notify();
          })
          .child(div().w(12).text_size(10).text_color(c.accent).child(selected ? "✓" : ""))
          .child(v_flex().flex_1().min_w(0).gap(1)
            .child(div().text_size(T.body).text_color(c.text).truncate().tooltip(option.tooltip || option.label).child(option.label))
            .when(Boolean(option.detail), (el) => el.child(div().text_size(T.label).text_color(c.dim).truncate().child(option.detail))))
          .child(div().text_size(T.label).text_color(c.dim).child(option.meta ?? ""));
      }))
      .when(options.truncated, (el) => el.child(div().p(G.sm).text_size(T.label).text_color(c.dim)
        .child(`按用量显示前 ${MAX_FACET_OPTIONS} 项。`)));
  }

  emptyNotice(c, config) {
    const roots = [];
    for (const source of config.sources ?? []) {
      if (source?.enabled === false) continue;
      for (const root of source.roots ?? []) roots.push(root);
    }
    return card(c).gap(G.sm)
      .child(h_flex().items_center().gap(G.sm)
        .child(div().size(8).flex_none().rounded_full().bg(c.accent))
        .child(div().text_size(T.card).font_semibold().text_color(c.text).child("尚未发现用量记录")))
      .child(bodyText("请启用数据来源并检查路径。仅统计本地会话用量，不保存提示词或代码。", c))
      .when(roots.length > 0, (el) => el.child(v_flex().gap(2)
        .children(roots.slice(0, 4).map((root) => mutedText(root, c)))))
      .child(h_flex().pt(G.xs)
        .child(button("ins-empty-settings", "打开设置", (_event, clickCx) => this.openSettings(clickCx), c, { variant: "outline" })));
  }

  metricStrip(c, lifetime, peak, streaks) {
    const stats = [
      {
        label: "累计 Token",
        value: formatCompact(lifetime.total),
        note: `${formatInt(lifetime.sessions)} 次会话 · 全部时间`,
        tooltip: `${formatInt(lifetime.total)} Token${lifetime.reasoning ? ` · ${formatInt(lifetime.reasoning)} 推理 Token（已含在输出中）` : ""}`,
      },
      {
        label: "单日最高",
        value: peak.day ? formatCompact(peak.tokens) : "—",
        note: peak.day ? dayLabel(peak.day) : "暂无活动",
        tooltip: peak.day ? `${formatInt(peak.tokens)} Token · ${dayLabel(peak.day)}` : "暂无活动",
      },
      {
        label: "最长任务",
        value: formatDuration(lifetime.longestTaskMs),
        note: lifetime.longestTaskMs > 0 ? "已记录时长" : "未记录",
        tooltip: lifetime.longestTaskMs > 0 ? `${formatInt(lifetime.longestTaskMs)} 毫秒（已记录）` : "任务时长未知",
      },
      {
        label: "最长连续使用",
        value: `${formatInt(streaks.longest)} 天`,
        tooltip: `${formatInt(streaks.longest)} 天连续使用`,
      },
      {
        label: "当前连续使用",
        value: `${formatInt(streaks.current)} 天`,
        color: c.text,
        tooltip: `${formatInt(streaks.current)} 天持续使用`,
      },
    ];

    // One summary band with hairline dividers instead of five separate boxes.
    const stat = (item, divided) => v_flex().flex_1().min_w(0).gap(2)
      .child(metaLabel(item.label, c))
      .child(div().text_size(18).font_semibold().text_color(item.color ?? c.text).truncate()
        .tooltip(item.tooltip).child(item.value))
      .when(Boolean(item.note), (el) => el.child(mutedText(item.note, c)));
    const row = (items) => h_flex().w_full().items_start().gap(G.lg)
      .children(items.map((item, index) => stat(item, index > 0)));

    if ((this.width || 960) >= 860) return card(c).child(row(stats));
    const perRow = (this.width || 960) >= 560 ? 3 : 2;
    const band = card(c);
    for (let start = 0; start < stats.length; start += perRow) {
      band.child(row(stats.slice(start, start + perRow)));
    }
    return band;
  }

  heatmapCard(c, config, heatmap, selectedDay) {
    const dark = isDarkTheme(c);
    const palette = PALETTES.includes(config.palette) ? config.palette : "blue";
    const metrics = heatmapMetrics(this.width, heatmap.weeks.length);
    const cell = metrics.cell;
    const weekWidth = metrics.weekWidth;
    const contentWidth = metrics.contentWidth;
    // A one-week leading partial month is narrow, so keep the span but omit text that would wrap.
    const months = heatmap.months.map((month) => div().w(month.span * weekWidth).flex_none()
      .text_size(11).text_color(c.dim)
      .when(month.span >= 2, (el) => el.whitespace_nowrap().child(month.label)));
    const weekLabels = weekdayLabels(heatmap.weekStartsOn).map((label) => div().h(cell).text_size(11)
      .text_color(c.dim).child(label));

    const cellElement = (dayCell) => {
      const color = dayCell.future
        ? c.muted
        : dayCell.level > 0 ? heatColor(dayCell.level, palette, dark) : c.muted;
      return div().id(`ins-cell-${dayCell.date}`).size(cell).flex_none().rounded(2).bg(color)
        .opacity(dayCell.future ? 0.3 : 1)
        .when(!dayCell.future, (el) => el.cursor_pointer()
          .hover((style) => style.opacity(0.8))
          .on_click((_event, clickCx) => {
            this.selectedDay = dayCell.date;
            this.scheduleDashboard(clickCx, { force: true });
            clickCx.notify();
          })
          .tooltip(dayCell.tooltip ?? ""))
        .when(dayCell.date === selectedDay, (el) => el.border_1().border_color(c.ring));
    };
    const weekElements = heatmap.weeks.map((week) => v_flex().gap(CELL_GAP).children(week.days.map(cellElement)));
    const grid = v_flex().w(contentWidth).flex_none().gap(G.xs)
      .child(h_flex().h(15).children([
        div().w(DAY_LABEL_WIDTH).flex_none(),
        ...months,
      ]))
      .child(h_flex().gap(CELL_GAP).items_start()
        .child(v_flex().w(DAY_LABEL_WIDTH).flex_none().gap(CELL_GAP).children(weekLabels))
        .child(h_flex().gap(CELL_GAP).children(weekElements)));

    const legend = h_flex().w_full().flex_wrap().gap(G.sm).items_center().justify_end()
      .child(mutedText("少", c))
      .children([0, 1, 2, 3, 4].map((level) => div().size(10).rounded(2)
        .bg(level === 0 ? c.muted : heatColor(level, palette, dark))))
      .child(mutedText("多", c))
      .child(mutedText(`${formatCompact(heatmap.windowTotal)} Token（图中范围）`, c));

    return card(c).gap(G.md)
      .child(h_flex().w_full().flex_wrap().gap(G.sm).items_center().justify_between()
        .child(cardHeader("历史活动", "最近一年", c))
        .child(segmented("ins-heat-mode", [
          { key: "daily", label: "按天" },
          { key: "weekly", label: "按周" },
          { key: "cumulative", label: "累计" },
        ], this.heatmapMode, (key, changeCx) => {
          this.heatmapMode = key;
          this.scheduleDashboard(changeCx, { force: true });
        }, c)))
      .child(v_flex().w_full().overflow_x_scrollbar()
        .child(h_flex().w_full().child(grid)))
      .child(legend);
  }

  tokenDetailCard(c, heatmap, selectedDay, today, selectedTotals, selectedTop, lifetime, lifetimeTop) {
    const hitTooltip = (totals) => `输入共 ${formatInt(totals.input + totals.cacheRead)} Token，其中缓存读取 ${formatInt(totals.cacheRead)} Token`;
    const column = (label, totals, top) => v_flex().flex_1().min_w(0).gap(G.md)
      .child(cardHeader(label, null, c))
      .child(h_flex().w_full().flex_wrap().gap_x(G.lg).gap_y(G.md).items_start()
        .child(statCell("输入", formatCompact(totals.input), c, { tooltip: `${formatInt(totals.input)} 输入 Token` }))
        .child(statCell("输出", formatCompact(totals.output), c, {
          tooltip: `${formatInt(totals.output)} 输出 Token · 其中推理 ${formatInt(totals.reasoning)}`,
        }))
        .child(statCell("缓存命中率", formatHitRate(totals.input, totals.cacheRead), c, { tooltip: hitTooltip(totals) })))
      .child(h_flex().w_full().gap(8).items_center()
        .child(div().flex_none().text_size(T.small).text_color(c.mutedForeground).child("主要模型"))
        .child(div().flex_1().min_w(0).truncate().text_size(T.body).text_color(c.text)
          .tooltip(top ? `${top.name} · ${top.sublabel}` : "暂无模型用量").child(top?.name ?? "—")));

    const dayHeading = selectedDay === today ? "今天" : dayLabel(selectedDay, { weekday: true });
    return card(c)
      .child(((this.width || 960) >= 760 ? h_flex().items_start() : v_flex()).w_full().gap(G.xl)
        .child(column(dayHeading, selectedTotals, selectedTop))
        .child(column("全部时间", lifetime, lifetimeTop)));
  }

  modelChartCard(c, series) {
    const weeks = series.weeks;
    const maxTotal = series.maxTotal || 0;
    const colors = new Map(series.models.map((name, index) => [name, modelChartColor(name, index)]));

    const bar = (week) => v_flex().flex_1().min_w(0).h(CHART_HEIGHT).justify_end()
      .tooltip(`${dayLabel(week.start)} 所在周 · ${formatCompact(week.total)} Token`)
      .when(week.total > 0 && maxTotal > 0, (el) => el.child(
        v_flex().w_full().flex_none().h(Math.max(2, Math.round((week.total / maxTotal) * CHART_HEIGHT)))
          .children(week.segments.map((segment) => div().w_full().flex_grow(Math.max(0.001, segment.tokens))
            .bg(colors.get(segment.name) ?? OTHER_CHART_COLOR)
            .tooltip(`${segment.name === "Other" ? "其他" : segment.name} · ${formatCompact(segment.tokens)} Token`))),
      ));

    const axisLabel = (text) => div().text_size(11).text_color(c.dim).child(text);
    const labelStep = Math.ceil(weeks.length / 6);
    const legend = h_flex().w_full().flex_wrap().gap_x(G.lg).gap_y(G.xs).items_center()
      .children(series.models.map((name) => h_flex().items_center().gap(G.xs)
        .child(div().size(8).flex_none().rounded_full().bg(colors.get(name) ?? OTHER_CHART_COLOR))
        .child(div().max_w(180).truncate().text_size(T.label).text_color(c.mutedForeground).tooltip(name === "Other" ? "其他" : name).child(name === "Other" ? "其他" : name))));

    return card(c).gap(G.md)
      .when((this.width || 960) >= 1100, el => el.h(376))
      .child(cardHeader(
        "模型趋势",
        `近 ${weeks.length} 周 · ${formatCompact(series.windowTotal)} Token · ${series.includeCache ? "含缓存" : "不含缓存"}`,
        c,
      ))
      .when(maxTotal === 0, (el) => el.child(div().py(G.lg).text_size(T.body).text_color(c.mutedForeground)
        .child("此时间范围内暂无模型用量。")))
      .when(maxTotal > 0, (el) => el.child(v_flex().w_full().gap(G.sm)
        .child(h_flex().w_full().gap(G.sm).items_end()
          .child(v_flex().w(46).flex_none().h(CHART_HEIGHT).justify_between().children([
            axisLabel(formatCompact(maxTotal)),
            axisLabel(formatCompact(maxTotal / 2)),
            axisLabel("0"),
          ]))
          .child(h_flex().flex_1().min_w(0).gap(CELL_GAP).items_end().children(weeks.map(bar))))
        .child(h_flex().w_full().gap(G.sm)
          .child(div().w(46).flex_none())
          .child(h_flex().flex_1().min_w(0).justify_between().children(weeks.filter((_week, index) => index % labelStep === 0)
            .map(week => axisLabel(dayLabel(week.start, { year: false })).flex_none()))))
        .child(legend)));
  }

  leaderboardCard(c, leaders, range) {
    const entries = leaders.entries;

    const changeLabel = (entry) => {
      if (entry.change.kind === "none") return "—";
      if (entry.change.kind === "up") return `↑${entry.change.label}`;
      if (entry.change.kind === "down") return `↓${entry.change.label}`;
      return entry.change.label;
    };

    const row = (entry, last) => {
      const logo = usageLogo(entry.name, entry.provider);
      return h_flex().w_full().flex_none().min_h(48).items_center().gap(G.sm).py(G.sm)
        .when(!last, (el) => el.border_b(1).border_color(c.border))
        .child(div().w(20).text_size(T.body).text_color(c.dim).child(`${entry.rank}.`))
        .child(h_flex().size(26).flex_none().rounded(R.control).bg(c.secondary).border_1().border_color(c.border)
          .items_center().justify_center()
          .child(logo
            ? svg(`mods/insights/logos/${logo}`).size(14).text_color(c.mutedForeground)
            : div().text_size(11).font_semibold().text_color(c.mutedForeground).child(initials(entry.name, 1))))
        .child(v_flex().flex_1().min_w(0).gap(1)
          .child(div().text_size(12).font_medium().text_color(c.text).truncate().tooltip(entry.name).child(entry.name))
          .child(div().text_size(10).text_color(c.dim).truncate().child(`来自 ${entry.sublabel}`)))
        .child(v_flex().items_end().gap(1)
          .child(div().text_size(12).font_semibold().text_color(c.text).tooltip(`${formatInt(entry.tokens)} Token`)
            .child(`${formatCompact(entry.tokens)} Token`))
          .child(div().text_size(T.small).text_color(changeColor(entry.change, c))
            .tooltip(entry.change.kind === "none" ? "无上期可比较" : `上期 ${formatInt(entry.previous ?? 0)} Token`)
            .child(changeLabel(entry))));
    };

    const empty = v_flex().w_full().items_center().gap(G.sm).p(G.lg)
      .child(div().text_size(12).font_medium().text_color(c.text).child("此时间段暂无用量"))
      .child(bodyText("可查看全部时间、切换年份或清除筛选。", c))
      .child(button("ins-leaders-all", "查看全部时间", (_event, clickCx) => {
        this.setPeriod("all", clickCx);
        clickCx.notify();
      }, c, { variant: "outline" }));

    return card(c).gap(G.md)
      .when((this.width || 960) >= 1100, el => el.h(376))
      .child(cardHeader(
        "模型用量排行",
        `${range.label} · ${formatCompact(leaders.totalTokens)} Token · ${formatInt(leaders.totalSessions)} 次会话`,
        c,
      ))
      .when(entries.length === 0, (el) => el.child(empty))
      .when(entries.length > 0, (el) => el.child(v_flex().id("ins-model-ranking").w_full().min_h(0).flex_1().max_h(420).pr(12).overflow_y_scrollbar().mode("always").gap(0)
        .children(entries.map((entry, index) => row(entry, index === entries.length - 1)))))
      .when(leaders.totalGroups > entries.length, (el) => el.child(mutedText(
        `按用量显示前 ${entries.length} / ${leaders.totalGroups} 项。`, c)));
  }

  statusCard(c, snapshot, config) {
    const stats = snapshot.stats && typeof snapshot.stats === "object" ? snapshot.stats : null;
    const errors = stats && Number.isFinite(Number(stats.errors)) ? Number(stats.errors) : null;
    const warnings = Array.isArray(snapshot.warnings) ? snapshot.warnings.map(warningText).filter(Boolean) : [];
    const sources = config.sources ?? [];
    return card(c).gap(G.md)
      .child(h_flex().w_full().flex_wrap().gap(G.sm).items_center().justify_between()
        .child(cardHeader(
          "扫描状态",
          `数据生成 ${formatTimestamp(snapshot.generatedAt) || "未知"} · 最近扫描 ${formatTimestamp(snapshot.lastScanAt) || "未知"}`,
          c,
        ))
        .child(div().text_size(T.small).text_color(errors > 0 ? c.destructive : errors === 0 ? c.done : c.dim)
          .child(errors === null ? "暂无扫描统计" : errors > 0 ? `${formatInt(errors)} 个错误` : "扫描无错误")))
      // Status rows follow the same top-aligned contract if a note is added.
      .child(h_flex().w_full().flex_wrap().gap_x(G.lg).gap_y(G.md).items_start()
        .child(statCell("文件总数", statCount(stats?.files), c, { tooltip: stats?.files === undefined ? "暂无扫描统计" : `已索引 ${formatInt(stats.files)} 个文件` }))
        .child(statCell("已读取", statCount(stats?.filesRead), c, { tooltip: stats?.filesRead === undefined ? "暂无扫描统计" : `已读取 ${formatInt(stats.filesRead)} 个文件` }))
        .child(statCell("无变化", statCount(stats?.unchangedFiles), c, { tooltip: stats?.unchangedFiles === undefined ? "暂无扫描统计" : `${formatInt(stats.unchangedFiles)} 个文件无变化` }))
        .child(statCell("读取大小", statBytes(stats?.bytesRead), c, { tooltip: stats?.bytesRead === undefined ? "暂无扫描统计" : `已读取 ${formatInt(stats.bytesRead)} 字节` })))
      .child(v_flex().w_full().gap(G.xs)
        .children(sources.map((source, index) => {
          const entry = sourceStatEntry(snapshot, source);
          const status = entry?.status || (source?.enabled === false ? "disabled" : "enabled");
          const statsText = sourceStatsText(entry);
          return h_flex().w_full().gap(G.sm).items_center().py(2)
            .opacity(source?.enabled === false ? 0.55 : 1)
            .child(div().size(6).flex_none().rounded_full().bg(sourceStatusColor(status, c)))
            .child(v_flex().flex_1().min_w(0).gap(1)
              .child(div().text_size(T.body).text_color(c.text).child(source?.label || source?.adapter || `来源 ${index + 1}`))
              .child(div().text_size(T.label).text_color(c.dim).truncate()
                .child([(Array.isArray(source?.roots) ? source.roots.join(" · ") : ""), statsText].filter(Boolean).join(" · ") || "未设置数据路径")))
            .child(v_flex().items_end().gap(1)
              .child(div().text_size(11).text_color(sourceStatusColor(status, c)).child(sourceStatusLabel(status)))
              .child(div().text_size(11).text_color(c.dim).child(source?.adapter || "")));
        })))
      .when(sources.length === 0, (el) => el.child(mutedText("尚未配置数据来源。", c)))
      .child(v_flex().w_full().gap(G.xs)
        .child(metaLabel("提示", c))
        .when(warnings.length === 0, (el) => el.child(mutedText("无扫描提示。", c)))
        .children(warnings.slice(0, 6).map((warning) => h_flex().w_full().gap(G.sm).items_start()
          .child(div().text_size(10).text_color(c.destructive).child("!"))
          .child(div().flex_1().min_w(0).text_size(T.small).text_color(c.mutedForeground).child(warning))))
        .when(warnings.length > 6, (el) => el.child(mutedText(`另有 ${warnings.length - 6} 条提示`, c))));
  }

  settingsView(c) {
    if (!this.configEditor || !this.refreshInput) {
      return stateCard(c, {
        tone: c.accent,
        title: "正在载入设置",
      });
    }
    const config = normalizeConfig(this.configDraft ?? this.snapshot?.config ?? {});
    const textInput = (state) => controlInput(Input.new(state).w_full(), c);
    const refreshInput = controlInput(Input.new(this.refreshInput).w(110), c);

    const preferences = card(c).gap(18)
      .child(cardHeader("显示设置", "", c))
      .child(preferenceRow("热力图颜色", segmented("ins-palette", [
        { key: "blue", label: "蓝色" },
        { key: "green", label: "绿色" },
        { key: "purple", label: "紫色" },
      ], config.palette, (key) => this.updateDraft((draft) => { draft.palette = key; }), c), c))
      .child(preferenceRow("每周起始日", segmented("ins-week-start", [
        { key: "0", label: "周日" },
        { key: "1", label: "周一" },
      ], String(config.weekStartsOn), (key) => this.updateDraft((draft) => { draft.weekStartsOn = Number(key); }), c), c))
      .child(preferenceRow(
        "计入缓存 Token",
        toggleSwitch("ins-include-cache", config.includeCache, (checked) => this.updateDraft((draft) => { draft.includeCache = checked; }), c, {
          label: "计入缓存 Token",
        }),
        c,
      ))
      .child(preferenceRow(
        "刷新间隔",
        h_flex().gap(10).items_center().child(refreshInput).child(mutedText("秒", c).line_height("20px")),
        c,
      ));

    const sourceCards = (config.sources ?? []).map((source, index) => {
      const key = sourceKey(source, index);
      const state = this.sourceInputs.get(key);
      return v_flex().w_full().min_w(0).gap(10)
        .child(h_flex().w_full().gap(12).items_center()
          .child(fieldLabel(source?.label || source?.adapter || `来源 ${index + 1}`, c).flex_1().min_w(0).line_height("20px"))
          .child(toggleSwitch(`ins-source-${index}`, source?.enabled !== false, (checked) => this.updateDraft((draft) => {
            const target = (draft.sources ?? []).find((item, itemIndex) => sourceKey(item, itemIndex) === key);
            if (target) target.enabled = checked;
          }), c, { label: `${source?.label || source?.adapter || `来源 ${index + 1}`}：启用` })))
        .when(state, (el) => el.child(textInput(state)))
        .when(!state, (el) => el.child(mutedText(rootsText(source) || "未设置数据路径", c)));
    });

    const sources = card(c).gap(24)
      .child(cardHeader("数据来源", "", c))
      .when(sourceCards.length === 0, (el) => el.child(mutedText("尚无数据来源，可在下方 JSON 配置中添加。", c)))
      .children(sourceCards);

    const scan = this.statusCard(c, this.snapshot ?? {}, config);

    const json = card(c).gap(G.sm)
      .child(h_flex().w_full().flex_wrap().gap(G.sm).items_center().justify_between()
        .child(cardHeader("高级配置（JSON）", "", c))
        .child(h_flex().flex_wrap().gap(G.xs)
          .child(button("ins-config-format", "整理格式", (_event, clickCx) => this.formatConfigEditor(clickCx), c, { variant: "outline" }))
          .child(button("ins-config-reset", "还原修改", (_event, clickCx) => this.resetConfigDraft(clickCx), c, { variant: "ghost" }))))
      .child(Editor.new(this.configEditor).w_full().h(320).rounded(R.control).border_1().border_color(c.input))
      .child(h_flex().w_full().flex_wrap().gap(G.md).items_center().justify_between()
        .child(v_flex().flex_1().min_w(0).gap(2)
          .when(Boolean(this.saveError), (el) => el.child(div().text_size(T.body).text_color(c.destructive).child(this.saveError)))
          .when(Boolean(this.saveMessage), (el) => el.child(div().text_size(T.body).text_color(c.done).child(this.saveMessage))))
        .child(button("ins-config-save", this.saving ? "正在保存…" : "保存配置", (_event, clickCx) => this.saveConfig(clickCx), c, {
          disabled: this.busy(),
          variant: "primary",
        })));

    return v_flex().w_full().gap(24).children([preferences, sources, scan, json]);
  }
}
