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

  // 소켓은 여는데 스크립트는 안 남기는 사용자를 찾는 남용 신호 창(최근 7일).
  // 정상 수업은 몇 초마다 한 문장씩 저장한다 — 분당 수십 개. 소켓만 열고
  // 저장이 ~0이면 오디오만 흘려보내고 미터를 피한 것이다.
  const ABUSE_WINDOW_MS = 7 * 86_400_000;
  const since = new Date(Date.now() - ABUSE_WINDOW_MS).toISOString();
  // ponytail: 페이지네이션 없이 첫 1,000명. 사용자가 그보다 많아지는 날
  // perPage 루프를 돈다 — 그날은 좋은 날이다.
  const [{ data: userData, error: userError }, { data: grants }, { data: sessions }, { data: signals }] = await Promise.all([
    admin.auth.admin.listUsers({ page: 1, perPage: 1000 }),
    admin.from("credit_grants")
      .select("user_id, remaining_credits, expires_at, revoked_at")
      .gt("remaining_credits", 0)
      .is("revoked_at", null)
      .gt("expires_at", new Date().toISOString()),
    admin.from("lecture_sessions").select("user_id, started_at"),
    // transcript_segments는 최대 볼륨 테이블이라 앱에서 세면 PostgREST의 1,000행
    // 상한에 잘려 오히려 헤비 유저가 남용자처럼 보인다. 집계는 Postgres에서.
    admin.rpc("admin_abuse_signals", { p_since: since }),
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
  const signalsByUser = new Map<string, { socketsOpened: number; segmentsSaved: number }>();
  for (const signal of (signals ?? []) as { user_id: string; sockets_opened: number; segments_saved: number }[]) {
    signalsByUser.set(signal.user_id, { socketsOpened: signal.sockets_opened, segmentsSaved: signal.segments_saved });
  }

  // 최소 3번은 소켓을 열었고, 소켓당 평균 5문장에도 못 미치면 남용 의심. 정상
  // 수업은 1분만 녹음해도 수십 문장을 남기므로 우발적 오조작 한두 번은 안 걸린다.
  const MIN_SOCKETS_TO_FLAG = 3;
  const MIN_SEGMENTS_PER_SOCKET = 5;
  function flagged(signal: { socketsOpened: number; segmentsSaved: number }): boolean {
    return signal.socketsOpened >= MIN_SOCKETS_TO_FLAG
      && signal.segmentsSaved < signal.socketsOpened * MIN_SEGMENTS_PER_SOCKET;
  }

  return NextResponse.json({
    users: userData.users.map((user) => {
      const signal = signalsByUser.get(user.id) ?? { socketsOpened: 0, segmentsSaved: 0 };
      return {
        id: user.id,
        email: user.email,
        name: (user.user_metadata as { full_name?: string; name?: string })?.full_name
          ?? (user.user_metadata as { name?: string })?.name ?? "",
        createdAt: user.created_at,
        credits: creditsByUser.get(user.id) ?? 0,
        sessionCount: sessionsByUser.get(user.id)?.count ?? 0,
        lastSessionAt: sessionsByUser.get(user.id)?.lastAt || null,
        socketsOpened: signal.socketsOpened,
        segmentsSaved: signal.segmentsSaved,
        abuseFlag: flagged(signal),
      };
    }).sort((a, b) => {
      // 의심 계정을 맨 위로, 그 다음은 기존대로 최근 수업 순.
      if (a.abuseFlag !== b.abuseFlag) return a.abuseFlag ? -1 : 1;
      return (b.lastSessionAt ?? "").localeCompare(a.lastSessionAt ?? "");
    }),
  }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "권한이 없습니다." }, { status: 403 });

  const body = await request.json().catch(() => ({})) as { userId?: unknown; credits?: unknown; days?: unknown; key?: unknown };
  const credits = Number(body.credits);
  const days = Number(body.days ?? 60);
  if (!isUuid(body.userId) || !isUuid(body.key) || !Number.isInteger(credits) || credits < 1 || credits > 100_000
    || !Number.isInteger(days) || days < 1 || days > 365) {
    return NextResponse.json({ error: "지급 값을 확인해 주세요." }, { status: 400 });
  }

  const now = new Date();
  const { error } = await admin.from("credit_grants").insert({
    user_id: body.userId,
    source_type: "service_credit",
    // 클릭이 만든 멱등키가 곧 source_id다. 같은 요청이 두 번 오면(더블클릭,
    // 응답 유실 뒤 재전송) unique (source_type, source_id)가 두 번째를 막는다.
    source_id: `admin-${body.key}`,
    plan_code: "service_credit",
    granted_credits: credits,
    remaining_credits: credits,
    // DB의 now()와 앱 시계가 어긋나도 방금 준 크레딧이 보이도록 몇 초 물린다.
    starts_at: new Date(now.getTime() - 10_000).toISOString(),
    expires_at: new Date(now.getTime() + days * 86_400_000).toISOString(),
  });
  // 23505 = 이미 처리된 같은 지급. 성공으로 답해 재전송 루프를 끝낸다.
  if (error && error.code !== "23505") return NextResponse.json({ error: error.message }, { status: 502 });
  return NextResponse.json({ ok: true });
}
