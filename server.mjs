import { createHash } from "node:crypto";
import http from "node:http";
import { pathToFileURL } from "node:url";

const port = Number(process.env.PORT || 8787);
const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
const model = process.env.DEEPSEEK_MODEL?.trim() || "deepseek-v4-flash";
const endpoint = process.env.DEEPSEEK_API_URL?.trim() || "https://api.deepseek.com/chat/completions";
const trustProxy = process.env.TRUST_PROXY === "true" || Boolean(process.env.VERCEL);
const cache = new Map();
const requestsByIp = new Map();

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT = 30;
const MAX_BODY_BYTES = 512_000;
const MAX_README_CHARS = 60_000;
export const INSIGHT_SCHEMA_VERSION = 4;

function json(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    let bytes = 0;
    let tooLarge = false;
    request.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        tooLarge = true;
        body = "";
        return;
      }
      if (!tooLarge) body += chunk;
    });
    request.on("end", () => {
      if (tooLarge) return reject(new Error("payload_too_large"));
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("invalid_json"));
      }
    });
    request.on("error", reject);
  });
}

function requestIp(request) {
  if (trustProxy) {
    const forwarded = request.headers["x-forwarded-for"];
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(",")[0];
    if (first?.trim()) return first.trim();
  }
  return request.socket.remoteAddress || "unknown";
}

function allowRequest(ip, now = Date.now()) {
  const recent = (requestsByIp.get(ip) || []).filter((time) => now - time < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) return false;
  recent.push(now);
  requestsByIp.set(ip, recent);
  return true;
}

export function parseModelJson(content) {
  if (typeof content !== "string") throw new Error("empty_model_response");
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("invalid_model_json");
  return JSON.parse(cleaned.slice(start, end + 1));
}

function normalizedText(value, fallback, maxLength = 600) {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, maxLength)
    : fallback;
}

function normalizedList(value, maxItems = 5, maxLength = 240) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item) => typeof item === "string")
    .map((item) => item.trim().slice(0, maxLength))
    .filter(Boolean))]
    .slice(0, maxItems);
}

export function normalizeInsight(value, modelName = model) {
  const source = value && typeof value === "object" ? value : {};
  const score = Number(source.score);
  return {
    oneLiner: normalizedText(source.oneLiner, "README 未提供足够信息以生成项目概述。", 300),
    capabilities: normalizedList(source.capabilities),
    audience: normalizedText(source.audience, "希望快速了解该开源项目的开发者。", 400),
    strengths: normalizedText(source.strengths, "请结合 README 中的公开信息理解项目特点。"),
    limitations: normalizedText(source.limitations, "README 未覆盖的能力、兼容性和部署条件需要进一步确认。"),
    score: Number.isFinite(score) ? Math.max(1, Math.min(10, Math.round(score))) : 5,
    evidence: normalizedText(source.evidence, "解读仅依据本次提交的 README 与仓库公开元数据生成。", 800),
    readmeHighlights: normalizedList(source.readmeHighlights, 8, 800),
    modelVersion: `${modelName}-zh-insight-v4`,
  };
}

export function validateInput(input) {
  if (!input || typeof input !== "object") throw new Error("invalid_request");
  const repository = typeof input.repository === "string" ? input.repository.trim() : "";
  const repositoryUrl = typeof input.repositoryUrl === "string" ? input.repositoryUrl.trim() : "";
  const readme = typeof input.readme === "string" ? input.readme.trim() : "";
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository) || !readme) throw new Error("invalid_request");

  let url;
  try {
    url = new URL(repositoryUrl);
  } catch {
    throw new Error("invalid_request");
  }
  const urlRepository = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || urlRepository.toLowerCase() !== repository.toLowerCase()) {
    throw new Error("invalid_request");
  }

  return {
    repository,
    repositoryUrl: url.toString(),
    language: normalizedText(input.language, "未标注", 80),
    topics: normalizedList(input.topics, 20, 80),
    readme: readme.slice(0, MAX_README_CHARS),
  };
}

export function createCacheKey(input) {
  return createHash("sha256")
    .update(`${INSIGHT_SCHEMA_VERSION}\n${input.repository}\n${input.readme}`)
    .digest("hex");
}

async function generateInsight(input) {
  if (!apiKey) throw new Error("gateway_not_configured");
  const prompt = `请仅依据以下公开 GitHub 仓库元数据和 README，用简体中文生成结构化技术解读。不得臆造 README 中不存在的功能，不得把学习优先级描述为安全、质量或生产可用性保证。证据不足时必须明确说明。只返回 JSON，不要 Markdown。

JSON 格式：
{
  "oneLiner": "一句中文项目概述",
  "capabilities": ["核心能力 1", "核心能力 2"],
  "audience": "适用人群与使用前提",
  "strengths": "有公开证据支持的优势",
  "limitations": "限制、前提、风险或证据缺口",
  "score": 1,
  "evidence": "结论对应的 README 章节或公开元数据",
  "readmeHighlights": [
    "【核心定位】用 2-4 句说明项目解决的问题、关键概念与工作方式",
    "【主要能力】列出 README 明确说明的核心能力及其作用",
    "【快速开始】保留必要的安装命令、初始化步骤和最小可运行示例",
    "【关键配置】说明环境变量、配置文件、运行参数及默认行为",
    "【使用方式】概括核心 API、CLI、SDK 或典型调用流程，保留短代码片段",
    "【架构与依赖】说明组件关系、运行时、外部服务、数据库或模型依赖",
    "【部署与集成】整理部署方式、平台要求以及可接入的生态系统",
    "【注意事项】说明 README 明示的兼容性、限制、前置条件和风险"
  ]
}

readmeHighlights 要优先覆盖上述 8 个章节；README 确无证据的章节可以省略，但至少输出 5 条。
每条应包含具体事实，通常 80-250 个中文字符；命令或短代码可用行内文本保留。不要重复顶部概述中的空泛结论。

仓库：${input.repository}
仓库链接：${input.repositoryUrl}
主要语言：${input.language}
公开话题：${input.topics.join(", ") || "无"}
README：
${input.readme}`;

  const upstream = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "你是严谨的中文开源项目技术分析助手，只能根据给定证据作答。" },
        { role: "user", content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!upstream.ok) throw new Error(`upstream_${upstream.status}`);
  const payload = await upstream.json();
  return normalizeInsight(parseModelJson(payload.choices?.[0]?.message?.content), model);
}

export async function handleGatewayRequest(request, response, pathOverride) {
    const url = new URL(pathOverride || request.url || "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/health") {
      return json(response, 200, {
        ok: Boolean(apiKey),
        configured: Boolean(apiKey),
        model,
        schemaVersion: INSIGHT_SCHEMA_VERSION,
      });
    }
    if (request.method !== "POST" || url.pathname !== "/v1/insights") {
      return json(response, 404, { error: "not_found" });
    }
    if (!apiKey) return json(response, 503, { error: "gateway_not_configured" });

    const ip = requestIp(request);
    if (!allowRequest(ip)) return json(response, 429, { error: "rate_limited" });

    try {
      const input = validateInput(await readJson(request));
      const key = createCacheKey(input);
      const cached = cache.get(key);
      if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) {
        return json(response, 200, cached.value);
      }
      const value = await generateInsight(input);
      cache.set(key, { value, createdAt: Date.now() });
      return json(response, 200, value);
    } catch (error) {
      if (error.message === "payload_too_large") return json(response, 413, { error: "payload_too_large" });
      if (["invalid_json", "invalid_request"].includes(error.message)) {
        return json(response, 400, { error: error.message });
      }
      console.error("insight generation failed", error.message);
      return json(response, 502, { error: "insight_unavailable" });
    }
}

export function createGatewayServer() {
  return http.createServer(handleGatewayRequest);
}

// Vercel's generic Node runtime loads the root server module as a function.
// Keeping this default export also preserves the standalone Node entrypoint below.
export default handleGatewayRequest;

export function startGateway() {
  return createGatewayServer().listen(port, () => {
    console.log(`DevPulse insight gateway listening on :${port}`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startGateway();
}
