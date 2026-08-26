import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

// Built from the locale rather than hardcoded, so /en/classroom, /en/billing
// and /en/classrooms — none of which export metadata of their own — stop
// showing a Korean description in an English speaker's tab and shares.
export async function generateMetadata(): Promise<Metadata> {
  const isEnglish = (await headers()).get("x-site-locale") === "en";
  const description = isEnglish
    ? "Lecue transcribes in-person lectures in real time and answers questions from the lecture context captured so far."
    : "Lecue는 현장 강의를 실시간으로 기록하고 강의 맥락을 바탕으로 질문에 답하는 학습 서비스입니다.";

  return {
    metadataBase: new URL("https://www.lecue.app"),
    applicationName: "Lecue",
    title: "Lecue",
    description,
    openGraph: {
      type: "website",
      siteName: "Lecue",
      title: "Lecue",
      description,
      url: isEnglish ? "/en" : "/",
    },
  };
}

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const locale = (await headers()).get("x-site-locale") === "en" ? "en" : "ko";
  return (
    <html lang={locale}>
      <body>{children}</body>
    </html>
  );
}
