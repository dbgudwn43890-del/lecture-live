import { headers } from "next/headers";
import Link from "next/link";

export default async function NotFound() {
  const isEnglish = (await headers()).get("x-site-locale") === "en";
  return (
    <main className="status-page">
      <h1>{isEnglish ? "Page not found" : "찾을 수 없는 페이지입니다"}</h1>
      <p>
        {isEnglish
          ? "The address may have changed, or the link may be out of date."
          : "주소가 바뀌었거나 오래된 링크일 수 있습니다."}
      </p>
      <Link href={isEnglish ? "/en" : "/"}>{isEnglish ? "Back to home" : "홈으로 돌아가기"}</Link>
    </main>
  );
}
