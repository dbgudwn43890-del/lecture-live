import type { Metadata } from "next";

import LegalPage from "../../legal-page";
import styles from "../../legal.module.css";

export const metadata: Metadata = {
  title: "Terms of Service | Lecue",
  description: "Terms for Lecue, including term passes, refunds, recording duties, AI answers, and personal API keys.",
};

export default function EnglishTermsPage() {
  return (
    <LegalPage
      locale="en"
      title="Terms of Service"
      description="These terms govern Lecue, an in-person lecture transcription and question service, including planned term passes, refunds, recording responsibilities, and optional personal AI connections."
    >
      <section><h2>1. Purpose and agreement</h2><div><p>These Terms govern the web service and related functions provided by the operator of Lecue (“we”). They become effective when posted during account creation or use and accepted by the user (“member”).</p><p>We may change these Terms within applicable law. Ordinary changes will be announced 7 days in advance; material or unfavorable changes 30 days in advance. Separate consent will be obtained where law requires it.</p></div></section>

      <section><h2>2. Definitions</h2><div><ul>
        <li><strong>Service:</strong> Lecue, which transcribes an in-person lecture and answers from lecture context.</li>
        <li><strong>Lecture record:</strong> title, speech-recognition result, question, answer, sources, and recorded time.</li>
        <li><strong>Classroom:</strong> a space that groups lectures for one subject and can use relevant earlier lectures in that classroom as supporting context.</li>
        <li><strong>Lecture:</strong> one continuous recording started and ended inside a classroom, limited to 3 hours per session.</li>
        <li><strong>Term pass:</strong> a product with a fixed access term and a recording allowance available during that term.</li>
        <li><strong>Monthly subscription:</strong> a paid product that renews every month until the member cancels.</li>
        <li><strong>Usage time:</strong> recording time included in a term pass or free trial.</li>
        <li><strong>Content:</strong> text or audio submitted, transmitted, or generated through the Service.</li>
        <li><strong>Personal AI connection:</strong> the optional use of the member's OpenAI, Anthropic, or Google Gemini API key, either once in the current tab or saved encrypted to the account.</li>
      </ul></div></section>

      <section><h2>3. Accounts</h2><div><ol>
        <li>Members may use Google sign-in or email and password.</li>
        <li>Email sign-up requires one initial address confirmation; later visits use ordinary sign-in.</li>
        <li>Members must provide accurate information and protect account access.</li>
        <li>Users under 14 may not register because the current Service has no verified parental-consent flow. A higher local minimum age applies where required.</li>
        <li>Use of another person's account or circumvention of account restrictions may lead to suspension.</li>
      </ol></div></section>

      <section><h2>4. What the Service provides</h2><div><ul>
        <li>Live transcription of microphone audio.</li>
        <li>AI answers based on lecture context available at question time.</li>
        <li>Selective web search and source display when current information or outside verification is needed.</li>
        <li>Optional OpenAI, Anthropic Claude, or Google Gemini answers using a member-provided API key.</li>
        <li>Continued transcription while an answer is generated.</li>
        <li>Storage and review by classroom, with relevant earlier lectures in the same classroom available as supporting context.</li>
        <li>Record deletion and usage-balance functions planned before the paid public launch.</li>
      </ul><p>Details may change during beta validation or because of technology or law. Material reductions or discontinuation will be announced in advance where practicable.</p></div></section>

      <section><h2>5. Recording permission</h2><div><ol>
        <li>Members must use the Service only where recording is permitted.</li>
        <li>The member is responsible for notices and consent required by the lecturer, institution, attendees, copyright rules, and local law.</li>
        <li>Do not process private third-party conversations, unlawfully intrusive material, trade secrets, or content whose recording or transmission is prohibited.</li>
        <li>We may stop recording, remove content, or restrict an account after a credible violation report or reasonable suspicion.</li>
      </ol></div></section>

      <section><h2>6. Content rights</h2><div><p>Rights owned by a member, lecturer, institution, or other lawful owner are not transferred to us merely because the Service is used. The member authorizes transmission and processing only as needed to provide the Service, handle errors, and maintain security. We do not publish or use lecture content for advertising or sale without separate permission.</p></div></section>

      <section><h2>7. AI answers, search, and personal keys</h2><div><ol>
        <li>Speech recognition and AI answers may omit, mishear, or inaccurately explain information.</li>
        <li>Answers are study aids, not the lecturer's official statement, an exam answer, or legal, medical, tax, or investment advice.</li>
        <li>When search is used, sources are shown where possible, but we do not guarantee an external site's accuracy, safety, or continuing availability.</li>
        <li>Important decisions should be checked against original and independently reliable material.</li>
        <li>When earlier lectures are used, Lecue retrieves only question-relevant transcript excerpts from the same classroom. It does not mix records from another classroom and uses only the current lecture when no relevant match is found.</li>
        <li>A personal AI connection sends the relevant transcript and question to the selected provider. That provider's terms, privacy policy, account settings, limits, and charges apply.</li>
        <li>Members may use only keys validly issued to them and are responsible for provider billing and permissions.</li>
        <li>Encrypted account storage is optional. A member may replace or delete a saved key at any time, and plaintext is not redisplayed in the browser.</li>
      </ol></div></section>

      <section><h2>8. Planned pricing, free trial, and recurring billing</h2><div>
        <p><strong>The current beta is free and no payment is taken.</strong> Final pricing, launch date, taxes, currency, and payment conditions will be shown before paid service begins.</p>
        <div className={styles.tableWrap}><table><thead><tr><th>Planned product</th><th>Access</th><th>Price</th><th>Recording included</th></tr></thead><tbody>
          <tr><td>First try</td><td>7 days</td><td>Free</td><td>One lecture · up to 3 hours · once per account</td></tr>
          <tr><td>Monthly subscription</td><td>1 month</td><td>$17.99</td><td>120 hours each month</td></tr>
          <tr><td>Semester pass</td><td>5 months</td><td>$79</td><td>600 hours total</td></tr>
        </tbody></table></div>
        <ul>
          <li>The free trial ends at the earlier of 7 days after activation or completion of its one lecture, which may run for up to 3 hours.</li>
          <li>During the trial, checkout will clearly show the paid conversion date, pre- and post-conversion price, monthly billing cycle, payment method, cancellation method, and effect of cancellation.</li>
          <li><strong>The first charge occurs only after the member separately and expressly accepts those paid-conversion terms.</strong> Account creation or acceptance of the general Terms alone is not treated as consent to recurring billing.</li>
          <li>Without separate consent, the trial ends without a charge. A member who did consent may still cancel before the first charge and will not be billed.</li>
          <li>The Monthly subscription renews for $17.99 on the same billing date each month until cancelled. We obtain renewed consent where a change in price or billing terms requires it.</li>
          <li>Members may cancel in account billing settings at any time. Cancellation stops the next charge and normally takes effect after the already-paid period. Section 9 applies to a request for immediate termination and refund.</li>
          <li>The Semester pass is a single five-month purchase and does not renew automatically.</li>
          <li>Monthly includes 120 hours each month, and Semester includes 600 hours across five months.</li>
          <li>Each lecture can record continuously for up to 3 hours. If allowance remains, the member may start another lecture afterward.</li>
          <li>Unused Monthly allowance does not roll over, and unused Semester allowance expires after five months.</li>
          <li>Time is deducted by the second only while microphone audio is actively sent for recognition.</li>
          <li>Connecting, paused, failed transmission, and review time are not deducted.</li>
          <li>Lecture questions, AI answers, and necessary web search are included in recorded-time pricing.</li>
          <li>Using a personal AI key does not change Lecue time deduction. Provider token and search fees are separate.</li>
          <li>Recording pauses after the allowance is exhausted until renewal or a new purchase. Existing content remains available.</li>
          <li>We retain electronic records of paid-conversion consent and cancellation, and provide conversion, recurring-payment, and price-change notices at the time and in the manner required by applicable law.</li>
          <li>Displayed USD prices may exclude taxes collected according to the buyer's region. Final checkout shows the amount due.</li>
        </ul>
      </div></section>

      <section><h2>9. Cancellations and refunds</h2><div><ol>
        <li>A charge, including an automatic renewal charge, is fully refundable within 7 days if none of that paid period's recording allowance has been used.</li>
        <li>Starting a digital recording service may limit cooling-off rights for the portion already supplied where law permits. It does not automatically remove rights over divisible, unused service or any mandatory cancellation right.</li>
        <li>After partial use, an immediate cancellation refund deducts the used portion based on remaining service time and recording allowance, plus only those deductions permitted by applicable law and consumer-dispute standards.</li>
        <li><strong>Failure to cancel during the free trial does not by itself make every refund unavailable.</strong> We consider whether paid use began, when the request was made, and the member's mandatory rights. Free or promotional access itself has no cash value.</li>
        <li>Where our fault makes the contracted service materially unavailable or different from its description, we provide the refund or remedy required by applicable law.</li>
        <li>We request reversal within 3 business days after approval where the payment method permits; a bank or card network may take longer to post it.</li>
        <li>Mandatory cancellation, cooling-off, and consumer rights in the member's country prevail over any less favorable term here.</li>
      </ol><p className={styles.placeholder}>Refund email and processor procedure: [add before paid launch]</p></div></section>

      <section><h2>10. Interruptions and service credit</h2><div><p>Maintenance, network failures, external API failures, or events beyond reasonable control may interrupt the Service. Planned work will be announced where practicable. If our fault makes paid recording continuously unavailable for at least 10 minutes, we will restore the verified affected time plus 10%, unless applicable law provides a better remedy.</p></div></section>

      <section><h2>11. Prohibited conduct</h2><div><ul>
        <li>Recording or disclosing private speech without the required permission.</li>
        <li>Infringing copyright, privacy, trade-secret, or other rights.</li>
        <li>Using the Service for unlawful content, fraud, harassment, discrimination, or unsafe conduct.</li>
        <li>Account resale or sharing, payment fraud, time manipulation, or security circumvention.</li>
        <li>Using another person's API key or an organization key without authority.</li>
        <li>Excessive automated calls, reverse engineering, or scraping that disrupts reliable operation.</li>
      </ul></div></section>

      <section><h2>12. Restriction and account closure</h2><div><p>Depending on severity, we may warn, restrict features, suspend, or terminate an account. Except for urgent security or rights violations, we will explain the reason and provide an opportunity to respond. Members may close their account at any time. Data is deleted under the Privacy Policy, and remaining paid time may be eligible for a refund under Section 9.</p></div></section>

      <section><h2>13. Responsibility</h2><div><p>We use reasonable care to provide a stable service and protect personal data. Liability for loss caused by our intentional misconduct or gross negligence follows applicable law.</p><p>To the extent permitted by law, we are not responsible where loss results without our fault from networks, user devices, recordings made without lawful permission, a personal AI provider's outage or pricing change, or unverified reliance on an AI answer. Nothing in these Terms excludes a non-waivable consumer right.</p></div></section>

      <section><h2>14. Governing law, language, and disputes</h2><div><p>We and the member should first try to resolve a dispute in good faith. Korean consumer and privacy mediation bodies may be available. These Terms are governed by the laws of the Republic of Korea, and litigation follows the court jurisdiction provided by Korean civil procedure law, without depriving a consumer of mandatory protections available in their place of residence.</p><p>This English text is provided for accessibility. If it conflicts with the Korean Terms, the Korean text controls to the extent permitted by applicable law.</p></div></section>

      <section><h2>15. Operator details</h2><div><div className={styles.tableWrap}><table><tbody>
        <tr><th>Legal name and representative</th><td className={styles.placeholder}>[add before public launch]</td></tr>
        <tr><th>Business address</th><td className={styles.placeholder}>[add before public launch]</td></tr>
        <tr><th>Business registration</th><td className={styles.placeholder}>[add before public launch]</td></tr>
        <tr><th>E-commerce registration</th><td className={styles.placeholder}>[add before paid launch]</td></tr>
        <tr><th>Support</th><td className={styles.placeholder}>[add email and phone]</td></tr>
      </tbody></table></div></div></section>
    </LegalPage>
  );
}
