type LiveAssistUser = {
  email?: string | null;
  email_confirmed_at?: string | null;
  is_anonymous?: boolean;
};

/** Only pass a user verified by Supabase auth.getUser(), never user metadata. */
export function canUseLiveAssist(user: LiveAssistUser | null | undefined): boolean {
  return Boolean(user && !user.is_anonymous
    && user.email === "dbgudwn43890@gmail.com"
    && typeof user.email_confirmed_at === "string"
    && Number.isFinite(Date.parse(user.email_confirmed_at)));
}
