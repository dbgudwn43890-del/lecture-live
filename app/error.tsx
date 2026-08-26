"use client";

import { useEffect, useState } from "react";

export default function AppError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  // Error boundaries must be Client Components, so the locale comes from the
  // lang the root layout already resolved rather than from headers().
  const [isEnglish, setIsEnglish] = useState(false);

  useEffect(() => {
    setIsEnglish(document.documentElement.lang === "en");
    console.error("Route error", error.digest ?? error.name);
  }, [error]);

  return (
    <main className="status-page">
      <h1>{isEnglish ? "Something went wrong" : "문제가 발생했습니다"}</h1>
      <p>
        {isEnglish
          ? "The page could not be loaded. Try again, and if it keeps happening, reload in a moment."
          : "화면을 불러오지 못했습니다. 다시 시도해 보고, 계속되면 잠시 후 새로고침해 주세요."}
      </p>
      <button type="button" onClick={retry}>
        {isEnglish ? "Try again" : "다시 시도"}
      </button>
    </main>
  );
}
