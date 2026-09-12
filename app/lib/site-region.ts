import { headers } from "next/headers";
import { siteRegion } from "./site-locale";

export async function getSiteRegion(): Promise<"kr" | "global"> {
  const request = await headers();
  return siteRegion(request.get("x-vercel-ip-country") ?? request.get("cf-ipcountry"), request.get("accept-language") ?? "");
}
