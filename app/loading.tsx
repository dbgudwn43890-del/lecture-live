import { headers } from "next/headers";

export default async function Loading() {
  const isEnglish = (await headers()).get("x-site-locale") === "en";
  return (
    <main className="status-page" aria-busy="true">
      <i className="auth-spinner auth-spinner-dark" aria-hidden="true" />
      <p>{isEnglish ? "Loading…" : "불러오는 중입니다…"}</p>
    </main>
  );
}
