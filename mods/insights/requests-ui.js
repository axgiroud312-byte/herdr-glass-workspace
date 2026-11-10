import { div } from "gpui-kit";
import { h_flex, v_flex, Button, Popover } from "gpui-base";
import { G, H, R, T, button, segmented } from "./ui.js";
import { formatInt, formatCompact } from "./analytics.js";
import { requestModel } from "./request-model.js";

const AGENTS = { codex: "Codex", claude: "Claude", pi: "Pi", opencode: "OpenCode", grok: "Grok", qwen: "Qwen" };
const COLUMNS = [
  ["时间", 116], ["Agent", 68], ["请求模型", 148], ["推理强度", 64],
  ["输入", 76, true], ["输出", 66, true], ["缓存写入", 74, true], ["缓存读取", 74, true],
  ["估算费用", 94, true], ["首字耗时", 68, true], ["总耗时", 68, true],
  ["速度 TPS", 78, true], ["状态", 68],
];
const TABLE_WIDTH = COLUMNS.reduce((sum, column) => sum + column[1], 0);

function number(value) { return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)) ? Number(value) : null; }
function integer(value) { const n = number(value); return n === null ? "—" : formatInt(n); }
function agentLabel(value) { return AGENTS[String(value).toLowerCase()] ?? value ?? "—"; }
function modelLabel(value) { return value === "unknown" || value === "__unknown__" ? "未记录模型" : value; }

export function formatMoney(value) {
  const n = number(value);
  if (n === null) return "—";
  if (n === 0) return "$0.00";
  if (n < 0.0001) return "<$0.0001";
  const [whole, fraction] = n.toFixed(n < 0.01 ? 4 : n < 1 ? 3 : 2).split(".");
  return `$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${fraction}`;
}

function duration(value) {
  const n = number(value);
  if (n === null || n < 0) return "—";
  if (n < 1000) return `${Math.round(n)} ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)} 秒`;
  return `${Math.floor(n / 60_000)}分${Math.round((n % 60_000) / 1000)}秒`;
}

function timestamp(value) {
  if (!value) return { text: "—", full: "记录中未提供时间" };
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return { text: "—", full: "记录中未提供有效时间" };
  const pad = (n) => String(n).padStart(2, "0");
  const text = `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return { text, full: `${date.getFullYear()}-${text}（本地时间）` };
}

function costDetails(row) {
  const cost = row.cost;
  if (!cost?.known || number(cost.usd) === null) return cost?.note || "没有足够的模型或定价信息，费用暂不可估算。";
  const model = cost.model || row.model || row.reportedModel;
  return [
    `${Number(cost.usd).toFixed(6)} USD · 按 API 定价估算`,
    model ? `定价模型：${model}` : null,
    cost.basis ? `依据：${cost.basis}` : null,
    cost.note,
    cost.checkedAt ? `价格核对：${cost.checkedAt}` : null,
    cost.sourceUrl,
  ].filter(Boolean).join("\n");
}

function statusLabel(row) {
  if (row.kind === "usage_event") return { text: "用量事件", kind: "mutedForeground" };
  const status = String(row.status || "unknown").toLowerCase();
  if (["success", "completed", "complete", "ok", "done"].includes(status)) return { text: "成功", kind: "done" };
  if (["error", "failed", "failure"].includes(status)) return { text: "失败", kind: "destructive" };
  if (["cancelled", "canceled", "aborted", "interrupted"].includes(status)) return { text: "已中止", kind: "mutedForeground" };
  if (["running", "pending", "in_progress", "working"].includes(status)) return { text: "进行中", kind: "accent" };
  return { text: "—", kind: "dim" };
}

function cell(value, index, c, options = {}) {
  const [, baseWidth, right] = COLUMNS[index];
  return div().flex_basis(baseWidth).min_w(baseWidth).flex_grow(baseWidth).flex_shrink(0).px(10).text_size(T.body).text_color(options.color ?? c.text)
    .when(options.strong, el => el.font_semibold())
    .when(right, (el) => el.text_right()).truncate().tooltip(options.tooltip ?? String(value)).child(value);
}

function requestRow(row, index, c) {
  const time = timestamp(row.timestamp ?? row.time);
  const usage = row.tokens === null ? {} : row.tokens ?? row;
  const model = requestModel(row);
  const state = statusLabel(row);
  const speed = number(row.speed ?? row.tokensPerSecond);
  const price = row.cost?.known && number(row.cost.usd) !== null ? `≈${formatMoney(row.cost.usd)}` : "—";
  const inferredDuration = /approx|estimated|inferred/.test(String(row.durationBasis ?? row.durationKind ?? ""));
  const durationText = duration(row.durationMs);
  const rowCell = (value, column, _colors, options = {}) => cell(value, column, c, { color: value === "—" ? c.dim : c.text, ...options });
  return h_flex().id(`ins-request-row-${index}`).w_full().min_w(TABLE_WIDTH).min_h(40).items_center().py(8)
    .bg(index % 2 ? c.canvas : c.card)
    .hover((style) => style.bg(c.subtle))
    .children([
      rowCell(time.text, 0, c, { tooltip: [time.full, row.basis].filter(Boolean).join("\n"), color: c.mutedForeground }),
      rowCell(agentLabel(row.agent ?? row.harness), 1, c),
      rowCell(model ?? "—", 2, c, { tooltip: model ?? "未记录模型", color: model ? c.text : c.dim }),
      rowCell(row.effort || "—", 3, c),
      rowCell(integer(usage.input), 4, c, { tooltip: "未缓存的输入 Token" }),
      rowCell(integer(usage.output), 5, c, { tooltip: "输出 Token，包含已报告的推理 Token" }),
      rowCell(integer(usage.cacheWrite), 6, c),
      rowCell(integer(usage.cacheRead), 7, c),
      rowCell(price, 8, c, { strong: row.cost?.known, color: row.cost?.known ? c.text : c.dim, tooltip: costDetails(row) }),
      rowCell(duration(row.firstTokenMs), 9, c, { tooltip: number(row.firstTokenMs) === null ? "来源没有记录首字耗时" : "来源记录的首字耗时" }),
      rowCell(inferredDuration && durationText !== "—" ? `≈${durationText}` : durationText, 10, c, { tooltip: row.durationNote || (number(row.durationMs) === null ? "没有可确认的单次请求耗时" : "单次请求耗时") }),
      rowCell(speed === null ? "—" : `${row.speedKind === "floor" ? "≥" : row.speedKind === "average" ? "≈" : ""}${speed.toFixed(1)}/秒`, 11, c, { tooltip: row.speedBasis || (speed === null ? "缺少可用于计算速度的请求计时" : "输出 Token / 秒") }),
      rowCell(state.text, 12, c, { color: c[state.kind], tooltip: row.kind === "usage_event" ? row.basis || "无法严格确认单次请求边界" : row.statusNote || (state.text === "—" ? "来源未记录请求结果" : state.text) }),
    ]);
}

export function requestFilter(view, field, label, values, c) {
  const selected = field === "agent" ? view.requestAgent : view.requestModel;
  const id = `ins-request-${field}`;
  const all = field === "agent" ? "全部 Agent" : "全部模型";
  const display = selected === "all" ? all : field === "agent" ? agentLabel(selected) : modelLabel(selected);
  const options = [...new Set((values ?? []).map((value) => typeof value === "string" ? value : value.value).filter(Boolean))];
  if (selected !== "all" && !options.includes(selected)) options.unshift(selected);
  const entries = ["all", ...options.filter((value) => value !== "all").slice(0, 250)];
  const trigger = Button.new(`${id}-trigger`).h(H.control).w(field === "model" ? 224 : 152).px(12).gap(12).items_center().rounded(R.control)
    .border_1().border_color(selected === "all" ? c.border : c.ring).bg(c.card).cursor_pointer()
    .hover((style) => style.bg(c.subtle)).accessibility_label(`${label}：${display}`)
    .child(div().flex_1().min_w(0).truncate().text_size(T.body).line_height("20px").text_color(c.text).child(display))
    .child(div().w(12).flex_none().text_center().text_size(12).line_height("20px").text_color(c.dim).child("⌄"));
  const menu = Popover.new(id).trigger(trigger).open(view.openFilter === id)
    .on_open_change((open, cx) => { view.openFilter = open ? id : null; cx.notify(); });
  if (view.openFilter === id) menu.content(v_flex().w(320).max_h(360).overflow_y_scrollbar().p(6).gap(2)
    .bg(c.popover).border_1().border_color(c.border).rounded(R.card)
    .children(entries.map((value, index) => {
      const text = value === "all" ? all : field === "agent" ? agentLabel(value) : modelLabel(value);
      return Button.new(`${id}-value-${index}`).min_h(36).px(12).rounded(R.control).items_center()
        .bg(value === selected ? c.selected : c.popover).hover((style) => style.bg(c.subtle))
        .on_click((_event, cx) => {
          if (field === "agent") view.requestAgent = value; else view.requestModel = value;
          view.requestPage = 1; view.openFilter = null;
          view.scheduleDashboard(cx, { force: true }); cx.notify();
        }).child(div().w_full().text_size(T.body).line_height("20px").text_color(c.text).truncate().tooltip(text).child(text));
    })));
  return v_flex().flex_none().gap(8)
    .child(div().pl(1).text_size(T.small).line_height("18px").text_color(c.mutedForeground).child(label))
    .child(menu);
}

export function costsSummary(costs, page, c) {
  const data = costs ?? page?.summary ?? {};
  const known = number(data.knownCount), unknown = number(data.unknownCount);
  const total = known === 0 && unknown > 0 ? null : number(data.usd ?? data.estimatedUsd);
  const count = number(page?.total ?? data.requestCount);
  const tokens = number(data.totalTokens);
  const metric = (label, value, tooltip, primary = false) => v_flex().flex_grow(primary ? 2 : 1).flex_basis(primary ? 240 : 160).min_w(primary ? 220 : 140).gap(8)
    .child(div().text_size(T.body).line_height("20px").text_color(c.mutedForeground).child(label))
    .child(div().text_size(30).line_height("40px").font_semibold().text_color(c.text).truncate().tooltip(tooltip ?? value).child(value));
  return v_flex().w_full().min_w(0).p(24).gap(18).rounded(R.panel).bg(c.card)
    .child(h_flex().w_full().flex_wrap().gap_x(24).gap_y(16).items_start()
      .child(metric("估算费用 · USD", total === null ? "—" : `≈${formatMoney(total)}`,
        `按本地 API 价格表估算，非实付账单。${unknown ? '未计价记录不计入金额。' : ''}${data.checkedAt ? '价格核对：' + data.checkedAt : ''}`, true))
      .child(metric("Token 总量", tokens === null ? "—" : formatCompact(tokens), tokens === null ? "未记录" : `${formatInt(tokens)} Token · 含缓存读取与写入`))
      .child(metric("用量记录", count === null ? "—" : formatInt(count), "当前筛选范围内的记录，包含不能严格对应单次请求的历史用量事件")))
    .child(h_flex().w_full().flex_wrap().gap(16).items_center()
      .child(div().text_size(T.small).text_color(c.mutedForeground).child(`已计价 ${known === null ? "—" : formatInt(known)} 条`))
      .when(unknown > 0, el => el.child(div().text_size(T.small).text_color(c.mutedForeground)
        .tooltip("缺少模型价格或计价条件，这些记录尚未计入费用总额").child(`未计价 ${formatInt(unknown)} 条`))));
}

export function requestsTable(view, page, c, controls) {
  if (!page) return div().py(G.xl).text_size(T.body).text_color(c.mutedForeground).child("正在读取请求…");
  if (page.error) return div().py(G.md).text_size(T.body).text_color(c.destructive).child(`请求列表暂不可用：${page.error}`);
  const rows = Array.isArray(page.rows) ? page.rows : [];
  const total = number(page.total) ?? 0;
  const current = Math.max(1, number(page.page) ?? view.requestPage);
  const size = number(page.pageSize) ?? view.requestPageSize;
  const pages = Math.max(1, number(page.totalPages) ?? Math.ceil(total / size));
  const loading = Boolean(view.dashboardPending || view.dashboardQueued || view.loading);
  const pagination = (id) => h_flex().flex_none().flex_wrap().gap(G.sm).items_center()
    .child(div().text_size(T.small).text_color(c.mutedForeground).child(total
      ? `${formatInt((current - 1) * size + 1)}–${formatInt(Math.min(current * size, total))} / ${formatInt(total)}` : "0 条"))
    .child(segmented(`${id}-size`, [{ key: 50, label: "50" }, { key: 100, label: "100" }], view.requestPageSize, (value, cx) => {
      view.requestPageSize = value; view.requestPage = 1; view.scheduleDashboard(cx, { force: true });
    }, c))
    .child(button(`${id}-prev`, "‹", (_event, cx) => view.setRequestPage(current - 1, cx), c, { variant: "outline", disabled: loading || current <= 1 }).tooltip("上一页"))
    .child(div().text_center().text_size(T.body).text_color(c.mutedForeground).child(`${current} / ${pages}`))
    .child(button(`${id}-next`, "›", (_event, cx) => view.setRequestPage(current + 1, cx), c, { variant: "outline", disabled: loading || current >= pages }).tooltip("下一页"));
  const groups = [["请求信息",0,4],["Token 用量",4,8],["费用",8,9],["请求性能",9,12],["结果",12,13]];
  return v_flex().w_full().min_w(0).gap(G.md)
    .child(h_flex().w_full().flex_wrap().gap(G.sm).items_center().justify_between()
      .child(div().text_size(T.card).font_semibold().text_color(c.text).child("请求明细"))
      .when(Boolean(controls), (el) => el.child(controls)).child(pagination("ins-requests-top")))
    .child(div().w_full().min_w(0).rounded(R.panel).overflow_hidden().bg(c.card)
      .child(div().id("ins-requests-scroll").w_full().min_w(0).overflow_x_scrollbar()
      .child(v_flex().w_full().min_w(TABLE_WIDTH)
        .child(h_flex().w_full().min_w(TABLE_WIDTH).h(30).items_center().bg(c.card)
          .children(groups.map(([label,start,end]) => {
            const width = COLUMNS.slice(start,end).reduce((sum,column)=>sum+column[1],0);
            return div().flex_basis(width).min_w(width).flex_grow(width).flex_shrink(0).px(10).text_size(T.small).text_color(c.mutedForeground).child(label);
          })))
        .child(h_flex().w_full().min_w(TABLE_WIDTH).min_h(36).items_center().bg(c.secondary).border_b(1).border_color(c.border)
          .children(COLUMNS.map(([label], index) => cell(label, index, c, { color: c.mutedForeground }).font_medium())))
        .when(rows.length > 0, (el) => el.children(rows.map((row, index) => requestRow(row, index, c))))
        .when(rows.length === 0, (el) => el.child(div().w_full().py(36).px(16).text_size(T.body).text_color(c.mutedForeground).child("没有符合筛选条件的请求。"))))))
    .when(rows.length > 15, (el) => el.child(h_flex().w_full().justify_end().child(pagination("ins-requests-bottom"))));
}
