"use client";

import { useEffect, useState } from "react";

type AdminUser = {
  id: string;
  email: string | null;
  name: string;
  createdAt: string;
  credits: number;
  sessionCount: number;
  lastSessionAt: string | null;
  socketsOpened: number;
  segmentsSaved: number;
  abuseFlag: boolean;
};

/** 운영자 전용 콘솔. 권한 검사는 전부 /api/admin이 한다 — 이 화면은 그저 표. */
export default function AdminPage() {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [pending, setPending] = useState("");
  const [query, setQuery] = useState("");

  async function load() {
    setError("");
    const response = await fetch("/api/admin", { cache: "no-store" });
    const data = await response.json() as { users?: AdminUser[]; error?: string };
    if (!response.ok || !data.users) {
      setError(data.error ?? "목록을 불러오지 못했습니다.");
      return;
    }
    setUsers(data.users);
  }
  useEffect(() => { void load(); }, []);

  async function grant(userId: string) {
    if (pending) return;
    const credits = Number(amounts[userId] ?? "");
    if (!Number.isInteger(credits) || credits < 1) {
      setError("지급할 크레딧 수를 입력하세요.");
      return;
    }
    setPending(userId);
    setError("");
    try {
      const response = await fetch("/api/admin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, credits, key: crypto.randomUUID() }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error);
      setNotice(`${credits.toLocaleString("ko-KR")} 크레딧을 지급했습니다.`);
      setAmounts((current) => ({ ...current, [userId]: "" }));
      await load();
    } catch (caught) {
      setError(caught instanceof Error && caught.message ? caught.message : "지급하지 못했습니다.");
    } finally {
      setPending("");
    }
  }

  const shown = (users ?? []).filter((user) => {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return (user.email ?? "").toLowerCase().includes(needle) || user.name.toLowerCase().includes(needle);
  });

  return (
    <main className="admin-shell">
      <h1>사용자 · 크레딧</h1>
      <p className="admin-sub">지급분은 60일 뒤 만료되는 service_credit으로 들어갑니다.</p>
      {error && <p className="admin-error" role="alert">{error}</p>}
      {notice && <p className="admin-notice" role="status">{notice}</p>}
      <input
        className="admin-search"
        type="search"
        placeholder="이메일·이름 검색"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {users === null ? <p>불러오는 중…</p> : (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr><th>이메일</th><th>이름</th><th>가입일</th><th>수업</th><th>마지막 수업</th><th>소켓·문장(7일)</th><th>크레딧</th><th>지급</th></tr>
            </thead>
            <tbody>
              {shown.map((user) => (
                <tr key={user.id} className={user.abuseFlag ? "admin-flagged" : undefined}>
                  <td>
                    {user.abuseFlag && (
                      <span className="admin-flag" title="소켓은 여는데 스크립트 저장이 거의 없음 — 남용 의심">⚠ 의심</span>
                    )}
                    {user.email}
                  </td>
                  <td>{user.name}</td>
                  <td>{new Date(user.createdAt).toLocaleDateString("ko-KR")}</td>
                  <td>{user.sessionCount}</td>
                  <td>{user.lastSessionAt ? new Date(user.lastSessionAt).toLocaleDateString("ko-KR") : "—"}</td>
                  <td className={user.abuseFlag ? "admin-flag-cell" : undefined}>
                    {user.socketsOpened.toLocaleString("ko-KR")} · {user.segmentsSaved.toLocaleString("ko-KR")}
                  </td>
                  <td>{user.credits.toLocaleString("ko-KR")}</td>
                  <td className="admin-grant">
                    <input
                      type="number"
                      min={1}
                      placeholder="예: 600"
                      value={amounts[user.id] ?? ""}
                      onChange={(event) => setAmounts((current) => ({ ...current, [user.id]: event.target.value }))}
                    />
                    <button type="button" disabled={pending === user.id} onClick={() => void grant(user.id)}>
                      {pending === user.id ? "지급 중…" : "지급"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
