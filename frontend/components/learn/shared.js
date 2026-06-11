"use client";

export function MiniIcon({ name }) {
  const common = {
    viewBox: "0 0 16 16",
    "aria-hidden": "true",
    focusable: "false",
  };
  if (name === "trend") {
    return (
      <svg {...common}>
        <path d="M2.5 11.5 6 8l2.2 2.2 4.8-5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M10 4.8h3.2V8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (name === "bookmark") {
    return (
      <svg {...common}>
        <path d="M4.5 2.5h7v11L8 11.2l-3.5 2.3z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      </svg>
    );
  }
  if (name === "send") {
    return (
      <svg {...common}>
        <path d="M2.5 8.4 13.2 3 10 13l-2.4-3.5z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
        <path d="M7.6 9.5 13.2 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    );
  }
  if (name === "confetti") {
    return (
      <svg {...common}>
        <path d="m3 12 2.2-7.2L11.6 11z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
        <path d="M8.8 3.2 10 2m1.2 4.3 2-.5M5.4 2.5 5.1 1" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        <path d="M5.1 8.5 7.4 6" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    );
  }
  if (name === "arrow-right") {
    return (
      <svg {...common}>
        <path d="M3 8h9.5M8.8 4.3 12.5 8l-3.7 3.7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (name === "target") {
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <circle cx="8" cy="8" r="2.4" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <path d="M8 1.5v2M14.5 8h-2M8 14.5v-2M1.5 8h2" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    );
  }
  if (name === "calendar") {
    return (
      <svg {...common}>
        <rect x="2.5" y="3.5" width="11" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <path d="M5.4 2.2v2.4M10.6 2.2v2.4M2.8 6.4h10.4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        <path d="M5 9h2v2H5z" fill="currentColor" />
      </svg>
    );
  }
  if (name === "share") {
    return (
      <svg {...common}>
        <circle cx="4" cy="8" r="1.7" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <circle cx="12" cy="4" r="1.7" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <circle cx="12" cy="12" r="1.7" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <path d="m5.5 7.2 5-2.4M5.5 8.8l5 2.4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    );
  }
  if (name === "book") {
    return (
      <svg {...common}>
        <path d="M3 3.2h4.1c.8 0 1.4.6 1.4 1.4v8.2c0-.8-.6-1.4-1.4-1.4H3zM13 3.2H8.9c-.8 0-1.4.6-1.4 1.4v8.2c0-.8.6-1.4 1.4-1.4H13z" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
      </svg>
    );
  }
  if (name === "list") {
    return (
      <svg {...common}>
        <path d="M5.8 4h7M5.8 8h7M5.8 12h7" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        <path d="M3.1 4h.1M3.1 8h.1M3.1 12h.1" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  }
  if (name === "focus") {
    return (
      <svg {...common}>
        <path d="M5.5 2.5H3.8c-.7 0-1.3.6-1.3 1.3v1.7M10.5 2.5h1.7c.7 0 1.3.6 1.3 1.3v1.7M13.5 10.5v1.7c0 .7-.6 1.3-1.3 1.3h-1.7M5.5 13.5H3.8c-.7 0-1.3-.6-1.3-1.3v-1.7" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
        <circle cx="8" cy="8" r="2" fill="none" stroke="currentColor" strokeWidth="1.35" />
      </svg>
    );
  }
  if (name === "dots") {
    return (
      <svg {...common}>
        <path d="M4 8h.1M8 8h.1M12 8h.1" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      </svg>
    );
  }
  if (name === "bulb") {
    return (
      <svg {...common}>
        <path d="M5.7 11.1h4.6M6.5 13.1h3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        <path d="M10.8 7.2c0 1.1-.7 1.8-1.3 2.5H6.6c-.7-.7-1.4-1.4-1.4-2.5a2.8 2.8 0 1 1 5.6 0Z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      </svg>
    );
  }
  if (name === "help") {
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <path d="M6.5 6.5A1.7 1.7 0 0 1 8.2 5c1 0 1.8.6 1.8 1.5 0 .7-.4 1.1-1.1 1.6-.5.4-.8.8-.8 1.5M8 11.6h.1" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    );
  }
  if (name === "hint") {
    return (
      <svg {...common}>
        <path d="M5.4 11.2h5.2M6.3 13.3h3.4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        <path d="M10.8 7.2c0 1-.5 1.5-1.2 2.2-.4.4-.7.8-.7 1.3H7.1c0-.9.4-1.5 1-2.1.6-.6.9-.9.9-1.4 0-.7-.5-1.1-1.2-1.1-.8 0-1.3.4-1.6 1.1" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        <path d="M3.1 8a4.9 4.9 0 1 1 9.8 0" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M3 8h10M8 3v10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function getTurnTimeLabel(timestamp = "") {
  const numericTimestamp = Number(timestamp || 0);
  if (!Number.isFinite(numericTimestamp) || numericTimestamp <= 0) {
    return "刚刚";
  }
  const diffMinutes = Math.max(0, Math.floor((Date.now() - numericTimestamp) / 60000));
  if (diffMinutes < 1) {
    return "刚刚";
  }
  if (diffMinutes < 60) {
    return `${diffMinutes} 分钟前`;
  }
  return `${Math.floor(diffMinutes / 60)} 小时前`;
}
