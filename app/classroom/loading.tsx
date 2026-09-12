import "./workspace.css";

export function ClassroomLoadingShell({ isEnglish = false }: { isEnglish?: boolean }) {
  return (
    <main className="workspace experience question-workspace classroom-skeleton" aria-busy="true">
      <p className="sr-only">{isEnglish ? "Loading the classroom…" : "강의실을 불러오는 중입니다…"}</p>
      <aside className="workspace-sidebar" aria-hidden="true">
        <strong className="sidebar-brand">Lecue</strong>
        <i className="skeleton-line skeleton-new" />
        <div className="sidebar-library">
          <i className="skeleton-line skeleton-label" />
          <i className="skeleton-line" /><i className="skeleton-line" /><i className="skeleton-line skeleton-short" />
        </div>
      </aside>
      <div className="workspace-main" aria-hidden="true">
        <header className="topbar"><i className="skeleton-line skeleton-state" /><i className="skeleton-line skeleton-action" /></header>
        <section className="panes">
          <section className="chat-pane is-mobile-active"><div className="conversation-loading"><i className="skeleton-line skeleton-heading" /><div className="skeleton-input" /></div></section>
        </section>
      </div>
    </main>
  );
}

export default ClassroomLoadingShell;
