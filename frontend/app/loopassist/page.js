import { redirect } from "next/navigation";

export default async function LoopAssistPage({ searchParams }) {
  const resolvedSearchParams = await searchParams;
  const query = new URLSearchParams();
  for (const [key, rawValue] of Object.entries(resolvedSearchParams || {})) {
    if (Array.isArray(rawValue)) {
      for (const value of rawValue) {
        if (value) {
          query.append(key, value);
        }
      }
      continue;
    }
    if (rawValue) {
      query.set(key, String(rawValue));
    }
  }
  query.set("mode", "interview");
  redirect(`/learn?${query.toString()}`);
}
