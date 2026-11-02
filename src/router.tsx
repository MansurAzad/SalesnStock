import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export const getRouter = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      // Queries pause while offline (navigator.onLine) so saved data is shown instead of being wiped.
      // Cached data is kept (and saved on the device) so pages still open without internet.
      queries: { gcTime: 1000 * 60 * 60 * 24 * 7, retry: 1 },
      mutations: { networkMode: "always" },
    },
  });

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
  });

  return router;
};
