// app/routes/api.proxy.reviews.ts
import prisma from "../db.server";
import { ReviewStatus } from "@prisma/client";
import { createClient } from "@supabase/supabase-js";

// ---------- Supabase ----------
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const SUPABASE_BUCKET = process.env.SUPABASE_REVIEW_MEDIA_BUCKET || "review-media";

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    : null;

// ---------- CORS helpers ----------
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Expose-Headers": "Content-Type",
};

/** JSON that safely stringifies BigInt and always includes CORS headers */
function safeJson<T>(data: T, init?: ResponseInit) {
  const headers = new Headers(init?.headers);

  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");

  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }

  return new Response(
    JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    { ...init, headers }
  );
}

/** CORS preflight handler */
function handleOptions(request: Request) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  return null;
}

// ---------- Body / shop helpers ----------
type ParsedBody =
  | { kind: "json"; data: any }
  | { kind: "form"; data: Record<string, any>; file?: File | null };

/** Read JSON, urlencoded, or multipart bodies (supports file upload) */
async function readBody(request: Request): Promise<ParsedBody> {
  const ct = request.headers.get("content-type") || "";

  // multipart/form-data (FormData + file)
  if (ct.includes("multipart/form-data")) {
    const form = await request.formData();
    const obj: Record<string, any> = {};
    let file: File | null = null;

    form.forEach((v, k) => {
      // If multiple fields share a key, last write wins (fine for our use)
      obj[k] = v;
    });

    const maybeFile = form.get("media");
    if (maybeFile && maybeFile instanceof File && maybeFile.size > 0) {
      file = maybeFile;
    }

    return { kind: "form", data: obj, file };
  }

  // application/x-www-form-urlencoded
  if (ct.includes("application/x-www-form-urlencoded")) {
    const form = await request.formData();
    const obj: Record<string, any> = {};
    form.forEach((v, k) => {
      obj[k] = v;
    });
    return { kind: "form", data: obj };
  }

  // JSON
  if (ct.includes("application/json")) {
    const data = await request.json().catch(() => ({}));
    return { kind: "json", data };
  }

  // fallback
  try {
    const data = await request.json();
    return { kind: "json", data };
  } catch {
    return { kind: "json", data: {} };
  }
}

/** Try to resolve the shop domain from header, query, or hostname */
function getShopFromRequest(request: Request): string | undefined {
  const hdr = request.headers.get("x-shopify-shop-domain");
  if (hdr) return hdr;

  const url = new URL(request.url);
  const q = url.searchParams.get("shop");
  if (q) return q;

  const host =
    request.headers.get("x-forwarded-host") ||
    request.headers.get("host") ||
    url.host;

  if (host && /\.myshopify\.com$/i.test(host)) return host;

  return undefined;
}

function toStr(v: any) {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  // FormData fields can be File; avoid stringifying file objects
  if (typeof File !== "undefined" && v instanceof File) return "";
  return String(v);
}

// ---------- GET: list reviews ----------
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
        return safeJson({ ok: false, error: "Invalid product_id" }, { status: 400 });
      }
    }

    const statusParam = (url.searchParams.get("status") ?? "approved") as
      | keyof typeof ReviewStatus
      | string;

    const normalizedStatusKey =
      statusParam in ReviewStatus
        ? (statusParam as keyof typeof ReviewStatus)
        : "approved";

    const where: any = {
      shopDomain: shop,
      status: ReviewStatus[normalizedStatusKey],
    };

    if (pid !== null) where.productId = pid;

    const reviews = await prisma.review.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 200,
    });

    return safeJson({ ok: true, reviews }, { status: 200 });
  } catch (err) {
    console.error("GET /reviews error:", err);
    return safeJson({ ok: false, error: "Failed to load reviews" }, { status: 500 });
  }
}

// ---------- POST: create review ----------
export async function action({ request }: { request: Request }) {
  const maybeCors = handleOptions(request);
  if (maybeCors) return maybeCors;

  if (request.method !== "POST") {
    return safeJson({ ok: false, error: "Method not allowed" }, { status: 405 });
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

    const parsed = await readBody(request);
    const body = parsed.kind === "json" ? parsed.data : parsed.data;
    const uploadedFile = parsed.kind === "form" ? parsed.file : null;

    // Normalize inputs (support multiple naming styles)
    const productIdRaw = toStr(body.productId ?? body.product_id);
    const ratingRaw = toStr(body.rating);
    const title = toStr(body.title) ? toStr(body.title) : null;

    const firstName = toStr(body.firstName ?? body.name ?? body.author_name);
    const lastName = toStr(body.lastName ?? body.family_name ?? body.last_name) || null;
    const authorEmail = toStr(body.email ?? body.author_email) || null;

    const text =
      body.body !== undefined
        ? toStr(body.body)
        : body.review !== undefined
        ? toStr(body.review)
        : "";

    // Optional old-style URL (still supported if no file)
    const mediaUrlFromBody = toStr(body.mediaUrl ?? body.media_url) || null;

    const productHandle = toStr(body.product_handle) ? toStr(body.product_handle) : null;

    if (!productIdRaw) {
      return safeJson({ ok: false, error: "product_id is required" }, { status: 400 });
    }

    let pid: bigint;
    try {
      pid = BigInt(productIdRaw);
    } catch {
      return safeJson({ ok: false, error: "Invalid product_id" }, { status: 400 });
    }

    const rating = Number(ratingRaw);
    if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
      return safeJson({ ok: false, error: "rating must be between 1 and 5" }, { status: 400 });
    }

    if (!firstName || !text) {
      return safeJson({ ok: false, error: "name and review body are required" }, { status: 400 });
    }

    // ---- Upload file (optional) ----
    let finalMediaUrl: string | null = mediaUrlFromBody;

    if (uploadedFile) {
      if (!supabase) {
        return safeJson(
          {
            ok: false,
            error:
              "Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
          },
          { status: 400 }
        );
      }

      const maxBytes = 20 * 1024 * 1024; // 20MB
      if (uploadedFile.size > maxBytes) {
        return safeJson(
          { ok: false, error: "File is too large. Please keep it under 20MB." },
          { status: 400 }
        );
      }

      const ext = (uploadedFile.name.split(".").pop() || "bin").toLowerCase();
      const safeExt = ext.replace(/[^a-z0-9]/g, "") || "bin";

      // Example: reviews/shop.myshopify.com/1234567890/<random>.jpg
      const path = `reviews/${shop}/${productIdRaw}/${crypto.randomUUID()}.${safeExt}`;

      const buf = Buffer.from(await uploadedFile.arrayBuffer());

      const { error: upErr } = await supabase.storage.from(SUPABASE_BUCKET).upload(path, buf, {
        contentType: uploadedFile.type || "application/octet-stream",
        upsert: false,
      });

      if (upErr) {
        return safeJson({ ok: false, error: upErr.message }, { status: 400 });
      }

      const { data: pub } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(path);
      finalMediaUrl = pub?.publicUrl || null;
    }

    const created = await prisma.review.create({
      data: {
        shopDomain: shop,
        productId: pid,
        productHandle,
        rating,
        title,
        body: text,
        authorName: firstName,
        authorLastName: lastName ? String(lastName) : null,
        authorEmail,
        mediaUrl: finalMediaUrl,
        status: ReviewStatus.pending,
      },
    });

    return safeJson({ ok: true, review: created }, { status: 200 });
  } catch (err) {
    console.error("POST /reviews error:", err);
    return safeJson({ ok: false, error: "Failed to submit review" }, { status: 500 });
  }
}