type EmailUser = {
  email?: string;
  email_confirmed_at?: string;
  is_anonymous?: boolean;
};

/** Use only a user returned by Supabase Auth, never session/user metadata. */
export function hasVerifiedEmail<T extends EmailUser>(user: T | null | undefined): user is T & {
  email: string;
  email_confirmed_at: string;
} {
  return Boolean(user && !user.is_anonymous
    && typeof user.email === "string" && user.email.trim()
    && typeof user.email_confirmed_at === "string" && user.email_confirmed_at.trim());
}
