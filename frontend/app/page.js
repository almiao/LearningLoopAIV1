import { Suspense } from "react";
import { HomePage as HomePageView } from "../components/home-page";

export default function HomePage() {
  return (
    <Suspense fallback={null}>
      <HomePageView />
    </Suspense>
  );
}
