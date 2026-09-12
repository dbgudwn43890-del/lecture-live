import LoginClient from "./login-client";
import { getSiteRegion } from "../lib/site-region";

export default async function LoginPage() {
  return <LoginClient region={await getSiteRegion()} />;
}
