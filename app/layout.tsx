import type { Metadata } from "next";
import { headers } from "next/headers";
import { IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
// Pretendard as ~92 unicode-range subsets instead of one 2 MB file: a Korean page
// pulls only the ranges it actually renders (tens of KB), and the browser fetches
// more on demand. Self-hosted through the CSS pipeline so the woff2 come back
// content-hashed and immutably cached.
// Font: Pretendard Variable v1.3.9 (SIL Open Font License 1.1), see app/fonts/PRETENDARD-LICENSE.txt.
import "./fonts/pretendard.css";

// globals.css and two CSS modules asked for "IBM Plex Mono" while nothing loaded it,
// so those labels fell through to whatever ui-monospace resolves to. next/font
// self-hosts it at build time; --font-mono is what the stylesheets now name.
const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-mono",
  display: "swap",
});

// Built from the locale rather than hardcoded, so /en/classroom and /en/billing
// — neither of which exports metadata of its own — stop
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
    <html lang={locale} className={mono.variable}>
      <body>{children}</body>
    </html>
  );
}
