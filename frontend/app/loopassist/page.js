import { Suspense } from "react";
import { LoopAssistWorkspace } from "../../components/loopassist-workspace";

export default function LoopAssistPage() {
  return (
    <Suspense fallback={null}>
      <LoopAssistWorkspace />
    </Suspense>
  );
}
