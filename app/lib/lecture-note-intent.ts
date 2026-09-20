// Deliberately match complete, generic navigation requests, not keywords.
// A named concept, a second request, or an ambiguous follow-up such as "다시
// 설명해줘" must remain available for learning-intent curation with context.
const koreanBoundary = "(?:(?:여기|지금|현재|이제)까지|(?:(?:내가|제가)\\s*)?(?:마지막으로\\s*)?질문한\\s*(?:이후|뒤)(?:부터)?)";
const statusRequests = [
  new RegExp(`^${koreanBoundary}(?:의)?(?:\\s*(?:강의|수업|내용)(?:을|를)?)?\\s*(?:요약|정리)(?:\\s*(?:해\\s*줘|해\\s*주세요|해줄래|해줄\\s*수\\s*있어))?$`, "u"),
  new RegExp(`^(?:${koreanBoundary}|방금|아까|조금\\s*전에)\\s*(?:뭐라고\\s*(?:했어|했어요|하셨어|하셨어요)|무슨\\s*말(?:을)?\\s*(?:했어|했어요|하셨어|하셨어요))$`, "u"),
  /^(?:지금|현재)\s*(?:어디까지\s*(?:했어|했어요|왔어|왔어요)|무슨\s*내용(?:이야|인가요))$/u,
  /^(?:강의|수업)\s*(?:전체|내용\s*전체)(?:를|을)?\s*(?:요약|정리)(?:\s*(?:해\s*줘|해\s*주세요|해줄래))?$/u,
  /^(?:놓친\s*(?:내용|부분)(?:을|를)?|내가\s*놓친\s*(?:내용|부분)(?:을|를)?)\s*(?:요약|정리|알려)(?:\s*(?:해\s*줘|해\s*주세요|줘|주세요))?$/u,
  /^(?:please )?(?:summari[sz]e|recap|sum up) (?:so far|(?:the )?(?:lecture|class|lesson|content|everything)(?: so far| up to now)?)(?: please)?$/u,
  /^what (?:did i miss|have i missed)(?: since (?:my last question|i last asked(?: a question)?))?$/u,
  /^what (?:did (?:you|the lecturer) say|has been (?:said|covered)|have we covered)(?: so far| since (?:my last question|i last asked(?: a question)?))$/u,
  /^where are we(?: (?:now|in the lecture|in the class))?$/u,
];

/** False means "leave to contextual curation", not "definitely a learning question". */
export function isLectureStatusRequest(text: string): boolean {
  const utterance = text.normalize("NFKC").trim().replace(/\s+/gu, " ").replace(/[.!?。！？]+$/u, "").trim().toLowerCase();
  return statusRequests.some(pattern => pattern.test(utterance));
}
