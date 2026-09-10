/**
 * 纯逻辑：当前聊天身份判定与会话 ID 的创建/复用。
 *
 * SillyTavern 的 chat_metadata 本身就是按聊天文件隔离的，因此每个聊天的
 * 会话 ID 存放在各自 metadata 的命名空间键下。为识别"复制/分支出的新聊天
 * 连同 metadata 一起被复制"的情况，除 ID 外还保存创建时的身份（角色/群组
 * + 聊天名）。身份不匹配时视为新聊天，重新分配 ID。
 *
 * 本模块不得依赖浏览器 API；ctx 通过参数注入，便于单元测试。
 */

export const METADATA_KEY = "opencode_session_header";

/**
 * 由 SillyTavern 上下文推断当前聊天身份。
 * 群聊以 groupId 区分；角色聊天以角色 avatar（目录名，稳定唯一）区分。
 */
export function currentIdentity(ctx) {
  const chatId = String(ctx?.chatId ?? "");
  const groupId = ctx?.groupId ?? null;
  const who = groupId
    ? `group:${groupId}`
    : `char:${ctx?.characters?.[ctx?.characterId]?.avatar ?? "?"}`;
  return { who, chat: chatId };
}

function sameIdentity(a, b) {
  return !!a && !!b && a.who === b.who && a.chat === b.chat;
}

function defaultGenId() {
  return `st-oc-${
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
  }`;
}

/**
 * 依据注入的参数确保存在会话 ID（单次调用，无并发保护）。
 * - manualId 非空时直接使用（用于上游要求"预先存在的会话"的场景），不写 metadata；
 * - metadata 中已有匹配身份的 ID 时复用；
 * - 否则生成新 ID，写回 metadata 并调用 persist 持久化。
 *
 * 返回 { id, created }；metadata 或 persist 不可用时返回 { id: null, reason }。
 *
 * @param {object} options
 * @param {Record<string, any>|null} options.metadata 当前聊天的 metadata 对象
 * @param {{who: string, chat: string}} options.identity 当前聊天身份
 * @param {string} [options.manualId] 手动指定的会话 ID
 * @param {() => string} [options.genId] 会话 ID 生成器
 * @param {() => unknown} [options.persist] metadata 持久化回调
 * @returns {Promise<{id: string|null, created?: boolean, manual?: boolean, reason?: string}>}
 */
export async function ensureSession(
  { metadata, identity, manualId, genId = defaultGenId, persist },
) {
  if (manualId && String(manualId).trim() !== "") {
    return { id: String(manualId).trim(), created: false, manual: true };
  }
  if (!metadata || typeof metadata !== "object") {
    return { id: null, reason: "no-chat-metadata" };
  }
  const existing = metadata[METADATA_KEY];
  if (
    existing && typeof existing.id === "string" && existing.id !== "" &&
    sameIdentity(existing.owner, identity)
  ) {
    return { id: existing.id, created: false };
  }
  const record = {
    id: genId(),
    owner: { who: identity.who, chat: identity.chat },
    createdAt: new Date().toISOString(),
  };
  metadata[METADATA_KEY] = record;
  if (typeof persist === "function") {
    await persist();
  }
  return { id: record.id, created: true };
}

/**
 * 并发安全的工厂：同一页面内并发生成请求会共享同一个"进行中"的分配流程，
 * 避免两个请求各自生成不同 ID、后写覆盖先写导致孤儿会话。
 * 键为 manual 标记之外的「身份 + metadata 对象引用」。
 */
export function createEnsureSession(options = {}) {
  const inflight = new Map();
  return function ensure(ctx, settings) {
    const identity = currentIdentity(ctx);
    const metadata = ctx?.chatMetadata ?? null;
    const key = `${identity.who}|${identity.chat}|${settings?.manualId ?? ""}|${
      metadata ? "" : "nometa"
    }`;
    if (inflight.has(key)) return inflight.get(key);
    const promise = ensureSession({
      metadata,
      identity,
      manualId: settings?.manualId ?? "",
      genId: options.genId,
      persist: () => ctx?.saveMetadata?.(),
    }).finally(() => inflight.delete(key));
    inflight.set(key, promise);
    return promise;
  };
}

/** 读取当前聊天已保存的会话记录（供 UI 展示）。 */
export function readSessionRecord(metadata) {
  const record = metadata?.[METADATA_KEY];
  return record && typeof record.id === "string" ? record : null;
}

/** 删除当前聊天的会话记录（供"重新生成 ID"按钮使用）。 */
export async function resetSession(ctx) {
  const metadata = ctx?.chatMetadata;
  if (!metadata) return false;
  delete metadata[METADATA_KEY];
  if (typeof ctx?.saveMetadata === "function") {
    await ctx.saveMetadata();
  }
  return true;
}
