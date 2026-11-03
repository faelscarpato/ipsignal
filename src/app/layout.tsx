import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sinal — Estúdio de Playlists IPTV",
  description:
    "Importe playlists M3U, teste cada canal com evidência real de reprodução no seu navegador, edite e exporte. Seus dados ficam somente neste aparelho.",
};

export const viewport: Viewport = {
  themeColor: "#07090d",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR">
      <body className="bg-ink text-snow antialiased">{children}</body>
    </html>
  );
}
