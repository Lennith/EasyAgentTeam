const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:3000";

async function check(pathname) {
  const target = `${baseUrl}${pathname}`;
  const response = await fetch(target);
  if (!response.ok) {
    throw new Error(`${pathname} returned HTTP ${response.status}`);
  }

  const payload = await response.json();
  console.log(`[check_api] ${pathname} OK`, payload);
}

async function main() {
  await check("/healthz");
  await check("/api/projects");
}

main().catch((error) => {
  console.error("[check_api] failed:", error.message);
  process.exitCode = 1;
});
