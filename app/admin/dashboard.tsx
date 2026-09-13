"use client";

import { useEffect, useRef, useState } from "react";
import "./dashboard.css";

type User = { id: string; email: string; name: string; createdAt: string; verified: boolean; lastSignInAt: string | null; credits: number; sessionCount: number; lastSessionAt: string | null };
type Grant = { userId: string; key: string; credits: number; days: number; reason: string };
type Snapshot = {
  generatedAt: string; days: number; page: number; pageSize: number; total: number; users: User[];
  metrics: Record<string, number>;
  attention: { userId: string; email: string; recordings: number; segments: number }[];
  audit: { requestId: string; actorId: string; userId: string; credits: number; days: number; reason: string; createdAt: string }[];
};
const number = (value: number) => value.toLocaleString("ko-KR");
const date = (value: string | null) => value ? new Date(value).toLocaleString("ko-KR") : "—";
const storageKey = "lecue-admin-pending-grant";

export default function AdminDashboard() {
  const [data, setData] = useState<Snapshot | null>(null);
  const [query, setQuery] = useState(""); const [search, setSearch] = useState("");
  const [page, setPage] = useState(1); const [days, setDays] = useState(7);
  const [refresh, setRefresh] = useState(0); const [loading, setLoading] = useState(true);
  const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<User | null>(null);
  const [draft, setDraft] = useState<Grant | null>(null);
  const [pending, setPending] = useState(false); const sending = useRef(false);
  const [amount, setAmount] = useState("600"); const [expiry, setExpiry] = useState("60"); const [reason, setReason] = useState("");

  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? "null");
      if (saved && typeof saved.userId === "string" && typeof saved.key === "string" && typeof saved.reason === "string" && Number.isInteger(saved.credits) && Number.isInteger(saved.days)) setDraft(saved);
    } catch { /* A blocked storage never authorizes a write. */ }
  }, []);

  useEffect(() => {
    const controller = new AbortController(); let active = true;
    setLoading(true); setError("");
    void (async () => {
      try {
        const response = await fetch(`/api/admin?${new URLSearchParams({ q: search, page: String(page), days: String(days) })}`, { cache: "no-store", signal: controller.signal });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? "조회에 실패했습니다.");
        if (active) setData(result);
      } catch (caught) {
        if (active) { setData(null); setError(caught instanceof Error ? caught.message : "조회에 실패했습니다."); }
      } finally { if (active) setLoading(false); }
    })();
    return () => { active = false; controller.abort(); };
  }, [search, page, days, refresh]);

  async function grant() {
    if (!draft || sending.current) return;
    sending.current = true; setPending(true); setError(""); setNotice("");
    try {
      // Persist before sending: a refresh or lost response must reuse the same key.
      sessionStorage.setItem(storageKey, JSON.stringify(draft));
      const response = await fetch("/api/admin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft), signal: AbortSignal.timeout(15_000) });
      const result = await response.json();
      if (!response.ok) {
        if ([400, 403, 409, 415].includes(response.status)) { sessionStorage.removeItem(storageKey); setDraft(null); setSelected(null); }
        throw new Error(result.error ?? "지급 결과를 확인하지 못했습니다.");
      }
      sessionStorage.removeItem(storageKey);
      setNotice(result.replayed ? "이미 완료된 지급을 확인했습니다. 추가 지급하지 않았습니다." : `${number(draft.credits)} 크레딧 지급을 완료했습니다.`);
      setDraft(null); setSelected(null); setReason(""); setRefresh(value => value + 1);
    } catch (caught) {
      setError(`${caught instanceof Error ? caught.message : "지급 결과를 확인하지 못했습니다."} 같은 요청으로 재시도할 수 있습니다.`);
    } finally { sending.current = false; setPending(false); }
  }

  const sections: [string, [string, string][]][] = [
    ["사용자와 강의", [["totalUsers", "전체 사용자"], ["verifiedUsers", "인증된 사용자"], ["newUsers", "기간 내 가입"], ["activeUsers", "기간 내 강의 사용자"], ["lectures", "시작한 강의"], ["questions", "저장된 질문"], ["notesReady", "완성된 복습 노트"], ["liveConnections", "현재 연결된 녹음"]]],
    ["처리 상태", [["notesFailed", "복습 노트 실패"], ["uploadsFailed", "녹음 업로드 실패"], ["indexPending", "강의 검색 색인 대기 · 현재"], ["cleanupPending", "파일 삭제 대기 · 현재"], ["cleanupRetried", "삭제 3회 이상 재시도 · 현재"]]],
    ["결제와 측정", [["completedOrders", "운영 결제 완료"], ["failedOrders", "운영 결제 실패"], ["pastDue", "결제 연체 계정 · 현재"], ["outstandingCredits", "사용 가능 크레딧 · 현재"], ["meteredMinutes", "차감된 녹음 분"], ["signupClaims", "가입 전환 전송 시도"]]],
  ];
  return <main className="admin-shell admin-dashboard">
    <header className="admin-toolbar"><div><h1>운영 대시보드</h1><p className="admin-sub">{data ? `마지막 조회 ${date(data.generatedAt)}` : "관리자 전용 운영 현황"}</p></div>
      <div className="admin-controls"><label>조회 기간 <select value={days} onChange={e => { setDays(Number(e.target.value)); setPage(1); }}><option value={7}>최근 7일</option><option value={30}>최근 30일</option><option value={90}>최근 90일</option></select></label><button disabled={loading} onClick={() => setRefresh(value => value + 1)}>{loading ? "조회 중…" : "새로고침"}</button><a href="/">사이트로</a></div>
    </header>
    {error && <p className="admin-error" role="alert">{error}</p>}{notice && <p className="admin-notice" role="status">{notice}</p>}
    {loading && <p role="status">운영 지표를 조회하고 있습니다.</p>}
    {data && <>
      <div className="admin-metrics">{sections.map(([title, items]) => <section key={title}><h2>{title}</h2><dl>{items.map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{number(data.metrics[key] ?? 0)}</dd></div>)}</dl></section>)}</div>
      <p className="admin-sub">실시간 연결·현재 잔액·대기열은 현재 상태입니다. 가입 전송 시도는 GA4 수신 건수가 아니며, 녹음 분은 공급자 청구 비용이 아닙니다.</p>
      <section><h2>확인이 필요한 녹음</h2><p className="admin-sub">녹음 시작 대비 저장 문장이 적은 계정입니다. 무음·권한·연결 문제도 원인이 될 수 있으므로 남용으로 단정하지 않습니다.</p>
        {data.attention.length ? <ul className="admin-attention">{data.attention.map(item => <li key={item.userId}><button onClick={() => { setQuery(item.email); setSearch(item.email); setPage(1); }}>{item.email}</button><span>시작 {number(item.recordings)}회 · 문장 {number(item.segments)}개</span></li>)}</ul> : <p>현재 조건에 해당하는 계정이 없습니다.</p>}
      </section>
      <section><div className="admin-toolbar"><h2>사용자 <small>{number(data.total)}명</small></h2><form onSubmit={e => { e.preventDefault(); setSearch(query); setPage(1); }} className="admin-controls"><label className="sr-only" htmlFor="admin-search">이메일·이름 검색</label><input id="admin-search" type="search" maxLength={100} placeholder="이메일·이름 검색" value={query} onChange={e => setQuery(e.target.value)} /><button type="submit">검색</button></form></div>
        <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>계정</th><th>가입·인증</th><th>최근 로그인</th><th>강의</th><th>사용 가능 크레딧</th><th>관리</th></tr></thead><tbody>{data.users.map(user => <tr key={user.id}><td>{user.email}<small>{user.name}</small></td><td>{date(user.createdAt)}<small>{user.verified ? "인증 완료" : "인증 대기"}</small></td><td>{date(user.lastSignInAt)}</td><td>{number(user.sessionCount)}<small>{date(user.lastSessionAt)}</small></td><td>{number(user.credits)}</td><td><button disabled={Boolean(draft) || pending} onClick={() => { setSelected(user); setReason(""); }}>크레딧 지급</button></td></tr>)}</tbody></table></div>
        {!data.users.length && <p>검색 결과가 없습니다.</p>}
        <nav className="admin-pagination" aria-label="사용자 페이지"><button disabled={loading || page<=1} onClick={() => setPage(value => value-1)}>이전</button><span>{page} / {Math.max(1, Math.ceil(data.total/data.pageSize))}</span><button disabled={loading || page*data.pageSize>=data.total} onClick={() => setPage(value => value+1)}>다음</button></nav>
      </section>
      {selected && !draft && <section className="admin-grant-form"><h2>크레딧 지급 · {selected.email}</h2><form onSubmit={e => { e.preventDefault(); setDraft({ userId: selected.id, credits: Number(amount), days: Number(expiry), reason: reason.trim(), key: crypto.randomUUID() }); }}><label>크레딧<input required type="number" min={1} max={100000} step={1} value={amount} onChange={e => setAmount(e.target.value)} /></label><label>유효 기간(일)<input required type="number" min={1} max={365} step={1} value={expiry} onChange={e => setExpiry(e.target.value)} /></label><label>지급 사유<input required minLength={3} maxLength={200} value={reason} onChange={e => setReason(e.target.value)} placeholder="예: 녹음 장애에 따른 보상" /></label><button>지급 내용 확인</button><button type="button" onClick={() => setSelected(null)}>취소</button></form></section>}
      <section><h2>최근 크레딧 지급 기록</h2>{data.audit.length ? <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>일시</th><th>대상 계정 ID</th><th>크레딧·기간</th><th>사유</th><th>관리자 ID</th></tr></thead><tbody>{data.audit.map(item => <tr key={item.requestId}><td>{date(item.createdAt)}</td><td>{item.userId}</td><td>{number(item.credits)} · {item.days}일</td><td>{item.reason}</td><td>{item.actorId}</td></tr>)}</tbody></table></div> : <p>감사 기록 도입 후 지급 내역이 없습니다.</p>}</section>
    </>}
    {draft && <section className="admin-grant-review" aria-labelledby="grant-review"><h2 id="grant-review">지급 요청 확인</h2><p>대상: {selected?.email ?? draft.userId}</p><p>{number(draft.credits)} 크레딧 · {draft.days}일 · {draft.reason}</p><p className="admin-sub">요청 번호: {draft.key}. 응답이 끊겨도 같은 요청 번호로 재시도합니다.</p><button disabled={pending || loading || !data} onClick={() => void grant()}>{pending ? "처리 중…" : "이 요청으로 지급 확인"}</button><button disabled={pending} onClick={() => { if (sessionStorage.getItem(storageKey)) { setNotice("전송한 요청은 최근 지급 기록을 확인한 뒤 처리하세요. 같은 요청으로 재시도하면 중복 지급되지 않습니다."); return; } setDraft(null); }}>내용 수정</button></section>}
  </main>;
}
