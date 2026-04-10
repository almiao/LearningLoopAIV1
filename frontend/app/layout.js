import "./globals.css";

export const metadata = {
  title: "Learning Loop AI",
  description: "Split-architecture frontend for Learning Loop AI"
};

export default function RootLayout({ children }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
