import { assertEquals } from "@std/assert";
import {
  mergeHeaderYaml,
  parseHeaderYaml,
  readHeaderValue,
  serializeHeaderYaml,
  TARGET_HEADER,
} from "../src/headers.js";

Deno.test("空配置返回空 entries", () => {
  assertEquals(parseHeaderYaml(""), { entries: [] });
  assertEquals(parseHeaderYaml("   \n  # 注释\n"), { entries: [] });
});

Deno.test("解析普通 mapping", () => {
  const parsed = parseHeaderYaml('X-Api-Key: "abc"\nunquoted: value');
  assertEquals(parsed, {
    entries: [["X-Api-Key", "abc"], ["unquoted", "value"]],
  });
});

Deno.test("值中允许包含冒号（URL）", () => {
  const parsed = parseHeaderYaml("X-Endpoint: https://example.com/v1/chat");
  assertEquals(parsed, {
    entries: [["X-Endpoint", "https://example.com/v1/chat"]],
  });
});

Deno.test("解析 mapping 序列并规范化", () => {
  const yaml = '- X-Api-Key: "abc"\n- X-Other: hello';
  const entries = parseHeaderYaml(yaml)?.entries;
  if (!entries) throw new Error("解析结果不应为 null");
  assertEquals(entries, [["X-Api-Key", "abc"], ["X-Other", "hello"]]);
  assertEquals(
    serializeHeaderYaml(entries),
    'X-Api-Key: "abc"\nX-Other: "hello"',
  );
});

Deno.test("单引号与转义", () => {
  const parsed = parseHeaderYaml("a: 'it''s'\nb: \"line\\nbreak\"");
  assertEquals(parsed, { entries: [["a", "it's"], ["b", "line\nbreak"]] });
});

Deno.test("不支持的形态返回 null", () => {
  assertEquals(parseHeaderYaml("---\na: 1"), null); // 多文档
  assertEquals(parseHeaderYaml("a:\n  b: 1"), null); // 嵌套
  assertEquals(parseHeaderYaml("a: [1, 2]"), null); // 流式序列
  assertEquals(parseHeaderYaml("block: |\n  text"), null); // 块标量
  assertEquals(parseHeaderYaml("a: 1\n  b: 2"), null); // 意外缩进
  assertEquals(parseHeaderYaml("&anchor a: 1"), null); // 锚点
});

Deno.test("合并且保留其他 header，目标 header 大小写不敏感替换", () => {
  const merged = mergeHeaderYaml(
    'X-Api-Key: "abc"\nX-OpenCode-Session: "old"',
    TARGET_HEADER,
    "new-id",
  );
  assertEquals(merged.ok, true);
  assertEquals(merged.yaml, 'X-Api-Key: "abc"\nx-opencode-session: "new-id"');
});

Deno.test("合并到空配置", () => {
  const merged = mergeHeaderYaml("", TARGET_HEADER, "st-oc-1");
  assertEquals(merged, { ok: true, yaml: 'x-opencode-session: "st-oc-1"' });
});

Deno.test("合并到 mapping 序列", () => {
  const merged = mergeHeaderYaml(
    "- X-Api-Key: key\n- X-Other: v",
    TARGET_HEADER,
    "id-1",
  );
  assertEquals(merged, {
    ok: true,
    yaml: 'X-Api-Key: "key"\nX-Other: "v"\nx-opencode-session: "id-1"',
  });
});

Deno.test("非法 YAML 时合并不改动原文", () => {
  const bad = "a:\n  b: 1";
  const merged = mergeHeaderYaml(bad, TARGET_HEADER, "id-1");
  assertEquals(merged, { ok: false, reason: "unsupported-or-invalid-yaml" });
});

Deno.test("注入值中的特殊字符会被安全转义且可回读", () => {
  const weird = 'has "quote" and \\ backslash';
  const merged = mergeHeaderYaml("", TARGET_HEADER, weird);
  assertEquals(merged.ok, true);
  assertEquals(readHeaderValue(merged.yaml, TARGET_HEADER), weird);
});

Deno.test("readHeaderValue 大小写不敏感", () => {
  assertEquals(
    readHeaderValue('X-OpenCode-Session: "v"', "x-opencode-session"),
    "v",
  );
  assertEquals(readHeaderValue("other: v", TARGET_HEADER), null);
});
