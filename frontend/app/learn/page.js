import { Suspense } from "react";

import { LearnWorkspace } from "../../components/learn-workspace";
import { LoopAssistWorkspace } from "../../components/loopassist-workspace";

export default async function LearnPage({ searchParams }) {
  const resolvedSearchParams = await searchParams;
  const mode = String(resolvedSearchParams?.mode || "");
  const interviewMode = mode === "interview" || mode === "loopassist";
  return (
    <Suspense fallback={null}>
      {interviewMode ? <LoopAssistWorkspace /> : <LearnWorkspace />}
    </Suspense>
  );
}
