import { getServerSideConfig } from "@/app/config/server";
import {
  DEEPSEEK_BASE_URL,
  ApiPath,
  ModelProvider,
  ServiceProvider,
} from "@/app/constant";
import { prettyObject } from "@/app/utils/format";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/app/api/auth";
import { isModelNotavailableInServer } from "@/app/utils/model";

const serverConfig = getServerSideConfig();

export async function handle(
  req: NextRequest,
  { params }: { params: { path: string[] } },
) {
  console.log("[DeepSeek Route] params ", params);

  if (req.method === "OPTIONS") {
    return NextResponse.json({ body: "OK" }, { status: 200 });
  }

  const authResult = auth(req, ModelProvider.DeepSeek);
  if (authResult.error) {
    return NextResponse.json(authResult, {
      status: 401,
    });
  }

  try {
    const response = await request(req);
    return response;
  } catch (e) {
    console.error("[DeepSeek] ", e);
    return NextResponse.json(prettyObject(e));
  }
}

async function request(req: NextRequest) {
  const controller = new AbortController();

  // alibaba use base url or just remove the path
  let path = `${req.nextUrl.pathname}`.replaceAll(ApiPath.DeepSeek, "");

  let baseUrl = serverConfig.deepseekUrl || DEEPSEEK_BASE_URL;

  if (!baseUrl.startsWith("http")) {
    baseUrl = `https://${baseUrl}`;
  }

  if (baseUrl.endsWith("/")) {
    baseUrl = baseUrl.slice(0, -1);
  }

  console.log("[Proxy] ", path);
  console.log("[Base Url]", baseUrl);

  const timeoutId = setTimeout(
    () => {
      controller.abort();
    },
    10 * 60 * 1000,
  );

  const fetchUrl = `${baseUrl}${path}`;
  const fetchOptions: RequestInit = {
    headers: {
      "Content-Type": "application/json",
      Authorization: req.headers.get("Authorization") ?? "",
    },
    method: req.method,
    body: req.body,
    redirect: "manual",
    // @ts-ignore
    duplex: "half",
    signal: controller.signal,
  };

  // #1815 try to refuse some request to some models
  if (serverConfig.customModels && req.body) {
    try {
      const clonedBody = await req.text();
      fetchOptions.body = clonedBody;

      const jsonBody = JSON.parse(clonedBody) as { model?: string };

      // not undefined and is false
      if (
        isModelNotavailableInServer(
          serverConfig.customModels,
          jsonBody?.model as string,
          ServiceProvider.DeepSeek as string,
        )
      ) {
        return NextResponse.json(
          {
            error: true,
            message: `you are not allowed to use ${jsonBody?.model} model`,
          },
          {
            status: 403,
          },
        );
      }
    } catch (e) {
      console.error(`[DeepSeek] filter`, e);
    }
  }
  try {
    const res = await fetch(fetchUrl, fetchOptions);

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const decoder = new TextDecoder();
    let buffer = "";
    let reasoningBuffer = "";
    const LOG_THRESHOLD = 32;

    (async () => {
      const reader = res.body?.getReader();
      if (!reader) return;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() || "";

        for (const chunk of chunks) {
          const lines = chunk
            .split("\n")
            .filter((line) => line.startsWith("data:"));
          for (const line of lines) {
            try {
              const jsonStr = line.replace(/^data: /, "").trim();
              if (jsonStr === "[DONE]") continue;

              const jsonData = JSON.parse(jsonStr);
              if (jsonData.choices?.[0]?.delta?.reasoning_content) {
                const reasoningContent =
                  jsonData.choices[0].delta.reasoning_content;

                reasoningBuffer += reasoningContent;
                if (reasoningBuffer.length >= LOG_THRESHOLD) {
                  const linesToLog = reasoningBuffer.split("\n");
                  for (let i = 0; i < linesToLog.length; i++) {
                    const line = linesToLog[i];
                    if (i === 0) {
                      console.log("[DeepSeek Reasoning]", line);
                    } else {
                      console.log("[DeepSeek Reasoning]", line);
                    }
                  }
                  reasoningBuffer = "";
                }
              }
            } catch (e) {
              // silently ignore
            }
          }
        }
        await writer.write(value);
      }
      if (reasoningBuffer.length > 0) {
        const linesToLog = reasoningBuffer.split("\n");
        for (let i = 0; i < linesToLog.length; i++) {
          const line = linesToLog[i];
          if (i === 0) {
            console.log("[DeepSeek Reasoning]", line);
          } else {
            console.log("[DeepSeek Reasoning]", line);
          }
        }
      }
      await writer.close();
    })();

    // to prevent browser prompt for credentials
    const newHeaders = new Headers(res.headers);
    newHeaders.delete("www-authenticate");
    // to disable nginx buffering
    newHeaders.set("X-Accel-Buffering", "no");

    return new Response(readable, {
      status: res.status,
      statusText: res.statusText,
      headers: newHeaders,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}
