import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import LandingPage from "./landing-page";
import { createClient } from "./lib/supabase/server";

export async function generateMetadata(): Promise<Metadata> {
  const isEnglish = (await headers()).get("x-site-locale") === "en";
  return isEnglish
    ? {
        title: "Lecue | A live assistant for in-person lectures",
        description: "Lecue transcribes in-person lectures in real time and answers questions using the lecture context captured so far.",
      }
    : {
        title: "Lecue | 현장 강의를 따라가는 실시간 조교",
        description: "Lecue는 현장 강의를 실시간으로 기록하고, 질문한 시점까지의 강의 맥락으로 눈높이에 맞게 답하는 학습 서비스입니다.",
      };
}

export default async function HomePage() {
  const locale = (await headers()).get("x-site-locale") === "en" ? "en" : "ko";
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  if (data?.claims) redirect(locale === "en" ? "/en/classroom" : "/classroom");
  return <LandingPage locale={locale} />;
}
