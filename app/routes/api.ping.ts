import prisma from "../db.server";

export async function loader() {
  // minimal DB touch to keep Supabase awake
  await prisma.review.findFirst().catch(() => null);
  return new Response("ok", { status: 200 });
}
