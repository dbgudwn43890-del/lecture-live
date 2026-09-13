import "server-only";
import { createClient } from "./supabase/server";
import { hasVerifiedEmail } from "./verified-email";

/** Only Supabase's verified server response may establish operator identity. */
export async function getAdminIdentity(): Promise<{ id: string } | null> {
  try {
    const client = await createClient();
    const { data: { user }, error } = await client.auth.getUser();
    if (error || !hasVerifiedEmail(user)) return null;
    const ids = (process.env.ADMIN_USER_IDS ?? "").split(",").map(value => value.trim()).filter(Boolean);
    // An explicit ID allowlist takes precedence; email remains compatible with existing deployments.
    const emails = (process.env.ADMIN_EMAILS ?? "").split(",").map(value => value.trim().toLowerCase()).filter(Boolean);
    const allowed = ids.length ? ids.includes(user.id) : emails.includes(user.email.toLowerCase());
    return allowed ? { id: user.id } : null;
  } catch { return null; }
}
