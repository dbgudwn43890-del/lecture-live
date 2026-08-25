import type { Metadata } from "next";
import { redirect } from "next/navigation";

import LandingPage from "../landing-page";
import { createClient } from "../lib/supabase/server";

export const metadata: Metadata = {
  title: "Lecue | A live assistant for in-person lectures",
  description: "Follow an in-person lecture as it is transcribed, then ask for a clear explanation grounded in everything said so far.",
};

export default async function EnglishLandingPage() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  if (data?.claims) redirect("/en/classroom");
  return <LandingPage locale="en" />;
}
