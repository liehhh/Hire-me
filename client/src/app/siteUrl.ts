// Set NEXT_PUBLIC_SITE_URL (the Amplify/custom-domain URL, no trailing slash)
// so canonical, Open Graph and sitemap URLs are absolute in production.
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:5173";
