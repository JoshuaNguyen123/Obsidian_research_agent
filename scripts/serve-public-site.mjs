import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import process from "node:process";

const root = path.resolve(process.cwd(), "public-site");
const port = Number.parseInt(process.env.PUBLIC_SITE_PORT ?? "4173", 10);
const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".json", "application/json; charset=utf-8"],
  [".mp4", "video/mp4"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webm", "video/webm"],
]);

function containedSitePath(pathname) {
  const decoded = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
  const candidate = path.resolve(root, `.${decoded}`);
  const relative = path.relative(root, candidate);
  if (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  ) {
    return candidate;
  }
  return null;
}

function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header ?? "");
  if (!match) return null;
  const start = match[1] ? Number.parseInt(match[1], 10) : 0;
  const end = match[2] ? Number.parseInt(match[2], 10) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    start >= size
  ) {
    return null;
  }
  return { start, end: Math.min(end, size - 1) };
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const filePath = containedSitePath(url.pathname);
    if (!filePath) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    const info = await stat(filePath);
    if (!info.isFile()) {
      response.writeHead(404).end("Not found");
      return;
    }

    const contentType =
      mimeTypes.get(path.extname(filePath).toLowerCase()) ??
      "application/octet-stream";
    const range = parseRange(request.headers.range, info.size);
    const headers = {
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
      "Content-Type": contentType,
    };
    if (range) {
      response.writeHead(206, {
        ...headers,
        "Content-Length": range.end - range.start + 1,
        "Content-Range": `bytes ${range.start}-${range.end}/${info.size}`,
      });
    } else {
      response.writeHead(200, { ...headers, "Content-Length": info.size });
    }
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    createReadStream(
      filePath,
      range ? { start: range.start, end: range.end } : undefined,
    ).pipe(response);
  } catch (error) {
    const status = error?.code === "ENOENT" ? 404 : 500;
    response.writeHead(status).end(status === 404 ? "Not found" : "Server error");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`public-site server: http://127.0.0.1:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
