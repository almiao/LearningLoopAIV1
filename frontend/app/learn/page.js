import { Suspense } from "react";
import { LearnWorkspace } from "../../components/learn-workspace";

export default function LearnPage() {
  return (
    <Suspense fallback={null}>
      <LearnWorkspace />
    </Suspense>
  );
}
