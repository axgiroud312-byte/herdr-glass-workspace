// Node-only price calculation. This module never performs network requests.
// Input is uncached input; output already contains reasoning output.
import { readFileSync } from "node:fs";

export const priceCatalog = JSON.parse(readFileSync(new URL("./prices.json", import.meta.url), "utf8"));
const tokenKeys = ["input", "output", "cacheRead", "cacheWrite"];
const shortDurations = new Set(["5m", "30m"]);
const knownTier = { default: "standard", standard: "standard", priority: "fast", fast: "fast", ultrafast: "ultrafast", flex: "flex", batch: "batch" };

function modelName(value) {
  if (typeof value !== "string") return null;
  const s = value.trim().toLowerCase();
  if (!s || ["unknown", "unknown model", "—"].includes(s)) return null;
  return s;
}

function resolveModel(request) {
  const observed = modelName(request.actualModel);
  const raw = observed ?? modelName(request.reportedModel) ?? modelName(request.model);
  let model = raw?.split("/").at(-1) ?? null;
  let suffixTier = null;
  // These are local coding-agent speed names, not a claim that an API model
  // has that suffix. We name the mapping in the returned explanation.
  if (model?.endsWith("-ultrafast")) { suffixTier = "ultrafast"; model = model.slice(0, -10); }
  else if (model?.endsWith("-fast")) { suffixTier = "fast"; model = model.slice(0, -5); }
  return { model, raw, observed: Boolean(observed), suffixTier };
}

function valueOf(request, key) {
  const value = request.tokens?.[key] ?? request[key];
  if (value === undefined || value === null) return 0;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : NaN;
}

function unknown(result, note) {
  return { ...result, usd: null, known: false, note: [...result.notes, note].filter(Boolean).join("；"), parts: null, rates: null };
}

/** Estimate a single request only: never pass a session/day token aggregate. */
export function estimateCost(request = {}) {
  const found = resolveModel(request);
  const entry = priceCatalog.models[found.model];
  const result = {
    usd: null, known: false, currency: "USD", model: found.model,
    basis: found.observed ? "按记录的实际模型折算" : "按记录模型折算（实际模型未确认）",
    modelBasis: request.modelBasis ?? null,
    sourceUrl: entry ? priceCatalog.sources[entry.source]?.url ?? null : null,
    checkedAt: priceCatalog.checkedAt,
    notes: ["当前公开 API 价估算，非实际账单"],
    parts: null, rates: null, tier: null, context: null,
  };
  if (request.kind === "usage_event") return unknown(result, "这是历史用量增量或汇总，无法确认单次请求边界，未套用单请求价格");
  if (request.tokens === null) return unknown(result, "该请求没有保存用量数字，无法估算");
  if (!entry) return unknown(result, "价格未知：尚无已核实的该模型费率");
  for (const key of ["input", "output"]) {
    const raw = request.tokens ? request.tokens[key] : request[key];
    if (raw === null || raw === undefined) return unknown(result, "该请求的输入或输出用量未知，无法估算");
  }
  const tokens = Object.fromEntries(tokenKeys.map(key => [key, valueOf(request, key)]));
  if (Object.values(tokens).some(v => !Number.isFinite(v))) return unknown(result, "用量字段无效，无法估算");
  if (!tokenKeys.some(key => request.tokens?.[key] !== undefined || request[key] !== undefined)) return unknown(result, "没有请求用量数字");

  const explicitContext = request.contextTokens;
  const context = typeof explicitContext === "number" && Number.isFinite(explicitContext) && explicitContext >= 0
    ? explicitContext : tokens.input + tokens.cacheRead + tokens.cacheWrite;
  result.contextTokens = context;
  if (entry.validThrough && new Date().toISOString().slice(0, 10) > entry.validThrough) return unknown(result, `价格快照已过有效期（${entry.validThrough}），需要重新核实`);
  if (entry.note) result.notes.push(entry.note);

  const requestedTier = String(request.serviceTier ?? "").toLowerCase();
  let tier = knownTier[requestedTier] ?? found.suffixTier ?? "standard";
  if (requestedTier && !knownTier[requestedTier] && requestedTier !== "auto") return unknown(result, `服务档位 ${requestedTier} 没有已核实费率`);
  if (!requestedTier || requestedTier === "auto") {
    result.notes.push(found.suffixTier ? `按模型名称中的 ${found.suffixTier} 档位折算` : "服务档位未记录，按标准档估算");
  }
  let rates;
  if (entry.schedule === "deepseek") {
    const when = new Date(request.timestamp ?? request.time ?? NaN);
    if (!Number.isFinite(when.getTime())) return unknown(result, "缺少请求时间，无法判断峰谷价格");
    const hour = when.getUTCHours() + when.getUTCMinutes() / 60;
    const weekday = when.getUTCDay() >= 1 && when.getUTCDay() <= 5;
    const peakWindow = weekday && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10));
    if (peakWindow && request.isChinesePublicHoliday === undefined) return unknown(result, "处于工作日峰价时段，但节假日状态未知，未猜测峰谷价格");
    tier = peakWindow && request.isChinesePublicHoliday === false ? "peak" : "offpeak";
    rates = entry.tiers[tier].short;
    result.context = "all";
    result.notes.push("按当前峰谷规则与请求时间折算");
  } else if (entry.regionRequired) {
    const regionAliases = { singapore: "international", international: "international", global: "global", beijing: "global", frankfurt: "global", virginia: "global" };
    const region = regionAliases[String(request.region ?? "").toLowerCase()];
    if (!region) return unknown(result, "该模型价格因部署地区不同，记录缺少地区，未选择默认地区价格");
    if (tier !== "standard") return unknown(result, "该模型的服务档位费率尚未核实");
    const band = entry.contextBands.findIndex(limit => context <= limit);
    if (band < 0) return unknown(result, "输入超出已核实定价范围");
    const [input, output] = entry.regions[region][band];
    rates = { input, output, cacheRead: null, writeShort: null, writeLong: null };
    result.context = `≤${entry.contextBands[band]}`;
    result.notes.push(`按 ${region} 地区公开价`);
  } else {
    const long = entry.contextThreshold !== undefined && (entry.longInclusive ? context >= entry.contextThreshold : context > entry.contextThreshold);
    result.context = long ? "long" : "short";
    rates = entry.tiers?.[tier]?.[long ? "long" : "short"];
    if (!rates) return unknown(result, `该模型的 ${tier}${long ? " 长上下文" : ""} 费率尚未核实`);
  }
  result.tier = tier;
  rates = { ...rates };
  if (request.inferenceGeo === "us" || request.dataResidency === true) {
    if (!["openai", "anthropic", "xai"].includes(entry.provider)) return unknown(result, "指定地区的加价规则尚未核实");
    for (const key of Object.keys(rates)) if (typeof rates[key] === "number") rates[key] *= 1.1;
    result.notes.push("已按记录的地区处理选项增加 10%");
  }
  for (const key of ["input", "output", "cacheRead"]) {
    if (tokens[key] > 0 && typeof rates[key] !== "number") return unknown(result, `${key === "cacheRead" ? "缓存读取" : key === "input" ? "输入" : "输出"}价格未核实`);
  }
  let writeCost = 0;
  if (tokens.cacheWrite > 0) {
    const durations = entry.writeDurations ?? [];
    if (!durations.length) return unknown(result, "缓存写入价格未核实");
    const splitKeys = durations.map(d => `cacheWrite${d}`);
    const split = splitKeys.map(key => valueOf(request, key));
    const haveSplit = splitKeys.some(key => request.tokens?.[key] != null || request[key] != null);
    if (haveSplit && split.every(Number.isFinite) && Math.abs(split[0] + split[1] - tokens.cacheWrite) < 0.5) {
      writeCost = split[0] * rates.writeShort + split[1] * rates.writeLong;
    } else {
      const duration = String(request.cacheWriteDuration ?? "").toLowerCase();
      if (!durations.includes(duration)) return unknown(result, "缓存写入时长未记录，无法区分写入价格");
      writeCost = tokens.cacheWrite * (shortDurations.has(duration) ? rates.writeShort : rates.writeLong);
    }
    if (!Number.isFinite(writeCost)) return unknown(result, "缓存写入价格未核实");
  }
  const parts = {
    input: tokens.input * (rates.input ?? 0) / 1e6,
    output: tokens.output * (rates.output ?? 0) / 1e6,
    cacheRead: tokens.cacheRead * (rates.cacheRead ?? 0) / 1e6,
    cacheWrite: writeCost / 1e6,
  };
  return { ...result, usd: Object.values(parts).reduce((sum, part) => sum + part, 0), known: true, parts, rates,
    note: result.notes.join("；") };
}

export function summarizeCosts(requests = []) {
  let usd = 0, knownCount = 0, unknownCount = 0;
  for (const request of requests) {
    const cost = estimateCost(request);
    if (cost.known) { usd += cost.usd; knownCount++; } else unknownCount++;
  }
  return { usd: knownCount > 0 ? usd : null, knownCount, unknownCount, checkedAt: priceCatalog.checkedAt,
    basis: priceCatalog.basis, currency: "USD" };
}
