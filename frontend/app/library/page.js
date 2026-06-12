import { Suspense } from "react";
import { LibraryWorkspace } from "../../components/library/library-workspace";

export default function LibraryPage() {
  return (
    <Suspense fallback={null}>
      <LibraryWorkspace />
    </Suspense>
  );
}
