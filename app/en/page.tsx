import type { Metadata } from "next";

import LandingPage from "../landing-page";

export const metadata: Metadata = {
  title: "Lecue | A live assistant for in-person lectures",
  description: "Follow an in-person lecture as it is transcribed, then ask for a clear explanation grounded in everything said so far.",
};

export default function EnglishLandingPage() {
  return <LandingPage locale="en" />;
}
