import { Suspense } from "react";
import { CampaignDashboard } from "../../components/campaign-dashboard";

export default function CampaignPage() {
  return (
    <Suspense fallback={null}>
      <CampaignDashboard />
    </Suspense>
  );
}
