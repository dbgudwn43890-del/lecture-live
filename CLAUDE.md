@AGENTS.md

# 코드를 찾기 전에 그래프를 먼저 본다

이 저장소에는 graphify 지식 그래프가 있다(`graphify-out/graph.json`, 커밋 훅이 자동 갱신).
772개 노드에 함수·파일·마이그레이션 테이블·RPC가 모두 들어 있다.

"X는 어디 있나", "Y를 고치면 뭐가 깨지나", "Z는 무엇을 호출하나" 같은 질문은
파일을 훑기 전에 그래프에 먼저 묻는다. 같은 답을 수십분의 일 토큰으로 얻는다.

```
graphify explain "createAdminClient"    # 이 심볼과 그 이웃
graphify affected "consume_lecture_credits"   # 이걸 바꾸면 영향받는 것
graphify god-nodes                      # 구조적 허브
graphify query "질문"                    # BFS 탐색
graphify update .                       # 훅이 놓쳤을 때만. LLM 없음, 비용 0
```

`graphify path`는 방향 그래프라 실패하면 `--undirected`를 붙인다.
그래프가 답을 못 주는 질문에서만 파일을 연다.
