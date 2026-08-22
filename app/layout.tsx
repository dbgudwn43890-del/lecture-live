import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export const metadata: Metadata = {
  title: "Lecue",
  description: "현장 강의를 실시간으로 기록하고 강의 맥락으로 질문하는 서비스",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const locale = (await headers()).get("x-site-locale") === "en" ? "en" : "ko";
  return (
    <html lang={locale}>
      <body>{children}</body>
    </html>
  );
}
