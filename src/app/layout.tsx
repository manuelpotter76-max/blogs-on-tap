import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Blogs on Tap",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
