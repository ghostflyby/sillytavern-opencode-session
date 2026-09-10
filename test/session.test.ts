import { assertEquals } from "@std/assert";
import {
  createEnsureSession,
  currentIdentity,
  ensureSession,
  METADATA_KEY,
  readSessionRecord,
  resetSession,
} from "../src/session.js";

const CHAR_CTX = {
  chatId: "chat-a",
  groupId: null,
  characterId: 0,
  characters: [{ avatar: "seraphina.png" }],
};

Deno.test("角色与群聊身份互不相同，聊天名参与身份", () => {
  const charIdentity = currentIdentity(CHAR_CTX);
  const groupIdentity = currentIdentity({ chatId: "chat-a", groupId: "grp-1" });
  assertEquals(charIdentity, { who: "char:seraphina.png", chat: "chat-a" });
  assertEquals(groupIdentity, { who: "group:grp-1", chat: "chat-a" });
  assertEquals(charIdentity.who === groupIdentity.who, false);
  const renamed = currentIdentity({ ...CHAR_CTX, chatId: "chat-b" });
  assertEquals(renamed.chat, "chat-b");
});

Deno.test("无 metadata 时拒绝分配", async () => {
  const result = await ensureSession({
    metadata: null,
    identity: currentIdentity(CHAR_CTX),
  });
  assertEquals(result, { id: null, reason: "no-chat-metadata" });
});

Deno.test("首次分配生成新 ID 并持久化", async () => {
  const metadata: Record<
    string,
    { id: string; owner: { who: string; chat: string }; createdAt?: string }
  > = {};
  let persisted = false;
  const result = await ensureSession({
    metadata,
    identity: currentIdentity(CHAR_CTX),
    genId: () => "id-1",
    persist: () => {
      persisted = true;
    },
  });
  assertEquals(result, { id: "id-1", created: true });
  assertEquals(persisted, true);
  assertEquals(metadata[METADATA_KEY].id, "id-1");
});

Deno.test("同一聊天复用已有 ID；复制的 metadata（身份不匹配）重新分配", async () => {
  const metadata: Record<
    string,
    { id: string; owner: { who: string; chat: string }; createdAt?: string }
  > = {
    [METADATA_KEY]: {
      id: "old-id",
      owner: { who: "char:other.png", chat: "chat-x" },
      createdAt: "t",
    },
  };
  const reusedViaOwnerMatch = await ensureSession({
    metadata,
    identity: { who: "char:other.png", chat: "chat-x" },
    genId: () => "should-not-be-used",
  });
  assertEquals(reusedViaOwnerMatch, { id: "old-id", created: false });

  const copiedChat = await ensureSession({
    metadata,
    identity: currentIdentity(CHAR_CTX),
    genId: () => "fresh-id",
    persist: () => {},
  });
  assertEquals(copiedChat, { id: "fresh-id", created: true });
  assertEquals(metadata[METADATA_KEY].id, "fresh-id");
});

Deno.test("手动 ID 优先且不写 metadata", async () => {
  const metadata: Record<
    string,
    { id: string; owner: { who: string; chat: string }; createdAt?: string }
  > = {};
  const result = await ensureSession({
    metadata,
    identity: currentIdentity(CHAR_CTX),
    manualId: "  upstream-session-7  ",
  });
  assertEquals(result, {
    id: "upstream-session-7",
    created: false,
    manual: true,
  });
  assertEquals(metadata[METADATA_KEY], undefined);
});

Deno.test("并发请求共享同一次分配（工厂 memo）", async () => {
  const metadata: Record<
    string,
    { id: string; owner: { who: string; chat: string }; createdAt?: string }
  > = {};
  let generated = 0;
  const ensure = createEnsureSession({
    genId: () => `id-${++generated}`,
  });
  const ctx = {
    ...CHAR_CTX,
    chatMetadata: metadata,
    saveMetadata: () => Promise.resolve(),
  };
  const [a, b, c] = await Promise.all([
    ensure(ctx, {}),
    ensure(ctx, {}),
    ensure(ctx, {}),
  ]);
  assertEquals(generated, 1);
  assertEquals(a.id, b.id);
  assertEquals(b.id, c.id);
});

Deno.test("聊天切换后按各自 metadata 隔离", async () => {
  const ensure = createEnsureSession({ genId: () => "static" });
  const ctxA = {
    ...CHAR_CTX,
    chatMetadata: {} as Record<
      string,
      { id: string; owner: { who: string; chat: string }; createdAt?: string }
    >,
    saveMetadata: () => Promise.resolve(),
  };
  const ctxB = {
    ...CHAR_CTX,
    chatId: "chat-b",
    chatMetadata: {} as Record<
      string,
      { id: string; owner: { who: string; chat: string }; createdAt?: string }
    >,
    saveMetadata: () => Promise.resolve(),
  };
  const a = await ensure(ctxA, {});
  const b = await ensure(ctxB, {});
  const aAgain = await ensure(ctxA, {});
  assertEquals(a.created, true);
  assertEquals(b.created, true);
  assertEquals(aAgain.created, false);
  assertEquals(ctxA.chatMetadata[METADATA_KEY].owner?.chat, "chat-a");
  assertEquals(ctxB.chatMetadata[METADATA_KEY].owner?.chat, "chat-b");
});

Deno.test("readSessionRecord 与 resetSession", async () => {
  const metadata = {
    [METADATA_KEY]: { id: "x", owner: { who: "w", chat: "c" } },
  };
  assertEquals(readSessionRecord(metadata)?.id, "x");
  const ctx = { chatMetadata: metadata, saveMetadata: () => Promise.resolve() };
  assertEquals(await resetSession(ctx), true);
  assertEquals(readSessionRecord(metadata), null);
});
