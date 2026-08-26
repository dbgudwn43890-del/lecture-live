import type { SupabaseClient } from "@supabase/supabase-js";
import type { User } from "@supabase/supabase-js";

export async function getClassroomData(supabase: SupabaseClient, user: User) {
  const [{ data: classrooms, error: classroomError }, { data: sessions, error: sessionError }, { data: questions, error: questionError }] = await Promise.all([
    supabase.from("classrooms").select("id,title,locale,created_at,updated_at").order("updated_at", { ascending: false }),
    supabase.from("lecture_sessions").select("id,classroom_id,title,status,started_at,ended_at,duration_seconds").order("started_at", { ascending: false }),
    supabase.from("lecture_questions").select("session_id"),
  ]);

  if (classroomError || sessionError || questionError) {
    return { error: classroomError?.code ?? sessionError?.code ?? questionError?.code ?? "unknown" };
  }

  const questionCounts = new Map<string, number>();
  for (const question of questions ?? []) {
    questionCounts.set(question.session_id, (questionCounts.get(question.session_id) ?? 0) + 1);
  }

  const withQuestionCounts = (sessions ?? []).map((session) => ({
    ...session,
    question_count: questionCounts.get(session.id) ?? 0,
  }));

  return {
    profile: {
      displayName: typeof user.user_metadata.full_name === "string"
        ? user.user_metadata.full_name
        : user.email?.split("@")[0] ?? "Lecue",
      email: user.email ?? "",
    },
    classrooms: (classrooms ?? []).map((classroom) => ({
      ...classroom,
      sessions: withQuestionCounts.filter((session) => session.classroom_id === classroom.id),
    })),
    unassignedSessions: withQuestionCounts.filter((session) => session.classroom_id === null),
  };
}
