import type { Metadata } from "next";

import LegalPage from "../legal-page";
import styles from "../legal.module.css";

export const metadata: Metadata = {
  title: "개인정보처리방침 | Lecue",
  description: "Lecue가 개인정보와 강의 데이터를 처리하는 기준입니다.",
};

export default function PrivacyPage() {
  return (
    <LegalPage
      title="개인정보처리방침"
      description="Lecue는 계정 생성, 강의 기록, 질문 답변과 결제에 필요한 정보만 처리하며 강의 내용을 맞춤 광고에 사용하지 않습니다."
    >
      <section>
        <h2>1. 처리하는 정보와 목적</h2>
        <div className={styles.tableWrap}>
          <table>
            <thead><tr><th>구분</th><th>처리 항목</th><th>이용 목적</th><th>수집 시점</th></tr></thead>
            <tbody>
              <tr><td>계정</td><td>이메일, 내부 계정 식별자, 가입·로그인 일시, Google 로그인 선택 시 이름·프로필 이미지</td><td>회원 식별, 로그인 유지, 계정 보호</td><td>회원가입·로그인</td></tr>
              <tr><td>강의 이용</td><td>강의실·수업 제목, 스크립트, 질문, 답변, 출처, 기록 시간</td><td>강의 기록 저장·열람, 강의 맥락을 반영한 답변 제공</td><td>강의 기록·질문</td></tr>
              <tr><td>강의 자료</td><td>이용자가 올린 강의 자료에서 추출한 텍스트·색인</td><td>답변에 자료 내용과 출처 반영</td><td>자료 업로드</td></tr>
              <tr><td>음성</td><td>마이크 음성 스트림</td><td>실시간 음성 인식</td><td>기록 중</td></tr>
              <tr><td>개인 AI 연결</td><td>선택한 공급자·모델, 이용자가 입력한 API 키</td><td>이용자가 선택한 AI 공급자의 답변 제공</td><td>해당 기능 선택 시</td></tr>
              <tr><td>서비스 이용</td><td>IP 주소, 브라우저·기기 정보, 접속 일시, 쿠키, 오류·보안 로그</td><td>서비스 보안, 부정 이용 방지, 오류 대응</td><td>접속·이용 과정에서 자동 생성</td></tr>
              <tr><td>결제</td><td>상품, 금액, 결제·구독·환불 상태, 결제 사업자가 제공하는 고객·거래 식별자, 잔여 크레딧</td><td>결제, 구독, 크레딧과 환불 관리</td><td>체험·결제·환불 시</td></tr>
              <tr><td>문의</td><td>이메일, 문의 내용, 답변 기록</td><td>문의 처리와 분쟁 대응</td><td>문의 시</td></tr>
            </tbody>
          </table>
        </div>
        <p>운영자는 강의 음성, 스크립트와 질문을 맞춤 광고나 광고 프로필 작성에 사용하지 않으며 개인정보를 판매하지 않습니다.</p>
      </section>

      <section>
        <h2>2. 보유 기간</h2>
        <div>
          <ul>
            <li>계정과 강의실·수업 기록: 이용자가 삭제하거나 회원 탈퇴할 때까지</li>
            <li>저장을 선택한 개인 AI API 키: 이용자가 삭제하거나 회원 탈퇴할 때까지</li>
            <li>접속·보안 로그: 생성일로부터 3개월. 보안 사고 조사 중이면 조사 종료 시까지</li>
            <li>고객 문의와 분쟁 처리 기록: 처리 완료 후 3년</li>
            <li>표시·광고 기록: 6개월</li>
            <li>계약, 청약철회, 결제와 서비스 공급 기록: 5년</li>
          </ul>
          <p>법령에 따라 보존해야 하는 정보는 다른 정보와 분리해 정해진 목적에만 이용합니다. 회원 탈퇴 후 삭제 처리와 백업 반영에는 최대 30일이 걸릴 수 있습니다.</p>
        </div>
      </section>

      <section>
        <h2>3. 저장과 음성 처리</h2>
        <div>
          <p>강의실 이름, 수업 제목, 스크립트, 질문과 답변은 계정에 연결해 저장합니다. 같은 강의실의 이전 수업 중 질문과 관련된 내용을 답변에 참고할 수 있습니다.</p>
          <p>이용자가 올린 강의 자료는 텍스트와 색인을 추출한 뒤 원본 파일을 보관하지 않습니다. 자료를 삭제하면 추출 텍스트와 색인도 함께 삭제합니다.</p>
          <p>마이크 음성은 음성 인식 사업자에게 실시간으로 전송되며 Lecue는 음성 원본을 별도로 저장하지 않습니다.</p>
          <p>개인 AI API 키는 이용자가 저장을 선택한 경우에만 암호화해 보관합니다. 저장하지 않은 키는 현재 브라우저 탭에서만 사용합니다. 저장된 키 원문은 화면에 다시 표시하거나 로그에 기록하지 않으며 이용자는 언제든 교체하거나 삭제할 수 있습니다.</p>
        </div>
      </section>

      <section>
        <h2>4. 제3자 제공</h2>
        <div>
          <p>운영자는 이용자의 동의나 법적 근거 없이 개인정보를 제3자에게 판매하거나 제공하지 않습니다. 아래 사업자는 서비스 제공을 위해 정보를 처리합니다.</p>
          <p>Paddle은 결제 화면에서 판매, 결제, 세금, 정기결제와 환불을 담당하는 독립적인 결제 사업자입니다. Lecue는 결제 결과와 거래 식별자를 받지만 카드번호 전체를 저장하지 않습니다.</p>
        </div>
      </section>

      <section>
        <h2>5. 처리 위탁과 국외 이전</h2>
        <div>
          <p>다음 정보는 서비스 이용 시 암호화된 네트워크를 통해 국외로 전송됩니다. 선택 기능은 이용하지 않는 방식으로 이전을 거부할 수 있으나, 필수 기능에 필요한 이전을 거부하면 해당 기능을 이용할 수 없습니다.</p>
          <div className={styles.tableWrap}>
            <table>
              <thead><tr><th>받는 사업자</th><th>목적·항목</th><th>국가·시점·기간</th></tr></thead>
              <tbody>
                <tr><td><a href="https://supabase.com/privacy" target="_blank" rel="noreferrer">Supabase, Inc.</a></td><td>계정 인증과 서비스 데이터 보관: 이메일, 계정 정보, 강의 기록, 저장을 선택한 암호화된 API 키</td><td>대한민국(AWS 서울 리전) / 가입·저장 시 / 삭제 또는 탈퇴 시까지</td></tr>
                <tr><td><a href="https://soniox.com/privacy" target="_blank" rel="noreferrer">Soniox, Inc.</a></td><td>한국어 수업 실시간 음성 인식: 마이크 음성</td><td>미국 / 기록 중 / 사업자 정책에 따른 처리 기간</td></tr>
                <tr><td><a href="https://deepgram.com/privacy" target="_blank" rel="noreferrer">Deepgram, Inc.</a></td><td>영어 수업 실시간 음성 인식과 녹음 파일 변환: 마이크 음성, 업로드한 녹음</td><td>미국 / 기록·변환 중 / 사업자 정책에 따른 처리 기간</td></tr>
                <tr><td><a href="https://openai.com/policies/privacy-policy/" target="_blank" rel="noreferrer">OpenAI, L.L.C.</a></td><td>AI 답변, 필요한 웹 검색과 관련 강의 내용 확인: 스크립트, 질문, 관련 강의 기록</td><td>미국 등 사업자 처리 국가 / 질문 시 / 사업자 정책과 계정 설정에 따른 기간</td></tr>
                <tr><td><a href="https://www.anthropic.com/legal/privacy" target="_blank" rel="noreferrer">Anthropic, PBC</a></td><td>이용자가 선택한 AI 답변: 스크립트, 질문, 개인 API 키</td><td>미국 등 사업자 처리 국가 / 해당 기능 이용 시 / 사업자 정책과 계정 설정에 따른 기간</td></tr>
                <tr><td><a href="https://policies.google.com/privacy" target="_blank" rel="noreferrer">Google LLC</a></td><td>Google 로그인 또는 이용자가 선택한 AI 답변: 계정 정보 또는 스크립트·질문·개인 API 키</td><td>미국 등 사업자 처리 국가 / 해당 기능 이용 시 / 사업자 정책과 계정 설정에 따른 기간</td></tr>
                <tr><td><a href="https://www.paddle.com/legal/privacy" target="_blank" rel="noreferrer">Paddle 관계사</a></td><td>결제, 정기결제, 세금, 환불과 부정결제 방지: 이름, 이메일, 청구·구매 정보</td><td>영국, 미국, 캐나다 등 / 결제 이용 시 / 법적 의무와 분쟁 대응에 필요한 기간</td></tr>
              </tbody>
            </table>
          </div>
          <p>개인 AI 연결을 이용하면 해당 공급자의 약관, 개인정보처리방침과 이용자 계정 설정이 함께 적용됩니다.</p>
        </div>
      </section>

      <section>
        <h2>6. 쿠키</h2>
        <div>
          <p>로그인 상태 유지와 보안을 위해 필수 인증 쿠키를 사용합니다. 브라우저에서 차단하면 로그인 기능이 동작하지 않을 수 있습니다.</p>
          <p>현재 맞춤 광고 쿠키나 제3자 광고 추적 도구는 사용하지 않습니다. 분석 도구를 추가하면 수집 항목과 거부 방법을 이 방침에 공개합니다.</p>
        </div>
      </section>

      <section>
        <h2>7. 이용자의 권리</h2>
        <div>
          <p>이용자는 자신의 개인정보에 대해 열람, 전송, 정정·삭제, 처리정지, 동의 철회와 회원 탈퇴를 요구할 수 있습니다.</p>
          <ol>
            <li>계정에서 직접 처리하거나 아래 개인정보 담당 창구에 요청합니다.</li>
            <li>운영자는 본인 여부를 확인한 뒤 법령이 정한 기간 안에 결과를 알립니다.</li>
            <li>법령상 보관 의무나 다른 사람의 권리 보호를 위해 일부 요청이 제한되면 그 사유를 안내합니다.</li>
          </ol>
        </div>
      </section>

      <section>
        <h2>8. 파기와 보호 조치</h2>
        <div>
          <p>보유 기간이 끝나거나 처리 목적을 달성한 정보는 지체 없이 삭제합니다. 전자 파일은 복구하기 어려운 방식으로 삭제하고 법령상 보존 대상은 분리해 접근을 제한합니다.</p>
          <ul>
            <li>전송·저장 구간 암호화와 접근 권한 최소화</li>
            <li>인증 정보와 비밀정보의 분리 보관</li>
            <li>접속 기록 보호, 이상 징후 점검과 보안 업데이트</li>
            <li>수탁자에 대한 목적 외 이용 제한과 보안 관리</li>
          </ul>
        </div>
      </section>

      <section>
        <h2>9. 만 14세 미만</h2>
        <div><p>현재 법정대리인 동의 확인 기능이 없으므로 만 14세 미만 이용자의 회원가입을 받지 않습니다.</p></div>
      </section>

      <section>
        <h2>10. 담당자, 구제와 변경</h2>
        <div>
          <p>개인정보 관련 문의: support@lecue.app</p>
          <p>개인정보 관련 상담이나 분쟁조정은 개인정보 포털, 개인정보침해 신고센터(국번 없이 118), 개인정보분쟁조정위원회(1833-6972)에 문의할 수 있습니다.</p>
          <p>이 방침을 변경하면 시행 7일 전부터 알립니다. 이용자 권리에 중대한 변경은 최소 30일 전에 알리고 법령상 필요한 경우 별도 동의를 받습니다.</p>
        </div>
      </section>
    </LegalPage>
  );
}
