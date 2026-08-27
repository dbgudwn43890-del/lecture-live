import type { Metadata } from "next";
import { headers } from "next/headers";
import localFont from "next/font/local";
import "./globals.css";

// globals.css names "Pretendard" in its font stack, but nothing ever loaded it —
// no @font-face, no next/font call, no file under public/ — so every page rendered
// in the browser's default sans-serif. Self-host the variable font here instead of
// pulling it from a CDN, per next/font's built-in self-hosting.
// Font: Pretendard Variable v1.3.9 (SIL Open Font License 1.1), see app/fonts/PRETENDARD-LICENSE.txt.
// Weight range matches the upstream @font-face declaration (45 920).
const pretendard = localFont({
  src: "./fonts/PretendardVariable.woff2",
  variable: "--font-pretendard",
  weight: "45 920",
  display: "swap",
  fallback: ["SUIT", "Noto Sans KR", "system-ui", "sans-serif"],
});

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
    <html lang={locale} className={pretendard.variable}>
      <body>{children}</body>
    </html>
  );
}
