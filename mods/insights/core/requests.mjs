// The existing dedup ledger is the single accounting source. This module adds
// only request metadata; no prompt, response body, credentials or network I/O.
import { parseTimestamp, toNonNegInt, isPlainObject } from "./util.mjs";
import { requestModel } from "../request-model.js";
import { requestSpeed } from "./codex-timing.mjs";

export const REQUEST_METADATA_VERSION = 1;
const text = (v) => typeof v === "string" && v.trim() && v !== "unknown" ? v.trim() : null;
const ms = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
const iso = (v) => { const n = parseTimestamp(v); return n === null ? null : new Date(n).toISOString(); };

export function observeRequestContext(record, state) {
  const p = isPlainObject(record.payload) ? record.payload : {};
  const c = state.requestContext ??= { turns: {} };
  if (record.type === "turn_context") {
    const previous = c.turns[p.turn_id ?? p.root_turn_id] ?? c;
    const next = {
      model: text(p.model) ?? previous.model ?? null,
      effort: text(p.effort ?? p.reasoning_effort) ?? previous.effort ?? null,
      serviceTier: text(p.service_tier ?? p.serviceTier) ?? previous.serviceTier ?? null,
    };
    Object.assign(c, next);
    const id = p.turn_id ?? p.root_turn_id;
    if (id) c.turns[id] = next;
  }
  if (record.type === "event_msg" && p.type === "thread_settings_applied") {
    const s = p.thread_settings ?? {};
    c.serviceTier = text(s.service_tier ?? s.serviceTier) ?? c.serviceTier ?? null;
    c.effort = text(s.reasoning_effort ?? s.effort) ?? c.effort ?? null;
  }
  if (record.type === "thinking_level_change") c.effort = text(record.thinkingLevel);
}

function splitCache(usage) {
  const c = usage?.cache_creation ?? {};
  const result = {};
  for (const [field, value] of Object.entries({
    cacheWrite5m: usage?.cache_creation_5m_input_tokens ?? c.ephemeral_5m_input_tokens,
    cacheWrite1h: usage?.cache_creation_1h_input_tokens ?? c.ephemeral_1h_input_tokens,
    cacheWrite30m: usage?.cache_write_30m_tokens,
    cacheWrite12h: usage?.cache_write_12h_tokens,
  })) if (typeof value === "number" && Number.isFinite(value) && value >= 0) result[field] = value;
  return result;
}

export function requestMetadata(record, state, meta) {
  const p = isPlainObject(record?.payload) ? record.payload : {};
  const message = isPlainObject(record?.message) ? record.message : record ?? {};
  const c = state.requestContext ?? {};
  const context = c.turns?.[p.turn_id ?? p.root_turn_id] ?? c;
  const out = {
    timestamp: iso(record?.timestamp ?? message.timestamp ?? meta.timestamp),
    actualModel: null, modelBasis: "requested", effort: null, serviceTier: null,
    firstTokenMs: null, durationMs: null, status: null,
    kind: "request", basis: "本地用量记录", tokenDetails: {},
  };
  if (meta.harness === "codex") {
    out.actualModel = text(p.actual_model ?? p.served_model ?? p.response?.model);
    out.modelBasis = out.actualModel ? "reported" : "context";
    out.effort = text(p.effort ?? p.reasoning_effort ?? context.effort);
    out.serviceTier = text(p.service_tier ?? context.serviceTier ?? c.serviceTier);
    out.firstTokenMs = ms(p.time_to_first_token_ms);
    out.durationMs = ms(p.request_duration_ms);
    if (out.durationMs !== null) out.durationBasis = "reported-request";
    out.basis = out.actualModel ? "响应记录确认模型" : "日志仅记录请求模型，未记录实际响应模型";
    if (record.type !== "token_usage_record" && !p.response_id) {
      out.kind = "usage_event";
      out.basis = "旧版用量计数增量；无法保证与单次请求一一对应";
    }
  } else if (meta.harness === "claude") {
    out.actualModel = text(message.model);
    if (out.actualModel?.startsWith("<")) out.actualModel = null;
    out.modelBasis = out.actualModel ? "reported" : "unknown";
    out.effort = text(message.effort ?? message.reasoning_effort);
    out.serviceTier = text(message.usage?.service_tier);
    out.firstTokenMs = ms(message.time_to_first_token_ms ?? message.ttft_ms);
    out.durationMs = ms(message.durationMs ?? message.duration_ms);
    out.status = record.error || record.isApiErrorMessage ? "error"
      : message.stop_reason ? "success" : null;
    out.tokenDetails = splitCache(message.usage);
    out.basis = out.actualModel ? "API 响应中的模型" : "响应未记录实际模型";
  } else if (meta.harness === "pi" || meta.harness === "pi-sub") {
    out.actualModel = text(message.actualModel ?? message.servedModel);
    out.modelBasis = out.actualModel ? "reported" : "requested";
    out.effort = text(message.thinkingLevel ?? c.effort);
    out.durationMs = ms(message.durationMs ?? record.durationMs);
    out.firstTokenMs = ms(message.timeToFirstTokenMs ?? message.ttftMs);
    const stop = message.stopReason;
    out.status = stop === "error" ? "error" : stop === "aborted" ? "cancelled"
      : ["stop", "length", "toolUse"].includes(stop) ? "success" : null;
    if (["compaction", "branch_summary", "usage"].includes(record.type) || message.role === "toolResult") {
      out.kind = "usage_event"; out.basis = "工具记录的用量事件";
    } else out.basis = "Pi 记录请求模型；未推断实际响应模型";
  } else if (meta.harness === "qwen") {
    out.actualModel = text(record.actualModel ?? record.servedModel);
    out.modelBasis = out.actualModel ? "reported" : "requested";
    out.durationMs = ms(record.durationMs ?? record.duration_ms);
    out.firstTokenMs = ms(record.timeToFirstTokenMs);
    out.basis = "Qwen 单请求用量记录";
  } else {
    out.kind = "usage_event";
    out.modelBasis = "record";
  }
  return out;
}

export function databaseRequestMetadata(agent, data, record, tokens) {
  if (agent === "opencode") {
    const time = data.time ?? {};
    const created = Number(time.created ?? record.time_created);
    const completed = Number(time.completed);
    return {
      timestamp: iso(created), actualModel: text(data.actualModel ?? data.servedModel),
      modelBasis: "requested", effort: text(data.model?.variant), serviceTier: null,
      // OpenCode's `streamed` is not a guaranteed first-token measurement.
      firstTokenMs: null,
      durationMs: data.finish && Number.isFinite(completed) && completed >= created ? completed - created : null,
      status: data.error ? "error" : data.finish ? "success" : null,
      kind: "request", basis: "OpenCode assistant 消息；模型是请求配置，耗时为消息记录边界",
      tokenDetails: {},
    };
  }
  const status = record.status;
  const code = Number(status);
  return {
    timestamp: iso(Number(record.created_at_ms) || Number(record.created_at) * 1000),
    actualModel: null, modelBasis: "requested", effort: null, serviceTier: null,
    firstTokenMs: null, firstByteMs: ms(record.ttfb_ms), durationMs: ms(record.duration_ms),
    status: code >= 200 && code < 400 || status === "success" ? "success"
      : status === "cancelled" || code === 499 ? "cancelled"
        : code >= 400 || ["error", "failed"].includes(status) ? "error" : null,
    kind: "request", basis: "AIO 请求日志；首字节耗时未冒充首 Token 耗时",
    tokenDetails: agent === "claude" ? splitCache(record) : {},
  };
}

// A richer duplicate may arrive later. Missing fields never erase known ones.
export function mergeRequestMetadata(previous, incoming) {
  const result = { ...(previous ?? {}) };
  const prefer = incoming.kind === "request" || result.kind !== "request";
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined || value === null) continue;
    if (["kind", "basis", "modelBasis"].includes(key) && !prefer) continue;
    if (key === "timestamp" && result.timestamp) continue;
    if (key === "tokenDetails") {
      result.tokenDetails = { ...(result.tokenDetails ?? {}), ...value };
    } else result[key] = value;
  }
  return result;
}

export function recordRequestOnly(file, id, meta, metadata, tokens = null) {
  file.requestOnly ??= {};
  file.requestOnly[id] = {
    id, day: meta.day, agent: meta.harness, model: text(meta.model),
    tokens, ...metadata,
  };
}

export function requestRows(store) {
  const files = new Map(Object.values(store.files ?? {}).map(f => [f.id, f]));
  const rows = [];
  for (const [id, entry] of Object.entries(store.dedup ?? {})) {
    if (!Array.isArray(entry)) continue;
    const aggregate = files.get(entry[0])?.rows?.[entry[1]];
    if (!aggregate) continue;
    const m = entry[7]?.request ?? {};
    const tokens = {
      input: toNonNegInt(entry[2]), output: toNonNegInt(entry[3]),
      cacheRead: toNonNegInt(entry[4]), cacheWrite: toNonNegInt(entry[5]),
      reasoning: toNonNegInt(entry[6]), ...(m.tokenDetails ?? {}),
    };
    tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
    const durationMs = ms(m.durationMs);
    const firstTokenMs = ms(m.firstTokenMs);
    rows.push({
      id, timestamp: m.timestamp ?? null, day: aggregate.day,
      agent: aggregate.harness, actualModel: m.actualModel ?? null,
      requestedModel: text(aggregate.model),
      model: m.actualModel ?? text(aggregate.model), modelBasis: m.modelBasis ?? "legacy",
      effort: m.effort ?? null, serviceTier: m.serviceTier ?? null,
      contextTokens: tokens.input + tokens.cacheRead + tokens.cacheWrite,
      tokens, firstTokenMs, durationMs,
      durationBasis: m.durationBasis ?? "reported", durationNote: m.durationNote ?? null,
      ...requestSpeed(aggregate.harness, tokens, m),
      status: m.status ?? null, kind: m.kind ?? "usage_event",
      basis: m.basis ?? "历史汇总索引，原始请求元数据尚未重建",
    });
  }
  const seen = new Set(rows.map(r => r.id));
  for (const file of files.values()) for (const row of Object.values(file.requestOnly ?? {})) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    rows.push({ ...row, effort: row.effort ?? null, serviceTier: row.serviceTier ?? null,
      actualModel: row.actualModel ?? null, firstTokenMs: row.firstTokenMs ?? null,
      durationMs: row.durationMs ?? null, speed: null, status: row.status ?? null });
  }
  return rows;
}

export function queryRequests(store, options = {}, priceRequest) {
  const all = requestRows(store);
  const facets = {
    agents: [...new Set(all.map(r => r.agent))].sort(),
    models: [...new Set(all.map(r => requestModel(r) ?? "__unknown__"))].sort(),
  };
  const start = options.startDate, end = options.endDate;
  const query = String(options.query ?? "").trim().toLowerCase();
  const rows = all.filter(r => (!start || r.day >= start) && (!end || r.day <= end)
    && (!options.agent || options.agent === "all" || r.agent === options.agent)
    && (!options.model || options.model === "all" || requestModel(r) === options.model
      || ["unknown", "__unknown__"].includes(options.model) && !requestModel(r))
    && (!query || [r.agent, r.actualModel, r.model, r.effort, r.status].some(v => String(v ?? "").toLowerCase().includes(query))));
  rows.sort((a, b) => (b.timestamp ?? b.day).localeCompare(a.timestamp ?? a.day) || a.id.localeCompare(b.id));
  let knownCount = 0, estimatedUsd = 0, totalTokens = 0;
  for (const row of rows) {
    row.cost = typeof priceRequest === "function" ? priceRequest(row) : null;
    const amount = row.cost?.usd;
    if (Number.isFinite(amount) && row.cost?.known !== false) { knownCount++; estimatedUsd += amount; }
    totalTokens += row.tokens?.total ?? 0;
  }
  const pageSize = Math.max(1, Math.min(100, Math.trunc(Number(options.pageSize) || 50)));
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const page = Math.max(1, Math.min(totalPages, Math.trunc(Number(options.page) || 1)));
  const coverage = {
    unknownActualModel: rows.filter(r => !r.actualModel).length,
    usageEvents: rows.filter(r => r.kind !== "request").length,
    missingTimestamp: rows.filter(r => !r.timestamp).length,
    notes: ["仅统计日志实际保存的用量；缺失字段显示为空。"],
  };
  if (coverage.usageEvents) coverage.notes.push(`${coverage.usageEvents} 条旧用量事件无法保证与单次请求一一对应。`);
  return {
    rows: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length,
    page, pageSize, totalPages, facets, coverage,
    summary: { usd: knownCount ? estimatedUsd : null, estimatedUsd: knownCount ? estimatedUsd : null, knownCount, unknownCount: rows.length - knownCount, totalTokens },
  };
}
