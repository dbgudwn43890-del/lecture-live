import { notFound } from "next/navigation";
import { getAdminIdentity } from "../lib/admin-access";
import AdminDashboard from "./dashboard";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  if (!await getAdminIdentity()) notFound();
  return <AdminDashboard />;
}
