"use client";

import { useEffect, useState } from "react";
import { languageSwitchUrl } from "./lib/site-locale";
import styles from "./site-language-menu.module.css";

export default function SiteLanguageMenu({ locale, region, href }: {
  locale: "ko" | "en";
  region: "kr" | "global";
  href: string;
}) {
  const [currentHref, setCurrentHref] = useState(href);
  useEffect(() => {
    setCurrentHref(`${window.location.pathname}${window.location.search}${window.location.hash}`);
  }, [href]);

  const english = locale === "en";
  return <div className={styles.root}>
    {region === "kr" ? <a
      className={styles.link}
      href={languageSwitchUrl(currentHref, english ? "ko" : "en")}
      lang={english ? "ko" : "en"}
      aria-label={english ? "한국어로 변경" : "Switch to English"}
    >{english ? "한국어" : "English"}</a> : <select
      className={styles.select}
      aria-label={english ? "Languages" : "언어 선택"}
      value={locale}
      onChange={event => {
        const next = event.currentTarget.value;
        if (next === "en" || next === "ko") window.location.assign(languageSwitchUrl(window.location.href, next));
      }}
    >
      <option value="en" lang="en">English</option>
      <optgroup label={english ? "Other languages" : "다른 언어"}>
        <option value="ko" lang="ko">한국어</option>
      </optgroup>
    </select>}
  </div>;
}
