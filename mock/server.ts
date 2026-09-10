/**
 * 本地模拟上游（OpenAI-compatible），仅监听 127.0.0.1。
 *
 * 记录每个请求收到的 x-opencode-session header，用于验证 SillyTavern 服务端
 * 是否把 custom_include_headers 转发为真实上游 header。日志不含 API 密钥与
 * 消息正文。
 *
 * 直接运行：deno task mock          （默认端口 18101）
 * 作为模块：startMockServer({ port, hostname }) → { port, captured, stop }
 */

export function startMockServer({ port = 18101, hostname = "127.0.0.1" } = {}) {
  const captured: {
    at: string;
    method: string;
    path: string;
    session: string | null;
    stream: boolean;
    messageCount: number;
    model: string;
    hasAuth: boolean;
  }[] = [];

  async function handler(request: Request) {
    const url = new URL(request.url);
    const session = request.headers.get("x-opencode-session");
    let stream = false;
    let messageCount = 0;
    let model = "mock-model";
    if (request.method === "POST") {
      try {
        const body = await request.json();
        stream = body?.stream === true;
        messageCount = Array.isArray(body?.messages) ? body.messages.length : 0;
        model = typeof body?.model === "string" ? body.model : model;
      } catch {
        // 非 JSON 请求体按原样计数为 0
      }
    }
    const record = {
      at: new Date().toISOString(),
      method: request.method,
      path: url.pathname,
      session,
      stream,
      messageCount,
      model,
      hasAuth: request.headers.has("authorization"),
    };
    captured.push(record);
    console.log(JSON.stringify(record));

    if (url.pathname.endsWith("/models")) {
      return Response.json({
        object: "list",
        data: [{ id: model, object: "model" }],
      });
    }

    const id = `chatcmpl-${crypto.randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    if (stream) {
      const body = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          const chunk = (content: string) =>
            encoder.encode(
              `data: ${
                JSON.stringify({
                  id,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  choices: [{
                    index: 0,
                    delta: { content },
                    finish_reason: null,
                  }],
                })
              }\n\n`,
            );
          controller.enqueue(chunk("来自模拟上游"));
          controller.enqueue(chunk("。"));
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${
                JSON.stringify({
                  id,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                })
              }\n\n`,
            ),
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        },
      });
    }
    return Response.json({
      id,
      object: "chat.completion",
      created,
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "来自模拟上游的回复。" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  }

  const server = Deno.serve({ port, hostname, handler });
  return {
    port: (server.addr as Deno.NetAddr).port,
    captured,
    stop: () => server.shutdown(),
  };
}

if (import.meta.main) {
  const port = Number(Deno.args[0] ?? 18101);
  const mock = startMockServer({ port });
  console.log(
    `模拟上游已启动：http://127.0.0.1:${mock.port}/v1 （Ctrl+C 停止）`,
  );
  Deno.addSignalListener("SIGINT", () => {
    mock.stop();
    Deno.exit(0);
  });
}
