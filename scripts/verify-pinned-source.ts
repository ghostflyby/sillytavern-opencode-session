/**
 * 固定版本源码核验：检查 SillyTavern release 分支 pinned commit
 * 8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8（v1.18.0）中，扩展链路依赖的
 * 关键代码仍然存在。仅在内存中抓取并断言，不落盘。
 *
 * 运行：deno task verify:source
 */

const SHA = "8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8";
const RAW = `https://raw.githubusercontent.com/SillyTavern/SillyTavern/${SHA}`;

const CHECKS = [
  {
    file: "public/scripts/openai.js",
    expect: [
      "CHAT_COMPLETION_SETTINGS_READY",
      "custom_include_headers",
      "/api/backends/chat-completions/generate",
    ],
  },
  {
    file: "src/endpoints/backends/chat-completions.js",
    expect: [
      "mergeObjectWithYaml(headers, request.body.custom_include_headers)",
      "'Authorization': 'Bearer ' + apiKey",
      "...headers",
    ],
  },
  {
    file: "public/scripts/st-context.js",
    expect: [
      "getCurrentChatId",
      "chatMetadata",
      "saveMetadata",
      "eventTypes",
      "extensionSettings",
    ],
  },
  {
    file: "public/scripts/events.js",
    expect: [
      "CHAT_COMPLETION_SETTINGS_READY: 'chat_completion_settings_ready'",
      "CHAT_CHANGED: 'chat_id_changed'",
    ],
  },
];

let failed = false;
for (const check of CHECKS) {
  const response = await fetch(`${RAW}/${check.file}`);
  if (!response.ok) {
    console.log(`FAIL ${check.file}（HTTP ${response.status}）`);
    failed = true;
    continue;
  }
  const text = await response.text();
  for (const marker of check.expect) {
    const ok = text.includes(marker);
    console.log(`${ok ? "PASS" : "FAIL"} ${check.file} :: ${marker}`);
    failed ||= !ok;
  }
}
console.log(
  failed
    ? "结论：链路断言存在失败，需人工复查。"
    : `结论：pinned commit ${SHA} 的全部断言通过。`,
);
Deno.exit(failed ? 1 : 0);
