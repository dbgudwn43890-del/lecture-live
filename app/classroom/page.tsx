import { headers } from "next/headers";

import LectureWorkspace from "./workspace-client";
import { getClassroomData } from "../lib/classroom-data";
import { getCreditStatus } from "../lib/credit-status";
import { getSttProvider } from "../lib/stt-provider";
import { createClient } from "../lib/supabase/server";

export default async function ClassroomPage() {
  // The proxy resolves locale from the site-locale cookie and the root layout
  // renders <html lang> from it, so hardcoding "ko" here produced an English
  // lang attribute wrapping an entirely Korean workspace.
  const locale = (await headers()).get("x-site-locale") === "en" ? "en" : "ko";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return <LectureWorkspace locale={locale} sttProvider={getSttProvider()} />;

  const [data, creditStatus] = await Promise.all([
    getClassroomData(supabase, user),
    getCreditStatus(supabase),
  ]);

  return (
    <LectureWorkspace
      locale={locale}
      sttProvider={getSttProvider()}
      initial={{
        profile: "error" in data ? null : data.profile,
        classrooms: "error" in data ? [] : data.classrooms,
        unassignedSessions: "error" in data ? [] : data.unassignedSessions,
        creditStatus: "error" in creditStatus ? null : creditStatus,
      }}
    />
  );
}
