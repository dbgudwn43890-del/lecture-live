import type { Metadata } from "next";

import LegalPage from "../../legal-page";

export const metadata: Metadata = {
  title: "Refund Policy | Lecue",
  description: "How refunds work for Lecue's Monthly, Term Pass, and Semester Pass plans.",
};

export default function EnglishRefundPolicyPage() {
  return (
    <LegalPage
      locale="en"
      title="Refund Policy"
      description="Paddle.com Market Limited is the Merchant of Record for all orders and handles order payments and refunds under its own terms, in addition to this policy."
    >
      <section><h2>1. Eligibility</h2><div><p>You may request a full refund within 7 days of a payment if none of that paid period's credits have been used.</p><p>If you have partially used the credits from that payment, we may deduct the value of the service and credits already supplied, to the extent allowed by applicable law.</p></div></section>

      <section><h2>2. Free trial</h2><div><p>The 7-day free trial is not a payment and has nothing to refund. If the trial converts to a paid Monthly subscription and you are charged, the eligibility rule in Section 1 applies to that charge.</p></div></section>

      <section><h2>3. Subscriptions (Monthly)</h2><div><p>You can cancel a Monthly subscription at any time from billing management. Cancelling stops the next renewal charge; the period you already paid for is not ended early unless a refund is approved under Section 1.</p></div></section>

      <section><h2>4. One-time passes (Term Pass, Semester Pass)</h2><div><p>Term Pass and Semester Pass are one-time purchases with no automatic renewal. The Section 1 refund window and usage deduction apply the same way.</p></div></section>

      <section><h2>5. Our fault</h2><div><p>If we fail to deliver the Service due to our fault, or the Service is materially different from its description, we provide the refund or remedy required by applicable law regardless of the 7-day window.</p></div></section>

      <section><h2>6. How to request</h2><div><p>Email <a href="mailto:dbgudwn43890@gmail.com">dbgudwn43890@gmail.com</a> with your account email and payment date. We typically respond within 2 business days. An approved refund is processed by Paddle and reflected according to your payment method's processing time.</p></div></section>
    </LegalPage>
  );
}
