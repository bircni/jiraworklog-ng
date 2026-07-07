import type { Metadata } from "next";
import "./globals.css";
import { Sidebar } from "@/components/sidebar";
import { ElectronBridge } from "@/components/electron-bridge";
import { getSettings } from "@/db/queries";

export const metadata: Metadata = {
  title: "JiraWorklog Tracker",
  description: "Lokale Zeiterfassung mit Jira-Anbindung",
};

export const dynamic = "force-dynamic";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const { themeMode } = getSettings();
  return (
    <html lang="de" className="h-full antialiased" data-theme={themeMode}>
      <body className="min-h-full" suppressHydrationWarning>
        <ElectronBridge />
        <div className="grid min-h-screen grid-cols-[232px_1fr]">
          <Sidebar />
          <div className="overflow-x-hidden">{children}</div>
        </div>
      </body>
    </html>
  );
}
