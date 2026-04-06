const stateRank = {
  "不可判": 0,
  weak: 1,
  partial: 2,
  solid: 3
};

export function buildNextSteps(concepts, conceptStates) {
  return concepts
    .map((concept) => ({
      conceptId: concept.id,
      title: concept.title,
      state: conceptStates[concept.id]?.judge?.state ?? "weak"
    }))
    .sort((left, right) => stateRank[left.state] - stateRank[right.state])
    .map((item, index) => ({
      order: index + 1,
      title: item.title,
      recommendation:
        item.state === "solid"
          ? `把 ${item.title} 用真实项目例子复述一遍，再尝试迁移到相邻主题。`
          : item.state === "partial"
            ? `围绕 ${item.title} 追加一轮边界条件练习，并用材料中的证据补足解释。`
            : item.state === "不可判"
              ? `重新回到 ${item.title} 的原始材料，先澄清题意和证据范围，再恢复追问。`
            : `先补齐 ${item.title} 的定义、关键机制和失败场景，再进入下一轮追问。`
    }));
}
