import { createClient } from "./supabase/server";
import { hasVerifiedEmail } from "./verified-email";

export async function getAuthenticatedUserId() {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  return !error && hasVerifiedEmail(user) ? user.id : null;
}
