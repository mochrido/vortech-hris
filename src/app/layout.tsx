import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: "Vortech Hadir | Prototipe Manajemen Kehadiran",
  description: "Pratinjau antarmuka manajemen kehadiran untuk tim Indonesia.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  );
}
