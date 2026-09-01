import type { SupabaseClient } from "@supabase/supabase-js";
import type { User } from "@supabase/supabase-js";

const SESSION_PAGE_SIZE = 500;

// PostgREST caps a single select at 1,000 rows regardless of `.limit()`. A
// user with more than one page of lecture history used to have their oldest
// lectures silently vanish from the classroom list once they crossed that
// cap. Page through with `.range()` so every session is still there.
async function fetchAllSessions(supabase: SupabaseClient) {
  const rows = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("lecture_sessions")
      .select("id,classroom_id,title,status,started_at,ended_at,duration_seconds,recorded_ms")
      .order("started_at", { ascending: false })
      // started_at alone is not unique, and a paginated read needs a total
      // order or sessions sharing a timestamp can straddle a page boundary
      // and be repeated or skipped.
      .order("id")
      .range(from, from + SESSION_PAGE_SIZE - 1);
    if (error) return { error };
    rows.push(...(data ?? []));
    if (!data || data.length < SESSION_PAGE_SIZE) break;
    from += SESSION_PAGE_SIZE;
  }
  return { rows };
}

export async function getClassroomData(supabase: SupabaseClient, user: User) {
  const [{ data: classrooms, error: classroomError }, { rows: sessions, error: sessionError }, { data: questions, error: questionError }] = await Promise.all([
    supabase.from("classrooms").select("id,title,locale,glossary,created_at,updated_at").order("updated_at", { ascending: false }),
    fetchAllSessions(supabase),
    // Grouped in Postgres. Selecting every question row and tallying them here
    // grew without bound across semesters.
    supabase.from("lecture_question_counts").select("session_id,question_count"),
  ]);

  if (classroomError || sessionError || questionError) {
    return { error: classroomError?.code ?? sessionError?.code ?? questionError?.code ?? "unknown" };
  }

  const questionCounts = new Map<string, number>();
  for (const row of questions ?? []) {
    questionCounts.set(row.session_id, row.question_count);
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
