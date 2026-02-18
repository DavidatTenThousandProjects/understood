/**
 * Attempt to fetch media (image or video) from a social media URL
 * by parsing Open Graph meta tags from the page HTML.
 *
 * Best-effort — social platforms may block this. Callers should
 * handle the null return gracefully.
 */

const SOCIAL_PATTERNS = [
  /instagram\.com/i,
  /tiktok\.com/i,
  /twitter\.com/i,
  /x\.com/i,
  /facebook\.com/i,
  /fb\.watch/i,
  /linkedin\.com/i,
  /youtube\.com/i,
  /youtu\.be/i,
  /threads\.net/i,
];

interface FetchedMedia {
  type: "image" | "video";
  buffer: Buffer;
  filename: string;
  pageTitle?: string;
  pageDescription?: string;
}

/**
 * Extract the first URL from a text message.
 */
export function extractUrl(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s>]+/i);
  return match ? match[0] : null;
}

/**
 * Check if a URL looks like a social media / ad platform link.
 */
export function isSocialUrl(url: string): boolean {
  return SOCIAL_PATTERNS.some((p) => p.test(url));
}

/**
 * Try to fetch media from a URL by:
 * 1. Fetching the page HTML
 * 2. Parsing og:image / og:video meta tags
 * 3. Downloading the media
 *
 * Returns null if the page is inaccessible or has no usable media.
 */
export async function fetchMediaFromUrl(url: string): Promise<FetchedMedia | null> {
  try {
    // Fetch the page with a browser-like user agent
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) return null;

    const html = await response.text();

    // Parse Open Graph meta tags
    const ogVideo = extractMetaContent(html, "og:video") || extractMetaContent(html, "og:video:url");
    const ogImage = extractMetaContent(html, "og:image");
    const ogTitle = extractMetaContent(html, "og:title");
    const ogDescription = extractMetaContent(html, "og:description");

    // Try video first (more content to analyze), then image
    if (ogVideo) {
      const buffer = await downloadMedia(ogVideo);
      if (buffer && buffer.length > 1000) {
        return {
          type: "video",
          buffer,
          filename: "competitor-video.mp4",
          pageTitle: ogTitle || undefined,
          pageDescription: ogDescription || undefined,
        };
      }
    }

    if (ogImage) {
      const buffer = await downloadMedia(ogImage);
      if (buffer && buffer.length > 1000) {
        // Determine extension from URL or default to jpg
        const ext = ogImage.match(/\.(png|jpg|jpeg|webp|gif)/i)?.[1] || "jpg";
        return {
          type: "image",
          buffer,
          filename: `competitor-image.${ext}`,
          pageTitle: ogTitle || undefined,
          pageDescription: ogDescription || undefined,
        };
      }
    }

    return null;
  } catch (err) {
    console.error("Failed to fetch media from URL:", err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Extract content from an Open Graph meta tag.
 * Handles both property="og:X" and name="og:X" patterns.
 */
function extractMetaContent(html: string, property: string): string | null {
  // Match: <meta property="og:image" content="https://..." />
  // Also: <meta name="og:image" content="https://..." />
  // Handle both single and double quotes, and various attribute orders
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${escapeRegex(property)}["'][^>]+content=["']([^"']+)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escapeRegex(property)}["']`, "i"),
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      // Decode HTML entities
      return match[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    }
  }

  return null;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Download media from a URL, returning a Buffer.
 */
async function downloadMedia(url: string): Promise<Buffer | null> {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) return null;

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch {
    return null;
  }
}
