import { resolve, sep } from "node:path";
const root = resolve("storybook-static");
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.STORYBOOK_PORT ?? 6017),
  async fetch(request) {
    const pathname = decodeURIComponent(new URL(request.url).pathname);
    const path = resolve(
      root,
      "." + (pathname === "/" ? "/index.html" : pathname),
    );
    if (path !== root && !path.startsWith(root + sep))
      return new Response("Forbidden", { status: 403 });
    const file = Bun.file(path);
    return (await file.exists())
      ? new Response(file)
      : new Response("Not found", { status: 404 });
  },
});
console.log(`Storybook: ${server.url}`);
