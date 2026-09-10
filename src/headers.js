/**
 * 纯逻辑：custom_include_headers（YAML 子集）的解析、合并与序列化。
 *
 * SillyTavern 服务端 mergeObjectWithYaml 接受两种形态：
 *   1. 单个 mapping：`key: value` 每行一条；
 *   2. mapping 序列：`- key: value` 每条一条。
 * 其他 YAML 特性（嵌套、锚点、多文档、块标量等）一律视为不支持，
 * 解析失败返回 null，由调用方决定降级行为（本扩展选择不注入并告警）。
 *
 * 本模块不得依赖浏览器或 Deno 运行时 API，便于单元测试。
 */

/** 默认注入的 header 名。 */
export const TARGET_HEADER = "x-opencode-session";

/** 仅由普通字符组成的 key 直接输出，否则加引号。 */
function safeKey(key) {
  return /^[\w.-]+$/.test(key) ? key : JSON.stringify(key);
}

function unescapeDouble(inner) {
  let out = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = inner[++i];
    if (next === undefined) return null;
    const simple = {
      '"': '"',
      "\\": "\\",
      "/": "/",
      n: "\n",
      t: "\t",
      r: "\r",
      "0": "\0",
    }[next];
    if (simple !== undefined) {
      out += simple;
    } else if (next === "u") {
      const hex = inner.slice(i + 1, i + 5);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 4;
    } else {
      return null;
    }
  }
  return out;
}

function parseScalar(raw) {
  const t = raw.trim();
  if (t === "") return "";
  const dq = t.startsWith('"') && t.endsWith('"') && t.length >= 2;
  const sq = !dq && t.startsWith("'") && t.endsWith("'") && t.length >= 2;
  if (dq) {
    const inner = t.slice(1, -1);
    if (/\\/.test(inner)) {
      const unescaped = unescapeDouble(inner);
      return unescaped === null ? null : unescaped;
    }
    return inner;
  }
  if (sq) return t.slice(1, -1).replace(/''/g, "'");
  // 未加引号的流式集合/锚点值会被服务端 YAML 解析成非字符串，直接视为不支持
  if (/^[{[&*|>]/.test(t)) return null;
  return t;
}

function splitKeyValue(text) {
  const m = /^([^:]+):(?:\s(.*))?$/.exec(text);
  if (!m) return null;
  const key = parseScalar(m[1]);
  if (key === null || key === "") return null;
  const value = parseScalar(m[2] ?? "");
  if (value === null) return null;
  return [key, value];
}

/**
 * 解析 custom_include_headers 字符串。
 * 返回 { entries: [[key, value], ...] }；为空字符串时 entries 为空；
 * 不支持的形态或非法内容返回 null。
 */
export function parseHeaderYaml(text) {
  if (typeof text !== "string") return null;
  if (text.trim() === "") return { entries: [] };
  const entries = [];
  let mode = null; // 'map' | 'seq'
  let baseIndent = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\t/g, "  ");
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    if (/^\s*(---|\.\.\.)\s*$/.test(line)) return null;
    // 块标量/锚点等由 parseScalar 对值的起始字符检查兜底（a: |、a: &anchor 等）
    let m = /^(\s*)-(?:\s+(.*))?$/.exec(line);
    if (m) {
      if (mode === "map") return null;
      mode = "seq";
      const indent = m[1].length;
      if (baseIndent === null) baseIndent = indent;
      else if (indent !== baseIndent) return null;
      if (m[2] === undefined) return null; // 空序列项或嵌套开始，不支持
      const kv = splitKeyValue(m[2]);
      if (!kv) return null;
      entries.push(kv);
      continue;
    }
    m = /^(\s*)(.+?)\s*$/.exec(line);
    const indent = m[1].length;
    if (mode === "seq") return null;
    mode = "map";
    if (baseIndent === null) baseIndent = indent;
    else if (indent !== baseIndent) return null;
    const kv = splitKeyValue(m[2]);
    if (!kv) return null;
    entries.push(kv);
  }
  return { entries };
}

/** 将 entries 序列化为服务端可接受的单个 mapping（数组形态会被规范化）。 */
export function serializeHeaderYaml(entries) {
  return entries.map(([key, value]) =>
    `${safeKey(key)}: ${JSON.stringify(value)}`
  ).join("\n");
}

/**
 * 在现有 custom_include_headers 基础上合并一个 header。
 * 同名（大小写不敏感）header 会被替换而不是重复，避免服务端 YAML 重复键错误。
 * 返回 { ok: true, yaml } 或 { ok: false, reason }；失败时不改动原文。
 */
export function mergeHeaderYaml(
  existingText,
  name,
  value,
) {
  const parsed = parseHeaderYaml(existingText ?? "");
  if (parsed === null) {
    return { ok: false, reason: "unsupported-or-invalid-yaml" };
  }
  const kept = parsed.entries.filter(([key]) =>
    key.toLowerCase() !== name.toLowerCase()
  );
  kept.push([name, value]);
  return { ok: true, yaml: serializeHeaderYaml(kept) };
}

/** 供显示与校验用：从现有配置中读取某 header 的当前值（大小写不敏感）。 */
export function readHeaderValue(text, name) {
  const parsed = parseHeaderYaml(text ?? "");
  if (parsed === null) return null;
  const found = parsed.entries.find(([key]) =>
    key.toLowerCase() === name.toLowerCase()
  );
  return found ? found[1] : null;
}
