import type { Metadata } from "next";

import LegalPage from "../legal-page";

export const metadata: Metadata = {
  title: "환불 정책 | Lecue",
  description: "Lecue 월간·4개월권·한 학기권 상품의 환불 기준을 안내합니다.",
};

export default function RefundPolicyPage() {
  return (
    <LegalPage
      title="환불 정책"
      description="모든 주문의 판매자는 Paddle.com Market Limited이며, 결제와 환불 처리는 이 정책과 함께 Paddle의 약관을 따릅니다."
    >
      <section><h2>제1조 환불 대상</h2><div><p>결제 후 7일 이내이고 해당 유료 기간의 크레딧을 사용하지 않았다면 전액 환불을 요청할 수 있습니다.</p><p>일부 사용한 뒤 요청하면 이미 제공된 서비스와 사용한 크레딧을 반영해 관계 법령이 허용하는 범위에서 금액을 공제할 수 있습니다.</p></div></section>

      <section><h2>제2조 무료 체험</h2><div><p>7일 무료 체험은 결제가 아니므로 환불 대상이 아닙니다. 체험이 유료 월간 구독으로 전환되어 결제가 발생한 경우에는 제1조 기준이 그 결제 건에 적용됩니다.</p></div></section>

      <section><h2>제3조 구독형(월간)</h2><div><p>구독 관리 화면에서 언제든 해지할 수 있으며, 해지하면 다음 결제가 중단됩니다. 이미 결제한 이용 기간은 제1조에 따른 환불 승인 없이 즉시 종료되지 않습니다.</p></div></section>

      <section><h2>제4조 단건형(4개월권·한 학기권)</h2><div><p>4개월권과 한 학기권은 자동 갱신이 없는 일회성 결제이며, 환불 기준과 사용분 공제는 제1조와 동일하게 적용됩니다.</p></div></section>

      <section><h2>제5조 운영자 책임</h2><div><p>운영자 책임으로 서비스를 제공하지 못했거나 표시된 내용과 현저히 다르게 제공한 경우, 7일 기준과 무관하게 관계 법령에 따른 환불이나 보상을 제공합니다.</p></div></section>

      <section><h2>제6조 신청 방법</h2><div><p>계정 이메일과 결제일을 적어 <a href="mailto:dbgudwn43890@gmail.com">dbgudwn43890@gmail.com</a>으로 요청하세요. 영업일 기준 2일 이내 답변합니다. 승인된 환불은 Paddle과 결제수단의 처리 기간에 따라 반영됩니다.</p></div></section>
    </LegalPage>
  );
}
