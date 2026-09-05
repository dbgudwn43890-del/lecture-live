"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { landingText } from "./landing-copy";

/** Enhance the server-rendered example; no microphone, model call, or account write. */
export default function LandingInteractions({ locale, children }: { locale: "ko" | "en"; children: ReactNode }) {
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = rootRef.current!;
    const controller = new AbortController();
    const { signal } = controller;
    const t = (text: string) => landingText(locale, text);
    const byId = <T extends HTMLElement = HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;
    const intro = byId("hero-intro");
    const demo = byId("demo-panel");
    const triggers = root.querySelectorAll<HTMLElement>("[data-open-demo]");
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let opener: HTMLElement | null = null;
    let originalScroll = 0;
    let equalized = false;

    function appear(element: HTMLElement) {
      element.classList.remove("enter");
      if (!reduceMotion.matches) requestAnimationFrame(() => { if (element.isConnected) element.classList.add("enter"); });
    }
    function setWeights(equal: boolean) {
      equalized = equal;
      const mix = equal ? [.5, .5] : [.9, .2];
      ["a", "b"].forEach((key, index) => {
        const pc = Math.round(mix[index] * 100);
        const track = byId(`mix-${key}`);
        track.querySelector<HTMLElement>(".mix-pc")!.style.setProperty("--portion", String(mix[index]));
        track.setAttribute("aria-label", locale === "en"
          ? `${key.toUpperCase()} visitors: ${pc}% desktop, ${100 - pc}% mobile`
          : `${key.toUpperCase()} 방문자 구성: PC ${pc}%, 모바일 ${100 - pc}%`);
        byId(`mix-label-${key}`).textContent = `${pc} : ${100 - pc}`;
      });
      const a = 90 * mix[0] + 10 * (1 - mix[0]);
      const b = 95 * mix[1] + 20 * (1 - mix[1]);
      byId("total-a").textContent = `${Number(a.toFixed(1))}%`;
      byId("total-b").textContent = `${Number(b.toFixed(1))}%`;
      byId("total-a").classList.toggle("winning", a > b);
      byId("total-b").classList.toggle("winning", b > a);
      byId("total-label").textContent = t(equal ? "반반씩 섞으면" : "합치면");
      byId("table-footnote").textContent = t(equal ? "PC·모바일 비중을 50%씩 맞춘 비교예요." : "PC에서도, 모바일에서도 B가 높은데 합계는 반대예요.");
      byId("equalize-button").textContent = t(equal ? "원래 강의 데이터로 돌아가기 ↶" : "PC·모바일을 반반씩 비교하면? →");
      byId("equalize-button").setAttribute("aria-pressed", String(equal));
      byId("what-if-result").hidden = !equal;
    }
    function resetDemo() {
      byId("demo-before").hidden = false;
      byId("mobile-explain").hidden = false;
      byId("demo-answer").hidden = true;
      byId("earlier-context").hidden = true;
      ["source-button", "explain-button", "mobile-explain"].forEach(id => byId(id).setAttribute("aria-expanded", "false"));
      byId("source-button").textContent = t("↖ 37:05 · 앞에서 설명한 근거 보기");
      byId("demo-announcement").textContent = "";
      byId("demo-footer-copy").textContent = t("예시 데이터로 잠깐 체험 중이에요.");
      setWeights(false);
    }
    function openDemo(trigger: HTMLElement) {
      if (demo.hidden) {
        opener = trigger;
        originalScroll = window.scrollY;
        resetDemo();
        intro.hidden = true;
        demo.hidden = false;
        byId("home").setAttribute("aria-labelledby", "demo-title");
        triggers.forEach(el => el.setAttribute("aria-expanded", "true"));
        appear(demo);
      }
      demo.scrollIntoView({ block: "start", behavior: "instant" });
      byId("demo-close").focus({ preventScroll: true });
    }
    function closeDemo(restore = true) {
      if (demo.hidden) return;
      demo.hidden = true;
      intro.hidden = false;
      byId("home").setAttribute("aria-labelledby", "hero-title");
      triggers.forEach(el => el.setAttribute("aria-expanded", "false"));
      if (restore) {
        window.scrollTo({ top: originalScroll, behavior: "instant" });
        if (opener?.isConnected) opener.focus({ preventScroll: true });
      }
    }
    function explain() {
      byId("demo-before").hidden = true;
      byId("mobile-explain").hidden = true;
      byId("mobile-explain").setAttribute("aria-expanded", "true");
      byId("demo-answer").hidden = false;
      byId("explain-button").setAttribute("aria-expanded", "true");
      byId("demo-announcement").textContent = t("강의 설명을 연결했어요. A에는 구매 비율이 높은 PC 방문자가 훨씬 많았어요. 방문자 구성을 바꿔 비교해 볼 수 있습니다.");
      byId("demo-footer-copy").textContent = t("이렇게, 놓친 연결 고리부터 다시 이어가요.");
      appear(byId("demo-answer"));
      byId("source-button").focus({ preventScroll: true });
      if (window.matchMedia("(max-width:620px)").matches) byId("demo-answer").closest(".answer-side")!.scrollIntoView({ block: "start", behavior: "instant" });
    }
    const note = byId<HTMLDetailsElement>("note-details");
    const theme = byId("theme-toggle");
    function themeLabel() {
      const dark = document.documentElement.dataset.theme === "dark";
      theme.textContent = t(dark ? "밝은 화면" : "어두운 화면");
      theme.setAttribute("aria-label", t(dark ? "밝은 화면으로 변경" : "어두운 화면으로 변경"));
    }
    const actions: Record<string, () => void> = {
      "demo-close": () => closeDemo(),
      "demo-return": () => {
        closeDemo(false);
        window.scrollTo({ top: 0, behavior: "instant" });
        root.querySelector<HTMLElement>(".site-header .wordmark")!.focus({ preventScroll: true });
      },
      "explain-button": explain,
      "mobile-explain": explain,
      "source-button": () => {
        const earlier = byId("earlier-context");
        earlier.hidden = !earlier.hidden;
        byId("source-button").setAttribute("aria-expanded", String(!earlier.hidden));
        byId("source-button").textContent = t(earlier.hidden ? "↖ 37:05 · 앞에서 설명한 근거 보기" : "37:05 · 강의 근거 접기");
        if (!earlier.hidden) {
          appear(earlier);
          earlier.scrollIntoView({ block: "nearest", behavior: reduceMotion.matches ? "instant" : "smooth" });
          byId("demo-announcement").textContent = t("37분 5초의 강의 근거가 열렸어요. A는 PC 90명과 모바일 10명, B는 PC 20명과 모바일 80명이었습니다.");
        }
      },
      "equalize-button": () => {
        setWeights(!equalized);
        byId("demo-announcement").textContent = t(equalized ? "방문자 비율을 같게 맞췄어요. A 50%, B 57.5%로 비교가 바뀝니다." : "원래 데이터로 돌아왔어요. 전체 비율은 A 82%, B 35%입니다.");
      },
      "preview-note-button": () => {
        note.open = !note.open;
        if (note.open) note.scrollIntoView({ block: "nearest", behavior: reduceMotion.matches ? "instant" : "smooth" });
      },
      "theme-toggle": () => {
        const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
        document.documentElement.dataset.theme = next;
        window.localStorage.setItem("lecue-theme", next);
      },
    };
    root.addEventListener("click", event => {
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>("a, button") : null;
      if (!target || !root.contains(target)) return;
      if (target.hasAttribute("data-open-demo")) { event.preventDefault(); openDemo(target); }
      else if (actions[target.id]) actions[target.id]();
      else if (target.matches('a[href^="#"]')) closeDemo(false);
    }, { signal });
    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && !demo.hidden) { event.preventDefault(); closeDemo(); }
    }, { signal });
    note.addEventListener("toggle", () => {
      byId("preview-note-button").setAttribute("aria-expanded", String(note.open));
      byId("preview-note-button").textContent = t(note.open ? "복습 노트 접기 ↙" : "복습 노트 한 장 펼쳐보기 ↗");
    }, { signal });
    const observer = new MutationObserver(themeLabel);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    themeLabel();
    return () => { controller.abort(); observer.disconnect(); };
  }, [locale]);
  return <div className="landing-experience" ref={rootRef}>{children}</div>;
}
