import type { Metadata } from "next";

import LegalPage from "../../legal-page";

export const metadata: Metadata = {
  title: "Classroom Use Policy | Lecue",
  description: "What happens when a student uses Lecue in your lecture, and how to block it for a specific course.",
};

export default function EnglishLecturePolicyPage() {
  return (
    <LegalPage
      locale="en"
      title="Classroom Use Policy"
      description="This page is for instructors. It states what Lecue does and does not do when a student uses it in your lecture, and how to have it blocked for a course."
    >
      <section><h2>1. What the tool does</h2><div><p>It transcribes lecture audio from the student&rsquo;s own laptop microphone in real time, and answers the student&rsquo;s questions using the lecture up to the moment they asked. The purpose is to help a student who lost the thread catch up and re-engage with the class.</p></div></section>

      <section><h2>2. What it does not do</h2><div><p>There is no way to share or publish a transcript. No share links, no file export, no posting.</p><p>Original lecture audio is never stored on our servers. Once recognition is done, the audio is gone.</p><p>It does not capture the student&rsquo;s screen or collect information about other students.</p></div></section>

      <section><h2>3. Exams and assessments</h2><div><p>Use during exams, quizzes, or any assessment is prohibited. Students must confirm this before recording can start.</p><p>Accounts found using the service during an assessment are restricted.</p></div></section>

      <section><h2>4. Copyright</h2><div><p>A lecture is the instructor&rsquo;s copyrighted work. Lecue assumes personal study use by the student alone; providing, selling, or publishing transcripts or course materials to third parties violates our terms and the instructor&rsquo;s copyright.</p><p>Course materials a student uploads are used only to improve that student&rsquo;s answers and are never served to other users.</p></div></section>

      <section><h2>5. If you do not want it used</h2><div><p>We block the service course by course. Email the institution, course name, instructor name, and term to <a href="mailto:dbgudwn43890@gmail.com">dbgudwn43890@gmail.com</a>. We apply the block and reply within two business days.</p><p>There is no fee and no additional process.</p></div></section>

      <section><h2>6. Syllabus language you can reuse</h2><div><p>Use or adapt either sentence when stating your AI policy.</p><p>&ldquo;Real-time transcription and question tools (such as Lecue) may be used for personal study in this course. They may not be used during exams or assessments, and transcripts may not be shared or distributed outside the course.&rdquo;</p><p>&ldquo;Recording and real-time transcription tools may not be used in this course.&rdquo;</p></div></section>

      <section><h2>7. Contact</h2><div><p>Policy questions, data handling questions, and block requests all go to <a href="mailto:dbgudwn43890@gmail.com">dbgudwn43890@gmail.com</a>.</p></div></section>
    </LegalPage>
  );
}
