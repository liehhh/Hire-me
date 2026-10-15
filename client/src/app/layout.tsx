import type { Metadata, Viewport } from "next";
import "./globals.css";
import { SITE_URL } from "./siteUrl";
import { DebugOverlay } from "../components/DebugOverlay";


const title = "InterviewerAI - AI Mock Interviews Tailored to the Job";
const description =
  "Paste a job description and get a mock interview planned for that exact role, held by a lip-synced 3D avatar, followed by a report based only on what you actually said.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: title, template: "%s | InterviewerAI" },
  description,
  applicationName: "InterviewerAI",
  keywords: ["mock interview", "AI interview practice", "interview preparation", "job interview", "interview feedback"],
  alternates: { canonical: "/" },
  robots: { index: true, follow: true },
  openGraph: {
    type: "website",
    siteName: "InterviewerAI",
    url: "/",
    title,
    description,
  },
  twitter: { card: "summary", title, description },
};

export const viewport: Viewport = {
  themeColor: "#f5f5f7",
};

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "WebApplication",
  name: "InterviewerAI",
  description,
  url: SITE_URL,
  applicationCategory: "EducationalApplication",
  operatingSystem: "Any (modern browser)",
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
        {children}
        <DebugOverlay />
      </body>
    </html>
  );
}
