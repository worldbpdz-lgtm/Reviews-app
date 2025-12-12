// app/routes/api.proxy.reviews.ts
import prisma from "../db.server";
import { ReviewStatus } from "@prisma/client";

/** Read JSON or form-encoded bodies */
async function readBody(request: Request) {
  const ct = request.headers.get("content-type") || "";
  if (ct.includes("application/json")) return request.json();
  if (ct.includes("application/x-www-form-urlencoded")) {
    const form = await request.formData();
    const obj: Record<string, any> = {};
    form.forEach((v, k) => {
      obj[k] = v;
    });
    return obj;
  }
  try {
    return await request.json();
  } catch {
    return {};
  }
}

/** JSON that safely stringifies BigInt */
function safeJson<T>(data: T, init?: ResponseInit) {
  return new Response(
    JSON.stringify(data, (_k, v) =>
      typeof v === "bigint" ? v.toString() : v
    ),
    { headers: { "Content-Type": "application/json" }, ...init }
  );
}

/** CORS preflight handler */
function handleOptions(request: Request) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }
  return null;
}

/** Try to resolve the shop domain from header, query, or hostname */
function getShopFromRequest(request: Request): string | undefined {
  const hdr = request.headers.get("x-shopify-shop-domain");
  if (hdr) return hdr;

  const url = new URL(request.url);
  const q = url.searchParams.get("shop");
  if (q) return q;

  // Fallback: parse host like reviews-app-dev-3.myshopify.com
  const host =
    request.headers.get("x-forwarded-host") ||
    request.headers.get("host") ||
    url.host;

  if (host && /\.myshopify\.com$/i.test(host)) return host;

  return undefined;
}

/**
 * GET /apps/<proxy>/reviews
 *
 * - /apps/reviews?product_id=123            → reviews for that product
 * - /apps/reviews                           → all reviews for the shop
 * - /apps/reviews?status=pending            → filter by status
 */
export async function loader({ request }: { request: Request }) {
  const maybeCors = handleOptions(request);
  if (maybeCors) return maybeCors;

  try {
    const shop = getShopFromRequest(request);
    if (!shop) {
      return safeJson(
        {
          ok: false,
          error:
            "Missing shop. Ensure you call via the App Proxy (/apps/<subpath>) or add ?shop=<domain>.",
        },
        { status: 401 }
      );
    }

    const url = new URL(request.url);

    const productIdRaw =
      url.searchParams.get("product_id") ??
      url.searchParams.get("productId") ??
      null;

    let pid: bigint | null = null;
    if (productIdRaw) {
      try {
        pid = BigInt(String(productIdRaw));
      } catch {
        return safeJson(
          { ok: false, error: "Invalid product_id" },
          { status: 400 }
        );
      }
    }

    const statusParam = (url.searchParams.get("status") ?? "approved") as
      | keyof typeof ReviewStatus
      | string;

    const normalizedStatusKey =
      statusParam in ReviewStatus ? (statusParam as keyof typeof ReviewStatus) : "approved";

    const where: any = {
      shopDomain: shop,
      status: ReviewStatus[normalizedStatusKey],
    };

    if (pid !== null) {
      where.productId = pid;
    }

    const reviews = await prisma.review.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 200,
    });

    return safeJson({ ok: true, reviews }, { status: 200 });
  } catch (err) {
    console.error("GET /reviews error:", err);
    return safeJson(
      { ok: false, error: "Failed to load reviews" },
      { status: 500 }
    );
  }
}

/**
 * POST /apps/<proxy>/reviews
 */
export async function action({ request }: { request: Request }) {
  const maybeCors = handleOptions(request);
  if (maybeCors) return maybeCors;

  if (request.method !== "POST") {
    return safeJson(
      { ok: false, error: "Method not allowed" },
      { status: 405 }
    );
  }

  try {
    const shop = getShopFromRequest(request);
    if (!shop) {
      return safeJson(
        {
          ok: false,
          error:
            "Missing shop. Ensure you post to the App Proxy (/apps/<subpath>) or add ?shop=<domain>.",
        },
        { status: 401 }
      );
    }

    const body = await readBody(request);

    // Normalize inputs (support multiple naming styles)
    const productIdRaw = body.productId ?? body.product_id;
    const ratingRaw = body.rating;
    const title = body.title ? String(body.title) : null;

    // First name
    const firstName =
      body.firstName ??
      body.name ??
      body.author_name ??
      "";

    // Family name (optional)
    const lastName =
      body.lastName ??
      body.family_name ??
      body.last_name ??
      null;

    // Optional email
    const authorEmail =
      body.email ??
      body.author_email ??
      null;

    // Review text
    const text =
      body.body !== undefined
        ? String(body.body)
        : body.review !== undefined
        ? String(body.review)
        : "";

    // Optional media URL
    const mediaUrl =
      body.mediaUrl ??
      body.media_url ??
      null;

    const productHandle = body.product_handle
      ? String(body.product_handle)
      : null;

    if (!productIdRaw) {
      return safeJson(
        { ok: false, error: "product_id is required" },
        { status: 400 }
      );
    }

    let pid: bigint;
    try {
      pid = BigInt(String(productIdRaw));
    } catch {
      return safeJson(
        { ok: false, error: "Invalid product_id" },
        { status: 400 }
      );
    }

    const rating = Number(ratingRaw);
    if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
      return safeJson(
        { ok: false, error: "rating must be between 1 and 5" },
        { status: 400 }
      );
    }

    if (!firstName || !text) {
      return safeJson(
        { ok: false, error: "name and review body are required" },
        { status: 400 }
      );
    }

    const created = await prisma.review.create({
      data: {
        shopDomain: shop,
        productId: pid,
        productHandle,
        rating,
        title,
        body: text,
        authorName: String(firstName),
        authorLastName: lastName ? String(lastName) : null,
        authorEmail,
        mediaUrl,
        status: ReviewStatus.pending,
      },
    });

    return safeJson({ ok: true, review: created }, { status: 200 });
  } catch (err) {
    console.error("POST /reviews error:", err);
    return safeJson(
      { ok: false, error: "Failed to submit review" },
      { status: 500 }
    );
  }
}
