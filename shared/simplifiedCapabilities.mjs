export const SIMPLIFIED_TABS = [
  { path: "/", label: "Settings" },
  { path: "/monitor", label: "Live discussion" },
  { path: "/surveys", label: "Surveys" },
  { path: "/results", label: "Results & export" },
  { path: "/logs", label: "AI call logs" },
  { path: "/help", label: "How Simplified works" },
];

export function simplifiedAdminRequestAllowed(method, path) {
  const route = path.split("?")[0].replace(/\/+$/, "") || "/";
  if (!route.startsWith("/admin/")) return ["GET", "HEAD"].includes(method);
  if (["GET", "HEAD"].includes(method))
    return [
      /^\/admin\/simplified\/(settings|overview|logs)$/,
      /^\/admin\/(surveys(?:\/export)?|introduction|monitoring|rooms)$/,
      /^\/admin\/decision-process(?:\/export)?$/,
    ].some((pattern) => pattern.test(route));
  if (method === "PUT")
    return [
      "/admin/simplified/settings",
      "/admin/surveys",
      "/admin/introduction",
    ].includes(route);
  if (method === "POST")
    return [
      "/admin/decision-process/start",
      "/admin/decision-process/interrupt",
      "/admin/decision-process/generate-questions",
      "/admin/decision-process/generate-description",
    ].includes(route);
  return false;
}
