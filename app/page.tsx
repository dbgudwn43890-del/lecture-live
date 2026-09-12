import type { Metadata } from "next";
import { headers } from "next/headers";

import LandingPage from "./landing-page";
import { getCreditStatus } from "./lib/credit-status";
import { getLandingProfile } from "./lib/landing-profile";
import { createClient } from "./lib/supabase/server";

export async function generateMetadata(): Promise<Metadata> {
  const isEnglish = (await headers()).get("x-site-locale") === "en";
  return isEnglish
    ? {
        title: "Lecue | Ask about the lecture as you learn",
        description: "Record your lecture, ask about the part you missed, and revisit your questions with the lecture context.",
      }
    : {
        title: "Lecue | 지금 듣는 강의에 바로 물어보세요",
        description: "강의를 기록하고, 놓친 설명을 물어보세요. Lecue가 지금까지의 강의 맥락으로 답하고 질문과 기록을 함께 남겨 줍니다.",
      };
}

export default async function HomePage() {
  const locale = (await headers()).get("x-site-locale") === "en" ? "en" : "ko";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const creditStatus = user ? await getCreditStatus(supabase) : null;
  return (
    <LandingPage
      locale={locale}
      isAuthenticated={Boolean(user)}
      profile={getLandingProfile(user)}
      creditStatus={creditStatus && !("error" in creditStatus) ? creditStatus : null}
    />
  );
}
