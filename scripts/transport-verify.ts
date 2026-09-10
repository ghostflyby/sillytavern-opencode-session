/**
 * 真实服务端转发验证（端到端，基于 npm 官方发布包）：
 *
 * 1. 在系统临时目录创建独立工程，`deno install` 安装 npm:sillytavern@1.18.0
 *    （精确版本；registry sha512 摘要由 Deno 自动校验），仓库内不产生任何文件；
 * 2. 断言安装的 package.json 版本与 verify:source 的 pinned commit 同一 release；
 * 3. 启动真实服务端（仅监听回环地址，临时数据目录）；
 * 4. 调用真实 /api/backends/chat-completions/generate（非流式与流式各一），
 *    断言模拟上游收到的 x-opencode-session 与请求体一致。
 *
 * 运行：deno task verify:transport
 */

import { startMockServer } from "../mock/server.ts";

const ST_VERSION = "1.18.0";
const ST_PORT = 18300;
const MOCK_PORT = 18301;
const BASE = `http://127.0.0.1:${ST_PORT}`;

const tmpRoot = `${
  (Deno.env.get("TMPDIR") ?? "/tmp").replace(/\/+$/, "")
}/st-ocs-transport`;
const workDir = `${tmpRoot}/app`;
const stDir = `${workDir}/node_modules/sillytavern`;

async function exists(path: string) {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function installSillyTavern() {
  if (await exists(`${stDir}/server.js`)) {
    console.log(
      `[transport] 复用已安装的 sillytavern@${ST_VERSION}（${stDir}）`,
    );
    return;
  }
  await Deno.mkdir(workDir, { recursive: true });
  await Deno.writeTextFile(
    `${workDir}/package.json`,
    JSON.stringify(
      { private: true, dependencies: { sillytavern: ST_VERSION } },
      null,
      2,
    ),
  );
  console.log(
    `[transport] deno install sillytavern@${ST_VERSION}（首次需数分钟）…`,
  );
  const install = new Deno.Command(Deno.execPath(), {
    args: ["install"],
    cwd: workDir,
    stdout: "inherit",
    stderr: "inherit",
  });
  const status = await install.output();
  if (!status.success) throw new Error("deno install 失败（见上方输出）");
  const pkg = JSON.parse(await Deno.readTextFile(`${stDir}/package.json`));
  if (pkg.version !== ST_VERSION) {
    throw new Error(
      `安装的 sillytavern 版本为 ${pkg.version}，期望 ${ST_VERSION}`,
    );
  }
  console.log(`[transport] sillytavern@${pkg.version} 安装完成`);
}

function startServer() {
  const dataRoot = `${tmpRoot}/data`;
  Deno.mkdirSync(dataRoot, { recursive: true });
  const serverLog = `${tmpRoot}/server.log`;
  const command = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "server.js",
      // npm 包自带 config.yaml 里 browserLaunch.enabled: true，会自动打开系统浏览器
      "--browserLaunchEnabled=false",
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
  throw new Error(`服务端启动超时，请查看 ${tmpRoot}/server.log(.err)`);
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
  await installSillyTavern();
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
  console.log(`[transport] 结果：${JSON.stringify(results)}`);
}
Deno.exit(results.error ? 1 : 0);
