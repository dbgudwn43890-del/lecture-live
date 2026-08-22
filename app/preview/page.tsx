import type { Metadata } from "next";

import LandingPage from "../landing-page";

export const metadata: Metadata = {
  title: "Lecue | 현장 강의를 따라가는 실시간 조교",
  description: "현장 강의를 실시간으로 기록하고, 질문한 시점까지의 수업 맥락으로 눈높이에 맞게 설명합니다.",
};

export default function KoreanLandingPage() {
  return <LandingPage locale="ko" />;
}
