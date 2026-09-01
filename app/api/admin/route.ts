import { NextResponse } from "next/server";

import { getAuthenticatedUserId } from "../../lib/auth";
import { isUuid } from "../../lib/billing";
import { createAdminClient } from "../../lib/supabase/admin";

export const runtime = "nodejs";

/**
 * 운영자 콘솔 API. ADMIN_EMAILS(쉼표 구분)에 적힌 계정만 통과한다.
 * GET  — 전체 사용자와 남은 크레딧·수업 수 목록.
 * POST — { userId, credits, days? } 로 service_credit 지급.
 *        credit_grants의 source_type='service_credit'은 스키마가 처음부터
 *        수동 지급용으로 정의해 둔 값이라 마이그레이션이 필요 없다.
 */
async function requireAdmin() {
  const userId = await getAuthenticatedUserId();
  const admin = createAdminClient();
  if (!userId || !admin) return null;
  const allowed = (process.env.ADMIN_EMAILS ?? "")
    .split(",").map((email) => email.trim().toLowerCase()).filter(Boolean);
  if (!allowed.length) return null;
  const { data } = await admin.auth.admin.getUserById(userId);
  const email = data.user?.email?.toLowerCase();
  return email && allowed.includes(email) ? admin : null;
}

export async function GET() {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "권한이 없습니다." }, { status: 403 });

  // ponytail: 페이지네이션 없이 첫 1,000명. 사용자가 그보다 많아지는 날
  // perPage 루프를 돈다 — 그날은 좋은 날이다.
  const [{ data: userData, error: userError }, { data: grants }, { data: sessions }] = await Promise.all([
    admin.auth.admin.listUsers({ page: 1, perPage: 1000 }),
    admin.from("credit_grants")
      .select("user_id, remaining_credits, expires_at, revoked_at")
      .gt("remaining_credits", 0)
      .is("revoked_at", null)
      .gt("expires_at", new Date().toISOString()),
    admin.from("lecture_sessions").select("user_id, started_at"),
  ]);
  if (userError) return NextResponse.json({ error: userError.message }, { status: 502 });

  const creditsByUser = new Map<string, number>();
  for (const grant of grants ?? []) {
    creditsByUser.set(grant.user_id, (creditsByUser.get(grant.user_id) ?? 0) + grant.remaining_credits);
  }
  const sessionsByUser = new Map<string, { count: number; lastAt: string }>();
  for (const session of sessions ?? []) {
    const current = sessionsByUser.get(session.user_id) ?? { count: 0, lastAt: "" };
    current.count += 1;
    if (session.started_at > current.lastAt) current.lastAt = session.started_at;
    sessionsByUser.set(session.user_id, current);
  }

  return NextResponse.json({
    users: userData.users.map((user) => ({
      id: user.id,
      email: user.email,
      name: (user.user_metadata as { full_name?: string; name?: string })?.full_name
        ?? (user.user_metadata as { name?: string })?.name ?? "",
      createdAt: user.created_at,
      credits: creditsByUser.get(user.id) ?? 0,
      sessionCount: sessionsByUser.get(user.id)?.count ?? 0,
      lastSessionAt: sessionsByUser.get(user.id)?.lastAt || null,
    })).sort((a, b) => (b.lastSessionAt ?? "").localeCompare(a.lastSessionAt ?? "")),
  }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "권한이 없습니다." }, { status: 403 });

  const body = await request.json().catch(() => ({})) as { userId?: unknown; credits?: unknown; days?: unknown };
  const credits = Number(body.credits);
  const days = Number(body.days ?? 60);
  if (!isUuid(body.userId) || !Number.isInteger(credits) || credits < 1 || credits > 100_000
    || !Number.isInteger(days) || days < 1 || days > 365) {
    return NextResponse.json({ error: "지급 값을 확인해 주세요." }, { status: 400 });
  }

  const now = new Date();
  const { error } = await admin.from("credit_grants").insert({
    user_id: body.userId,
    source_type: "service_credit",
    source_id: `admin-${crypto.randomUUID()}`,
    plan_code: "service_credit",
    granted_credits: credits,
    remaining_credits: credits,
    starts_at: now.toISOString(),
    expires_at: new Date(now.getTime() + days * 86_400_000).toISOString(),
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 502 });
  return NextResponse.json({ ok: true });
}
