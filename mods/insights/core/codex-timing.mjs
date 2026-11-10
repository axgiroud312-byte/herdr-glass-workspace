// Request timing only: the existing adapter remains the owner of token accounting.
// Policy follows Magpie d24be3c (sessions/calls.go and usage/ledger.go): a turn's
// duration/TTFT belongs to a request only when it contains exactly one call.
// Otherwise infer a bounded interval from input/tool-result and answer timestamps.
import { parseTimestamp } from "./util.mjs";

const validMs = v => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
const stateOf = state => state.codexRequestTiming ??= { current: null, turns: {}, calls: {} };
const turnOf = (s, id) => s.turns[id] ??= { keys: [], input: null, previous: null };
const validSpan = (start, end) => start !== null && end !== null && end > start && end - start < 7200000;

function applyTiming(store, file, key) {
  const s = stateOf(file.state), call = s.calls[key], entry = store.dedup[key];
  if (!call || !entry?.[7]?.request) return;
  const turn = turnOf(s, call.turn), m = entry[7].request;
  // Never replace a source's explicit per-request measurement.
  if (m.durationBasis === "reported-request" || m.durationMs !== null && m.durationMs !== undefined && !m.timingOwner) return;
  let duration = call.eligible && validSpan(call.input, call.end) ? call.end - call.input : null;
  let first = null, basis = "inferred", rank = duration === null ? 0 : 1;
  if (call.eligible && turn.keys.length === 1 && turn.complete && turn.duration > 0) {
    duration = turn.duration; first = turn.firstToken; basis = "codex-single-call-turn"; rank = 2;
  }
  // A partial/replayed copy must not erase a better original measurement.
  if (m.timingOwner && m.timingOwner !== file.id && (m.timingRank ?? 0) >= rank) return;
  Object.assign(m, {
    durationMs: duration, firstTokenMs: first, durationBasis: basis,
    durationNote: rank === 2 ? "这一轮只有一次模型请求，使用日志记录的整轮计时"
      : duration !== null ? "按输入或工具返回到本次输出结束的日志时间估算，包含等待" : "没有可确认的请求时间边界",
    timingOwner: file.id, timingRank: rank,
  });
}

export function observeCodexTiming(record, file, store) {
  const p = record.payload ?? {}, s = stateOf(file.state), at = parseTimestamp(record.timestamp);
  const explicit = p.turn_id ?? p.root_turn_id;
  if (record.type === "turn_context" || record.type === "event_msg" && p.type === "task_started") {
    if (explicit) s.current = explicit;
  }
  const input = record.type === "response_item" &&
    (p.type === "message" && p.role === "user" || ["function_call_output", "custom_tool_call_output"].includes(p.type))
    || record.type === "event_msg" && p.type === "user_message";
  if (!s.current && input) s.current = `legacy:${at}`;
  const id = explicit ?? s.current;
  if (!id) return;
  const turn = turnOf(s, id);
  if (input && at !== null) turn.input = at;
  const answer = record.type === "response_item" &&
    (p.type === "message" && p.role === "assistant" || ["reasoning", "function_call", "custom_tool_call"].includes(p.type));
  if (answer && at !== null) {
    if (!turn.answering) { turn.answering = true; turn.asked = turn.input; }
    turn.answered = at;
  }
  if (record.type === "event_msg" && p.type === "task_complete") {
    turn.complete = true;
    turn.duration = validMs(p.duration_ms);
    if (turn.duration === null) {
      const start = parseTimestamp(p.started_at), end = parseTimestamp(p.completed_at);
      if (validSpan(start, end)) turn.duration = end - start;
    }
    turn.firstToken = validMs(p.time_to_first_token_ms);
    for (const key of turn.keys) applyTiming(store, file, key);
  }
  if (record.type === "event_msg" && p.type === "turn_aborted") {
    turn.complete = false;
    for (const key of turn.keys) applyTiming(store, file, key);
  }
}

export function recordCodexTiming(record, file, store, key, tokens) {
  const p = record.payload ?? {}, s = stateOf(file.state);
  const id = p.turn_id ?? p.root_turn_id ?? s.current;
  if (!id) return;
  const turn = turnOf(s, id), at = parseTimestamp(record.timestamp);
  const modern = record.type === "token_usage_record";
  const last = p.info?.last_token_usage;
  // A first cumulative counter can include old history: don't time that sum as
  // this reply. Modern records can subsequently confirm the same dedup entry.
  const eligible = modern || Boolean(last && tokens.output === last.output_tokens
    && tokens.input + tokens.cacheRead + tokens.cacheWrite === last.input_tokens);
  let call = s.calls[key];
  if (!call) {
    let input = turn.answering ? turn.asked : turn.input;
    if (turn.previous !== null && (input === null || turn.previous > input)) input = turn.previous;
    // Usage can be logged after a tool finishes. End at the answer in that case.
    const end = turn.answering && turn.answered <= at && turn.input > turn.answered ? turn.answered : at;
    call = s.calls[key] = { turn: id, input, end, eligible };
    turn.keys.push(key);
    turn.previous = at === null ? turn.previous : Math.max(turn.previous ?? at, at);
    turn.answering = false;
    // A late second call invalidates any earlier single-call turn measurement.
    if (turn.keys.length === 2) applyTiming(store, file, turn.keys[0]);
  } else {
    if (modern) call.eligible = true;
    // A modern/legacy twin is one call, even when it appears after new content.
  }
  applyTiming(store, file, key);
}

// Explicitly separate decode speed, conservative floor and end-to-end average.
export function requestSpeed(agent, tokens, meta) {
  const empty = { speed: null, speedKind: null, speedBasis: "缺少可靠的请求计时" };
  const out = tokens?.output, reasoning = tokens?.reasoning ?? 0;
  const duration = meta.durationMs, first = meta.firstTokenMs;
  if (!(out > 0) || !(duration > 0) || ["error", "failed", "cancelled"].includes(meta.status)) return empty;
  if (agent !== "codex") return { speed: out * 1000 / duration, speedKind: "average", speedBasis: "平均速度：输出 Token / 总耗时（含等待）" };
  const window = duration - first, body = out - reasoning;
  const acceptable = (n, w) => n > 0 && w >= 1000 && n * 1000 <= 10000 * w;
  if (first > 0 && body >= 100 && acceptable(body, window)) {
    if (reasoning > 0) return { speed: body * 1000 / window, speedKind: "floor", speedBasis: "速度下限：正文 Token（扣除推理）/ 首 Token 到结束的时间；没有首正文计时" };
    return { speed: out * 1000 / window, speedKind: "measured", speedBasis: "输出 Token / 首 Token 到结束的时间；单次请求计时" };
  }
  if (out >= 1000 && acceptable(out, duration)) return {
    speed: out * 1000 / duration, speedKind: "floor",
    speedBasis: "速度下限：输出 Token / 总耗时，包含等待；日志边界耗时可能有少量误差",
  };
  return { ...empty, speedBasis: "计时窗口或输出量不足：首 Token 后至少 1 秒、100 个正文 Token；总耗时下限至少 1 秒、1,000 个输出 Token" };
}
