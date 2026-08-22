import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://www.lecue.app"),
  applicationName: "Lecue",
  title: "Lecue",
  description: "Lecue는 현장 강의를 실시간으로 기록하고 강의 맥락을 바탕으로 질문에 답하는 학습 서비스입니다.",
  openGraph: {
    type: "website",
    siteName: "Lecue",
    title: "Lecue",
    description: "현장 강의를 실시간으로 기록하고 강의 맥락을 바탕으로 질문에 답하는 학습 서비스",
    url: "/",
  },
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const locale = (await headers()).get("x-site-locale") === "en" ? "en" : "ko";
  return (
    <html lang={locale}>
      <body>{children}</body>
    </html>
  );
}
