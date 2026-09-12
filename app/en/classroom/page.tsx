import { getSiteRegion } from "../../lib/site-region";
import { redirect } from "next/navigation";

import LectureWorkspace from "../../classroom/workspace-client";
import { getClassroomData } from "../../lib/classroom-data";
import { getCreditStatus } from "../../lib/credit-status";
import { ensureFreePilotGrant } from "../../lib/free-pilot";
import { createClient } from "../../lib/supabase/server";
import { hasVerifiedEmail } from "../../lib/verified-email";
import { canUseLiveAssist } from "../../lib/live-assist-access";

export default async function EnglishClassroomPage() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !hasVerifiedEmail(user)) {
    redirect(`/en/login?${user && !authError ? "error=unverified&" : ""}next=%2Fen%2Fclassroom`);
  }

  let [data, creditStatus] = await Promise.all([
    getClassroomData(supabase, user),
    getCreditStatus(supabase),
  ]);

  // 피드백 기간 무료 크레딧. ko 페이지와 같은 멱등 지급 — 여기만 빠져 있어
  // 영어로 첫 진입한 새 계정이 0크레딧으로 시작했다.
  if (!("error" in creditStatus) && creditStatus.latestGrantAt === null) {
    if (await ensureFreePilotGrant(user.id)) creditStatus = await getCreditStatus(supabase);
  }

  return (
    <LectureWorkspace
      region={await getSiteRegion()}
      locale="en"
      liveAssistAvailable={canUseLiveAssist(user)}
      initial={{
        profile: "error" in data ? null : data.profile,
        classrooms: "error" in data ? [] : data.classrooms,
        unassignedSessions: "error" in data ? [] : data.unassignedSessions,
        creditStatus: "error" in creditStatus ? null : creditStatus,
      }}
    />
  );
}
