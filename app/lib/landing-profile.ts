import type { User } from "@supabase/supabase-js";

export function getLandingProfile(user: User | null) {
  if (!user) return null;
  const metadata = user.user_metadata as { full_name?: unknown; name?: unknown; avatar_url?: unknown; picture?: unknown };
  return {
    displayName: typeof metadata.full_name === "string"
      ? metadata.full_name
      : typeof metadata.name === "string" ? metadata.name : user.email?.split("@")[0] ?? "",
    avatarUrl: typeof metadata.avatar_url === "string"
      ? metadata.avatar_url
      : typeof metadata.picture === "string" ? metadata.picture : null,
  };
}
