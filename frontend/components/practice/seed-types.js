export const practiceSeedTypes = {
  jdTopic: "jd-topic",
  resumeClaim: "resume-claim",
  reportSeed: "report-seed",
  reviewItem: "review-item",
};

export const practiceSeedSourceLabels = {
  "jd-topic": "JD 要的",
  "resume-claim": "简历说的",
  "report-seed": "面经常考",
  "review-item": "复习项",
};

export function getPracticeSeedSourceLabel(source = "jd-topic") {
  return practiceSeedSourceLabels[source] || practiceSeedSourceLabels["jd-topic"];
}
