import { redirect } from "next/navigation";

export default async function DocumentPage({ params, searchParams }) {
  const resolvedParams = await params;
  const resolvedSearchParams = await searchParams;
  const docPath = resolvedSearchParams?.doc || "";
  const query = new URLSearchParams();
  if (docPath) {
    query.set("doc", docPath);
  } else if (resolvedParams?.slug) {
    query.set("doc", resolvedParams.slug);
  }

  redirect(`/learn${query.toString() ? `?${query.toString()}` : ""}`);
}
