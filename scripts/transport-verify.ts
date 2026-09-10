/**
 * 真实服务端转发验证（端到端）：
 *
 * 1. 在 .research/transport 下展开 pinned commit 的 SillyTavern 源码；
 * 2. 用 Deno 安装依赖并启动真实服务端（仅监听回环地址，独立 data 目录）；
 * 3. 启动本仓库的模拟上游，配置为 Custom 连接；
 * 4. 以 HTTP 方式调用真实 /api/backends/chat-completions/generate（非流式与
 *    流式各一），断言模拟上游收到的 x-opencode-session 与请求体一致。
 *
 * 运行：deno task verify:transport
 */

import { startMockServer } from "../mock/server.ts";

const SHA = "8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8";
const ST_PORT = 18300;
const MOCK_PORT = 18301;
const BASE = `http://127.0.0.1:${ST_PORT}`;

const root = new URL("../.research/transport/", import.meta.url).pathname;
const stDir = `${root}SillyTavern-${SHA}`;

async function exists(path: string) {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function downloadSource() {
  if (await exists(`${stDir}/package.json`)) {
    console.log(`[transport] 复用已存在的源码目录 ${stDir}`);
    return;
  }
  await Deno.mkdir(root, { recursive: true });
  console.log("[transport] 下载 pinned 源码包…");
  const response = await fetch(
    `https://codeload.github.com/SillyTavern/SillyTavern/tar.gz/${SHA}`,
  );
  if (!response.ok) throw new Error(`源码下载失败：HTTP ${response.status}`);
  const tgz = `${root}st.tgz`;
  await Deno.writeFile(tgz, response.body!);
  const tar = new Deno.Command("tar", {
    args: ["-xzf", tgz, "-C", root],
    stdout: "inherit",
    stderr: "inherit",
  });
  const status = await tar.output();
  if (!status.success) throw new Error("tar 解压失败");
  console.log(`[transport] 源码就绪：${stDir}`);
}

async function installDependencies() {
  if (await exists(`${stDir}/node_modules`)) {
    console.log("[transport] 依赖已安装，跳过");
    return;
  }
  console.log("[transport] deno install（可能需要数分钟）…");
  const install = new Deno.Command(Deno.execPath(), {
    args: ["install", "--entrypoint", "server.js"],
    cwd: stDir,
    stdout: "inherit",
    stderr: "inherit",
  });
  const status = await install.output();
  if (!status.success) throw new Error("deno install 失败（见上方输出）");
}

function startServer() {
  const dataRoot = `${root}data`;
  Deno.mkdirSync(dataRoot, { recursive: true });
  const serverLog = `${root}server.log`;
  const command = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "server.js",
      "--port",
      String(ST_PORT),
      "--dataRoot",
      dataRoot,
    ],
    cwd: stDir,
    stdout: "piped",
    stderr: "piped",
  });
  const child = command.spawn();
  // 服务端日志写入文件，避免管道缓冲塞满阻塞进程。
  const logFile = Deno.openSync(serverLog, {
    write: true,
    create: true,
    truncate: true,
  });
  child.stdout.pipeTo(logFile.writable, { preventClose: true }).catch(() => {});
  const errFile = Deno.openSync(`${serverLog}.err`, {
    write: true,
    create: true,
    truncate: true,
  });
  child.stderr.pipeTo(errFile.writable, { preventClose: true }).catch(() => {});
  console.log(`[transport] 服务端日志：${serverLog}`);
  return child;
}

async function waitForServer(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(BASE);
      if (response.status < 500) return;
    } catch {
      // 尚未就绪
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    "服务端启动超时，请查看 .research/transport/server.log(.err)",
  );
}

async function getCsrf() {
  // token 存在 cookie-session 中：需保存响应的会话 cookie 一并回传
  const response = await fetch(`${BASE}/csrf-token`);
  const data = await response.json();
  const cookies = response.headers.getSetCookie?.() ?? [];
  const cookie = cookies.map((c) => c.split(";")[0]).join("; ");
  if (!data?.token || cookie === "") {
    throw new Error(
      `获取 CSRF token 失败：${JSON.stringify({ data, cookies })}`,
    );
  }
  return { token: data.token as string, cookie };
}

async function generate(
  csrf: { token: string; cookie: string },
  session: string,
  stream: boolean,
) {
  const response = await fetch(
    `${BASE}/api/backends/chat-completions/generate`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": csrf.token,
        cookie: csrf.cookie,
      },
      body: JSON.stringify({
        chat_completion_source: "custom",
        custom_url: `http://127.0.0.1:${MOCK_PORT}/v1`,
        custom_include_headers: `x-opencode-session: "${session}"`,
        api_key: "sk-mock-not-real",
        model: "mock-model",
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 16,
        stream,
      }),
    },
  );
  return { status: response.status, text: await response.text() };
}

function assertSession(
  captured: { path: string; session: string | null }[],
  expected: string,
  label: string,
) {
  const hit = captured.filter((r) =>
    r.path.includes("chat/completions") && r.session === expected
  );
  if (hit.length === 0) {
    throw new Error(
      `${label}：模拟上游未收到期望的 x-opencode-session=${expected}；实际记录：${
        JSON.stringify(captured)
      }`,
    );
  }
  console.log(
    `[transport] PASS ${label}：上游收到 x-opencode-session=${expected}`,
  );
}

const results = {
  stream: false,
  nonstream: false,
  error: null as string | null,
};
const mock = startMockServer({ port: MOCK_PORT });
let server: Deno.ChildProcess | undefined;
try {
  await downloadSource();
  await installDependencies();
  server = startServer();
  console.log("[transport] 等待真实服务端启动…");
  await waitForServer();
  const csrf = await getCsrf();
  console.log("[transport] 服务端就绪，已取得 CSRF token");

  const nonstream = await generate(csrf, "sess-nonstream-1", false);
  console.log(
    `[transport] /generate 非流式：HTTP ${nonstream.status} ${
      nonstream.text.slice(0, 200)
    }`,
  );
  if (nonstream.status !== 200) {
    throw new Error(`非流式生成失败：${nonstream.text.slice(0, 400)}`);
  }
  assertSession(mock.captured, "sess-nonstream-1", "非流式");
  results.nonstream = true;

  const stream = await generate(csrf, "sess-stream-2", true);
  console.log(
    `[transport] /generate 流式：HTTP ${stream.status} ${
      stream.text.slice(0, 120)
    }`,
  );
  if (stream.status !== 200) {
    throw new Error(`流式生成失败：${stream.text.slice(0, 400)}`);
  }
  assertSession(mock.captured, "sess-stream-2", "流式");
  results.stream = true;
} catch (error) {
  results.error = String((error as Error)?.message ?? error);
  console.error(`[transport] FAIL：${results.error}`);
} finally {
  server?.kill();
  await server?.status.catch(() => {});
  mock.stop();
  await Deno.mkdir(root, { recursive: true });
  await Deno.writeTextFile(
    `${root}transport-results.json`,
    JSON.stringify(results, null, 2),
  );
  console.log(`[transport] 结果已写入 ${root}transport-results.json`);
}
Deno.exit(results.error ? 1 : 0);
