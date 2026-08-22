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
      description="Lecue는 계정 정보와 강의 데이터를 서비스 제공에 필요한 범위에서만 처리합니다. 강의실 기록은 계정에 저장되며, 개인 AI API 키는 이용자가 선택한 경우에만 암호화해 저장합니다."
    >
      <section>
        <h2>1. 기본 원칙</h2>
        <div>
          <p>
            Lecue 운영자(이하 “운영자”)는 개인정보 보호법 등 관계 법령을 준수하며, 이용자가 어떤 정보가 왜 필요한지 알 수 있도록 이 방침을 공개합니다.
          </p>
          <ul>
            <li>서비스 제공에 필요한 정보만 수집합니다.</li>
            <li>강의 음성과 질문은 광고 프로필 작성이나 마케팅에 사용하지 않습니다.</li>
            <li>법적 근거가 없거나 이용자가 별도로 동의하지 않은 제3자 판매·제공을 하지 않습니다.</li>
            <li>AI 답변은 이용자에게 법적·재정적 영향을 주는 자동 의사결정에 사용하지 않습니다.</li>
          </ul>
        </div>
      </section>

      <section>
        <h2>2. 처리하는 정보</h2>
        <div className={styles.tableWrap}>
          <table>
            <thead><tr><th>구분</th><th>항목</th><th>수집 시점</th><th>필수 여부</th></tr></thead>
            <tbody>
              <tr><td>계정</td><td>이메일, Supabase 이용자 ID, 가입·로그인 일시</td><td>회원가입·로그인</td><td>필수</td></tr>
              <tr><td>소셜 로그인</td><td>Google 계정 식별자, 이메일, Google이 제공하는 이름·프로필 이미지</td><td>Google 로그인 선택 시</td><td>선택</td></tr>
              <tr><td>강의 이용</td><td>강의실·수업 제목, 실시간 스크립트, 질문, AI 답변, 검색 출처, 기록 시간, 이전 수업 검색용 임베딩</td><td>강의 기록·질문</td><td>서비스 이용 시</td></tr>
              <tr><td>음성</td><td>마이크에서 입력되는 강의 음성 스트림</td><td>강의 기록 중</td><td>서비스 이용 시</td></tr>
              <tr><td>개인 AI 연결</td><td>선택한 AI 공급자·모델, 이용자가 직접 입력한 API 키</td><td>개인 AI 선택·질문 시</td><td>선택</td></tr>
              <tr><td>기술 정보</td><td>IP 주소, 브라우저·기기 정보, 접속 일시, 쿠키, 오류 및 보안 로그</td><td>접속·이용 과정</td><td>자동 생성</td></tr>
              <tr><td>결제</td><td>상품, 결제 금액·시각·상태, 거래 식별자, 환불 내역</td><td>향후 유료 결제 시</td><td>결제 시</td></tr>
              <tr><td>문의</td><td>이메일, 문의 내용, 답변 기록</td><td>고객 문의 시</td><td>문의 시</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2>3. 이용 목적</h2>
        <div>
          <ul>
            <li>회원 식별, 로그인 유지, 계정 보호와 부정 이용 방지</li>
            <li>실시간 음성 인식, 강의 스크립트 표시, 질문 시점까지의 강의 맥락을 반영한 답변 제공</li>
            <li>필요한 경우 최신 정보 확인을 위한 웹 검색과 출처 표시</li>
            <li>이용자가 선택한 외부 AI 공급자로 질문을 전달하고 답변을 표시하는 개인 API 키 연결</li>
            <li>기록 시간 산정, 잔여 시간 관리, 결제·환불 처리</li>
            <li>오류 분석, 보안 사고 대응, 서비스 품질과 음성 인식 성능 개선</li>
            <li>문의 처리, 법적 의무 이행과 분쟁 대응</li>
          </ul>
          <p><strong>운영자는 강의 내용이나 질문을 맞춤 광고에 사용하지 않습니다.</strong></p>
        </div>
      </section>

      <section>
        <h2>4. 저장 위치와 기간</h2>
        <div>
          <h3>강의실과 수업 기록</h3>
          <p>
            강의실 이름, 수업 제목, 스크립트, 질문과 답변은 회원 계정에 연결해 Supabase에 저장합니다. 같은 강의실의 관련 이전 수업을 찾기 위해 스크립트를 문단 묶음으로 나누고 OpenAI에서 생성한 수치형 임베딩을 함께 저장합니다. 음성 원본은 운영자 서버에 저장하지 않고 음성 인식 처리를 위해 Deepgram으로 실시간 전송합니다.
          </p>
          <h3>이용자가 입력한 AI API 키</h3>
          <p>
            저장을 선택하지 않은 개인 API 키는 현재 브라우저 탭의 메모리에만 두고 질문 요청 중에만 사용합니다. 이용자가 “내 계정에 저장”을 선택하면 Supabase Vault에 암호화해 보관하며, 키 원문은 계정 화면이나 브라우저로 다시 보내지 않습니다. 질문할 때 운영자 서버가 해당 키를 복호화해 선택한 AI 공급자에 전달합니다. 키 값은 애플리케이션 로그와 오류 응답에 기록하지 않습니다. 이용자는 모델 설정에서 저장된 키를 교체하거나 삭제할 수 있습니다.
          </p>
          <h3>보유 기간</h3>
          <ul>
            <li>회원 계정: 회원 탈퇴 시까지. 탈퇴 처리와 백업 반영에 필요한 정보는 최대 30일 이내 삭제</li>
            <li>계정에 저장한 개인 AI API 키: 이용자가 삭제하거나 회원 탈퇴할 때까지</li>
            <li>강의실·수업 기록과 검색용 임베딩: 이용자가 삭제하거나 회원 탈퇴할 때까지</li>
            <li>접속·보안 로그: 생성일로부터 3개월. 보안 사고 조사 중인 경우 조사 종료 시까지</li>
            <li>고객 문의와 분쟁 처리 기록: 처리 완료 후 3년</li>
            <li>표시·광고 기록: 6개월</li>
            <li>계약, 청약철회, 결제와 서비스 공급 기록: 5년</li>
          </ul>
          <p>법령에 따라 보존하는 정보는 별도 분리하여 보관하고 정해진 목적 외에는 이용하지 않습니다.</p>
        </div>
      </section>

      <section>
        <h2>5. 제3자 제공</h2>
        <div>
          <p>
            운영자는 원칙적으로 개인정보를 제3자에게 제공하지 않습니다. 다만 이용자가 별도로 동의한 경우, 법률에 특별한 규정이 있거나 생명·신체의 급박한 위험에 대응하기 위해 필요한 경우에는 관계 법령이 허용하는 범위에서 제공할 수 있습니다.
          </p>
          <p>아래 6항의 클라우드·AI 사업자는 운영자를 대신해 서비스를 처리하는 수탁자이며, 개인정보를 독자적인 광고 목적으로 이용하도록 허용하지 않습니다.</p>
        </div>
      </section>

      <section>
        <h2>6. 처리 위탁과 국외 이전</h2>
        <div>
          <p>
            서비스의 계정 인증, 음성 인식과 기본 AI 답변을 위해 다음 사업자에게 처리를 위탁합니다. 이용자가 개인 AI를 선택하면 이용자의 요청에 따라 해당 공급자에도 API 키, 질문 시점까지의 스크립트와 질문이 전송됩니다. 데이터는 인터넷 암호화 통신으로 서비스 이용 시점에 전송됩니다.
          </p>
          <div className={styles.tableWrap}>
            <table>
              <thead><tr><th>수탁자</th><th>처리 목적·항목</th><th>이전 국가·기간</th><th>거부 방법과 영향</th></tr></thead>
              <tbody>
                <tr>
                  <td><a href="https://supabase.com/privacy" target="_blank" rel="noreferrer">Supabase, Inc.</a></td>
                  <td>계정 인증·세션 관리, 강의실·수업 기록 저장과 선택한 개인 AI 키의 암호화 보관: 이메일, 계정 식별자, 인증 로그, 스크립트·질문·답변·임베딩, 암호화된 API 키</td>
                  <td className={styles.placeholder}>미국 또는 프로젝트 리전 · 배포 전 정확한 리전 확정 필요 / 회원 탈퇴 시까지</td>
                  <td>회원가입을 하지 않으면 이전을 거부할 수 있으나 계정 기반 기능 이용 불가</td>
                </tr>
                <tr>
                  <td><a href="https://deepgram.com/privacy" target="_blank" rel="noreferrer">Deepgram, Inc.</a></td>
                  <td>실시간 음성 인식: 마이크 음성 스트림, 언어·모델 설정</td>
                  <td>미국 / 실시간 처리 및 해당 사업자의 계약·보안 정책상 기간</td>
                  <td>마이크 권한을 허용하지 않으면 거부 가능하나 실시간 스크립트 이용 불가</td>
                </tr>
                <tr>
                  <td><a href="https://openai.com/policies/privacy-policy/" target="_blank" rel="noreferrer">OpenAI, L.L.C.</a></td>
                  <td>기본 AI 답변, 필요한 웹 검색과 이전 수업 검색용 임베딩 생성: 질문 시점까지의 스크립트, 관련 이전 수업 문단, 질문, 스크립트 문단 묶음, 임의화된 안전 식별자, 개인 연결 시 API 키</td>
                  <td>미국 등 OpenAI 처리 지역 / OpenAI의 API 계정 설정·보존 정책에 따른 기간</td>
                  <td>질문 기능 또는 OpenAI 개인 연결을 사용하지 않으면 거부 가능</td>
                </tr>
                <tr>
                  <td><a href="https://www.anthropic.com/legal/privacy" target="_blank" rel="noreferrer">Anthropic, PBC</a></td>
                  <td>이용자가 선택한 Claude 답변과 필요한 웹 검색: 질문 시점까지의 스크립트, 질문, 개인 API 키</td>
                  <td>Anthropic이 고지한 처리 국가 / 이용자의 API 계정 설정·Anthropic 보존 정책에 따른 기간</td>
                  <td>Claude 개인 연결을 선택하지 않으면 이전 없이 기본 AI 이용 가능</td>
                </tr>
                <tr>
                  <td><a href="https://policies.google.com/privacy" target="_blank" rel="noreferrer">Google LLC</a></td>
                  <td>선택한 Google 로그인: 계정 식별자, 이메일, 이름·프로필 이미지</td>
                  <td>Google이 고지한 처리 국가와 기간</td>
                  <td>이메일 회원가입을 선택하면 Google 이전 없이 이용 가능</td>
                </tr>
                <tr>
                  <td><a href="https://policies.google.com/privacy" target="_blank" rel="noreferrer">Google LLC</a></td>
                  <td>이용자가 선택한 Gemini 답변과 필요한 Google 검색: 질문 시점까지의 스크립트, 질문, 개인 API 키</td>
                  <td>Google이 고지한 처리 국가 / 이용자의 Gemini API 계정 설정·Google 보존 정책에 따른 기간</td>
                  <td>Gemini 개인 연결을 선택하지 않으면 이전 없이 기본 AI 이용 가능</td>
                </tr>
                <tr>
                  <td className={styles.placeholder}>결제대행사 확정 필요</td>
                  <td>향후 결제·환불: 결제수단 정보, 거래 식별자와 상태</td>
                  <td className={styles.placeholder}>결제 도입 전 확정</td>
                  <td>결제하지 않으면 유료 시간 구매 불가</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p>
            OpenAI Responses API 요청은 <code>store: false</code>로 전송합니다. 이용자의 개인 API 키로 연결한 서비스의 보존 기간, 학습 사용 여부와 지역 설정은 해당 이용자가 AI 공급자와 체결한 계약 및 계정 설정을 따릅니다. 운영자는 이용자가 선택한 외부 공급자의 계정 설정을 대신 변경할 수 없습니다.
          </p>
        </div>
      </section>

      <section>
        <h2>7. 쿠키와 자동 수집</h2>
        <div>
          <p>로그인 상태 유지와 보안을 위해 Supabase 인증 쿠키를 사용합니다. 이 쿠키는 서비스 제공에 필수이므로 브라우저에서 차단하면 로그인 기능이 동작하지 않을 수 있습니다.</p>
          <p>현재 맞춤 광고 쿠키나 제3자 광고 추적 도구는 사용하지 않습니다. 분석 도구를 추가할 경우 도구 이름, 수집 항목, 거부 방법을 이 방침에 먼저 공개합니다.</p>
        </div>
      </section>

      <section>
        <h2>8. 이용자의 권리</h2>
        <div>
          <p>이용자는 자신의 개인정보에 대해 열람, 전송, 정정·삭제, 처리정지, 동의 철회와 회원 탈퇴를 요구할 수 있습니다.</p>
          <ol>
            <li>계정 설정에서 직접 수정·삭제하거나 개인정보 담당 창구에 요청합니다.</li>
            <li>운영자는 요청자의 본인 여부를 확인한 뒤 법령이 정한 기간 안에 조치 결과를 알립니다.</li>
            <li>다른 법령에서 보관을 요구하거나 타인의 권리를 침해할 우려가 있으면 일부 요청이 제한될 수 있으며 그 사유를 안내합니다.</li>
          </ol>
          <p className={styles.placeholder}>개인정보 요청 이메일: [정식 배포 전 입력]</p>
        </div>
      </section>

      <section>
        <h2>9. 파기 방법</h2>
        <div>
          <p>보유 기간이 끝나거나 처리 목적이 달성된 정보는 지체 없이 파기합니다. 전자 파일은 복구하기 어려운 방식으로 삭제하고, 출력물은 분쇄하거나 소각합니다. 법령상 보존 대상은 별도 저장소로 분리하고 접근 권한을 제한합니다.</p>
        </div>
      </section>

      <section>
        <h2>10. 안전성 확보 조치</h2>
        <div>
          <ul>
            <li>HTTPS와 보안 WebSocket을 이용한 전송 구간 암호화</li>
            <li>운영용 장기 API 키의 브라우저 노출 금지와 음성 인식용 단기 토큰 사용</li>
            <li>개인 API 키의 Vault 암호화 저장, 브라우저 재노출·로그 기록 금지와 허용된 공급자 주소로만 전송</li>
            <li>서비스 운영 권한 최소화, 인증 정보와 비밀키의 환경 변수 분리</li>
            <li>접속 기록 보호, 오류·이상 징후 점검과 보안 업데이트</li>
            <li>수탁자 계약과 설정을 통한 목적 외 이용 제한</li>
          </ul>
        </div>
      </section>

      <section>
        <h2>11. 만 14세 미만</h2>
        <div>
          <p>현재 서비스는 법정대리인 동의 확인 기능을 제공하지 않으므로 만 14세 미만 이용자의 회원가입을 받지 않습니다. 해당 기능을 도입하기 전까지 만 14세 미만 이용자는 서비스를 이용할 수 없습니다.</p>
        </div>
      </section>

      <section>
        <h2>12. 권리 침해 구제</h2>
        <div>
          <p>개인정보 관련 상담이나 분쟁조정은 다음 기관에 문의할 수 있습니다.</p>
          <ul>
            <li><a href="https://www.privacy.go.kr" target="_blank" rel="noreferrer">개인정보 포털</a></li>
            <li><a href="https://privacy.kisa.or.kr" target="_blank" rel="noreferrer">개인정보침해 신고센터</a> · 국번 없이 118</li>
            <li><a href="https://www.kopico.go.kr" target="_blank" rel="noreferrer">개인정보분쟁조정위원회</a> · 1833-6972</li>
          </ul>
        </div>
      </section>

      <section>
        <h2>13. 책임자와 변경</h2>
        <div>
          <p className={styles.placeholder}>개인정보 보호책임자: [성명 또는 담당 부서], 연락처: [이메일·전화번호]</p>
          <p>이 방침을 변경할 때에는 시행 7일 전부터 서비스에 알립니다. 수집 항목 확대, 제3자 제공 등 이용자 권리에 중대한 변경은 최소 30일 전에 알리고 필요한 경우 별도 동의를 받습니다.</p>
        </div>
      </section>
    </LegalPage>
  );
}
