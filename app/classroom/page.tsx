import { headers } from "next/headers";

import LectureWorkspace from "./workspace-client";
import { getClassroomData } from "../lib/classroom-data";
import { getCreditStatus } from "../lib/credit-status";
import { FREE_PILOT, FREE_PILOT_CREDITS } from "../lib/free-pilot";
import { createAdminClient } from "../lib/supabase/admin";
import { createClient } from "../lib/supabase/server";

export default async function ClassroomPage() {
  // The proxy resolves locale from the site-locale cookie and the root layout
  // renders <html lang> from it, so hardcoding "ko" here produced an English
  // lang attribute wrapping an entirely Korean workspace.
  const locale = (await headers()).get("x-site-locale") === "en" ? "en" : "ko";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return <LectureWorkspace locale={locale} />;

  let [data, creditStatus] = await Promise.all([
    getClassroomData(supabase, user),
    getCreditStatus(supabase),
  ]);

  // 피드백 기간: 그랜트가 하나도 없는 새 계정에 무료 크레딧을 심는다.
  // 웹훅과 같은 (source_type, source_id) 멱등 upsert라 새로고침에도 한 번만 들어간다.
  if (FREE_PILOT && !("error" in creditStatus) && creditStatus.latestGrantAt === null) {
    const admin = createAdminClient();
    if (admin) {
      const now = Date.now();
      await admin.from("credit_grants").upsert({
        user_id: user.id,
        source_type: "trial",
        source_id: user.id,
        plan_code: "trial",
        granted_credits: FREE_PILOT_CREDITS,
        remaining_credits: FREE_PILOT_CREDITS,
        starts_at: new Date(now).toISOString(),
        expires_at: new Date(now + 180 * 24 * 60 * 60 * 1000).toISOString(),
      }, { onConflict: "source_type,source_id", ignoreDuplicates: true });
      creditStatus = await getCreditStatus(supabase);
    }
  }

  return (
    <LectureWorkspace
      locale={locale}
      initial={{
        profile: "error" in data ? null : data.profile,
        classrooms: "error" in data ? [] : data.classrooms,
        unassignedSessions: "error" in data ? [] : data.unassignedSessions,
        creditStatus: "error" in creditStatus ? null : creditStatus,
      }}
    />
  );
}
