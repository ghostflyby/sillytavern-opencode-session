// SillyTavern 前端扩展入口（浏览器专用，不在 Deno 下做类型检查）。
//
// deno-lint-ignore-file no-window
//
// 行为：监听 CHAT_COMPLETION_SETTINGS_READY，对启用的 Custom
// （OpenAI-compatible）连接生成请求，把当前聊天专属的 x-opencode-session
// 合并进该次请求的 custom_include_headers。SillyTavern 服务端会在构造上游
// 请求时解析该字段并发送真实 HTTP header。
//
// 设计约束：
// - 每次事件都重新获取 SillyTavern.getContext()，不长期持有聊天状态；
// - 只修改本次请求对象，不改全局连接配置；
// - 全局 custom_include_headers 无法安全解析时保持原样并告警，不静默注入。

import { mergeHeaderYaml, TARGET_HEADER } from "./src/headers.js";
import {
  createEnsureSession,
  currentIdentity,
  METADATA_KEY,
  readSessionRecord,
  resetSession,
} from "./src/session.js";

const MODULE_NAME = "st-opencode-session";

const DEFAULT_SETTINGS = {
  enabled: false,
  targetUrl: "",
  manualId: "",
};

function logWarn(message) {
  console.warn(`[${MODULE_NAME}] ${message}`);
}

function notify(type, message) {
  try {
    window.toastr?.[type]?.(message, "OpenCode Session Header");
  } catch {
    /* 通知失败不影响生成 */
  }
}

function loadSettings(ctx) {
  const store = ctx?.extensionSettings;
  if (!store || typeof store !== "object") return { ...DEFAULT_SETTINGS };
  const saved = store[MODULE_NAME] ?? {};
  return {
    enabled: saved.enabled === true,
    targetUrl: typeof saved.targetUrl === "string" ? saved.targetUrl : "",
    manualId: typeof saved.manualId === "string" ? saved.manualId : "",
  };
}

function persistSettings(ctx, settings) {
  try {
    const store = ctx?.extensionSettings;
    if (!store || typeof store !== "object") return;
    store[MODULE_NAME] = { ...settings };
    ctx?.saveSettingsDebounced?.();
  } catch (error) {
    logWarn(`保存设置失败：${error?.message ?? error}`);
  }
}

function normalizeUrl(value) {
  return String(value ?? "").trim().replace(/\/+$/, "");
}

const ensure = createEnsureSession();

function requestMatchesTarget(generateData, settings) {
  if (generateData?.chat_completion_source !== "custom") return false;
  const target = normalizeUrl(settings.targetUrl);
  if (target === "") return true; // 未填写目标地址时对所有 Custom 请求生效
  const ctx = window.SillyTavern?.getContext?.();
  const requestUrl = normalizeUrl(
    generateData?.custom_url ?? ctx?.chatCompletionSettings?.custom_url ?? "",
  );
  return requestUrl === target;
}

async function onSettingsReady(generateData) {
  try {
    const ctx = window.SillyTavern?.getContext?.();
    const settings = loadSettings(ctx);
    if (!settings.enabled) return;
    if (!requestMatchesTarget(generateData, settings)) return;
    if (!ctx?.chatMetadata || !ctx?.getCurrentChatId?.()) {
      logWarn("当前没有可用的聊天上下文，跳过注入。");
      return;
    }
    const ensured = await ensure(ctx, settings);
    if (!ensured.id) {
      notify(
        "error",
        `未能确定会话 ID（${ensured.reason ?? "未知原因"}），本次请求未注入。`,
      );
      return;
    }
    if (ensured.created && !ensured.manual) {
      notify("info", `已为当前聊天分配新会话 ID：${ensured.id}`);
    }
    const existing = generateData?.custom_include_headers ?? "";
    const merged = mergeHeaderYaml(existing, TARGET_HEADER, ensured.id);
    if (!merged.ok) {
      // 保持原样，交由用户修正；服务端此时也会丢弃全部自定义 header。
      notify(
        "error",
        "连接设置里的 custom_include_headers 不是受支持的 YAML mapping，未注入会话 header，请修正后重试。",
      );
      logWarn(`custom_include_headers 解析失败：${existing}`);
      return;
    }
    generateData.custom_include_headers = merged.yaml;
  } catch (error) {
    logWarn(`处理生成事件失败：${error?.message ?? error}`);
  }
}

let currentSessionHandler = null;

function refreshPanel(ctx, settings) {
  const panel = document.getElementById(`${MODULE_NAME}-panel`);
  if (!panel) return;
  const identity = currentIdentity(ctx);
  const record = readSessionRecord(ctx?.chatMetadata);
  const effective = settings.manualId && settings.manualId.trim() !== ""
    ? `${settings.manualId.trim()}（手动指定）`
    : record?.id ?? "（尚未分配，首次生成时创建）";
  panel.querySelector(`#${MODULE_NAME}-identity`).textContent =
    `${identity.who} / ${identity.chat || "-"}`;
  panel.querySelector(`#${MODULE_NAME}-current`).textContent = effective;
  panel.querySelector(`#${MODULE_NAME}-enabled`).checked = settings.enabled;
  panel.querySelector(`#${MODULE_NAME}-target`).value = settings.targetUrl;
  panel.querySelector(`#${MODULE_NAME}-manual`).value = settings.manualId;
}

const SETTINGS_HTML = `
<div id="${MODULE_NAME}-panel" class="opencode-session-settings">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>OpenCode Session Header</b>
      <div class="inline-drawer-caret fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <label class="checkbox_label" for="${MODULE_NAME}-enabled">
        <input id="${MODULE_NAME}-enabled" type="checkbox" />
        <span>启用（仅对 Custom 兼容连接的生成请求生效）</span>
      </label>
      <label for="${MODULE_NAME}-target">目标 Custom API 地址（留空表示全部 Custom 连接）</label>
      <input id="${MODULE_NAME}-target" class="text_pole" type="text" placeholder="https://upstream.example.com/v1" />
      <label for="${MODULE_NAME}-manual">手动会话 ID（上游要求已存在会话时填写，优先于自动分配）</label>
      <input id="${MODULE_NAME}-manual" class="text_pole" type="text" placeholder="留空则自动生成 UUID" />
      <div>当前聊天：<code id="${MODULE_NAME}-identity">-</code></div>
      <div>当前会话 ID：<code id="${MODULE_NAME}-current">-</code></div>
      <div class="flex-container">
        <a id="${MODULE_NAME}-reset" class="menu_button">重新分配当前聊天 ID</a>
      </div>
      <small>
        会话 ID 保存在各聊天的 metadata 中；复制/分支出的新聊天会重新分配。
        聊天改名后身份记录不再匹配，也会重新分配。header 经 SillyTavern 服务端转发，浏览器不直连上游。
      </small>
    </div>
  </div>
</div>`;

function init() {
  const ctx = window.SillyTavern?.getContext?.();
  if (!ctx?.eventSource || !ctx?.eventTypes) {
    logWarn("SillyTavern 上下文不可用，扩展未启用。");
    return;
  }
  const settings = loadSettings(ctx);

  const container = document.getElementById("extensions_settings2") ??
    document.getElementById("extensions_settings");
  if (container) {
    container.insertAdjacentHTML("beforeend", SETTINGS_HTML);
    const panel = document.getElementById(`${MODULE_NAME}-panel`);
    panel.querySelector(`#${MODULE_NAME}-enabled`).addEventListener(
      "change",
      (event) => {
        settings.enabled = event.target.checked;
        persistSettings(ctx, settings);
        notify(
          settings.enabled ? "success" : "info",
          settings.enabled ? "已启用" : "已停用",
        );
      },
    );
    panel.querySelector(`#${MODULE_NAME}-target`).addEventListener(
      "input",
      (event) => {
        settings.targetUrl = event.target.value;
        persistSettings(ctx, settings);
      },
    );
    panel.querySelector(`#${MODULE_NAME}-manual`).addEventListener(
      "input",
      (event) => {
        settings.manualId = event.target.value;
        persistSettings(ctx, settings);
        refreshPanel(ctx, settings);
      },
    );
    panel.querySelector(`#${MODULE_NAME}-reset`).addEventListener(
      "click",
      async () => {
        const done = await resetSession(ctx);
        if (done) {
          notify("success", "已删除当前聊天的会话 ID，下次生成时重新分配。");
        } else notify("error", "当前没有可用的聊天 metadata。");
        refreshPanel(ctx, settings);
      },
    );
  }

  currentSessionHandler = onSettingsReady;
  const readyEvent = ctx.eventTypes.CHAT_COMPLETION_SETTINGS_READY;
  const changedEvent = ctx.eventTypes.CHAT_CHANGED;
  // makeLast：确保在其他监听器（可能整体覆盖 custom_include_headers）之后执行。
  if (typeof ctx.eventSource.makeLast === "function") {
    ctx.eventSource.makeLast(readyEvent, currentSessionHandler);
  } else {
    ctx.eventSource.on(readyEvent, currentSessionHandler);
  }
  if (changedEvent) {
    ctx.eventSource.on(
      changedEvent,
      () => refreshPanel(window.SillyTavern.getContext(), loadSettings(ctx)),
    );
  }
  refreshPanel(ctx, settings);
  console.log(
    `[${MODULE_NAME}] 已加载。metadata 键：${METADATA_KEY}，header：${TARGET_HEADER}`,
  );
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
