import type { Metadata } from "next";

import LegalPage from "../../legal-page";
import styles from "../../legal.module.css";

export const metadata: Metadata = {
  title: "Terms of Service | Lecue",
  description: "Terms for Lecue accounts, credits, billing, and refunds.",
};

export default function EnglishTermsPage() {
  return (
    <LegalPage
      locale="en"
      title="Terms of Service"
      description="These Terms govern Lecue accounts, lecture recording, AI answers, credits, billing, and refunds."
    >
      <section><h2>1. Agreement and changes</h2><div><p>These Terms govern the Service provided by the operator of Lecue (“we”) and the rights and duties of members. They take effect when accepted during sign-up or use.</p><p>We may change them within applicable law. We normally announce changes 7 days in advance and material or unfavorable changes 30 days in advance. Separate consent is obtained where required.</p></div></section>

      <section><h2>2. Accounts</h2><div><ol><li>Members may use Google sign-in or email and password.</li><li>Members must provide accurate information and protect account access.</li><li>Users under 14 may not register because the Service has no verified parental-consent flow. A higher local minimum age applies where required.</li><li>Using another person's account or bypassing restrictions may result in limits or suspension.</li></ol></div></section>

      <section><h2>3. Service</h2><div><p>Lecue transcribes an in-person lecture and provides AI answers using the lecture context available at question time and relevant records in the same classroom. It may also provide classroom storage, selective web search, optional personal AI connections, billing, and credit management.</p><p>We will give advance notice where practicable before materially reducing or ending an important function.</p></div></section>

      <section><h2>4. Recording and content rights</h2><div><ol><li>Members may use the Service only where recording is permitted and must give any notice or obtain any consent required by the lecturer, institution, attendees, and local law.</li><li>Do not process private conversations, intrusive material, trade secrets, or content whose recording or transmission is prohibited.</li><li>Using the Service does not transfer rights owned by a member or another lawful owner to us.</li><li>Members authorize processing only as needed to provide and secure the Service and handle errors. We do not publish, sell, or use lecture content for advertising without separate permission.</li></ol></div></section>

      <section><h2>5. AI answers and personal AI</h2><div><ol><li>Speech recognition and AI answers may omit, mishear, or inaccurately explain information.</li><li>Answers are study aids, not the lecturer's official statement, an exam answer, or legal, medical, tax, or investment advice.</li><li>Important decisions should be checked against original and independently reliable sources.</li><li>A personal AI connection sends the necessary lecture context and question to the provider selected by the member. That provider's terms, privacy policy, limits, and charges apply.</li><li>Members may use only keys validly issued to them and may replace or delete a saved key at any time.</li></ol></div></section>

      <section><h2>6. Plans and credits</h2><div>
        <div className={styles.tableWrap}><table><thead><tr><th>Plan</th><th>Term</th><th>Credits</th><th>Billing</th></tr></thead><tbody>
          <tr><td>Free trial</td><td>7 days</td><td>180 · multiple lectures · once per account</td><td>Converts to Monthly after trial</td></tr>
          <tr><td>Monthly</td><td>1 month</td><td>4,800 each billing period</td><td>Renews monthly until cancelled</td></tr>
          <tr><td>4-month pass</td><td>4 months</td><td>19,200</td><td>One-time purchase; no renewal</td></tr>
          <tr><td>Semester</td><td>6 months</td><td>28,800</td><td>One-time purchase; no renewal</td></tr>
        </tbody></table></div>
        <ul>
          <li>Checkout shows the actual price, tax, promotion, first charge date, and renewal amount.</li>
          <li>The trial ends after 7 days or when all 180 credits are used. Credits may be split across multiple lectures during the trial.</li>
          <li>One credit is charged for each started recording minute. A partial minute costs one credit, and the same minute in the same lecture is not charged twice.</li>
          <li>Each lecture may record for up to 3 hours. A new lecture may be started while credits remain.</li>
          <li>Monthly credits do not roll over. Credits from the 4-month and Semester passes expire when their respective terms end.</li>
          <li>Questions, AI answers, and necessary web search use no separate credit while recording.</li>
          <li>A personal AI connection follows the same Lecue credit rule. The external provider may charge the member separately.</li>
          <li>Recording stops when credits are exhausted, but existing records remain available.</li>
        </ul>
      </div></section>

      <section><h2>7. Payment and renewal</h2><div><ol><li>Paddle handles sale, payment, tax, recurring billing, and refunds. Paddle's buyer terms and privacy notice also apply at checkout.</li><li>Monthly and post-trial Monthly charges occur at the amount and date shown at checkout.</li><li>Members must review the product, amount, renewal cycle, and cancellation terms before purchase.</li><li>A subscription may be cancelled at any time through billing management. Cancellation stops the next charge; an already-paid period does not end immediately unless a refund is approved.</li></ol></div></section>

      <section><h2>8. Cancellation and refunds</h2><div><ol><li>A payment may be fully refunded within 7 days if none of that paid period's credits have been used.</li><li>After partial use, a refund may deduct the service and credits already supplied to the extent allowed by applicable law.</li><li>If our fault prevents delivery or the Service is materially different from its description, we provide the remedy required by law.</li><li>Mandatory consumer rights in a member's country override any less favorable term here.</li><li>Refund requests go to our support contact. An approved refund is posted according to Paddle and the payment method's processing time.</li></ol></div></section>

      <section><h2>9. Changes and interruptions</h2><div><p>Maintenance, network or external-service failures, security incidents, and events beyond reasonable control may interrupt the Service. Planned interruptions are announced where practicable.</p><p>If our fault prevents normal use of a paid service, we provide restored credits, an extension, a refund, or another remedy required by law and the plan.</p></div></section>

      <section><h2>10. Prohibited conduct</h2><div><ul><li>Recording or disclosing private speech without required permission.</li><li>Infringing copyright, privacy, trade-secret, or other rights.</li><li>Using the Service for unlawful content, fraud, harassment, or unsafe conduct.</li><li>Account sharing or resale, payment fraud, usage manipulation, or security circumvention.</li><li>Unauthorized API keys, disruptive automation, reverse engineering, or scraping.</li></ul></div></section>

      <section><h2>11. Restriction and closure</h2><div><p>Depending on severity, we may warn, limit, suspend, or terminate an account. Except for urgent security or rights violations, we explain the reason and how to respond.</p><p>Members may close an account at any time. Data is deleted under the Privacy Policy and refunds follow Section 8.</p></div></section>

      <section><h2>12. Responsibility</h2><div><p>We use reasonable care to provide a stable service and protect personal data, and remain liable as required by law for intentional misconduct or gross negligence.</p><p>To the extent permitted by law, we are not responsible for loss caused without our fault by networks, user devices, unauthorized recording, an external AI provider's outage, policy or pricing, or unverified reliance on an AI answer. Nothing here excludes a non-waivable consumer right.</p></div></section>

      <section><h2>13. Law, disputes, and language</h2><div><p>We and the member should first try to resolve disputes in good faith. Korean consumer, content, and privacy mediation bodies may be available.</p><p>These Terms are governed by the laws of the Republic of Korea and disputes follow the court jurisdiction provided by Korean civil procedure law, without removing mandatory protections in the consumer's country. If this translation conflicts with the Korean Terms, the Korean text controls to the extent permitted by law.</p></div></section>

      <section><h2>14. Operator details</h2><div><div className={styles.tableWrap}><table><tbody>
        <tr><th>Legal name and representative</th><td className={styles.placeholder}>[required]</td></tr>
        <tr><th>Business address</th><td className={styles.placeholder}>[required]</td></tr>
        <tr><th>Business registration</th><td className={styles.placeholder}>[required]</td></tr>
        <tr><th>E-commerce registration</th><td className={styles.placeholder}>[required before paid sales]</td></tr>
        <tr><th>Support</th><td className={styles.placeholder}>[email and phone required]</td></tr>
      </tbody></table></div></div></section>
    </LegalPage>
  );
}
