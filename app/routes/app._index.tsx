// app/routes/app._index.tsx
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";

import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ReviewStatus } from "@prisma/client";

/* -------------------- SERVER: LOADER -------------------- */

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session?.shop;
  if (!shop) {
    throw new Response("Unauthorized", { status: 401 });
  }

  const url = new URL(request.url);
  const statusParam = (url.searchParams.get("status") ?? "pending") as
    | "pending"
    | "approved"
    | "trashed";

  const prismaStatus = ReviewStatus[statusParam] ?? ReviewStatus.pending;

  const reviewsRaw = await prisma.review.findMany({
    where: {
      shopDomain: shop,
      status: prismaStatus,
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  // Convert BigInt to string so React Router can JSON-serialize
  const reviews = reviewsRaw.map((r) => ({
    ...r,
    productId: r.productId.toString(),
  }));

  return { reviews, status: statusParam };
};

/* -------------------- SERVER: ACTION -------------------- */

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session?.shop;
  if (!shop) {
    return new Response("Unauthorized", { status: 401 });
  }

  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  const id = String(form.get("id") || "");

  if (!id) {
    return new Response("Missing review id", { status: 400 });
  }

  // Ensure the review belongs to this shop
  const review = await prisma.review.findUnique({
    where: { id },
  });

  if (!review || review.shopDomain !== shop) {
    return new Response("Not found", { status: 404 });
  }

  if (intent === "approve") {
    await prisma.review.update({
      where: { id },
      data: { status: ReviewStatus.approved },
    });
  } else if (intent === "trash") {
    await prisma.review.update({
      where: { id },
      data: { status: ReviewStatus.trashed },
    });
  } else if (intent === "restore") {
    // Back to pending; you can approve again later
    await prisma.review.update({
      where: { id },
      data: { status: ReviewStatus.pending },
    });
  } else if (intent === "delete") {
    await prisma.review.delete({
      where: { id },
    });
  } else {
    return new Response("Unknown intent", { status: 400 });
  }

  // Let React Router revalidate loader data
  return new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json" },
  });
};

/* -------------------- CLIENT COMPONENT -------------------- */

function formatDisplayName(review: {
  authorName: string;
  authorLastName: string | null;
}) {
  if (review.authorLastName && review.authorLastName.length > 0) {
    return `${review.authorName} ${review.authorLastName[0]}.`;
  }
  return review.authorName;
}

export default function ReviewsIndex() {
  const { reviews, status } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();

  const statusLabel =
    status === "pending"
      ? "Pending"
      : status === "approved"
      ? "Approved"
      : "Corbeille";

  return (
    <s-page heading="Reviews">
      <s-section heading={`Reviews – ${statusLabel}`}>
        <s-stack direction="block" gap="base">
          {/* Status filters */}
          <s-stack direction="inline" gap="base">
            <s-link href="/app?status=pending">
              <s-badge tone={status === "pending" ? "success" : "neutral"}>
                Pending
              </s-badge>
            </s-link>
            <s-link href="/app?status=approved">
              <s-badge tone={status === "approved" ? "success" : "neutral"}>
                Approved
              </s-badge>
            </s-link>
            <s-link href="/app?status=trashed">
              <s-badge tone={status === "trashed" ? "critical" : "neutral"}>
                Corbeille
              </s-badge>
            </s-link>
          </s-stack>

          {reviews.length === 0 ? (
            <s-paragraph>No reviews in this state yet.</s-paragraph>
          ) : (
            reviews.map((review) => (
              <s-box
                key={review.id}
                padding="base"
                borderWidth="base"
                borderRadius="base"
                background="subdued"
              >
                <s-stack direction="block" gap="base">
                  <s-stack direction="inline" gap="base">
                    <s-text>{formatDisplayName(review)}</s-text>
                    <s-badge tone="info">{review.rating} ★</s-badge>
                    <s-text>
                      Product ID: {review.productId}
                    </s-text>
                    {review.productHandle && (
                      <s-text>Handle: {review.productHandle}</s-text>
                    )}
                  </s-stack>

                  <s-text>{review.body}</s-text>

                  {review.mediaUrl && (
                    <s-text>Media URL: {review.mediaUrl}</s-text>
                  )}

                  <s-stack direction="inline" gap="base">
                    {status === "pending" && (
                      <>
                        <fetcher.Form method="post">
                          <input type="hidden" name="id" value={review.id} />
                          <input
                            type="hidden"
                            name="intent"
                            value="approve"
                          />
                          <s-button variant="primary">
                            Approve
                          </s-button>
                        </fetcher.Form>

                        <fetcher.Form method="post">
                          <input type="hidden" name="id" value={review.id} />
                          <input type="hidden" name="intent" value="trash" />
                          <s-button variant="tertiary">
                            Move to corbeille
                          </s-button>
                        </fetcher.Form>
                      </>
                    )}

                    {status === "approved" && (
                      <fetcher.Form method="post">
                        <input type="hidden" name="id" value={review.id} />
                        <input type="hidden" name="intent" value="trash" />
                        <s-button variant="tertiary">
                          Move to corbeille
                        </s-button>
                      </fetcher.Form>
                    )}

                    {status === "trashed" && (
                      <>
                        <fetcher.Form method="post">
                          <input type="hidden" name="id" value={review.id} />
                          <input
                            type="hidden"
                            name="intent"
                            value="restore"
                          />
                          <s-button variant="primary">
                            Restore
                          </s-button>
                        </fetcher.Form>

                        <fetcher.Form method="post">
                          <input type="hidden" name="id" value={review.id} />
                          <input
                            type="hidden"
                            name="intent"
                            value="delete"
                          />
                          <s-button tone="critical">
                            Delete permanently
                          </s-button>
                        </fetcher.Form>
                      </>
                    )}
                  </s-stack>
                </s-stack>
              </s-box>
            ))
          )}
        </s-stack>
      </s-section>
    </s-page>
  );
}

/* Shopify headers passthrough */
export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
