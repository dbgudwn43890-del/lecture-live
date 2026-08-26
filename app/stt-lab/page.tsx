import { notFound } from "next/navigation";

import { getAuthenticatedUserId } from "../lib/auth";
import { canUseSttLab } from "../lib/lab-access";
import KoreanSttLab from "./lab-client";

export default async function SttLabPage() {
  if (!canUseSttLab(await getAuthenticatedUserId())) notFound();
  return <KoreanSttLab />;
}
