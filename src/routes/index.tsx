import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Mobile Dealer ERP" },
      { name: "description", content: "Multi-branch mobile retail ERP for showrooms and dealer house." },
      { property: "og:title", content: "Mobile Dealer ERP" },
      { property: "og:description", content: "Multi-branch mobile retail ERP for showrooms and dealer house." },
    ],
  }),
  beforeLoad: () => {
    throw redirect({ to: "/dashboard" });
  },
});
