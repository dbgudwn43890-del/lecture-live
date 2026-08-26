import type { Metadata } from "next";

import LandingPage from "../landing-page";
import { getCreditStatus } from "../lib/credit-status";
import { getLandingProfile } from "../lib/landing-profile";
import { createClient } from "../lib/supabase/server";

export const metadata: Metadata = {
  title: "Lecue | A live assistant for in-person lectures",
  description: "Follow an in-person lecture as it is transcribed, then ask for a clear explanation grounded in everything said so far.",
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
