import { NextResponse } from "next/server";

import { getAuthenticatedUserId } from "../../lib/auth";
import {
  isAllowedPersonalModel,
  isPersonalProvider,
  type PersonalProvider,
} from "../../lib/llm-models";
import { checkSharedRateLimit } from "../../lib/rate-limit";
import { createAdminClient } from "../../lib/supabase/admin";

export const runtime = "nodejs";

type CredentialBody = {
  provider?: unknown;
  model?: unknown;
  apiKey?: unknown;
  locale?: unknown;
};

function isEnglishRequest(request: Request) {
  return request.headers.get("x-site-locale") === "en";
}

function unavailable(request: Request) {
  return NextResponse.json(
    { error: isEnglishRequest(request)
      ? "API key storage has not been configured yet."
      : "API 키 저장 기능이 아직 설정되지 않았습니다." },
    { status: 503 },
  );
}

async function authenticatedAdmin(request: Request) {
  const userId = await getAuthenticatedUserId();
  if (!userId) return { response: NextResponse.json({ error: isEnglishRequest(request) ? "Sign-in is required." : "로그인이 필요합니다." }, { status: 401 }) };
  // The only authenticated route that had no shared limit — PUT reaches the
  // Vault write RPC.
  const rateLimit = await checkSharedRateLimit(`llm-credentials:${userId}`, 20, 60_000);
  if (!rateLimit.allowed) {
    return { response: NextResponse.json(
      { error: isEnglishRequest(request) ? "Too many requests. Try again shortly." : "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요." },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } },
    ) };
  }
  const admin = createAdminClient();
  if (!admin) return { response: unavailable(request) };
  return { userId, admin };
}

export async function GET(request: Request) {
  const context = await authenticatedAdmin(request);
  if ("response" in context) return context.response;

  const { data, error } = await context.admin.rpc("list_user_llm_credentials", {
    p_user_id: context.userId,
  });
  if (error) {
    console.error("Credential metadata read failed", error.code);
    return NextResponse.json({ error: "저장된 API 키 정보를 불러오지 못했습니다." }, { status: 500 });
  }

  return NextResponse.json({ credentials: data ?? [] });
}

export async function PUT(request: Request) {
  const context = await authenticatedAdmin(request);
  if ("response" in context) return context.response;

  let body: CredentialBody;
  try {
    body = (await request.json()) as CredentialBody;
  } catch {
    return NextResponse.json({ error: "요청 형식이 올바르지 않습니다." }, { status: 400 });
  }

  const provider = body.provider;
  const isEnglish = body.locale === "en";
  const model = typeof body.model === "string" ? body.model : "";
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (
    !isPersonalProvider(provider) ||
    !isAllowedPersonalModel(provider, model) ||
    apiKey.length < 10 ||
    apiKey.length > 512 ||
    /[\r\n]/.test(apiKey)
  ) {
    return NextResponse.json({ error: isEnglish
      ? "Check the provider, model, and API key."
      : "공급자, 모델 또는 API 키를 확인해 주세요." }, { status: 400 });
  }

  const { error } = await context.admin.rpc("save_user_llm_credential", {
    p_user_id: context.userId,
    p_provider: provider,
    p_model: model,
    p_api_key: apiKey,
  });
  if (error) {
    console.error("Credential save failed", error.code);
    return NextResponse.json({ error: isEnglish ? "Could not save the API key." : "API 키를 저장하지 못했습니다." }, { status: 500 });
  }

  return NextResponse.json({ provider, model });
}

export async function DELETE(request: Request) {
  const context = await authenticatedAdmin(request);
  if ("response" in context) return context.response;

  let body: CredentialBody;
  try {
    body = (await request.json()) as CredentialBody;
  } catch {
    return NextResponse.json({ error: "요청 형식이 올바르지 않습니다." }, { status: 400 });
  }
  if (!isPersonalProvider(body.provider)) {
    return NextResponse.json({ error: "공급자를 확인해 주세요." }, { status: 400 });
  }

  const provider: PersonalProvider = body.provider;
  const isEnglish = body.locale === "en";
  const { error } = await context.admin.rpc("delete_user_llm_credential", {
    p_user_id: context.userId,
    p_provider: provider,
  });
  if (error) {
    console.error("Credential delete failed", error.code);
    return NextResponse.json({ error: isEnglish ? "Could not remove the saved API key." : "저장된 API 키를 삭제하지 못했습니다." }, { status: 500 });
  }

  return NextResponse.json({ provider });
}
