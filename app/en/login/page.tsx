import LoginClient from "../../login/login-client";
import { getSiteRegion } from "../../lib/site-region";

export default async function EnglishLoginPage() {
  return <LoginClient locale="en" region={await getSiteRegion()} />;
}
