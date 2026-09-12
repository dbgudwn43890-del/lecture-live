import type { Metadata } from "next";

import LandingPage from "../landing-page";
import { getCreditStatus } from "../lib/credit-status";
import { getLandingProfile } from "../lib/landing-profile";
import { createClient } from "../lib/supabase/server";

export const metadata: Metadata = {
  title: "Lecue | Ask about the lecture as you learn",
  description: "Record your lecture, ask about the part you missed, and revisit your questions with the lecture context.",
};

export default async function EnglishLandingPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const creditStatus = user ? await getCreditStatus(supabase) : null;
  return (
    <LandingPage
      locale="en"
      isAuthenticated={Boolean(user)}
      profile={getLandingProfile(user)}
      creditStatus={creditStatus && !("error" in creditStatus) ? creditStatus : null}
    />
  );
}
