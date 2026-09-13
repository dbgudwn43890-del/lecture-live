import type { Metadata } from "next";

import LegalPage from "../../legal-page";
import { formatLegalDate, PRIVACY_POLICY_DATES } from "../../lib/legal-date";
import styles from "../../legal.module.css";

export const metadata: Metadata = {
  title: "Privacy Policy | Lecue",
  description: "How Lecue handles account, lecture, voice, and payment data.",
};

export default function EnglishPrivacyPage() {
  return (
    <LegalPage
      locale="en"
      title="Privacy Policy"
      effectiveDate={PRIVACY_POLICY_DATES.effective}
      description="Lecue processes only the data needed for accounts, lecture records, answers, and payments. We do not use lecture content for targeted advertising."
    >
      <section><h2>1. Data and purposes</h2><div className={styles.tableWrap}><table>
        <thead><tr><th>Category</th><th>Data</th><th>Purpose</th><th>When</th></tr></thead>
        <tbody>
          <tr><td>Account</td><td>Email, internal account identifier, sign-up and sign-in time; name and profile image if Google sign-in is used</td><td>Identity, sessions, and account security</td><td>Sign-up and sign-in</td></tr>
          <tr><td>Lecture use</td><td>Classroom and lecture titles, transcripts, questions, answers, sources, and recorded time</td><td>Save and review lectures; answer from lecture context</td><td>Recording and questions</td></tr>
          <tr><td>Lecture materials</td><td>Text and search index extracted from uploaded lecture materials, and the original PDF file</td><td>Use material content and citations in answers, show material pages in lecture notes</td><td>Material upload</td></tr>
          <tr><td>Voice</td><td>Microphone audio stream; for online lectures, the audio stream of the browser tab you choose</td><td>Live speech recognition</td><td>While recording</td></tr>
          <tr><td>Personal AI</td><td>Selected provider and model; API key entered by the user</td><td>Use the AI provider selected by the user</td><td>When selected</td></tr>
          <tr><td>Service use</td><td>IP address, browser and device data, access time, cookies, error and security logs</td><td>Security, abuse prevention, and troubleshooting</td><td>Automatically during use</td></tr>
          <tr><td>Optional analytics</td><td>Static page category and title, known referring-site origin, browser/device data, allowlisted product events, locale, placement or input-source category, and validated advertising click or known campaign values</td><td>Product analytics and advertising measurement, without personalized ads</td><td>Only after affirmative analytics consent</td></tr>
          <tr><td>Payment</td><td>Product, amount, payment, subscription and refund status, customer and transaction identifiers supplied by the payment provider, and credit balance</td><td>Billing, subscriptions, credits, and refunds</td><td>Trial, payment, and refund</td></tr>
          <tr><td>Support</td><td>Email, request, and response history</td><td>Support and dispute handling</td><td>When support is contacted</td></tr>
        </tbody>
      </table></div><p>We do not sell personal data or use lecture audio, transcripts, or questions to create advertising profiles.</p></section>

      <section><h2>2. Retention</h2><div><ul>
        <li>Account, classroom, and lecture records: until deleted by the user or the account is closed.</li>
        <li>Saved personal AI key: until removed by the user or the account is closed.</li>
        <li>Access and security logs: 3 months, or until an active security investigation ends.</li>
        <li>Support and dispute records: 3 years after resolution.</li>
        <li>Advertising-display records: 6 months where Korean law requires them.</li>
        <li>Contract, cancellation, payment, and service-supply records: 5 years where Korean law requires them.</li>
      </ul><p>Records required by law are separated and used only for that legal purpose. Account deletion and backup propagation may take up to 30 days.</p></div></section>

      <section><h2>3. Storage and audio</h2><div>
        <p>Classroom names, lecture titles, transcripts, questions, and answers are linked to the account. Relevant earlier lectures in the same classroom may be used to answer a question.</p>
        <p>Lecue keeps the original PDF of uploaded lecture materials in private storage alongside the extracted text and search index, so lecture notes can show the user the relevant material page. The original opens only through a short-lived signed URL issued to the owner. Non-PDF materials are not kept as originals. Deleting a material also deletes its original file, extracted text, and index.</p>
        <p>Microphone audio, and for online lectures the audio of the browser tab you choose yourself, is streamed to a speech-recognition provider. Lecue does not separately store the original audio. The shared tab’s screen is displayed locally inside Lecue so you can watch while asking questions. It is never sent to Lecue’s servers or anyone else, nor stored. The chosen tab’s title and URL are not stored either.</p>
        <p>A personal AI key is stored only if the user chooses encrypted account storage. Otherwise it is used only in the current browser tab. A saved key is not redisplayed or written to application logs, and the user may replace or delete it at any time.</p>
      </div></section>

      <section><h2>4. Disclosure and payment data</h2><div>
        <p>We do not sell or disclose personal data to unrelated third parties without consent or another lawful basis. The providers below process data to deliver the Service.</p>
        <p>Paddle independently handles checkout, sale, tax, recurring billing, and refunds. Lecue receives transaction results and identifiers but does not store full card numbers.</p>
        <p>Depending on the user's location, our legal bases may include performance of a contract, consent, compliance with law, and legitimate interests in security and reliable operation where permitted.</p>
      </div></section>

      <section><h2>5. Service providers and international transfers</h2><div>
        <p>Data is transferred over encrypted networks when the relevant feature is used. A user can avoid an optional transfer by not selecting that feature; refusing a transfer needed for a core function makes that function unavailable.</p>
        <div className={styles.tableWrap}><table><thead><tr><th>Recipient</th><th>Purpose and data</th><th>Location, time, and retention</th></tr></thead><tbody>
          <tr><td><a href="https://supabase.com/privacy" target="_blank" rel="noreferrer">Supabase, Inc.</a></td><td>Account authentication and service data storage: email, account data, lecture records, uploaded lecture materials, and an optionally saved encrypted API key</td><td>Republic of Korea (AWS Seoul region) / at sign-up and storage / until deletion or account closure</td></tr>
          <tr><td><a href="https://soniox.com/privacy" target="_blank" rel="noreferrer">Soniox, Inc.</a></td><td>Live speech recognition for Korean lectures: microphone audio, chosen-tab audio</td><td>United States / while recording / provider retention policy</td></tr>
          <tr><td><a href="https://deepgram.com/privacy" target="_blank" rel="noreferrer">Deepgram, Inc.</a></td><td>Live speech recognition for English lectures and uploaded-recording transcription: microphone audio, chosen-tab audio, uploaded recordings</td><td>United States / while recording or transcribing / provider retention policy</td></tr>
          <tr><td><a href="https://openai.com/policies/privacy-policy/" target="_blank" rel="noreferrer">OpenAI, L.L.C.</a></td><td>AI answers, necessary web search, and relevant lecture retrieval: transcript, question, and related lecture records</td><td>United States and other disclosed processing locations / when asking / provider policy and account settings</td></tr>
          <tr><td><a href="https://www.anthropic.com/legal/privacy" target="_blank" rel="noreferrer">Anthropic, PBC</a></td><td>User-selected AI answers: transcript, question, and personal API key</td><td>United States and other disclosed processing locations / when selected / provider policy and account settings</td></tr>
          <tr><td><a href="https://policies.google.com/privacy" target="_blank" rel="noreferrer">Google LLC</a></td><td>Google sign-in, user-selected AI answers, or consented Google Analytics and Google Ads measurement: account data; transcript, question, and personal API key; or sanitized page and allowlisted event/attribution data, depending on the selected feature</td><td>United States and other disclosed processing locations / when selected or after analytics consent / provider policy and account settings</td></tr>
          <tr><td><a href="https://www.paddle.com/legal/privacy" target="_blank" rel="noreferrer">Paddle entities</a></td><td>Checkout, recurring billing, tax, refunds, and fraud prevention: name, email, billing, and purchase data</td><td>United Kingdom, United States, Canada, and other disclosed locations / at payment / as required for the transaction, law, and disputes</td></tr>
        </tbody></table></div>
        <p>A personal AI provider's terms, privacy policy, and user account settings also apply when that connection is used.</p>
      </div></section>

      <section><h2>6. Cookies and optional analytics</h2><div>
        <p>Essential authentication cookies maintain sign-in and protect sessions. Blocking them may prevent account functions from working. The first-party <code>lecue-analytics-consent</code> cookie stores “granted” or “denied” for up to one year so Lecue can remember the analytics choice. A missing or invalid value is treated as denied.</p>
        <p>If the user accepts, Lecue loads Google Analytics 4 for product analytics and advertising measurement. Analytics and advertising storage are enabled only then. Only after this consent, advertising measurement data may be shared with Google Ads to connect advertising clicks with eligible conversions. Ad personalization remains disabled, and Lecue does not use Google Signals, remarketing audiences, or personalized ads. Lecue does not send email addresses or other user-provided data for enhanced conversions. If the user rejects, Lecue does not load the Google tag or send cookieless analytics pings.</p>
        <p>Analytics receives manual page views reduced to known static route categories, fixed page titles, and known referring-site origins (or sanitized same-site paths). Arbitrary route segments and query values are removed; only format-validated Google advertising click identifiers and known allowlisted UTM source, medium, campaign, and creative values may remain. This privacy boundary means acquisition and attribution reports can be incomplete.</p>
        <p>Allowlisted events are limited to landing call-to-action clicks, starting Google or email authentication, a recording actually starting, a final successful answer, a newly generated review note becoming ready, and an eligible sign-up confirmed atomically by Lecue’s server. Event metadata is limited to fixed enums such as locale, placement, input-source category, or sign-up method. GA4 uses its own pseudonymous browser and analytics-session identifiers. Lecue does not send email, Lecue user/account/classroom-session identifiers, lecture or classroom names, questions, answers, transcripts, or raw URLs to analytics.</p>
        <p>The persistent “Analytics settings” control can reopen the choice at any time. Withdrawal changes consent to denied, removes accessible Google Analytics cookies, stops further app events, and reloads the page so the loaded tag is no longer active. Google Analytics delivery may also be blocked by browser or network settings.</p>
      </div></section>

      <section><h2>7. Your rights</h2><div><p>Subject to applicable law, users may request access, portability, correction, deletion, restriction, withdrawal of consent, and account closure.</p><ol><li>Use available account controls or contact the privacy address below.</li><li>We may verify identity and will respond within the legally required period.</li><li>If law requires retention or another person's rights would be harmed, we may limit a request and explain why.</li></ol></div></section>

      <section><h2>8. Deletion and security</h2><div><p>Data is deleted when its purpose or retention period ends. Electronic records are deleted using methods intended to prevent practical recovery, and legally retained records are separated and access-restricted.</p><ul><li>Encryption in transit and at rest, with least-privilege access.</li><li>Separate protection for credentials and secrets.</li><li>Protected access logs, security monitoring, and updates.</li><li>Purpose and security restrictions for service providers.</li></ul></div></section>

      <section><h2>9. Children</h2><div><p>We do not accept accounts from children under 14 because the Service has no verified parental-consent flow. A higher minimum age applies where local law requires it.</p></div></section>

      <section><h2>10. Contact, complaints, and changes</h2><div>
        <p>Privacy inquiries: support@lecue.app</p>
        <p>Users in Korea may also contact the privacy portal, the Korea Internet &amp; Security Agency privacy center at 118, or the Personal Information Dispute Mediation Committee at 1833-6972.</p>
        <p>We normally announce changes at least 7 days before they take effect. Material changes are announced at least 30 days in advance, and consent is obtained where required.</p>
      </div></section>
      <section><h2>11. Change history</h2><div><ul>
        <li><time dateTime={PRIVACY_POLICY_DATES.effective}>{formatLegalDate(PRIVACY_POLICY_DATES.effective, "en")}</time>: Privacy Policy effective date.</li>
        <li><time dateTime={PRIVACY_POLICY_DATES.dateClarified}>{formatLegalDate(PRIVACY_POLICY_DATES.dateClarified, "en")}</time>: Clarified the effective date and added this change history. No change to the data handling terms.</li>
      </ul></div></section>
    </LegalPage>
  );
}
