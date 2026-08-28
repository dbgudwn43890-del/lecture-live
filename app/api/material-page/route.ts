import { NextResponse } from "next/server";
import OpenAI from "openai";

import { isUuid } from "../../lib/billing";
import { checkSharedRateLimit } from "../../lib/rate-limit";
import { createAdminClient } from "../../lib/supabase/admin";
import { createClient } from "../../lib/supabase/server";

export const runtime = "nodejs";

/**
 * 표시 임계값. 검색 컨텍스트에 슬쩍 끼워 넣는 것과 달리, 여기서 넘긴 쪽은 화면에
 * 슬라이드로 뜬다. 틀린 쪽을 확신 있게 띄우는 것이 아무것도 안 띄우는 것보다
 * 나쁘므로 자신 없으면 비운다.
 * ponytail: 현장 실증 로그로 조정할 값. 지금은 검색 임계값과 같은 자리에서 시작한다.
 */
const MIN_SIMILARITY = 0.3;
const MAX_ANCHOR_CHARACTERS = 2_000;

/**
 * 지금 강의가 어느 슬라이드를 지나고 있는지 추정한다. 질문이 아니라 직전 강의
 * 발화로 검색하므로, 학습자가 아무것도 묻지 않는 동안에도 슬라이드가 강의를
 * 따라갈 수 있다.
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const isEnglish = request.headers.get("x-site-locale") === "en";
  if (!user) return NextResponse.json({ error: isEnglish ? "Sign-in is required." : "로그인이 필요합니다." }, { status: 401 });

  const rateLimit = await checkSharedRateLimit(`material-page:${user.id}`, 60, 60_000);
  if (!rateLimit.allowed) {
    return NextResponse.json({ page: null }, { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } });
  }

  let body: { classroomId?: unknown; anchor?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: isEnglish ? "Invalid request." : "올바른 요청이 아닙니다." }, { status: 400 });
  }

  const classroomId = isUuid(body.classroomId) ? body.classroomId : null;
  const anchor = typeof body.anchor === "string" ? body.anchor.slice(0, MAX_ANCHOR_CHARACTERS).trim() : "";
  // 근거가 없으면 추정하지 않는다. 호출자는 직전 쪽을 그대로 두면 된다.
  if (!classroomId || anchor.length < 40) return NextResponse.json({ page: null });

  const admin = createAdminClient();
  const apiKey = process.env.OPENAI_API_KEY;
  if (!admin || !apiKey) return NextResponse.json({ page: null });

  try {
    const openai = new OpenAI({ apiKey, timeout: 15_000, maxRetries: 1 });
    const embedding = await openai.embeddings.create({ model: "text-embedding-3-small", input: anchor });
    const { data, error } = await admin.rpc("match_material_chunks", {
      p_user_id: user.id,
      p_classroom_id: classroomId,
      p_query_embedding: embedding.data[0].embedding,
      p_match_count: 1,
    });
    if (error) throw error;

    const best = Array.isArray(data) ? data[0] : null;
    if (!best || Number(best.similarity) < MIN_SIMILARITY) return NextResponse.json({ page: null });

    return NextResponse.json({
      page: {
        documentId: String(best.document_id),
        filename: String(best.filename),
        startPage: Number(best.start_page),
        endPage: Number(best.end_page),
      },
    });
  } catch (error) {
    // 슬라이드 추종은 보조 기능이다. 실패해도 강의 화면은 그대로 굴러가야 한다.
    console.error("Material page lookup failed", error && typeof error === "object" && "status" in error ? error.status : "unknown");
    return NextResponse.json({ page: null });
  }
}
