import { Suspense } from "react";
import { InterviewAssistWorkspace } from "../../components/interview-assist-workspace";

export default function InterviewAssistPage() {
  return (
    <Suspense fallback={null}>
      <InterviewAssistWorkspace />
    </Suspense>
  );
}
