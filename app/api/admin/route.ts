import { NextResponse } from "next/server";
import { getAdminIdentity } from "../../lib/admin-access";
import { isUuid } from "../../lib/billing";
import { checkSharedRateLimit } from "../../lib/rate-limit";
import { createAdminClient } from "../../lib/supabase/admin";

export const runtime = "nodejs";
const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store", "Vary": "Cookie" } });

async function access(write: boolean) {
  const identity = await getAdminIdentity();
  if (!identity) return { error: reply({ error: "권한이 없습니다." }, 403) };
  const limit = await checkSharedRateLimit(`admin:${write ? "write" : "read"}:${identity.id}`, write ? 10 : 30, 60_000);
  if (!limit.allowed) return { error: reply({ error: "요청이 많습니다. 잠시 후 다시 시도하세요." }, 429) };
  const client = createAdminClient();
  if (!client) return { error: reply({ error: "관리자 서비스를 사용할 수 없습니다." }, 503) };
  return { identity, client };
}

export async function GET(request: Request) {
  try {
    const admin = await access(false);
    if (admin.error) return admin.error;
    const params = new URL(request.url).searchParams;
    const page = Number(params.get("page") ?? 1);
    const days = Number(params.get("days") ?? 7);
    const query = (params.get("q") ?? "").trim();
    if (!Number.isInteger(page) || page < 1 || page > 100_000 || ![7, 30, 90].includes(days) || query.length > 100) return reply({ error: "검색 조건을 확인하세요." }, 400);
    const { data, error } = await admin.client.rpc("admin_dashboard_service", { p_page: page, p_query: query, p_days: days });
    if (error || !data) return reply({ error: "운영 지표를 불러오지 못했습니다. 새로고침해 주세요." }, 502);
    return reply(data);
  } catch { return reply({ error: "관리자 서비스를 사용할 수 없습니다." }, 503); }
}

export async function POST(request: Request) {
  try {
    if (request.headers.get("origin") !== new URL(request.url).origin
      || request.headers.get("sec-fetch-site") === "cross-site") return reply({ error: "허용되지 않은 요청입니다." }, 403);
    if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") return reply({ error: "JSON 요청이 필요합니다." }, 415);
    const admin = await access(true);
    if (admin.error) return admin.error;
    const reader = request.body?.getReader();
    if (!reader) return reply({ error: "지급 내용을 확인하세요." }, 400);
    let text = ""; let bytes = 0;
    const decoder = new TextDecoder();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 4096) { await reader.cancel(); return reply({ error: "요청이 너무 큽니다." }, 413); }
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } finally { reader.releaseLock(); }
    let body;
    try { body = JSON.parse(text); } catch { return reply({ error: "지급 내용을 확인하세요." }, 400); }
    if (!body || !isUuid(body.userId) || !isUuid(body.key) || !Number.isInteger(body.credits) || body.credits < 1 || body.credits > 100_000
      || !Number.isInteger(body.days) || body.days < 1 || body.days > 365 || typeof body.reason !== "string" || body.reason.trim().length < 3 || body.reason.length > 200) return reply({ error: "대상·금액·기간·사유를 확인하세요." }, 400);
    const { data, error } = await admin.client.rpc("admin_grant_credits_service", {
      p_actor: admin.identity.id, p_user: body.userId, p_key: body.key, p_credits: body.credits, p_days: body.days, p_reason: body.reason.trim(),
    });
    if (error) return reply({ error: error.message === "IDEMPOTENCY_CONFLICT" ? "이 요청 번호로 다른 지급이 처리됐습니다. 새 요청으로 진행하세요." : "지급 결과를 확인하지 못했습니다. 같은 요청으로 재시도하세요." }, error.message === "IDEMPOTENCY_CONFLICT" ? 409 : 502);
    return reply({ ok: true, replayed: data?.replayed === true });
  } catch { return reply({ error: "지급 결과를 확인하지 못했습니다. 같은 요청으로 재시도하세요." }, 503); }
}
