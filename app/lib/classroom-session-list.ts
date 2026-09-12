import type { SessionSummary } from "../classroom/use-lecture-recorder";

type Group = { id: string; sessions: SessionSummary[] };
export type ClassroomLists<C extends Group> = { classrooms: C[]; unassignedSessions: SessionSummary[] };
type SavedSession = Omit<SessionSummary, "question_count"> & { question_count?: number };

function findSession<C extends Group>(lists: ClassroomLists<C>, id: string) {
  return lists.unassignedSessions.find((session) => session.id === id)
    ?? lists.classrooms.flatMap((classroom) => classroom.sessions).find((session) => session.id === id);
}

/** One functional state update moves the row and preserves its latest fields. */
export function mergeListedSession<C extends Group>(lists: ClassroomLists<C>, saved: SavedSession): ClassroomLists<C> {
  const previous = findSession(lists, saved.id);
  const session = { ...previous, ...saved, question_count: saved.question_count ?? previous?.question_count ?? 0 };
  const update = (rows: SessionSummary[], include: boolean) => {
    const next = rows.filter((row) => row.id !== session.id);
    if (include) next.push(session);
    return next.sort((left, right) => right.started_at.localeCompare(left.started_at) || left.id.localeCompare(right.id));
  };
  return {
    classrooms: lists.classrooms.map((classroom) => ({ ...classroom, sessions: update(classroom.sessions, classroom.id === session.classroom_id) })),
    unassignedSessions: update(lists.unassignedSessions, session.classroom_id === null),
  };
}

/** Rename/move responses contain one change, not a fresh recording snapshot. */
export function patchListedSession<C extends Group>(lists: ClassroomLists<C>, id: string, patch: Partial<Pick<SessionSummary, "title" | "classroom_id">>): ClassroomLists<C> {
  const session = findSession(lists, id);
  return session ? mergeListedSession(lists, { ...session, ...patch }) : lists;
}
