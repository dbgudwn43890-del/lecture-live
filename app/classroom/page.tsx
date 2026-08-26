import LectureWorkspace from "./workspace-client";
import { getClassroomData } from "../lib/classroom-data";
import { getCreditStatus } from "../lib/credit-status";
import { getSttProvider } from "../lib/stt-provider";
import { createClient } from "../lib/supabase/server";

export default async function ClassroomPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return <LectureWorkspace locale="ko" sttProvider={getSttProvider()} />;

  const [data, creditStatus] = await Promise.all([
    getClassroomData(supabase, user),
    getCreditStatus(supabase),
  ]);

  return (
    <LectureWorkspace
      locale="ko"
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
