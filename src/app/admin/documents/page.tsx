import { DocumentsAdmin } from "@/components/documents-admin";
import { env } from "@/lib/env";

export const metadata = { title: "Knowledge base" };

export default function Page() {
  return <DocumentsAdmin maxUploadMb={Math.round(env.maxUploadBytes / 1024 / 1024)} />;
}
