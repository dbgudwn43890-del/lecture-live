import type { Metadata } from "next";

import LegalPage from "../../legal-page";
import styles from "../../legal.module.css";

export const metadata: Metadata = {
  title: "Privacy Policy | Lecue",
  description: "How Lecue handles account, lecture, voice, and personal AI credential data.",
};

export default function EnglishPrivacyPage() {
  return (
    <LegalPage
      locale="en"
      title="Privacy Policy"
      description="Lecue processes account and lecture data only as needed to provide the service. Classroom records are saved to the account. A personal AI key is stored only when the user chooses encrypted account storage."
    >
      <section><h2>1. Our principles</h2><div>
        <p>The operator of Lecue (“we”) follows applicable data-protection law and explains what data is needed and why.</p>
        <ul><li>We collect only what is needed to provide and secure the service.</li><li>Lecture audio and questions are not used for advertising profiles or marketing.</li><li>We do not sell personal data or disclose it to unrelated third parties without consent or another lawful basis.</li><li>AI answers are not used to make decisions that create legal or similarly significant effects for users.</li></ul>
      </div></section>

      <section><h2>2. Data we process</h2><div className={styles.tableWrap}><table>
        <thead><tr><th>Category</th><th>Data</th><th>When</th></tr></thead>
        <tbody>
          <tr><td>Account</td><td>Email, Supabase user ID, sign-up and sign-in time</td><td>Account creation and sign-in</td></tr>
          <tr><td>Google sign-in</td><td>Google account identifier, email, and profile details Google provides</td><td>When selected</td></tr>
          <tr><td>Lecture use</td><td>Classroom and lecture titles, live transcript, questions, AI answers, sources, recorded time, and embeddings used to retrieve earlier lectures</td><td>While using a classroom</td></tr>
          <tr><td>Voice</td><td>Microphone audio stream</td><td>During active recording</td></tr>
          <tr><td>Personal AI</td><td>Selected provider and model; API key entered by the user</td><td>When selected, saved, or used</td></tr>
          <tr><td>Technical</td><td>IP address, browser and device data, cookies, access time, security and error logs</td><td>Automatically during access</td></tr>
          <tr><td>Payment</td><td>Product, amount, time, status, transaction ID, and refund history</td><td>When paid service launches</td></tr>
          <tr><td>Support</td><td>Email, request, and response history</td><td>When contacting support</td></tr>
        </tbody>
      </table></div></section>

      <section><h2>3. Why we use it</h2><div><ul>
        <li>Identify users, maintain sessions, protect accounts, and prevent abuse.</li>
        <li>Transcribe speech, display the lecture, and answer from context available at question time.</li>
        <li>Search the web and show sources when current or independently verified information is needed.</li>
        <li>Send a request to the external AI provider the user selects.</li>
        <li>Measure recorded time, manage balances, and process future payments and refunds.</li>
        <li>Diagnose errors, respond to security incidents, improve quality, answer support requests, and meet legal obligations.</li>
      </ul><p><strong>We do not use lecture content or questions for targeted advertising.</strong></p></div></section>

      <section><h2>4. Storage and retention</h2><div>
        <h3>Classroom and lecture records</h3><p>Classroom names, lecture titles, transcripts, questions, and answers are linked to the member's account and stored in Supabase. To retrieve relevant earlier lectures from the same classroom, transcripts are grouped into passages and stored with numeric embeddings created by OpenAI. We do not store original audio on our server. The existing classroom streams audio to Deepgram; the separate Korean STT lab sends overlapping audio windows of up to 10 seconds to Cloudflare Workers AI.</p>
        <h3>Personal AI keys</h3><p>If the user does not choose storage, the key remains only in the current browser tab and is used for the request. If the user selects “Save to my account,” the key is encrypted in Supabase Vault. Plaintext is never returned to the browser or shown on the account screen. The server decrypts it only to send an authorized request to the chosen provider. Key values are excluded from application logs and error responses. Users may replace or delete a saved key at any time.</p>
        <h3>Retention periods</h3><ul>
          <li>Account: until account deletion; deletion and backup propagation completed within 30 days where practicable.</li>
          <li>Saved personal AI key: until the user removes it or deletes the account.</li>
          <li>Classroom and lecture records, including retrieval embeddings: until the user deletes them or closes the account.</li>
          <li>Access and security logs: 3 months, or until an active security investigation ends.</li>
          <li>Support and dispute records: 3 years after resolution.</li>
          <li>Contract, cancellation, payment, and supply records: 5 years where Korean law requires it.</li>
        </ul><p>Records required by law are separated and used only for the required purpose.</p>
      </div></section>

      <section><h2>5. Service providers and international processing</h2><div>
        <p>Data is sent over encrypted connections. Providers process it to deliver the function shown below. If a user selects a personal AI provider, the transcript up to question time, the question, and the key needed to authorize that request are sent to that provider.</p>
        <div className={styles.tableWrap}><table><thead><tr><th>Provider</th><th>Purpose and data</th><th>Location and retention</th></tr></thead><tbody>
          <tr><td>Supabase, Inc.</td><td>Authentication, sessions, classroom and lecture record storage, and encrypted Vault storage for an optionally saved AI key</td><td className={styles.placeholder}>United States or selected project region; exact production region to be confirmed</td></tr>
          <tr><td>Deepgram, Inc.</td><td>Live speech recognition: microphone stream, language, and model settings</td><td>United States; real-time processing and provider contract terms</td></tr>
          <tr><td>Cloudflare, Inc.</td><td>Optional Korean STT lab: WAV audio windows of up to 10 seconds, Korean/model settings, and a short prior-transcript prompt</td><td>Cloudflare processing locations; request processing without an added storage service</td></tr>
          <tr><td>OpenAI, L.L.C.</td><td>Default or user-selected answers and web search: transcript, question, randomized safety identifier, and personal key when applicable</td><td>OpenAI processing regions and API retention settings</td></tr>
          <tr><td>Anthropic, PBC</td><td>User-selected Claude answers and search: transcript, question, and personal key</td><td>Locations and retention described by Anthropic and the user's API account</td></tr>
          <tr><td>Google LLC</td><td>Optional Google sign-in; optional Gemini answers and Google Search</td><td>Locations and retention described by Google and the user's API account</td></tr>
          <tr><td className={styles.placeholder}>Payment processor to be selected</td><td>Future payment and refund processing</td><td className={styles.placeholder}>To be confirmed before paid launch</td></tr>
        </tbody></table></div>
        <p>Default OpenAI Responses API calls use <code>store: false</code>. Retention and training choices for a personal provider follow the user's contract and account settings with that provider. Users can avoid an optional transfer by not selecting that function; core features affected by the transfer will then be unavailable.</p>
      </div></section>

      <section><h2>6. Cookies and automatic collection</h2><div><p>Supabase authentication cookies maintain sign-in and protect sessions. Blocking them may prevent account features from working. We currently use no targeted-advertising cookie or third-party advertising tracker. Any future analytics tool will be disclosed here with its data and opt-out method.</p></div></section>

      <section><h2>7. Your rights</h2><div><p>Subject to applicable law, users may request access, portability, correction, deletion, restriction, withdrawal of consent, and account closure.</p><ol><li>Use available account controls or contact the privacy address below.</li><li>We may verify identity before acting and will respond within the legally required period.</li><li>A request may be limited where law requires retention or where another person's rights would be harmed; we will explain the reason.</li></ol><p className={styles.placeholder}>Privacy request email: [add before public launch]</p></div></section>

      <section><h2>8. Deletion and security</h2><div><p>Data is deleted when its purpose or retention period ends. Electronic records are deleted using methods intended to prevent practical recovery; legally retained records are separated and access-restricted.</p><ul><li>HTTPS and secure WebSocket encryption in transit.</li><li>Short-lived speech-recognition tokens; production API secrets never exposed to the browser.</li><li>Vault encryption for saved personal AI keys, no plaintext redisplay, and no key logging.</li><li>Least-privilege operational access, environment-separated secrets, protected logs, and security updates.</li><li>Purpose and security controls imposed on service providers.</li></ul></div></section>

      <section><h2>9. Children</h2><div><p>The current service has no verified parental-consent flow and does not accept accounts from children under 14. Users under the minimum age required in their country must not use the service without a legally valid consent process.</p></div></section>

      <section><h2>10. Contact, complaints, and changes</h2><div>
        <p className={styles.placeholder}>Privacy officer or team: [name or team]; contact: [email and phone]</p>
        <p>Users in Korea may also contact the Personal Information Protection Commission, the Korea Internet &amp; Security Agency privacy center at 118, or the Personal Information Dispute Mediation Committee.</p>
        <p>We will normally post changes at least 7 days before they take effect. Material changes such as expanded collection or new disclosure will be announced at least 30 days in advance, and consent will be obtained where required.</p>
      </div></section>
    </LegalPage>
  );
}
