import type { Metadata } from "next";
import PhoneMicrophonePage from "./phone-mic-client";
import { validPhoneRoom } from "../lib/phone-mic-wire";
import "./phone-mic.css";

export const metadata: Metadata = {
  title: "Phone microphone · Lecue",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function PhoneMicPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const locale = query.locale === "ko" ? "ko" : "en";
  const room = typeof query.room === "string" ? query.room : null;
  return <PhoneMicrophonePage roomId={validPhoneRoom(room) ? room : null} locale={locale} />;
}
